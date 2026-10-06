
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { databaseConfig, parseConfig, readConfig, useDatabase } from "../../launcher/serve.mjs";

const main = fileURLToPath(new URL("dist/main.js", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "ticket-db-"));

function node(script, database, adapter) {
  const env = { ...process.env };

  delete env.TICKET_DATABASE;
  delete env.TICKET_DATABASE_ADAPTER;

  if (database !== undefined) {
    env.TICKET_DATABASE = database;
  }

  if (adapter !== undefined) {
    env.TICKET_DATABASE_ADAPTER = adapter;
  }

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(main)});\n${script}`],
    { env, encoding: "utf8" },
  );

  return (result.stdout + result.stderr).trim();
}

function errorOf(fn) {
  try {
    fn();
    return "no error";
  } catch (error) {
    return error.message;
  }
}

console.log(
  `18 tx_serialises: ${node(
    `console.log(await m.counter_setup());
     const results = await Promise.all(
       Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? m.bump() : m.counter())),
     );
     console.log(results.filter((r) => r.startsWith("Err")).length, "errors;", await m.counter());`,
    ":memory:",
  ).replace(/\n/g, " | ")}`,
);

console.log(`19 no_database: ${node("console.log(await m.counter());")}`);
console.log(`19 unknown_adapter: ${node("console.log(await m.counter());", ":memory:", "oracle")}`);

const file = join(scratch, "nested", "dir", "app.sqlite3");
const created = node("console.log(await m.counter_setup(), await m.bump(), await m.counter());", file);
const reopened = node("console.log(await m.counter());", file);

const journal = existsSync(file)
  ? new DatabaseSync(file).prepare("pragma journal_mode").get().journal_mode
  : "none";

console.log(`20 file_database: ${created} | reopened ${reopened} | journal=${journal}`);

const shown = ({ adapter, database }) => `${adapter}:${database}`;
const toml = { database: { adapter: "sqlite", database: "data/app.db" } };

console.log(
  `21 database_config: ${[
    shown(databaseConfig("/app", {}, {})),
    shown(databaseConfig("/app", toml, { TICKET_DATABASE: "" })),
    shown(databaseConfig("/app", toml, { TICKET_DATABASE: "other.db" })),
    shown(databaseConfig("/app", {}, { TICKET_DATABASE: "/abs/x.db" })),
    shown(databaseConfig("/app", { database: { database: ":memory:" } }, {})),
    shown(databaseConfig("/app", {}, { TICKET_DATABASE_ADAPTER: "sqlite" })),
  ].join(" ")}`,
);
console.log(`21 unknown_adapter: ${errorOf(() => databaseConfig("/app", { database: { adapter: "pg" } }, {}))}`);

console.log(
  `22 parse_config: ${JSON.stringify(
    parseConfig(
      "# settings\n\n[database] # the db\nadapter = \"sqlite\"\ndatabase = \"db/a \\\"b\\\".sqlite3\" # comment\n",
      "ticket.toml",
    ),
  )} ${JSON.stringify(parseConfig("[database]\ndatabase = 'x.db'\n", "ticket.toml"))}`,
);

for (const [name, text] of [
  ["unknown_table", "[db]\ndatabase = \"x\"\n"],
  ["unknown_key", "[database]\npath = \"x\"\n"],
  ["wrong_type", "[database]\ndatabase = 3\n"],
  ["outside_table", "database = \"x\"\n"],
  ["duplicate_key", "[database]\ndatabase = \"x\"\ndatabase = \"y\"\n"],
  ["not_toml", "[database]\ndatabase\n"],
]) {
  console.log(`23 config_error ${name}: ${errorOf(() => parseConfig(text, "ticket.toml"))}`);
}

const app = join(scratch, "app");
const env = { TICKET_DATABASE: "", TICKET_DATABASE_ADAPTER: "" };

mkdirSync(app);
writeFileSync(join(app, "ticket.toml"), "[database]\nadapter = \"sqlite\"\ndatabase = \"db/test.sqlite3\"\n");
useDatabase({ root: app }, env);

const bare = join(scratch, "bare");
const bareEnv = {};

mkdirSync(bare);
useDatabase({ root: bare }, bareEnv);

console.log(
  `24 use_database: ${env.TICKET_DATABASE_ADAPTER} ${env.TICKET_DATABASE === join(app, "db/test.sqlite3")} ${
    bareEnv.TICKET_DATABASE === join(bare, "db/development.sqlite3")
  } ${bareEnv.TICKET_DATABASE_ADAPTER} ${JSON.stringify(readConfig(bare))}`,
);

rmSync(scratch, { recursive: true, force: true });
