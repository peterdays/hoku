import type { OverseerRefresh } from "../src/features/overseer/adapters.ts";
import { hash32 } from "../src/lib/hash.ts";
import {
  agentPageUrl,
  applyPull,
  cachedLoad,
  CURSOR_AGENT_CAP,
  CURSOR_CACHE_MS,
  CURSOR_PAGE_LIMIT,
  cursorItem,
  parsePr,
  readAgentPage,
  readCursorAgent,
  readPull,
  stepAgents,
  type CacheSlot,
  type CursorFields,
} from "../src/features/overseer/orbits.ts";

const BLOCKED_PORT = 1340;

export function httpAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || raw.includes("@")) return false;
  if (url.protocol === "https:" && (url.hostname === "api.cursor.com" || url.hostname === "api.github.com")) return true;
  return loopback(url);
}

export function loopbackOrigin(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.pathname !== "/" || url.search || url.hash) return false;
  return loopback(url);
}

function loopback(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 && port !== BLOCKED_PORT;
}

export interface RemoteEnv {
  cursorKey?: string;
  githubToken?: string;
  hermesKey?: string;
  hermesDashboard: string;
  hermesApi: string;
}

function usable(key: string): boolean {
  return key.length > 0 && ![...key].some((ch) => ch <= " " || ch === "\u007f");
}

function explain(source: string, err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return `${source} timed out.`;
  const msg = err instanceof Error ? err.message : "";
  if (msg === "refused") return `${source} URL was refused.`;
  if (msg === "HTTP 401" || msg === "HTTP 403") return `${source} rejected the credentials.`;
  if (msg.startsWith("HTTP ")) return `${source} returned ${msg}.`;
  if (msg === "not JSON" || err instanceof SyntaxError) return `${source} returned data that was not JSON.`;
  return `${source} could not be reached.`;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  if (!httpAllowed(url)) throw new Error("refused");
  const res = await fetch(url, {
    headers: { "User-Agent": "hoku-galaxy", Accept: "application/json", ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  const text = await res.text();
  if (text.length > 400_000) throw new Error("not JSON");
  return JSON.parse(text) as unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function clip(v: unknown, n: number): string | null {
  const s = str(v);
  return s ? s.slice(0, n) : null;
}

type CursorBundle = Pick<OverseerRefresh, "cursorItems" | "cursorRuns" | "cursorError" | "cursorSkipped">;

const cursorSlot: { current: CacheSlot<Promise<CursorBundle>> | null } = { current: null };

export function clearCursorCache(): void {
  cursorSlot.current = null;
}

async function mapPool<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  if (!items.length) return;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index], index);
    }
  }));
}

async function fetchCursor(key: string | undefined, githubToken: string | undefined): Promise<CursorBundle> {
  if (!key) return { cursorItems: [], cursorRuns: [], cursorError: "No Cursor API key.", cursorSkipped: false };
  if (!usable(key)) return { cursorItems: [], cursorRuns: [], cursorError: "The credential contains whitespace and was not sent.", cursorSkipped: false };
  const cacheKey = `${hash32(key)}:${githubToken && usable(githubToken) ? hash32(githubToken) : "0"}`;
  try {
    return await cachedLoad(cursorSlot, cacheKey, Date.now(), CURSOR_CACHE_MS, () => loadCursor(key, githubToken));
  } catch (err) {
    return { cursorItems: [], cursorRuns: [], cursorError: explain("Cursor", err), cursorSkipped: false };
  }
}

