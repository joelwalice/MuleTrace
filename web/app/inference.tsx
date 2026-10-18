"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ConfidenceTag } from "./evidence";
import { get, post, when, inr, type Confidence } from "./lib";
import { AccountLink, Skeleton } from "./ui";

/* The "Inferred" tab: what the records cannot show, possible return paths, and inferred relationships.
   Recorded transfers are solid in the graph; everything here is dashed or flagged, and says so. */
export type FirstHop = {
  finding_type: string; account_id: string; true_origin: "unknown"; first_observed_at: string; observed_incoming_count: number;
  status: "insufficient_evidence" | "under_review" | "supported_by_observed_data"; confidence: Confidence; explanation: string; limitations: string[];
  downstream_signals: { hops_observed: number; rapid_hops: number; rapid_threshold_minutes: number };
  downstream_path: { accounts: string[]; txn_ids: string[] };
  supporting_evidence: { txn_ids: string[]; observations: string[] };
  observation_window: { start: string; end: string; covers_lookback: boolean };
};
export type ReturnPath = {
  id: string; accounts: string[]; txn_ids: string[]; hops: number; elapsed_minutes: number; evidence_strength: "weak" | "moderate" | "strong";
  signals: string[]; amount_sent: number; amount_returned: number; amount_relation: string;
  timing: { waits_minutes: number[] };
};
export type ReturnResult = { origin: string; paths: ReturnPath[]; aggregate: { returned_total: number; sent_total: number; partial_returns: boolean }; truncated: string[] };
export type Suspected = {
  id: string; source: string; target: string; relationship_type: string; status: "suspected" | "under_review" | "corroborated" | "rejected";
  score: number; strength: string; statement: string; explanation: string; supporting_txn_ids: string[];
  alternative_explanations: string[]; missing_evidence: string[]; limitations: string[]; created_at: string;
  history: { at: string; actor: string; action: string; to_status: string; note: string }[];
};
export type Inference = {
  network_id: string; first_hop: FirstHop[];
  return_paths: { found: ReturnResult[]; origins_searched: string[]; truncated: string[]; limits: { max_depth: number; max_paths: number; max_span_hours: number | null }; statement: string };
  suspected: Suspected[];
};

export function useInference(netId: string | null | undefined, sig: string) {
  const [inf, setInf] = useState<Inference | null>(null);
  useEffect(() => {
    if (!netId) { setInf(null); return; }
    let live = true;
    get<Inference>(`/network/${netId}/inference`).then((d) => live && setInf(d)).catch(() => live && setInf(null));
    return () => { live = false; };
  }, [netId, sig]);
  return inf;
}

const H = ({ children }: { children: ReactNode }) => <h4 className="eyebrow border-t border-line px-4 pb-1.5 pt-3.5">{children}</h4>;
const STATUS = { suspected: "Suspected", under_review: "Under Review", corroborated: "Corroborated", rejected: "Rejected" } as const;
const SIGNAL = { returns_to_origin: "returns to origin", rapid_hop: "rapid hop", repeated_counterparty: "repeated counterparty", amount_similar: "similar amount",
  alerted_intermediary: "alerted intermediary", multiple_partial_returns: "several partial returns" } as Record<string, string>;

