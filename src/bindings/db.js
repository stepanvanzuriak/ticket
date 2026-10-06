
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const adapters = {
  sqlite: { open: openSqlite },
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

  while (active !== null) {
    await active.done;
  }

  let release;

  active = { done: new Promise((resolve) => (release = resolve)) };

  try {
    const db = await current();

    await db.begin();

    try {
      const result = await inside.run({ depth: 0 }, body);

      await db.script(commit(result) ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      if (await db.inTransaction()) {
        await db.script("ROLLBACK");
      }

      throw error;
    }
  } finally {
    active = null;
    release();
  }
}

async function savepoint(outer, body, commit) {
  const db = await current();
  const name = `ticket_${outer.depth + 1}`;

  await db.script(`SAVEPOINT ${name}`);

  try {
    const result = await inside.run({ depth: outer.depth + 1 }, body);

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

  let opened;

  try {
    opened = await adapter.open(database);
  } catch (error) {
    throw new DbFailure("connection", `can't open ${name} database \`${database}\`: ${error.message}`);
  }

  const previous = client;

  client = opened;
  await previous?.close();
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

  return {
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
    },
    inTransaction() {
      return db.isTransaction;
    },
    failure: sqliteFailure,
    close() {
      db.close();
    },
  };
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
