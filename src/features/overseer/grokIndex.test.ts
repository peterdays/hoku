import { describe, expect, it } from "vitest";
import { galaxyJson, webDemo } from "./galaxyPayload";
import { deriveGrokStates, messagesSchemaOk, type GrokMessage } from "./grokIndex";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const MIN = 60_000;

function msg(p: Partial<GrokMessage> & Pick<GrokMessage, "agentId" | "role" | "timestampMs" | "body">): GrokMessage {
  return { seq: 1, ...p };
}

describe("deriveGrokStates", () => {
  const names = new Map([["bot", "Release notes"]]);

  it("treats a recent assistant line as active and an old one as resting", () => {
    const active = deriveGrokStates([msg({ agentId: "bot", role: "assistant", timestampMs: NOW - 2 * MIN, body: "Pushed the notes." })], names, NOW, 15);
    const resting = deriveGrokStates([msg({ agentId: "bot", role: "assistant", timestampMs: NOW - 40 * MIN, body: "Pushed the notes." })], names, NOW, 15);
    expect(active[0].state).toBe("active");
    expect(resting[0].state).toBe("resting");
  });

  it("counts the boundary minute as active", () => {
    const edge = deriveGrokStates([msg({ agentId: "bot", role: "assistant", timestampMs: NOW - 15 * MIN, body: "Still here." })], names, NOW, 15);
    const past = deriveGrokStates([msg({ agentId: "bot", role: "assistant", timestampMs: NOW - 15 * MIN - 1, body: "Still here." })], names, NOW, 15);
    expect(edge[0].state).toBe("active");
    expect(past[0].state).toBe("resting");
  });

  it("lets a trailing question beat a recent reply, including trailing space", () => {
    const waiting = deriveGrokStates([msg({ agentId: "bot", role: "assistant", timestampMs: NOW - MIN, body: "Which version?\n" })], names, NOW, 15);
    expect(waiting[0]).toMatchObject({ state: "probably-waiting", lastRole: "assistant" });
  });

  it("calls it unanswered when the newest row is the user's, even after a recent reply", () => {
    const rows = [
      msg({ agentId: "bot", role: "assistant", timestampMs: NOW - 2 * MIN, body: "On it.", seq: 1 }),
      msg({ agentId: "bot", role: "user", timestampMs: NOW - MIN, body: "And the changelog?", seq: 2 }),
    ];
    expect(deriveGrokStates(rows, names, NOW, 15)[0].state).toBe("unanswered");
  });

  it("uses the higher seq when timestamps tie, and ignores an older question", () => {
    const rows = [
      msg({ agentId: "bot", role: "assistant", timestampMs: NOW - MIN, body: "Which version?", seq: 1 }),
      msg({ agentId: "bot", role: "assistant", timestampMs: NOW - MIN, body: "Shipping 1.2.", seq: 4 }),
    ];
    expect(deriveGrokStates(rows, names, NOW, 15)[0].state).toBe("active");
  });

  it("skips a bot with no profile name and does not return the body", () => {
    const body = "SECRET_BODY_not_a_name";
    const states = deriveGrokStates([msg({ agentId: "ghost", role: "assistant", timestampMs: NOW, body })], names, NOW, 15);
    expect(states).toEqual([]);
    expect(JSON.stringify(states)).not.toContain(body);
  });
});

describe("messagesSchemaOk", () => {
  const columns = [
    { name: "id", type: "INTEGER" },
    { name: "agent_id", type: "TEXT" },
    { name: "entry_id", type: "TEXT" },
    { name: "role", type: "TEXT" },
    { name: "timestamp_ms", type: "INTEGER" },
    { name: "body", type: "TEXT" },
    { name: "seq", type: "INTEGER" },
  ];
  const sql = `CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    timestamp_ms INTEGER NOT NULL,
    body TEXT NOT NULL,
    seq INTEGER NOT NULL
  )`;

  it("accepts the known table and an extra column", () => {
    expect(messagesSchemaOk(sql, columns)).toBe(true);
    expect(messagesSchemaOk(sql, [...columns, { name: "tool", type: "TEXT" }])).toBe(true);
  });

  it("rejects a missing column, a widened role check, and a different table", () => {
    expect(messagesSchemaOk(sql, columns.filter((c) => c.name !== "body"))).toBe(false);
    expect(messagesSchemaOk(sql.replace("'assistant'", "'assistant', 'tool'"), columns)).toBe(false);
    expect(messagesSchemaOk(sql.replace("messages", "notes"), columns)).toBe(false);
    expect(messagesSchemaOk(null, columns)).toBe(false);
  });
});

describe("galaxyJson", () => {
  it("drops a message body that was attached beside the public fields", () => {
    const payload = webDemo();
    const sentinel = "BODY_SENTINEL_gallery_json";
    (payload.grokAgents[0] as unknown as { body: string }).body = sentinel;
    (payload.fronts[0] as unknown as { body: string }).body = sentinel;
    const star = payload.orbits.flatMap((cluster) => [...cluster.bots, ...cluster.work]).find(Boolean);
    if (star) (star as unknown as { body: string }).body = sentinel;
    const text = galaxyJson(payload);
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain('"body"');
    const parsed = JSON.parse(text) as { grokAgents: Record<string, string>[] };
    expect(Object.keys(parsed.grokAgents[0]).sort()).toEqual(["id", "lastRole", "lastTimestamp", "name", "state"]);
  });
});