export function InferenceView({ inf, setCite }: { inf: Inference | null; setCite: (ids: string[]) => void }) {
  const lit = (ids: string[]) => ({ onMouseEnter: () => setCite(ids), onMouseLeave: () => setCite([]), onFocus: () => setCite(ids), onBlur: () => setCite([]) });
  const [analyst, setAnalyst] = useState("analyst");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Suspected[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setRows(inf?.suspected ?? null); }, [inf]);
  useEffect(() => () => setCite([]), [setCite]);

  if (!inf) return <div className="grid gap-3 p-4" aria-busy="true"><Skeleton className="h-3 w-28" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;

  const review = async (e: Suspected, decision: Suspected["status"]) => {
    try {
      const u = await post<Suspected>(`/suspected/${e.id}/review`, { decision, analyst, note: notes[e.id] ?? "" });
      setRows((rs) => (rs ?? []).map((r) => (r.id === u.id ? u : r))); setErr(null);
    } catch { setErr(decision === "corroborated" || decision === "rejected" ? "A note of at least 5 characters is required to corroborate or reject." : "Couldn’t save the decision."); }
  };

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain" role="region" aria-label="Observed facts, gaps and inferences">
      <p className="px-4 py-3 font-sans text-[13.5px] leading-snug text-ink-2">
        Recorded transfers are facts. Everything on this tab is a gap in the records or an inference from indirect evidence, and none of it is a transfer.
      </p>

      <H>Where the Records Begin · {inf.first_hop.length}</H>
      {inf.first_hop.map((f) => (
        <div key={f.account_id} {...lit(f.supporting_evidence.txn_ids)} className="border-b border-line px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span aria-hidden className="text-red">▲</span><span className="tl text-ink">Earliest observed: <AccountLink id={f.account_id} /></span>
            <ConfidenceTag c={f.confidence} />
          </div>
          <p className="mt-1 font-sans text-[14px] leading-snug text-ink">{f.explanation}</p>
          <p className="tl mt-1 text-muted">True origin: unknown · {f.observed_incoming_count} incoming in the records · first seen <time dateTime={f.first_observed_at}>{when(f.first_observed_at)}</time></p>
          <p className="tl mt-1 text-muted">Downstream, recorded: {f.downstream_signals.hops_observed} transfers, {f.downstream_signals.rapid_hops} within {f.downstream_signals.rapid_threshold_minutes} min of money arriving</p>
          <details className="mt-1"><summary className="tl cursor-pointer text-ink-2">What the data can’t show</summary>
            <ul className="mt-1 grid gap-1">{f.limitations.map((l) => <li key={l} className="flex gap-2 font-sans text-[13px] text-ink-2"><span aria-hidden>•</span>{l}</li>)}</ul>
          </details>
        </div>
      ))}

      <H>Possible Return Paths · {inf.return_paths.found.reduce((n, r) => n + r.paths.length, 0)}</H>
      <p className="px-4 pb-1 font-sans text-[13px] text-ink-2">{inf.return_paths.statement}</p>
      {!inf.return_paths.found.length && (
        <p className="px-4 pb-2 font-sans text-[13.5px] text-ink">No return path found for {inf.return_paths.origins_searched.length} origin(s) within depth {inf.return_paths.limits.max_depth}
          {inf.return_paths.limits.max_span_hours != null && <> and {inf.return_paths.limits.max_span_hours} h</>}. That does not show none exists.</p>
      )}
      {inf.return_paths.found.flatMap((r) => r.paths.map((p) => (
        <div key={p.id} {...lit(p.txn_ids)} className="border-b border-line px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[13px] uppercase">
            {p.accounts.map((a, i) => <span key={i} className="flex items-center gap-1.5">{i > 0 && <span aria-hidden className="text-muted">→</span>}<AccountLink id={a} /></span>)}
          </div>
          <p className="tl mt-1 text-muted">Possible return · not confirmed · {p.hops} hops over {p.elapsed_minutes} min · evidence {p.evidence_strength} (heuristic)</p>
          <p className="font-sans text-[13px] text-ink-2">Sent {inr(p.amount_sent)}, came back {inr(p.amount_returned)} ({p.amount_relation}). Signals: {p.signals.map((s) => SIGNAL[s] ?? s).join(", ")}. Irregular timing alone is not a signal.</p>
        </div>
      )))}
      {inf.return_paths.truncated.length > 0 && <p className="px-4 py-2 font-sans text-[13px] text-red">Search limits reached: {inf.return_paths.truncated.join(", ")}. There may be more paths.</p>}

      <H>Inferred Relationships · {rows?.length ?? 0}</H>
      <label className="flex items-center gap-2 px-4 pb-2"><span className="tl text-muted">Reviewing as</span>
        <input value={analyst} maxLength={64} onChange={(e) => setAnalyst(e.target.value)} className="tl w-40 border border-line-hi bg-bg px-2 py-1 text-ink" /></label>
      {err && <p className="px-4 pb-2 font-sans text-[13.5px] text-red" role="alert">{err}</p>}
      {!rows?.length && <p className="px-4 pb-3 font-sans text-[13.5px] text-ink-2">No inferred relationships touch this ring. Where evidence is too weak, the observations stay separate and nothing is inferred.</p>}
      {rows?.map((e) => (
        <article key={e.id} {...lit(e.supporting_txn_ids)} className="mx-4 mb-3 rounded-lg border border-dashed border-line-hi bg-bg px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip bg-amber-soft px-2 py-0.5 text-amber">Inferred · Not a Transfer</span>
            <span className="chip bg-panel px-2 py-0.5 text-ink-2">{STATUS[e.status]}</span>
            <span className="num ml-auto text-ink" title="Heuristic closeness, 0 to 1. Not a probability.">{e.score.toFixed(2)} · {e.strength}</span>
          </div>
          <p className="mt-1.5 font-mono text-[13px] uppercase"><AccountLink id={e.source} /> <span aria-hidden className="text-muted">⇢</span><span className="sr-only">possibly linked to</span> <AccountLink id={e.target} /></p>
          <p className="mt-1 font-sans text-[14px] leading-snug text-ink">{e.explanation}</p>
          <p className="mt-1 font-sans text-[13px] leading-snug text-ink-2">{e.statement}</p>
          <p className="tl mt-1 text-muted">Evidence: <span translate="no">{e.supporting_txn_ids.join(", ")}</span> · {e.id}</p>
          <details className="mt-1"><summary className="tl cursor-pointer text-ink-2">Alternative explanations and what’s missing</summary>
            <ul className="mt-1 grid gap-1">{[...e.alternative_explanations, ...e.missing_evidence, ...e.limitations].map((l) => <li key={l} className="flex gap-2 font-sans text-[13px] text-ink-2"><span aria-hidden>•</span>{l}</li>)}</ul>
          </details>
          <details className="mt-1"><summary className="tl cursor-pointer text-ink-2">Audit trail · {e.history.length}</summary>
            <ol className="mt-1 grid gap-1">{e.history.map((h, i) => <li key={i} className="font-sans text-[13px] text-ink-2"><time className="tl mr-2 text-muted" dateTime={h.at}>{when(h.at)}</time>{h.actor}: {h.action} → {h.to_status}{h.note && ` · ${h.note}`}</li>)}</ol>
          </details>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <input aria-label={`Note for ${e.id}`} placeholder="Note (required to corroborate or reject)" value={notes[e.id] ?? ""} maxLength={500}
              onChange={(ev) => setNotes((n) => ({ ...n, [e.id]: ev.target.value }))} className="tl min-w-0 flex-1 border border-line-hi bg-panel px-2 py-1 text-ink" />
            {(["under_review", "corroborated", "rejected"] as const).filter((d) => d !== e.status).map((d) => (
              <button key={d} onClick={() => review(e, d)} className="tl border border-line-hi bg-panel px-2 py-1 text-ink transition-colors hover:bg-raised">{STATUS[d]}</button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}