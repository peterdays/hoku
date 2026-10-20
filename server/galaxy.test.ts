import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { GROK_UNAVAILABLE } from "../src/features/overseer/grokIndex.ts";
import { livePayload, type GalaxyPayload } from "../src/features/overseer/galaxyPayload.ts";
import type { OverseerRefresh } from "../src/features/overseer/adapters.ts";
import { startGalaxy } from "./galaxy.ts";
import { openReadOnly, pathAllowed, readGrok, readOnlyUri } from "./grokRead.ts";
import { httpAllowed } from "./remote.ts";

const SCHEMA = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  timestamp_ms INTEGER NOT NULL,
  body TEXT NOT NULL,
  seq INTEGER NOT NULL
)`;

const NOW = Date.parse("2026-10-17T12:00:00Z");
const MIN = 60_000;
const SENTINEL = "BODY_SENTINEL_7f3c9a_do_not_leak";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { indexPath: string; agentsPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), "hoku-galaxy-"));
  dirs.push(root);
  const indexPath = path.join(root, "search-index.db");
  const agentsPath = path.join(root, "agents");
  mkdirSync(agentsPath);
  const db = new DatabaseSync(indexPath);
  db.exec(SCHEMA);
  const insert = db.prepare("INSERT INTO messages (agent_id, entry_id, role, timestamp_ms, body, seq) VALUES (?, ?, ?, ?, ?, ?)");
  const rows: [string, string, string, number, string, number][] = [
    ["bot-active", "a1", "user", NOW - 30 * MIN, SENTINEL, 1],
    ["bot-active", "a2", "assistant", NOW - 2 * MIN, "Notes are drafted.", 2],
    ["bot-rest", "r1", "assistant", NOW - 90 * MIN, `${SENTINEL} old`, 1],
    ["bot-wait", "w1", "assistant", NOW - MIN, "Which version should ship?", 1],
    ["bot-ask-old", "q1", "assistant", NOW - 3 * 60 * MIN, "Still there?  ", 1],
    ["bot-open", "o1", "assistant", NOW - 5 * MIN, "On it.", 1],
    ["bot-open", "o2", "user", NOW - MIN, `${SENTINEL} ping`, 2],
    ["bot-tie", "t1", "assistant", NOW - MIN, "Which one?", 1],
    ["bot-tie", "t2", "assistant", NOW - MIN, "Shipped 1.2.", 3],
    ["room-1", "g1", "assistant", NOW - MIN, `${SENTINEL} group`, 1],
    ["ghost", "h1", "assistant", NOW - MIN, `${SENTINEL} ghost`, 1],
  ];
  for (const row of rows) insert.run(...row);
  db.close();
  writeProfile(agentsPath, "bot-active", "Release notes");
  writeProfile(agentsPath, "bot-rest", "Triage");
  writeProfile(agentsPath, "bot-wait", "Version picker");
  writeProfile(agentsPath, "bot-ask-old", "Old question");
  writeProfile(agentsPath, "bot-open", "Changelog");
  writeProfile(agentsPath, "bot-tie", "Ship it");
  writeProfile(agentsPath, "room-1", "Group room");
  writeFileSync(path.join(agentsPath, "room-1", "group.json"), "{}\n");
  writeProfile(agentsPath, "ghost-named", "No messages");
  return { indexPath, agentsPath };
}

function writeProfile(agentsPath: string, id: string, name: string): void {
  const folder = path.join(agentsPath, id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "profile.json"), JSON.stringify({ name, prompt: SENTINEL }));
}

function blank(): OverseerRefresh {
  return {
    cursorItems: [],
    cursorRuns: [],
    cursorError: "No Cursor API key.",
    cursorSkipped: false,
    githubReview: [],
    githubChanges: [],
    githubFailing: [],
    githubAuthored: [],
    githubIssues: [],
    githubError: "No GitHub token.",
    githubSkipped: false,
    hermesSessions: null,
    hermesError: "Hermes is not running.",
    hermesNote: "",
    hermesSkipped: false,
    hermesDashboard: "http://127.0.0.1:9119",
    grokText: null,
    grokError: null,
    grokNote: "",
    grokSkipped: true,
  };
}

describe("synthetic grok index", () => {
  it("opens file:...?mode=ro and refuses a write", () => {
    const { indexPath } = fixture();
    expect(readOnlyUri(indexPath)).toMatch(/^file:\/\//);
    expect(readOnlyUri(indexPath)).toContain("mode=ro");
    const db = openReadOnly(indexPath);
    expect(() => db.exec("CREATE TABLE injected(id INTEGER)")).toThrow(/readonly/i);
    db.close();
  });

  it("derives guesses from the newest row and skips group rooms", () => {
    const { indexPath, agentsPath } = fixture();
    const read = readGrok(indexPath, agentsPath, NOW, 15);
    expect(read.available).toBe(true);
    if (!read.available) return;
    const byId = Object.fromEntries(read.agents.map((agent) => [agent.id, agent]));
    expect(byId["bot-active"]).toMatchObject({ name: "Release notes", state: "active", lastRole: "assistant" });
    expect(byId["bot-rest"]).toMatchObject({ state: "resting" });
    expect(byId["bot-wait"]).toMatchObject({ state: "probably-waiting" });
    expect(byId["bot-ask-old"]).toMatchObject({ state: "probably-waiting" });
    expect(byId["bot-open"]).toMatchObject({ state: "unanswered", lastRole: "user" });
    expect(byId["bot-tie"]).toMatchObject({ state: "active" });
    expect(byId["room-1"]).toBeUndefined();
    expect(byId["ghost"]).toBeUndefined();
    expect(JSON.stringify(read.agents)).not.toContain(SENTINEL);
    expect(JSON.stringify(read.mentions)).not.toContain(SENTINEL);
  });

  it("says the source is unavailable when the schema does not match", () => {
    const { indexPath, agentsPath } = fixture();
    const db = new DatabaseSync(indexPath);
    db.exec("DROP TABLE messages");
    db.exec("CREATE TABLE messages (id INTEGER, agent_id TEXT, role TEXT, body TEXT)");
    db.prepare("INSERT INTO messages (id, agent_id, role, body) VALUES (1, 'bot-active', 'assistant', ?)").run(SENTINEL);
    db.close();
    const read = readGrok(indexPath, agentsPath, NOW, 15);
    expect(read).toEqual({ available: false });
    const payload = livePayload(blank(), { available: false });
    expect(payload.sources.find((source) => source.key === "grok")?.detail).toBe(GROK_UNAVAILABLE);
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);
  });

  it("refuses secret filenames and the gateway port", () => {
    expect(pathAllowed("/home/box/agent-data/search-index.db")).toBe(true);
    expect(pathAllowed("/home/box/agent-data/box-secrets.json")).toBe(false);
    expect(pathAllowed("/home/box/agent-data/host-secrets.json")).toBe(false);
    expect(pathAllowed("/home/box/agent-data/gateway.json")).toBe(false);
    expect(pathAllowed("/tmp/chrome-cookie-seed.json")).toBe(false);
    expect(pathAllowed("/home/box/agent-data/store.db")).toBe(false);
    expect(pathAllowed("/tmp/../etc/passwd")).toBe(false);
    expect(httpAllowed("http://127.0.0.1:1340/api/sessions")).toBe(false);
    expect(httpAllowed("http://127.0.0.1:9119/api/status")).toBe(true);
    expect(httpAllowed("https://api.github.com/search/issues")).toBe(true);
    expect(httpAllowed("https://example.com/")).toBe(false);
  });
});

describe("GET /api/galaxy", () => {
  it("does not include message bodies", async () => {
    const { indexPath, agentsPath } = fixture();
    const db = new DatabaseSync(indexPath);
    const insert = db.prepare("INSERT INTO messages (agent_id, entry_id, role, timestamp_ms, body, seq) VALUES (?, ?, ?, ?, ?, ?)");
    insert.run("bot-active", "m1", "user", NOW - 10 * MIN, `See https://github.com/hoku-demo/site/pull/4 ${SENTINEL}`, 4);
    insert.run("bot-active", "m2", "assistant", NOW - 9 * MIN, "https://cursor.com/agents/bc-11111111-2222-4333-8444-555555555555 and https://github.com/hoku-demo/site/issues/9", 5);
    insert.run("room-1", "g2", "assistant", NOW - MIN, "https://github.com/hoku-demo/secret/pull/1 bc-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 2);
    db.close();
    const raw = blank();
    raw.cursorError = null;
    raw.cursorItems = [
      {
        id: "bc-11111111-2222-4333-8444-555555555555",
        name: "Site work",
        status: "IDLE",
        runStatus: "FINISHED",
        repository: "hoku-demo/site",
        prUrl: "https://github.com/hoku-demo/site/pull/4",
        githubPr: "open",
        updatedAt: new Date(NOW).toISOString(),
        url: "https://cursor.com/agents/bc-11111111-2222-4333-8444-555555555555",
      },
      {
        id: "bc-99999999-8888-4777-8666-555555555555",
        name: "HIDDEN_CLOSED",
        status: "IDLE",
        runStatus: "FINISHED",
        repository: "hoku-demo/site",
        prUrl: "https://github.com/hoku-demo/site/pull/2",
        githubPr: "closed",
        updatedAt: new Date(NOW).toISOString(),
      },
    ];
    const server = await startGalaxy({
      host: "127.0.0.1",
      port: 0,
      staticDir: null,
      snapshot: async () => {
        const grok = readGrok(indexPath, agentsPath, NOW, 15);
        return livePayload(raw, grok.available
          ? { available: true, agents: grok.agents, mentions: grok.mentions, activeMinutes: 15 }
          : { available: false });
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/galaxy`);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain('"body"');
      expect(text).not.toContain('"prompt"');
      expect(text).toContain("bc-11111111-2222-4333-8444-555555555555");
      expect(text).toContain("hoku-demo/site");
      expect(text).not.toContain("bc-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      expect(text).not.toContain("hoku-demo/secret");
      expect(text).not.toContain("HIDDEN_CLOSED");
      const json = JSON.parse(text) as GalaxyPayload;
      const site = json.orbits.find((cluster) => cluster.slug === "hoku-demo/site");
      const bot = site?.bots.find((star) => star.id === "grok:bot-active");
      expect(bot?.mentions).toBeGreaterThanOrEqual(2);
      expect(bot?.lastMentioned).toBe(new Date(NOW - 9 * MIN).toISOString());
      expect(bot?.guess).toBe(true);
      const waiting = json.grokAgents.find((agent) => agent.id === "bot-wait");
      expect(waiting).toEqual({
        id: "bot-wait",
        name: "Version picker",
        lastTimestamp: new Date(NOW - MIN).toISOString(),
        lastRole: "assistant",
        state: "probably-waiting",
      });
      expect(json.fronts.find((front) => front.id === "grok:bot-wait")).toMatchObject({
        state: "needs-you",
        reason: "~ waiting on you",
        url: "grokbot://app/v1/agent?id=bot-wait",
      });
      const posted = await fetch(`http://127.0.0.1:${server.port}/api/galaxy`, { method: "POST", body: "hello" });
      expect(posted.status).toBe(405);
    } finally {
      await server.close();
    }
  });
});