async function loadCursor(key: string, githubToken: string | undefined): Promise<CursorBundle> {
  const auth = { Authorization: `Bearer ${key}` };
  const rawItems: unknown[] = [];
    let cursor: string | null = null;
    let fetched = 0;
    const seen = new Set<string>();
    for (let page = 0; page < 10 && rawItems.length < CURSOR_AGENT_CAP; page++) {
      const limit = Math.min(CURSOR_PAGE_LIMIT, CURSOR_AGENT_CAP - rawItems.length);
      const parsed = await getJson(agentPageUrl(cursor, limit), auth);
      const batch = readAgentPage(parsed);
      rawItems.push(...batch.items.slice(0, CURSOR_AGENT_CAP - rawItems.length));
      const step = stepAgents(fetched, batch, CURSOR_AGENT_CAP, seen);
      fetched = rawItems.length;
      if (!step.cursor) break;
      seen.add(step.cursor);
      cursor = step.cursor;
    }
    const slots: { fields: CursorFields | null; run: unknown }[] = rawItems.map(() => ({ fields: null, run: null }));
    await mapPool(rawItems, 8, async (item, index) => {
      const id = str(rec(item)?.id);
      if (!id) return;
      let detail: unknown = null;
      let run: unknown = null;
      try {
        detail = await getJson(`https://api.cursor.com/v1/agents/${encodeURIComponent(id)}`, auth);
      } catch {
        /* The list row still places the agent when a run is missing. */
      }
      const runId = str(rec(item)?.latestRunId);
      if (runId) {
        try {
          run = await getJson(`https://api.cursor.com/v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`, auth);
        } catch {
          /* No run leaves the pull request unknown. */
        }
      }
      slots[index] = { fields: readCursorAgent(item, detail, run), run };
    });
    const fields = slots.flatMap((slot) => slot.fields ? [slot.fields] : []);
    if (githubToken && usable(githubToken)) await stampPulls(fields, githubToken);
    const runs = slots.flatMap((slot) => slot.fields && slot.run ? [slimRun(slot.run)] : []).slice(0, 10);
  return { cursorItems: fields.map((field) => cursorItem(field)), cursorRuns: runs, cursorError: null, cursorSkipped: false };
}

function slimRun(run: unknown): Record<string, unknown> {
  const row = rec(run);
  const git = rec(row?.git);
  const branches = Array.isArray(git?.branches) ? git.branches.slice(0, 4).map((branch) => {
    const b = rec(branch);
    return { repoUrl: clip(b?.repoUrl, 200), prUrl: clip(b?.prUrl, 200) };
  }) : [];
  return {
    id: clip(row?.id, 128),
    agentId: clip(row?.agentId, 128),
    status: clip(row?.status, 40),
    updatedAt: clip(row?.updatedAt, 40),
    result: clip(row?.result, 160),
    git: { branches },
  };
}

async function stampPulls(fields: CursorFields[], token: string): Promise<void> {
  const urls = [...new Set(fields.map((field) => field.prUrl).filter((url): url is string => !!url))].slice(0, CURSOR_AGENT_CAP);
  const found = new Map<string, { state: "open" | "closed" | "merged"; title: string | null } | null>();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  await mapPool(urls, 6, async (url) => {
    const pr = parsePr(url);
    if (!pr) {
      found.set(url, null);
      return;
    }
    try {
      const json = await getJson(`https://api.github.com/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.n}`, headers);
      found.set(url, readPull(json));
    } catch {
      found.set(url, null);
    }
  });
  for (let i = 0; i < fields.length; i++) {
    const url = fields[i].prUrl;
    const pull = url ? found.get(url) ?? null : null;
    if (pull) fields[i] = applyPull(fields[i], pull);
  }
}

const GH_QUERIES = [
  "is:open is:pr review-requested:@me",
  "is:open is:pr author:@me review:changes_requested",
  "is:open is:pr author:@me status:failure",
  "is:open is:pr author:@me",
  "is:open is:issue assignee:@me",
] as const;

