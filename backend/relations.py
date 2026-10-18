"""MuleTrace relations: what the recorded transfers show, what they cannot show, and what may be inferred.

Three deterministic, side-effect-free analyses over the same per-account indexes the engine already builds
(`inc`, `out`: account -> ts-sorted list of transaction dicts), plus one small stateful store for analyst review:

1. first_hop_findings   the earliest OBSERVED account of a trail is not necessarily the true origin
2. return_paths         bounded, time-respecting search for POSSIBLE routes back to an originating account
3. closeness_score      recency-weighted account-to-account relationship strength from independent evidence
   build_suspected / SuspectedStore   inferred relationships kept apart from the verified ledger

Nothing here writes to the transaction ledger or mints a transaction. Every output that rests on inference says so.
"""
from __future__ import annotations

import hashlib
import math
from bisect import bisect_left, bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from operator import itemgetter

TS = itemgetter("ts")


def key(t):
    """Total order on transfers: time, then txn id. Equal timestamps are ordered by id (= ingest order),
    so path search is deterministic and never travels backward in time."""
    return (t["ts"], t["txn_id"])


def iso(x):
    return x.isoformat() if isinstance(x, datetime) else x


def _mins(td):
    return round(td.total_seconds() / 60, 1)


def _inr(x):  # same Indian digit grouping as muletrace.inr; copied so this module imports without building the demo bank
    s = str(round(x))
    h, t = s[:-3], s[-3:]
    while len(h) > 2:
        h, t = h[:-2], h[-2:] + "," + t
    return "₹" + (h + "," + t if h else t)


def _digest(*parts, n=10):
    return hashlib.sha1("|".join(map(str, parts)).encode()).hexdigest()[:n]


# =====================================================================================================================
# 1. First-hop blind spot
# =====================================================================================================================
@dataclass(frozen=True)
class FirstHopConfig:
    lookback: timedelta = timedelta(hours=72)   # history the dataset must cover before an account's first transfer
    rapid: timedelta = timedelta(minutes=30)    # a hop this quick after money arrived is noted as rapid pass-through
    max_edges: int = 40                         # cap on downstream transfers listed per finding


def _downstream(root, edges, first):
    """Edges reachable from the root's first transfer without going backward in time, and the minutes each
    sender held money after it last arrived. `edges` must be sorted by key()."""
    arrivals = {root: [first["ts"]]}
    got, waits = [], []
    for t in edges:
        s = t["sender_account"]
        if key(t) < key(first) or s not in arrivals:
            continue
        prior = [a for a in arrivals[s] if a <= t["ts"]]
        if not prior:
            continue
        if s != root:
            waits.append((t["txn_id"], _mins(t["ts"] - max(prior))))
        got.append(t)
        arrivals.setdefault(t["receiver_account"], []).append(t["ts"])
    return got, waits


def first_hop_findings(edges, inc, out, obs_start, obs_end, cfg=FirstHopConfig(), prior_activity=()):
    """One finding per earliest observed account of the trail `edges` (a ring's or alert's transfers).

    The earliest observed account is where the RECORDS begin, not necessarily where the money began. A finding is
    never evidence about the true source: `true_origin` is always "unknown" and no sender is ever invented.
    `prior_activity`: accounts known (from outside this dataset) to have been active before `obs_start`."""
    edges = sorted(edges, key=key)
    if not edges:
        return []
    receivers = {t["receiver_account"] for t in edges}
    roots = sorted({t["sender_account"] for t in edges} - receivers) or [edges[0]["sender_account"]]  # pure cycle: earliest sender
    prior = set(prior_activity)
    trail = {t["txn_id"] for t in edges}
    return [_first_hop(r, edges, trail, inc, out, obs_start, obs_end, cfg, r in prior) for r in roots]


