import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { deriveGrokStates, messagesSchemaOk, type GrokAgentState, type GrokColumn, type GrokMessage } from "../src/features/overseer/grokIndex.ts";

const BLOCKED = new Set(["box-secrets.json", "host-secrets.json", "gateway.json", "chrome-cookie-seed.json"]);

export function pathAllowed(filePath: string): boolean {
  if (filePath.includes("\0")) return false;
  const parts = filePath.split(/[/\\]/);
  if (parts.some((part) => part === "..")) return false;
  const base = path.basename(filePath);
  if (BLOCKED.has(base) || base === "store.db") return false;
  return true;
}

/** `file:<absolute>?mode=ro`, the URI Node's SQLite opener accepts on recent 22.x. */
export function readOnlyUri(filePath: string): string {
  const url = pathToFileURL(path.resolve(filePath));
  url.searchParams.set("mode", "ro");
  return url.href;
}

export function openReadOnly(filePath: string): DatabaseSync {
  const uri = readOnlyUri(filePath);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(uri, { readOnly: true });
  } catch {
    db = new DatabaseSync(path.resolve(filePath), { readOnly: true });
  }
  try {
    db.exec("PRAGMA query_only = ON");
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function readGrok(indexPath: string, agentsPath: string, nowMs: number, activeMinutes: number): { available: true; agents: GrokAgentState[] } | { available: false } {
  if (!pathAllowed(indexPath) || !pathAllowed(agentsPath)) return { available: false };
  let db: DatabaseSync | null = null;
  try {
    if (!fs.statSync(indexPath).isFile() || !fs.statSync(agentsPath).isDirectory()) return { available: false };
    const names = readNames(agentsPath);
    db = openReadOnly(indexPath);
    const master = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
    const columns = db.prepare("PRAGMA table_info(messages)").all().map(columnOf);
    const sql = master && typeof master.sql === "string" ? master.sql : null;
    if (!messagesSchemaOk(sql, columns)) return { available: false };
    const rows = db.prepare(`
      SELECT agent_id, role, timestamp_ms, body, seq
      FROM (
        SELECT agent_id, role, timestamp_ms, body, seq,
               ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY timestamp_ms DESC, seq DESC, id DESC) AS rn
        FROM messages
      )
      WHERE rn = 1
    `).all();
    const messages: GrokMessage[] = [];
    for (const row of rows) {
      if (typeof row.agent_id !== "string" || typeof row.role !== "string" || typeof row.body !== "string") continue;
      const timestampMs = typeof row.timestamp_ms === "number" ? row.timestamp_ms : Number(row.timestamp_ms);
      const seq = typeof row.seq === "number" ? row.seq : Number(row.seq);
      messages.push({ agentId: row.agent_id, role: row.role, timestampMs, body: row.body, seq });
    }
    return { available: true, agents: deriveGrokStates(messages, names, nowMs, activeMinutes) };
  } catch {
    return { available: false };
  } finally {
    db?.close();
  }
}

function columnOf(row: Record<string, unknown>): GrokColumn {
  return {
    name: typeof row.name === "string" ? row.name : "",
    type: typeof row.type === "string" ? row.type : "",
  };
}

function readNames(agentsPath: string): Map<string, string> {
  const names = new Map<string, string>();
  const root = path.resolve(agentsPath);
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const folder = path.resolve(root, ent.name);
    if (!folder.startsWith(root + path.sep)) continue;
    if (exists(path.join(folder, "group.json"))) continue;
    const profile = path.join(folder, "profile.json");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(profile);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 32_768) continue;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(profile, "utf8"));
      const name = parsed && typeof parsed === "object" && "name" in parsed && typeof parsed.name === "string" ? parsed.name.trim() : "";
      if (name) names.set(ent.name, name);
    } catch {
      // A bad profile drops that bot. It does not invent a state.
    }
  }
  return names;
}

function exists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}
