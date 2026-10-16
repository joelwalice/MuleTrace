"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import MoneyGraph, { ROLE_TEXT } from "./graph";
import {
  API, ATTACKS, PATTERN, RISK_BANDS, clock, compactInr, day, get, inr, num, playbookNote, post, riskBand, when,
  type Alert, type Attack, type Case, type Detail, type Graph, type Network, type Profile, type Sel, type Sev, type Snapshot,
} from "./lib";
import { AccountLink, Barcode, Kbd, Locked, Nav, NavLink, Readout, RoleMark, SelLink, SevGlyph, SevTag, Skeleton, Tag, Tween } from "./ui";

type Signal = { id: number; at: string; sev: Sev | "ok"; text: string };
type Tab = "rings" | "graph" | "side";
type Side = "feed" | "profile" | "signals";
type View = "graph" | "table";
type UrlState = { sel: Sel; acct: string | null; side: Side; view: View; tab: Tab };
const SPEEDS = [1, 2, 5, 10];
const SIDE_LABEL: Record<Side, string> = { feed: "Ledger", profile: "Account 360", signals: "Signals" };

// The URL mirrors what's on screen, so any view can be shared, bookmarked or opened in a new tab.
function toQuery(s: UrlState) {
  const q = new URLSearchParams();
  if (s.sel) q.set(s.sel.kind === "network" ? "ring" : "alert", s.sel.id);
  if (s.acct) q.set("acct", s.acct);
  if (s.side !== "feed") q.set("panel", s.side);
  if (s.view !== "graph") q.set("view", s.view);
  if (s.tab !== "graph") q.set("tab", s.tab);
  const str = q.toString();
  return str ? `?${str}` : "?";
}
function readQuery(): Partial<UrlState> {
  const q = new URLSearchParams(location.search);
  const ring = q.get("ring"), alert = q.get("alert"), tab = q.get("tab"), panel = q.get("panel");
  return {
    sel: ring ? { kind: "network", id: ring } : alert ? { kind: "alert", id: alert } : null,
    acct: q.get("acct"),
    side: panel === "profile" || panel === "signals" ? panel : "feed",
    view: q.get("view") === "table" ? "table" : "graph",
    tab: tab === "rings" || tab === "side" ? tab : "graph",
  };
}

function useLive() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<"connecting" | "live" | "offline">("connecting");
  useEffect(() => {
    const es = new EventSource(`${API}/stream`);  // EventSource reconnects on its own
    es.onopen = () => setConn("live");
    es.onmessage = (e) => { setSnap(JSON.parse(e.data)); setConn("live"); };
    es.onerror = () => setConn("offline");
    return () => es.close();
  }, []);
  return { snap, conn };
}

