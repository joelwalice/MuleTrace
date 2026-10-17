"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import {
  CASE_STATUS, CONFIDENCE, COPILOT_URL, DEFAULT_POLICY, PATTERN, RULES, aiBand, clock, get, inr, num, post, when,
  type AiExplanation, type AiRing, type Case, type Check, type Snapshot, type Compare, type Computation, type Confidence, type Evidence, type Graph, type NextQ, type Policy, type Replay,
} from "./lib";
import { AccountLink, SevTag, Skeleton } from "./ui";

/* Confidence = bar count + word (never colour alone). Insufficient is the one state that warns. */
export function ConfidenceTag({ c, label: prefix }: { c: Confidence; label?: string }) {
  const { label, bars } = CONFIDENCE[c];
  return (
    <span className={`chip inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-0.5 text-[12.5px] font-medium ${c === "insufficient" ? "bg-red-soft text-red" : c === "high" ? "bg-green-soft text-green" : "bg-bg text-ink-2"}`}>
      <span aria-hidden className="flex items-end gap-[2px]">
        {[0, 1, 2].map((i) => <span key={i} className={`w-1 rounded-[1px] ${["h-1.5", "h-2", "h-2.5"][i]} ${i < bars ? "bg-current" : "bg-current opacity-25"}`} />)}
      </span>
      {prefix ? `${prefix}: ${label}` : `${label} Confidence`}
    </span>
  );
}

const PCT = new Set(["passthrough_ratio", "share_reaching_exits"]);
const MONEY = new Set(["money_in", "money_to_exits", "total_deposited"]);
const fmtValue = (c: Computation) =>
  PCT.has(c.name) ? `${Math.round(c.value * 100)}%` : MONEY.has(c.name) ? inr(c.value)
  : c.name.includes("minutes") ? `${c.value} min` : c.name.includes("days") ? `${num(c.value)} d` : num(c.value);
const label = (name: string) => name.replaceAll("_", " ");

/* Secondary detail folds away (native <details>): open it when a judge asks "show me the transactions". */
const Fold = ({ title, children }: { title: string; children: ReactNode }) => (
  <details className="group border-t border-line">
    <summary className="eyebrow flex cursor-pointer list-none items-center justify-between px-4 py-3 hover:text-ink [&::-webkit-details-marker]:hidden">
      {title}<span aria-hidden className="text-[14px] transition-transform group-open:rotate-90">›</span>
    </summary>
    {children}
  </details>
);

/* The AI half of the verdict: the subject's score, or how many of the ring's accounts the classifier flags. */
function AiChip({ ev }: { ev: Evidence }) {
  const tone = (s: number) => ({ high: "bg-red-soft text-red", medium: "bg-amber-soft text-amber", low: "bg-bg text-muted" })[aiBand(s)];
  if (ev.ai) return <span className={`chip px-2 py-0.5 ${tone(ev.ai.score)}`}>AI: {pct(ev.ai.score)}% Mule</span>;
  const r = ev.ai_accounts;
  if (!r) return null;
  const hit = r.accounts.filter((a) => a.score >= 0.5).length;
  return <span className={`chip px-2 py-0.5 ${tone(hit / Math.max(1, r.accounts.length))}`}>AI: {hit}/{r.accounts.length} Accounts Flagged</span>;
}

const H = ({ children }: { children: ReactNode }) => (
  <h4 className="eyebrow border-t border-line px-4 pb-1.5 pt-3.5">{children}</h4>
);

type Answer = { q: string; body: ReactNode } | null;

/* The Evidence tab: the claim, the figures with their formulas, the transactions they rest on, and what's missing.
   Hovering a figure or a row lights exactly those transfers in the graph; clicking pins them. */
