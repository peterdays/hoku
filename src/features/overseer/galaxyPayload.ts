import { assemble, demoSnapshot, rankFronts, type Front, type OverseerRefresh, type SourceReport } from "./adapters";
import { frontsFromGrokAgents, GROK_UNAVAILABLE, type GrokAgentState, type GrokGuess } from "./grokIndex";

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
  });
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
  return {
    demo: true,
    fronts,
    sources: demo.sources.map((source) => source.key === "grok"
      ? { ...source, detail: "Demo. Grok states are guesses on invented bots. The local index was not read." }
      : source),
    grokAgents: [
      { id: "release-notes", name: "Release notes", lastTimestamp: stamp("grok:release-notes"), lastRole: "assistant", state: "probably-waiting" },
      { id: "triage", name: "Triage", lastTimestamp: stamp("grok:triage"), lastRole: "assistant", state: "active" },
    ],
  };
}

export function livePayload(
  raw: OverseerRefresh,
  grok: { available: true; agents: GrokAgentState[]; activeMinutes: number } | { available: false },
): GalaxyPayload {
  const base = assemble({ ...raw, grokText: null, grokError: null, grokNote: "", grokSkipped: true });
  if (!grok.available) {
    return {
      demo: false,
      fronts: base.fronts,
      sources: base.sources.map((source) => source.key === "grok"
        ? { key: "grok", label: "Grok bots", mode: "error", detail: GROK_UNAVAILABLE }
        : source),
      grokAgents: [],
    };
  }
  const bots = frontsFromGrokAgents(grok.agents);
  return {
    demo: false,
    fronts: rankFronts([...base.fronts, ...bots]),
    sources: base.sources.map((source) => source.key === "grok"
      ? {
          key: "grok",
          label: "Grok bots",
          mode: "live",
          detail: `${bots.length} bots. States are guesses from the local index. Active means an assistant message in the last ${grok.activeMinutes} minutes.`,
        }
      : source),
    grokAgents: grok.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      lastTimestamp: agent.lastTimestamp,
      lastRole: agent.lastRole,
      state: agent.state,
    })),
  };
}