export default function Dashboard() {
  const { snap, conn } = useLive();
  const [sel, setSel] = useState<Sel>(null);
  const [acct, setAcct] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("graph");
  const [side, setSide] = useState<Side>("feed");
  const [view, setView] = useState<View>("graph");
  const [signals, setSignals] = useState<Signal[]>([]);
  const [busy, setBusy] = useState(false);
  const autoFor = useRef<string | null>(null);
  const clockRef = useRef("");
  if (snap) clockRef.current = snap.clock;

  // Restore state from the URL once on the client, then keep the URL in sync.
  const [urlReady, setUrlReady] = useState(false);
  useEffect(() => {
    const u = readQuery();
    setSel(u.sel ?? null); setAcct(u.acct ?? null); setSide(u.side ?? "feed"); setView(u.view ?? "graph"); setTab(u.tab ?? "graph");
    if (u.acct && u.sel) autoFor.current = u.sel.id;  // a linked account wins over the ring's default account
    setUrlReady(true);
  }, []);
  const state: UrlState = useMemo(() => ({ sel, acct, side, view, tab }), [sel, acct, side, view, tab]);
  useEffect(() => { if (urlReady) history.replaceState(null, "", toQuery(state)); }, [state, urlReady]);

  // Signals: an append-only log of what the engine found and what the analyst did, stamped with the bank clock.
  const signal = useCallback((sev: Signal["sev"], text: string) => {
    setSignals((s) => [{ id: Date.now() + Math.random(), at: clockRef.current, sev, text }, ...s].slice(0, 80));
  }, []);

  // Log new rings/alerts, follow the first ring, and drop selections that no longer exist (after reset).
  const prev = useRef<{ alerts: Set<string>; nets: Set<string> } | null>(null);
  useEffect(() => {
    if (!snap || !urlReady) return;
    const alerts = new Set(snap.alerts.map((a) => a.alert_id));
    const nets = new Set(snap.networks.map((n) => n.network_id));
    const p = prev.current;
    prev.current = { alerts, nets };
    setSel((s) => (s && !(s.kind === "network" ? nets : alerts).has(s.id) ? null : s));
    if (!p) {  // opened mid-demo: show the top ring straight away
      if (snap.networks[0]) setSel((s) => s ?? { kind: "network", id: snap.networks[0].network_id });
      return;
    }
    const newNets = snap.networks.filter((n) => !p.nets.has(n.network_id));
    for (const n of newNets)
      signal(n.severity, `${n.network_id} Linked · ${n.accounts.length} Accounts · ${n.patterns.map((x) => PATTERN[x]).join(" / ")}`);
    for (const a of snap.alerts.filter((a) => !p.alerts.has(a.alert_id) && p.nets.has(a.network_id)))
      signal(a.severity, `${a.alert_id} Joined ${a.network_id} · ${a.account_id} · ${a.reasons[0]}`);
    if (newNets[0]) setSel((s) => s ?? { kind: "network", id: newNets[0].network_id });
  }, [snap, signal, urlReady]);

  // Refetch the selected ring/alert only when it changes, or as its money trail grows.
  const selected = snap && sel
    ? sel.kind === "network" ? snap.networks.find((n) => n.network_id === sel.id) : snap.alerts.find((a) => a.alert_id === sel.id)
    : undefined;
  const selSig = selected ? JSON.stringify(selected) + Math.floor((snap?.stats.transactions ?? 0) / 40) : "";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  useEffect(() => {
    if (!sel || !selSig) { setDetail(null); setGraph(null); return; }
    let live = true;
    Promise.all([get<Detail>(`/${sel.kind}/${sel.id}`), get<Graph>(`/${sel.kind}/${sel.id}/graph`)])
      .then(([d, g]) => { if (live) { setDetail(d); setGraph(g); } })
      .catch(() => {});
    return () => { live = false; };
  }, [sel, selSig]);
  // While the next selection loads, keep the previous one on screen, dimmed, instead of flashing empty.
  const detailPending = !!sel && (!detail || (sel.kind === "network" ? detail.network_id !== sel.id || !!detail.alert_id : detail.alert_id !== sel.id));

  // When a new ring/alert opens, show its main account in Account 360 (once, so node taps aren't overridden).
  useEffect(() => {
    const id = detail?.alert_id ?? detail?.network_id;
    if (!detail || !id || autoFor.current === id) return;
    autoFor.current = id;
    setAcct(detail.account_id ?? detail.alerted?.[0] ?? null);
  }, [detail]);

  const acctSig = acct ? `${acct}:${Math.floor((snap?.stats.transactions ?? 0) / 25)}:${snap?.stats.frozen}` : "";
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    if (!acct) { setProfile(null); return; }
    let live = true;
    get<Profile>(`/account/${acct}`).then((p) => live && setProfile(p)).catch(() => {});
    return () => { live = false; };
  }, [acct, acctSig]);

  const control = useCallback(async (action: "play" | "pause" | "reset", speed?: number) => {
    try {
      await post(`/live/${action}${speed ? `?speed=${speed}` : ""}`);
      if (action === "reset") { setSel(null); setAcct(null); prev.current = null; autoFor.current = null; seenAttacks.current = null; setSignals([]); }
    } catch {
      signal("high", `API Unreachable at ${API} · Start it with “uvicorn app:app --reload”`);
    }
  }, [signal]);

  const launch = useCallback(async (kind: Attack["kind"]) => {
    try { await post(`/inject/${kind}`); }
    catch { signal("high", `Couldn’t Launch the Attack · Is the API running at ${API}?`); }
  }, [signal]);
  const setAutopilot = useCallback(async (on: boolean) => {
    try { await post(`/autopilot?on=${on}`); signal("ok", on ? "Autopilot On · A Random Attack Every 1–2 Minutes" : "Autopilot Off"); }
    catch { signal("high", `Couldn’t Change Autopilot · Is the API running at ${API}?`); }
  }, [signal]);

  // Log each attack the moment the server accepts it.
  const seenAttacks = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!snap) return;
    const ids = new Set(snap.attacks.map((a) => a.id));
    if (seenAttacks.current) for (const a of snap.attacks) if (!seenAttacks.current.has(a.id)) signal("medium", `${a.id} Launched · ${a.label} · ${a.total} Transfers Queued`);
    seenAttacks.current = ids;
  }, [snap, signal]);

  const choose = useCallback((s: Sel) => { setSel(s); setTab("graph"); }, []);
  const openAccount = useCallback((id: string) => { setAcct(id); setSide("profile"); setTab("side"); }, []);

  // Keyboard-first: Space play/pause, J/K next/previous ring, T graph/table.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !snap) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable], [role='dialog']")) return;
      if (e.code === "Space" && !t.closest("button, a, [tabindex]")) { e.preventDefault(); control(snap.running ? "pause" : "play"); }
      else if ((e.key === "j" || e.key === "k") && snap.networks.length) {
        const ids = snap.networks.map((n) => n.network_id);
        const cur = sel?.kind === "network" ? sel.id : sel ? snap.alerts.find((a) => a.alert_id === sel.id)?.network_id : undefined;
        const i = cur ? ids.indexOf(cur) : -1;
        choose({ kind: "network", id: ids[(i + (e.key === "j" ? 1 : -1) + ids.length) % ids.length] });
      } else if (e.key === "t") setView((v) => (v === "graph" ? "table" : "graph"));
      else { const atk = ATTACKS.find((a) => a.key === e.key); if (atk) launch(atk.kind); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snap, control, sel, choose, launch]);

  const dismantle = async (id: string) => {
    setBusy(true);
    try {
      const r = await post<Case>(`/network/${id}/dismantle`);
      signal("ok", `${r.case_id} Opened · ${id} Dismantled · ${r.frozen.length} Frozen, ${r.review.length} to Review · ${playbookNote(r.webhook)}`);
    } catch {
      signal("high", `Couldn’t Dismantle ${id} · The API returned an error. Check its log, then try again.`);
    }
    setBusy(false);
  };

  const nav = useMemo(() => ({
    openAccount, choose,
    hrefAccount: (id: string) => toQuery({ ...state, acct: id, side: "profile", tab: "side" }),
    hrefSel: (s: Sel) => toQuery({ ...state, sel: s, tab: "graph" }),
  }), [openAccount, choose, state]);

  if (!snap) return conn === "offline" ? <Offline /> : <LoadingShell />;

  const panel = (t: Tab) => `${tab === t ? "flex" : "hidden"} lg:flex flex-col min-h-0 min-w-0`;
  return (
    <Nav.Provider value={nav}>
      <div className="flex h-dvh flex-col gap-px bg-line pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]">
        <a href="#main" className="tl sr-only z-[70] bg-ink px-3 py-2 text-bg focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to Investigation</a>
        <Header snap={snap} conn={conn} control={control} />
        <Ticker snap={snap} conn={conn} latest={signals[0]} />
        <Summary snap={snap} />
        <main id="main" tabIndex={-1} className="grid min-h-0 flex-1 grid-cols-1 gap-px outline-none lg:grid-cols-[320px_minmax(0,1fr)_360px] xl:grid-cols-[344px_minmax(0,1fr)_404px]">
          <section className={`${panel("rings")} bg-bg`} aria-labelledby="rings-h">
            <Rings snap={snap} sel={sel} launch={launch} setAutopilot={setAutopilot} />
          </section>
          <section className={`${panel("graph")} bg-panel`} aria-labelledby="trail-h">
            <GraphToolbar view={view} setView={setView} hasGraph={!!graph} />
            <div className={`relative min-h-[48dvh] flex-1 transition-opacity lg:min-h-[300px] duration-200 ${detailPending && graph ? "opacity-40" : ""}`} aria-busy={detailPending}>
              <div className={view === "graph" ? "contents" : "hidden"}><MoneyGraph graph={graph} onNode={openAccount} /></div>
              {view === "table" && graph && <TrailTable graph={graph} />}
              {!graph && (sel ? <GraphSkeleton /> : <Watching snap={snap} />)}
              {graph && view === "graph" && <GraphFrame id={sel?.id ?? ""} graph={graph} />}
            </div>
            {detail && sel ? <CasePanel detail={detail} kind={sel.kind} busy={busy} pending={detailPending} dismantle={dismantle} />
              : sel && <CaseSkeleton />}
          </section>
          <section className={`${panel("side")} bg-bg`} aria-labelledby="side-h">
            <h2 id="side-h" className="sr-only">Ledger, Account Profile and Signals</h2>
            <div className="grid grid-cols-3 gap-px border-b border-line bg-line" role="tablist" aria-label="Side panel">
              {(["feed", "profile", "signals"] as const).map((s) => (
                <button key={s} id={`tab-${s}`} role="tab" aria-selected={side === s} aria-controls={`panel-${s}`} onClick={() => setSide(s)}
                  className={`tl py-2.5 transition-colors ${side === s ? "bg-ink text-bg" : "bg-panel text-muted hover:text-ink"}`}>
                  {SIDE_LABEL[s]}{s === "signals" && signals.length > 0 && <span className="num"> {String(signals.length).padStart(2, "0")}</span>}
                </button>
              ))}
            </div>
            <div id={`panel-${side}`} role="tabpanel" aria-labelledby={`tab-${side}`} className="flex min-h-0 flex-1 flex-col">
              {side === "feed" ? <Feed snap={snap} /> : side === "profile" ? <ProfileView p={profile} acct={acct} /> : <Signals signals={signals} />}
            </div>
          </section>
        </main>
        <footer className="tl hidden items-center gap-5 bg-bg px-4 py-1.5 text-[11.5px] text-muted lg:flex">
          <span className="flex items-center gap-1.5"><Kbd>Space</Kbd>Play / Pause</span>
          <span className="flex items-center gap-1.5"><Kbd>J</Kbd><Kbd>K</Kbd>Next / Previous Ring</span>
          <span className="flex items-center gap-1.5"><Kbd>T</Kbd>Graph / Table</span>
          <span className="flex items-center gap-1.5"><Kbd>1</Kbd><Kbd>2</Kbd><Kbd>3</Kbd>Launch Attack</span>
          <a href="/send" target="_blank" rel="noopener" className="text-ink underline-offset-2 hover:text-red hover:underline">Send a Transfer ↗</a>
          <span className="ml-auto" translate="no">API {API.replace(/^https?:\/\//, "")} · SSE Stream · Synthetic Bank, Live Feed</span>
        </footer>
        <nav className="grid grid-cols-3 gap-px bg-line pb-[env(safe-area-inset-bottom,0px)] lg:hidden" aria-label="Sections">
          {([["rings", `Rings ${String(snap.stats.networks).padStart(2, "0")}`], ["graph", "Trail"], ["side", "Ledger & 360"]] as const).map(([t, label]) => (
            <NavLink key={t} href={toQuery({ ...state, tab: t })} onNavigate={() => setTab(t)} aria-current={tab === t ? "page" : undefined}
              className={`tl py-3 text-center transition-colors ${tab === t ? "bg-ink text-bg" : "bg-panel text-muted"}`}>{label}</NavLink>
          ))}
        </nav>
      </div>
    </Nav.Provider>
  );
}

function Wordmark({ as: Tag = "div", big }: { as?: "div" | "h1"; big?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="grid grid-cols-2 gap-[3px]">
        <span className="h-2 w-2 bg-[var(--risk-1)]" /><span className="h-2 w-2 bg-red" />
        <span className="h-2 w-2 bg-muted" /><span className="h-2 w-2 bg-[var(--risk-2)]" />
      </span>
      <Tag translate="no" className={`macro ${big ? "text-5xl" : "text-[22px]"} text-ink`}>MuleTrace</Tag>
    </div>
  );
}

function LoadingShell() {
  return (
    <div className="flex h-dvh flex-col gap-px bg-line" aria-busy="true" aria-label="Loading MuleTrace">
      <div className="flex items-center gap-4 bg-bg px-4 py-3"><Wordmark /><Skeleton className="ml-auto h-6 w-72" /></div>
      <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="grid gap-2 bg-panel px-4 py-4"><Skeleton className="h-2.5 w-28" /><Skeleton className="h-8 w-24" /></div>)}
      </div>
      <div className="grid flex-1 gap-px lg:grid-cols-[320px_1fr_360px]">
        <div className="grid content-start gap-px bg-bg">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div>
        <div className="blueprint hidden lg:block" />
        <div className="hidden content-start gap-px bg-bg lg:grid">{Array.from({ length: 14 }, (_, i) => <Skeleton key={i} className="h-6" />)}</div>
      </div>
      <p className="sr-only" role="status">Connecting to the live transaction stream…</p>
    </div>
  );
}