def _first_hop(root, edges, trail, inc, out, start, end, cfg, prior):
    mine_in, mine_out = inc.get(root, []), out.get(root, [])
    first = next(t for t in edges if t["sender_account"] == root)
    down, waits = _downstream(root, edges, first)
    rapid = [w for w in waits if w[1] <= cfg.rapid.total_seconds() / 60]
    covered = first["ts"] - start >= cfg.lookback
    seen = min(mine_in + mine_out, key=key)
    inflow, outflow = sum(t["amount"] for t in mine_in), sum(t["amount"] for t in mine_out)
    limits = ["Zero observed incoming transfers is not proof that none occurred; it means none is present in the available records.",
              "The true source of the funds is unknown. It has not been inferred, and nothing was added to the transaction ledger."]
    outside = [t for t in mine_in if t["txn_id"] not in trail]
    if outside:
        kind, status, conf = "observed_incoming_outside_trail", "under_review", "insufficient"
        limits.append(f"{len(outside)} incoming transfer(s) to {root} exist in the dataset but fall outside this trail's filters "
                      "(minimum amount or time window). The trail may simply be truncated here; widen it before concluding anything.")
        why = f"{root} is the first account of this trail, but the dataset does hold incoming transfers to it that the trail excludes."
    elif mine_in:
        kind, status, conf = "earliest_observed_in_cycle", "under_review", "insufficient"
        limits.append(f"Every incoming transfer to {root} is part of this trail's own cycle, so the trail has no distinct source account.")
        why = f"{root} is the earliest observed account, but the trail loops back to it; the records show circulation, not where the money started."
    else:
        kind = "possible_missing_first_hop"
        weak = []
        if prior:
            weak.append(f"{root} is known to have been active before the dataset begins ({start:%d %b %H:%M}), so earlier funding may predate it.")
        if not covered:
            weak.append(f"The dataset begins only {_mins(first['ts'] - start)} minutes before {root}'s first transfer, shorter than the "
                        f"{_mins(cfg.lookback)}-minute lookback, so missing history may simply be outside the observation window.")
        if len(down) < 2:
            weak.append("Fewer than two recorded downstream transfers: too little to say anything about the path.")
        limits += weak
        status = "insufficient_evidence" if weak else "supported_by_observed_data"
        conf = "insufficient" if weak else "medium" if rapid else "low"
        why = (f"No incoming transfer to {root} is present in the available records "
               f"({start:%d %b %H:%M} to {end:%d %b %H:%M}), yet it sent {_inr(outflow)} on. "
               + ("The observed data supports that its funding is not recorded here; " if not weak else "The data cannot show whether its funding is missing; ")
               + "where the money came from remains unknown.")
    return dict(
        finding_type=kind, account_id=root, earliest_observed_account=root, true_origin="unknown",
        first_observed_at=iso(seen["ts"]), first_observed_txn=seen["txn_id"], first_transfer_in_trail=first["txn_id"],
        observed_incoming_count=len(mine_in), observed_incoming_ids=[t["txn_id"] for t in mine_in[:10]],
        observed_inflow=round(inflow, 2), observed_outflow=round(outflow, 2),
        observation_window=dict(start=iso(start), end=iso(end), covers_lookback=covered, lookback_minutes=_mins(cfg.lookback)),
        downstream_path=dict(accounts=list(dict.fromkeys(t["receiver_account"] for t in down))[:cfg.max_edges],
                             txn_ids=[t["txn_id"] for t in down][:cfg.max_edges], truncated=len(down) > cfg.max_edges),
        downstream_signals=dict(hops_observed=len(down), rapid_hops=len(rapid), rapid_threshold_minutes=_mins(cfg.rapid),
                                waits_minutes=[w[1] for w in waits][:cfg.max_edges]),
        supporting_evidence=dict(txn_ids=[first["txn_id"]] + [t["txn_id"] for t in down if t["txn_id"] != first["txn_id"]][:cfg.max_edges],
                                 observations=[f"{root} has {len(mine_in)} incoming and {len(mine_out)} outgoing transfers in the dataset",
                                               f"{len(down)} downstream transfer(s) follow its first transfer, {len(rapid)} within "
                                               f"{_mins(cfg.rapid)} minutes of money arriving"]),
        limitations=limits, confidence=conf, confidence_basis="qualitative heuristic label, not a calibrated probability",
        status=status, explanation=why)


