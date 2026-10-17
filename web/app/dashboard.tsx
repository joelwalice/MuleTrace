"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AiPanel, CasesSheet, Checklist, CopilotSheet, EvidenceView, PolicySheet, QrSheet, Verdict, isDefaultPolicy } from "./evidence";
import MoneyGraph, { ROLE_TEXT } from "./graph";
import {
  API, ATTACKS, CASE_STATUS, COPILOT_URL, PATTERN, RISK_BANDS, clock, compactInr, day, get, inr, num, playbookNote, post, riskBand, when,
  type AiExplanation, type Alert, type Attack, type Case, type Detail, type Evaluation, type Evidence, type Graph, type Network, type Policy,
  type Profile, type Sel, type Sev, type Snapshot,
} from "./lib";
import { AccountLink, Kbd, Locked, Nav, NavLink, RoleMark, SelLink, SevGlyph, SevTag, Skeleton, Tag, useTween } from "./ui";

type SheetName = "policy" | "copilot" | "cases" | "qr";
type Signal = { id: number; at: string; sev: Sev | "ok"; text: string };
type Tab = "rings" | "graph" | "side";
type Side = "feed" | "evidence" | "profile" | "signals";
type View = "graph" | "table";
type UrlState = { sel: Sel; acct: string | null; side: Side; view: View; tab: Tab };
const SIDE_LABEL: Record<Side, string> = { feed: "Live Feed", evidence: "Evidence", profile: "Account", signals: "Log" };

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
    side: panel === "profile" || panel === "signals" || panel === "evidence" ? panel : "feed",
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
  const selSig = selected ? JSON.stringify(selected) + Math.floor((snap?.stats.transactions ?? 0) / 40) + `v${snap?.model_version}` : "";
  const [detail, setDetail] = useState<Detail | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  useEffect(() => {
    if (!sel || !selSig) { setDetail(null); setGraph(null); setEvidence(null); return; }
    let live = true;
    const base = `/${sel.kind}/${sel.id}`;
    Promise.all([get<Detail>(base), get<Graph>(`${base}/graph`), get<Evidence>(`${base}/evidence`)])
      .then(([d, g, ev]) => { if (live) { setDetail(d); setGraph(g); setEvidence(ev); } })
      .catch(() => {});
    return () => { live = false; };
  }, [sel, selSig]);
  const evPending = !!sel && (!evidence || (sel.kind === "network" ? evidence.network_id !== sel.id || !!evidence.alert_id : evidence.alert_id !== sel.id));
  const [cite, setCite] = useState<string[]>([]);
  const [strOpen, setStrOpen] = useState(false);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [bench, setBench] = useState<Evaluation | null>(null);
  useEffect(() => { get<Evaluation>("/evaluation").then(setBench).catch(() => {}); }, []);
  // While the next selection loads, keep the previous one on screen, dimmed, instead of flashing empty.
  const detailPending = !!sel && (!detail || (sel.kind === "network" ? detail.network_id !== sel.id || !!detail.alert_id : detail.alert_id !== sel.id));

  // When a new ring/alert opens, show its main account in Account 360 (once, so node taps aren't overridden).
  useEffect(() => {
    const id = detail?.alert_id ?? detail?.network_id;
    if (!detail || !id || autoFor.current === id) return;
    autoFor.current = id;
    setAcct(detail.account_id ?? detail.alerted?.[0] ?? null);
  }, [detail]);

  const acctSig = acct ? `${acct}:${Math.floor((snap?.stats.transactions ?? 0) / 25)}:${snap?.stats.frozen}:${snap?.model_version}` : "";
  const [profile, setProfile] = useState<Profile | null>(null);
  const [acctAi, setAcctAi] = useState<AiExplanation | null>(null);
  useEffect(() => {
    if (!acct) { setProfile(null); setAcctAi(null); return; }
    let live = true;
    get<Profile>(`/account/${acct}`).then((p) => live && setProfile(p)).catch(() => {});
    get<AiExplanation>(`/account/${acct}/ai`).then((a) => live && setAcctAi(a)).catch(() => live && setAcctAi(null));
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

  const choose = useCallback((s: Sel) => { setSel(s); setTab("graph"); setSide("evidence"); }, []);
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

  const caseAction = useCallback(async (id: string, a: "file_str" | "close") => {
    try {
      const c = await post<Case>(`/case/${id}/${a}`);
      signal("ok", a === "file_str" ? `${id} · STR Filed With FIU-IND (Simulated) · Ack ${c.ack}` : `${id} · Case Closed`);
    } catch { signal("high", `Couldn’t Update ${id} · It May Already Be at That Step`); }
  }, [signal]);

  const nav = useMemo(() => ({
    openAccount, choose,
    hrefAccount: (id: string) => toQuery({ ...state, acct: id, side: "profile", tab: "side" }),
    hrefSel: (s: Sel) => toQuery({ ...state, sel: s, tab: "graph", side: "evidence" }),
  }), [openAccount, choose, state]);

  if (!snap) return conn === "offline" ? <Offline /> : <LoadingShell />;

  const panel = (t: Tab) => `${tab === t ? "flex" : "hidden"} lg:flex flex-col min-h-0 min-w-0`;
  return (
    <Nav.Provider value={nav}>
      <div className="flex h-dvh flex-col gap-px bg-line pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]">
        <a href="#main" className="tl sr-only z-[70] rounded-md bg-ink px-3 py-2 text-panel focus:not-sr-only focus:fixed focus:left-3 focus:top-3">Skip to Investigation</a>
        <Header snap={snap} conn={conn} control={control} openSheet={setSheet} setAutopilot={setAutopilot} />
        <Ticker snap={snap} conn={conn} latest={signals[0]} />
        <Summary snap={snap} bench={bench} />
        <main id="main" tabIndex={-1} className="grid min-h-0 flex-1 grid-cols-1 gap-px outline-none lg:grid-cols-[320px_minmax(0,1fr)_360px] xl:grid-cols-[344px_minmax(0,1fr)_404px]">
          <section className={`${panel("rings")} bg-bg`} aria-labelledby="rings-h">
            <Rings snap={snap} sel={sel} launch={launch} />
          </section>
          <section className={`${panel("graph")} bg-panel`} aria-labelledby="trail-h">
            <GraphToolbar view={view} setView={setView} hasGraph={!!graph} />
            <div className={`relative min-h-[48dvh] flex-1 transition-opacity lg:min-h-[300px] duration-200 ${detailPending && graph ? "opacity-40" : ""}`} aria-busy={detailPending}>
              <div className={view === "graph" ? "contents" : "hidden"}><MoneyGraph graph={graph} onNode={openAccount} cite={side === "evidence" ? cite : undefined} /></div>
              {view === "table" && graph && <TrailTable graph={graph} />}
              {!graph && (sel ? <GraphSkeleton /> : <Watching snap={snap} />)}
              {graph && view === "graph" && <GraphFrame />}
            </div>
            {detail && sel ? <CasePanel detail={detail} kind={sel.kind} busy={busy} pending={detailPending} dismantle={dismantle} str={strOpen} setStr={setStrOpen}
              kase={snap.cases.find((c) => c.network_id === detail.network_id && sel.kind === "network")} act={caseAction} />
              : sel && <CaseSkeleton />}
          </section>
          <section className={`${panel("side")} bg-panel`} aria-labelledby="side-h">
            <div className="border-b border-line bg-panel px-3 py-2.5"><Step n={4} id="side-h">Check the Evidence</Step></div>
            <div className="grid grid-cols-4 gap-px border-b border-line bg-line" role="tablist" aria-label="Side panel">
              {(["feed", "evidence", "profile", "signals"] as const).map((s) => (
                <button key={s} id={`tab-${s}`} role="tab" aria-selected={side === s} aria-controls={`panel-${s}`} onClick={() => setSide(s)}
                  className={`tl bg-panel py-2.5 transition-colors ${side === s ? "text-ink shadow-[inset_0_-2px_0_var(--ink)]" : s === "evidence" && sel ? "text-red hover:text-ink" : "text-muted hover:text-ink"}`}>
                  {SIDE_LABEL[s]}{s === "signals" && signals.length > 0 && <span className="num"> ({signals.length})</span>}
                </button>
              ))}
            </div>
            <div id={`panel-${side}`} role="tabpanel" aria-labelledby={`tab-${side}`} className="flex min-h-0 flex-1 flex-col">
              {side === "feed" ? <Feed snap={snap} />
                : side === "evidence" ? (sel ? <EvidenceView ev={evidence} pending={evPending} graph={graph} setCite={setCite} openStr={() => setStrOpen(true)} />
                  : <p className="p-4 font-sans text-sm text-ink-2">Select a ring or an alert to see the evidence behind it: the figures the rules computed and the transactions they rest on.</p>)
                : side === "profile" ? <ProfileView p={profile} acct={acct} ai={acctAi?.account_id === acct ? acctAi : null}
                  setLabel={(v) => setProfile((p) => p && { ...p, label: v })} /> : <Signals signals={signals} />}
            </div>
          </section>
        </main>
        {sheet === "policy" && <PolicySheet policy={snap.policy} onClose={() => setSheet(null)}
          onApplied={(p: Policy) => signal("ok", `Policy Applied · ${p.rules.length} of 5 Rules On · Pass-Through ${Math.round(p.pass_ratio * 100)}% · Structuring From ${inr(p.band_floor)}`)} />}
        {sheet === "copilot" && <CopilotSheet onClose={() => setSheet(null)} prompts={copilotPrompts(sel, detail)} />}
        {sheet === "cases" && <CasesSheet snap={snap} onClose={() => setSheet(null)} act={caseAction} />}
        {sheet === "qr" && <QrSheet onClose={() => setSheet(null)} />}
        <nav className="grid grid-cols-3 gap-px bg-line pb-[env(safe-area-inset-bottom,0px)] lg:hidden" aria-label="Sections">
          {([["rings", `Rings (${snap.stats.networks})`], ["graph", "Money Trail"], ["side", "Evidence & Feed"]] as const).map(([t, label]) => (
            <NavLink key={t} href={toQuery({ ...state, tab: t })} onNavigate={() => setTab(t)} aria-current={tab === t ? "page" : undefined}
              className={`tl bg-panel py-3 text-center transition-colors ${tab === t ? "text-ink shadow-[inset_0_2px_0_var(--ink)]" : "text-muted"}`}>{label}</NavLink>
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

function copilotPrompts(sel: Sel, d: Detail | null) {
  if (!sel) return ["Which ring has the most money in it?", "List the open rings", "How does MuleTrace score on the IBM benchmark?"];
  const ring = d?.network_id ?? sel.id;
  const pair = sel.kind === "network" ? d?.alerted?.slice(0, 2) : d?.account_id && [d.account_id, ...(d.lateral ?? d.upstream ?? [])].slice(0, 2);
  return [
    sel.kind === "alert" ? `Why is ${sel.id} suspicious?` : `Explain ring ${ring}`,
    `Trace the money in ${ring}`,
    ...(pair && pair.length === 2 ? [`Why are ${pair[0]} and ${pair[1]} connected?`] : []),
    `Draft the STR for ${ring} and list what's missing`,
  ];
}

type Control = (a: "play" | "pause" | "reset", s?: number) => void;
function Header({ snap, conn, control, openSheet, setAutopilot }:
  { snap: Snapshot; conn: string; control: Control; openSheet: (s: SheetName) => void; setAutopilot: (on: boolean) => void }) {
  const btn = "tl bg-bg px-3 py-2 text-ink transition-colors hover:bg-raised";
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-panel px-4 pb-2.5 pt-[max(10px,env(safe-area-inset-top,0px))]">
      <div className="flex min-w-0 items-baseline gap-4">
        <Wordmark as="h1" />
        <span className="hidden truncate font-sans text-[14px] text-ink-2 lg:inline">Catches money-mule rings in a live bank, and shows the evidence.</span>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="tl flex items-center gap-2.5" aria-live="polite">
          {conn !== "live" ? <span className="text-red">○ Offline</span>
            : snap.running ? <span className="flex items-center gap-1.5 text-red"><span className="live-dot" aria-hidden />Live</span> : <span className="text-ink-2">Paused</span>}
          <time className="num text-ink-2" dateTime={snap.clock} title={`Bank clock, running at ${snap.speed}× real time`}>{when(snap.clock)}</time>
        </span>
        <div className="flex gap-1.5">
          <button onClick={() => control(snap.running ? "pause" : "play")} title="Shortcut: Space" aria-keyshortcuts="Space" className={btn}>
            {snap.running ? "Pause" : "Resume"}
          </button>
          <button onClick={() => openSheet("cases")} className={btn} title="Cases after dismantling, and the analyst feedback that retrains the AI">
            Cases{snap.cases.length > 0 && <span className="num"> ({snap.cases.length})</span>}
          </button>
          <button onClick={() => openSheet("policy")} className={btn} title="Tune the detection rules and replay them on today's data">
            Rules{!isDefaultPolicy(snap.policy) && <span className="text-red"> · Custom</span>}
          </button>
          {COPILOT_URL && (
            <button onClick={() => openSheet("copilot")} className="tl bg-ink px-3 py-2 font-semibold text-bg transition-colors hover:bg-red">Ask Copilot</button>
          )}
          <More snap={snap} control={control} setAutopilot={setAutopilot} openQr={() => openSheet("qr")} />
        </div>
      </div>
    </header>
  );
}

/* Secondary controls: clock speed, reset, the judge page and shortcuts. Out of the way of a first-time viewer. */
function More({ snap, control, setAutopilot, openQr }: { snap: Snapshot; control: Control; setAutopilot: (on: boolean) => void; openQr: () => void }) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  useEffect(() => {
    const close = (e: Event) => { if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && ref.current) ref.current.open = false; };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc); };
  }, []);
  const row = "flex items-center justify-between gap-3 px-3 py-2";
  return (
    <details ref={ref} className="relative rounded-md bg-bg">
      <summary className="tl cursor-pointer list-none px-3 py-2 text-ink-2 transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">More <span aria-hidden>▾</span></summary>
      <div className="tl absolute right-0 top-full z-50 mt-1.5 grid w-72 gap-px overflow-hidden rounded-lg border border-line-hi bg-line shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
        <div className={`${row} bg-panel`}>
          <span className="text-muted">Clock Speed</span>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Bank clock speed">
            {snap.speeds.map((s) => (
              <button key={s} role="radio" aria-checked={snap.speed === s} aria-label={`Bank clock at ${s} times real time`} onClick={() => control(snap.running ? "play" : "pause", s)}
                className={`num px-2 py-1 transition-colors ${snap.speed === s ? "bg-ink text-panel" : "bg-bg text-muted hover:text-ink"}`}>{s}×</button>
            ))}
          </div>
        </div>
        <button role="switch" aria-checked={snap.autopilot} onClick={() => setAutopilot(!snap.autopilot)} className={`${row} bg-panel text-left text-ink hover:bg-raised`}>
          Autopilot<span className={snap.autopilot ? "text-red" : "text-muted"}>{snap.autopilot ? "On · Every 1–2 Min" : "Off"}</span>
        </button>
        <button onClick={() => { if (ref.current) ref.current.open = false; openQr(); }} className={`${row} bg-panel text-left text-ink hover:bg-raised`}>Judge Phone QR Code<span aria-hidden>▦</span></button>
        <button onClick={() => { if (armed) { setArmed(false); control("reset"); } else setArmed(true); }}
          className={`${row} text-left transition-colors ${armed ? "bg-red font-semibold text-bg" : "bg-panel text-ink-2 hover:text-red"}`}>
          {armed ? "Confirm: Start a New Bank" : "New Bank"}<span className="msg font-sans text-[12px] opacity-80">{armed ? "" : "Clears everything"}</span>
        </button>
        <div className="grid gap-1.5 bg-panel px-3 py-2.5 text-[11.5px] text-ink-2">
          <span className="text-muted">Keyboard</span>
          <span className="flex items-center gap-1.5"><Kbd>1</Kbd><Kbd>2</Kbd><Kbd>3</Kbd>Plant a Ring</span>
          <span className="flex items-center gap-1.5"><Kbd>J</Kbd><Kbd>K</Kbd>Next / Previous Ring</span>
          <span className="flex items-center gap-1.5"><Kbd>T</Kbd>Graph / Table · <Kbd>Space</Kbd>Pause</span>
        </div>
      </div>
    </details>
  );
}

function Ticker({ snap, conn, latest }: { snap: Snapshot; conn: string; latest?: Signal }) {
  return (
    <div className="tl flex min-w-0 items-center gap-3 bg-bg px-4 py-2" role="status" aria-live="polite">
      <span className="eyebrow shrink-0">Latest</span>
      {conn === "offline" ? <span className="truncate text-red">Stream Lost · Retrying Automatically… Figures Shown Are From the Last Update</span>
        : latest ? <span className="flex min-w-0 gap-3">
            <span className="num shrink-0 text-muted">{clock(latest.at || snap.clock)}</span>
            {latest.sev === "ok" ? <span aria-hidden className="text-ink">■</span> : <SevGlyph sev={latest.sev} />}
            <span className="msg truncate text-ink">{latest.text}</span>
          </span>
        : <span className="truncate text-muted">{snap.running ? "Live Bank Running · Press 1, 2 or 3 to Plant a Mule Ring, Then Watch It Get Caught" : "Feed Paused · Press Go Live to Resume"}</span>}
    </div>
  );
}

/* The engine as a pipeline a viewer reads left to right: every transfer is checked, a few raise alerts,
   alerts collapse into rings (the pitch), and rings get locked. */
function Summary({ snap, bench }: { snap: Snapshot; bench: Evaluation | null }) {
  const s = snap.stats;
  return (
    <section aria-label="What MuleTrace found" className={`flex snap-x gap-px overflow-x-auto overscroll-x-contain *:shrink-0 *:snap-start lg:grid lg:*:shrink ${bench?.status === "ok" ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
      <Stage label="Transfers Checked" value={s.transactions} note="Every one runs through 5 rules" />
      <Stage label="Alerts Raised" value={s.alerts} note="Accounts a rule flagged" arrow />
      <Stage label="Mule Rings" value={s.networks} hot arrow
        note={s.networks ? `Alerts grouped by shared money · ${compactInr(s.total_in)} in` : "Alerts grouped by shared money or devices"} />
      <Stage label="Accounts Locked" value={s.frozen} arrow note={s.cases ? `${s.cases} ${s.cases === 1 ? "case" : "cases"} opened` : "After an analyst dismantles a ring"} />
      {bench?.status === "ok" && <Bench e={bench} />}
    </section>
  );
}

function Stage({ label, value, note, arrow, hot }: { label: string; value: number; note: string; arrow?: boolean; hot?: boolean }) {
  const v = useTween(value);
  return (
    <div className={`min-w-[190px] bg-panel px-4 py-3 ${hot ? "shadow-[inset_0_-3px_0_var(--red)]" : ""}`}>
      <div className="tl flex items-center gap-2 text-muted">{arrow && <span aria-hidden className="text-red">→</span>}{label}</div>
      <output className="macro mt-1.5 block text-[clamp(2.25rem,3.4vw,3.25rem)] text-ink">{num(v)}</output>
      <p className="mt-1.5 truncate font-sans text-[13px] text-ink-2">{note}</p>
    </div>
  );
}

/* The accuracy card appears only what eval_ibm.py measured on IBM's public data, never a placeholder figure. */
function Bench({ e }: { e: Extract<Evaluation, { status: "ok" }> }) {
  return (
    <div className="min-w-[190px] bg-panel px-4 py-3"
      title={`${e.dataset} · ${e.rows_read === "all" ? "all" : num(e.rows_read)} rows · USD only, no device data · run ${e.run_on}`}>
      <div className="tl text-muted">Accuracy · IBM Data</div>
      <output className="macro mt-1.5 block text-[clamp(2.25rem,3.4vw,3.25rem)] text-ink">{e.lift}<span className="text-[0.6em]">×</span></output>
      <p className="mt-1.5 truncate font-sans text-[13px] text-ink-2">Better than chance · precision {e.precision.toFixed(2)}, recall {e.recall.toFixed(2)}</p>
    </div>
  );
}

/* Panels carry a reading order (Step 1 → 4) so a first-time viewer knows where to look next. */
function Step({ n, id, children }: { n: number; id?: string; children: ReactNode }) {
  return (
    <h2 id={id} className="tl flex items-center gap-2 text-ink">
      <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink text-[11px] text-panel">{n}</span>
      <span className="sr-only">Step {n}: </span>{children}
    </h2>
  );
}

function RedTeam({ snap, launch }: { snap: Snapshot; launch: (k: Attack["kind"]) => void }) {
  const live = snap.attacks.filter((a) => a.left > 0);
  return (
    <div className="border-b border-line-hi bg-panel">
      <div className="tl flex items-center justify-between px-3 pt-2.5">
        <Step n={1}>Plant a Mule Ring</Step>
        {snap.autopilot && <span className="tl text-red">Autopilot</span>}
      </div>
      <p className="px-3 pt-1 font-sans text-[13px] leading-snug text-ink-2">
        Each button sends a real laundering pattern into the live bank. Or <a href="/send" target="_blank" rel="noopener" className="text-ink underline underline-offset-2 hover:text-red">send your own from a phone ↗</a>
      </p>
      <div className="grid grid-cols-3 gap-px p-3 pb-2">
        {ATTACKS.map((a) => (
          <button key={a.kind} onClick={() => launch(a.kind)} title={`${a.hint} · Shortcut: ${a.key}`} aria-keyshortcuts={a.key}
            className="tl group flex flex-col items-start gap-1 rounded-md border border-line-hi bg-panel px-2.5 py-2 text-left text-ink transition-colors hover:border-red hover:bg-red-soft active:scale-[0.98]">
            <span className="text-[11.5px] text-muted">Key {a.key}</span>
            <span className="leading-tight">{a.label}</span>
          </button>
        ))}
      </div>
      {live.length > 0 && (
        <ul className="grid gap-1 px-3 pb-2.5" aria-label="Attacks in progress">
          {live.map((a) => {
            const done = a.total - a.left;
            return (
              <li key={a.id} className="tl grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-[11.5px]">
                <span translate="no" className="text-red">{a.id}</span>
                <span className="truncate text-ink-2">{a.label}</span>
                <span className="num flex shrink-0 items-center gap-2 whitespace-nowrap" role="progressbar" aria-label={`${a.id} transfers released`} aria-valuenow={done} aria-valuemin={0} aria-valuemax={a.total}>
                  <span aria-hidden className="h-1.5 w-20 overflow-hidden rounded-full bg-line"><span className="block h-full origin-left bg-red transition-transform duration-500" style={{ transform: `scaleX(${done / a.total})` }} /></span>
                  <span className="text-ink-2">{done}/{a.total}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Rings({ snap, sel, launch }: { snap: Snapshot; sel: Sel; launch: (k: Attack["kind"]) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RedTeam snap={snap} launch={launch} />
      <div className="tl flex items-baseline justify-between border-b border-line bg-panel px-3 py-2.5">
        <Step n={2} id="rings-h">Pick a Ring</Step>
        <span className="num text-muted">{snap.networks.length} Found</span>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {!snap.networks.length ? (
          <div className="p-4">
            <p className="tl text-ink-2">No Rings Yet</p>
            <p className="mt-2 font-sans text-sm text-ink-2">{snap.running ? "Plant one above. When the rules flag accounts that pass money between each other, they show up here as one ring." : "The bank is paused. Press Resume."}</p>
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
  const open = on || (sel?.kind === "alert" && alerts.some((a) => a.alert_id === sel.id));
  const done = n.status === "dismantled";
  return (
    <article className="animate-enter bg-panel">
      <SelLink sel={{ kind: "network", id: n.network_id }} current={on}
        className={`block px-3 pb-3 pt-2.5 transition-colors ${on ? "bg-sel shadow-[inset_3px_0_0_var(--sel-line)]" : "hover:bg-bg"}`}>
        <div className="flex items-center justify-between gap-2">
          <h3 translate="no" className="macro text-[24px] text-ink">{n.network_id}</h3>
          {done ? <Locked /> : <SevTag sev={n.severity} score={n.score} />}
        </div>
        <div className="tl mt-2 flex items-baseline justify-between gap-2 text-ink-2">
          <span className="num">{n.accounts.length} Accounts · {n.alert_ids.length} {n.alert_ids.length === 1 ? "Alert" : "Alerts"}</span>
          <span className="num text-[13px] font-semibold text-ink">{compactInr(n.total_in)} In</span>
        </div>
        <p className="mt-2 flex flex-wrap gap-1">
          {n.patterns.map((p) => <span key={p} className="chip bg-bg px-1.5 py-0.5 text-[12px] text-ink-2">{PATTERN[p]}</span>)}
        </p>
      </SelLink>
      {open && <ul className="border-t border-line" aria-label={`Alerts in ${n.network_id}`}>
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
      </ul>}
    </article>
  );
}

function GraphToolbar({ view, setView, hasGraph }: { view: View; setView: (v: View) => void; hasGraph: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-panel px-4 py-2">
      <Step n={3} id="trail-h">Follow the Money</Step>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Money trail view" aria-keyshortcuts="T">
        {(["graph", "table"] as const).map((v) => (
          <button key={v} role="radio" aria-checked={view === v} disabled={!hasGraph} onClick={() => setView(v)}
            className={`tl px-2.5 py-1 transition-colors disabled:opacity-40 ${view === v ? "bg-ink text-panel" : "bg-bg text-muted hover:text-ink"}`}>{v === "graph" ? "Graph" : "Table"}</button>
        ))}
      </div>
      <ul className="tl flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-2" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span>Low</span>
          <span className="flex" aria-hidden>{RISK_BANDS.map((b, i) => <span key={b} className="h-2.5 w-2.5" style={{ background: `var(--risk-${i})` }} />)}</span>
          <span>High Risk</span>
        </li>
        <li className="flex items-center gap-1.5"><RoleMark role="alerted" />Flagged</li>
        <li className="flex items-center gap-1.5"><RoleMark role="source" />Source, Maybe a Victim</li>
        <li className="flex items-center gap-1.5"><RoleMark role="device" />Shared Phone</li>
      </ul>
    </div>
  );
}

/* One plain caption: how to read the drawing. */
function GraphFrame() {
  return (
    <p className="pointer-events-none absolute bottom-2.5 left-3 right-3 font-sans text-[13px] text-ink-2">
      Money moves left → right in time order. Bigger square = more money. <span className="font-mono text-ink">+9m</span> = how long it sat before moving on.
    </p>
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
            : snap.running ? "Plant a ring (keys 1–3) and watch its money trail draw here, hop by hop, as the money moves."
            : "The feed is paused. Press Go Live (or Space) to resume."}
        </p>
      </div>
    </div>
  );
}

function CasePanel({ detail: d, kind, busy, pending, dismantle, str, setStr, kase, act }:
  { detail: Detail; kind: "network" | "alert"; busy: boolean; pending: boolean; dismantle: (id: string) => void; str: boolean; setStr: (v: boolean) => void;
    kase?: Snapshot["cases"][number]; act: (id: string, a: "file_str" | "close") => void }) {
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
  }, [str, setStr]);
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
  const btn = "tl border border-line-hi px-3 py-2 transition-[background-color,color,transform] active:scale-[0.98]";
  return (
    <div className={`max-h-[42%] shrink-0 overflow-y-auto overscroll-contain border-t border-line-hi bg-bg transition-opacity duration-200 ${pending ? "opacity-40" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3">
        <h3 translate="no" className="macro text-[34px] text-ink">{id}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {kind === "alert" && <Tag>In <span translate="no">{d.network_id}</span></Tag>}
          {d.status === "dismantled" || d.status === "frozen" ? <Locked /> : <SevTag sev={d.severity} score={d.score} />}
        </div>
        <div className="ml-auto flex gap-1.5">
          <button ref={opener} onClick={() => setStr(true)} className={`${btn} bg-panel text-ink hover:bg-raised`}>Draft STR</button>
          {kase?.status === "open" && <button onClick={() => act(kase.case_id, "file_str")} className={`${btn} border-ink bg-ink font-semibold text-panel hover:opacity-90`}>File STR · {kase.case_id}</button>}
          {kase?.status === "str_filed" && <button onClick={() => act(kase.case_id, "close")} className={`${btn} bg-panel font-semibold text-ink hover:bg-raised`}>Close {kase.case_id}</button>}
          {kase?.status === "closed" && <span className="chip self-center bg-green-soft px-2 py-1 text-green">{kase.case_id} {CASE_STATUS.closed}</span>}
          {kind === "network" && d.status !== "dismantled" && !confirm && (
            <button onClick={() => setConfirm(true)} className={`${btn} border-red bg-panel font-semibold text-red hover:bg-red-soft`}>Dismantle Ring</button>
          )}
        </div>
      </div>
      {confirm && d.status !== "dismantled" && (
        <div className="mx-4 mt-3 overflow-hidden rounded-lg border border-red bg-red-soft" role="alertdialog" aria-label={`Confirm dismantling ${id}`}>

          <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <p className="tl min-w-0 flex-1 text-ink">
              <span className="font-semibold text-red">Confirm · </span>Locks {d.freeze?.length} mule & exit accounts. {sources === 1 ? "1 source account goes" : `${sources} source accounts go`} to review, since they may be victims.
            </p>
            <div className="flex gap-1.5">
              <button onClick={() => setConfirm(false)} className={`${btn} bg-bg text-ink-2 hover:text-ink`}>Cancel</button>
              <button disabled={busy} onClick={() => dismantle(id)} className={`${btn} border-red bg-red font-semibold text-panel hover:opacity-90 disabled:opacity-50`}>
                {busy ? "Locking…" : `Lock ${d.freeze?.length} Accounts`}
              </button>
            </div>
          </div>
        </div>
      )}
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
        <div className="fixed inset-0 z-[65] grid place-items-center overscroll-contain bg-ink/30 p-4" onClick={() => setStr(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="str-title" onClick={(e) => e.stopPropagation()}
            className="animate-enter flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line-hi bg-panel shadow-[0_24px_60px_rgba(0,0,0,0.12)]">
            <div className="flex flex-wrap items-center gap-3 border-b border-line-hi px-4 py-3">
              <h2 id="str-title" className="tl text-ink">Suspicious Transaction Report · <span translate="no">{id}</span></h2>
              <span className="tl text-red">Draft · FIU-IND</span>
              <div className="ml-auto flex gap-1.5">
                <button onClick={copy} className={`${btn} bg-panel text-ink hover:bg-raised`}>{copied ? "Copied" : "Copy"}</button>
                <button onClick={download} className={`${btn} bg-panel text-ink hover:bg-raised`}>Save .txt</button>
                <button ref={closeRef} onClick={() => setStr(false)} className={`${btn} bg-panel text-muted hover:text-ink`} aria-label="Close Report"><span aria-hidden>✕</span></button>
              </div>
            </div>
            <div className="overflow-y-auto overscroll-contain">
            {d.checklist && <Checklist items={d.checklist} />}
            <pre className="whitespace-pre-wrap p-4 font-mono text-[12.5px] leading-relaxed text-ink"><samp>{d.str_draft}</samp></pre>
            </div>
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

function ProfileView({ p, acct, ai, setLabel }: { p: Profile | null; acct: string | null; ai: AiExplanation | null; setLabel: (v: boolean | null) => void }) {
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
          <span className="tl text-muted">Rule Risk</span>
          <span className="flex items-center gap-2">
            <span className="h-3.5 w-3.5" style={{ background: `var(--risk-${riskBand(p.risk)})` }} aria-hidden />
            <output className="macro text-[40px] text-ink">{p.risk.toFixed(2)}</output>
          </span>
        </div>
      </div>
      <h4 className="eyebrow px-4 pt-3">AI Classifier · Why This Score</h4>
      {ai ? <div className="pt-1.5"><AiPanel ai={ai} /></div> : <div className="px-4 py-3"><Skeleton className="h-24" /></div>}
      <Verdict id={p.account_id} label={p.label ?? null} onChange={setLabel} />
      <dl className="tl grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-line px-4 py-3">
        {row("Account", `${p.type} · Opened ${day(p.open_date)}`)}
        {row("KYC Risk", p.kyc_risk)}
        {row("Devices", <span translate="no">{p.devices.join(", ") || "None"}</span>)}
        {row("IP Addresses", <span translate="no">{p.ips.join(", ") || "None"}</span>)}
      </dl>
      <dl className="grid grid-cols-2 gap-px border-y border-line bg-line">
        {[["Received", inr(p.total_received)], ["Senders", p.unique_senders], ["Sent", inr(p.total_sent)],
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
          <h4 className="eyebrow">Why It’s Flagged</h4>
          {p.alerts.flatMap((a) => a.reasons).map((r) => (
            <p key={r} className="flex gap-2 font-sans text-[14px] leading-snug text-ink"><span aria-hidden className={sev === "high" ? "text-red" : "text-ink-2"}>•</span><span className="min-w-0 break-words">{r}</span></p>
          ))}
        </div>
      )}
      <h4 className="eyebrow border-t border-line px-4 pb-1 pt-3">Transactions</h4>
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
