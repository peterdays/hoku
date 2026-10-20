import { unit } from "../../lib/hash";
import { clip, rankFronts, type Front, type FrontState } from "./adapters";
import type { GrokGuess } from "./grokIndex";

/** Cloud agent id, as it appears in chat and on cursor.com. */
export const BC_ID = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BC_SRC = "bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GH_SRC = "github\\.com\\/([A-Za-z0-9_.-]+)\\/([A-Za-z0-9_.-]+)\\/(?:pull|issues|tree|blob)\\/";

export const CURSOR_AGENT_CAP = 200;
export const CURSOR_PAGE_LIMIT = 100;
export const CURSOR_CACHE_MS = 60_000;
export const ORBIT_CAP = 8;
export const OTHER_BOTS = "Other bots";
export const MENTION_TIP = "linked by mentions in chat";
export const RECENT_DAYS_DEFAULT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL_RUN = new Set(["FINISHED", "ERROR", "FAILED", "CANCELLED", "CANCELED", "EXPIRED", "IDLE", "ARCHIVED"]);

export interface MentionRow {
  agentId: string;
  timestampMs: number;
  body: string;
}

export interface MentionHit {
  key: string;
  count: number;
  lastMs: number;
}

export interface BotMentions {
  botId: string;
  agents: MentionHit[];
  repos: MentionHit[];
}

export type PrKind = "open" | "closed" | "merged";

export interface CursorFields {
  id: string;
  name: string;
  status: string;
  runStatus: string | null;
  url: string;
  updatedAt: string;
  latestRunId: string | null;
  repository: string | null;
  prUrl: string | null;
  prTitle: string | null;
  prStatus: PrKind | null;
  githubPr: PrKind | null;
  parentId: string | null;
}

export interface OrbitStar {
  id: string;
  kind: "grok-bot" | "cloud-agent" | "cursor-project";
  title: string;
  state: FrontState;
  reason: string | null;
  url: string;
  guess: boolean;
  prUnknown: boolean;
  needsYou: boolean;
  updatedAt: string;
  mentions: number | null;
  lastMentioned: string | null;
  prUrl: string | null;
  threads: OrbitStar[];
}

export interface OrbitCluster {
  name: string;
  url: string;
  slug: string | null;
  bots: OrbitStar[];
  work: OrbitStar[];
  /** Finished work left off the ring. Not a control. */
  hidden: number;
}

export interface OrbitModel {
  clusters: OrbitCluster[];
  attention: Front[];
  suppressPrUrls: string[];
}

export interface AgentPage {
  items: unknown[];
  nextCursor: string | null;
}

export interface CacheSlot<T> {
  key: string;
  at: number;
  value: T;
}

const GUESS: Record<GrokGuess, { state: FrontState; reason: string }> = {
  active: { state: "working", reason: "~ active" },
  resting: { state: "idle", reason: "~ resting" },
  "probably-waiting": { state: "needs-you", reason: "~ waiting on you" },
  unanswered: { state: "idle", reason: "~ unanswered" },
};

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function slugPart(raw: string): string | null {
  const name = raw.replace(/\.git$/i, "");
  if (!name || name === "." || name === "..") return null;
  return name;
}

/** `owner/repo` in lowercase, from a GitHub URL or a bare slug. */
export function repoSlug(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i) ?? raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  const owner = slugPart(m[1]);
  const repo = slugPart(m[2]);
  if (!owner || !repo) return null;
  return `${owner}/${repo}`.toLowerCase();
}

export function parsePr(url: string | null): { owner: string; repo: string; n: number; slug: string } | null {
  if (!url) return null;
  const m = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i);
  if (!m) return null;
  const owner = slugPart(m[1]);
  const repo = slugPart(m[2]);
  if (!owner || !repo) return null;
  return { owner, repo, n: Number(m[3]), slug: `${owner}/${repo}`.toLowerCase() };
}

function bump(map: Map<string, MentionHit>, key: string, ms: number): void {
  const prev = map.get(key);
  if (!prev) map.set(key, { key, count: 1, lastMs: ms });
  else {
    prev.count += 1;
    if (ms > prev.lastMs) prev.lastMs = ms;
  }
}

