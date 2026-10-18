"""API for first-hop findings, return paths, closeness and suspected relationships.

Wire-up in app.py (3 lines, see PATCHES.md):
    from inference_api import build_router
    INFERENCE, add_suspected = build_router(LIVE)
    app.include_router(INFERENCE)

Read endpoints are safe for the Copilot tool list. The review endpoint changes state, so it is NOT a Copilot tool: an
analyst makes that decision. There is no authentication in the existing app; these endpoints inherit whatever the
deployment puts in front of it (CORS only today). Nothing here writes to the transaction ledger."""
import os
from bisect import bisect_left
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import relations as rel

CFG = rel.ClosenessConfig(half_life_days=float(os.environ.get("MULETRACE_HALF_LIFE_DAYS", 14)))
SCAN_DAYS = 30     # cash links are searched over the most recent bank days only: bounded work per refresh
REFRESH_EVERY = 25  # transactions between refreshes of the suspected-edge scan


class Review(BaseModel):
    decision: Literal["suspected", "under_review", "corroborated", "rejected"]
    analyst: str = Field(min_length=1, max_length=64, description="Who is making the decision (recorded in the audit trail)")
    note: str = Field("", max_length=500, description="Required (5+ characters) to corroborate or reject")


def build_router(live):
    r = APIRouter(tags=["relations"])
    cache = {}

    def lookup(table, key, what):
        if key not in table:
            raise HTTPException(404, f"No {what} {key}")
        return table[key]

    def coverage():
        t = live.txns
        return (t[0]["ts"], t[-1]["ts"]) if t else (live.clock, live.clock)

    def refresh():
        """Rescan recent cash events and sync suspected edges, at most every REFRESH_EVERY transactions."""
        n, store = len(live.txns), live.suspected
        if cache.get("store") is not store or cache.get("n", -REFRESH_EVERY) + REFRESH_EVERY <= n:
            txns = live.txns[:n]
            recent = txns[bisect_left(txns, live.clock - timedelta(days=SCAN_DAYS), key=rel.TS):]
            pairs = rel.cash_matches(recent, CFG)
            edges, insufficient = rel.build_suspected(pairs, live.inc, live.out, live.clock, CFG, live.devs)
            store.sync(edges, live.clock)
            cache.update(store=store, n=n, pairs=pairs, insufficient=insufficient)
        return cache

    def limits(max_depth, max_paths, max_span_hours, min_amount=0.0):
        return rel.ReturnLimits(max_depth=max_depth, max_paths=max_paths, min_amount=min_amount,
                                max_span=None if max_span_hours is None else timedelta(hours=max_span_hours))

    def add_suspected(graph, min_score=CFG.create_threshold):
        """Add inferred edges to a graph payload as kind='suspected', only between nodes already drawn."""
        refresh()
        ids = {n["id"] for n in graph["nodes"]}
        graph["edges"] += [dict(id=e["id"], source=e["source"], target=e["target"], kind="suspected", directed=True, score=e["score"],
                                status=e["status"], label="Inferred cash link (not a transfer)")
                           for e in live.suspected.list(min_score=min_score) if e["source"] in ids and e["target"] in ids]
        return graph

    D, P, S = Query(6, ge=2, le=12, description="Most transfers in a path"), Query(10, ge=1, le=50), Query(None, gt=0, description="Optional: longest hours from first transfer to return. Omit for no delay limit.")

    @r.get("/network/{network_id}/inference", operation_id="explainRingGaps",
           summary="What the ring's records cannot show: missing first hops, possible return paths, inferred relationships")
    def network_inference(network_id: str, max_depth: int = D, max_paths: int = P, max_span_hours: float | None = S):
        n = lookup(live.net_by, network_id, "network")
        inc, out, alerts = live.inc, live.out, live.alerts
        start, end = coverage()
        origins = sorted(set(n["alerted"]) | set(n["sources"]))[:12]
        lim, flagged = limits(max_depth, max_paths, max_span_hours), {a["account_id"] for a in alerts}
        searched = [rel.return_paths(o, out, lim, inc=inc, coverage=(start, end), alerted=flagged) for o in origins]
        members = set(n["accounts"])
        cache = refresh()
        return dict(
            network_id=network_id, observed_vs_inferred="first_hop and return_paths use recorded transfers only; suspected rows are inferences",
            first_hop=rel.first_hop_findings(n["edges"], inc, out, start, end),
            return_paths=dict(origins_searched=origins, limits=lim.describe(), found=[s for s in searched if s["paths"]],
                              truncated=sorted({x for s in searched for x in s["truncated"]}),
                              statement="Possible return paths are investigative signals, not confirmed tracing of the same money."),
            suspected=[e for e in live.suspected.list(include_rejected=True, limit=200) if e["source"] in members or e["target"] in members],
            insufficient=[x for x in cache["insufficient"] if x["account_a"] in members or x["account_b"] in members][:20])

    @r.get("/account/{account_id}/return-paths", operation_id="traceReturnPaths",
           summary="Possible routes back to this account through recorded transfers, any timing, bounded by the limits it reports")
    def account_return_paths(account_id: str, max_depth: int = D, max_paths: int = P, max_span_hours: float | None = S,
                             min_amount: float = Query(0, ge=0)):
        lookup(live.accounts, account_id, "account")
        return rel.return_paths(account_id, live.out, limits(max_depth, max_paths, max_span_hours, min_amount), inc=live.inc,
                                coverage=coverage(), alerted={a["account_id"] for a in live.alerts})

    @r.get("/closeness", operation_id="scoreCloseness",
           summary="Recency-weighted closeness between two accounts (0-1 heuristic, direction preserved, evidence listed)")
    def closeness(a: str, b: str, half_life_days: float | None = Query(None, ge=0.5, le=365)):
        a, b = a.strip().upper(), b.strip().upper()
        lookup(live.accounts, a, "account")
        lookup(live.accounts, b, "account")
        if a == b:
            raise HTTPException(422, "Give two different accounts")
        cfg = CFG if half_life_days is None else rel.ClosenessConfig(half_life_days=half_life_days)
        pairs = refresh()["pairs"]  # whole-population matches, so look-alikes among other accounts are counted
        return rel.closeness_score(a, b, live.inc, live.out, live.clock, cfg, devs=live.devs, cash_pairs=pairs)

    @r.get("/suspected", operation_id="listSuspectedEdges", summary="Inferred (not verified) relationships, strongest first")
    def suspected(status: Literal["suspected", "under_review", "corroborated", "rejected"] | None = None,
                  min_score: float = Query(0, ge=0, le=1), account: str | None = None, include_rejected: bool = False,
                  limit: int = Query(50, ge=1, le=200)):
        refresh()
        return dict(note="Every row is an inference from indirect evidence. None is a recorded transaction.",
                    edges=live.suspected.list(status, min_score, account and account.strip().upper(), include_rejected, limit))

    @r.get("/suspected/{edge_id}", operation_id="getSuspectedEdge", summary="One inferred relationship: evidence, limits, alternatives and its audit trail")
    def suspected_edge(edge_id: str):
        refresh()
        return lookup(live.suspected.edges, edge_id, "suspected relationship")

    @r.post("/suspected/{edge_id}/review", summary="Analyst decision on an inferred relationship (recorded in its audit trail). Never creates a transaction.")
    def review(edge_id: str, body: Review):
        try:
            e = live.suspected.review(edge_id, body.decision, body.analyst.strip(), body.note, live.clock)
        except KeyError:
            raise HTTPException(404, f"No suspected relationship {edge_id}")
        except rel.ReviewError as err:
            raise HTTPException(409, str(err))
        live.version += 1
        return e

    return r, add_suspected