# =====================================================================================================================
# 2. Possible return-to-origin paths
# =====================================================================================================================
@dataclass(frozen=True)
class ReturnLimits:
    """Every limit is echoed in the result. None means unlimited (bounded only by the dataset and the safeguards)."""
    max_depth: int = 6                      # most transfers in one path
    max_paths: int = 25                     # stop after this many paths
    max_branch: int = 25                    # outgoing transfers explored per account visit
    max_expansions: int = 20_000            # hard performance safeguard on search effort
    max_span: timedelta | None = None       # longest time from the origin's first transfer to the return; None = no delay limit
    window_start: datetime | None = None
    window_end: datetime | None = None
    min_amount: float = 0.0
    similar_tol: float = 0.15               # |returned/sent - 1| within this reads as "similar"; a label only, never a filter
    rapid: timedelta = timedelta(minutes=30)

    def describe(self):
        return dict(max_depth=self.max_depth, max_paths=self.max_paths, max_branch=self.max_branch,
                    max_expansions=self.max_expansions, max_span_hours=None if self.max_span is None else self.max_span.total_seconds() / 3600,
                    window_start=iso(self.window_start), window_end=iso(self.window_end), min_amount=self.min_amount,
                    similar_tol=self.similar_tol, rapid_minutes=_mins(self.rapid))


class _Stop(Exception):
    pass


def return_paths(origin, out, limits=ReturnLimits(), inc=None, coverage=None, alerted=()):
    """Time-respecting, bounded search for recorded routes that leave `origin` and come back to it.

    A route is a chain of recorded transfers, each strictly after the previous one in (time, txn id) order, over
    distinct accounts, ending at `origin`. Waits between hops may be any length (no delay cap unless `max_span` is set).
    A route is a POSSIBLE return path: matching amounts and ordering are investigative signals, not proof that the same
    money returned. `alerted`: accounts the rules already flagged, used as one independent signal."""
    lim, alerted = limits, set(alerted)
    st = dict(expansions=0, truncated=set())
    found = []

    def later(acct, last, t0):
        lst, res = out.get(acct, []), []
        for t in lst[bisect_left(lst, last[0], key=TS):]:
            if lim.window_end is not None and t["ts"] > lim.window_end:
                break
            if lim.max_span is not None and t["ts"] - t0 > lim.max_span:
                break
            if key(t) <= last or t["amount"] < lim.min_amount:
                continue
            res.append(t)
            if len(res) > lim.max_branch:
                break
        return res

    def dfs(acct, path, seen, t0):
        cands = later(acct, key(path[-1]), t0)
        if len(cands) > lim.max_branch:
            st["truncated"].add("max_branch")
            cands = cands[:lim.max_branch]
        for t in cands:
            st["expansions"] += 1
            if st["expansions"] > lim.max_expansions:
                st["truncated"].add("max_expansions")
                raise _Stop
            r = t["receiver_account"]
            if r == origin:
                found.append(path + [t])
                if len(found) >= lim.max_paths:
                    st["truncated"].add("max_paths")
                    raise _Stop
            elif r not in seen:
                if len(path) + 1 >= lim.max_depth:
                    st["truncated"].add("max_depth")
                    continue
                dfs(r, path + [t], seen | {r}, t0)

    starts = sorted((t for t in out.get(origin, []) if t["amount"] >= lim.min_amount and t["receiver_account"] != origin
                     and (lim.window_start is None or t["ts"] >= lim.window_start)
                     and (lim.window_end is None or t["ts"] <= lim.window_end)), key=key)
    try:
        for first in starts:
            st["expansions"] += 1
            if st["expansions"] > lim.max_expansions:
                st["truncated"].add("max_expansions")
                break
            dfs(first["receiver_account"], [first], {origin, first["receiver_account"]}, first["ts"])
    except _Stop:
        pass

    paths = [_describe_path(origin, p, out, lim, alerted) for p in found]
    finals = {p["txn_ids"][-1]: p["transfers"][-1]["amount"] for p in paths}
    firsts = {p["txn_ids"][0]: p["transfers"][0]["amount"] for p in paths}
    partial = len(finals) >= 2
    if partial:
        for p in paths:
            p["signals"].append("multiple_partial_returns")
            p["evidence_strength"] = _strength(p["signals"])
    sent, returned = sum(firsts.values()), sum(finals.values())
    linked = set(finals)
    unlinked = []
    if inc is not None and starts:
        unlinked = [t for t in inc.get(origin, []) if key(t) > key(starts[0]) and t["txn_id"] not in linked][:10]
    truncated = sorted(st["truncated"])
    if paths:
        status = "possible_return_paths_found"
    else:
        status = "none_found_within_limits" if truncated or lim.max_span or lim.window_start or lim.window_end else "none_found"
    return dict(
        origin=origin, status=status, limits=lim.describe(), truncated=truncated, expansions=st["expansions"],
        coverage=None if not coverage else dict(start=iso(coverage[0]), end=iso(coverage[1]),
                                                days=round((coverage[1] - coverage[0]).total_seconds() / 86400, 2)),
        paths=paths,
        aggregate=dict(return_transfers=len(finals), first_transfers_used=len(firsts), sent_total=round(sent, 2),
                       returned_total=round(returned, 2), returned_to_sent=round(returned / sent, 3) if sent else None,
                       partial_returns=partial),
        unlinked_incoming=[dict(txn_id=t["txn_id"], sender=t["sender_account"], amount=t["amount"], ts=iso(t["ts"]),
                                note="Arrived after the origin first sent money, but no recorded time-respecting chain from the origin "
                                     "leads to it within these limits. An observation, not a confirmed return.") for t in unlinked],
        statement=("These are possible return paths through recorded transfers. Matching amounts and ordering are investigative "
                   "signals; they do not show that the same money returned." if paths else
                   "No return path was found within these limits. That does not show that none exists: records outside the "
                   "dataset or beyond the limits are not searched."))