export function EvidenceView({ ev, pending, graph, setCite, openStr }:
  { ev: Evidence | null; pending: boolean; graph: Graph | null; setCite: (ids: string[]) => void; openStr: () => void }) {
  const [hover, setHover] = useState<string[] | null>(null);
  const [pinned, setPinned] = useState<string[]>([]);
  const [answer, setAnswer] = useState<Answer>(null);
  const id = ev?.alert_id ?? ev?.network_id;
  useEffect(() => { setPinned([]); setAnswer(null); }, [id]);
  useEffect(() => { setCite(hover ?? pinned); }, [hover, pinned, setCite]);
  useEffect(() => () => setCite([]), [setCite]);

  if (!ev) return (
    <div className="grid gap-3 p-4" aria-busy="true">
      <Skeleton className="h-3 w-28" /><Skeleton className="h-14" /><Skeleton className="h-24" /><Skeleton className="h-24" />
      <p className="sr-only" role="status">Loading evidence…</p>
    </div>
  );

  const lit = (ids: string[]) => ({
    onMouseEnter: () => setHover(ids), onMouseLeave: () => setHover(null),
    onFocus: () => setHover(ids), onBlur: () => setHover(null),
  });
  const pin = (ids: string[]) => setPinned((p) => (p.join() === ids.join() ? [] : ids));
  const isPinned = (ids: string[]) => pinned.length > 0 && pinned.join() === ids.join();

  const ask = async (n: NextQ) => {
    if (n.action === "str") { openStr(); return; }
    if (n.action === "trace") {
      const t = n.target!, money = (graph?.edges ?? []).filter((e) => e.kind === "money");
      const ins = money.filter((e) => e.target === t), outs = money.filter((e) => e.source === t);
      const sum = (xs: typeof money) => inr(xs.reduce((s, e) => s + (e.amount ?? 0), 0));
      setPinned([...ins, ...outs].map((e) => e.id));
      setAnswer({ q: n.q, body: (
        <div className="grid gap-1.5">
          <p><span className="text-muted">In · </span>{ins.length ? <>{ins.length} transfer{ins.length > 1 && "s"}, {sum(ins)} from {[...new Set(ins.map((e) => e.source))].map((a, i) => <span key={a}>{i > 0 && ", "}<AccountLink id={a} /></span>)}</> : "none in this trail"}</p>
          <p><span className="text-muted">Out · </span>{outs.length ? <>{outs.length} transfer{outs.length > 1 && "s"}, {sum(outs)} to {[...new Set(outs.map((e) => e.target))].map((a, i) => <span key={a}>{i > 0 && ", "}<AccountLink id={a} /></span>)}</> : "none in this trail"}</p>
          <p className="text-muted">Lit in the graph. Press Trace Flow there to replay them in time order.</p>
        </div>
      ) });
      return;
    }
    setAnswer({ q: n.q, body: <Skeleton className="h-12" /> });
    try {
      const c = await get<Compare>(`/compare?accounts=${n.accounts!.join(",")}`);
      setPinned([...c.accounts, ...c.direct_transfers.map((t) => t.id)]);
      setAnswer({ q: n.q, body: (
        <div className="grid gap-1.5">
          <ConfidenceTag c={c.confidence} />
          <p>{c.summary}</p>
          {c.direct_transfers.slice(0, 5).map((t) => (
            <p key={t.id} className="num text-[13px] text-ink-2" translate="no">
              [{t.id}] {clock(t.ts)} {t.sender} → {t.receiver} <span className="text-ink">{inr(t.amount)}</span>
            </p>
          ))}
          {c.shared_devices.map((d) => <p key={d.device} className="text-ink-2"><span translate="no" className="font-mono">{d.device}</span> used by {d.accounts.join(", ")}</p>)}
          {c.common_counterparties.length > 0 && <p className="text-ink-2">Common counterparties: {c.common_counterparties.slice(0, 4).map((x) => x.account).join(", ")}</p>}
        </div>
      ) });
    } catch {
      setAnswer({ q: n.q, body: <p className="text-red">Couldn’t reach the API. Try again.</p> });
    }
  };

  return (
    <div className={`flex-1 overflow-y-auto overscroll-contain transition-opacity duration-200 ${pending ? "opacity-40" : ""}`} aria-busy={pending}>
      <div className="grid gap-2.5 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span translate="no" className="tl text-muted">Verdict · {ev.alert_id ? `${ev.alert_id} · ${ev.account_id}` : ev.network_id}</span>
          <span className="flex flex-wrap gap-1.5"><ConfidenceTag c={ev.confidence} label="Rules" /><AiChip ev={ev} /></span>
        </div>
        <p className="font-sans text-[15px] leading-relaxed text-pretty text-ink">{ev.claim}</p>
        {ev.confidence === "insufficient" && (
          <div className="rounded-lg border border-red bg-red-soft">
            <p className="px-3 py-2 font-sans text-[14px] text-ink" role="note">
              Insufficient evidence to conclude. Don’t act on this alert alone. See the gaps below.
            </p>
          </div>
        )}
      </div>

      {ev.ai && <><H>Why · AI Classifier</H><AiPanel ai={ev.ai} /></>}
      {ev.ai_accounts && <><H>Why · AI Score per Account</H><AiRingList r={ev.ai_accounts} /></>}

      <H>Why · Rules</H>
      <ul className="pb-2">
        {ev.computations.map((c) => (
          <li key={`${c.pattern ?? ""}${c.name}`}>
            <button {...lit(c.inputs)} onClick={() => pin(c.inputs)} aria-pressed={isPinned(c.inputs)}
              className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-1.5 text-left transition-colors hover:bg-raised ${isPinned(c.inputs) ? "bg-raised" : ""}`}>
              <span className="tl truncate text-ink-2">{label(c.name)}</span>
              <span className="num font-mono text-[15px] font-semibold text-ink">{fmtValue(c)}</span>
              <span className="msg col-span-2 font-sans text-[13px] text-muted">
                = {c.formula} <span className="tl whitespace-nowrap text-[11.5px] text-ink-2">· {c.inputs.length} cited</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <Fold title={`Transactions Behind It · ${ev.transactions.length}`}>
      <ul className="font-mono text-[13px] uppercase">
        {ev.transactions.map((t) => (
          <li key={t.id} {...lit([t.id])} onClick={() => pin([t.id])}
            className={`grid cursor-pointer grid-cols-[46px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line px-4 py-1.5 transition-colors hover:bg-raised ${isPinned([t.id]) ? "bg-raised" : ""}`}>
            <time className="num text-muted" dateTime={t.ts} title={when(t.ts)}>{clock(t.ts)}</time>
            <span className="flex min-w-0 items-center gap-1.5">
              <AccountLink id={t.sender} /><span className="text-muted" aria-hidden>→</span><span className="sr-only">to</span><AccountLink id={t.receiver} />
              <span className="truncate text-[11.5px] text-muted">{t.why ?? t.relation}</span>
            </span>
            <span className="grid justify-items-end">
              <data value={t.amount} className="num text-ink">{inr(t.amount)}</data>
              <span translate="no" className="text-[11px] text-muted">{t.id}{t.relation === "trigger" && <span className="text-red"> · trigger</span>}</span>
            </span>
          </li>
        ))}
      </ul>

      </Fold>

      <Fold title={`What the Data Can’t Show · ${ev.gaps.length}`}>
      <ul className="grid gap-1 px-4 pb-3">
        {ev.gaps.map((g) => (
          <li key={g} className="flex gap-2 font-sans text-[14px] leading-snug text-ink-2"><span aria-hidden className="text-muted">•</span>{g}</li>
        ))}
      </ul>
      </Fold>

      <H>Ask Next</H>
      <div className="grid gap-px bg-line px-4 pb-3">
        {ev.next_questions.map((n) => (
          <button key={n.q} onClick={() => ask(n)}
            className={`msg bg-bg py-2 text-left font-sans text-[14px] text-ink transition-colors hover:text-red ${answer?.q === n.q ? "text-red" : ""}`}>
            <span aria-hidden className="tl mr-2 text-muted">?</span>{n.q}
          </button>
        ))}
      </div>
      {answer && (
        <div className="mx-4 mb-4 rounded-lg border border-line-hi bg-bg px-3 py-2.5 font-sans text-[14px] leading-snug text-ink" aria-live="polite">
          <p className="eyebrow mb-1.5">{answer.q}</p>
          {answer.body}
        </div>
      )}
    </div>
  );
}

/* STR completeness: what the evidence supports, and what an analyst still has to get before filing. */
export function Checklist({ items }: { items: Check[] }) {
  const ok = items.filter((i) => i.status === "supported").length;
  return (
    <div className="border-b border-line-hi px-4 py-3">
      <p className="tl text-muted">Completeness · <span className="text-ink">{ok} Supported</span> · <span className="text-red">{items.length - ok} Missing</span></p>
      <ul className="mt-2 grid gap-1">
        {items.map((i) => (
          <li key={i.item} className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2 font-sans font-mono text-[13px] uppercase leading-snug">
            <span aria-hidden className={i.status === "supported" ? "text-ink" : "text-red"}>{i.status === "supported" ? "■" : "□"}</span>
            <span>
              <span className="text-ink">{i.item}</span>
              <span className="sr-only">: {i.status}</span>
              <span className="text-muted"> · {i.status === "supported" ? i.evidence : <>Needs: {i.needs}</>}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* Side sheet shared by Policy and Ask Copilot: modal, Escape closes, focus returns to the opener. */
function Sheet({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const close = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {  // once per open: the live feed re-renders the parent several times a second
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); opener?.focus(); };
  }, []);
  return (
    <div className="fixed inset-0 z-[65] flex justify-end overscroll-contain bg-ink/25" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} onClick={(e) => e.stopPropagation()}
        className={`animate-enter flex h-full w-full flex-col border-l border-line-hi bg-panel shadow-[0_0_60px_rgba(0,0,0,0.12)] ${wide ? "max-w-xl" : "max-w-md"}`}>
        <div className="flex items-center gap-3 border-b border-line-hi px-4 py-3 pt-[max(12px,env(safe-area-inset-top,0px))]">
          <h2 className="tl text-ink">{title}</h2>
          <button ref={close} onClick={onClose} className="tl ml-auto bg-bg px-3 py-2 text-muted transition-colors hover:text-ink" aria-label="Close">
            <span aria-hidden>✕</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const RULE_HINT: Record<(typeof RULES)[number], string> = {
  structuring: "3+ cash deposits in the band within 24h", passthrough: "Most of a deposit sent on within 30 min",
  fan_in_out: "Many senders and receivers within 1h", dormant: "Long-quiet account suddenly moves money",
  shared_device: "Sends from a device other accounts use",
};
export const isDefaultPolicy = (p: Policy) => JSON.stringify({ ...p, rules: [...p.rules].sort() }) === JSON.stringify({ ...DEFAULT_POLICY, rules: [...DEFAULT_POLICY.rules].sort() });

/* Policy: tune the rules, replay them on today's data to see the consequence, then (and only then) switch them on. */
export function PolicySheet({ policy, onClose, onApplied }: { policy: Policy; onClose: () => void; onApplied: (p: Policy) => void }) {
  const [draft, setDraft] = useState<Policy>(policy);
  const [result, setResult] = useState<Replay | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "armed" | "error">("idle");
  const set = (patch: Partial<Policy>) => { setDraft((d) => ({ ...d, ...patch })); setResult(null); setState("idle"); };
  const toggle = (r: (typeof RULES)[number]) => set({ rules: draft.rules.includes(r) ? draft.rules.filter((x) => x !== r) : [...draft.rules, r] });
  const replay = async () => {
    setState("busy");
    try { setResult(await post<Replay>("/policy/replay", draft)); setState("idle"); } catch { setState("error"); }
  };
  const apply = async () => {
    if (state !== "armed") { setState("armed"); return; }
    try { await post("/policy/apply", draft); onApplied(draft); onClose(); } catch { setState("error"); }
  };
  const slider = (key: keyof Policy, text: string, min: number, max: number, step: number, show: (v: number) => string) => (
    <label className="grid gap-1.5 px-4 py-2.5">
      <span className="tl flex justify-between text-ink-2">{text}<output className="num text-ink">{show(draft[key] as number)}</output></span>
      <input type="range" min={min} max={max} step={step} value={draft[key] as number}
        onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<Policy>)} className="w-full accent-[var(--red)]" />
    </label>
  );
  const delta = (a: number, b: number) => <span className="num"><span className="text-ink-2">{a}</span> → <span className={b === a ? "text-ink" : "text-red"}>{b}</span></span>;
  return (
    <Sheet title="Detection Policy" onClose={onClose}>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <p className="px-4 pt-3 font-sans text-[14px] text-ink-2">Change a rule, replay it on today’s data, and see which alerts and rings you’d gain or lose before you switch it on.</p>
        <fieldset className="mt-2 border-t border-line">
          <legend className="tl px-4 pt-3 text-muted">Rules</legend>
          {RULES.map((r) => (
            <label key={r} className="flex cursor-pointer items-center gap-3 px-4 py-2 transition-colors hover:bg-raised">
              <input type="checkbox" role="switch" checked={draft.rules.includes(r)} onChange={() => toggle(r)} className="h-4 w-4 accent-[var(--red)]" />
              <span className="grid">
                <span className="tl text-ink">{PATTERN[r]}</span>
                <span className="font-sans text-[13px] text-muted">{RULE_HINT[r]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="border-t border-line pb-2">
          <legend className="tl px-4 pt-3 text-muted">Thresholds</legend>
          {slider("band_floor", "Structuring Band From", 30000, 49000, 1000, (v) => `${inr(v)}–₹49,999`)}
          {slider("pass_ratio", "Pass-Through Share", 0.5, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          {slider("min_pass", "Pass-Through Min Deposit", 10000, 500000, 10000, inr)}
          {slider("fan", "Fan Size (More Than)", 2, 20, 1, (v) => `${v} accts`)}
          {slider("dormant_days", "Dormant After", 30, 365, 5, (v) => `${v} days`)}
        </fieldset>
        {result && (
          <div className="mx-4 mb-4 rounded-lg border border-line-hi bg-bg px-3 py-3" aria-live="polite">
            <p className="tl text-muted">Replay on Today’s Data</p>
            <p className="macro mt-2 text-[26px] text-ink">Alerts {delta(result.before.alerts, result.after.alerts)}</p>
            <p className="macro mt-1 text-[26px] text-ink">Rings {delta(result.before.rings, result.after.rings)}</p>
            <ul className="mt-2.5 grid gap-1 font-sans font-mono text-[13px] uppercase text-ink-2">
              {result.lost_rings.length > 0 && <li><span className="text-red">Rings missed:</span> <span translate="no">{result.lost_rings.join(", ")}</span></li>}
              {result.removed.length > 0 && <li>Alerts dropped: <span translate="no">{result.removed.join(", ")}</span></li>}
              {result.added.length > 0 && <li>New accounts alerted: <span translate="no">{result.added.slice(0, 8).join(", ")}{result.added.length > 8 && ` +${result.added.length - 8}`}</span></li>}
              {result.new_rings > 0 && <li>New rings: {result.new_rings}</li>}
              {!result.lost_rings.length && !result.removed.length && !result.added.length && <li>No change on today’s data.</li>}
            </ul>
          </div>
        )}
        {state === "error" && <p className="mx-4 mb-3 font-sans text-[14px] text-red" role="alert">The API refused that or couldn’t be reached. Check it’s running, then try again.</p>}
      </div>
      <div className="grid grid-cols-3 gap-px border-t border-line-hi bg-line pb-[env(safe-area-inset-bottom,0px)]">
        <button onClick={() => set(DEFAULT_POLICY)} className="tl bg-bg py-3 text-ink-2 transition-colors hover:text-ink">Defaults</button>
        <button onClick={replay} disabled={state === "busy"} className="tl bg-ink py-3 font-semibold text-panel transition-opacity hover:opacity-90 disabled:opacity-50">
          {state === "busy" ? "Replaying…" : "Replay"}
        </button>
        <button onClick={apply} disabled={!result}
          title={result ? undefined : "Replay first, so you see the consequence"}
          className={`tl py-3 font-semibold transition-colors disabled:opacity-40 ${state === "armed" ? "bg-red text-panel" : "bg-panel text-red hover:bg-red-soft"}`}>
          {state === "armed" ? "Confirm Apply" : "Apply Live"}
        </button>
      </div>
    </Sheet>
  );
}

/* Ask Copilot: the Copilot Studio agent in a side sheet. Prompts for the current selection copy with one tap,
   since a cross-origin chat can't be typed into from here. */
export function CopilotSheet({ prompts, onClose }: { prompts: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (p: string) => {
    try { await navigator.clipboard.writeText(p); setCopied(p); setTimeout(() => setCopied(null), 1500); } catch { /* prompt stays readable */ }
  };
  return (
    <Sheet title={<>Ask Copilot · <span className="text-muted">Copilot Studio</span></>} onClose={onClose} wide>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2.5">
        {prompts.map((p) => (
          <button key={p} onClick={() => copy(p)} className="msg border border-line-hi bg-bg px-2 py-1 text-left font-sans text-[13px] text-ink transition-colors hover:border-ink">
            {copied === p ? "Copied. Paste it below" : p}
          </button>
        ))}
      </div>
      <iframe src={COPILOT_URL} title="MuleTrace Investigator, a Copilot Studio agent" className="min-h-0 w-full flex-1 border-0 bg-white" />
      <p className="tl px-4 py-2 text-[11.5px] text-muted">Answers come from MuleTrace’s rules through its API · Every figure cites transactions</p>
    </Sheet>
  );
}

const BAR: Record<string, string> = { high: "bg-red", medium: "bg-[var(--risk-1)]", low: "bg-muted" };
const FOUNDRY = "Microsoft Foundry endpoint";
const pct = (s: number) => Math.min(99, Math.max(1, Math.round(s * 100)));  // a model is never 0% or 100% sure

/* Explainable AI: the classifier's probability, and each behaviour's exact contribution to it (TreeSHAP).
   Bars diverge from a centre line: red pushes towards "mule", grey pushes towards "ordinary customer". */
export function AiPanel({ ai }: { ai: AiExplanation }) {
  const max = Math.max(0.5, ...ai.reasons.map((r) => Math.abs(r.contribution)));
  return (
    <div className="px-4 pb-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <output className="macro text-[40px] text-ink">{pct(ai.score)}<span className="text-[22px]">%</span></output>
          <p className="font-sans text-[13px] text-ink-2">Mule likelihood from the classifier</p>
        </div>
        <SevTag sev={aiBand(ai.score)} />
      </div>
      <ul className="mt-3 grid gap-2" aria-label="What moved the score, biggest first">
        {ai.reasons.map((r) => {
          const up = r.contribution > 0, w = (Math.abs(r.contribution) / max) * 50;
          return (
            <li key={r.feature} className="grid grid-cols-[minmax(0,1fr)_112px] items-center gap-3">
              <span className="font-sans text-[13.5px] leading-snug text-ink">{r.text}</span>
              <span className="relative h-3 rounded-sm bg-bg" role="img" aria-label={`${up ? "Raises" : "Lowers"} risk by ${Math.abs(r.contribution).toFixed(2)}`}>
                <span aria-hidden className="absolute inset-y-[-3px] left-1/2 w-px bg-line-hi" />
                <span aria-hidden className={`absolute inset-y-0 rounded-sm ${up ? "left-1/2 bg-red" : "right-1/2 bg-muted"}`} style={{ width: `${w}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="tl mt-1.5 flex justify-end gap-3 text-[11px] text-muted"><span>← Lowers Risk</span><span>Raises Risk →</span></p>
      <p className="mt-2 font-sans text-[12.5px] leading-snug text-muted">
        {ai.scored_by === FOUNDRY ? "Scored live by the Microsoft Foundry endpoint" : "Scored by the local copy of the model"} · LightGBM v{ai.model_version ?? 1} · exact SHAP contributions
        {ai.model?.holdout && <> · held-out AUC {ai.model.holdout.auc.toFixed(2)}</>}
        {ai.note && <span className="block text-red">{ai.note}</span>}
      </p>
    </div>
  );
}

export function AiRingList({ r }: { r: AiRing }) {
  return (
    <div className="pb-3">
      {r.ai_only.length > 0 && (
        <p className="mx-4 mb-2 rounded-lg bg-amber-soft px-3 py-2 font-sans text-[13.5px] leading-snug text-ink">
          The classifier also flags {r.ai_only.length === 1 ? "1 account" : `${r.ai_only.length} accounts`} that no rule alerted:{" "}
          {r.ai_only.map((a, i) => <span key={a}>{i > 0 && ", "}<AccountLink id={a} /></span>)}
        </p>
      )}
      <ul>
        {r.accounts.map((a) => (
          <li key={a.account_id} className="grid grid-cols-[76px_minmax(0,1fr)_42px] items-center gap-3 border-b border-line px-4 py-1.5">
            <AccountLink id={a.account_id} />
            <span className="min-w-0">
              <span className="block h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
                <span className={`block h-full rounded-full ${BAR[aiBand(a.score)]}`} style={{ width: `${Math.max(2, a.score * 100)}%` }} />
              </span>
              <span className="mt-1 block truncate font-sans text-[12.5px] text-ink-2">
                {a.top}{a.alerted && <span className="text-ink"> · alerted</span>}{a.source && " · source"}
              </span>
            </span>
            <span className="num text-right text-ink">{pct(a.score)}%</span>
          </li>
        ))}
      </ul>
      <p className="px-4 pt-2 font-sans text-[12.5px] text-muted">
        {r.scored_by === FOUNDRY ? "Scored live by the Microsoft Foundry endpoint" : "Scored by the local copy of the model"}. Open an account to see why.
      </p>
    </div>
  );
}

const STATUS_CHIP = { open: "bg-amber-soft text-amber", str_filed: "bg-sel text-sel-line", closed: "bg-green-soft text-green" } as const;

/* Cases: what happened after "Dismantle". Each case moves open → STR filed → closed, and every step is stamped
   in its audit trail. Below them, the feedback loop: analyst verdicts retrain the explainable classifier. */
export function CasesSheet({ snap, onClose, act }: { snap: Snapshot; onClose: () => void; act: (id: string, a: "file_str" | "close") => Promise<void> }) {
  const [cases, setCases] = useState<Case[] | null>(null);
  const [train, setTrain] = useState<"idle" | "busy" | string>("idle");
  const sig = snap.cases.map((c) => c.status).join();
  useEffect(() => { get<Case[]>("/cases").then(setCases).catch(() => setCases([])); }, [sig]);
  const labels = snap.labels.mule + snap.labels.not_mule;
  const retrain = async () => {
    setTrain("busy");
    try {
      const r = await post<{ version: number; analyst_labels: number; holdout: { auc: number } }>("/ai/retrain");
      setTrain(`Model v${r.version} live · learned from ${r.analyst_labels} analyst ${r.analyst_labels === 1 ? "label" : "labels"} · held-out AUC ${r.holdout.auc.toFixed(2)}`);
    } catch { setTrain("Couldn’t retrain. Is the API running?"); }
  };
  const btn = "tl rounded-md border px-3 py-1.5 transition-colors active:scale-[0.98]";
  return (
    <Sheet title="Cases & Model Feedback" onClose={onClose} wide>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {!cases ? <div className="p-4"><Skeleton className="h-24" /></div>
          : !cases.length ? <p className="p-4 font-sans text-[14px] text-ink-2">No cases yet. Pick a ring and press <b>Dismantle Ring</b>; its case appears here with every step logged.</p>
          : cases.map((c) => (
            <article key={c.case_id} className="border-b border-line px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 translate="no" className="macro text-[22px] text-ink">{c.case_id}</h3>
                <span className="tl text-muted">Ring {c.network_id}</span>
                <span className={`chip px-2 py-0.5 ${STATUS_CHIP[c.status]}`}>{CASE_STATUS[c.status]}</span>
                <span className="ml-auto flex gap-1.5">
                  {c.status === "open" && <button onClick={() => act(c.case_id, "file_str")} className={`${btn} border-ink bg-ink text-panel hover:opacity-90`}>File STR with FIU-IND</button>}
                  {c.status !== "closed" && <button onClick={() => act(c.case_id, "close")} className={`${btn} border-line-hi bg-panel text-ink hover:bg-raised`}>Close Case</button>}
                </span>
              </div>
              <p className="mt-1.5 font-sans text-[13.5px] text-ink-2">{c.frozen.length} {c.frozen.length === 1 ? "account" : "accounts"} locked · {c.review.length} sent to review{c.ack && <> · acknowledgement <span className="font-mono text-ink">{c.ack}</span></>}</p>
              <ol className="mt-2 grid gap-1 border-l-2 border-line pl-3" aria-label={`${c.case_id} audit trail`}>
                {c.events.map((e, i) => (
                  <li key={i} className="font-sans text-[13px] text-ink"><time className="tl mr-2 text-muted" dateTime={e.at}>{when(e.at)}</time>{e.text}</li>
                ))}
              </ol>
            </article>
          ))}
        <section className="m-4 rounded-lg border border-line-hi bg-bg p-4" aria-labelledby="fb-h">
          <h3 id="fb-h" className="eyebrow">Teach the Classifier</h3>
          <p className="mt-2 font-sans text-[14px] leading-snug text-ink">
            {labels ? <>{snap.labels.mule} confirmed {snap.labels.mule === 1 ? "mule" : "mules"} and {snap.labels.not_mule} cleared {snap.labels.not_mule === 1 ? "account" : "accounts"} from analysts.</>
              : "No analyst verdicts yet."} Dismantled rings count as confirmed; mark others in the Account tab.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button onClick={retrain} disabled={!labels || train === "busy"} className={`${btn} border-ink bg-ink text-panel hover:opacity-90 disabled:opacity-40`}>
              {train === "busy" ? "Retraining…" : `Retrain Model v${snap.model_version} → v${snap.model_version + 1}`}
            </button>
            {train !== "idle" && train !== "busy" && <p className="font-sans text-[13.5px] text-ink" role="status">{train}</p>}
          </div>
        </section>
      </div>
    </Sheet>
  );
}

/* Big QR for the projector: judges scan and land on /send. */
export function QrSheet({ onClose }: { onClose: () => void }) {
  const [svg, setSvg] = useState("");
  const url = typeof location === "undefined" ? "" : `${location.origin}/send`;
  const local = /localhost|127\.0\.0\.1/.test(url);
  useEffect(() => { QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#1f2328", light: "#ffffff" } }).then(setSvg).catch(() => {}); }, [url]);
  return (
    <Sheet title="Judges: Try to Fool It" onClose={onClose}>
      <div className="grid flex-1 content-start justify-items-center gap-4 overflow-y-auto p-6">
        <div className="w-full max-w-[320px] rounded-lg border border-line-hi bg-white p-3" role="img" aria-label={`QR code for ${url}`} dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="font-mono text-[15px] text-ink">{url}</p>
        <p className="max-w-sm text-center font-sans text-[14px] text-ink-2">Scan to send money into this live bank. Move it like a mule and watch the rules and the AI catch you here.</p>
        {local && <p className="max-w-sm rounded-lg bg-amber-soft px-3 py-2 font-sans text-[13px] text-ink">Phones can’t reach <b>localhost</b>. Open this dashboard through your laptop’s network address (see the README’s judge-phone setup) and this code updates itself.</p>}
        <a href="/send" target="_blank" rel="noopener" className="tl text-sel-line underline">Open the Phone Page Here ↗</a>
      </div>
    </Sheet>
  );
}

/* Analyst verdict: saved for the classifier's next retrain. */
export function Verdict({ id, label, onChange }: { id: string; label: boolean | null; onChange: (v: boolean | null) => void }) {
  const set = async (v: boolean | null) => {
    try { await post(`/account/${id}/label${v === null ? "" : `?mule=${v}`}`); onChange(v); } catch { /* button state stays as it was */ }
  };
  const b = "tl rounded-md border px-2.5 py-1.5 transition-colors";
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
      <span className="tl text-muted">Analyst Verdict</span>
      <button onClick={() => set(label === true ? null : true)} aria-pressed={label === true}
        className={`${b} ${label === true ? "border-red bg-red text-panel" : "border-line-hi bg-panel text-red hover:bg-red-soft"}`}>Confirm Mule</button>
      <button onClick={() => set(label === false ? null : false)} aria-pressed={label === false}
        className={`${b} ${label === false ? "border-green bg-green text-panel" : "border-line-hi bg-panel text-green hover:bg-green-soft"}`}>Not a Mule</button>
      {label !== null && <span className="font-sans text-[12.5px] text-muted">Saved. Retrain from Cases.</span>}
    </div>
  );
}
