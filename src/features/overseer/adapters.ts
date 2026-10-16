/**
 * Fronts: one shape for every place Pedro's work is happening.
 * Parsers accept provider payloads and emit short fields only (title ≤64, detail ≤160).
 * They never invent a "needs you" the source did not actually signal.
 */

export type FrontKind = "grok-bot" | "cloud-agent" | "github-pr" | "github-issue" | "hermes";
export type FrontState = "needs-you" | "working" | "blocked" | "done" | "idle";
export type SourceKey = "cursor" | "github" | "hermes" | "grok";
export type SourceMode = "live" | "fixture" | "absent" | "off" | "unconfigured" | "error";

export interface Front {
  id: string;
  project: string;
  kind: FrontKind;
  title: string;
  state: FrontState;
  /** Why it needs Pedro, when state is needs-you. Also a short status line otherwise. */
  reason: string | null;
  updatedAt: string;
  url: string;
  source: SourceKey;
  detail: string | null;
}

export interface SourceReport {
  key: SourceKey;
  label: string;
  mode: SourceMode;
  detail: string;
}

export interface OverseerRefresh {
  cursorItems: unknown[];
  cursorRuns: unknown[];
  cursorError: string | null;
  cursorSkipped: boolean;
  githubReview: unknown[];
  githubChanges: unknown[];
  githubFailing: unknown[];
  githubAuthored: unknown[];
  githubIssues: unknown[];
  githubError: string | null;
  githubSkipped: boolean;
  hermesSessions: unknown;
  hermesError: string | null;
  hermesNote: string;
  hermesSkipped: boolean;
  hermesDashboard: string;
  grokText: string | null;
  grokError: string | null;
  grokNote: string;
  grokSkipped: boolean;
}

export const KIND_LABEL: Record<FrontKind, string> = {
  "grok-bot": "Grok bot",
  "cloud-agent": "Cloud agent",
  hermes: "Hermes",
  "github-pr": "Pull request",
  "github-issue": "Issue",
};

export const STATE_LABEL: Record<FrontState, string> = {
  "needs-you": "Needs you",
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  idle: "Idle",
};

/** Halo colour. Needs-you is the only amber, matching the rest of Hoku. */
export const HALO: Record<FrontState, string> = {
  "needs-you": "#f2bf4d",
  working: "#f1ead8",
  blocked: "#de8f7d",
  done: "#a9c2a0",
  idle: "#6a6f78",
};

