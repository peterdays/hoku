import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMinuteClock } from "../../app/useClock";
import { api, type OverseerPublicConfig } from "../../lib/api";
import { unit } from "../../lib/hash";
import { relativeTime } from "../../lib/time";
import {
  assemble,
  demoSnapshot,
  disconnectedSnapshot,
  HALO,
  KIND_LABEL,
  needsYou,
  STATE_LABEL,
  type Front,
  type FrontKind,
  type FrontState,
  type SourceKey,
  type SourceReport,
} from "./adapters";
import type { GalaxyPayload, GrokPublic } from "./galaxyPayload";
import { GROK_UNAVAILABLE } from "./grokIndex";
import { OrbitCanvas } from "./OrbitMap";
import { findStar, MENTION_TIP, starFront, type OrbitCluster } from "./orbits";

interface Model {
  demo: boolean;
  fronts: Front[];
  sources: SourceReport[];
  connected: boolean;
  config: OverseerPublicConfig | null;
  grokAgents: GrokPublic[];
  orbits: OrbitCluster[];
}

interface Form {
  demo: boolean;
  cursorOn: boolean;
  githubOn: boolean;
  hermesOn: boolean;
  grokOn: boolean;
  hermesDashboard: string;
  hermesApi: string;
  grokFeed: string;
  cursorKey: string;
  githubToken: string;
  hermesKey: string;
  clearCursorKey: boolean;
  clearGithubToken: boolean;
  clearHermesKey: boolean;
}

const EMPTY_FORM: Form = {
  demo: true,
  cursorOn: true,
  githubOn: true,
  hermesOn: true,
  grokOn: true,
  hermesDashboard: "http://127.0.0.1:9119",
  hermesApi: "http://127.0.0.1:8642",
  grokFeed: "",
  cursorKey: "",
  githubToken: "",
  hermesKey: "",
  clearCursorKey: false,
  clearGithubToken: false,
  clearHermesKey: false,
};

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const RINGS: Record<FrontKind, number> = { "grok-bot": 64, "cloud-agent": 96, hermes: 128, "github-pr": 160, "github-issue": 188 };

function layout(fronts: Front[], w: number, h: number) {
  const names = [...new Set(fronts.map((f) => f.project))];
  const cx = w / 2;
  const cy = h / 2 + 8;
  const rx = Math.max(140, Math.min(w * 0.28, 320));
  const ry = Math.max(100, Math.min(h * 0.26, 220));
  const scale = Math.min(1, Math.min(w, h) / 860);
  const cores = names.map((name, i) => {
    const a = -Math.PI / 2 + (Math.PI * 2 * i) / Math.max(names.length, 1);
    return { name, x: cx + Math.cos(a) * (names.length === 1 ? 0 : rx), y: cy + Math.sin(a) * (names.length === 1 ? 0 : ry) };
  });
  const nodes: { f: Front; x: number; y: number; ring: number; cx: number; cy: number }[] = [];
  for (const core of cores) {
    const groups = new Map<FrontKind, Front[]>();
    for (const f of fronts.filter((x) => x.project === core.name)) {
      const list = groups.get(f.kind) ?? [];
      list.push(f);
      groups.set(f.kind, list);
    }
    for (const [kind, list] of groups) {
      const base = unit(`${core.name}:${kind}`) * Math.PI * 2;
      const ring = RINGS[kind] * scale;
      list.forEach((f, i) => {
        const spread = Math.min(0.85, 4 / list.length);
        const a = base + (i - (list.length - 1) / 2) * spread;
        nodes.push({ f, x: core.x + Math.cos(a) * ring, y: core.y + Math.sin(a) * ring, ring, cx: core.x, cy: core.y });
      });
    }
  }
  return { cores, nodes };
}

