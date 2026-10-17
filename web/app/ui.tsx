"use client";
import { createContext, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { SEV_LABEL, reducedMotion, type Sel, type Sev } from "./lib";

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
      className={`rounded-[3px] font-mono text-[0.95em] text-sel-line underline-offset-2 transition-colors hover:bg-sel hover:underline ${className}`}>{id}</NavLink>
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
const SEV_TONE: Record<Sev, string> = { high: "text-red", medium: "text-amber", low: "text-muted" };
const SEV_CHIP: Record<Sev, string> = { high: "bg-red-soft text-red", medium: "bg-amber-soft text-amber", low: "bg-bg text-muted" };
export function SevGlyph({ sev }: { sev: Sev }) {
  return <span aria-hidden className={SEV_TONE[sev]}>{SEV_GLYPH[sev]}</span>;
}
export function SevTag({ sev, score }: { sev: Sev; score?: number }) {
  return (
    <span className={`chip inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-0.5 text-[12.5px] font-medium ${SEV_CHIP[sev]}`}>
      <SevGlyph sev={sev} />{SEV_LABEL[sev]} risk{score != null && <span className="num opacity-80">{score.toFixed(2)}</span>}
    </span>
  );
}

export function Tag({ children, tone = "text-ink-2" }: { children: ReactNode; tone?: string }) {
  return <span className={`chip inline-flex items-center gap-1 whitespace-nowrap border border-line-hi px-2 py-0.5 text-[12.5px] font-medium ${tone}`}>{children}</span>;
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