async function fetchGithub(token: string | undefined): Promise<Pick<OverseerRefresh, "githubReview" | "githubChanges" | "githubFailing" | "githubAuthored" | "githubIssues" | "githubError" | "githubSkipped">> {
  const empty = { githubReview: [], githubChanges: [], githubFailing: [], githubAuthored: [], githubIssues: [], githubError: null as string | null, githubSkipped: false };
  if (!token) return { ...empty, githubError: "No GitHub token." };
  if (!usable(token)) return { ...empty, githubError: "The credential contains whitespace and was not sent." };
  const buckets: unknown[][] = [];
  try {
    for (const query of GH_QUERIES) {
      const url = `https://api.github.com/search/issues?per_page=15&q=${encodeURIComponent(query).replace(/%20/g, "+")}`;
      const parsed = await getJson(url, {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      const items = Array.isArray(rec(parsed)?.items) ? rec(parsed)!.items as unknown[] : [];
      buckets.push(items.slice(0, 15).map((item) => {
        const row = rec(item);
        return {
          title: clip(row?.title, 120),
          html_url: clip(row?.html_url, 200),
          updated_at: clip(row?.updated_at, 40),
          repository_url: clip(row?.repository_url, 200),
          draft: row?.draft === true,
        };
      }));
    }
  } catch (err) {
    return { ...empty, githubError: explain("GitHub", err) };
  }
  return {
    githubReview: buckets[0],
    githubChanges: buckets[1],
    githubFailing: buckets[2],
    githubAuthored: buckets[3],
    githubIssues: buckets[4],
    githubError: null,
    githubSkipped: false,
  };
}

function projectSessions(value: unknown): { sessions: unknown[] } {
  const list = Array.isArray(value) ? value : Array.isArray(rec(value)?.sessions) ? rec(value)!.sessions as unknown[] : [];
  const sessions = [];
  for (const item of list.slice(0, 30)) {
    const row = rec(item);
    const id = str(row?.id);
    if (!row || !id) continue;
    sessions.push({
      id: id.slice(0, 128),
      title: clip(row.title, 80),
      preview: clip(row.preview, 160),
      status: clip(row.status, 40),
      source: clip(row.source, 64),
      is_active: row.is_active === true,
      pending_approval: row.pending_approval === true,
      pending_clarify: row.pending_clarify === true,
      last_active: row.last_active ?? null,
      ended_at: row.ended_at ?? null,
    });
  }
  return { sessions };
}

async function fetchHermes(env: RemoteEnv): Promise<Pick<OverseerRefresh, "hermesSessions" | "hermesError" | "hermesNote" | "hermesSkipped" | "hermesDashboard">> {
  const base = { hermesSessions: null, hermesSkipped: false, hermesDashboard: env.hermesDashboard };
  if (!loopbackOrigin(env.hermesDashboard)) {
    return { ...base, hermesError: "The Hermes dashboard address is not a loopback URL.", hermesNote: "" };
  }
  try {
    await getJson(`${env.hermesDashboard}/api/status`, {});
  } catch (err) {
    const message = explain("Hermes", err).replace("could not be reached", "is not running");
    return { ...base, hermesError: message, hermesNote: "" };
  }
  try {
    const sessions = projectSessions(await getJson(`${env.hermesDashboard}/api/sessions?limit=20`, {}));
    return { ...base, hermesSessions: sessions, hermesError: null, hermesNote: "Sessions from the local dashboard. A needs-you state is set only when a session says it is waiting on approval or a clarification." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg !== "HTTP 401" && msg !== "HTTP 403") return { ...base, hermesError: explain("Hermes", err), hermesNote: "" };
  }
  if (!env.hermesKey) {
    return { ...base, hermesError: "The Hermes dashboard is running, but the session list requires a login. Hoku does not sign in.", hermesNote: "" };
  }
  if (!usable(env.hermesKey)) return { ...base, hermesError: "The credential contains whitespace and was not sent.", hermesNote: "" };
  if (!loopbackOrigin(env.hermesApi)) return { ...base, hermesError: "The Hermes API address is not a loopback URL.", hermesNote: "" };
  try {
    const sessions = projectSessions(await getJson(`${env.hermesApi}/api/sessions?limit=20`, { Authorization: `Bearer ${env.hermesKey}` }));
    return { ...base, hermesSessions: sessions, hermesError: null, hermesNote: "Sessions from the local API server. Hoku does not call the approval or clarify endpoints." };
  } catch (err) {
    return { ...base, hermesError: explain("Hermes", err), hermesNote: "" };
  }
}

export async function fetchRemote(env: RemoteEnv): Promise<OverseerRefresh> {
  const [cursor, github, hermes] = await Promise.all([fetchCursor(env.cursorKey, env.githubToken), fetchGithub(env.githubToken), fetchHermes(env)]);
  return {
    ...cursor,
    ...github,
    ...hermes,
    grokText: null,
    grokError: null,
    grokNote: "",
    grokSkipped: true,
  };
}
