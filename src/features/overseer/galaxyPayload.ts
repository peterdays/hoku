import { assemble, demoSnapshot, rankFronts, type Front, type OverseerRefresh, type SourceReport } from "./adapters";
import { frontsFromGrokAgents, GROK_UNAVAILABLE, type GrokAgentState, type GrokGuess } from "./grokIndex";
import { buildOrbits, OTHER_BOTS, RECENT_DAYS_DEFAULT, withOrbits, type BotMentions, type OrbitCluster, type OrbitStar } from "./orbits";

const DEMO_AT = Date.parse("2026-10-17T11:00:00Z");
const demoId = (n: string) => `bc-00000000-0000-4000-8000-${n}`;

const DEMO_MENTIONS: BotMentions[] = [
  { botId: "release-notes", agents: [{ key: demoId("000000000010"), count: 2, lastMs: DEMO_AT }], repos: [{ key: "hoku-demo/site", count: 3, lastMs: DEMO_AT }, { key: "hoku-demo/noise", count: 1, lastMs: DEMO_AT }] },
  { botId: "triage", agents: [{ key: demoId("000000000011"), count: 1, lastMs: DEMO_AT - 1000 }], repos: [{ key: "hoku-demo/site", count: 2, lastMs: DEMO_AT }] },
  { botId: "changelog", agents: [], repos: [{ key: "hoku-demo/hoku", count: 4, lastMs: DEMO_AT }] },
];

const DEMO_CURSOR = [
  { id: demoId("000000000010"), name: "performance gains", status: "IDLE", runStatus: "FINISHED", updatedAt: "2026-10-17T10:00:00Z", repository: "hoku-demo/site", url: `https://cursor.com/agents/${demoId("000000000010")}` },
  { id: demoId("000000000011"), name: "Cache headers", status: "IDLE", runStatus: "FINISHED", parentId: demoId("000000000010"), updatedAt: "2026-10-17T10:30:00Z", repository: "hoku-demo/site", prUrl: "https://github.com/hoku-demo/lumen/pull/18", prTitle: "Pagination fix", githubPr: "open", url: `https://cursor.com/agents/${demoId("000000000011")}` },
  { id: demoId("000000000012"), name: "Fonts", status: "ACTIVE", runStatus: "RUNNING", parentId: demoId("000000000010"), updatedAt: "2026-10-17T11:00:00Z", repository: "hoku-demo/site", prUrl: "https://github.com/hoku-demo/site/pull/19", githubPr: "open", url: `https://cursor.com/agents/${demoId("000000000012")}` },
  { id: demoId("000000000013"), name: "Old thread", status: "IDLE", runStatus: "FINISHED", parentId: demoId("000000000010"), updatedAt: "2026-10-01T10:00:00Z", repository: "hoku-demo/site", prUrl: "https://github.com/hoku-demo/site/pull/3", githubPr: "merged" },
  { id: demoId("000000000014"), name: "List virtualization", status: "ACTIVE", runStatus: "RUNNING", updatedAt: "2026-10-17T11:10:00Z", repository: "hoku-demo/site", prUrl: "https://github.com/hoku-demo/site/pull/30", githubPr: "open", url: `https://cursor.com/agents/${demoId("000000000014")}` },
  { id: demoId("000000000015"), name: "API types", status: "IDLE", runStatus: "FINISHED", updatedAt: "2026-10-16T08:00:00Z", repository: "hoku-demo/hoku", prUrl: "https://github.com/hoku-demo/hoku/pull/2", githubPr: "open", url: `https://cursor.com/agents/${demoId("000000000015")}` },
  { id: demoId("000000000016"), name: "Schema notes", status: "IDLE", runStatus: "FINISHED", updatedAt: "2026-10-16T09:00:00Z", repository: "hoku-demo/hoku", prUrl: "https://github.com/hoku-demo/hoku/pull/4", url: `https://cursor.com/agents/${demoId("000000000016")}` },
  { id: demoId("000000000017"), name: "Merged notes", status: "IDLE", runStatus: "FINISHED", updatedAt: "2026-10-01T09:00:00Z", repository: "hoku-demo/hoku", prUrl: "https://github.com/hoku-demo/hoku/pull/1", githubPr: "closed" },
];