/**
 * Ids and repo slugs only. The body is read and dropped.
 * A `cursor.com/agents/<bc-id>` link counts as that agent. A GitHub link counts
 * when it is a pull, issue, tree, or blob.
 */
export function extractMentions(rows: MentionRow[]): BotMentions[] {
  const byBot = new Map<string, { agents: Map<string, MentionHit>; repos: Map<string, MentionHit> }>();
  for (const row of rows) {
    if (!row.agentId || typeof row.body !== "string" || !Number.isFinite(row.timestampMs)) continue;
    const slot = byBot.get(row.agentId) ?? { agents: new Map(), repos: new Map() };
    for (const match of row.body.matchAll(new RegExp(BC_SRC, "gi"))) bump(slot.agents, match[0].toLowerCase(), row.timestampMs);
    for (const match of row.body.matchAll(new RegExp(GH_SRC, "gi"))) {
      const owner = slugPart(match[1]);
      const repo = slugPart(match[2]);
      if (owner && repo) bump(slot.repos, `${owner}/${repo}`.toLowerCase(), row.timestampMs);
    }
    if (slot.agents.size || slot.repos.size) byBot.set(row.agentId, slot);
  }
  return [...byBot.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([botId, slot]) => ({
      botId,
      agents: [...slot.agents.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
      repos: [...slot.repos.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    }));
}

export function agentPageUrl(cursor: string | null, limit: number): string {
  const q = new URLSearchParams({ limit: String(limit), includeArchived: "false" });
  if (cursor) q.set("cursor", cursor);
  return `https://api.cursor.com/v1/agents?${q.toString()}`;
}

export function readAgentPage(parsed: unknown): AgentPage {
  const row = rec(parsed);
  const items = Array.isArray(row?.items) ? row.items : [];
  const next = str(row?.nextCursor);
  return { items, nextCursor: next };
}

/** Stop at the cap, an omitted cursor, an empty page, or a repeated cursor. */
export function stepAgents(fetched: number, page: AgentPage, cap: number, seen: ReadonlySet<string>): { fetched: number; cursor: string | null } {
  const next = Math.min(cap, fetched + page.items.length);
  if (next >= cap || page.items.length === 0 || !page.nextCursor || seen.has(page.nextCursor)) return { fetched: next, cursor: null };
  return { fetched: next, cursor: page.nextCursor };
}

export function cacheGet<T>(slot: CacheSlot<T> | null, key: string, now: number, ttl: number): T | null {
  if (!slot || slot.key !== key || now - slot.at >= ttl) return null;
  return slot.value;
}

export async function cachedLoad<T>(
  slot: { current: CacheSlot<Promise<T>> | null },
  key: string,
  now: number,
  ttl: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = cacheGet(slot.current, key, now, ttl);
  if (hit) return hit;
  const pending = load().catch((err: unknown) => {
    if (slot.current?.value === pending) slot.current = null;
    throw err;
  });
  slot.current = { key, at: now, value: pending };
  return pending;
}

function prKind(raw: string | null): PrKind | null {
  const v = raw?.toLowerCase();
  if (v === "open" || v === "opened" || v === "draft") return "open";
  if (v === "closed") return "closed";
  if (v === "merged") return "merged";
  return null;
}

function cursorPr(branch: unknown): PrKind | null {
  const row = rec(branch);
  if (!row) return null;
  for (const key of ["prStatus", "prState", "pullRequestState"]) {
    const kind = prKind(str(row[key]));
    if (kind) return kind;
  }
  const nested = rec(row.pr) ?? rec(row.pullRequest);
  return prKind(str(nested?.status) ?? str(nested?.state));
}

export function readPull(parsed: unknown): { state: PrKind; title: string | null } | null {
  const row = rec(parsed);
  if (!row) return null;
  const title = str(row.title);
  if (row.merged === true) return { state: "merged", title };
  const kind = prKind(str(row.state));
  if (kind === "open" || kind === "closed") return { state: kind, title };
  return null;
}

export function applyPull(agent: CursorFields, pull: { state: PrKind; title: string | null } | null): CursorFields {
  if (!pull) return agent;
  return { ...agent, githubPr: pull.state, prTitle: agent.prTitle ?? (pull.title ? clip(pull.title, 64) : null) };
}

function agentUrl(id: string, given: string | null): string {
  return given?.startsWith("https://cursor.com/agents/") ? given : `https://cursor.com/agents/${id}`;
}

/** List item plus the agent record and the latest run. Missing PR status stays null. */
export function readCursorAgent(item: unknown, detail?: unknown, run?: unknown): CursorFields | null {
  const row = rec(item);
  const id = str(row?.id)?.toLowerCase() ?? "";
  if (!row || !BC_ID.test(id)) return null;
  if (str(row.status)?.toUpperCase() === "ARCHIVED") return null;
  const full = rec(detail) ?? row;
  const runRow = rec(run);
  const branches = Array.isArray(rec(runRow?.git)?.branches) ? rec(runRow?.git)!.branches as unknown[] : [];
  let repository = str(row.repository) ? repoSlug(str(row.repository)) : null;
  let prUrl = str(row.prUrl);
  let prTitle = str(row.prTitle);
  let prStatus = prKind(str(row.prStatus));
  const repos = Array.isArray(full.repos) ? full.repos : [];
  for (const repo of repos) {
    repository = repository ?? repoSlug(str(rec(repo)?.url));
    prUrl = prUrl ?? str(rec(repo)?.prUrl);
    prStatus = prStatus ?? cursorPr(repo);
  }
  for (const branch of branches) {
    repository = repository ?? repoSlug(str(rec(branch)?.repoUrl));
    prUrl = prUrl ?? str(rec(branch)?.prUrl);
    prTitle = prTitle ?? str(rec(branch)?.prTitle);
    prStatus = prStatus ?? cursorPr(branch);
  }
  const parentRaw = str(full.parentAgentId) ?? str(full.parentId) ?? str(row.parentId);
  const parentId = parentRaw && BC_ID.test(parentRaw) ? parentRaw.toLowerCase() : null;
  const runStatus = str(runRow?.status) ?? str(row.runStatus);
  const cleanPr = prUrl && parsePr(prUrl) ? prUrl : null;
  return {
    id,
    name: clip(str(row.name) ?? str(full.name) ?? "Cloud agent", 80),
    status: str(row.status) ?? "",
    runStatus,
    url: agentUrl(id, str(row.url) ?? str(full.url)),
    updatedAt: str(runRow?.updatedAt) ?? str(row.updatedAt) ?? new Date(0).toISOString(),
    latestRunId: str(row.latestRunId),
    repository,
    prUrl: cleanPr,
    prTitle: prTitle ? clip(prTitle, 64) : null,
    prStatus,
    githubPr: prKind(str(row.githubPr)),
    parentId: parentId === id ? null : parentId,
  };
}

export function cursorItem(fields: CursorFields): Record<string, string | null> {
  return {
    id: fields.id,
    name: fields.name,
    status: fields.status,
    runStatus: fields.runStatus,
    url: fields.url,
    updatedAt: fields.updatedAt,
    latestRunId: fields.latestRunId,
    repository: fields.repository,
    prUrl: fields.prUrl,
    prTitle: fields.prTitle,
    prStatus: fields.prStatus,
    githubPr: fields.githubPr,
    parentId: fields.parentId,
  };
}

export type PrVisibility = PrKind | "unknown" | "none";

/** GitHub wins when it answered. Cursor is next. Otherwise an unknown PR is not invented closed. */
export function prVisibility(prUrl: string | null, github: PrKind | null, cursor: PrKind | null): PrVisibility {
  if (!prUrl) return "none";
  if (github) return github;
  if (cursor) return cursor;
  return "unknown";
}

/** `HOKU_GALAXY_RECENT_DAYS`. Blank or unreadable values stay on the default. */
export function parseRecentDays(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return RECENT_DAYS_DEFAULT;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) return RECENT_DAYS_DEFAULT;
  return days;
}

/** CREATING, RUNNING, ACTIVE, and any status that is not a finished run. */
export function isActiveRun(runStatus: string | null, status: string): boolean {
  const run = (runStatus ?? "").trim().toUpperCase();
  if (run) return !TERMINAL_RUN.has(run);
  const list = status.trim().toUpperCase();
  return list.length > 0 && !TERMINAL_RUN.has(list);
}

function updatedWithin(updatedAt: string, now: number, recentMs: number): boolean {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) && now - at <= recentMs;
}

