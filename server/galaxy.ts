import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OverseerRefresh } from "../src/features/overseer/adapters.ts";
import { parseRecentDays } from "../src/features/overseer/orbits.ts";
import { galaxyJson, livePayload, webDemo, type GalaxyPayload } from "../src/features/overseer/galaxyPayload.ts";
import { readGrok } from "./grokRead.ts";
import { fetchRemote, type RemoteEnv } from "./remote.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export interface GalaxyOptions {
  host: string;
  port: number;
  staticDir: string | null;
  snapshot: () => Promise<GalaxyPayload>;
}

export interface GalaxyHandle {
  port: number;
  close(): Promise<void>;
}

export function startGalaxy(opts: GalaxyOptions): Promise<GalaxyHandle> {
  const server = http.createServer((req, res) => {
    void handle(req, res, opts).catch(() => {
      if (res.headersSent) return;
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("The galaxy could not be read.");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve({
        port,
        close: () => new Promise((done, fail) => server.close((err) => err ? fail(err) : done())),
      });
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: GalaxyOptions): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET" });
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/galaxy") {
    const body = galaxyJson(await opts.snapshot());
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }
  if (!opts.staticDir) {
    res.writeHead(404);
    res.end();
    return;
  }
  const file = staticFile(opts.staticDir, url.pathname);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(file).pipe(res);
}

function staticFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = decoded === "/" ? "/galaxy.html" : decoded;
  const full = path.resolve(root, `.${rel}`);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

export interface LiveEnv extends RemoteEnv {
  demo: boolean;
  grokIndex: string;
  grokAgents: string;
  activeMinutes: number;
  recentDays: number;
}

export function liveSnapshot(env: LiveEnv): () => Promise<GalaxyPayload> {
  let remote: { at: number; value: Promise<OverseerRefresh> } | null = null;
  return () => {
    if (env.demo) return Promise.resolve(webDemo());
    const now = Date.now();
    if (!remote || now - remote.at > 20_000) remote = { at: now, value: fetchRemote(env) };
    const pending = remote.value;
    return pending.then((raw) => {
      const grok = readGrok(env.grokIndex, env.grokAgents, Date.now(), env.activeMinutes);
      return livePayload(raw, grok.available
        ? { available: true, agents: grok.agents, mentions: grok.mentions, activeMinutes: env.activeMinutes }
        : { available: false }, { prKnown: !!env.githubToken, recentDays: env.recentDays });
    });
  };
}

export function envFromProcess(source: NodeJS.ProcessEnv = process.env): LiveEnv {
  const flag = (source.HOKU_GALAXY_DEMO ?? "1").trim().toLowerCase();
  const minutes = Number(source.HOKU_GROK_ACTIVE_MINUTES ?? "15");
  return {
    demo: flag !== "0" && flag !== "false" && flag !== "off" && flag !== "no",
    cursorKey: source.CURSOR_API_KEY?.trim() || undefined,
    githubToken: (source.GITHUB_TOKEN ?? source.GH_TOKEN)?.trim() || undefined,
    hermesKey: (source.HERMES_API_KEY ?? source.API_SERVER_KEY)?.trim() || undefined,
    hermesDashboard: source.HERMES_DASHBOARD?.trim() || "http://127.0.0.1:9119",
    hermesApi: source.HERMES_API?.trim() || "http://127.0.0.1:8642",
    grokIndex: source.HOKU_GROK_INDEX?.trim() || "/home/box/agent-data/search-index.db",
    grokAgents: source.HOKU_GROK_AGENTS?.trim() || "/home/box/agent-data/agents",
    activeMinutes: Number.isInteger(minutes) && minutes >= 1 && minutes <= 24 * 60 ? minutes : 15,
    recentDays: parseRecentDays(source.HOKU_GALAXY_RECENT_DAYS),
  };
}

function main(): void {
  const env = envFromProcess();
  const port = Number(process.env.HOKU_GALAXY_PORT ?? "4730");
  const host = process.env.HOKU_GALAXY_HOST?.trim() || "0.0.0.0";
  startGalaxy({
    host,
    port: Number.isInteger(port) && port > 0 ? port : 4730,
    staticDir: path.resolve(process.cwd(), "dist/galaxy"),
    snapshot: liveSnapshot(env),
  }).then((handle) => {
    console.log(`Hoku galaxy at http://${host}:${handle.port}/ (${env.demo ? "demo" : "live"})`);
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "failed";
    console.error(`Hoku galaxy failed to start. ${message}`);
    process.exit(1);
  });
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry && import.meta.url === entry) main();