function Offline() {
  return (
    <div className="grid h-dvh place-items-center bg-bg px-4">
      <div className="grid max-w-lg gap-4">
        <Wordmark as="h1" big />
        <p className="tl text-red" role="alert"><span aria-hidden>▲ </span>No Signal From the API</p>
        <p className="font-sans text-[15px] text-ink-2">
          Can’t reach <span translate="no" className="font-mono text-ink">{API}</span>. Start it with{" "}
          <span translate="no" className="font-mono text-ink">uvicorn app:app --reload</span>. This page reconnects on its own.
        </p>
      </div>
    </div>
  );
}

function Header({ snap, conn, control }: { snap: Snapshot; conn: string; control: (a: "play" | "pause" | "reset", s?: number) => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-bg px-4 pb-2.5 pt-[max(10px,env(safe-area-inset-top,0px))]">
      <div className="flex items-baseline gap-4">
        <Wordmark as="h1" />
        <span className="tl hidden text-muted xl:inline">AML / Mule-Ring Telemetry · FIU-IND</span>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="tl flex items-center gap-2" aria-live="polite">
          {conn === "live" ? <span className="text-green">● Link</span> : <span className="text-red">○ No Link</span>}
          <span className={snap.running ? "text-red" : "text-ink-2"}>{snap.running ? <>Live <span className="cursor" aria-hidden /></> : "Feed Paused"}</span>
        </span>
        <time className="tl num text-ink" dateTime={snap.clock} title={`Bank clock, running at ${snap.speed}× real time`}>T {when(snap.clock)}</time>
        <span className="tl num hidden text-ink-2 md:inline" title="Ordinary customer transactions per real second, plus queued attack transfers">
          {snap.feed_rate} Tx/s{snap.queued > 0 && <span className="text-red"> · {snap.queued} Queued</span>}
        </span>
        <div className="flex items-center gap-px bg-line">
          <button onClick={() => control(snap.running ? "pause" : "play")} title="Shortcut: Space" aria-keyshortcuts="Space"
            className="tl bg-ink px-3.5 py-2 font-semibold text-bg transition-[background-color,transform] hover:bg-red active:translate-y-px">
            <span aria-hidden>{snap.running ? "❚❚ " : "▶ "}</span>{snap.running ? "Pause Feed" : "Go Live"}
          </button>
          <div className="flex gap-px" role="radiogroup" aria-label="Bank clock speed">
            {snap.speeds.map((s) => (
              <button key={s} role="radio" aria-checked={snap.speed === s} aria-label={`Bank clock at ${s} times real time`} onClick={() => control(snap.running ? "play" : "pause", s)}
                className={`tl num px-2.5 py-2 transition-colors ${snap.speed === s ? "bg-raised text-ink" : "bg-bg text-muted hover:text-ink"}`}>{s}×</button>
            ))}
          </div>
          <button onClick={() => { if (armed) { setArmed(false); control("reset"); } else setArmed(true); }}
            className={`tl px-3 py-2 transition-colors active:translate-y-px ${armed ? "bg-red font-semibold text-bg" : "bg-bg text-ink-2 hover:text-red"}`}
            title="Starts a fresh bank: clears rings, cases and signals">
            {armed ? "Confirm New Bank" : "New Bank"}
          </button>
        </div>
      </div>
    </header>
  );
}