const STATE_RANK: Record<FrontState, number> = { "needs-you": 0, blocked: 1, working: 2, idle: 3, done: 4 };

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1).trimEnd()}…`;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function stamp(v: unknown, fallback: string): string {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : NaN;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const s = str(v);
  if (s && Number.isFinite(Date.parse(s))) return new Date(Date.parse(s)).toISOString();
  return fallback;
}

/** Needs-you waits longest at the top. Everything else is newest first. */
export function rankFronts(fronts: Front[]): Front[] {
  return [...fronts].sort((a, b) => {
    const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (byState) return byState;
    const ta = Date.parse(a.updatedAt) || 0;
    const tb = Date.parse(b.updatedAt) || 0;
    const byTime = a.state === "needs-you" ? ta - tb : tb - ta;
    return byTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

export function needsYou(fronts: Front[]): Front[] {
  return rankFronts(fronts).filter((f) => f.state === "needs-you");
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function repoName(url: string | null): string {
  if (!url) return "Unassigned";
  const parts = url.replace(/\.git$/, "").split("/").filter(Boolean);
  const name = parts[parts.length - 1];
  return name && !name.includes(":") ? name : "Unassigned";
}

function cursorState(status: string): { state: FrontState; reason: string } | null {
  switch (status.toUpperCase()) {
    case "CREATING":
      return { state: "working", reason: "Starting a run" };
    case "RUNNING":
    case "ACTIVE":
      return { state: "working", reason: "Run in progress" };
    case "FINISHED":
      return { state: "done", reason: "Turn finished" };
    case "ERROR":
      return { state: "blocked", reason: "Run failed" };
    case "CANCELLED":
      return { state: "idle", reason: "Run cancelled" };
    case "EXPIRED":
      return { state: "idle", reason: "Run expired" };
    case "IDLE":
      return { state: "idle", reason: "Waiting for a follow-up" };
    default:
      return null;
  }
}

/** Cursor list items plus the latest run for each agent. Archived agents are dropped. */
export function frontsFromCursor(items: unknown[], runs: unknown[]): Front[] {
  const byAgent = new Map<string, Record<string, unknown>>();
  for (const run of runs) {
    const o = rec(run);
    const id = str(o?.agentId);
    if (o && id) byAgent.set(id, o);
  }
  const out: Front[] = [];
  for (const item of items) {
    const o = rec(item);
    const id = str(o?.id);
    if (!o || !id || !SAFE_ID.test(id)) continue;
    if (str(o.status)?.toUpperCase() === "ARCHIVED") continue;
    const run = byAgent.get(id);
    const runStatus = str(run?.status);
    const mapped = cursorState(runStatus ?? str(o.status) ?? "");
    const known = mapped ?? { state: "idle" as const, reason: `Unrecognised status “${clip(runStatus ?? str(o.status) ?? "empty", 40)}”` };
    let project = "Unassigned";
    const git = rec(run?.git);
    const branches = Array.isArray(git?.branches) ? git.branches : [];
    let pr = "";
    for (const b of branches) {
      const br = rec(b);
      project = repoName(str(br?.repoUrl));
      pr = str(br?.prUrl) ?? pr;
      if (project !== "Unassigned") break;
    }
    const given = str(o.url);
    const url = given?.startsWith("https://cursor.com/agents/") ? given : `https://cursor.com/agents/${id}`;
    const result = str(run?.result);
    out.push({
      id: `cursor:${id}`,
      project,
      kind: "cloud-agent",
      title: clip(str(o.name) ?? "Cloud agent", 64),
      state: known.state,
      reason: known.reason,
      updatedAt: stamp(run?.updatedAt ?? o.updatedAt, new Date(0).toISOString()),
      url,
      source: "cursor",
      detail: result ? clip(result, 160) : pr ? clip(`Pull request ${pr}`, 160) : null,
    });
  }
  return out;
}

interface GhDraft {
  url: string;
  title: string;
  project: string;
  updatedAt: string;
  draft: boolean;
  state: FrontState;
  reason: string;
  kind: FrontKind;
}

function ghItem(v: unknown, kind: FrontKind, state: FrontState, reason: string): GhDraft | null {
  const o = rec(v);
  const url = str(o?.html_url);
  const title = str(o?.title);
  if (!o || !url?.startsWith("https://github.com/") || !title) return null;
  return {
    url,
    title: clip(title, 64),
    project: repoName(str(o.repository_url)),
    updatedAt: stamp(o.updated_at, new Date(0).toISOString()),
    draft: o.draft === true,
    state,
    reason,
    kind,
  };
}

