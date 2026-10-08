import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const polar = process.env.POLAR ?? "polar";
const cliDir = join(root, "cli");

const buffer = new AsyncLocalStorage();
let failed = 0;

const log = (message) => buffer.getStore().push(message);
const pass = (name, detail = "") => log(`ok   ${name}${detail}`);
const output = (result) => `${result.stdout}${result.stderr}`;

function fail(name, detail) {
  failed++;
  log(`FAIL ${name}${detail}`);
}

function failExit(name, result, label = "exit") {
  fail(name, ` (${label} ${result.status})\n${output(result)}`);
}

function projects(dir, marker) {
  const base = join(root, dir);

  if (!existsSync(base)) {
    return [];
  }

  return readdirSync(base, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(base, entry.name, marker)),
    )
    .map((entry) => join(base, entry.name))
    .sort();
}

function hasNativeTests(dir) {
  if (!existsSync(dir)) {
    return false;
  }

  return readdirSync(dir, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? hasNativeTests(join(dir, entry.name))
      : entry.name.endsWith("_test.px"),
  );
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function diff(expected, actual) {
  const want = expected.split("\n");
  const got = actual.split("\n");
  const lines = [];

  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i] !== got[i]) {
      if (want[i] !== undefined) {
        lines.push(`  - ${want[i]}`);
      }
      if (got[i] !== undefined) {
        lines.push(`  + ${got[i]}`);
      }
    }
  }

  return lines.join("\n");
}

function expectMatch(name, expectedPath, actual) {
  if (!existsSync(expectedPath)) {
    fail(name, `: missing ${relative(root, expectedPath)}`);
    return;
  }

  const expected = readFileSync(expectedPath, "utf8");
  const normalized = actual.replace(/\(\d+ms\)/g, "(Nms)");

  if (expected === normalized) {
    pass(name);
  } else {
    fail(name, `\n${diff(expected, normalized)}`);
  }
}

function expectStdout(name, expectedPath, result) {
  if (result.status !== 0) {
    failExit(name, result);
    return;
  }

  expectMatch(name, expectedPath, result.stdout);
}

async function nativeTests(name, dir) {
  const result = await run(polar, ["test", "--no-color"], dir);

  if (result.status !== 0) {
    failExit(name, result, "polar test, exit");
    return;
  }

  const count = result.stdout.match(/ℹ pass (\d+)/)?.[1] ?? "?";
  pass(name, ` (polar test: ${count} passed)`);
}

async function formats(name, dir) {
  const cases = join(dir, "fmt");

  if (!existsSync(cases)) {
    return;
  }

  const scratch = join(dir, ".polar", "fmt");
  const files = readdirSync(cases)
    .filter((f) => !f.endsWith(".expected.px"))
    .sort();

  for (const file of files) {
    const caseName = `${name} fmt/${file}`;
    const expectedPath = join(cases, file.replace(/\.px$/, ".expected.px"));
    const input = join(scratch, file);

    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    copyFileSync(join(cases, file), input);

    const first = await run(polar, ["fmt", "--no-color", input], dir);
    const result =
      first.status === 0
        ? await run(polar, ["fmt", "--no-color", input], dir)
        : first;

    if (result.status !== 0) {
      failExit(caseName, result);
      continue;
    }

    expectMatch(caseName, expectedPath, readFileSync(input, "utf8"));
  }
}

async function e2e(
  name,
  dir,
  script = "e2e.mjs",
  expected = "e2e.expected.txt",
) {
  if (existsSync(join(dir, "polar.toml"))) {
    const build = await run(polar, ["build"], dir);

    if (build.status !== 0) {
      failExit(name, build);
      return;
    }
  }

  expectStdout(
    name,
    join(dir, expected),
    await run(process.execPath, [script], dir),
  );
}

async function testProject(dir) {
  const name = relative(root, dir);
  const checkExpected = join(dir, "check.expected.txt");
  const mainExpected = join(dir, "main.expected.txt");

  if (existsSync(checkExpected)) {
    const result = await run(polar, ["check", "--no-color"], dir);
    expectMatch(name, checkExpected, result.stderr);
  } else if (existsSync(mainExpected) || !hasNativeTests(join(dir, "src"))) {
    expectStdout(name, mainExpected, await run(polar, ["run"], dir));
  } else {
    await nativeTests(name, dir);
  }

  if (existsSync(join(dir, "e2e.mjs"))) {
    await e2e(`${name} e2e`, dir);
  }

  await formats(name, dir);
}

const parallel = [
  ...projects("tests", "polar.toml").map((dir) => () => testProject(dir)),
  ...projects("examples", "e2e.mjs").map(
    (dir) => () => e2e(`${relative(root, dir)} e2e`, dir),
  ),
  () => e2e("launcher e2e", join(root, "launcher")),
];

const exclusive = [
  () => e2e("cli e2e", cliDir),
  () =>
    e2e(
      "scaffold e2e",
      cliDir,
      "scaffold_e2e.mjs",
      "scaffold_e2e.expected.txt",
    ),
  () =>
    e2e("console e2e", cliDir, "console_e2e.mjs", "console_e2e.expected.txt"),
  () => e2e("watch e2e", cliDir, "watch_e2e.mjs", "watch_e2e.expected.txt"),
];

const results = [];
let flushed = 0;

function flush() {
  while (results[flushed]) {
    for (const line of results[flushed++]) console.log(line);
  }
}

async function runTask(index, task) {
  const lines = [];

  await buffer.run(lines, task);
  results[index] = lines;
  flush();
}

async function runParallel(tasks) {
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      await runTask(index, tasks[index]);
    }
  }

  const workers = Math.min(availableParallelism(), tasks.length);
  await Promise.all(Array.from({ length: workers }, worker));
}

const cliBuild = await run(polar, ["build"], cliDir);

if (cliBuild.status !== 0) {
  console.log(`FAIL cli build\n${output(cliBuild)}`);
  process.exit(1);
}

await runParallel(parallel);

for (const [i, task] of exclusive.entries()) {
  await runTask(parallel.length + i, task);
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
