
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const adapters = {
  sqlite: { open: openSqlite },
  postgres: { open: openPostgres },
};

let client = null;
let connecting = null;
let active = null;
const inside = new AsyncLocalStorage();

class DbFailure extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export async function connect(config) {
  await idle();

  return attempt("", async () => {
    await replace(config.adapter, config.database);
    return {};
  }, false);
}

export async function dialect() {
  try {
    return (await current()).dialect;
  } catch {
    return "sqlite";
  }
}

export async function query(sql, params) {
  await idle();

  return attempt(sql, async (db) => JSON.stringify(await db.all(sql, values(params))));
}

export async function exec(sql, params) {
  await idle();

  return attempt(sql, (db) => db.run(sql, values(params)));
}

export async function script(sql) {
  await idle();

  return attempt(sql, async (db) => {
    await db.script(sql);
    return {};
  });
}

export async function within_transaction(body, commit) {
  const outer = inside.getStore();

  if (outer !== undefined) {
    return savepoint(outer, body, commit);
  }

  const root = await current();
  let release = null;

  // SQLite has one connection, so a transaction holds every other Db call off.
  // Postgres pins one pooled connection to the transaction and lets the rest run.
  if (root.serial) {
    while (active !== null) {
      await active.done;
    }

    active = { done: new Promise((resolve) => (release = resolve)) };
  }

  try {
    const db = await root.begin();

    try {
      const result = await inside.run({ depth: 0, db }, body);

      await db.script(commit(result) ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      if (await db.inTransaction()) {
        await db.script("ROLLBACK");
      }

      throw error;
    } finally {
      await db.release?.();
    }
  } finally {
    if (release !== null) {
      active = null;
      release();
    }
  }
}

async function savepoint(outer, body, commit) {
  const db = await current();
  const name = `ticket_${outer.depth + 1}`;

  await db.script(`SAVEPOINT ${name}`);

  try {
    const result = await inside.run({ depth: outer.depth + 1, db: outer.db }, body);

    if (!commit(result)) {
      await db.script(`ROLLBACK TO ${name}`);
    }

    await db.script(`RELEASE ${name}`);
    return result;
  } catch (error) {
    if (await db.inTransaction()) {
      await db.script(`ROLLBACK TO ${name}`);
      await db.script(`RELEASE ${name}`);
    }

    throw error;
  }
}

async function idle() {
  while (active !== null && inside.getStore() === undefined) {
    await active.done;
  }
}

async function current() {
  const pinned = inside.getStore()?.db;

  if (pinned !== undefined) {
    return pinned;
  }

  if (client !== null) {
    return client;
  }

  connecting ??= (async () => {
    const database = process.env.TICKET_DATABASE;

    if (database === undefined || database === "") {
      throw new DbFailure(
        "connection",
        "no database: set `[database]` in ticket.toml or `TICKET_DATABASE`, or call `Db.connect`",
      );
    }

    await replace(process.env.TICKET_DATABASE_ADAPTER || "sqlite", database);
  })().finally(() => {
    connecting = null;
  });

  await connecting;
  return client;
}

async function replace(name, database) {
  const adapter = Object.hasOwn(adapters, name) ? adapters[name] : undefined;

  if (adapter === undefined) {
    throw new DbFailure(
      "connection",
      `unknown database adapter \`${name}\`; the adapters are: ${Object.keys(adapters).join(", ")}`,
    );
  }

  // The test helpers ask for `:memory:`; point them at Postgres when it's set up for tests.
  const testing = database === ":memory:" && name === "sqlite" && process.env.TICKET_TEST_POSTGRES;
  const target = testing ? process.env.TICKET_TEST_POSTGRES : database;
  const chosen = testing ? adapters.postgres : adapter;
  let opened;

  try {
    opened = await chosen.open(target, { fresh: Boolean(testing) });
  } catch (error) {
    throw new DbFailure(
      "connection",
      `can't open ${testing ? "postgres" : name} database \`${redact(target)}\`: ${error.message}`,
    );
  }

  const previous = client;

  client = opened;
  await previous?.close();
}

function redact(database) {
  return database.replace(/^([a-z]+:\/\/[^:/@]*):[^@]*@/i, "$1:***@");
}

function values(params) {
  return params.map((param) => {
    switch (param.$) {
      case "SqlNull":
        return { type: "null", value: null };
      case "SqlInt":
        return { type: "int", value: param._0 };
      case "SqlFloat":
        return { type: "float", value: param._0 };
      case "SqlBool":
        return { type: "bool", value: param._0 };
      default:
        return { type: "text", value: param._0 };
    }
  });
}

async function attempt(sql, action, connected = true) {
  let db = null;

  globalThis.$ticketStatements = (globalThis.$ticketStatements ?? 0) + 1;

  try {
    db = connected ? await current() : null;
    return { ok: await action(db) };
  } catch (error) {
    const { kind, code, message } =
      error instanceof DbFailure
        ? { kind: error.kind, code: "", message: error.message }
        : db !== null
          ? db.failure(error)
          : { kind: "other", code: "", message: error?.message ?? String(error) };

    return { err: { kind, code, message, sql } };
  }
}

async function openSqlite(database) {
  const { DatabaseSync } = await import("node:sqlite");

  if (database !== ":memory:") {
    mkdirSync(dirname(database), { recursive: true });
  }

  const db = new DatabaseSync(database);

  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");

  if (database !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }

  const self = {
    dialect: "sqlite",
    serial: true,
    all(sql, params) {
      const statement = db.prepare(sql);
      const booleans = statement
        .columns()
        .filter((column) => /^bool(ean)?$/i.test(column.type ?? ""))
        .map((column) => column.name);
      const rows = statement.all(...params.map(sqliteValue));

      for (const row of booleans.length === 0 ? [] : rows) {
        for (const name of booleans) {
          if (row[name] !== null) {
            row[name] = row[name] !== 0;
          }
        }
      }

      return rows;
    },
    run(sql, params) {
      const { changes, lastInsertRowid } = db.prepare(sql).run(...params.map(sqliteValue));

      return { changes: Number(changes), last_id: Number(lastInsertRowid) };
    },
    script(sql) {
      db.exec(sql);
    },
    begin() {
      db.exec("BEGIN IMMEDIATE");
      return self;
    },
    inTransaction() {
      return db.isTransaction;
    },
    failure: sqliteFailure,
    close() {
      db.close();
    },
  };

  return self;
}

function sqliteValue({ type, value }) {
  switch (type) {
    case "int":
      return BigInt(value);
    case "bool":
      return value ? 1n : 0n;
    default:
      return value;
  }
}

const sqliteKinds = { 1555: "unique", 2067: "unique", 787: "foreign_key", 1299: "not_null", 275: "check" };

function sqliteFailure(error) {
  const code = error?.errcode;
  const message = error?.message ?? String(error);
  const kind =
    sqliteKinds[code] ?? (code === 1 && /syntax error|no such/.test(message) ? "syntax" : "other");

  return { kind, code: code === undefined ? "" : String(code), message };
}

async function openPostgres(database, { fresh = false } = {}) {
  let pg;

  try {
    pg = await import("pg");
  } catch {
    throw new Error("the `pg` package isn't installed; add it to the app's package.json");
  }

  const { Pool, types } = pg.default ?? pg;
  // int8 (COUNT, SUM of integers) and numeric (AVG) arrive as strings by default.
  const parsers = {
    getTypeParser: (oid, format) =>
      oid === 20 || oid === 1700 ? Number : types.getTypeParser(oid, format),
  };
  const pool = new Pool({ connectionString: database, types: parsers });

  pool.on("error", () => {});

  try {
    await pool.query("SELECT 1");

    if (fresh) {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    }
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }

  const connection = (runner, pinned) => ({
    dialect: "postgres",
    serial: false,
    async all(sql, params) {
      const result = await runner.query(numbered(sql), params.map(postgresValue));

      return result.rows;
    },
    async run(sql, params) {
      const result = await runner.query(numbered(sql), params.map(postgresValue));

      return { changes: result.rowCount ?? 0, last_id: Number(result.rows?.[0]?.id ?? 0) };
    },
    async script(sql) {
      await runner.query(sql);

      if (pinned !== undefined && /^\s*(COMMIT|ROLLBACK)\s*$/i.test(sql)) {
        pinned.open = false;
      }
    },
    async begin() {
      const client = await pool.connect();
      const state = { open: false };
      const db = connection(client, state);

      db.inTransaction = () => state.open;
      db.release = () => client.release();

      try {
        await client.query("BEGIN");
        state.open = true;
      } catch (error) {
        client.release();
        throw error;
      }

      return db;
    },
    inTransaction() {
      return false;
    },
    failure: postgresFailure,
    async close() {
      await pool.end();
    },
  });

  return connection(pool);
}

// `?` is the portable placeholder; Postgres wants `$1`, `$2`, ... Quoted text is left alone.
function numbered(sql) {
  let count = 0;
  let quote = null;
  let out = "";

  for (const char of sql) {
    if (quote !== null) {
      quote = char === quote ? null : quote;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "?") {
      out += `$${++count}`;
      continue;
    }

    out += char;
  }

  return out;
}

function postgresValue({ type, value }) {
  return type === "null" ? null : value;
}

const postgresKinds = {
  23505: "unique",
  23503: "foreign_key",
  23502: "not_null",
  23514: "check",
  42601: "syntax",
  "42P01": "syntax",
  42703: "syntax",
};

function postgresFailure(error) {
  const code = error?.code === undefined ? "" : String(error.code);
  const message = error?.message ?? String(error);

  return { kind: postgresKinds[code] ?? "other", code, message };
}