def _strength(signals):
    extra = len([s for s in signals if s != "returns_to_origin"])
    return "weak" if extra == 0 else "moderate" if extra == 1 else "strong"


def _describe_path(origin, path, out, lim, alerted):
    waits = [_mins(path[i]["ts"] - path[i - 1]["ts"]) for i in range(1, len(path))]
    accounts = [origin] + [t["receiver_account"] for t in path]
    sent, back = path[0]["amount"], path[-1]["amount"]
    ratio = back / sent if sent else None
    relation = ("unknown" if ratio is None else "similar" if abs(ratio - 1) <= lim.similar_tol
                else "reduced" if ratio < 1 else "exceeds")
    repeated = any(sum(1 for t in out.get(u, []) if t["receiver_account"] == v) >= 2 for u, v in zip(accounts, accounts[1:]))
    signals = ["returns_to_origin"]  # timing irregularity is deliberately NOT a signal
    if any(w <= lim.rapid.total_seconds() / 60 for w in waits):
        signals.append("rapid_hop")
    if repeated:
        signals.append("repeated_counterparty")
    if relation == "similar":
        signals.append("amount_similar")
    if alerted & set(accounts[1:-1]):
        signals.append("alerted_intermediary")
    ids = [t["txn_id"] for t in path]
    return dict(
        id="RP-" + _digest(*ids), label="possible_return_path", confirmed=False, attribution="not_established",
        accounts=accounts, txn_ids=ids,
        transfers=[dict(txn_id=t["txn_id"], sender=t["sender_account"], receiver=t["receiver_account"], amount=t["amount"],
                        ts=iso(t["ts"]), wait_minutes=None if i == 0 else waits[i - 1]) for i, t in enumerate(path)],
        hops=len(path), elapsed_minutes=_mins(path[-1]["ts"] - path[0]["ts"]),
        amount_sent=sent, amount_returned=back, amount_ratio=None if ratio is None else round(ratio, 3), amount_relation=relation,
        timing=dict(waits_minutes=waits, contributes_to_score=False,
                    note="Irregular waits are reported but are not evidence on their own."),
        signals=signals, evidence_strength=_strength(signals),
        strength_basis="count of independent signals besides the return itself; heuristic, not a probability")


# =====================================================================================================================
# 3. Recency-weighted closeness
# =====================================================================================================================
@dataclass(frozen=True)
class ClosenessConfig:
    """closeness is a heuristic investigative priority on [0, 1]. It is not a probability of guilt, proof of common
    ownership, or proof that specific money moved between two accounts."""
    half_life_days: float = 14.0            # recency_weight = exp(-lambda * age_days), lambda = ln 2 / half_life_days
    reliability: dict = field(default_factory=lambda: dict(direct_transfer=0.9, cash_link=0.35, shared_device=0.6,
                                                           common_counterparty=0.25))
    direct_weight: float = 0.5              # one recorded payment is common between strangers; repetition corroborates
    cash_out_channels: tuple = ("atm",)     # channels read as cash leaving the sender
    cash_in_channels: tuple = ("cash",)     # channels read as cash credited to the receiver
    max_gap: timedelta = timedelta(hours=24)
    amount_tol: float = 0.05                # |deposit - withdrawal| / withdrawal must be within this to be a candidate
    max_common: int = 5
    single_indirect_cap: float = 0.30       # no recorded interaction and one kind of evidence: never above "weak"
    indirect_cap: float = 0.60              # no recorded interaction at all: never above "moderate"
    create_threshold: float = 0.15          # a suspected edge needs at least this much after recency and evidence quality

    def __post_init__(self):
        if self.half_life_days <= 0:
            raise ValueError("half_life_days must be positive")

    @property
    def lam(self):
        return math.log(2) / self.half_life_days