function Ticker({ snap, conn, latest }: { snap: Snapshot; conn: string; latest?: Signal }) {
  return (
    <div className="tl flex min-w-0 items-center gap-3 bg-panel px-4 py-2" role="status" aria-live="polite">
      <span className="shrink-0 text-red" aria-hidden>&gt;&gt;&gt;</span>
      {conn === "offline" ? <span className="truncate text-red">Stream Lost · Retrying Automatically… Figures Shown Are From the Last Update</span>
        : latest ? <span className="flex min-w-0 gap-3">
            <span className="num shrink-0 text-muted">{clock(latest.at || snap.clock)}</span>
            {latest.sev === "ok" ? <span aria-hidden className="text-ink">■</span> : <SevGlyph sev={latest.sev} />}
            <span className="msg truncate text-ink">{latest.text}</span>
          </span>
        : <span className="truncate text-muted">{snap.running ? "Feed Live · Launch an Attack From the Red Team Console, or Send a Transfer at /send" : "Feed Paused · Press Go Live to Resume"}</span>}
    </div>
  );
}

function Summary({ snap }: { snap: Snapshot }) {
  const s = snap.stats;
  const hourAgo = (i: number) => (snap.hourly.length - 1 - i === 0 ? "txn · latest hour" : `txn · ${snap.hourly.length - 1 - i}h ago`);
  return (
    <section aria-label="Summary" className="flex snap-x gap-px overflow-x-auto overscroll-x-contain *:shrink-0 *:snap-start lg:grid lg:grid-cols-[minmax(340px,1.5fr)_repeat(3,minmax(0,1fr))] lg:*:shrink">
      <div className="bg-bg px-4 py-3">
        <div className="tl text-muted"><span aria-hidden>[ </span>Alerts → Rings<span aria-hidden> ]</span></div>
        <div className="mt-2 flex items-end gap-3 text-ink">
          <span className="macro text-[clamp(3.25rem,6vw,5.75rem)]"><Tween value={s.alerts} pad={2} /></span>
          <span className="macro pb-1 text-[clamp(1.5rem,2.6vw,2.5rem)] text-red" aria-hidden>→</span>
          <span className="sr-only">alerts grouped into</span>
          <span className="macro text-[clamp(3.25rem,6vw,5.75rem)]"><Tween value={s.networks} pad={2} /></span>
          <span className="tl pb-1.5 text-muted">{s.networks === 1 ? "Ring" : "Rings"}</span>
        </div>
      </div>
      <Readout label="Txn Screened" value={s.transactions} note="Per Hour · 48h"
        trend={<Barcode data={snap.hourly} label="Transactions per hour" unit={hourAgo} />} />
      <Readout label="Money Into Rings" value={s.total_in} fmt={compactInr} note="From Source Accounts" />
      <Readout label="Accounts Locked" value={s.frozen} fmt={(v) => num(v).padStart(2, "0")} note={`${String(s.cases).padStart(2, "0")} ${s.cases === 1 ? "Case" : "Cases"} Opened`} />
    </section>
  );
}

