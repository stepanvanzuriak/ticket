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
let failed = 0;

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

const capture = new AsyncLocalStorage();
const log = (message) => capture.getStore().push(message);

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
    log(
      `FAIL ${name} (exit ${result.status})\n${result.stdout}${result.stderr}`,
    );
    return;
  }

  if (!existsSync(expectedPath)) {
    failed++;
    log(`FAIL ${name}: missing ${relative(root, expectedPath)}`);
    return;
  }

  const expected = readFileSync(expectedPath, "utf8");
  const actual = result[output].replace(/\(\d+ms\)/g, "(Nms)");

  if (expected === actual) {
    log(`ok   ${name}`);
  } else {
    failed++;
    log(`FAIL ${name}\n${diff(expected, actual)}`);
  }
}

async function formats(name, dir) {
  const cases = join(dir, "fmt");

  if (!existsSync(cases)) {
    return;
  }

  const scratch = join(dir, ".polar", "fmt");

  const expected = readdirSync(cases)
    .filter((f) => !f.endsWith(".expected.px"))
    .sort();

  for (const file of expected) {
    const input = join(scratch, file);

    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    copyFileSync(join(cases, file), input);

    let result = await run(polar, ["fmt", "--no-color", input], dir);

    if (result.status === 0) {
      result = await run(polar, ["fmt", "--no-color", input], dir);
    }

    if (result.status === 0) {
      result = { status: 0, stdout: readFileSync(input, "utf8") };
    }

    check(
      `${name} fmt/${file}`,
      cases,
      file.replace(/\.px$/, ".expected.px"),
      result,
    );
  }
}

async function e2e(
  name,
  dir,
  script = "e2e.mjs",
  expected = "e2e.expected.txt",
) {
  const build = existsSync(join(dir, "polar.toml"))
    ? await run(polar, ["build"], dir)
    : { status: 0 };

  if (build.status !== 0) {
    check(name, dir, expected, build);
    return;
  }

  check(name, dir, expected, await run(process.execPath, [script], dir));
}

const tasks = [];

for (const dir of projects("tests", "polar.toml")) {
  tasks.push([
    async () => {
      const name = relative(root, dir);

      if (
        !existsSync(join(dir, "main.expected.txt")) &&
        !existsSync(join(dir, "check.expected.txt")) &&
        existsSync(join(dir, "src")) &&
        hasNativeTests(join(dir, "src"))
      ) {
        const result = await run(polar, ["test", "--no-color"], dir);

        if (result.status === 0) {
          log(
            `ok   ${name} (polar test: ${result.stdout.match(/ℹ pass (\d+)/)?.[1] ?? "?"} passed)`,
          );
        } else {
          failed++;
          log(
            `FAIL ${name} (polar test, exit ${result.status})\n${result.stdout}${result.stderr}`,
          );
        }
      } else if (existsSync(join(dir, "check.expected.txt"))) {
        check(
          name,
          dir,
          "check.expected.txt",
          await run(polar, ["check", "--no-color"], dir),
          "stderr",
        );
      } else {
        check(name, dir, "main.expected.txt", await run(polar, ["run"], dir));
      }

      if (existsSync(join(dir, "e2e.mjs"))) {
        await e2e(`${name} e2e`, dir);
      }

      await formats(name, dir);
    },
  ]);
}

for (const dir of projects("examples", "e2e.mjs")) {
  tasks.push([() => e2e(`${relative(root, dir)} e2e`, dir)]);
}

tasks.push([
  () => e2e("cli e2e", join(root, "cli")),
  () =>
    e2e(
      "scaffold e2e",
      join(root, "cli"),
      "scaffold_e2e.mjs",
      "scaffold_e2e.expected.txt",
    ),
  () =>
    e2e(
      "console e2e",
      join(root, "cli"),
      "console_e2e.mjs",
      "console_e2e.expected.txt",
    ),
  () =>
    e2e(
      "watch e2e",
      join(root, "cli"),
      "watch_e2e.mjs",
      "watch_e2e.expected.txt",
    ),
]);
tasks.push([() => e2e("launcher e2e", join(root, "launcher"))]);

const results = tasks.map(() => null);
let next = 0;

async function worker() {
  while (next < tasks.length) {
    const index = next++;
    const lines = [];

    await capture.run(lines, async () => {
      for (const step of tasks[index]) await step();
    });
    results[index] = lines;
  }
}

await Promise.all(
  Array.from(
    { length: Math.min(availableParallelism(), tasks.length) },
    worker,
  ),
);

for (const lines of results) {
  for (const line of lines) {
    console.log(line);
  }
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