export interface GrokPublic {
  id: string;
  name: string;
  lastTimestamp: string;
  lastRole: "user" | "assistant";
  state: GrokGuess;
}

export interface GalaxyPayload {
  demo: boolean;
  fronts: Front[];
  sources: SourceReport[];
  grokAgents: GrokPublic[];
  orbits: OrbitCluster[];
}

const FRONT_KEYS = ["id", "project", "kind", "title", "state", "reason", "updatedAt", "url", "source", "detail"] as const;

export function galaxyJson(payload: GalaxyPayload): string {
  return JSON.stringify({
    demo: payload.demo === true,
    fronts: payload.fronts.map((front) => {
      const out: Record<string, string | null> = {};
      for (const key of FRONT_KEYS) out[key] = front[key] ?? null;
      return out;
    }),
    sources: payload.sources.map((source) => ({
      key: source.key,
      label: source.label,
      mode: source.mode,
      detail: source.detail,
    })),
    grokAgents: payload.grokAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      lastTimestamp: agent.lastTimestamp,
      lastRole: agent.lastRole,
      state: agent.state,
    })),
    orbits: (payload.orbits ?? []).map(publicCluster),
  });
}

function publicStar(star: OrbitStar, nested = false): Record<string, unknown> {
  return {
    id: star.id,
    kind: star.kind,
    title: star.title,
    state: star.state,
    reason: star.reason,
    url: star.url,
    guess: star.guess === true,
    prUnknown: star.prUnknown === true,
    needsYou: star.needsYou === true,
    updatedAt: star.updatedAt,
    mentions: typeof star.mentions === "number" ? star.mentions : null,
    lastMentioned: star.lastMentioned ?? null,
    prUrl: star.prUrl ?? null,
    threads: nested ? [] : star.threads.map((thread) => publicStar(thread, true)),
  };
}

function publicCluster(cluster: OrbitCluster): Record<string, unknown> {
  return {
    name: cluster.name,
    url: cluster.url,
    slug: cluster.slug,
    hidden: cluster.hidden,
    bots: cluster.bots.map((star) => publicStar(star)),
    work: cluster.work.map((star) => publicStar(star)),
  };
}

/** Same invented fronts as the desktop demo, with Grok labels marked as guesses. */
export function webDemo(): GalaxyPayload {
  const demo = demoSnapshot();
  const fronts = demo.fronts.map((front) => {
    if (front.id === "grok:release-notes") {
      return { ...front, reason: "~ waiting on you", detail: "Guess from the message index. No turn or approval data.", url: "grokbot://app/v1/agent?id=release-notes" };
    }
    if (front.id === "grok:triage") {
      return { ...front, reason: "~ active", detail: "Guess from the message index. No turn or approval data.", url: "grokbot://app/v1/agent?id=triage" };
    }
    return front;
  });
  const stamp = (id: string) => fronts.find((front) => front.id === id)?.updatedAt ?? new Date(0).toISOString();
  const grokAgents: GrokPublic[] = [
    { id: "release-notes", name: "Release notes", lastTimestamp: stamp("grok:release-notes"), lastRole: "assistant", state: "probably-waiting" },
    { id: "triage", name: "Triage", lastTimestamp: stamp("grok:triage"), lastRole: "assistant", state: "active" },
    { id: "changelog", name: "Changelog", lastTimestamp: stamp("grok:triage"), lastRole: "assistant", state: "resting" },
    { id: "version-picker", name: "Version picker", lastTimestamp: stamp("grok:release-notes"), lastRole: "assistant", state: "probably-waiting" },
  ];
  const extra: Front[] = [
    { id: "grok:changelog", project: "hoku", kind: "grok-bot", title: "Changelog", state: "idle", reason: "~ resting", updatedAt: stamp("grok:triage"), url: "grokbot://app/v1/agent?id=changelog", source: "grok", detail: "Guess from the message index. No turn or approval data." },
    { id: "grok:version-picker", project: OTHER_BOTS, kind: "grok-bot", title: "Version picker", state: "needs-you", reason: "~ waiting on you", updatedAt: stamp("grok:release-notes"), url: "grokbot://app/v1/agent?id=version-picker", source: "grok", detail: "Guess from the message index. No turn or approval data." },
  ];
  const kept = fronts.filter((front) => front.kind !== "cloud-agent");
  const model = buildOrbits({
    bots: grokAgents.map((bot) => ({ id: bot.id, name: bot.name, state: bot.state, lastTimestamp: bot.lastTimestamp })),
    mentions: DEMO_MENTIONS,
    cursorItems: DEMO_CURSOR,
    review: kept.filter((front) => front.kind === "github-pr" && front.state === "needs-you").map((front) => ({ url: front.url, reason: front.reason })),
    prKnown: false,
    now: Date.parse("2026-10-17T12:00:00Z"),
    recentDays: 3,
  });
  return withOrbits({
    demo: true,
    fronts: [...kept, ...extra],
    sources: demo.sources.map((source) => source.key === "grok"
      ? { ...source, detail: "Demo. Grok states are guesses on invented bots. The local index was not read." }
      : source),
    grokAgents,
    orbits: [],
  }, model);
}