/** Higher-priority buckets overwrite the same URL, so a review request beats "you authored this". */
export function frontsFromGithub(raw: Pick<OverseerRefresh, "githubReview" | "githubChanges" | "githubFailing" | "githubAuthored" | "githubIssues">): Front[] {
  const ranked: { items: unknown[]; kind: FrontKind; state: FrontState; reason: string; weight: number }[] = [
    { items: raw.githubAuthored, kind: "github-pr", state: "idle", reason: "Open pull request", weight: 1 },
    { items: raw.githubFailing, kind: "github-pr", state: "blocked", reason: "Checks failing", weight: 2 },
    { items: raw.githubIssues, kind: "github-issue", state: "needs-you", reason: "Assigned to you", weight: 3 },
    { items: raw.githubReview, kind: "github-pr", state: "needs-you", reason: "Review requested", weight: 4 },
    { items: raw.githubChanges, kind: "github-pr", state: "needs-you", reason: "Changes requested", weight: 5 },
  ];
  const map = new Map<string, GhDraft & { weight: number }>();
  for (const bucket of ranked) {
    for (const item of bucket.items) {
      const row = ghItem(item, bucket.kind, bucket.state, bucket.reason);
      if (!row) continue;
      if (bucket.weight === 1 && row.draft) row.reason = "Draft pull request";
      const prev = map.get(row.url);
      if (!prev || bucket.weight >= prev.weight) map.set(row.url, { ...row, weight: bucket.weight });
    }
  }
  return [...map.values()].map((row) => ({
    id: `github:${row.url}`,
    project: row.project,
    kind: row.kind,
    title: row.title,
    state: row.state,
    reason: row.reason,
    updatedAt: row.updatedAt,
    url: row.url,
    source: "github" as const,
    detail: null,
  }));
}

function hermesState(o: Record<string, unknown>): { state: FrontState; reason: string } {
  const status = (str(o.status) ?? "").toLowerCase();
  if (o.pending_clarify === true || status === "waiting_for_clarify" || status === "needs_clarify") {
    return { state: "needs-you", reason: "Waiting on a clarification" };
  }
  if (o.pending_approval === true || status === "waiting_for_approval") {
    return { state: "needs-you", reason: "Waiting on approval" };
  }
  if (o.is_active === true || status === "running" || status === "active") return { state: "working", reason: "Turn in progress" };
  if (status === "failed" || status === "error") return { state: "blocked", reason: "Turn failed" };
  if (o.ended_at) return { state: "idle", reason: "Last turn finished" };
  return { state: "idle", reason: "No live status on this session" };
}

function sessionList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const o = rec(v);
  return Array.isArray(o?.sessions) ? o.sessions : [];
}

export function frontsFromHermes(sessions: unknown, dashboard: string): Front[] {
  const origin = dashboard.replace(/\/$/, "");
  const url = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin) ? `${origin}/` : "";
  const out: Front[] = [];
  for (const item of sessionList(sessions)) {
    const o = rec(item);
    const id = str(o?.id);
    if (!o || !id || !SAFE_ID.test(id)) continue;
    const mapped = hermesState(o);
    const preview = str(o.preview);
    out.push({
      id: `hermes:${id}`,
      project: (() => {
        const source = str(o.source);
        return source && SAFE_ID.test(source) ? clip(source, 64) : "Hermes";
      })(),
      kind: "hermes",
      title: clip(str(o.title) ?? "Hermes session", 64),
      state: mapped.state,
      reason: mapped.reason,
      updatedAt: stamp(o.last_active ?? o.ended_at, new Date(0).toISOString()),
      url,
      source: "hermes",
      detail: preview ? clip(preview, 160) : null,
    });
  }
  return out;
}

const GROK_STATE = new Set<FrontState>(["needs-you", "working", "blocked", "done", "idle"]);

function grokFront(v: unknown): Front | null {
  const o = rec(v);
  const id = str(o?.id);
  const title = str(o?.name) ?? str(o?.title);
  const state = str(o?.state) as FrontState | null;
  if (!o || !id || !SAFE_ID.test(id) || !title || !state || !GROK_STATE.has(state)) return null;
  const rawUrl = str(o.url) ?? "";
  const url = rawUrl.startsWith("https://grok.com/") ? rawUrl : "";
  const reason = str(o.reason);
  if (state === "needs-you" && !reason) return null;
  return {
    id: `grok:${id}`,
    project: clip(str(o.project) ?? "Inbox", 64),
    kind: "grok-bot",
    title: clip(title, 64),
    state,
    reason,
    updatedAt: stamp(o.updatedAt, new Date(0).toISOString()),
    url,
    source: "grok",
    detail: str(o.detail) ? clip(str(o.detail)!, 160) : null,
  };
}