function liveStatus(status: string): { state: FrontState; reason: string } {
  switch (status.toUpperCase()) {
    case "CREATING":
      return { state: "working", reason: "Starting a run" };
    case "RUNNING":
    case "ACTIVE":
      return { state: "working", reason: "Run in progress" };
    case "FINISHED":
      return { state: "done", reason: "Turn finished" };
    case "ERROR":
    case "FAILED":
      return { state: "blocked", reason: "Run failed" };
    case "CANCELLED":
      return { state: "idle", reason: "Run cancelled" };
    case "EXPIRED":
      return { state: "idle", reason: "Run expired" };
    case "IDLE":
      return { state: "idle", reason: "Waiting for a follow-up" };
    default:
      return { state: "idle", reason: status ? `Unrecognised status “${clip(status, 40)}”` : "No run status" };
  }
}

const LIVE_RANK: FrontState[] = ["working", "blocked", "idle", "done"];

function summaryState(states: FrontState[]): { state: FrontState; reason: string } {
  const state = LIVE_RANK.find((item) => states.includes(item)) ?? "idle";
  return liveStatus(state === "working" ? "RUNNING" : state === "blocked" ? "ERROR" : state === "done" ? "FINISHED" : "IDLE");
}

interface AgentRec extends CursorFields {
  repo: string | null;
  visibility: PrVisibility;
  needsYou: boolean;
  reviewReason: string | null;
  live: { state: FrontState; reason: string };
}

