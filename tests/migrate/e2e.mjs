
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const home = join(here, "..", "..");
const shim = join(home, "bin", "ticket");
const scratch = mkdtempSync(join(tmpdir(), "ticket-migrate-e2e-"));
const app = join(scratch, "app");
const database = join(scratch, "db", "test.sqlite3");

function ticket(args, cwd = app, env = {}) {
  const result = spawnSync(shim, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TICKET_DATABASE: database, ...env },
  });

  return { code: result.status, out: result.stdout.replace(/\(\d+ms\)/g, "(Nms)"), err: result.stderr };
}

function row(n, name, result) {
  console.log(`${n} ${name}: ${result}`);
}

function lines(text) {
  return text.trim().split("\n").join(" | ");
}

function versions() {
  const db = new DatabaseSync(database);

  try {
    return db
      .prepare("select version from schema_migrations order by version")
      .all()
      .map((r) => r.version)
      .join(",");
  } finally {
    db.close();
  }
}

function users() {
  const db = new DatabaseSync(database);

  try {
    return db.prepare("select count(*) as n from users").get().n;
  } finally {
    db.close();
  }
}

try {
  cpSync(join(here, "src"), join(app, "src"), { recursive: true });
  writeFileSync(
    join(app, "polar.toml"),
    `[project]
name = "migrate_app"
hosts = ["Node"]

[dependencies]
ticket = { path = "${home.replace(/\/$/, "")}" }

[run]
launcher = "ticket"
options = { port = 0 }
`,
  );

  let result = ticket(["db:migrate"]);
  row(14, "migrate", `exit=${result.code} ${lines(result.out)} versions=${versions()}`);

  result = ticket(["db:migrate"]);
  row(15, "migrate_nothing_pending", `exit=${result.code} out=${result.out.trim()}`);

  result = ticket(["db:rollback"]);
  row(16, "rollback_one", `exit=${result.code} ${lines(result.out)} versions=${versions()}`);

  result = ticket(["db:rollback", "--step", "5"]);
  row(17, "rollback_step", `exit=${result.code} reverted=${result.out.match(/reverted/g).length} versions=${versions()}`);

  result = ticket(["db:migrate", "--version", "20261001_120000"]);
  row(18, "migrate_version", `exit=${result.code} versions=${versions()}`);

  result = ticket(["db:status"]);
  row(19, "status", `exit=${result.code} ${lines(result.out)}`);

  const orphan = new DatabaseSync(database);

  orphan.exec("insert into schema_migrations (version) values ('20200101_000000')");
  orphan.close();
  result = ticket(["db:status"]);
  row(19, "status_no_file", `exit=${result.code} ${lines(result.out)}`);

  const cleanup = new DatabaseSync(database);

  cleanup.exec("delete from schema_migrations where version = '20200101_000000'");
  cleanup.close();

  result = ticket(["db:seed"]);
  row(20, "seed", `exit=${result.code} ${result.out.trim()} users=${users()}`);

  result = ticket(["db:reset"]);
  row(21, "reset", `exit=${result.code} migrated=${result.out.match(/migrated/g).length} seeded=${result.out.includes("seeded")} versions=${versions()} users=${users()}`);

  result = ticket(["db:migrate", "--version", "1"]);
  row(22, "unknown_version", `exit=${result.code} ${result.err.trim()}`);

  result = ticket(["db:rollback", "--step", "0"]);
  row(23, "bad_step", `exit=${result.code} ${result.err.trim()}`);

  result = ticket(["db:migrate", "--bogus"]);
  row(24, "bad_flag", `exit=${result.code} ${lines(result.err).slice(0, 40)}`);

  result = ticket(["db:migrate"], join(home, "examples", "hello"));
  row(25, "no_migrate_export", `exit=${result.code} ${result.err.trim().split("\n").pop().slice(0, 55)}`);

  result = ticket(["db:status"], scratch);
  row(26, "needs_app", `exit=${result.code}`);

  rmSync(join(scratch, "db"), { recursive: true, force: true });
  writeFileSync(join(app, "ticket.toml"), '[database]\nmigrate = "auto"\n');

  const server = spawn(shim, ["server", "-p", "0"], {
    cwd: app,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TICKET_DATABASE: database },
  });
  let output = "";

  server.stdout.on("data", (chunk) => (output += chunk));
  server.stderr.on("data", (chunk) => (output += chunk));

  for (let i = 0; i < 300 && !output.includes("is listening"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  process.kill(-server.pid, "SIGINT");
  await new Promise((resolve) => (server.exitCode !== null ? resolve() : server.on("exit", resolve)));
  row(27, "auto_migrate", `versions=${versions()} listening=${output.includes("is listening")}`);

  writeFileSync(join(app, "ticket.toml"), '[database]\nmigrate = "sometimes"\n');
  result = ticket(["db:status"]);
  row(28, "bad_migrate_setting", `exit=${result.code} ${result.err.trim()}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