/** A JSON array or JSONL. Bad lines are skipped, not invented. */
export function frontsFromGrok(text: string): { fronts: Front[]; skipped: number } {
  const trimmed = text.trim();
  if (!trimmed) return { fronts: [], skipped: 0 };
  let rows: unknown[] = [];
  let skipped = 0;
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) return { fronts: [], skipped: 1 };
      rows = parsed;
    } catch {
      return { fronts: [], skipped: 1 };
    }
  } else {
    rows = trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        skipped += 1;
        return null;
      }
    });
  }
  const fronts: Front[] = [];
  for (const row of rows) {
    if (row == null) continue;
    const front = grokFront(row);
    if (front) fronts.push(front);
    else skipped += 1;
  }
  return { fronts, skipped };
}

function modeFor(error: string | null, hasData: boolean, skipped: boolean): SourceMode {
  if (skipped) return "off";
  if (hasData) return "live";
  if (!error) return "absent";
  if (/no cursor api key|no github token/i.test(error)) return "unconfigured";
  if (/not there|not running|timed out|could not be reached|connection refused|absent/i.test(error)) return "absent";
  return "error";
}

export function assemble(raw: OverseerRefresh): { fronts: Front[]; sources: SourceReport[] } {
  const sources: SourceReport[] = [];
  const fronts: Front[] = [];

  const cursorFronts = raw.cursorSkipped || raw.cursorError ? [] : frontsFromCursor(raw.cursorItems, raw.cursorRuns);
  fronts.push(...cursorFronts);
  sources.push({
    key: "cursor",
    label: "Cursor cloud agents",
    mode: modeFor(raw.cursorError, cursorFronts.length > 0 || (!raw.cursorSkipped && !raw.cursorError), raw.cursorSkipped),
    detail: raw.cursorSkipped
      ? "Turned off."
      : raw.cursorError ?? `${cursorFronts.length} agents. Cursor reports run status only — a finished turn is done, not a request for you.`,
  });

  const ghFronts = raw.githubSkipped || raw.githubError ? [] : frontsFromGithub(raw);
  fronts.push(...ghFronts);
  sources.push({
    key: "github",
    label: "GitHub",
    mode: modeFor(raw.githubError, ghFronts.length > 0 || (!raw.githubSkipped && !raw.githubError), raw.githubSkipped),
    detail: raw.githubSkipped ? "Turned off." : raw.githubError ?? `${ghFronts.length} pull requests and issues.`,
  });

  const hermesFronts = raw.hermesSkipped || raw.hermesError ? [] : frontsFromHermes(raw.hermesSessions, raw.hermesDashboard);
  fronts.push(...hermesFronts);
  const hermesLive = !raw.hermesSkipped && !raw.hermesError;
  sources.push({
    key: "hermes",
    label: "Hermes",
    mode: modeFor(raw.hermesError, hermesLive, raw.hermesSkipped),
    detail: raw.hermesSkipped ? "Turned off." : raw.hermesError ?? raw.hermesNote,
  });

  const grok = raw.grokSkipped || raw.grokError || raw.grokText == null ? { fronts: [] as Front[], skipped: 0 } : frontsFromGrok(raw.grokText);
  fronts.push(...grok.fronts);
  sources.push({
    key: "grok",
    label: "Grok bots",
    mode: modeFor(raw.grokError, !raw.grokSkipped && !raw.grokError && raw.grokText != null, raw.grokSkipped),
    detail: raw.grokSkipped
      ? "Turned off."
      : raw.grokError ?? (raw.grokNote || (grok.skipped ? `${grok.fronts.length} bots. ${grok.skipped} lines skipped.` : `${grok.fronts.length} bots from the local feed.`)),
  });

  return { fronts: rankFronts(fronts), sources };
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** Invented fronts. No credentials, no real ids, no real repos. */
export function demoSnapshot(): { fronts: Front[]; sources: SourceReport[]; demo: true } {
  const fronts: Front[] = rankFronts([
    { id: "grok:release-notes", project: "Northwind", kind: "grok-bot", title: "Release notes", state: "needs-you", reason: "Which version should ship?", updatedAt: ago(90), url: "https://grok.com/chat/demo-release-notes", source: "grok", detail: "The bot is waiting on a version choice." },
    { id: "grok:triage", project: "Northwind", kind: "grok-bot", title: "Triage", state: "working", reason: "Sorting the overnight queue", updatedAt: ago(12), url: "https://grok.com/chat/demo-triage", source: "grok", detail: null },
    { id: "cursor:bc-demo-pagination", project: "Lumen", kind: "cloud-agent", title: "Fix pagination", state: "working", reason: "Run in progress", updatedAt: ago(8), url: "https://cursor.com/agents/bc-demo-pagination", source: "cursor", detail: "Editing the list query." },
    { id: "cursor:bc-demo-types", project: "Lumen", kind: "cloud-agent", title: "API types", state: "done", reason: "Turn finished", updatedAt: ago(400), url: "https://cursor.com/agents/bc-demo-types", source: "cursor", detail: "Opened a pull request." },
    { id: "github:https://github.com/hoku-demo/lumen/pull/18", project: "Lumen", kind: "github-pr", title: "Pagination fix", state: "needs-you", reason: "Review requested", updatedAt: ago(40), url: "https://github.com/hoku-demo/lumen/pull/18", source: "github", detail: null },
    { id: "github:https://github.com/hoku-demo/lumen/pull/21", project: "Lumen", kind: "github-pr", title: "Types migration", state: "blocked", reason: "Checks failing", updatedAt: ago(30), url: "https://github.com/hoku-demo/lumen/pull/21", source: "github", detail: null },
    { id: "github:https://github.com/hoku-demo/kepler/issues/7", project: "Kepler", kind: "github-issue", title: "Document the feed", state: "idle", reason: "Open, nobody is blocked on it", updatedAt: ago(2400), url: "https://github.com/hoku-demo/kepler/issues/7", source: "github", detail: null },
    { id: "hermes:demo-schema", project: "Kepler", kind: "hermes", title: "Clarify the schema", state: "needs-you", reason: "Waiting on a clarification", updatedAt: ago(200), url: "http://127.0.0.1:9119/", source: "hermes", detail: "It asked which field is required." },
    { id: "hermes:demo-index", project: "Kepler", kind: "hermes", title: "Nightly index", state: "idle", reason: "Last turn finished", updatedAt: ago(600), url: "http://127.0.0.1:9119/", source: "hermes", detail: null },
  ]);
  const sources: SourceReport[] = [
    { key: "cursor", label: "Cursor cloud agents", mode: "fixture", detail: "Demo. No Cursor API key is loaded, and nothing was contacted." },
    { key: "github", label: "GitHub", mode: "fixture", detail: "Demo. No GitHub token is loaded, and nothing was contacted." },
    { key: "hermes", label: "Hermes", mode: "fixture", detail: "Demo. The local dashboard was not probed." },
    { key: "grok", label: "Grok bots", mode: "fixture", detail: "Demo. Grok has no public list API; this feed is invented." },
  ];
  return { fronts, sources, demo: true };
}

/** Browser preview with demo switched off: no network, no invented fronts. */
export function disconnectedSnapshot(): { fronts: Front[]; sources: SourceReport[]; demo: false } {
  return {
    demo: false,
    fronts: [],
    sources: [
      { key: "cursor", label: "Cursor cloud agents", mode: "unconfigured", detail: "No API key in this preview. Nothing was contacted." },
      { key: "github", label: "GitHub", mode: "unconfigured", detail: "No token in this preview. Nothing was contacted." },
      { key: "hermes", label: "Hermes", mode: "absent", detail: "Not probed. The desktop app checks 127.0.0.1:9119 only when demo data is off." },
      { key: "grok", label: "Grok bots", mode: "absent", detail: "No feed file is loaded. Grok has no public list API." },
    ],
  };
}