def recency(ts, ref, cfg):
    age = max(0.0, (ref - ts).total_seconds() / 86400)
    return math.exp(-cfg.lam * age)


def strength(score):
    return "insufficient" if score < 0.10 else "weak" if score < 0.35 else "moderate" if score < 0.65 else "strong"


def cash_matches(txns, cfg=ClosenessConfig()):
    """Candidate (cash withdrawal, later similar cash deposit) pairs from a ts-sorted transaction list.

    Schema caveat: a transfer has a sender and a receiver, so a withdrawal is read as an `atm` transfer FROM an account and a
    deposit as a `cash` transfer INTO an account. A pair whose deposit was sent by the withdrawing account is a recorded transfer,
    not an inference, and is skipped. `ambiguity` counts how many look-alike matches compete for the same withdrawal or deposit:
    the more there are, the likelier a coincidence."""
    outs = [t for t in txns if t.get("channel") in cfg.cash_out_channels]
    ins = sorted((t for t in txns if t.get("channel") in cfg.cash_in_channels), key=key)
    pairs = []
    for w in outs:
        for d in ins[bisect_left(ins, w["ts"], key=TS):bisect_right(ins, w["ts"] + cfg.max_gap, key=TS)]:
            a, b = w["sender_account"], d["receiver_account"]
            if key(d) <= key(w) or a == b or d["sender_account"] == a or w["receiver_account"] == b or not w["amount"]:
                continue
            diff = abs(d["amount"] - w["amount"]) / w["amount"]
            if diff <= cfg.amount_tol:
                pairs.append(dict(w=w, d=d, a=a, b=b, diff=diff, gap=d["ts"] - w["ts"]))
    per_w, per_d = Counter(p["w"]["txn_id"] for p in pairs), Counter(p["d"]["txn_id"] for p in pairs)
    for p in pairs:
        p["ambiguity"] = max(per_w[p["w"]["txn_id"]], per_d[p["d"]["txn_id"]])
    return pairs


def _obs(oid, typ, sem, ts, txn_ids, weight, rel, ref, cfg, note, direct=False):
    rec = recency(ts, ref, cfg)
    return dict(id=oid, type=typ, semantics=sem, ts=ts, txn_ids=sorted(set(txn_ids)), weight=weight, reliability=rel,
                recency=rec, score=weight * rel * rec, direct=direct, note=note)


def _direct_obs(a, b, out, ref, cfg):
    res = {}
    for x, y in ((a, b), (b, a)):
        for t in out.get(x, []):
            if t["receiver_account"] == y and t["ts"] <= ref and t["txn_id"] not in res:
                res[t["txn_id"]] = _obs(f"direct_transfer:{t['txn_id']}", "direct_transfer", f"directed:{x}->{y}", t["ts"], [t["txn_id"]],
                                        cfg.direct_weight, cfg.reliability["direct_transfer"], ref, cfg,
                                        f"Recorded transfer of {_inr(t['amount'])} from {x} to {y}", direct=True)
    return list(res.values())


def _cash_obs(pairs, a, b, ref, cfg):
    res = []
    for p in pairs:
        if (p["a"], p["b"]) not in ((a, b), (b, a)) or p["d"]["ts"] > ref:
            continue
        d_ratio, g_ratio = min(1.0, p["diff"] / cfg.amount_tol), min(1.0, p["gap"] / cfg.max_gap)
        w = (1 - 0.5 * d_ratio) * (1 - 0.5 * g_ratio) / p["ambiguity"]
        res.append(_obs(f"cash_link:{p['w']['txn_id']}+{p['d']['txn_id']}", "cash_link", f"directed:{p['a']}->{p['b']}", p["d"]["ts"],
                        [p["w"]["txn_id"], p["d"]["txn_id"]], w, cfg.reliability["cash_link"], ref, cfg,
                        f"{p['a']} cash out {_inr(p['w']['amount'])}, then {p['b']} credited {_inr(p['d']['amount'])} in cash "
                        f"{_mins(p['gap'])} min later ({p['ambiguity']} look-alike match(es)); source of the deposited cash unverified"))
    return res


