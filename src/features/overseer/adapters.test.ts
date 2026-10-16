import { describe, expect, it } from "vitest";
import {
  assemble,
  demoSnapshot,
  frontsFromCursor,
  frontsFromGithub,
  frontsFromGrok,
  frontsFromHermes,
  needsYou,
  rankFronts,
  type Front,
  type OverseerRefresh,
} from "./adapters";

const front = (p: Partial<Front> & Pick<Front, "id" | "state" | "updatedAt">): Front => ({
  project: "Lumen",
  kind: "github-pr",
  title: p.id,
  reason: p.state === "needs-you" ? "Review requested" : null,
  url: "https://github.com/hoku-demo/lumen/pull/1",
  source: "github",
  detail: null,
  ...p,
});

describe("rankFronts", () => {
  it("puts needs-you first, longest wait at the top, and newest working above older working", () => {
    const ranked = rankFronts([
      front({ id: "new-work", state: "working", updatedAt: "2026-10-16T00:00:00Z" }),
      front({ id: "old-need", state: "needs-you", updatedAt: "2026-10-15T00:00:00Z" }),
      front({ id: "new-need", state: "needs-you", updatedAt: "2026-10-15T12:00:00Z" }),
      front({ id: "old-work", state: "working", updatedAt: "2026-10-14T00:00:00Z" }),
      front({ id: "blocked", state: "blocked", updatedAt: "2026-10-16T00:00:00Z" }),
      front({ id: "done", state: "done", updatedAt: "2026-10-16T00:00:00Z" }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(["old-need", "new-need", "blocked", "new-work", "old-work", "done"]);
    expect(needsYou(ranked).map((f) => f.id)).toEqual(["old-need", "new-need"]);
  });

  it("breaks ties by id", () => {
    const ranked = rankFronts([
      front({ id: "b", state: "idle", updatedAt: "2026-10-15T00:00:00Z" }),
      front({ id: "a", state: "idle", updatedAt: "2026-10-15T00:00:00Z" }),
    ]);
    expect(ranked.map((f) => f.id)).toEqual(["a", "b"]);
  });
});

describe("cursor adapter", () => {
  const items = [
    { id: "bc-demo-pagination", name: "Fix pagination", status: "ACTIVE", url: "https://cursor.com/agents/bc-demo-pagination", updatedAt: "2026-10-15T01:00:00Z", latestRunId: "run-demo-1" },
    { id: "bc-demo-old", name: "Archived experiment", status: "ARCHIVED", updatedAt: "2026-10-01T00:00:00Z" },
    { id: "bc-demo-types", name: "API types", status: "IDLE", updatedAt: "2026-10-14T00:00:00Z", latestRunId: "run-demo-2" },
    { id: "not a safe id", name: "Dropped", status: "ACTIVE" },
  ];
  const runs = [
    { id: "run-demo-1", agentId: "bc-demo-pagination", status: "RUNNING", updatedAt: "2026-10-15T02:00:00Z", result: "x".repeat(400) },
    {
      id: "run-demo-2",
      agentId: "bc-demo-types",
      status: "ERROR",
      updatedAt: "2026-10-14T03:00:00Z",
      git: { branches: [{ repoUrl: "github.com/hoku-demo/lumen", prUrl: "https://github.com/hoku-demo/lumen/pull/21" }] },
    },
    ];

  it("maps run status, drops archived and unsafe ids, and clips the result", () => {
    const fronts = frontsFromCursor(items, runs);
    const live = fronts.find((f) => f.id === "cursor:bc-demo-pagination");
    const failed = fronts.find((f) => f.id === "cursor:bc-demo-types");
    expect(fronts.map((f) => f.id).sort()).toEqual(["cursor:bc-demo-pagination", "cursor:bc-demo-types"]);
    expect(live).toMatchObject({ state: "working", project: "Unassigned", reason: "Run in progress" });
    expect(live?.detail?.length).toBeLessThanOrEqual(160);
    expect(failed).toMatchObject({ state: "blocked", project: "lumen", reason: "Run failed" });
    expect(failed?.detail).toContain("pull/21");
  });

  it("says so when a run status is not one Cursor documents", () => {
    const fronts = frontsFromCursor(
      [{ id: "bc-demo-odd", name: "Odd", status: "ACTIVE", latestRunId: "run-demo-8" }],
      [{ agentId: "bc-demo-odd", status: "WEIRD" }],
    );
    expect(fronts[0].state).toBe("idle");
    expect(fronts[0].reason).toContain("Unrecognised");
  });

  it("does not treat a finished turn as needs-you", () => {
    const fronts = frontsFromCursor(
      [{ id: "bc-demo-done", name: "Done work", status: "IDLE", latestRunId: "run-demo-9" }],
      [{ id: "run-demo-9", agentId: "bc-demo-done", status: "FINISHED", result: "Shipped the notes." }],
    );
    expect(fronts[0].state).toBe("done");
    expect(needsYou(fronts)).toEqual([]);
  });
});

describe("github adapter", () => {
  const pr = (n: number, title: string) => ({
    title,
    html_url: `https://github.com/hoku-demo/lumen/pull/${n}`,
    updated_at: "2026-10-15T00:00:00Z",
    repository_url: "https://api.github.com/repos/hoku-demo/lumen",
    draft: n === 3,
  });

  it("lets a review request beat authorship, and keeps failing checks blocked", () => {
    const fronts = frontsFromGithub({
      githubReview: [pr(18, "Pagination fix")],
      githubChanges: [pr(19, "Rename fields")],
      githubFailing: [pr(21, "Types migration"), pr(18, "Pagination fix")],
      githubAuthored: [pr(18, "Pagination fix"), pr(3, "Draft notes"), pr(21, "Types migration")],
      githubIssues: [{ title: "Document the feed", html_url: "https://github.com/hoku-demo/kepler/issues/7", updated_at: "2026-10-10T00:00:00Z", repository_url: "https://api.github.com/repos/hoku-demo/kepler" }],
    });
    const byUrl = Object.fromEntries(fronts.map((f) => [f.url, f]));
    expect(byUrl["https://github.com/hoku-demo/lumen/pull/18"].state).toBe("needs-you");
    expect(byUrl["https://github.com/hoku-demo/lumen/pull/18"].reason).toBe("Review requested");
    expect(byUrl["https://github.com/hoku-demo/lumen/pull/19"].reason).toBe("Changes requested");
    expect(byUrl["https://github.com/hoku-demo/lumen/pull/21"]).toMatchObject({ state: "blocked", project: "lumen" });
    expect(byUrl["https://github.com/hoku-demo/lumen/pull/3"].reason).toBe("Draft pull request");
    expect(byUrl["https://github.com/hoku-demo/kepler/issues/7"]).toMatchObject({ kind: "github-issue", state: "needs-you", project: "kepler" });
  });

  it("drops items that are not https://github.com links", () => {
    expect(frontsFromGithub({ githubReview: [{ title: "x", html_url: "file:///tmp/x" }], githubChanges: [], githubFailing: [], githubAuthored: [], githubIssues: [] })).toEqual([]);
  });
});

describe("hermes adapter", () => {
  it("maps approval and clarify onto needs-you and leaves quiet sessions idle", () => {
    const fronts = frontsFromHermes(
      {
        sessions: [
          { id: "demo-schema", title: "Clarify the schema", is_active: true, status: "waiting_for_clarify", last_active: 1_760_000_000, preview: "Which field?" },
          { id: "demo-index", title: "Nightly index", is_active: false, ended_at: "2026-10-14T00:00:00Z", source: "cli" },
        ],
      },
      "http://127.0.0.1:9119",
    );
    expect(fronts[0]).toMatchObject({ state: "needs-you", reason: "Waiting on a clarification", url: "http://127.0.0.1:9119/", detail: "Which field?" });
    expect(fronts[1]).toMatchObject({ state: "idle", project: "cli", url: "http://127.0.0.1:9119/" });
  });

  it("drops the jump link when the dashboard origin is not loopback", () => {
    const fronts = frontsFromHermes([{ id: "demo-schema", title: "X", is_active: false }], "https://example.com");
    expect(fronts[0].url).toBe("");
  });
});

describe("grok feed", () => {
  it("reads jsonl, skips bad lines, and refuses a needs-you entry with no reason", () => {
    const text = [
      JSON.stringify({ id: "release", name: "Release notes", project: "Northwind", state: "needs-you", reason: "Which version?", updatedAt: "2026-10-15T00:00:00Z", url: "https://grok.com/chat/demo-release-notes" }),
      "not json",
      JSON.stringify({ id: "nope", name: "Missing reason", state: "needs-you" }),
      JSON.stringify({ id: "odd", name: "Elsewhere", state: "idle", url: "https://evil.example/phish" }),
    ].join("\n");
    const { fronts, skipped } = frontsFromGrok(text);
    expect(skipped).toBe(2);
    expect(fronts.map((f) => f.id)).toEqual(["grok:release", "grok:odd"]);
    expect(fronts[1].url).toBe("");
    expect(fronts[0].state).toBe("needs-you");
  });
});

describe("assemble and demo", () => {
  it("reports an absent hermes without inventing fronts", () => {
    const raw = emptyRefresh();
    raw.hermesError = "Hermes dashboard is not running.";
    raw.hermesNote = "not running";
    raw.cursorSkipped = true;
    raw.githubSkipped = true;
    raw.grokError = "The Grok feed file is not there yet.";
    const snap = assemble(raw);
    expect(snap.fronts).toEqual([]);
    expect(snap.sources.map((s) => s.mode)).toEqual(["off", "off", "absent", "absent"]);
  });

  it("demo data covers every kind, ranks needs-you, and contains no secrets", () => {
    const demo = demoSnapshot();
    expect(new Set(demo.fronts.map((f) => f.kind))).toEqual(new Set(["grok-bot", "cloud-agent", "github-pr", "github-issue", "hermes"]));
    expect(demo.fronts[0].state).toBe("needs-you");
    expect(demo.sources.every((s) => s.mode === "fixture")).toBe(true);
    const blob = JSON.stringify(demo);
    expect(blob).not.toMatch(/ghp_|github_pat_|sk-|AKIA|eyJ|@/);
  });
});

function emptyRefresh(): OverseerRefresh {
  return {
    cursorItems: [],
    cursorRuns: [],
    cursorError: null,
    cursorSkipped: false,
    githubReview: [],
    githubChanges: [],
    githubFailing: [],
    githubAuthored: [],
    githubIssues: [],
    githubError: null,
    githubSkipped: false,
    hermesSessions: null,
    hermesError: null,
    hermesNote: "",
    hermesSkipped: false,
    hermesDashboard: "http://127.0.0.1:9119",
    grokText: null,
    grokError: null,
    grokNote: "",
    grokSkipped: false,
  };
}
