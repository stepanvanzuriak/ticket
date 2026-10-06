import { fileURLToPath } from "node:url";
import { serve } from "../../launcher/serve.mjs";

const dist = fileURLToPath(new URL("dist/", import.meta.url));
const server = await serve({
  version: 1,
  project: "hello",
  main: "main.js",
  hosts: { Node: dist },
  options: { port: 0, log: "off" },
});

const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path) {
  const response = await fetch(`${base}${path}`, { method });
  const text = await response.text();

  console.log(`${method} ${path} -> ${response.status} ${text}`.trimEnd());
}

try {
  await call("GET", "/");
  await call("GET", "/nope");
} finally {
  server.close();
}
