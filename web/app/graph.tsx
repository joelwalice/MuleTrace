"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Core, ElementDefinition, EventObject, LayoutOptions, StylesheetJson } from "cytoscape";
import { flowLayout, minutes, type Flow } from "./flow";
import { clock, inr, reducedMotion, riskBand, when, type Graph } from "./lib";

export const ROLE_TEXT: Record<string, string> = {
  subject: "Alerted account", source: "Source: review before freezing", member: "Part of the ring",
  upstream: "Sent money in", downstream: "Received money", lateral: "Shares a device", device: "Shared device",
};
const COLUMN_TEXT = { sources: "Sources", hop: "Hop", exits: "Exits" } as const;

// Colours come from the theme tokens. Accounts are squares sized by the money through them; devices are diamonds.
function sheet(): StylesheetJson {
  const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const [bg, panel, ink, ink2, muted, red, edge, lineHi, amber] = ["--bg", "--panel", "--ink", "--ink-2", "--muted", "--red", "--edge", "--line-hi", "--amber"].map(v);
  const am = amber || ink2;  // falls back to grey if the theme has no --amber; the dashes carry the meaning either way
  const mono = `${v("--font-plex-mono") || "ui-monospace"}, ui-monospace, monospace`;
  return [
    { selector: "node", style: {
      shape: "round-rectangle", label: "data(label)", color: ink2, "font-size": 12.5, "font-weight": 500, "font-family": mono,
      "text-valign": "bottom", "text-margin-y": 7, "text-wrap": "wrap", "text-outline-color": panel, "text-outline-width": 4,
      width: "data(size)", height: "data(size)", "border-width": 1, "border-color": lineHi,
      "transition-property": "background-color, opacity, border-color", "transition-duration": 220,
    } },
    ...[0, 1, 2, 3].map((b) => ({ selector: `node[band = ${b}]`, style: { "background-color": v(`--risk-${b}`) } })),
    { selector: "node[role='subject']", style: { "border-width": 2.5, "border-color": red, color: ink } },
    { selector: "node[role='source']", style: { "border-width": 1.5, "border-color": ink2, "border-style": "dashed" } },
    { selector: "node[role='device']", style: { shape: "diamond", "background-color": ink2, width: 16, height: 16, color: ink2, "font-size": 11.5 } },
    { selector: "node[?frozen]", style: { "background-color": panel, "border-width": 3, "border-color": ink, "border-style": "double", color: ink } },
    { selector: "node[role='axis']", style: {
      shape: "rectangle", width: 1, height: 1, "background-opacity": 0, "border-width": 0, events: "no",
      label: "data(label)", "text-valign": "center", "text-halign": "center", "text-wrap": "wrap", color: muted,
      "font-size": 11.5, "font-weight": 600, "text-outline-width": 0, "text-background-color": bg, "text-background-opacity": 1,
      "text-background-padding": "5px", "text-background-shape": "roundrectangle", "text-border-width": 1, "text-border-color": lineHi, "text-border-opacity": 1,
    } },
    { selector: "node.fresh", style: { "outline-width": 2, "outline-color": red, "outline-offset": 4 } },
    { selector: "node.picked", style: { "outline-width": 2, "outline-color": ink, "outline-offset": 5, color: ink } },
    { selector: "edge", style: {
      width: "data(w)", "line-color": edge, "target-arrow-color": edge, "target-arrow-shape": "triangle", "arrow-scale": 0.9,
      "curve-style": "bezier", "control-point-step-size": 28, opacity: 0.95,
      "font-family": mono, "font-size": 11.5, "font-weight": 600, color: ink, "text-rotation": "none",
      "text-background-color": bg, "text-background-opacity": 1, "text-background-padding": "2px",
      "transition-property": "line-color, opacity", "transition-duration": 220,
    } },
    { selector: "edge.labeled, edge.focus", style: { label: "data(dlabel)" } },
    { selector: "edge.focus", style: { "line-color": ink, "target-arrow-color": ink, opacity: 1, "z-index": 20 } },
    { selector: "edge.flow", style: { "line-color": red, "target-arrow-color": red, opacity: 1, "z-index": 30, label: "data(dlabel)" } },
    { selector: "edge.cite", style: { "line-color": ink, "target-arrow-color": ink, opacity: 1, "z-index": 25, label: "data(dlabel)", width: 4 } },
    { selector: "node.cite", style: { "outline-width": 2, "outline-color": ink, "outline-offset": 4, color: ink } },
    { selector: "edge.fresh", style: { "line-color": red, "target-arrow-color": red, opacity: 1 } },
    { selector: "edge[kind='shared_device']", style: { "line-style": "dashed", "target-arrow-shape": "none", width: 1, "line-color": muted, opacity: 0.55, "curve-style": "straight" } },
    { selector: "edge[kind='suspected']", style: { "line-style": "dashed", "line-dash-pattern": [6, 4], width: 2, "line-color": am, "target-arrow-color": am,
        "target-arrow-shape": "triangle", opacity: 0.9, label: "data(dlabel)", color: am } },
    { selector: ".dim", style: { opacity: 0.12 } },
    { selector: "node[role='axis'].dim", style: { opacity: 0.4 } },
  ];
}

