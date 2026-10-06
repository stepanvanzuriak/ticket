import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

async function load(manifest) {
  const options = manifest.options ?? {};
  const serverHost = options.server ?? "Node";
  const server = manifest.hosts?.[serverHost] ?? manifest.out;
  const main = manifest.main ?? "main.js";
  const from = (dir, file) => import(pathToFileURL(join(dir, file)).href);

  return {
    options,
    serverHost,
    main,
    client: manifest.hosts?.[options.client ?? "Browser"],
    from,
    rt: await from(server, "_polar/runtime.js"),
    program: await from(server, main),
    server,
  };
}


const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".xml": "application/xml",
};

const hashed = /[-.][0-9a-f]{8,}\.[A-Za-z0-9]+$/;

export async function locate(root, pathname) {
  let decoded;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded === "/" || decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("//")) {
    return null;
  }

  const parts = decoded.split("/").filter((part) => part !== "");

  if (parts.some((part) => part === ".." || part.startsWith("."))) {
    return null;
  }

  const top = resolve(root);
  const file = resolve(top, ...parts);

  if (!file.startsWith(top + sep)) {
    return null;
  }

  try {
    const real = await realpath(file);

    if (!real.startsWith((await realpath(top)) + sep)) {
      return null;
    }

    const info = await stat(real);

    return info.isFile() ? { file: real, info } : null;
  } catch {
    return null;
  }
}

export function staticHandler(root, options = {}) {
  const production = options.env !== "development";

  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return null;
    }

    const found = await locate(root, new URL(request.url).pathname);

    if (found === null) {
      return null;
    }

    const { file, info } = found;
    const headers = {
      "content-type": types[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(info.size),
    };

    if (production) {
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;

      headers.etag = etag;
      headers["cache-control"] = hashed.test(file)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600";

      if (request.headers.get("if-none-match") === etag) {
        delete headers["content-length"];
        return new Response(null, { status: 304, headers });
      }
    } else {
      headers["cache-control"] = "no-cache";
    }

    const body = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(file));

    return new Response(body, { status: 200, headers });
  };
}

export async function publicPage(root, name) {
  const found = await locate(root, `/${name}`);

  return found === null ? null : found.file;
}

const secrets = ["password", "secret", "token", "authenticity_token", "_csrf", "cookie"];

function filtered(key, extra) {
  const lower = key.toLowerCase();

  return [...secrets, ...extra.map((name) => name.toLowerCase())].some((name) => lower.includes(name));
}

export function filterParams(params, extra = []) {
  if (Array.isArray(params)) {
    return params.map((value) => filterParams(value, extra));
  }

  if (params === null || typeof params !== "object") {
    return params;
  }

  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      filtered(key, extra) ? "[FILTERED]" : filterParams(value, extra),
    ]),
  );
}

export function nest(pairs) {
  const root = {};

  for (const [name, value] of pairs) {
    const path = [...name.matchAll(/^[^[\]]+|\[([^[\]]*)\]/g)].map((m) => m[1] ?? m[0]);
    let at = root;

    path.forEach((key, i) => {
      const last = i === path.length - 1;

      if (key === "" && Array.isArray(at)) {
        at.push(value);
      } else if (last) {
        if (Array.isArray(at)) {
          at.push(value);
        } else {
          at[key] = value;
        }
      } else {
        const next = path[i + 1] === "" ? [] : {};

        at[key] = typeof at[key] === "object" && at[key] !== null ? at[key] : next;
        at = at[key];
      }
    });
  }

  return root;
}