function RedTeam({ snap, launch, setAutopilot }: { snap: Snapshot; launch: (k: Attack["kind"]) => void; setAutopilot: (on: boolean) => void }) {
  const live = snap.attacks.filter((a) => a.left > 0);
  return (
    <div className="border-b border-line-hi bg-panel">
      <div className="tl flex items-center justify-between px-3 pt-2.5">
        <h2 className="text-red"><span aria-hidden>[ </span>Red Team<span aria-hidden> ]</span></h2>
        <button role="switch" aria-checked={snap.autopilot} onClick={() => setAutopilot(!snap.autopilot)}
          className={`tl border px-2 py-0.5 transition-colors ${snap.autopilot ? "border-red bg-red text-bg" : "border-line-hi text-ink-2 hover:text-ink"}`}>
          Autopilot {snap.autopilot ? "On" : "Off"}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-px p-3 pb-2">
        {ATTACKS.map((a) => (
          <button key={a.kind} onClick={() => launch(a.kind)} title={`${a.hint} · Shortcut: ${a.key}`} aria-keyshortcuts={a.key}
            className="tl group flex flex-col items-start gap-1 border border-line-hi bg-bg px-2 py-2 text-left text-ink transition-colors hover:border-red hover:bg-red hover:text-bg active:translate-y-px">
            <span className="text-[11.5px] text-muted group-hover:text-bg">{a.key} · Launch</span>
            <span className="leading-tight">{a.label}</span>
          </button>
        ))}
      </div>
      {live.length > 0 && (
        <ul className="grid gap-1 px-3 pb-2.5" aria-label="Attacks in progress">
          {live.map((a) => {
            const done = a.total - a.left, cells = 8, on = Math.round((done / a.total) * cells);
            return (
              <li key={a.id} className="tl grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-[11.5px]">
                <span translate="no" className="text-red">{a.id}</span>
                <span className="truncate text-ink-2">{a.label}</span>
                <span className="num shrink-0 whitespace-nowrap font-mono" role="progressbar" aria-label={`${a.id} transfers released`} aria-valuenow={done} aria-valuemin={0} aria-valuemax={a.total}>
                  <span aria-hidden><span className="text-ink">{"█".repeat(on)}</span><span className="text-line-hi">{"░".repeat(cells - on)}</span></span>
                  <span className="ml-1.5 text-ink-2">{done}/{a.total}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Rings({ snap, sel, launch, setAutopilot }: { snap: Snapshot; sel: Sel; launch: (k: Attack["kind"]) => void; setAutopilot: (on: boolean) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RedTeam snap={snap} launch={launch} setAutopilot={setAutopilot} />
      <div className="tl flex items-baseline justify-between border-b border-line bg-panel px-3 py-2.5">
        <h2 id="rings-h" className="text-ink"><span aria-hidden>[ </span>Mule Rings<span aria-hidden> ]</span></h2>
        <span className="num text-muted">{String(snap.networks.length).padStart(2, "0")} / {String(snap.alerts.length).padStart(2, "0")} Alerts</span>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {!snap.networks.length ? (
          <div className="p-4">
            <p className="tl text-ink-2">No Rings Yet</p>
            <p className="mt-2 font-sans text-sm text-muted">{snap.running ? "The rules run on every transaction as it arrives. Launch an attack above, or send transfers from /send, and linked accounts appear here as one ring." : "The feed is paused. Press Go Live to resume."}</p>
          </div>
        ) : (
          <ul className="grid gap-px bg-line pb-px">
            {snap.networks.map((n) => <li key={n.network_id}><RingCard n={n} alerts={snap.alerts.filter((a) => a.network_id === n.network_id)} sel={sel} /></li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

function RingCard({ n, alerts, sel }: { n: Network; alerts: Alert[]; sel: Sel }) {
  const on = sel?.kind === "network" && sel.id === n.network_id;
  const done = n.status === "dismantled";
  return (
    <article className="animate-enter bg-bg">
      <SelLink sel={{ kind: "network", id: n.network_id }} current={on}
        className={`block px-3 pb-3 pt-2.5 transition-colors ${on ? "bg-ink text-bg" : "hover:bg-raised"}`}>
        <div className="flex items-center justify-between gap-2">
          <h3 translate="no" className="macro text-[26px]">{n.network_id}</h3>
          {done ? <span className={`tl ${on ? "text-bg" : "text-ink"}`}><span aria-hidden>▣ </span>Dismantled</span>
            : on ? <span className="tl text-bg"><span aria-hidden>[</span>{n.severity === "high" ? "▲ " : n.severity === "medium" ? "◆ " : "● "}{n.severity} {n.score.toFixed(2)}<span aria-hidden>]</span></span>
            : <SevTag sev={n.severity} score={n.score} />}
        </div>
        <div className={`tl mt-2 flex items-baseline justify-between gap-2 ${on ? "text-bg/80" : "text-ink-2"}`}>
          <span className="num">{String(n.accounts.length).padStart(2, "0")} Accts · {String(n.alert_ids.length).padStart(2, "0")} Alerts</span>
          <span className={`num text-[13px] font-semibold ${on ? "text-bg" : "text-ink"}`}>{compactInr(n.total_in)} In</span>
        </div>
        <p className={`tl mt-1.5 text-[11.5px] ${on ? "text-bg/80" : "text-ink-2"}`}>
          {n.patterns.map((p) => <span key={p}><span aria-hidden>/// </span>{PATTERN[p]} </span>)}
        </p>
      </SelLink>
      <ul className="border-t border-line">
        {alerts.map((a) => {
          const aon = sel?.kind === "alert" && sel.id === a.alert_id;
          return (
            <li key={a.alert_id} className="animate-enter">
              <SelLink sel={{ kind: "alert", id: a.alert_id }} current={aon}
                className={`grid grid-cols-[14px_auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 font-mono text-[12.5px] uppercase transition-colors ${aon ? "bg-raised text-ink" : "text-ink-2 hover:bg-raised hover:text-ink"}`}>
                {a.status === "frozen" ? <span aria-hidden className="text-ink">▣</span> : <SevGlyph sev={a.severity} />}
                <span translate="no" className="text-ink">{a.alert_id}</span>
                <span className="truncate"><span translate="no">{a.account_id}</span> · {a.pattern.split("+").map((p) => PATTERN[p]).join(", ")}</span>
                <span className="num text-ink">{a.score.toFixed(2)}</span>
              </SelLink>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function GraphToolbar({ view, setView, hasGraph }: { view: View; setView: (v: View) => void; hasGraph: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-panel px-4 py-2">
      <h2 id="trail-h" className="tl text-ink"><span aria-hidden>[ </span>Money Trail<span aria-hidden> ]</span></h2>
      <div className="flex gap-px bg-line" role="radiogroup" aria-label="Money trail view" aria-keyshortcuts="T">
        {(["graph", "table"] as const).map((v) => (
          <button key={v} role="radio" aria-checked={view === v} disabled={!hasGraph} onClick={() => setView(v)}
            className={`tl px-2.5 py-1 transition-colors disabled:opacity-40 ${view === v ? "bg-ink text-bg" : "bg-panel text-muted hover:text-ink"}`}>{v}</button>
        ))}
      </div>
      <ul className="tl flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11.5px] text-ink-2" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span className="text-muted">Risk</span>
          {RISK_BANDS.map((b, i) => (
            <span key={b} className="flex items-center gap-1"><span className="h-2.5 w-2.5" style={{ background: `var(--risk-${i})` }} aria-hidden />{b}</span>
          ))}
        </li>
        <li className="flex items-center gap-1.5"><RoleMark role="alerted" />Alerted</li>
        <li className="flex items-center gap-1.5"><RoleMark role="source" />Source</li>
        <li className="flex items-center gap-1.5"><RoleMark role="device" />Device</li>
        <li className="flex items-center gap-1.5"><span className="text-ink" aria-hidden>+9m</span>Wait Before Forwarding</li>
        <li className="hidden items-center gap-1.5 xl:flex"><span aria-hidden className="inline-block h-2.5 w-4 bg-[var(--risk-1)]" />Size = Money Through</li>
      </ul>
    </div>
  );
}

/* Corner annotations carry real figures for the drawn trail, so the frame says something true. */
function GraphFrame({ id, graph }: { id: string; graph: Graph }) {
  const money = graph.edges.filter((e) => e.kind === "money");
  const total = money.reduce((t, e) => t + (e.amount ?? 0), 0);
  const corner = "pointer-events-none absolute tl text-[11.5px] text-muted";
  return (
    <>
      <span className={`${corner} left-3 top-2.5`} translate="no">+ Unit / {id}</span>
      <span className={`${corner} bottom-2.5 left-3 num`}>+ {String(graph.nodes.length).padStart(2, "0")} Nodes · {String(money.length).padStart(2, "0")} Transfers</span>
      <span className={`${corner} bottom-2.5 right-3 num hidden sm:block`}>{compactInr(total)} Moved Across Hops +</span>
    </>
  );
}

function TrailTable({ graph }: { graph: Graph }) {
  const money = graph.edges.filter((e) => e.kind === "money").sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  const th = "py-2 text-left font-normal text-muted";
  return (
    <div className="absolute inset-0 overflow-auto overscroll-contain bg-panel px-4 pb-4">
      <table className="w-full min-w-[460px] font-mono text-[13px] uppercase">
        <caption className="tl pb-1 pt-3 text-left text-muted">{money.length} Transfers · Time Order</caption>
        <thead className="tl sticky top-0 bg-panel"><tr className="border-b border-line-hi">
          <th scope="col" className={th}>Time</th><th scope="col" className={th}>From</th><th scope="col" className={th}>To</th><th scope="col" className={`${th} text-right`}>Amount</th>
        </tr></thead>
        <tbody>{money.map((e) => (
          <tr key={e.id} className="border-b border-line transition-colors hover:bg-raised">
            <td className="num py-1.5 text-ink-2"><time dateTime={e.ts}>{when(e.ts ?? "")}</time></td>
            <td><AccountLink id={e.source} /></td><td><AccountLink id={e.target} /></td>
            <td className="num text-right text-ink">{inr(e.amount ?? 0)}</td>
          </tr>
        ))}</tbody>
      </table>
      <table className="mt-6 w-full min-w-[460px] font-mono text-[13px] uppercase">
        <caption className="tl pb-1 text-left text-muted">{graph.nodes.length} Accounts & Devices</caption>
        <thead className="tl"><tr className="border-b border-line-hi">
          <th scope="col" className={th}>Account</th><th scope="col" className={th}>Role</th><th scope="col" className={`${th} text-right`}>Risk</th>
        </tr></thead>
        <tbody>{graph.nodes.map((n) => (
          <tr key={n.id} className="border-b border-line transition-colors hover:bg-raised">
            <td className="py-1.5">
              {n.role === "device" ? <span translate="no">{n.id}</span> : <AccountLink id={n.id} />}
              {n.frozen && <span className="ml-2 text-ink"><span aria-hidden>▣ </span>Locked</span>}
            </td>
            <td className="text-ink-2">{ROLE_TEXT[n.role]}</td>
            <td className="num text-right">{n.role === "device" ? "—" : n.risk.toFixed(2)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function GraphSkeleton() {
  return (
    <div className="blueprint absolute inset-0 grid place-items-center" aria-hidden>
      <div className="grid justify-items-center gap-7">
        <div className="flex gap-6">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-5 w-5" />)}</div>
        <Skeleton className="h-7 w-7" />
        <div className="flex gap-12">{[0, 1].map((i) => <Skeleton key={i} className="h-5 w-5" />)}</div>
      </div>
    </div>
  );
}

function CaseSkeleton() {
  return (
    <div className="grid shrink-0 gap-2 border-t border-line bg-bg px-4 py-4" aria-hidden>
      <Skeleton className="h-7 w-32" /><Skeleton className="h-3 w-full max-w-xl" /><Skeleton className="h-3 w-2/3 max-w-md" />
    </div>
  );
}

function Watching({ snap }: { snap: Snapshot }) {
  const rings = snap.networks.length;
  return (
    <div className="blueprint pointer-events-none absolute inset-0 grid place-items-center p-6">
      <div className="grid max-w-md justify-items-center gap-3 text-center">
        <svg width="84" height="84" viewBox="0 0 84 84" aria-hidden>
          <rect x="1" y="1" width="82" height="82" fill="none" stroke="var(--line-hi)" />
          <path d="M42 6v72M6 42h72" stroke="var(--line-hi)" />
          <circle cx="42" cy="42" r="26" fill="none" stroke="var(--line-hi)" />
          {snap.running && (
            <g className="radar-sweep">
              <circle cx="42" cy="42" r="26" fill="none" />
              <path d="M42 42 L42 16 A26 26 0 0 1 64 28 Z" fill="var(--red)" opacity="0.28" />
            </g>
          )}
          <rect x="39" y="39" width="6" height="6" fill="var(--red)" />
        </svg>
        <p className="macro text-[28px] text-ink">{rings ? "Select a Ring" : <>Screening <span className="num">{num(snap.stats.transactions)}</span></>}</p>
        <p className="font-sans text-sm text-ink-2">
          {rings ? "Its money trail draws here, each transfer in time order. Press J or K to step through rings."
            : snap.running ? "Launch an attack (keys 1–3) and watch the ring assemble here as the money moves."
            : "The feed is paused. Press Go Live (or Space) to resume."}
        </p>
      </div>
    </div>
  );
}

function CasePanel({ detail: d, kind, busy, pending, dismantle }:
  { detail: Detail; kind: "network" | "alert"; busy: boolean; pending: boolean; dismantle: (id: string) => void }) {
  const [str, setStr] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const id = kind === "network" ? d.network_id : d.alert_id!;
  useEffect(() => { setConfirm(false); }, [id]);
  useEffect(() => {
    if (!str) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setStr(false);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); opener.current?.focus(); };
  }, [str]);
  const group = (label: string, role: Parameters<typeof RoleMark>[0]["role"], ids?: string[]) => !!ids?.length && (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-start gap-2">
      <span className="tl flex items-center gap-1.5 pt-1 text-ink-2"><RoleMark role={role} />{label}</span>
      <div className="flex flex-wrap gap-1">
        {ids.map((a) => <AccountLink key={a} id={a} className="border border-line-hi px-1.5 py-0.5 text-[12.5px] text-ink" />)}
      </div>
    </div>
  );
  const copy = async () => {
    try { await navigator.clipboard.writeText(d.str_draft); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* text stays selectable */ }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([d.str_draft], { type: "text/plain" }));
    Object.assign(document.createElement("a"), { href: url, download: `STR-${id}.txt` }).click();
    URL.revokeObjectURL(url);
  };
  const sources = d.sources?.length ?? 0;
  const btn = "tl px-3 py-2 transition-[background-color,color,transform] active:translate-y-px";
  return (
    <div className={`max-h-[42%] shrink-0 overflow-y-auto overscroll-contain border-t border-line-hi bg-bg transition-opacity duration-200 ${pending ? "opacity-40" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3">
        <h3 translate="no" className="macro text-[34px] text-ink">{id}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {kind === "alert" && <Tag>In <span translate="no">{d.network_id}</span></Tag>}
          {d.status === "dismantled" || d.status === "frozen" ? <Locked /> : <SevTag sev={d.severity} score={d.score} />}
        </div>
        <div className="ml-auto flex gap-px bg-line">
          <button ref={opener} onClick={() => setStr(true)} className={`${btn} bg-panel text-ink hover:bg-ink hover:text-bg`}>Draft STR</button>
          {kind === "network" && d.status !== "dismantled" && !confirm && (
            <button onClick={() => setConfirm(true)} className={`${btn} bg-panel font-semibold text-red hover:bg-red hover:text-bg`}>Dismantle Ring</button>
          )}
        </div>
      </div>
      {confirm && d.status !== "dismantled" && (
        <div className="mx-4 mt-3 border border-red" role="alertdialog" aria-label={`Confirm dismantling ${id}`}>
          <div className="hazard h-2" aria-hidden />
          <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <p className="tl min-w-0 flex-1 text-ink">
              <span className="text-red">Armed · </span>Locks {d.freeze?.length} mule & exit accounts. {sources === 1 ? "1 source account goes" : `${sources} source accounts go`} to review, since they may be victims.
            </p>
            <div className="flex gap-px bg-line">
              <button onClick={() => setConfirm(false)} className={`${btn} bg-bg text-ink-2 hover:text-ink`}>Cancel</button>
              <button disabled={busy} onClick={() => dismantle(id)} className={`${btn} bg-red font-semibold text-bg hover:bg-ink disabled:opacity-50`}>
                {busy ? "Locking…" : `Lock ${d.freeze?.length} Accounts`}
              </button>
            </div>
          </div>
        </div>
      )}
      <p className="mt-3 max-w-[70ch] px-4 font-sans text-[15px] leading-relaxed text-pretty text-ink">{d.explanation}</p>
      <div className="grid gap-1.5 px-4 pb-4 pt-3">
        {kind === "network" ? <>
          {group("Sources", "source", d.sources)}
          {group("Mules", "alerted", d.mules)}
          {group("Exits", "exit", d.exits)}
        </> : <>
          {group("Money From", "source", d.upstream)}
          {group("Money To", "member", d.downstream)}
          {group("Same Device", "device", d.lateral)}
        </>}
      </div>
      {str && (
        <div className="fixed inset-0 z-[65] grid place-items-center overscroll-contain bg-bg/85 p-4" onClick={() => setStr(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="str-title" onClick={(e) => e.stopPropagation()}
            className="animate-enter flex max-h-[85dvh] w-full max-w-2xl flex-col border border-ink bg-panel">
            <div className="flex flex-wrap items-center gap-3 border-b border-line-hi px-4 py-3">
              <h2 id="str-title" className="tl text-ink">Suspicious Transaction Report · <span translate="no">{id}</span></h2>
              <span className="tl text-red">Draft · FIU-IND</span>
              <div className="ml-auto flex gap-px bg-line">
                <button onClick={copy} className={`${btn} bg-panel text-ink hover:bg-ink hover:text-bg`}>{copied ? "Copied" : "Copy"}</button>
                <button onClick={download} className={`${btn} bg-panel text-ink hover:bg-ink hover:text-bg`}>Save .txt</button>
                <button ref={closeRef} onClick={() => setStr(false)} className={`${btn} bg-panel text-muted hover:text-ink`} aria-label="Close Report"><span aria-hidden>✕</span></button>
              </div>
            </div>
            <pre className="overflow-y-auto overscroll-contain whitespace-pre-wrap p-4 font-mono text-[12.5px] leading-relaxed text-ink"><samp>{d.str_draft}</samp></pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Feed({ snap }: { snap: Snapshot }) {
  return (
    <div className="flex-1 scroll-pt-9 overflow-y-auto overscroll-contain">
      <div className="tl sticky top-0 z-10 flex items-center justify-between border-b border-line bg-bg px-4 py-2 text-[11.5px] text-muted">
        <span>Newest First</span>
        <span className="flex items-center gap-1.5"><span aria-hidden className="text-red">▲</span>Touches an Alerted Account</span>
      </div>
      <ul aria-label="Latest transactions" className="font-mono text-[13px] uppercase">
        {snap.feed.map((t) => (
          <li key={t.txn_id} className={`animate-enter grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-4 py-2 ${t.suspicious ? "bg-[color-mix(in_oklab,var(--red)_9%,transparent)]" : ""}`}>
            <time className="num text-muted" dateTime={t.ts}>{clock(t.ts)}</time>
            <span className="flex min-w-0 items-center gap-1.5">
              {t.suspicious && <><span aria-hidden className="text-red">▲</span><span className="sr-only">Flagged:</span></>}
              <AccountLink id={t.sender_account} />
              <span className="text-muted" aria-hidden>→</span><span className="sr-only">to</span>
              <AccountLink id={t.receiver_account} />
              <span className="truncate text-muted">{t.channel}</span>
            </span>
            <data value={t.amount} className={`num ${t.suspicious ? "font-semibold text-ink" : "text-ink-2"}`}>{inr(t.amount)}</data>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProfileView({ p, acct }: { p: Profile | null; acct: string | null }) {
  if (!acct) return <p className="p-4 font-sans text-sm text-ink-2">Select any account in the graph, the ledger or the case panel to open its profile.</p>;
  if (!p) return (
    <div className="grid gap-3 p-4" aria-busy="true">
      <Skeleton className="h-3 w-20" /><Skeleton className="h-7 w-48" /><Skeleton className="h-24" /><Skeleton className="h-20" />
      <p className="sr-only" role="status">Loading account {acct}…</p>
    </div>
  );
  const pending = p.account_id !== acct;
  const pass = Math.min(100, p.passthrough_pct);
  const sev: Sev = p.risk >= 0.85 ? "high" : p.risk >= 0.7 ? "medium" : "low";
  const row = (k: string, v: ReactNode) => <div className="contents"><dt className="text-muted">{k}</dt><dd className="min-w-0 truncate text-ink">{v}</dd></div>;
  return (
    <div className={`flex-1 overflow-y-auto overscroll-contain transition-opacity duration-200 ${pending ? "opacity-40" : ""}`} aria-busy={pending}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-px border-b border-line bg-line">
        <div className="min-w-0 bg-bg px-4 py-3">
          <div translate="no" className="tl text-muted">{p.account_id} · {p.home_branch}</div>
          <h3 className="macro mt-1.5 truncate text-[26px] text-ink">{p.name}</h3>
          <div className="mt-2">{p.frozen ? <Locked /> : p.alerts.length ? <SevTag sev={sev} /> : <span className="tl text-muted">No Alerts</span>}</div>
        </div>
        <div className="grid content-center justify-items-end bg-bg px-4 py-3">
          <span className="tl text-muted">Risk</span>
          <span className="flex items-center gap-2">
            <span className="h-3.5 w-3.5" style={{ background: `var(--risk-${riskBand(p.risk)})` }} aria-hidden />
            <output className="macro text-[40px] text-ink">{p.risk.toFixed(2)}</output>
          </span>
        </div>
      </div>
      <dl className="tl grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-4 py-3">
        {row("Account", `${p.type} · Opened ${day(p.open_date)}`)}
        {row("KYC Risk", p.kyc_risk)}
        {row("Devices", <span translate="no">{p.devices.join(", ") || "None"}</span>)}
        {row("IP Addresses", <span translate="no">{p.ips.join(", ") || "None"}</span>)}
      </dl>
      <dl className="grid grid-cols-2 gap-px border-y border-line bg-line">
        {[["Received", inr(p.total_received)], ["Senders", String(p.unique_senders).padStart(2, "0")], ["Sent", inr(p.total_sent)],
          ["To Forward", p.avg_minutes_to_forward != null ? `${p.avg_minutes_to_forward} min` : "n/a"]].map(([k, v]) => (
          <div key={k} className="bg-panel px-4 py-2.5">
            <dt className="tl text-muted">{k}</dt>
            <dd className="num mt-1 font-mono text-[16px] font-semibold text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="px-4 py-3">
        <div className="tl flex justify-between"><span className="text-muted" id="pass-l">Passed Through</span><span className="num text-ink">{p.passthrough_pct}%</span></div>
        <div className="mt-1.5 h-2.5 bg-raised" role="meter" aria-labelledby="pass-l" aria-valuenow={pass} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full origin-left transition-transform duration-500 ${pass >= 80 ? "bg-red" : "bg-ink"}`} style={{ transform: `scaleX(${pass / 100})` }} />
        </div>
      </div>
      {!!p.alerts.length && (
        <div className="grid gap-1 border-t border-line px-4 py-3">
          <h4 className="tl text-muted"><span aria-hidden>[ </span>Why It’s Flagged<span aria-hidden> ]</span></h4>
          {p.alerts.flatMap((a) => a.reasons).map((r) => (
            <p key={r} className="flex gap-2 font-sans text-[14px] leading-snug text-ink"><span aria-hidden className={sev === "high" ? "text-red" : "text-ink-2"}>&gt;</span><span className="min-w-0 break-words">{r}</span></p>
          ))}
        </div>
      )}
      <h4 className="tl border-t border-line px-4 pb-1 pt-3 text-muted"><span aria-hidden>[ </span>Transactions<span aria-hidden> ]</span></h4>
      <ul className="font-mono text-[13px] uppercase">
        {p.txns.map((t) => {
          const out = t.sender_account === p.account_id, other = out ? t.receiver_account : t.sender_account;
          return (
            <li key={t.txn_id} className="grid grid-cols-[110px_minmax(0,1fr)_auto] gap-x-3 border-b border-line px-4 py-1.5">
              <time className="num text-muted" dateTime={t.ts}>{when(t.ts)}</time>
              <span className="flex min-w-0 gap-1.5">
                <span className={out ? "text-red" : "text-ink-2"} aria-hidden>{out ? "→" : "←"}</span><span className="sr-only">{out ? "Sent to" : "Received from"}</span>
                <AccountLink id={other} />
                <span className="truncate text-muted">{t.channel}</span>
              </span>
              <data value={out ? -t.amount : t.amount} className="num text-ink">{out ? "−" : "+"}{inr(t.amount)}</data>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Signals({ signals }: { signals: Signal[] }) {
  if (!signals.length) return (
    <div className="p-4">
      <p className="tl text-ink-2">No Signals Yet</p>
      <p className="mt-2 font-sans text-sm text-muted">Every ring found, alert linked and case opened is logged here with the bank clock time.</p>
    </div>
  );
  return (
    <ol className="flex-1 overflow-y-auto overscroll-contain font-mono text-[13px]" aria-label="Signal log, newest first">
      {signals.map((s) => (
        <li key={s.id} className="animate-enter grid grid-cols-[96px_14px_minmax(0,1fr)] gap-x-2 border-b border-line px-4 py-2">
          <time className="num text-muted" dateTime={s.at}>{s.at ? when(s.at) : "—"}</time>
          {s.sev === "ok" ? <span aria-hidden className="text-ink">■</span> : <SevGlyph sev={s.sev} />}
          <span className="msg break-words font-sans text-[14px] leading-snug text-ink">{s.text}</span>
        </li>
      ))}
    </ol>
  );
}
