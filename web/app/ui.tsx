"use client";
import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { SEV_LABEL, num, reducedMotion, type Sel, type Sev } from "./lib";

/* Navigation: every selection is a real link (deep-linkable, Cmd/Ctrl+click opens a new tab);
   a plain click updates the view in place. */
type NavApi = { hrefAccount: (id: string) => string; openAccount: (id: string) => void; hrefSel: (s: Sel) => string; choose: (s: Sel) => void };
export const Nav = createContext<NavApi | null>(null);
const useNav = () => useContext(Nav)!;

export function NavLink({ href, onNavigate, className, children, ...rest }:
  { href: string; onNavigate: () => void; className?: string; children: ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;  // let the browser open a new tab/window
    e.preventDefault();
    onNavigate();
  };
  return <a href={href} onClick={click} className={className} {...rest}>{children}</a>;
}

export function AccountLink({ id, className = "" }: { id: string; className?: string }) {
  const nav = useNav();
  return (
    <NavLink href={nav.hrefAccount(id)} onNavigate={() => nav.openAccount(id)} translate="no"
      className={`font-mono underline-offset-2 transition-colors hover:bg-ink hover:text-bg ${className}`}>{id}</NavLink>
  );
}

export function SelLink({ sel, className, children, current }: { sel: Sel; className?: string; children: ReactNode; current: boolean }) {
  const nav = useNav();
  return <NavLink href={nav.hrefSel(sel)} onNavigate={() => nav.choose(sel)} className={className} aria-current={current ? "page" : undefined}>{children}</NavLink>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-shimmer bg-raised ${className}`} aria-hidden />;
}

/* Severity = glyph shape + word, so it never rests on colour. Red is reserved for High. */
const SEV_GLYPH: Record<Sev, string> = { high: "▲", medium: "◆", low: "●" };
const SEV_TONE: Record<Sev, string> = { high: "text-red", medium: "text-ink", low: "text-muted" };
export function SevGlyph({ sev }: { sev: Sev }) {
  return <span aria-hidden className={SEV_TONE[sev]}>{SEV_GLYPH[sev]}</span>;
}
export function SevTag({ sev, score }: { sev: Sev; score?: number }) {
  return (
    <span className={`tl inline-flex items-center gap-1.5 whitespace-nowrap ${SEV_TONE[sev]}`}>
      <span aria-hidden>[</span><SevGlyph sev={sev} />{SEV_LABEL[sev]}{score != null && <span className="num text-ink-2">{score.toFixed(2)}</span>}<span aria-hidden>]</span>
    </span>
  );
}

export function Tag({ children, tone = "text-ink-2" }: { children: ReactNode; tone?: string }) {
  return <span className={`tl inline-flex items-center gap-1 whitespace-nowrap border border-line-hi px-1.5 py-px ${tone}`}>{children}</span>;
}
export function Locked() {
  return <Tag tone="text-ink"><span aria-hidden>▣</span>Locked</Tag>;
}

/* Role markers mirror the graph's node shapes: square = account, diamond = shared device. */
export function RoleMark({ role }: { role: "alerted" | "source" | "member" | "exit" | "device" }) {
  const base = "inline-block h-2.5 w-2.5 shrink-0";
  if (role === "device") return <span aria-hidden className={`${base} h-2 w-2 rotate-45 bg-ink-2`} />;
  if (role === "alerted") return <span aria-hidden className={`${base} border-2 border-red bg-[var(--risk-2)]`} />;
  if (role === "source") return <span aria-hidden className={`${base} border border-dashed border-ink-2 bg-[var(--risk-0)]`} />;
  return <span aria-hidden className={`${base} bg-[var(--risk-1)]`} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="tl border border-line-hi px-1.5 py-px text-[11.5px] text-ink">{children}</kbd>;
}

/* Transaction "barcode": one thin column per hour (last 48h). Hover/focus reads out the hour;
   arrow keys step through it. The latest hour is drawn in phosphor white, the rest recede. */
export function Barcode({ data, label, unit }: { data: number[]; label: string; unit: (i: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length, w = n * 3, h = 30;
  const max = Math.max(1, ...data);
  const at = hover ?? n - 1;
  const pick = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect();
    setHover(Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n))));
  };
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-8 w-[144px] touch-none" tabIndex={0} role="img"
        aria-label={`${label}: latest ${data[n - 1]} ${unit(n - 1)}, peak ${max}`}
        onPointerMove={(e) => pick(e.clientX, e.currentTarget)} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
        onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setHover((p) => Math.max(0, Math.min(n - 1, (p ?? n - 1) + (e.key === "ArrowLeft" ? -1 : 1)))); } }}>
        <line x1="0" x2={w} y1={h - 0.5} y2={h - 0.5} stroke="var(--line-hi)" strokeWidth="1" />
        {data.map((v, i) => {
          const bh = Math.max(1, (v / max) * (h - 2));
          return <rect key={i} x={i * 3} y={h - 1 - bh} width="2" height={bh} fill={i === at ? "var(--ink)" : "var(--muted)"} />;
        })}
      </svg>
      {hover != null && (
        <div className="tl pointer-events-none absolute bottom-full right-0 z-30 mb-1 whitespace-nowrap border border-line-hi bg-bg px-2 py-1">
          <span className="num text-ink">{data[at]}</span> <span className="text-muted">{unit(at)}</span>
        </div>
      )}
    </div>
  );
}

export function useTween(value: number, ms = 600) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reducedMotion()) { from.current = value; setShown(value); return; }
    const start = performance.now(), a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      from.current = a + (value - a) * (1 - (1 - k) ** 3);
      setShown(from.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

export function Tween({ value, pad = 0 }: { value: number; pad?: number }) {
  const v = num(useTween(value));
  return <>{pad ? v.padStart(pad, "0") : v}</>;
}

/* Readout: a labelled telemetry value. <output> marks it as a live computed result. */
export function Readout({ label, value, fmt = num, note, trend }:
  { label: string; value: number; fmt?: (v: number) => string; note?: ReactNode; trend?: ReactNode }) {
  const v = useTween(value);
  return (
    <div className="flex min-w-0 items-end justify-between gap-3 bg-panel px-4 py-3">
      <div className="min-w-0">
        <div className="tl text-muted">{label}</div>
        <output className="macro mt-1.5 block text-[30px] text-ink">{fmt(v)}</output>
        {note && <div className="tl mt-1.5 truncate text-[11.5px] text-muted">{note}</div>}
      </div>
      {trend}
    </div>
  );
}
