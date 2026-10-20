import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { unit } from "../../lib/hash";
import { HALO, STATE_LABEL, type FrontState } from "./adapters";
import { placeOrbits, type OrbitCluster, type SkyModel } from "./orbits";

export function OrbitCanvas({ clusters, selectedId, onSelect }: { clusters: OrbitCluster[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [open, setOpen] = useState<string[]>([]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const expanded = useMemo(() => new Set(open), [open]);
  const model = useMemo(() => placeOrbits(clusters, size.w, size.h, expanded), [clusters, size.w, size.h, expanded]);
  const toggle = (key: string) => setOpen((list) => list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);
  return (
    <div ref={host} className="absolute inset-0" data-overseer="map">
      <OrbitMap model={model} selectedId={selectedId} onSelect={onSelect} onToggle={toggle} />
    </div>
  );
}

export function OrbitMap({ model, selectedId, onSelect, onToggle }: { model: SkyModel; selectedId: string | null; onSelect: (id: string) => void; onToggle: (key: string) => void }) {
  const stars = useMemo(() => Array.from({ length: 48 }, (_, i) => ({ x: unit(String(i), "sx"), y: unit(String(i), "sy"), o: 0.12 + unit(String(i), "so") * 0.4 })), []);
  const rings = new Map<string, { cx: number; cy: number; r: number }>();
  for (const node of model.nodes) rings.set(`${node.cx}:${node.cy}:${node.ring}`, { cx: node.cx, cy: node.cy, r: node.ring });

  return (
    <>
      <svg className="absolute inset-0 h-full w-full">
        {stars.map((star, i) => (
          <circle key={i} cx={`${star.x * 100}%`} cy={`${star.y * 100}%`} r={i % 9 === 0 ? 1.3 : 0.7} fill="#f1ead8" opacity={star.o} />
        ))}
        {[...rings.values()].map((ring) => (
          <circle key={`${ring.cx}-${ring.cy}-${ring.r}`} cx={ring.cx} cy={ring.cy} r={ring.r} fill="none" stroke="rgb(241 234 216 / 0.08)" />
        ))}
        {model.nodes.map((node) => (
          <line key={`l-${node.key}`} x1={node.cx} y1={node.cy} x2={node.x} y2={node.y} stroke="rgb(241 234 216 / 0.08)" />
        ))}
      </svg>
      {model.cores.map((core) => {
        const body = (
          <>
            <div className="mx-auto h-[7px] w-[7px] rounded-full bg-star" style={{ boxShadow: "0 0 14px #f1ead8" }} />
            <div className="mt-1.5 text-center text-[12.5px] whitespace-nowrap text-star">{core.name}</div>
            {core.hidden > 0 && <div className="text-center text-[10px] whitespace-nowrap text-ink-4" data-hidden={core.hidden}>+{core.hidden} older hidden</div>}
          </>
        );
        const place = { left: core.x, top: core.y, transform: "translate(-50%, -50%)" };
        if (core.href) {
          return (
            <a key={core.key} href={core.href} title={core.name} data-star={`project:${core.key}`} target="_blank" rel="noreferrer" className="absolute" style={place}>
              {body}
            </a>
          );
        }
        return <div key={core.key} className="absolute" style={place} data-star={`project:${core.key}`}>{body}</div>;
      })}
      {model.nodes.map((node) => {
        const on = !!selectedId && node.ids.includes(selectedId);
        const color = HALO[node.state];
        return (
          <a
            key={node.key}
            href={node.href}
            title={node.tooltip}
            data-star={node.ids[0]}
            data-kind={node.kind}
            data-pr={node.prUnknown ? "unknown" : undefined}
            target={node.href.startsWith("http") ? "_blank" : undefined}
            rel="noreferrer"
            onMouseEnter={() => onSelect(node.ids[0])}
            onFocus={() => onSelect(node.ids[0])}
            className="absolute"
            style={{ left: node.x, top: node.y, transform: "translate(-50%, -50%)" }}
          >
            <span
              className={`block h-[18px] w-[18px] rounded-full bg-void ${node.needsYou ? "hoku-need" : ""}`}
              style={{ boxShadow: `0 0 0 ${on ? 2 : 1}px ${color}, 0 0 ${node.needsYou ? 16 : 8}px ${color}${on ? "" : "66"}` }}
            />
            {node.prUnknown && <span className="absolute top-[-10px] left-[14px] text-[11px] text-ink-2">?</span>}
          </a>
        );
      })}
      {model.badges.map((badge) => (
        <button
          key={badge.key}
          type="button"
          data-orbit-more={badge.key}
          title={badge.plus ? `${badge.count} more` : `${badge.count} threads`}
          onClick={() => onToggle(badge.key)}
          className="absolute flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-line bg-void px-1 text-[10px] text-ink-2"
          style={{ left: badge.x, top: badge.y, transform: "translate(-50%, -50%)" }}
        >
          {badge.plus ? `+${badge.count}` : badge.count}
        </button>
      ))}
      {model.nodes.filter((node) => node.float).map((node) => (
        <div key={`t-${node.key}`} className="pointer-events-none absolute max-w-[180px] truncate text-[11px] text-ink-2" style={{ left: node.x + 14, top: node.y - 8 }}>
          {node.float}
        </div>
      ))}
      <div className="absolute bottom-3 left-4 flex gap-3 text-[11px] text-ink-4">
        {(Object.keys(HALO) as FrontState[]).map((state) => (
          <span key={state} className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: HALO[state] }} />
            {STATE_LABEL[state]}
          </span>
        ))}
      </div>
    </>
  );
}