export function OverseerView({ web = false }: { web?: boolean }) {
  const now = useMinuteClock();
  const [model, setModel] = useState<Model | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    if (web) {
      const res = await fetch("/api/galaxy");
      if (!res.ok) throw new Error("The galaxy could not be read.");
      const payload: unknown = await res.json();
      if (!isGalaxyPayload(payload)) throw new Error("The galaxy could not be read.");
      setModel({ demo: payload.demo, fronts: payload.fronts, sources: payload.sources, grokAgents: payload.grokAgents, orbits: payload.orbits ?? [], connected: true, config: null });
      return;
    }
    if (!inTauri()) {
      setModel({ ...demoSnapshot(), connected: false, config: null, grokAgents: [], orbits: [] });
      return;
    }
    const config = await api.overseerConfig();
    setForm((f) => ({ ...f, ...formFrom(config), cursorKey: "", githubToken: "", hermesKey: "" }));
    if (config.demo) {
      setModel({ ...demoSnapshot(), connected: true, config, grokAgents: [], orbits: [] });
      return;
    }
    const raw = await api.overseerRefresh();
    setModel({ ...assemble(raw), demo: false, connected: true, config, grokAgents: [], orbits: [] });
  };

  useEffect(() => {
    let stop = false;
    const run = () => {
      void refresh().catch((e: unknown) => {
        if (stop) return;
        const message = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : "Sources could not be read.";
        if (web) {
          const fail = (key: SourceKey, label: string): SourceReport => ({ key, label, mode: "error", detail: "The galaxy could not be read." });
          setModel({
            demo: false,
            fronts: [],
            connected: false,
            config: null,
            grokAgents: [],
            orbits: [],
            sources: [fail("cursor", "Cursor cloud agents"), fail("github", "GitHub"), fail("hermes", "Hermes"), fail("grok", "Grok bots")],
          });
          return;
        }
        if (!inTauri()) {
          setModel({ ...demoSnapshot(), connected: false, config: null, grokAgents: [], orbits: [] });
          return;
        }
        const fail = (key: SourceKey, label: string): SourceReport => ({ key, label, mode: "error", detail: message });
        setModel({
          demo: false,
          fronts: [],
          connected: true,
          config: null,
          grokAgents: [],
          orbits: [],
          sources: [fail("cursor", "Cursor cloud agents"), fail("github", "GitHub"), fail("hermes", "Hermes"), fail("grok", "Grok bots")],
        });
      });
    };
    run();
    if (!web) return;
    const timer = setInterval(run, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
    // First paint only. The desktop refresh stays explicit. The web view polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [web]);

  const fronts = model?.fronts ?? [];
  const orbits = model?.orbits ?? [];
  const waiting = needsYou(fronts);
  const picked = findStar(orbits, selectedId ?? "");
  const listed = fronts.find((f) => f.id === selectedId) ?? null;
  const selected = picked ? (listed ? { ...listed, project: picked.project } : starFront(picked.star, picked.project)) : listed;
  const lastRole = selected ? model?.grokAgents.find((agent) => selected.id === `grok:${agent.id}`)?.lastRole ?? null : null;
  const grokDown = !!model?.sources.some((source) => source.key === "grok" && source.detail === GROK_UNAVAILABLE);

  const save = async () => {
    setNote(null);
    if (!inTauri()) {
      setModel(form.demo ? { ...demoSnapshot(), connected: false, config: null, grokAgents: [], orbits: [] } : { ...disconnectedSnapshot(), connected: false, config: null, grokAgents: [], orbits: [] });
      setNote("This preview does not store tokens or call the network.");
      setSourcesOpen(false);
      return;
    }
    const config = await api.overseerSave(form);
    setForm((f) => ({ ...f, ...formFrom(config), cursorKey: "", githubToken: "", hermesKey: "", clearCursorKey: false, clearGithubToken: false, clearHermesKey: false }));
    setNote("Saved on this machine.");
    await refresh();
  };

  return (
    <div className="absolute inset-0 flex bg-void">
      <Inbox fronts={fronts} waiting={waiting} selectedId={selectedId} now={now} onSelect={setSelectedId} web={web} sources={model?.sources ?? []} />
      <div className="relative min-w-0 flex-1">
        {web ? <OrbitCanvas clusters={orbits} selectedId={selectedId} onSelect={setSelectedId} /> : <Sky fronts={fronts} selectedId={selectedId} onSelect={setSelectedId} />}
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
          {model?.demo && <span className="rounded-full border border-line px-2 py-1 text-[11px] text-ink-3">Demo data</span>}
          {!web && <button className="btn" onClick={() => void refresh().catch(() => setNote("Could not refresh."))}>Refresh</button>}
          {!web && <button className="btn" onClick={() => setSourcesOpen(true)}>Sources</button>}
        </div>
        {!model && <div className="absolute bottom-4 left-4 text-[12px] text-ink-3">{web ? "Reading the galaxy…" : "Reading sources…"}</div>}
        {model && fronts.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-3" data-galaxy={grokDown ? "grok-unavailable" : undefined}>
            {grokDown ? GROK_UNAVAILABLE : "No fronts yet."}
          </div>
        )}
        {grokDown && fronts.length > 0 && (
          <div className="absolute top-3 left-4 z-10 rounded-full border border-line bg-ground/90 px-3 py-1 text-[12px] text-ink-2" data-galaxy="grok-unavailable">{GROK_UNAVAILABLE}</div>
        )}
      </div>
      {selected && <Detail front={selected} demo={!!model?.demo} web={web} lastRole={lastRole} mention={!!picked?.star.guess} onClose={() => setSelectedId(null)} />}
      {!web && sourcesOpen && (
        <Sources
          form={form}
          setForm={setForm}
          config={model?.config ?? null}
          sources={model?.sources ?? []}
          note={note}
          onClose={() => setSourcesOpen(false)}
          onSave={() => void save().catch(() => setNote("Could not save settings."))}
        />
      )}
    </div>
  );
}

function Inbox({ fronts, waiting, selectedId, now, onSelect, web = false, sources = [] }: { fronts: Front[]; waiting: Front[]; selectedId: string | null; now: number; onSelect: (id: string) => void; web?: boolean; sources?: SourceReport[] }) {
  const counts = countStates(fronts);
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-ground/90" data-overseer="inbox">
      <div className="px-4 pt-[18px] pb-2">
        <div className="eyebrow">Needs you</div>
        <div className="mt-1 text-[28px] leading-none font-medium tracking-tight text-ink" data-galaxy="needs-you">{waiting.length}</div>
        <p className="mt-1 text-[12px] text-ink-3">{waiting.length ? "Longest wait first." : "Nothing is waiting on you."}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {waiting.map((f) => (
          <button
            key={f.id}
            onClick={() => onSelect(f.id)}
            className={`mb-1 w-full rounded-[10px] px-2.5 py-2 text-left ${selectedId === f.id ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"}`}
          >
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: HALO["needs-you"], boxShadow: `0 0 8px ${HALO["needs-you"]}` }} />
              <span className="truncate text-[13px] text-ink">{f.title}</span>
              <span className="ml-auto shrink-0 text-[11px] text-ink-4">{relativeTime(f.updatedAt, now)}</span>
            </div>
            <div className="mt-0.5 truncate pl-3.5 text-[11.5px] text-ink-3">{f.project} · {KIND_LABEL[f.kind]}</div>
            <div className="mt-0.5 line-clamp-2 pl-3.5 text-[12.5px] text-ink-2">{f.reason}</div>
          </button>
        ))}
      </div>
      <div className="border-t border-line px-4 py-2.5 text-[11px] text-ink-4">
        {counts}
        {web && sources.filter((source) => source.mode !== "fixture").map((source) => (
          <div key={source.key} className="mt-1 text-ink-3" data-galaxy={source.detail === GROK_UNAVAILABLE ? "grok-unavailable" : undefined}>{source.label}: {source.detail}</div>
        ))}
      </div>
    </aside>
  );
}