export function livePayload(
  raw: OverseerRefresh,
  grok: { available: true; agents: GrokAgentState[]; mentions: BotMentions[]; activeMinutes: number } | { available: false },
  opts: { prKnown?: boolean; recentDays?: number; now?: number } = {},
): GalaxyPayload {
  const base = assemble({ ...raw, grokText: null, grokError: null, grokNote: "", grokSkipped: true });
  const payload: GalaxyPayload = !grok.available
    ? {
        demo: false,
        fronts: base.fronts,
        sources: base.sources.map((source) => source.key === "grok"
          ? { key: "grok", label: "Grok bots", mode: "error", detail: GROK_UNAVAILABLE }
          : source),
        grokAgents: [],
        orbits: [],
      }
    : {
        demo: false,
        fronts: rankFronts([...base.fronts, ...frontsFromGrokAgents(grok.agents)]),
        sources: base.sources.map((source) => source.key === "grok"
          ? {
              key: "grok",
              label: "Grok bots",
              mode: "live",
              detail: `${grok.agents.length} bots. States are guesses from the local index. Active means an assistant message in the last ${grok.activeMinutes} minutes.`,
            }
          : source),
        grokAgents: grok.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          lastTimestamp: agent.lastTimestamp,
          lastRole: agent.lastRole,
          state: agent.state,
        })),
        orbits: [],
      };
  const bots = grok.available ? grok.agents : [];
  const prKnown = opts.prKnown === true;
  const recentDays = opts.recentDays ?? RECENT_DAYS_DEFAULT;
  const model = buildOrbits({
    bots: bots.map((bot) => ({ id: bot.id, name: bot.name, state: bot.state, lastTimestamp: bot.lastTimestamp })),
    mentions: grok.available ? grok.mentions : [],
    cursorItems: raw.cursorSkipped || raw.cursorError ? [] : raw.cursorItems,
    review: payload.fronts.filter((front) => front.kind === "github-pr" && front.state === "needs-you").map((front) => ({ url: front.url, reason: front.reason })),
    prKnown,
    recentDays,
    now: opts.now,
  });
  const merged = withOrbits(payload, model);
  if (!raw.cursorSkipped && !raw.cursorError) {
    const shown = merged.orbits.reduce((sum, cluster) => sum + cluster.work.reduce((inner, star) => inner + (star.threads.length || (star.kind === "cloud-agent" ? 1 : 0)), 0), 0);
    const detail = prKnown
      ? `${shown} cloud agents on the map. Open pull requests and running work stay. Closed and merged pull requests are hidden unless the run is still going.`
      : `${shown} cloud agents on the map. No GitHub token, so finished work older than ${recentDays} days is hidden.`;
    merged.sources = merged.sources.map((source) => source.key === "cursor" ? { ...source, detail } : source);
  }
  return merged;
}
