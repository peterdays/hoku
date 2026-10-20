import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { webDemo } from "./galaxyPayload";
import { OrbitMap } from "./OrbitMap";
import {
  agentPageUrl,
  applyPull,
  buildOrbits,
  cachedLoad,
  cacheGet,
  extractMentions,
  MENTION_TIP,
  ORBIT_CAP,
  OTHER_BOTS,
  parseRecentDays,
  placeOrbits,
  prVisibility,
  readAgentPage,
  readCursorAgent,
  readPull,
  stepAgents,
  type AgentPage,
  type BotMentions,
  type OrbitCluster,
  type OrbitStar,
} from "./orbits";

const BC = (n: string) => `bc-00000000-0000-4000-8000-${n}`;
const PARENT = BC("000000000010");
const THREAD = BC("000000000011");
const OPEN = "https://github.com/hoku-demo/site/pull/18";

function bot(id: string, state: "active" | "resting" | "probably-waiting" | "unanswered" = "active") {
  return { id, name: id, state, lastTimestamp: "2026-10-17T11:00:00Z" };
}

function mention(botId: string, agents: [string, number, number][] = [], repos: [string, number, number][] = []): BotMentions {
  return {
    botId,
    agents: agents.map(([key, count, lastMs]) => ({ key, count, lastMs })),
    repos: repos.map(([key, count, lastMs]) => ({ key, count, lastMs })),
  };
}

function cursor(p: Record<string, unknown>) {
  return { name: "Work", status: "IDLE", runStatus: "FINISHED", updatedAt: "2026-10-17T11:00:00Z", ...p };
}

describe("extractMentions", () => {
  it("counts agent ids and github repos and drops the rest of the body", () => {
    const secret = "SECRET_BODY_not_a_slug";
    const rows = [
      { agentId: "alpha", timestampMs: 10, body: `see ${secret} https://github.com/Hoku-Demo/Site/pull/4` },
      { agentId: "alpha", timestampMs: 30, body: `https://cursor.com/agents/${BC("0000000000aa")} and https://github.com/hoku-demo/site/blob/main/README.md` },
      { agentId: "alpha", timestampMs: 20, body: "https://github.com/hoku-demo/site/commit/abc no" },
      { agentId: "beta", timestampMs: 5, body: `again ${BC("0000000000aa")} ${BC("0000000000aa")}` },
    ];
    const out = extractMentions(rows);
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.find((item) => item.botId === "alpha")?.repos).toEqual([{ key: "hoku-demo/site", count: 2, lastMs: 30 }]);
    expect(out.find((item) => item.botId === "alpha")?.agents).toEqual([{ key: BC("0000000000aa"), count: 1, lastMs: 30 }]);
    expect(out.find((item) => item.botId === "beta")?.agents[0]).toMatchObject({ count: 2, lastMs: 5 });
  });
});