def _latest_by(acct, out, ref, field_):
    last = {}
    for t in out.get(acct, []):
        if t["ts"] <= ref and t.get(field_):
            last[t[field_]] = t
    return last


def _device_obs(a, b, out, ref, cfg, devs):
    la, lb = _latest_by(a, out, ref, "device_id"), _latest_by(b, out, ref, "device_id")
    res = []
    for d in sorted(set(la) & set(lb)):
        n = len(devs[d]) if devs and d in devs else 2
        ta, tb = la[d], lb[d]
        res.append(_obs(f"shared_device:{d}", "shared_device", "undirected", min(ta["ts"], tb["ts"]), [ta["txn_id"], tb["txn_id"]],
                        1 / math.sqrt(max(1, n - 1)), cfg.reliability["shared_device"], ref, cfg,
                        f"Both accounts sent from device {d}" + (f", which {n} accounts use" if n > 2 else "")))
    return res, bool(la), bool(lb)


def _counterparties(acct, inc, out, ref):
    last = {}
    for t in out.get(acct, []):
        if t["ts"] <= ref:
            last[t["receiver_account"]] = t
    for t in inc.get(acct, []):
        if t["ts"] <= ref and (t["sender_account"] not in last or key(t) > key(last[t["sender_account"]])):
            last[t["sender_account"]] = t
    return last


def _common_obs(a, b, inc, out, ref, cfg):
    ca, cb = _counterparties(a, inc, out, ref), _counterparties(b, inc, out, ref)
    res = []
    for x in sorted((set(ca) & set(cb)) - {a, b}):
        deg = len({t["receiver_account"] for t in out.get(x, [])} | {t["sender_account"] for t in inc.get(x, [])})
        ta, tb = ca[x], cb[x]
        res.append(_obs(f"common_counterparty:{x}", "common_counterparty", "undirected", min(ta["ts"], tb["ts"]), [ta["txn_id"], tb["txn_id"]],
                        1 / math.log2(2 + deg), cfg.reliability["common_counterparty"], ref, cfg,
                        f"Both transacted with {x}, which has {deg} counterparties"))
    return sorted(res, key=lambda o: (-o["score"], o["id"]))[:cfg.max_common]


def _select(obs):
    """A transaction supports at most one counted observation, so an inference derived from a transaction never
    counts as evidence independent of that transaction. Strongest observation wins; the rest are discounted."""
    used, kept, dropped = set(), [], []
    for o in sorted(obs, key=lambda o: (-o["score"], o["id"])):
        if used & set(o["txn_ids"]):
            dropped.append((o, "shares a transaction with stronger evidence that is already counted"))
        else:
            used |= set(o["txn_ids"])
            kept.append(o)
    return kept, dropped


def _combine(obs, cfg):
    """Noisy-OR over de-duplicated observations, then capped by evidence quality: without any recorded interaction,
    one kind of indirect evidence can never exceed `single_indirect_cap`, and no mix can exceed `indirect_cap`.
    Recency only ever multiplies by <= 1, so it can fade a score but can never raise it past a cap."""
    if not obs:
        return dict(score=0.0, raw=0.0, cap=None, capped=False)
    miss = 1.0
    for o in obs:
        miss *= 1 - o["score"]
    raw = 1 - miss
    direct, kinds = any(o["direct"] for o in obs), {o["type"] for o in obs}
    cap = 1.0 if direct else cfg.indirect_cap if len(kinds) >= 2 else cfg.single_indirect_cap
    return dict(score=min(raw, cap), raw=raw, cap=cap, capped=raw > cap)


def _public(o):
    return dict(id=o["id"], type=o["type"], semantics=o["semantics"], observed_at=iso(o["ts"]), txn_ids=o["txn_ids"],
                direct=o["direct"], weight=round(o["weight"], 4), reliability=o["reliability"], recency_weight=round(o["recency"], 4),
                contribution=round(o["score"], 4), note=o["note"])