export function bodyParams(contentType, body) {
  const kind = (contentType ?? "").toLowerCase();

  if (kind.startsWith("application/x-www-form-urlencoded")) {
    return nest(new URLSearchParams(body));
  }

  if (kind.startsWith("application/json")) {
    try {
      const value = JSON.parse(body);

      return value !== null && typeof value === "object" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export function loggedPath(url, extra = []) {
  const { pathname, searchParams } = new URL(url);

  if ([...searchParams].length === 0) {
    return pathname;
  }

  const query = [...searchParams]
    .map(([key, value]) => `${encodeURIComponent(key)}=${filtered(key, extra) ? "[FILTERED]" : encodeURIComponent(value)}`)
    .join("&");

  return `${pathname}?${query}`;
}

export async function requestParams(request, extra = []) {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const params = bodyParams(request.headers.get("content-type"), await request.text());

  return params === undefined ? undefined : filterParams(params, extra);
}

export function requestLog(options, write = console.log) {
  const extra = options.filter_params ?? [];

  return (handler) => async (request) => {
    if (options.log === "off") {
      return handler(request);
    }

    const peek = request.method === "GET" || request.method === "HEAD" ? null : request.clone();
    const started = performance.now();
    const response = await handler(request);
    const ms = Math.round(performance.now() - started);
    const params = peek === null ? undefined : await requestParams(peek, extra).catch(() => undefined);
    const shown = params === undefined || Object.keys(params).length === 0 ? "" : `  params=${JSON.stringify(params)}`;

    write(`Started ${request.method} "${loggedPath(request.url, extra)}" ${response.status} (${ms}ms)${shown}`);

    return response;
  };
}


const html = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function acceptsHtml(request) {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

const pageHead = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">';

async function developmentPage(request, error, options) {
  const params = await requestParams(request, options.filter_params ?? []).catch(() => undefined);
  const message = error?.message ?? String(error);
  const stack = error?.stack ?? String(error);

  return (
    `${pageHead}<title>Error: ${html(message)}</title>` +
    `<body style="font-family:system-ui;margin:2rem"><h1>${html(message)}</h1>` +
    `<h2>Request</h2><p><code>${html(request.method)} ${html(loggedPath(request.url, options.filter_params ?? []))}</code></p>` +
    `<h2>Params</h2><pre>${html(JSON.stringify(params === undefined ? {} : filterParams(params, options.filter_params ?? []), null, 2))}</pre>` +
    `<h2>Stack</h2><pre>${html(stack)}</pre></body>`
  );
}

export async function errorPage(kind, request, error, options = {}) {
  const status = Number(kind);
  const development = options.env === "development";
  const browser = acceptsHtml(request);

  if (kind === "500") {
    if (development) {
      return browser
        ? new Response(await developmentPage(request, error, options), {
            status,
            headers: { "content-type": "text/html; charset=utf-8" },
          })
        : new Response(`internal server error\n\n${error?.stack ?? error}`, {
            status,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
    }
  }

  if (!development && browser && options.public !== undefined) {
    const file = await publicPage(options.public, `${kind}.html`);

    if (file !== null) {
      return new Response(await readFile(file), {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  }

  return kind === "500"
    ? new Response("internal server error", {
        status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    : new Response(JSON.stringify({ error: "not found" }), {
        status,
        headers: { "content-type": "application/json" },
      });
}

function routerHandler(rt, router, options) {
  return async (request) => {
    let routed;
    const copy = request.clone();

    try {
      routed = await router(await rt.http.toRequest(request));
    } catch (e) {
      console.error(e);

      return errorPage("500", copy, e, options);
    }

    return routed.$ === "Some" ? rt.http.fromResponse(routed._0) : null;
  };
}

export function nodeListener(handler, { limit = 1_000_000 } = {}) {
  return async (req, res) => {
    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
      size += chunk.length;

      if (size > limit) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request too large" }));
        return;
      }

      chunks.push(chunk);
    }

    const bodyless = req.method === "GET" || req.method === "HEAD";
    const request = new Request(new URL(req.url, "http://localhost"), {
      method: req.method,
      headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
      body: bodyless ? undefined : Buffer.concat(chunks),
    });
    const response = await handler(request);
    const headers = {};

    for (const [name, value] of response.headers) {
      if (name !== "set-cookie") {
        headers[name] = value;
      }
    }

    const cookies = response.headers.getSetCookie();

    if (cookies.length > 0) {
      headers["set-cookie"] = cookies;
    }

    res.writeHead(response.status, headers);

    if (response.body === null) {
      res.end();
    } else {
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  };
}

export function serverSettings(manifest) {
  const root = manifest.root;
  const given = root === undefined ? {} : (readConfig(root).server ?? {});
  const options = manifest.options ?? {};
  const folder = options.public ?? given.public ?? "public";

  return {
    ...options,
    log: options.log ?? given.log ?? "request",
    filter_params: options.filter_params ?? given.filter_params ?? [],
    public: root === undefined ? undefined : resolve(root, folder),
  };
}

export async function serve(manifest, hooks = {}) {
  const { serverHost, main, client, from, rt, program, server } = await load(manifest);
  const options = serverSettings(manifest);

  if (typeof program.router !== "function") {
    throw new Error(`\`${main}\` for ${serverHost} doesn't export \`router\``);
  }

  const handlers = [];

  if (options.public !== undefined) {
    handlers.push(staticHandler(options.public, options));
  }

  if (client) {
    handlers.push(rt.http.files(client, { prefix: "/_client/" }));
  }

  if (existsSync(join(server, "_polar/bridges.js"))) {
    const { bridges } = await from(server, "_polar/bridges.js");

    handlers.push(rt.bridge.handler(bridges));
  }

  handlers.push(routerHandler(rt, program.router, options));

  const routed = rt.http.compose(...handlers);
  const answered = async (request) =>
    (await routed(request)) ?? errorPage("404", request, undefined, options);
  const logged = requestLog(options, hooks.write ?? console.log)(answered);
  const listener = createServer(nodeListener(logged));
  const hostname = options.hostname ?? "127.0.0.1";

  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(options.port ?? 3000, hostname, resolve);
  });

  return listener;
}

export const tasks = {
  routes: routesTask,
  "db:migrate": (manifest, args) => migrationTask(manifest, "migrate", args),
  "db:rollback": (manifest, args) => migrationTask(manifest, "rollback", args),
  "db:status": (manifest, args) => migrationTask(manifest, "status", args),
  "db:reset": resetTask,
  "db:seed": seedTask,
};

export function migrationArgs(args) {
  const parsed = { version: "", step: 1 };

  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    const value = inline ?? args[++i];

    if (flag !== "--version" && flag !== "--step") {
      return { error: `unknown argument \`${args[i]}\`` };
    }

    if (value === undefined || value === "") {
      return { error: `\`${flag}\` needs a value` };
    }

    if (flag === "--version") {
      parsed.version = value;
    } else if (/^[1-9]\d*$/.test(value)) {
      parsed.step = Number(value);
    } else {
      return { error: `\`--step\` must be a positive integer, not \`${value}\`` };
    }
  }

  return parsed;
}

async function migrator(manifest) {
  const { program, main } = await load(manifest);

  if (typeof program.migrate !== "function") {
    console.error(
      `\`${main}\` doesn't export \`migrate\`: add \`migrate(command: String, step: Int, version: String) -> Int / {Db, Clock}\` calling \`Migrate.run(Schema.migrations, command, step, version)\``,
    );
    return null;
  }

  return program.migrate;
}

async function migrationTask(manifest, command, args) {
  const parsed = migrationArgs(args);

  if (parsed.error !== undefined) {
    console.error(`error: ${parsed.error}`);
    return 2;
  }

  const migrate = await migrator(manifest);

  return migrate === null ? 1 : migrate(command, parsed.step, parsed.version);
}

async function seedTask(manifest) {
  const { program, main } = await load(manifest);

  if (typeof program.seed !== "function") {
    console.error(`\`${main}\` doesn't export \`seed\`: add \`seed() -> {} / {Db}\``);
    return 1;
  }

  await program.seed();
  return 0;
}

async function resetTask(manifest) {
  const migrate = await migrator(manifest);

  if (migrate === null) {
    return 1;
  }

  const code = await migrate("reset", 1, "");

  return code === 0 && typeof (await load(manifest)).program.seed === "function"
    ? seedTask(manifest)
    : code;
}

async function routesTask(manifest) {
  const { program, main } = await load(manifest);

  if (program.route_table === undefined) {
    console.error(`\`${main}\` doesn't export \`route_table\`: it needs a \`routes\` zone`);
    return 1;
  }

  const rows = [];

  for (let rest = program.route_table; rest.$ === "Cons"; rest = rest._1) {
    const { name, method, path, action } = rest._0;

    rows.push([name === "" ? "" : `${name}_path`, method, path, action]);
  }

  const widths = [0, 1, 2].map((c) => Math.max(0, ...rows.map((r) => r[c].length)));

  for (const row of rows) {
    console.log(row.map((cell, c) => (c < 3 ? cell.padEnd(widths[c]) : cell)).join("  ").trimEnd());
  }

  return 0;
}

export function taskArgs(argv) {
  const rest = argv.slice(3);
  const dash = rest.indexOf("--");

  return dash === -1 ? rest : rest.slice(dash + 1);
}

export function withPortFromEnv(manifest, port) {
  if (port === undefined || port === "") {
    return manifest;
  }

  return { ...manifest, options: { ...manifest.options, port: Number(port) } };
}

const settings = {
  database: { adapter: "string", database: "string", migrate: "string" },
  session: { secret: "string", max_age: "number" },
  server: { public: "string", log: "string", filter_params: "array" },
};

export function readConfig(root) {
  const file = join(root, "ticket.toml");

  return existsSync(file) ? parseConfig(readFileSync(file, "utf8"), "ticket.toml") : {};
}

export function parseConfig(text, file) {
  const config = {};
  let table = null;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^\s+|\s+$/g, "");
    const fail = (message) => {
      throw new Error(`${file}:${index + 1}: ${message}`);
    };

    if (line === "" || line.startsWith("#")) {
      return;
    }

    const header = line.match(/^\[\s*([A-Za-z0-9_-]+)\s*\]\s*(#.*)?$/);

    if (header) {
      table = header[1];

      if (settings[table] === undefined) {
        fail(`unknown table \`[${table}]\`; the tables are: ${Object.keys(settings).map((t) => `[${t}]`).join(", ")}`);
      }

      if (config[table] !== undefined) {
        fail(`\`[${table}]\` is defined twice`);
      }

      config[table] = {};
      return;
    }

    const entry = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);

    if (!entry) {
      fail(`expected \`key = value\` or \`[table]\`, found \`${line}\``);
    }

    const [, key, rest] = entry;

    if (table === null) {
      fail(`\`${key}\` must be inside a table, like \`[database]\``);
    }

    const kind = settings[table][key];

    if (kind === undefined) {
      fail(`unknown key \`${key}\` in \`[${table}]\`; the keys are: ${Object.keys(settings[table]).join(", ")}`);
    }

    if (Object.hasOwn(config[table], key)) {
      fail(`\`${key}\` is defined twice in \`[${table}]\``);
    }

    const value = parseValue(rest);

    if (value === undefined) {
      fail(`\`${key}\` has a value that isn't a string, an integer or a boolean: \`${rest}\``);
    }

    if ((kind === "array" ? !Array.isArray(value) : typeof value !== kind)) {
      fail(`\`${key}\` must be a ${kind === "array" ? "list of strings" : kind}`);
    }

    if (table === "server" && key === "log" && value !== "request" && value !== "off") {
      fail("`log` must be \"request\" or \"off\"");
    }

    if (table === "database" && key === "migrate" && value !== "auto" && value !== "manual") {
      fail("`migrate` must be \"auto\" or \"manual\"");
    }

    config[table][key] = value;
  });

  return config;
}

function parseValue(text) {
  const list = text.match(/^\[(.*)\]\s*(#.*)?$/);

  if (list) {
    const items = [...list[1].matchAll(/\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(,|$)/g)];
    const rebuilt = items.map((m) => m[0]).join("");

    if (rebuilt.trim() !== list[1].trim()) {
      return undefined;
    }

    const values = items.map((m) => parseValue(m[1]));

    return values.some((v) => typeof v !== "string") ? undefined : values;
  }

  const basic = text.match(/^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/);

  if (basic) {
    try {
      return JSON.parse(`"${basic[1]}"`);
    } catch {
      return undefined;
    }
  }

  const literal = text.match(/^'([^']*)'\s*(#.*)?$/);

  if (literal) {
    return literal[1];
  }

  const bare = text.replace(/\s*#.*$/, "");

  if (/^[+-]?\d+$/.test(bare)) {
    return Number(bare);
  }

  return bare === "true" ? true : bare === "false" ? false : undefined;
}

const adapters = {
  sqlite: {
    database: "db/development.sqlite3",
    locate: (database, root) =>
      database === ":memory:" || isAbsolute(database) ? database : resolve(root, database),
  },
};

export function databaseConfig(root, config, env) {
  const given = (value) => (value === undefined || value === "" ? undefined : value);
  const name = given(env.TICKET_DATABASE_ADAPTER) ?? config.database?.adapter ?? "sqlite";
  const adapter = Object.hasOwn(adapters, name) ? adapters[name] : undefined;

  if (adapter === undefined) {
    throw new Error(
      `unknown database adapter \`${name}\`; the adapters are: ${Object.keys(adapters).join(", ")}`,
    );
  }

  const database = given(env.TICKET_DATABASE) ?? config.database?.database ?? adapter.database;

  return { adapter: name, database: adapter.locate(database, root) };
}

export function useDatabase(manifest, environment) {
  const root = manifest.root ?? process.cwd();
  const { adapter, database } = databaseConfig(root, readConfig(root), environment);

  environment.TICKET_DATABASE_ADAPTER = adapter;
  environment.TICKET_DATABASE = database;
}

export function sessionSettings(config, environment, options = {}) {
  const given = (value) => (value === undefined || value === "" ? undefined : String(value));
  const env = given(environment.TICKET_ENV) ?? given(options.env) ?? "production";
  const secret = given(environment.TICKET_SECRET) ?? given(config.session?.secret);
  const maxAge = given(environment.TICKET_SESSION_MAX_AGE) ?? given(config.session?.max_age);
  const variables = { TICKET_ENV: env };

  if (maxAge !== undefined) {
    variables.TICKET_SESSION_MAX_AGE = maxAge;
  }

  if (secret !== undefined) {
    variables.TICKET_SECRET = secret;
    return { variables };
  }

  if (config.session === undefined) {
    return { variables };
  }

  if (env === "production") {
    throw new Error(
      "sessions need a secret in production: set `secret` under `[session]` in ticket.toml, or `TICKET_SECRET`",
    );
  }

  return {
    variables,
    warning: "warning: no session secret, using the development one (set `[session] secret` or `TICKET_SECRET`)",
  };
}

export function useSession(manifest, environment) {
  const root = manifest.root ?? process.cwd();
  const { variables, warning } = sessionSettings(readConfig(root), environment, manifest.options);

  Object.assign(environment, variables);

  if (warning !== undefined) {
    console.warn(warning);
  }
}

export async function runTask(manifest, [name, ...args]) {
  const task = tasks[name];

  if (task === undefined) {
    console.error(`unknown task \`${name}\`; the tasks are: ${Object.keys(tasks).join(", ")}`);
    return 2;
  }

  return task(manifest, args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
  const args = taskArgs(process.argv);

  try {
    useDatabase(manifest, process.env);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }

  if (args.length > 0) {
    process.exitCode = await runTask(manifest, args);
  } else {
    try {
      useSession(manifest, process.env);
    } catch (error) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }

    if (readConfig(manifest.root ?? process.cwd()).database?.migrate === "auto") {
      const code = await migrationTask(manifest, "migrate", []);

      if (code !== 0) {
        process.exit(code);
      }
    }

    const listener = await serve(withPortFromEnv(manifest, process.env.PORT));
    const { address, port } = listener.address();

    console.log(`${manifest.project} is listening on http://${address}:${port}`);

    const stop = () => {
      listener.closeAllConnections();
      listener.close();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}