function workTitle(agent: AgentRec): string {
  return clip(agent.prTitle || agent.name, 64);
}

function agentStar(agent: AgentRec): OrbitStar {
  return {
    id: `cursor:${agent.id}`,
    kind: "cloud-agent",
    title: workTitle(agent),
    state: agent.live.state,
    reason: agent.live.reason,
    url: agent.url,
    guess: false,
    prUnknown: agent.visibility === "unknown",
    needsYou: agent.needsYou,
    updatedAt: agent.updatedAt,
    mentions: null,
    lastMentioned: null,
    prUrl: agent.prUrl,
    threads: [],
  };
}

interface BotLink {
  count: number;
  lastMs: number;
}

function betterClaim(a: { count: number; lastMs: number; botId: string }, b: { count: number; lastMs: number; botId: string }): boolean {
  if (a.count !== b.count) return a.count > b.count;
  if (a.lastMs !== b.lastMs) return a.lastMs > b.lastMs;
  return a.botId < b.botId;
}

function repoLabel(slug: string, slugs: string[]): string {
  const name = slug.split("/")[1] || slug;
  const clash = slugs.filter((item) => (item.split("/")[1] || item) === name).length > 1;
  return clash ? slug : name;
}

export interface OrbitInput {
  bots: { id: string; name: string; state: GrokGuess; lastTimestamp: string }[];
  mentions: BotMentions[];
  cursorItems: unknown[];
  review: { url: string; reason: string | null }[];
  /** True when a GitHub token was used to read pull-request state. */
  prKnown?: boolean;
  now?: number;
  recentDays?: number;
}

/**
 * Projects are GitHub repos. Bots orbit a repo when chat mentions it twice, or
 * when the bot that mentions an agent most (latest mention breaks a tie) is
 * attached to that agent's repo. With a GitHub token, work is an open pull
 * request or a run that is still going. Without one, work is a live run or
 * anything touched inside the recent window. A coordinator is one star when a
 * thread survives.
 */