def closeness_score(a, b, inc, out, ref_time, cfg=ClosenessConfig(), devs=None, cash_pairs=None):
    """Recency-weighted relationship strength between two accounts, 0 to 1, as of `ref_time`.

    Per observation: score_i = weight_i * reliability_i * exp(-lambda * age_days_i). Observations are de-duplicated by
    underlying transaction, combined by noisy-OR, then capped by evidence quality (see _combine). Direction is preserved:
    `components` keeps a->b, b->a and undirected evidence apart; `score` is the direction-agnostic total.
    `devs`: device -> accounts using it (to discount public devices). `cash_pairs`: precomputed cash_matches over the whole
    population, so look-alike matches among OTHER accounts are counted; when omitted only these two accounts are inspected."""
    if a == b:
        raise ValueError("closeness needs two different accounts")
    obs = _direct_obs(a, b, out, ref_time, cfg)
    if cash_pairs is None:
        pool = {t["txn_id"]: t for x in (a, b) for t in inc.get(x, []) + out.get(x, [])}
        cash_pairs = cash_matches(sorted(pool.values(), key=key), cfg)
    obs += _cash_obs(cash_pairs, a, b, ref_time, cfg)
    dev, had_a, had_b = _device_obs(a, b, out, ref_time, cfg, devs)
    obs += dev
    obs += _common_obs(a, b, inc, out, ref_time, cfg)
    unavailable = []
    for x, had in ((a, had_a), (b, had_b)):
        if not had:
            unavailable.append(dict(evidence="shared_device", reason=f"no device identifier is recorded for {x}; no device link was inferred"))
    kept, dropped = _select(obs)
    sem = lambda s: [o for o in kept if o["semantics"] == s]
    comp = {"a_to_b": _combine(sem(f"directed:{a}->{b}"), cfg), "b_to_a": _combine(sem(f"directed:{b}->{a}"), cfg),
            "undirected": _combine(sem("undirected"), cfg)}
    total = _combine(kept, cfg)
    return dict(
        account_a=a, account_b=b, reference_time=iso(ref_time), score=round(total["score"], 4), strength=strength(total["score"]),
        score_kind="heuristic closeness on [0, 1]; not a probability", capped=total["capped"], cap=total["cap"],
        components={k: round(v["score"], 4) for k, v in comp.items()},
        component_semantics=dict(a_to_b=f"evidence of money or cash moving {a} -> {b}, as a hypothesis unless a recorded transfer",
                                 b_to_a=f"same, {b} -> {a}", undirected="evidence of a relationship with no established direction of money"),
        observations=[_public(o) for o in sorted(kept, key=lambda o: (-o["score"], o["id"]))],
        discounted=[dict(_public(o), reason=r) for o, r in dropped], unavailable=unavailable,
        config=dict(half_life_days=cfg.half_life_days, lambda_per_day=round(cfg.lam, 6), reliability=cfg.reliability,
                    single_indirect_cap=cfg.single_indirect_cap, indirect_cap=cfg.indirect_cap),
        limitations=["Not a probability of guilt, proof of common ownership, or proof that specific funds moved.",
                     "Only evidence present in this dataset is used; missing records lower coverage, not the score's honesty.",
                     "Similar cash amounts at nearby times are common among unrelated people; look-alike matches reduce weight."])


def closeness(a, b, inc, out, ref_time, **kw):
    return closeness_score(a, b, inc, out, ref_time, **kw)["score"]


# =====================================================================================================================
# 4. Suspected relationships: kept apart from the verified ledger
# =====================================================================================================================
METHOD = "cash_withdrawal_deposit_match v1"
ALTERNATIVES = ["Two unrelated people made cash transactions of similar size close together in time.",
                "The withdrawn cash was spent, kept, or deposited elsewhere; the deposited cash may have come from another source.",
                "Both accounts belong to customers of the same business or branch routine."]
MISSING = ["No recorded transfer between the two accounts", "The source of the deposited cash is unverified",
           "No branch, CCTV or counterparty records are in this dataset"]


def suspected_id(rel_type, a, b):
    return "SE-" + _digest(rel_type, a, b)