function Sky({ fronts, selectedId, onSelect, web = false }: { fronts: Front[]; selectedId: string | null; onSelect: (id: string) => void; web?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { cores, nodes } = useMemo(() => layout(fronts, size.w, size.h), [fronts, size]);
  const stars = useMemo(() => Array.from({ length: 48 }, (_, i) => ({ x: unit(String(i), "sx"), y: unit(String(i), "sy"), o: 0.12 + unit(String(i), "so") * 0.4 })), []);
  const rings = new Map<string, { cx: number; cy: number; r: number }>();
  for (const n of nodes) rings.set(`${n.cx}:${n.cy}:${n.ring}`, { cx: n.cx, cy: n.cy, r: n.ring });

  return (
    <div ref={host} className="absolute inset-0" data-overseer="map">
      <svg className="absolute inset-0 h-full w-full">
        {stars.map((s, i) => (
          <circle key={i} cx={s.x * size.w} cy={s.y * size.h} r={i % 9 === 0 ? 1.3 : 0.7} fill="#f1ead8" opacity={s.o} />
        ))}
        {[...rings.values()].map((r) => (
          <circle key={`${r.cx}-${r.r}`} cx={r.cx} cy={r.cy} r={r.r} fill="none" stroke="rgb(241 234 216 / 0.08)" />
        ))}
        {nodes.map((n) => (
          <line key={`l-${n.f.id}`} x1={n.cx} y1={n.cy} x2={n.x} y2={n.y} stroke="rgb(241 234 216 / 0.08)" />
        ))}
      </svg>
      {cores.map((c) => (
        <div key={c.name} className="absolute" style={{ left: c.x, top: c.y, transform: "translate(-50%, -50%)" }}>
          <div className="mx-auto h-[7px] w-[7px] rounded-full bg-star" style={{ boxShadow: "0 0 14px #f1ead8" }} />
          <div className="mt-1.5 text-center text-[12.5px] whitespace-nowrap text-star">{c.name}</div>
        </div>
      ))}
      {nodes.map((n) => {
        const on = n.f.id === selectedId;
        const color = HALO[n.f.state];
        const label = web && n.f.reason ? `${n.f.title} — ${n.f.reason}` : `${n.f.title} — ${STATE_LABEL[n.f.state]}`;
        const dot = (
          <span
            className={`block h-[18px] w-[18px] rounded-full bg-void ${n.f.state === "needs-you" ? "hoku-need" : ""}`}
            style={{ boxShadow: `0 0 0 ${on ? 2 : 1}px ${color}, 0 0 ${n.f.state === "needs-you" ? 16 : 8}px ${color}${on ? "" : "66"}` }}
          />
        );
        const place = { left: n.x, top: n.y, transform: "translate(-50%, -50%)" };
        if (web && n.f.url) {
          return (
            <a
              key={n.f.id}
              href={n.f.url}
              title={label}
              data-star={n.f.id}
              target={n.f.url.startsWith("http") ? "_blank" : undefined}
              rel="noreferrer"
              onMouseEnter={() => onSelect(n.f.id)}
              onFocus={() => onSelect(n.f.id)}
              className="absolute"
              style={place}
            >
              {dot}
            </a>
          );
        }
        return (
          <button
            key={n.f.id}
            title={label}
            onClick={() => onSelect(n.f.id)}
            className="absolute"
            style={place}
          >
            {dot}
          </button>
        );
      })}
      {nodes.filter((n) => n.f.state === "needs-you" || n.f.id === selectedId).map((n) => (
        <div key={`t-${n.f.id}`} className="pointer-events-none absolute max-w-[180px] truncate text-[11px] text-ink-2" style={{ left: n.x + 14, top: n.y - 8 }}>
          {n.f.title}{web && n.f.reason?.startsWith("~") ? ` · ${n.f.reason}` : ""}
        </div>
      ))}
      <div className="absolute bottom-3 left-4 flex gap-3 text-[11px] text-ink-4">
        {(Object.keys(HALO) as FrontState[]).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: HALO[s] }} />
            {STATE_LABEL[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

function Detail({ front, demo, onClose, web = false, lastRole = null, mention = false }: { front: Front; demo: boolean; onClose: () => void; web?: boolean; lastRole?: "user" | "assistant" | null; mention?: boolean }) {
  const guess = web && front.source === "grok";
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-panel" data-overseer="detail">
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div>
          <div className="eyebrow">{KIND_LABEL[front.kind]}</div>
          <h2 className="mt-1 text-[16px] leading-snug font-medium text-ink">{front.title}</h2>
        </div>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <div className="mt-3 flex items-center gap-2 px-4">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: HALO[front.state] }} />
        <span className="text-[12.5px] text-ink-2">{guess && front.reason ? front.reason : STATE_LABEL[front.state]}</span>
        <span className="text-[12px] text-ink-4">{front.project}</span>
      </div>
      {front.reason && <p className="mt-3 px-4 text-[13.5px] text-ink" data-galaxy={guess ? "guess" : undefined}>{front.reason}</p>}
      {front.detail && <p className="mt-2 px-4 text-[12.5px] text-ink-3">{front.detail}</p>}
      {guess && (
        <p className="mt-2 px-4 text-[12px] text-ink-3">
          Guess{lastRole ? ` · last message from ${lastRole === "user" ? "you" : "the bot"}` : ""}. The index has no turn or approval data.
        </p>
      )}
      {mention && <p className="mt-2 px-4 text-[12px] text-ink-3">{MENTION_TIP}.</p>}
      <div className="mt-4 px-4 text-[11.5px] text-ink-4">{relativeTime(front.updatedAt)} · {front.source}</div>
      {demo && <p className="mt-3 px-4 text-[12px] text-ink-3">Sample front. The link is invented and opens nowhere real.</p>}
      <div className="mt-auto border-t border-line p-4">
        {web ? (
          front.url ? <a className="btn btn-primary" href={front.url} target={front.url.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{jumpLabel(front.kind)}</a> : null
        ) : (
          <button className="btn btn-primary" disabled={!front.url} onClick={() => void jump(front)}>{jumpLabel(front.kind)}</button>
        )}
        {front.url ? <div className="mt-2 break-all font-mono text-[11px] text-ink-4">{front.url}</div> : <div className="mt-2 text-[12px] text-ink-3">No jump link for this front.</div>}
      </div>
    </aside>
  );
}

function Sources({ form, setForm, config, sources, note, onClose, onSave }: { form: Form; setForm: (f: Form) => void; config: OverseerPublicConfig | null; sources: SourceReport[]; note: string | null; onClose: () => void; onSave: () => void }) {
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const report = (key: SourceKey) => sources.find((s) => s.key === key);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/55 p-6" data-overseer="sources">
      <div className="max-h-full w-[460px] overflow-auto rounded-xl border border-line-strong bg-raised p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <div className="eyebrow">Sources</div>
            <h2 className="mt-1 text-[15px] text-ink">What Hoku is allowed to read</h2>
          </div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <p className="mt-2 text-[12px] text-ink-3">Read-only. Hoku never posts, approves, or comments. Tokens stay in this app’s data folder.</p>
        <label className="mt-3 flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={form.demo} onChange={(e) => set({ demo: e.target.checked })} />
          Demo data
        </label>
        <p className="mt-1 text-[12px] text-ink-3">On, the map shows invented fronts and does not contact Cursor, GitHub, or Hermes.</p>
        <SourceBlock title="Cursor cloud agents" on={form.cursorOn} onToggle={(v) => set({ cursorOn: v })} report={report("cursor")} hint={config?.cursorConfigured ? "A key is available." : "Or set CURSOR_API_KEY."}>
          <input className="field" type="password" autoComplete="off" placeholder="API key" value={form.cursorKey} onChange={(e) => set({ cursorKey: e.target.value, clearCursorKey: false })} />
          <button className="btn mt-1" onClick={() => set({ clearCursorKey: true, cursorKey: "" })}>Clear saved key</button>
        </SourceBlock>
        <SourceBlock title="GitHub" on={form.githubOn} onToggle={(v) => set({ githubOn: v })} report={report("github")} hint={config?.githubConfigured ? "A token is available." : "Or set GITHUB_TOKEN."}>
          <input className="field" type="password" autoComplete="off" placeholder="Token (repo and read:org if you use org repos)" value={form.githubToken} onChange={(e) => set({ githubToken: e.target.value, clearGithubToken: false })} />
          <button className="btn mt-1" onClick={() => set({ clearGithubToken: true, githubToken: "" })}>Clear saved token</button>
        </SourceBlock>
        <SourceBlock title="Hermes" on={form.hermesOn} onToggle={(v) => set({ hermesOn: v })} report={report("hermes")} hint={config?.hermesConfigured ? "An API key is saved." : "Dashboard status is public. Sessions may require a login Hoku will not perform."}>
          <input className="field" placeholder="Dashboard" value={form.hermesDashboard} onChange={(e) => set({ hermesDashboard: e.target.value })} />
          <input className="field mt-1" placeholder="API server" value={form.hermesApi} onChange={(e) => set({ hermesApi: e.target.value })} />
          <input className="field mt-1" type="password" autoComplete="off" placeholder="API server key (optional)" value={form.hermesKey} onChange={(e) => set({ hermesKey: e.target.value, clearHermesKey: false })} />
        </SourceBlock>
        <SourceBlock title="Grok bots" on={form.grokOn} onToggle={(v) => set({ grokOn: v })} report={report("grok")} hint="No public list API. A local JSONL feed the bots write. See docs/overseer.md.">
          <input className="field" placeholder="Feed path (empty uses the data folder / grok-bots.jsonl)" value={form.grokFeed} onChange={(e) => set({ grokFeed: e.target.value })} />
        </SourceBlock>
        {note && <p className="mt-3 text-[12px] text-ink-2">{note}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

function SourceBlock({ title, on, onToggle, report, hint, children }: { title: string; on: boolean; onToggle: (v: boolean) => void; report?: SourceReport; hint: string; children: ReactNode }) {
  return (
    <section className="mt-3 rounded-[10px] border border-line p-3">
      <label className="flex items-center gap-2 text-[13px] text-ink">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        {title}
      </label>
      {report && <div className="mt-1 text-[11.5px] text-ink-3">{report.mode} — {report.detail}</div>}
      <p className="mt-1 text-[11.5px] text-ink-4">{hint}</p>
      {on && <div className="mt-2">{children}</div>}
    </section>
  );
}

function countStates(fronts: Front[]): string {
  const order: FrontState[] = ["working", "blocked", "idle", "done"];
  const parts = order.map((s) => {
    const n = fronts.filter((f) => f.state === s).length;
    return n ? `${n} ${STATE_LABEL[s].toLowerCase()}` : "";
  }).filter(Boolean);
  return parts.join(" · ") || "No other fronts";
}

function jumpLabel(kind: FrontKind): string {
  if (kind === "grok-bot") return "Open the bot";
  if (kind === "cloud-agent") return "Open in Cursor";
  if (kind === "hermes") return "Open Hermes";
  return "Open on GitHub";
}

async function jump(front: Front) {
  if (!front.url) return;
  if (inTauri()) {
    await api.overseerOpen(front.url, front.kind);
    return;
  }
  window.open(front.url, "_blank", "noopener,noreferrer");
}

function isGalaxyPayload(value: unknown): value is GalaxyPayload {
  if (!value || typeof value !== "object") return false;
  const row = value as GalaxyPayload;
  return typeof row.demo === "boolean" && Array.isArray(row.fronts) && Array.isArray(row.sources) && Array.isArray(row.grokAgents) && Array.isArray(row.orbits);
}

function formFrom(config: OverseerPublicConfig): Pick<Form, "demo" | "cursorOn" | "githubOn" | "hermesOn" | "grokOn" | "hermesDashboard" | "hermesApi" | "grokFeed"> {
  return {
    demo: config.demo,
    cursorOn: config.cursorOn,
    githubOn: config.githubOn,
    hermesOn: config.hermesOn,
    grokOn: config.grokOn,
    hermesDashboard: config.hermesDashboard,
    hermesApi: config.hermesApi,
    grokFeed: config.grokFeed,
  };
}
