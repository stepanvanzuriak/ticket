
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = fileURLToPath(new URL("..", import.meta.url));
const shim = join(home, "bin", "ticket");
const scratch = mkdtempSync(join(tmpdir(), "ticket-cli-e2e-"));

function ticket(args, cwd, env = {}) {
  const result = spawnSync(shim, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function row(n, name, result) {
  console.log(`${n} ${name}: ${result}`);
}

function yes(test) {
  return test ? "yes" : "no";
}

function files(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

      return entry.isDirectory() ? files(dir, path) : [path];
    })
    .sort();
}

async function serving(args, cwd) {
  const child = spawn(shim, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";

  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  try {
    for (let i = 0; i < 300; i++) {
      const port = output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1];

      if (port !== undefined) {
        const response = await fetch(`http://127.0.0.1:${port}/`);

        return { port, status: response.status, text: await response.text() };
      }

      if (child.exitCode !== null) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return { port: undefined, status: undefined, text: output };
  } finally {
    process.kill(-child.pid, "SIGINT");
    await exited;
  }
}

try {
  const outside = join(scratch, "outside");

  mkdirSync(outside);

  let result = ticket(["frobnicate"], outside);

  row(
    3,
    "unknown_command",
    `exit=${result.status} message=${yes(result.stderr.includes("unknown command `frobnicate`"))} help=${yes(result.stderr.includes("Commands:"))}`,
  );

  result = ticket(["help"], outside);
  row(4, "help_outside_app", `exit=${result.status} help=${yes(result.stdout.includes("routes"))}`);

  result = ticket(["routes"], outside);
  row(5, "needs_app", `exit=${result.status} ${result.stderr.trim()}`);

  result = ticket(["new", "MyApp", "--skip-build"], outside);
  row(7, "new_bad_name", `exit=${result.status} written=${yes(existsSync(join(outside, "MyApp")))}`);

  mkdirSync(join(outside, "taken"));
  writeFileSync(join(outside, "taken", "notes.txt"), "mine\n");
  result = ticket(["new", "taken", "--skip-build"], outside);
  row(8, "new_non_empty", `exit=${result.status} files=${files(join(outside, "taken")).join(",")}`);

  result = ticket(["new", "blog_app", "--skip-build", "--path"], outside);

  const created = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("      create  "))
    .map((line) => line.trim().replace(/^create\s+/, ""));
  const app = join(outside, "blog_app");
  const leftover = files(app).filter((file) => readFileSync(join(app, file), "utf8").includes("{{"));

  row(9, "new_files", `exit=${result.status} created=${created.join(",")}`);
  row("+", "new_public", files(join(app, "public")).join(","));
  row(9, "new_files_on_disk", `same=${yes(created.join() === files(app).join())} placeholders=${leftover.length}`);
  row(
    9,
    "new_files_absolute_path",
    yes(readFileSync(join(app, "polar.toml"), "utf8").includes(`ticket = { path = "${home.replace(/\/$/, "")}" }`)),
  );

  result = ticket(["new", "from_git", "--skip-build"], outside);
  row(
    9,
    "new_git_dependency",
    `exit=${result.status} ${readFileSync(join(outside, "from_git", "polar.toml"), "utf8").match(/^ticket = .*$/m)?.[0]} fetch=${yes(result.stdout.includes("  polar fetch"))}`,
  );

  result = ticket(["new", "demo", "--path"], outside);

  const demo = join(outside, "demo");

  row(10, "new_builds", `exit=${result.status} built=${yes(existsSync(join(demo, "dist", "start.mjs")))}`);

  let served = await serving(["server", "-p", "0"], demo);

  row(
    10,
    "new_serves",
    `status=${served.status} ${served.text.match(/<title>.*?<\/title>/)?.[0] ?? served.text}`,
  );

  served = await serving(["s", "-p", "4001"], demo);
  row(12, "server_port", `port=${served.port} status=${served.status}`);

  const work = join(scratch, "work");

  mkdirSync(work);
  symlinkSync(home, join(work, "ticket"));
  result = spawnSync(
    process.execPath,
    [join(home, "cli", "dist", "start.mjs"), "--", "new", "sibling", "--skip-build", "--path"],
    { cwd: work, encoding: "utf8", env: { ...process.env, TICKET_HOME: join(work, "ticket") } },
  );
  row(
    11,
    "new_relative_path",
    `exit=${result.status} ${readFileSync(join(work, "sibling", "polar.toml"), "utf8").match(/^ticket = .*$/m)?.[0]}`,
  );

  const pages = join(home, "examples", "pages");
  const expected = spawnSync("polar", ["start", "--", "routes"], { cwd: pages, encoding: "utf8" });

  result = ticket(["routes"], join(pages, "src", "controllers"));
  row(
    13,
    "routes_table",
    `exit=${result.status} same=${yes(result.stdout === expected.stdout && result.stdout.includes("articles_path"))}`,
  );

  writeFileSync(join(app, "src", "routes.px"), "module Routes\n\nroutes\n  root -> \n");
  result = ticket(["routes"], app);
  row(14, "routes_build_error", `exit=${result.status} shown=${yes(result.stderr.includes("error[POLAR"))}`);

  const now = new Date();
  const past = new Date(now.getTime() - 60_000);

  utimesSync(join(home, "cli", "dist", "start.mjs"), past, past);
  utimesSync(join(home, "cli", "src", "main.px"), now, now);

  const rebuilds = [ticket(["version"], outside), ticket(["version"], outside)].map(
    (r) => (r.stderr.match(/built ticket_cli/g) ?? []).length,
  );

  row(15, "shim_rebuilds", `rebuilds=${rebuilds.join(",")}`);

  const bin = join(scratch, "bin");

  mkdirSync(bin);
  symlinkSync(shim, join(bin, "real"));
  symlinkSync("real", join(bin, "ticket"));
  result = spawnSync(join(bin, "ticket"), ["version"], { cwd: outside, encoding: "utf8" });
  row(16, "shim_symlink", `exit=${result.status} ${result.stdout.trim()}`);
  const stamped = (text) => text.replace(/\d{8}_\d{6}/g, "V");
  const gen = (args, cwd) => {
    const r = ticket(args, cwd);

    return { ...r, out: stamped(r.stdout.trim().split("\n").join(" | ")), err: stamped(r.stderr.trim()) };
  };

  ticket(["new", "gen_app", "--skip-build", "--path"], outside);

  const generated = join(outside, "gen_app");

  result = gen(["g", "model", "User", "name:String", "email:String:unique"], generated);
  row(17, "g_model", `exit=${result.status} ${result.out}`);
  row(17, "g_model_files", files(generated).filter((f) => f.startsWith("src/models") || f === "src/schema.px").join(","));
  row(17, "g_model_wired", yes(readFileSync(join(generated, "src", "main.px"), "utf8").includes("Migrate.run(Schema.migrations")));

  result = gen(["generate", "model", "Post", "title:String", "published:Bool:default=false", "user:references"], generated);
  row(18, "g_model_more", `exit=${result.status} ${result.out}`);

  result = gen(["g", "migration", "AddSlugToPosts", "slug:String?"], generated);
  row(19, "g_migration_add", `exit=${result.status} ${result.out}`);

  result = gen(["g", "migration", "RemoveSlugFromPosts", "slug"], generated);
  row(19, "g_migration_remove", `exit=${result.status} ${result.out}`);

  const schema = stamped(readFileSync(join(generated, "src", "schema.px"), "utf8"));

  row(20, "schema", schema.slice(schema.indexOf("migrations\n")).trim().split("\n").join(" | "));

  result = ticket(["db:migrate"], generated, { TICKET_DATABASE: join(scratch, "gen.sqlite3") });
  row(21, "generated_migrates", `exit=${result.status} migrated=${(result.stdout.match(/migrated/g) ?? []).length}`);

  result = gen(["g", "model", "Post", "title:String"], generated);
  row(22, "g_model_exists", `exit=${result.status} ${result.err.replace(generated, ".")}`);

  result = gen(["g", "migration", "Frobnicate", "x:Int"], generated);
  row(23, "g_migration_unknown", `exit=${result.status} ${result.err.slice(0, 40)}`);

  result = gen(["g", "migration", "AddAgeToUsers", "age:Int:bogus"], generated);
  row(23, "g_bad_modifier", `exit=${result.status} ${result.err}`);

  result = gen(["g", "model", "post", "title:String"], generated);
  row(24, "g_bad_name", `exit=${result.status} ${result.err.slice(0, 30)}`);

  result = gen(["g", "model", "Tag"], generated);
  row(24, "g_no_fields", `exit=${result.status} ${result.err}`);

  result = gen(["g", "model", "Tag", "name"], generated);
  row(24, "g_bad_field", `exit=${result.status} ${result.err.slice(0, 30)}`);

  result = gen(["g", "model", "Tag", "name:String"], outside);
  row(24, "g_needs_app", `exit=${result.status}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