export function buildOrbits(input: OrbitInput): OrbitModel {
  const prKnown = input.prKnown === true;
  const now = input.now ?? Date.now();
  const recentMs = (input.recentDays ?? RECENT_DAYS_DEFAULT) * DAY_MS;
  const survives = (agent: AgentRec) => {
    const active = isActiveRun(agent.runStatus, agent.status);
    if (prKnown) return agent.visibility === "open" || active;
    return active || updatedWithin(agent.updatedAt, now, recentMs);
  };
  const review = new Map(input.review.map((item) => [item.url, item.reason ?? "Review requested"]));
  const agents: AgentRec[] = [];
  for (const item of input.cursorItems) {
    const fields = readCursorAgent(item);
    if (!fields) continue;
    const repo = fields.repository ?? parsePr(fields.prUrl)?.slug ?? null;
    const visibility = prVisibility(fields.prUrl, fields.githubPr, fields.prStatus);
    const needsYou = !!fields.prUrl && review.has(fields.prUrl) && visibility !== "closed" && visibility !== "merged" && visibility !== "none";
    agents.push({
      ...fields,
      repo,
      visibility,
      needsYou,
      reviewReason: fields.prUrl ? review.get(fields.prUrl) ?? null : null,
      live: liveStatus(fields.runStatus ?? fields.status),
    });
  }
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const consumed = new Set<string>();
  const groups: { repo: string; star: OrbitStar }[] = [];
  const grouped = new Set<string>();
  for (const agent of agents) {
    if (!agent.parentId || !byId.has(agent.parentId) || grouped.has(agent.parentId)) continue;
    const kids = agents.filter((item) => item.parentId === agent.parentId && survives(item));
    if (!kids.length) continue;
    const parent = byId.get(agent.parentId)!;
    const threads = kids.map(agentStar);
    const repo = parent.repo ?? kids.find((kid) => kid.repo)?.repo ?? null;
    if (!repo) continue;
    const summed = summaryState(threads.map((thread) => thread.state));
    grouped.add(parent.id);
    groups.push({
      repo,
      star: {
        id: `cursor-project:${parent.id}`,
        kind: "cursor-project",
        title: clip(parent.name, 64),
        state: summed.state,
        reason: threads.length === 1 ? threads[0].reason : `${threads.length} threads`,
        url: parent.url,
        guess: false,
        prUnknown: threads.some((thread) => thread.prUnknown),
        needsYou: threads.some((thread) => thread.needsYou) || (survives(parent) && parent.needsYou),
        updatedAt: threads.map((thread) => thread.updatedAt).sort().at(-1) ?? parent.updatedAt,
        mentions: null,
        lastMentioned: null,
        prUrl: parent.prUrl,
        threads,
      },
    });
    consumed.add(parent.id);
    for (const kid of kids) consumed.add(kid.id);
  }

  const workByRepo = new Map<string, OrbitStar[]>();
  const put = (repo: string, star: OrbitStar) => {
    const list = workByRepo.get(repo) ?? [];
    list.push(star);
    workByRepo.set(repo, list);
  };
  for (const group of groups) put(group.repo, group.star);
  for (const agent of agents) {
    if (consumed.has(agent.id) || !survives(agent) || !agent.repo) continue;
    put(agent.repo, agentStar(agent));
  }
  const drawn = new Set<string>(consumed);
  for (const stars of workByRepo.values()) {
    for (const star of stars) if (star.kind === "cloud-agent") drawn.add(star.id.slice("cursor:".length));
  }
  const hiddenByRepo = new Map<string, number>();
  for (const agent of agents) {
    if (!agent.repo || drawn.has(agent.id)) continue;
    hiddenByRepo.set(agent.repo, (hiddenByRepo.get(agent.repo) ?? 0) + 1);
  }

  const links = new Map<string, Map<string, BotLink>>();
  const link = (botId: string, repo: string, count: number, lastMs: number) => {
    const repos = links.get(botId) ?? new Map<string, BotLink>();
    const prev = repos.get(repo);
    if (!prev || count > prev.count || (count === prev.count && lastMs > prev.lastMs)) repos.set(repo, { count, lastMs });
    links.set(botId, repos);
  };
  for (const mention of input.mentions) {
    for (const repo of mention.repos) if (repo.count >= 2) link(mention.botId, repo.key, repo.count, repo.lastMs);
  }
  for (const agent of agents) {
    if (!agent.repo) continue;
    let winner: { botId: string; count: number; lastMs: number } | null = null;
    for (const mention of input.mentions) {
      const hit = mention.agents.find((item) => item.key === agent.id);
      if (!hit) continue;
      const claim = { botId: mention.botId, count: hit.count, lastMs: hit.lastMs };
      if (!winner || betterClaim(claim, winner)) winner = claim;
    }
    if (winner) link(winner.botId, agent.repo, winner.count, winner.lastMs);
  }

  const botById = new Map(input.bots.map((bot) => [bot.id, bot]));
  const slugs = [...new Set([...workByRepo.keys(), ...[...links.values()].flatMap((repos) => [...repos.keys()])])];
  const clusters: OrbitCluster[] = [];
  for (const slug of slugs) {
    const name = repoLabel(slug, slugs);
    const bots: OrbitStar[] = [];
    for (const [botId, repos] of links) {
      const hit = repos.get(slug);
      const bot = botById.get(botId);
      if (!hit || !bot) continue;
      const guess = GUESS[bot.state];
      bots.push({
        id: `grok:${bot.id}`,
        kind: "grok-bot",
        title: bot.name,
        state: guess.state,
        reason: guess.reason,
        url: `grokbot://app/v1/agent?id=${encodeURIComponent(bot.id)}`,
        guess: true,
        prUnknown: false,
        needsYou: guess.state === "needs-you",
        updatedAt: bot.lastTimestamp,
        mentions: hit.count,
        lastMentioned: new Date(hit.lastMs).toISOString(),
        prUrl: null,
        threads: [],
      });
    }
    bots.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    const work = (workByRepo.get(slug) ?? []).slice().sort((a, b) => (a.title < b.title ? -1 : 1));
    if (!bots.length && !work.length) continue;
    clusters.push({ name, url: `https://github.com/${slug}`, slug, bots, work, hidden: hiddenByRepo.get(slug) ?? 0 });
  }
  clusters.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const placed = new Set(clusters.flatMap((cluster) => cluster.bots.map((bot) => bot.id)));
  const other = input.bots.filter((bot) => !placed.has(`grok:${bot.id}`));
  if (other.length) {
    clusters.push({
      name: OTHER_BOTS,
      url: "",
      slug: null,
      bots: other.map((bot) => {
        const guess = GUESS[bot.state];
        return {
          id: `grok:${bot.id}`,
          kind: "grok-bot" as const,
          title: bot.name,
          state: guess.state,
          reason: guess.reason,
          url: `grokbot://app/v1/agent?id=${encodeURIComponent(bot.id)}`,
          guess: false,
          prUnknown: false,
          needsYou: guess.state === "needs-you",
          updatedAt: bot.lastTimestamp,
          mentions: null,
          lastMentioned: null,
          prUrl: null,
          threads: [],
        };
      }),
      work: [],
      hidden: 0,
    });
  }

  const attention: Front[] = [];
  const suppress = new Set<string>();
  for (const agent of agents) {
    if (!agent.prUrl) continue;
    if (agent.visibility === "closed" || agent.visibility === "merged") suppress.add(agent.prUrl);
    if (!survives(agent) || !agent.needsYou) continue;
    const cluster = clusters.find((item) => item.slug === agent.repo);
    attention.push({
      id: `cursor:${agent.id}`,
      project: cluster?.name ?? agent.repo ?? "GitHub",
      kind: "cloud-agent",
      title: workTitle(agent),
      state: "needs-you",
      reason: agent.reviewReason,
      updatedAt: agent.updatedAt,
      url: agent.url,
      source: "cursor",
      detail: null,
    });
    suppress.add(agent.prUrl);
  }
  return { clusters, attention, suppressPrUrls: [...suppress] };
}

