
import { fileURLToPath } from "node:url";

const main = await import(fileURLToPath(new URL("dist/main.js", import.meta.url)));

console.log(`16 deterministic: ${await main.determinism()}`);
console.log(`16 deterministic_again: ${await main.determinism()}`);

import { spawnSync } from "node:child_process";

const sample = () =>
  spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(fileURLToPath(new URL("dist/main.js", import.meta.url)))}); console.log(await m.sample());`], { encoding: "utf8" });
const a = sample();
const b = sample();

console.log(`16 same_across_processes: ${a.status === 0 && a.stdout === b.stdout && a.stdout.trim() !== ""} ${a.stdout.trim().slice(0, 12)}…`);
