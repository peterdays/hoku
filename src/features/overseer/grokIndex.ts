import { clip, type Front } from "./adapters";

export const GROK_UNAVAILABLE = "Grok Bot data unavailable";

export type GrokGuess = "active" | "resting" | "probably-waiting" | "unanswered";

export interface GrokColumn {
  name: string;
  type: string;
}

export interface GrokMessage {
  agentId: string;
  role: string;
  timestampMs: number;
  body: string;
  seq: number;
}

export interface GrokAgentState {
  id: string;
  name: string;
  lastTimestamp: string;
  lastRole: "user" | "assistant";
  state: GrokGuess;
}

const REQUIRED = ["id", "agent_id", "entry_id", "role", "timestamp_ms", "body", "seq"];
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** True only when `messages` still has the columns and the role check we know. */
export function messagesSchemaOk(createSql: string | null | undefined, columns: GrokColumn[]): boolean {
  if (!createSql) return false;
  const sql = createSql.replace(/\s+/g, " ").trim();
  if (!/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"messages"|messages)\b/i.test(sql)) return false;
  const byName = new Map(columns.map((c) => [c.name, c.type.toUpperCase()]));
  if (!REQUIRED.every((name) => byName.has(name))) return false;
  const role = byName.get("role") ?? "";
  const body = byName.get("body") ?? "";
  const stamp = byName.get("timestamp_ms") ?? "";
  if (!/TEXT|CHAR|CLOB/.test(role) || !/TEXT|CHAR|CLOB/.test(body) || !/INT/.test(stamp)) return false;
  const check = sql.match(/CHECK\s*\(\s*role\s+IN\s*\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)\s*\)/i);
  if (!check) return false;
  const words = [check[1], check[2]].map((s) => s.toLowerCase()).sort();
  return words[0] === "assistant" && words[1] === "user";
}

/**
 * Newest row wins (later timestamp, then higher seq).
 * A question on that row is "probably waiting", even inside the active window.
 * A newest user row is unanswered, even if the bot spoke earlier.
 */
export function deriveGrokStates(
  messages: GrokMessage[],
  names: ReadonlyMap<string, string>,
  nowMs: number,
  activeMinutes: number,
): GrokAgentState[] {
  const newest = new Map<string, GrokMessage>();
  for (const message of messages) {
    if (!AGENT_ID.test(message.agentId)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!Number.isFinite(message.timestampMs) || !Number.isFinite(message.seq)) continue;
    const prev = newest.get(message.agentId);
    if (!prev || message.timestampMs > prev.timestampMs || (message.timestampMs === prev.timestampMs && message.seq > prev.seq)) {
      newest.set(message.agentId, message);
    }
  }
  const windowMs = activeMinutes * 60_000;
  const out: GrokAgentState[] = [];
  for (const [id, message] of newest) {
    const name = names.get(id);
    if (!name) continue;
    out.push({
      id,
      name: clip(name, 64),
      lastTimestamp: new Date(message.timestampMs).toISOString(),
      lastRole: message.role === "user" ? "user" : "assistant",
      state: guessOf(message, nowMs, windowMs),
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function guessOf(message: GrokMessage, nowMs: number, windowMs: number): GrokGuess {
  if (message.role === "user") return "unanswered";
  if (message.body.trimEnd().endsWith("?")) return "probably-waiting";
  const age = nowMs - message.timestampMs;
  if (age <= windowMs) return "active";
  return "resting";
}

const FRONT_STATE = {
  active: { state: "working", reason: "~ active" },
  resting: { state: "idle", reason: "~ resting" },
  "probably-waiting": { state: "needs-you", reason: "~ waiting on you" },
  unanswered: { state: "idle", reason: "~ unanswered" },
} as const;

/** Stars for the galaxy. The reason is the guess label. The body is not copied. */
export function frontsFromGrokAgents(agents: GrokAgentState[]): Front[] {
  return agents.map((agent) => {
    const mapped = FRONT_STATE[agent.state];
    return {
      id: `grok:${agent.id}`,
      project: "Grok bots",
      kind: "grok-bot",
      title: agent.name,
      state: mapped.state,
      reason: mapped.reason,
      updatedAt: agent.lastTimestamp,
      url: `grokbot://app/v1/agent?id=${encodeURIComponent(agent.id)}`,
      source: "grok",
      detail: "Guess from the local message index.",
    };
  });
}