function quietWork(clusters: OrbitCluster[]): Front[] {
  const out: Front[] = [];
  for (const cluster of clusters) {
    for (const star of cluster.work) {
      const items = star.kind === "cursor-project" ? star.threads : [star];
      for (const item of items) {
        if (item.needsYou) continue;
        out.push(starFront(item, cluster.name));
      }
    }
  }
  return out;
}

function homesFor(clusters: OrbitCluster[]): Map<string, string> {
  const homes = new Map<string, string[]>();
  for (const cluster of clusters) {
    for (const bot of cluster.bots) {
      const names = homes.get(bot.id) ?? [];
      names.push(cluster.name);
      homes.set(bot.id, names);
    }
  }
  return new Map([...homes].map(([id, names]) => [id, names.join(", ")]));
}

export function withOrbits<T extends { fronts: Front[] }>(payload: T, model: OrbitModel): T & { orbits: OrbitCluster[] } {
  const drop = new Set(model.suppressPrUrls);
  const homes = homesFor(model.clusters);
  const fronts = payload.fronts.filter((front) => {
    if (front.source === "cursor" && front.kind === "cloud-agent") return false;
    return !(front.kind === "github-pr" && drop.has(front.url));
  }).map((front) => {
    const project = front.kind === "grok-bot" ? homes.get(front.id) : undefined;
    return project ? { ...front, project } : front;
  });
  return { ...payload, fronts: rankFronts([...fronts, ...quietWork(model.clusters), ...model.attention]), orbits: model.clusters };
}