type Tip = { x: number; y: number; value: string; unit: string; lines: string[] };
type Step = { i: number; n: number; text: string } | null;

/* `cite`: transaction or account ids the Evidence panel points at; they stay lit, everything else dims. */
export default function MoneyGraph({ graph, onNode, cite }: { graph: Graph | null; onNode: (id: string) => void; cite?: string[] }) {
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const onNodeRef = useRef(onNode);
  const flowTimer = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const frame = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [broken, setBroken] = useState(false);
  const [step, setStep] = useState<Step>(null);
  useEffect(() => { onNodeRef.current = onNode; }, [onNode]);

  const fit = useCallback(() => {
    const c = cy.current;
    if (!c || c.elements().empty()) return;
    c.fit(undefined, 56);
    if (c.zoom() > 1.35) { c.zoom(1.35); c.center(); }  // small rings shouldn't fill the screen
  }, []);

  const stopFlow = useCallback(() => {
    if (flowTimer.current) clearInterval(flowTimer.current);
    flowTimer.current = null;
    cy.current?.elements().removeClass("dim flow");
    setStep(null);
  }, []);

  useEffect(() => {
    let dead = false;
    const cleanups: (() => void)[] = [];
    import("cytoscape").then(({ default: cytoscape }) => {
      if (dead || !box.current) return;
      const c = cytoscape({ container: box.current, style: sheet(), minZoom: 0.2, maxZoom: 3, boxSelectionEnabled: false });
      const accounts = "node[role != 'device'][role != 'axis']";
      c.on("tap", accounts, (e) => { c.nodes().removeClass("picked"); e.target.addClass("picked"); onNodeRef.current(e.target.id()); });
      // Hover traces the whole path through an account: everything upstream and downstream stays lit.
      c.on("mouseover", "node[role != 'axis']", (e: EventObject) => {
        if (flowTimer.current) return;
        const n = e.target, p = n.renderedPosition(), d = n.data();
        const susp = c.edges("[kind='suspected']"); susp.remove();  // "follow the money" must never run through an inference
        const path = n.predecessors().union(n.successors()).union(n);
        susp.restore();
        c.elements().not(path).not("node[role='axis']").addClass("dim");
        path.edges("[kind='money']").addClass("focus");
        setTip(d.role === "device"
          ? { x: p.x, y: p.y, value: d.id, unit: "", lines: [`Used by ${n.connectedEdges().length} accounts`] }
          : { x: p.x, y: p.y, value: d.risk.toFixed(2), unit: "risk", lines: [`${d.id} · ${d.name}`, `${inr(d.through)} through this account`, ROLE_TEXT[d.role] ?? "", d.frozen ? "Frozen" : ""].filter(Boolean) });
      });
      c.on("mouseover", "edge[kind='money']", (e: EventObject) => {
        if (flowTimer.current) return;
        const ed = e.target, p = ed.renderedMidpoint(), d = ed.data();
        ed.addClass("focus");
        setTip({ x: p.x, y: p.y, value: inr(d.amount), unit: "", lines: [`${d.source} → ${d.target}`, when(d.ts), d.wait != null ? `Sent on ${minutes(d.wait).slice(1)} after it arrived` : "First money in"] });
      });
      c.on("mouseover", "edge[kind='suspected']", (e: EventObject) => {
        if (flowTimer.current) return;
        const ed = e.target, p = ed.renderedMidpoint(), d = ed.data();
        setTip({ x: p.x, y: p.y, value: Number(d.score).toFixed(2), unit: "inferred closeness",
                 lines: [`${d.source} ⇢ ${d.target}`, "Not a recorded transfer", `Status: ${d.status}`, "Evidence: Inferred tab"] });
      });
      c.on("mouseout", "node, edge", () => { if (!flowTimer.current) c.elements().removeClass("dim focus"); setTip(null); });
      c.on("viewport", () => setTip(null));
      const ro = new ResizeObserver(([entry]) => {
        c.resize();
        const { width, height } = entry.contentRect;
        setSize((s) => (Math.abs(s.w - width) > 24 || Math.abs(s.h - height) > 24 ? { w: width, h: height } : s));
        fit();
      });
      ro.observe(box.current);
      cleanups.push(() => ro.disconnect());
      cy.current = c;
      setReady(true);
    }).catch(() => setBroken(true));  // e.g. a stale chunk after a rebuild: say so instead of drawing nothing
    return () => { dead = true; cleanups.forEach((f) => f()); if (flowTimer.current) clearInterval(flowTimer.current); cy.current?.destroy(); cy.current = null; };
  }, [fit]);

  useEffect(() => {
    const c = cy.current;
    if (!c) return;
    if (flowTimer.current) stopFlow();
    if (!graph) { c.elements().remove(); return; }
    // Draw left → right or top → bottom, whichever shows this ring larger in the space available.
    const scale = (f: Flow) => {
      const pts = [...Object.values(f.pos), ...f.columns];
      const w = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)) + 140;
      const h = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)) + 120;
      return Math.min((size.w || 800) / w, (size.h || 400) / h);
    };
    const across = flowLayout(graph.nodes, graph.edges, false), down = flowLayout(graph.nodes, graph.edges, true, 132);
    const flow: Flow = scale(down) > scale(across) * 1.1 ? down : across;
    const money = graph.edges.filter((e) => e.kind === "money");
    const maxAmt = Math.max(1, ...money.map((e) => e.amount ?? 0));
    const through: Record<string, number> = {};
    for (const e of money) for (const id of [e.source, e.target]) through[id] = (through[id] ?? 0) + (e.amount ?? 0) / 2;
    const maxThrough = Math.max(1, ...Object.values(through));
    const els: ElementDefinition[] = [
      ...graph.nodes.map((n) => ({ group: "nodes" as const, data: {
        ...n, band: riskBand(n.risk), through: through[n.id] ?? 0,
        size: Math.round(16 + 22 * Math.sqrt((through[n.id] ?? 0) / maxThrough)),
        label: n.frozen ? `${n.id}\nLOCKED` : n.id,
      } })),
      ...flow.columns.map((col) => ({ group: "nodes" as const, data: {
        id: `axis-${col.depth}`, role: "axis",
        label: `${col.kind === "hop" ? `${COLUMN_TEXT.hop} ${col.depth}` : COLUMN_TEXT[col.kind]}${col.ts ? `\n${clock(col.ts)}` : ""}`.toUpperCase(),
      } })),
      ...graph.edges.map((e) => ({ group: "edges" as const, data: {
        ...e, wait: flow.delta[e.id] ?? null,
        dlabel: e.kind === "suspected" ? "inferred" : flow.delta[e.id] != null ? minutes(flow.delta[e.id]) : "",
        w: e.kind === "money" ? 1.5 + 6 * (e.amount ?? 0) / maxAmt : 1,
      } })),
    ];
    const ids = new Set(els.map((e) => e.data.id as string));
    const stale = c.elements().filter((el) => !ids.has(el.id()));
    // A different ring (no account survives) is a fresh draw, not a live update; axis labels don't count.
    const firstDraw = c.nodes("[role != 'axis']").filter((n) => ids.has(n.id())).empty();
    c.batch(() => {
      stale.remove();
      for (const e of els) {
        const el = c.getElementById(e.data.id as string);
        if (el.nonempty()) el.data(e.data);
      }
    });
    const fresh = c.add(els.filter((e) => c.getElementById(e.data.id as string).empty()));
    c.edges("[kind='money']").toggleClass("labeled", money.length <= 12);  // busy rings show wait times on hover
    if (!firstDraw && fresh.nonempty()) {  // highlight what just arrived in a live ring
      const lit = fresh.not("node[role='axis']");
      lit.addClass("fresh");
      setTimeout(() => lit.removeClass("fresh"), 1800);
    }
    const pos = (id: string) => {
      if (id.startsWith("axis-")) { const col = flow.columns.find((k) => `axis-${k.depth}` === id)!; return { x: col.x, y: col.y }; }
      return flow.pos[id] ?? { x: 0, y: 0 };
    };
    c.layout({ name: "preset", positions: (n: { id: () => string }) => pos(n.id()), fit: false,
               animate: !firstDraw && !reducedMotion(), animationDuration: 420, stop: fit } as unknown as LayoutOptions).run();
    if (firstDraw || reducedMotion()) fit();
  }, [graph, ready, size, fit, stopFlow]);

  useEffect(() => {
    const c = cy.current;
    if (!c || flowTimer.current) return;
    c.elements().removeClass("cite dim");
    if (!cite?.length) return;
    const hit = c.collection();
    for (const id of cite) {
      const el = c.getElementById(id);
      if (el.nonempty()) hit.merge(el.isEdge() ? el.union(el.connectedNodes()) : el);
    }
    if (hit.empty()) return;
    hit.addClass("cite");
    c.elements().not(hit).not("node[role='axis']").addClass("dim");
  }, [cite, graph, ready]);

  // Trace Flow: replay the transfers one at a time, in the order the money moved.
  const traceFlow = () => {
    const c = cy.current;
    if (!c) return;
    if (flowTimer.current) { stopFlow(); return; }
    const edges = c.edges("[kind='money']").sort((a, b) => String(a.data("ts")).localeCompare(String(b.data("ts"))));
    if (edges.empty()) return;
    setTip(null);
    c.elements().not("node[role='axis']").addClass("dim");
    let i = 0;
    const tick = () => {
      if (i >= edges.length) { flowTimer.current && clearInterval(flowTimer.current); flowTimer.current = null; setTimeout(stopFlow, 1600); return; }
      const e = edges[i];
      e.removeClass("dim").addClass("flow");
      e.source().removeClass("dim"); e.target().removeClass("dim");
      setStep({ i: i + 1, n: edges.length, text: `${clock(e.data("ts"))} · ${inr(e.data("amount"))} · ${e.data("source")} → ${e.data("target")}${e.data("wait") != null ? ` · ${minutes(e.data("wait"))}` : ""}` });
      i++;
    };
    tick();
    flowTimer.current = window.setInterval(tick, reducedMotion() ? 900 : 420);
  };
  const zoomBy = (k: number) => {
    const c = cy.current;
    if (!c) return;
    c.zoom({ level: Math.max(0.2, Math.min(3, c.zoom() * k)), renderedPosition: { x: c.width() / 2, y: c.height() / 2 } });
  };

  const expand = () => {
    const el = frame.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});  // optional: some phones and embedded views refuse it
  };
  const ctl = "tl border border-line-hi bg-panel px-2.5 py-1.5 text-ink transition-colors hover:bg-raised disabled:opacity-40";
  return (
    <div ref={frame} className="blueprint absolute inset-0" role="img" aria-label="Money trail: columns are hops in time order, from source accounts on the left to exits on the right. The table view lists the same transfers.">
      {/* cytoscape forces position:relative on its container, so the container sits inside the absolute wrapper */}
      <div ref={box} className="h-full w-full" />
      {broken && (
        <p className="absolute inset-x-4 top-1/2 -translate-y-1/2 text-center font-sans text-[15px] text-ink" role="alert">
          The graph didn’t load. <button onClick={() => location.reload()} className="text-sel-line underline">Reload the page</button>, or use Table view.
        </p>
      )}
      {graph && (
        <div className="absolute right-3 top-2.5 z-10 grid justify-items-end gap-1.5">
          <div className="flex gap-1">
            <button onClick={traceFlow} className={`${ctl} ${step ? "border-red bg-red-soft text-red hover:bg-red-soft" : ""}`} aria-pressed={!!step}>
              <span aria-hidden>{step ? "■ " : "▶ "}</span>{step ? "Stop" : "Trace Flow"}
            </button>
            <button onClick={() => zoomBy(1.25)} className={ctl} aria-label="Zoom In"><span aria-hidden>+</span></button>
            <button onClick={() => zoomBy(0.8)} className={ctl} aria-label="Zoom Out"><span aria-hidden>−</span></button>
            <button onClick={fit} className={ctl}>Fit</button>
            <button onClick={expand} className={ctl} aria-label="Expand Graph to Full Screen" title="Full screen (Esc to exit)"><span aria-hidden>⤢</span></button>
          </div>
          <p className="tl msg num max-w-[min(420px,80vw)] truncate rounded-md border border-line-hi bg-panel px-2.5 py-1 text-[12.5px] text-ink empty:hidden" aria-live="polite">
            {step && <><span className="text-red">{step.i}/{step.n}</span> {step.text}</>}
          </p>
        </div>
      )}
      {tip && (
        <div className="tl pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-[calc(100%+16px)] whitespace-nowrap rounded-lg border border-line-hi bg-panel px-3 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.10)]"
          style={{ left: tip.x, top: tip.y }}>
          <div><span className="text-[15px] font-semibold text-ink">{tip.value}</span> <span className="text-muted">{tip.unit}</span></div>
          {tip.lines.map((l) => <div key={l} className="msg font-sans text-[13px] text-ink-2">{l}</div>)}
        </div>
      )}
    </div>
  );
}