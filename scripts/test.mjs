
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const polar = process.env.POLAR ?? "polar";
let failed = 0;

function projects(dir, marker) {
  const base = join(root, dir);

  if (!existsSync(base)) {
    return [];
  }

  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, marker)))
    .map((entry) => join(base, entry.name))
    .sort();
}

function hasNativeTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory() ? hasNativeTests(join(dir, entry.name)) : entry.name.endsWith("_test.px"),
  );
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function diff(expected, actual) {
  const want = expected.split("\n");
  const got = actual.split("\n");
  const lines = [];

  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i] !== got[i]) {
      if (want[i] !== undefined) lines.push(`  - ${want[i]}`);
      if (got[i] !== undefined) lines.push(`  + ${got[i]}`);
    }
  }

  return lines.join("\n");
}

function check(name, dir, expectedFile, result, output = "stdout") {
  const expectedPath = join(dir, expectedFile);

  if (output === "stdout" && result.status !== 0) {
    failed++;
    console.log(`FAIL ${name} (exit ${result.status})\n${result.stdout}${result.stderr}`);
    return;
  }

  if (!existsSync(expectedPath)) {
    failed++;
    console.log(`FAIL ${name}: missing ${relative(root, expectedPath)}`);
    return;
  }

  const expected = readFileSync(expectedPath, "utf8");
  const actual = result[output].replace(/\(\d+ms\)/g, "(Nms)");

  if (expected === actual) {
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}\n${diff(expected, actual)}`);
  }
}

function formats(name, dir) {
  const cases = join(dir, "fmt");

  if (!existsSync(cases)) {
    return;
  }

  const scratch = join(dir, ".polar", "fmt");

  for (const file of readdirSync(cases).filter((f) => !f.endsWith(".expected.px")).sort()) {
    const input = join(scratch, file);

    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    copyFileSync(join(cases, file), input);

    let result = run(polar, ["fmt", "--no-color", input], dir);

    if (result.status === 0) {
      result = run(polar, ["fmt", "--no-color", input], dir);
    }

    if (result.status === 0) {
      result = { status: 0, stdout: readFileSync(input, "utf8") };
    }

    check(`${name} fmt/${file}`, cases, file.replace(/\.px$/, ".expected.px"), result);
  }
}

function e2e(name, dir, script = "e2e.mjs", expected = "e2e.expected.txt") {
  const build = existsSync(join(dir, "polar.toml")) ? run(polar, ["build"], dir) : { status: 0 };

  if (build.status !== 0) {
    check(name, dir, expected, build);
    return;
  }

  check(name, dir, expected, run(process.execPath, [script], dir));
}

for (const dir of projects("tests", "polar.toml")) {
  const name = relative(root, dir);

  if (!existsSync(join(dir, "main.expected.txt")) && !existsSync(join(dir, "check.expected.txt")) && existsSync(join(dir, "src")) && hasNativeTests(join(dir, "src"))) {
    const result = run(polar, ["test", "--no-color"], dir);

    if (result.status === 0) {
      console.log(`ok   ${name} (polar test: ${result.stdout.match(/ℹ pass (\d+)/)?.[1] ?? "?"} passed)`);
    } else {
      failed++;
      console.log(`FAIL ${name} (polar test, exit ${result.status})\n${result.stdout}${result.stderr}`);
    }
  } else if (existsSync(join(dir, "check.expected.txt"))) {
    check(name, dir, "check.expected.txt", run(polar, ["check", "--no-color"], dir), "stderr");
  } else {
    check(name, dir, "main.expected.txt", run(polar, ["run"], dir));
  }

  if (existsSync(join(dir, "e2e.mjs"))) {
    e2e(`${name} e2e`, dir);
  }

  formats(name, dir);
}

for (const dir of projects("examples", "e2e.mjs")) {
  e2e(`${relative(root, dir)} e2e`, dir);
}

e2e("cli e2e", join(root, "cli"));
e2e("scaffold e2e", join(root, "cli"), "scaffold_e2e.mjs", "scaffold_e2e.expected.txt");
e2e("console e2e", join(root, "cli"), "console_e2e.mjs", "console_e2e.expected.txt");
e2e("launcher e2e", join(root, "launcher"));

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