export interface SkyCore {
  key: string;
  name: string;
  href: string;
  hidden: number;
  x: number;
  y: number;
}

export interface SkyNode {
  key: string;
  ids: string[];
  href: string;
  tooltip: string;
  state: FrontState;
  needsYou: boolean;
  x: number;
  y: number;
  cx: number;
  cy: number;
  ring: number;
  float: string | null;
  prUnknown: boolean;
  kind: OrbitStar["kind"];
}

export interface SkyBadge {
  key: string;
  count: number;
  plus: boolean;
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export interface SkyModel {
  cores: SkyCore[];
  nodes: SkyNode[];
  badges: SkyBadge[];
}

function tooltip(star: OrbitStar): string {
  const parts = [star.title, star.reason ?? "", star.guess ? MENTION_TIP : "", star.prUnknown ? "PR state unknown" : ""];
  return parts.filter(Boolean).join(" — ");
}

function floatFor(star: OrbitStar): string {
  if (star.prUnknown) return `${star.title} · ?`;
  if (star.reason?.startsWith("~")) return `${star.title} · ~`;
  return star.title;
}

function nodeOf(star: OrbitStar, x: number, y: number, cx: number, cy: number, ring: number, key: string): SkyNode {
  return {
    key,
    ids: [star.id, ...star.threads.map((thread) => thread.id)],
    href: star.url,
    tooltip: tooltip(star),
    state: star.state,
    needsYou: star.needsYou,
    x, y, cx, cy, ring,
    float: floatFor(star),
    prUnknown: star.prUnknown,
    kind: star.kind,
  };
}

function arc(count: number, index: number, base: number): number {
  const spread = Math.min(0.85, 4 / Math.max(count, 1));
  return base + (index - (count - 1) / 2) * spread;
}

/** Rings collapse past ORBIT_CAP until `expanded` contains the ring key. */
export function placeOrbits(clusters: OrbitCluster[], w: number, h: number, expanded: ReadonlySet<string>, cap = ORBIT_CAP): SkyModel {
  const scale = Math.min(1, Math.min(w, h) / 860);
  const cx = w / 2;
  const cy = h / 2 + 8;
  const rx = Math.max(140, Math.min(w * 0.28, 320));
  const ry = Math.max(100, Math.min(h * 0.26, 220));
  const cores: SkyCore[] = clusters.map((cluster, i) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * i) / Math.max(clusters.length, 1);
    const alone = clusters.length === 1;
    return {
      key: cluster.slug ?? cluster.name,
      name: cluster.name,
      href: cluster.url,
      hidden: cluster.hidden,
      x: cx + Math.cos(angle) * (alone ? 0 : rx),
      y: cy + Math.sin(angle) * (alone ? 0 : ry),
    };
  });
  const nodes: SkyNode[] = [];
  const badges: SkyBadge[] = [];
  clusters.forEach((cluster, i) => {
    const core = cores[i];
    const botR = (cluster.name === OTHER_BOTS ? 64 : 78) * scale;
    const workR = 140 * scale;
    placeRing(cluster.bots, `${cluster.name}:bots`, core, botR, scale, expanded, cap, nodes, badges);
    placeRing(cluster.work, `${cluster.name}:work`, core, workR, scale, expanded, cap, nodes, badges);
  });
  return { cores, nodes, badges };
}