def build_suspected(pairs, inc, out, ref_time, cfg=ClosenessConfig(), devs=None):
    """Turn candidate cash links into suspected edges. Returns (edges, insufficient). An edge is created only if the
    de-duplicated, recency-weighted evidence reaches `create_threshold`; otherwise the observations stay separate
    events and the pair is returned in `insufficient`. A suspected edge is never a transaction."""
    groups = defaultdict(list)
    for p in pairs:
        if p["d"]["ts"] <= ref_time:
            groups[(p["a"], p["b"])].append(p)
    edges, insufficient = [], []
    for (a, b), ps in sorted(groups.items()):
        r = closeness_score(a, b, inc, out, ref_time, cfg, devs=devs, cash_pairs=ps)
        cash = [o for o in r["observations"] if o["type"] == "cash_link" and o["semantics"] == f"directed:{a}->{b}"]
        txns = sorted({i for o in r["observations"] for i in o["txn_ids"]})
        if not cash or r["score"] < cfg.create_threshold:
            insufficient.append(dict(account_a=a, account_b=b, txn_ids=sorted({i for p in ps for i in (p["w"]["txn_id"], p["d"]["txn_id"])}),
                                     score=r["score"], result="insufficient_evidence",
                                     reason="Evidence is too weak or too old after recency decay and ambiguity; recorded as separate events, no relationship inferred."))
            continue
        best = cash[0]
        edges.append(dict(
            id=suspected_id("possible_cash_link", a, b), relationship_type="possible_cash_link", inferred=True, verified=False,
            directed=True, source=a, target=b, status="suspected", created_at=iso(ref_time), evaluated_at=iso(ref_time),
            statement=f"INFERRED relationship, not a recorded transfer. No transaction from {a} to {b} exists in the records, "
                      "and the source of the cash deposited by the target is unverified.",
            method=METHOD, method_params=dict(max_gap_hours=cfg.max_gap.total_seconds() / 3600, amount_tolerance=cfg.amount_tol,
                                              half_life_days=cfg.half_life_days),
            score=r["score"], score_kind=r["score_kind"], strength=r["strength"], capped=r["capped"], components=r["components"],
            supporting_txn_ids=txns, evidence=r["observations"], discounted=r["discounted"],
            explanation=best["note"] + f". Heuristic closeness {r['score']:.2f} ({r['strength']}) after recency weighting.",
            alternative_explanations=ALTERNATIVES, missing_evidence=MISSING, limitations=r["limitations"] + [u["reason"] for u in r["unavailable"]], history=[]))
    return edges, insufficient


class ReviewError(ValueError):
    pass


class SuspectedStore:
    """In-memory suspected relationships with an audit trail. It holds inferences only; it can't reach the ledger."""
    STATUSES = ("suspected", "under_review", "corroborated", "rejected")
    KEEP = {"status", "history", "created_at", "new_evidence_since_rejection"}

    def __init__(self):
        self.edges = {}

    def sync(self, candidates, now):
        for c in candidates:
            old = self.edges.get(c["id"])
            if old is None:
                c["history"] = [dict(at=iso(now), actor="engine", action="created", from_status=None, to_status="suspected",
                                     note=f"{c['method']}; evidence {', '.join(c['supporting_txn_ids'])}")]
                self.edges[c["id"]] = c
                continue
            changed = set(old["supporting_txn_ids"]) != set(c["supporting_txn_ids"])
            old.update({k: v for k, v in c.items() if k not in self.KEEP})
            if changed:
                old["history"].append(dict(at=iso(now), actor="engine", action="evidence_updated", from_status=old["status"],
                                           to_status=old["status"], note=f"evidence now {', '.join(c['supporting_txn_ids'])}"))
                if old["status"] == "rejected":
                    old["new_evidence_since_rejection"] = True

    def review(self, edge_id, decision, analyst, note, now):
        e = self.edges.get(edge_id)
        if e is None:
            raise KeyError(edge_id)
        if decision not in self.STATUSES:
            raise ReviewError(f"decision must be one of {', '.join(self.STATUSES)}")
        if decision in ("corroborated", "rejected") and len(note.strip()) < 5:
            raise ReviewError(f"A note is required to mark an inferred relationship {decision}")
        if decision == e["status"]:
            raise ReviewError(f"Already {decision}")
        e["history"].append(dict(at=iso(now), actor=analyst, action="review", from_status=e["status"], to_status=decision, note=note.strip()))
        e["status"] = decision
        if decision != "rejected":
            e["new_evidence_since_rejection"] = False
        return e

    def get(self, edge_id):
        return self.edges.get(edge_id)

    def list(self, status=None, min_score=0.0, account=None, include_rejected=False, limit=100):
        rows = [e for e in self.edges.values()
                if (status is None or e["status"] == status) and (include_rejected or status == "rejected" or e["status"] != "rejected")
                and e["score"] >= min_score and (account is None or account in (e["source"], e["target"]))]
        return sorted(rows, key=lambda e: (-e["score"], e["id"]))[:limit]