describe("cursor pages and pull state", () => {
  it("walks nextCursor until the cap or the cursor is omitted", () => {
    const page = (n: number, next: string | null): AgentPage => ({ items: Array.from({ length: n }, (_, i) => i), nextCursor: next });
    const items: unknown[] = [];
    let fetched = 0;
    const seen = new Set<string>();
    const pages = [page(20, "c1"), page(20, "c2"), page(20, null)];
    for (const batch of pages) {
      items.push(...batch.items.slice(0, 50 - items.length));
      const step = stepAgents(fetched, batch, 50, seen);
      fetched = items.length;
      if (!step.cursor) break;
      seen.add(step.cursor);
    }
    expect(items).toHaveLength(50);
    expect(readAgentPage({ items: [1], nextCursor: "x" }).nextCursor).toBe("x");
    expect(readAgentPage({ items: [] }).nextCursor).toBeNull();
    expect(agentPageUrl("c1", 100)).toContain("limit=100");
    expect(agentPageUrl("c1", 100)).toContain("includeArchived=false");
    expect(agentPageUrl(null, 100)).not.toContain("cursor=");
    const repeated = stepAgents(0, page(10, "c1"), 200, new Set(["c1"]));
    expect(repeated.cursor).toBeNull();
  });

  it("reads repository, parent, and PR status without inventing a missing status", () => {
    const agent = readCursorAgent(
      { id: THREAD, name: "Cache headers", status: "ACTIVE", latestRunId: "run-1", updatedAt: "2026-10-17T10:00:00Z" },
      { repos: [{ url: "https://github.com/hoku-demo/site.git" }], parentAgentId: PARENT },
      { status: "FINISHED", updatedAt: "2026-10-17T11:00:00Z", git: { branches: [{ repoUrl: "github.com/hoku-demo/site", prUrl: OPEN, prStatus: "open" }] } },
    );
    expect(agent).toMatchObject({ repository: "hoku-demo/site", parentId: PARENT, prUrl: OPEN, prStatus: "open", runStatus: "FINISHED" });
    expect(readCursorAgent({ id: PARENT, name: "Plain", status: "ACTIVE" })?.prStatus).toBeNull();
    expect(readPull({ state: "closed", merged: true, title: "Done" })).toEqual({ state: "merged", title: "Done" });
    expect(readPull({ state: "weird" })).toBeNull();
    const stamped = applyPull(agent!, { state: "closed", title: "From GitHub" });
    expect(stamped.githubPr).toBe("closed");
    expect(prVisibility(OPEN, "closed", "open")).toBe("closed");
    expect(prVisibility(OPEN, null, null)).toBe("unknown");
    expect(prVisibility(null, null, "open")).toBe("none");
  });

  it("caches a load until the ttl, and drops a failed load", async () => {
    const slot: { current: { key: string; at: number; value: Promise<number> } | null } = { current: null };
    let calls = 0;
    const load = () => Promise.resolve(++calls);
    expect(await cachedLoad(slot, "k", 0, 1000, load)).toBe(1);
    expect(await cachedLoad(slot, "k", 500, 1000, load)).toBe(1);
    expect(await cachedLoad(slot, "k", 1000, 1000, load)).toBe(2);
    expect(cacheGet(slot.current, "other", 1000, 1000)).toBeNull();
    const failing: { current: { key: string; at: number; value: Promise<number> } | null } = { current: null };
    await expect(cachedLoad(failing, "k", 0, 1000, () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(failing.current).toBeNull();
  });
});

describe("buildOrbits", () => {
  const review = [{ url: OPEN, reason: "Review requested" }];

  it("breaks mention ties by recency and hides a repo mentioned once", () => {
    const model = buildOrbits({
      bots: [bot("early"), bot("late"), bot("quiet")],
      mentions: [
        mention("early", [[THREAD, 2, 10]], [["hoku-demo/site", 2, 10]]),
        mention("late", [[THREAD, 2, 50]], []),
        mention("quiet", [], [["hoku-demo/noise", 1, 50]]),
      ],
      cursorItems: [cursor({ id: THREAD, repository: "hoku-demo/site", prUrl: OPEN, githubPr: "open" })],
      review: [],
    });
    const site = model.clusters.find((cluster) => cluster.slug === "hoku-demo/site");
    expect(site?.bots.map((item) => item.id).sort()).toEqual(["grok:early", "grok:late"]);
    expect(site?.bots.find((item) => item.id === "grok:late")?.mentions).toBe(2);
    expect(model.clusters.some((cluster) => cluster.slug === "hoku-demo/noise")).toBe(false);
    expect(site?.bots.every((item) => item.guess && item.url.startsWith("grokbot://"))).toBe(true);
  });

  it("groups a coordinator's open threads and drops closed, merged, and unclaimed agents", () => {
    const model = buildOrbits({
      bots: [bot("notes", "probably-waiting"), bot("alone", "probably-waiting")],
      mentions: [mention("notes", [[PARENT, 3, 20]], [["hoku-demo/site", 2, 20]])],
      prKnown: true,
      now: Date.parse("2026-10-17T12:00:00Z"),
      cursorItems: [
        cursor({ id: PARENT, name: "performance gains", repository: "hoku-demo/site" }),
        cursor({ id: THREAD, name: "Cache headers", parentId: PARENT, repository: "hoku-demo/site", prUrl: OPEN, prTitle: "Pagination fix", githubPr: "open", runStatus: "FINISHED" }),
        cursor({ id: BC("000000000012"), name: "Fonts", parentId: PARENT, repository: "hoku-demo/site", prUrl: "https://github.com/hoku-demo/site/pull/19", githubPr: "open", runStatus: "RUNNING" }),
        cursor({ id: BC("000000000013"), name: "OLD_THREAD", parentId: PARENT, repository: "hoku-demo/site", prUrl: "https://github.com/hoku-demo/site/pull/3", githubPr: "merged" }),
        cursor({ id: BC("000000000014"), name: "NO_PR", repository: "hoku-demo/site", runStatus: "FINISHED" }),
        cursor({ id: BC("000000000015"), name: "LOST", prUrl: "https://github.com/hoku-demo/hoku/pull/9", githubPr: "open" }),
        cursor({ id: BC("000000000016"), name: "NOWHERE", runStatus: "FINISHED" }),
      ],
      review,
    });
    const names = model.clusters.map((cluster) => cluster.name);
    expect(names).not.toContain("Unassigned");
    expect(names).not.toContain("Unclaimed");
    expect(names).toContain(OTHER_BOTS);
    const site = model.clusters.find((cluster) => cluster.slug === "hoku-demo/site")!;
    const project = site.work.find((star) => star.kind === "cursor-project");
    expect(project).toMatchObject({ title: "performance gains", needsYou: true });
    expect(project?.threads.map((thread) => thread.title).sort()).toEqual(["Fonts", "Pagination fix"]);
    expect(project?.threads.find((thread) => thread.title === "Pagination fix")).toMatchObject({ state: "done", needsYou: true });
    expect(JSON.stringify(model)).not.toContain("OLD_THREAD");
    expect(JSON.stringify(model)).not.toContain("NO_PR");
    expect(JSON.stringify(model)).not.toContain("NOWHERE");
    const hoku = model.clusters.find((cluster) => cluster.slug === "hoku-demo/hoku");
    expect(hoku?.work.map((star) => star.title)).toEqual(["LOST"]);
    expect(model.attention.map((front) => front.id)).toEqual([`cursor:${THREAD}`]);
    expect(model.attention[0]).toMatchObject({ state: "needs-you", reason: "Review requested" });
    expect(model.suppressPrUrls).toContain(OPEN);
    expect(model.clusters.find((cluster) => cluster.name === OTHER_BOTS)?.bots.map((item) => item.id)).toEqual(["grok:alone"]);
  });

  it("shows an unknown pull request with no needs-you, and keeps a finished open PR out of the inbox", () => {
    const model = buildOrbits({
      bots: [],
      mentions: [],
      prKnown: false,
      now: Date.parse("2026-10-17T12:00:00Z"),
      cursorItems: [
        cursor({ id: THREAD, name: "Schema notes", repository: "hoku-demo/hoku", prUrl: "https://github.com/hoku-demo/hoku/pull/4", runStatus: "FINISHED" }),
        cursor({ id: BC("000000000012"), name: "API types", repository: "hoku-demo/hoku", prUrl: "https://github.com/hoku-demo/hoku/pull/2", githubPr: "open", runStatus: "FINISHED" }),
      ],
      review: [],
    });
    const work = model.clusters[0].work;
    expect(work.find((star) => star.title === "Schema notes")).toMatchObject({ prUnknown: true, needsYou: false, state: "done" });
    expect(work.find((star) => star.title === "API types")).toMatchObject({ prUnknown: false, needsYou: false, state: "done" });
    expect(model.attention).toEqual([]);
  });

  it("hides a cursor project whose threads have no open pull request", () => {
    const model = buildOrbits({
      bots: [],
      mentions: [],
      prKnown: true,
      cursorItems: [
        cursor({ id: PARENT, name: "performance gains", repository: "hoku-demo/site" }),
        cursor({ id: THREAD, name: "Closed", parentId: PARENT, repository: "hoku-demo/site", prUrl: OPEN, githubPr: "closed" }),
      ],
      review: [],
    });
    expect(model.clusters).toEqual([]);
  });
});

describe("work filter", () => {
  const NOW = Date.parse("2026-10-17T12:00:00Z");
  const day = 24 * 60 * 60 * 1000;

  it("shows a running old item, a finished recent item, and hides a finished old item", () => {
    const model = buildOrbits({
      bots: [],
      mentions: [],
      prKnown: false,
      now: NOW,
      cursorItems: [
        cursor({ id: THREAD, name: "Still going", repository: "hoku-demo/site", runStatus: "RUNNING", updatedAt: new Date(NOW - 30 * day).toISOString() }),
        cursor({ id: BC("000000000012"), name: "Fresh finish", repository: "hoku-demo/site", runStatus: "FINISHED", updatedAt: new Date(NOW - day).toISOString() }),
        cursor({ id: BC("000000000013"), name: "OLD_FINISH", repository: "hoku-demo/site", runStatus: "FINISHED", updatedAt: new Date(NOW - 10 * day).toISOString() }),
        cursor({ id: BC("000000000014"), name: "Creating", repository: "hoku-demo/site", runStatus: "CREATING", status: "IDLE", updatedAt: new Date(NOW - 40 * day).toISOString() }),
      ],
      review: [],
    });
    const titles = model.clusters[0].work.map((star) => star.title).sort();
    expect(titles).toEqual(["Creating", "Fresh finish", "Still going"]);
    expect(model.clusters[0].hidden).toBe(1);
    expect(JSON.stringify(model)).not.toContain("OLD_FINISH");
  });

  it("with a known pull-request state, keeps open pull requests and running work", () => {
    const model = buildOrbits({
      bots: [],
      mentions: [],
      prKnown: true,
      now: NOW,
      cursorItems: [
        cursor({ id: THREAD, name: "Open old", repository: "hoku-demo/site", prUrl: OPEN, githubPr: "open", runStatus: "FINISHED", updatedAt: new Date(NOW - 30 * day).toISOString() }),
        cursor({ id: BC("000000000012"), name: "CLOSED_OLD", repository: "hoku-demo/site", prUrl: "https://github.com/hoku-demo/site/pull/2", githubPr: "closed", runStatus: "FINISHED", updatedAt: new Date(NOW - day).toISOString() }),
        cursor({ id: BC("000000000013"), name: "NO_PR", repository: "hoku-demo/site", runStatus: "FINISHED", updatedAt: new Date(NOW - day).toISOString() }),
        cursor({ id: BC("000000000014"), name: "Running closed", repository: "hoku-demo/site", prUrl: "https://github.com/hoku-demo/site/pull/8", githubPr: "closed", runStatus: "RUNNING", updatedAt: new Date(NOW - 30 * day).toISOString() }),
      ],
      review: [],
    });
    expect(model.clusters[0].work.map((star) => star.title).sort()).toEqual(["Open old", "Running closed"]);
    expect(model.clusters[0].hidden).toBe(2);
    expect(JSON.stringify(model)).not.toContain("CLOSED_OLD");
    expect(JSON.stringify(model)).not.toContain("NO_PR");
  });

  it("drops a cursor project when every thread is hidden, and keeps the repo for its bots", () => {
    const model = buildOrbits({
      bots: [bot("notes")],
      mentions: [mention("notes", [], [["hoku-demo/site", 2, 20]])],
      prKnown: false,
      now: NOW,
      cursorItems: [
        cursor({ id: PARENT, name: "performance gains", repository: "hoku-demo/site", runStatus: "FINISHED", updatedAt: new Date(NOW - 10 * day).toISOString() }),
        cursor({ id: THREAD, name: "OLD_A", parentId: PARENT, repository: "hoku-demo/site", runStatus: "FINISHED", updatedAt: new Date(NOW - 10 * day).toISOString() }),
        cursor({ id: BC("000000000012"), name: "OLD_B", parentId: PARENT, repository: "hoku-demo/site", runStatus: "FINISHED", updatedAt: new Date(NOW - 12 * day).toISOString() }),
      ],
      review: [],
    });
    const site = model.clusters.find((cluster) => cluster.slug === "hoku-demo/site");
    expect(site?.work).toEqual([]);
    expect(site?.bots.map((item) => item.id)).toEqual(["grok:notes"]);
    expect(site?.hidden).toBe(3);
    expect(JSON.stringify(model)).not.toContain("performance gains");
    expect(JSON.stringify(model)).not.toContain("cursor-project");
  });

  it("reads the recent window from the env string", () => {
    expect(parseRecentDays(undefined)).toBe(3);
    expect(parseRecentDays("")).toBe(3);
    expect(parseRecentDays("nope")).toBe(3);
    expect(parseRecentDays("1")).toBe(1);
    const recent = cursor({ id: THREAD, name: "Two days", repository: "hoku-demo/site", runStatus: "FINISHED", updatedAt: new Date(NOW - 2 * day).toISOString() });
    const wide = buildOrbits({ bots: [], mentions: [], prKnown: false, now: NOW, recentDays: 3, cursorItems: [recent], review: [] });
    const narrow = buildOrbits({ bots: [], mentions: [], prKnown: false, now: NOW, recentDays: 1, cursorItems: [recent], review: [] });
    expect(wide.clusters[0].work.map((star) => star.title)).toEqual(["Two days"]);
    expect(narrow.clusters).toEqual([]);
  });
});

describe("orbit layout", () => {
  function work(id: string): OrbitStar {
    return {
      id: `cursor:${id}`, kind: "cloud-agent", title: id, state: "done", reason: "Turn finished", url: `https://cursor.com/agents/${id}`,
      guess: false, prUnknown: false, needsYou: false, updatedAt: "2026-10-17T11:00:00Z", mentions: null, lastMentioned: null, prUrl: null, threads: [],
    };
  }

  it("collapses a ring past the cap until it is expanded", () => {
    const cluster: OrbitCluster = { name: "site", url: "https://github.com/hoku-demo/site", slug: "hoku-demo/site", hidden: 0, bots: [], work: Array.from({ length: 50 }, (_, i) => work(String(i).padStart(2, "0"))) };
    const collapsed = placeOrbits([cluster], 1200, 800, new Set());
    expect(collapsed.nodes).toHaveLength(ORBIT_CAP);
    expect(collapsed.badges).toEqual([expect.objectContaining({ key: "site:work", count: 50 - ORBIT_CAP, plus: true })]);
    const open = placeOrbits([cluster], 1200, 800, new Set(["site:work"]));
    expect(open.nodes).toHaveLength(50);
    expect(open.badges).toEqual([]);
  });

  it("draws demo stars for projects, bots, and open work", () => {
    const payload = webDemo();
    const model = placeOrbits(payload.orbits, 1280, 800, new Set());
    const html = renderToStaticMarkup(<OrbitMap model={model} selectedId={null} onSelect={() => undefined} onToggle={() => undefined} />);
    expect(html).toContain("performance gains");
    expect(html).toContain(OTHER_BOTS);
    expect(html).toContain("https://github.com/hoku-demo/site");
    expect(html).toContain("grokbot://app/v1/agent?id=release-notes");
    expect(html).toContain("https://cursor.com/agents/");
    expect(html).toContain(MENTION_TIP);
    expect(html).toContain("?");
    expect(html).toContain('data-orbit-more="threads:');
    expect(html).not.toContain("Unassigned");
    expect(html).not.toContain("Unclaimed");
    expect(html).not.toContain("OLD");
    expect(html).not.toContain("Merged");
    expect(model.nodes.filter((node) => node.ids.includes("grok:release-notes")).length).toBeGreaterThan(0);
    expect(model.nodes.find((node) => node.ids.includes("grok:release-notes"))?.float).toContain("~");
    expect(payload.orbits.find((cluster) => cluster.name === OTHER_BOTS)?.work).toEqual([]);
    const thread = payload.orbits.find((cluster) => cluster.name === "site")?.work.find((star) => star.kind === "cursor-project")?.threads.find((item) => item.title === "Pagination fix");
    expect(thread).toMatchObject({ state: "done", needsYou: true });
    expect(payload.fronts.find((front) => front.title === "Pagination fix")).toMatchObject({ kind: "cloud-agent", project: "site", state: "needs-you" });
    expect(payload.fronts.find((front) => front.id === "grok:release-notes")?.project).toBe("site");
    expect(payload.fronts.some((front) => front.kind === "github-pr" && front.url.endsWith("/pull/18"))).toBe(false);
    expect(html).toContain("+1 older hidden");
    expect(payload.orbits.find((cluster) => cluster.name === "site")?.work).not.toEqual([]);
  });
});