function placeRing(
  stars: OrbitStar[],
  ringKey: string,
  core: SkyCore,
  radius: number,
  scale: number,
  expanded: ReadonlySet<string>,
  cap: number,
  nodes: SkyNode[],
  badges: SkyBadge[],
): void {
  if (!stars.length || radius <= 0) return;
  const open = expanded.has(ringKey);
  const shown = open || stars.length <= cap ? stars : stars.slice(0, cap);
  const hidden = stars.length - shown.length;
  const slots = shown.length + (hidden ? 1 : 0);
  const base = unit(ringKey) * Math.PI * 2;
  shown.forEach((star, index) => {
    const angle = arc(slots, index, base);
    const x = core.x + Math.cos(angle) * radius;
    const y = core.y + Math.sin(angle) * radius;
    const node = nodeOf(star, x, y, core.x, core.y, radius, `${ringKey}:${star.id}`);
    nodes.push(node);
    if (!star.threads.length) return;
    const threadKey = `threads:${star.id}`;
    if (!expanded.has(threadKey)) {
      badges.push({ key: threadKey, count: star.threads.length, plus: false, x: x + 16, y: y - 16, cx: x, cy: y });
      return;
    }
    const threadAll = expanded.has(`threads-more:${star.id}`);
    const threadShown = threadAll || star.threads.length <= cap ? star.threads : star.threads.slice(0, cap);
    const threadHidden = star.threads.length - threadShown.length;
    const threadSlots = threadShown.length + (threadHidden ? 1 : 0);
    const threadR = 40 * scale;
    threadShown.forEach((thread, threadIndex) => {
      const threadAngle = arc(threadSlots, threadIndex, unit(threadKey) * Math.PI * 2);
      nodes.push(nodeOf(thread, x + Math.cos(threadAngle) * threadR, y + Math.sin(threadAngle) * threadR, x, y, threadR, `${threadKey}:${thread.id}`));
    });
    if (threadHidden) {
      const threadAngle = arc(threadSlots, threadShown.length, unit(threadKey) * Math.PI * 2);
      badges.push({
        key: `threads-more:${star.id}`,
        count: threadHidden,
        plus: true,
        x: x + Math.cos(threadAngle) * threadR,
        y: y + Math.sin(threadAngle) * threadR,
        cx: x,
        cy: y,
      });
    }
  });
  if (hidden) {
    const angle = arc(slots, shown.length, base);
    badges.push({
      key: ringKey,
      count: hidden,
      plus: true,
      x: core.x + Math.cos(angle) * radius,
      y: core.y + Math.sin(angle) * radius,
      cx: core.x,
      cy: core.y,
    });
  }
}

export function findStar(clusters: OrbitCluster[], id: string): { star: OrbitStar; project: string } | null {
  for (const cluster of clusters) {
    for (const star of [...cluster.bots, ...cluster.work]) {
      if (star.id === id) return { star, project: cluster.name };
      const thread = star.threads.find((item) => item.id === id);
      if (thread) return { star: thread, project: cluster.name };
    }
  }
  return null;
}

export function starFront(star: OrbitStar, project: string): Front {
  return {
    id: star.id,
    project,
    kind: star.kind === "grok-bot" ? "grok-bot" : "cloud-agent",
    title: star.title,
    state: star.needsYou ? "needs-you" : star.state,
    reason: star.reason,
    updatedAt: star.updatedAt,
    url: star.url,
    source: star.kind === "grok-bot" ? "grok" : "cursor",
    detail: star.guess ? MENTION_TIP : star.prUnknown ? "PR state unknown" : null,
  };
}
