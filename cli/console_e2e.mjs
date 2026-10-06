
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const home = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const shim = join(home, "bin", "ticket");
const scratch = mkdtempSync(join(tmpdir(), "ticket-console-e2e-"));

function ticket(args, cwd, env = {}, input) {
  return spawnSync(shim, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, input });
}

const row = (n, name, text) => console.log(`${n} ${name}: ${text}`);
const out = (r) => r.stdout.trim().replaceAll(scratch, "~").split("\n").join(" | ");

try {
  const app = join(scratch, "app");

  cpSync(join(home, "cli", "fixtures", "console_app"), app, { recursive: true });
  writeFileSync(join(app, "polar.toml"), readFileSync(join(app, "polar.toml"), "utf8").replace("{{ticket_path}}", home));
  spawnSync("polar", ["build"], { cwd: app });

  ticket(["db:migrate"], app);

  let r = ticket(["console", "-e", "Posts.count([])"], app);
  row(1, "console_e", `exit=${r.status} ${out(r)}`);
  row(2, "console_announces", out(r).split(" | ")[0]);

  r = ticket(["c", "--sandbox", "-e", 'Posts.insert({ title: "x" })'], app);
  row(3, "console_sandbox", `exit=${r.status} ${out(r).split(" | ")[0]}`);
  r = ticket(["console", "-e", "Posts.count([])"], app);
  row(3, "console_sandbox_left_db_alone", `exit=${r.status} ${out(r).split(" | ").slice(1).join(" | ")}`);
  r = ticket(["console", "--sandbox", "-e", "Posts.count([])"], app);
  row(3, "console_sandbox_starts_empty", `exit=${r.status} ${out(r).split(" | ").slice(1).join(" | ")}`);

  r = ticket(["console", "-e", "List.length(Schema.migrations)"], app);
  row(4, "console_models", `exit=${r.status} ${out(r).split(" | ").slice(1).join(" | ")}`);

  r = ticket(["console"], app, {}, "Posts.count([])\nlet n = 2\nn * 21\n");
  row(5, "console_piped", `exit=${r.status} ${out(r).split(" | ").slice(1).join(" | ")}`);

  r = ticket(["console", "-e", "1 +"], app);
  row(5, "console_error_exit", `exit=${r.status}`);

  const fake = join(scratch, "fake");

  mkdirSync(fake);
  writeFileSync(join(fake, "polar"), '#!/bin/sh\nif [ "$1" = "repl" ]; then exit 2; fi\nexec "$REAL_POLAR" "$@"\n');
  chmodSync(join(fake, "polar"), 0o755);

  const real = spawnSync("sh", ["-c", "command -v polar"], { encoding: "utf8" }).stdout.trim();

  r = ticket(["console", "-e", "1"], app, { PATH: `${fake}:${process.env.PATH}`, REAL_POLAR: real });
  row(6, "console_no_repl", `exit=${r.status} ${r.stderr.trim()}`);

  const old = join(scratch, "old");

  cpSync(app, old, { recursive: true });
  writeFileSync(join(old, "src", "main.px"), readFileSync(join(old, "src", "main.px"), "utf8").replace(/\n  boot\(\)[\s\S]*?\n  }\n/, "\n").replace("  boot\n", ""));
  r = ticket(["console", "-e", "1"], old);
  row(7, "console_needs_boot", `exit=${r.status} ${r.stderr.trim().split("\n")[0]}`);

  r = ticket(["console", "-e", "1"], scratch);
  row(7, "console_needs_app", `exit=${r.status}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
