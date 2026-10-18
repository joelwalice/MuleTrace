"""Run: python3 backend/tests/test_relations.py -v   (or pytest backend/tests). Synthetic data only."""
import json
import math
import os
import random
import sys
import unittest
from collections import defaultdict
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # the backend modules
import relations as R

T0 = datetime(2026, 10, 1, 9, 0)


def build(rows):
    """rows: (txn_id, sender, receiver, amount, ts_offset_minutes[, channel[, device]]) -> txns, inc, out, devs."""
    txns = []
    for r in rows:
        i, s, d, amt, off = r[:5]
        txns.append(dict(txn_id=i, sender_account=s, receiver_account=d, amount=amt, ts=T0 + timedelta(minutes=off),
                         channel=r[5] if len(r) > 5 else "imps", device_id=r[6] if len(r) > 6 else None))
    txns.sort(key=R.key)
    inc, out, devs = defaultdict(list), defaultdict(list), defaultdict(set)
    for t in txns:
        out[t["sender_account"]].append(t)
        inc[t["receiver_account"]].append(t)
        if t["device_id"]:
            devs[t["device_id"]].add(t["sender_account"])
    return txns, inc, out, devs


def valid(tc, p, by_id):
    ts = [by_id[i] for i in p["txn_ids"]]
    tc.assertEqual([R.key(t) for t in ts], sorted(R.key(t) for t in ts), "path must not go backward in time")
    tc.assertEqual(ts[0]["sender_account"], p["accounts"][0])
    tc.assertEqual(ts[-1]["receiver_account"], p["accounts"][0])
    for x, y in zip(ts, ts[1:]):
        tc.assertEqual(x["receiver_account"], y["sender_account"])


class FirstHop(unittest.TestCase):
    long_cover = ("X1", "Z1", "Z2", 10, -14 * 24 * 60)  # unrelated transfer 14 days earlier: dataset covers the lookback

    def run_case(self, rows, **kw):
        txns, inc, out, _ = build(rows)
        ids = {t["txn_id"] for t in txns}
        edges = [t for t in txns if t["txn_id"].startswith("T")]
        f = R.first_hop_findings(edges, inc, out, txns[0]["ts"], txns[-1]["ts"], **kw)
        return f, ids, len(txns)

    def test_a_complete_path_earliest_observed_not_claimed_origin(self):
        f, ids, _ = self.run_case([self.long_cover, ("T1", "A", "B", 9e4, 0), ("T2", "B", "C", 9e4, 10)])
        self.assertEqual([x["account_id"] for x in f], ["A"])
        self.assertEqual(f[0]["true_origin"], "unknown")
        self.assertEqual(f[0]["earliest_observed_account"], "A")
        self.assertEqual(f[0]["observed_incoming_count"], 0)

    def test_b_missing_first_transfer_not_fabricated(self):
        f, ids, n = self.run_case([self.long_cover, ("T2", "B", "C", 9e4, 10), ("T3", "C", "D", 9e4, 20)])
        self.assertEqual(f[0]["account_id"], "B")
        self.assertEqual(f[0]["finding_type"], "possible_missing_first_hop")
        self.assertNotIn('"A"', json.dumps(f))                                   # no invented sender
        self.assertTrue(set(f[0]["supporting_evidence"]["txn_ids"]) <= ids)      # only ledger ids
        self.assertEqual(n, 3)                                                   # ledger untouched

    def test_c_window_vs_absence(self):
        rows = [("T2", "B", "C", 9e4, 10), ("T3", "C", "D", 9e4, 20)]
        short, *_ = self.run_case(rows)                                          # dataset starts 10 min before B's first transfer
        self.assertEqual(short[0]["status"], "insufficient_evidence")
        self.assertFalse(short[0]["observation_window"]["covers_lookback"])
        self.assertTrue(any("observation window" in s for s in short[0]["limitations"]))
        long, *_ = self.run_case([self.long_cover] + rows)
        self.assertEqual(long[0]["status"], "supported_by_observed_data")
        prior, *_ = self.run_case([self.long_cover] + rows, prior_activity={"B"})
        self.assertEqual(prior[0]["status"], "insufficient_evidence")
        self.assertTrue(any("before the dataset begins" in s for s in prior[0]["limitations"]))

    def test_d_downstream_reported_separately(self):
        f, *_ = self.run_case([self.long_cover, ("T1", "B", "C", 9e4, 0), ("T2", "C", "D", 9e4, 5), ("T3", "D", "E", 9e4, 9)])
        x = f[0]
        self.assertEqual(x["downstream_signals"]["rapid_hops"], 2)
        self.assertEqual(x["downstream_path"]["accounts"], ["C", "D", "E"])
        self.assertEqual(x["status"], "supported_by_observed_data")
        self.assertEqual(x["confidence"], "medium")
        self.assertIn("confidence_basis", x)

    def test_incoming_outside_trail_is_not_a_missing_first_hop(self):
        f, *_ = self.run_case([self.long_cover, ("S1", "Q", "B", 100, -50), ("T1", "B", "C", 9e4, 0), ("T2", "C", "D", 9e4, 5)])
        self.assertEqual(f[0]["finding_type"], "observed_incoming_outside_trail")
        self.assertEqual(f[0]["observed_incoming_count"], 1)

    def test_pure_cycle_still_terminates_with_a_root(self):
        f, *_ = self.run_case([self.long_cover, ("T1", "A", "B", 1, 0), ("T2", "B", "A", 1, 5)])
        self.assertEqual(len(f), 1)
        self.assertEqual(f[0]["finding_type"], "earliest_observed_in_cycle")   # its own return leg is not "outside the trail"
        self.assertEqual(f[0]["true_origin"], "unknown")


class ReturnPaths(unittest.TestCase):
    def go(self, rows, origin="A", **lim):
        txns, inc, out, _ = build(rows)
        res = R.return_paths(origin, out, R.ReturnLimits(**lim), inc=inc)
        by = {t["txn_id"]: t for t in txns}
        for p in res["paths"]:
            valid(self, p, by)
        return res

    def test_complete_cycle(self):
        r = self.go([("1", "A", "B", 100, 0), ("2", "B", "C", 100, 10), ("3", "C", "A", 100, 20)])
        self.assertEqual([p["txn_ids"] for p in r["paths"]], [["1", "2", "3"]])
        p = r["paths"][0]
        self.assertEqual((p["label"], p["confirmed"], p["attribution"]), ("possible_return_path", False, "not_established"))
        self.assertIn("possible return paths", r["statement"])

    def test_irregular_intervals_and_no_default_delay_cap(self):
        rows = [("1", "A", "B", 100, 0), ("2", "B", "C", 100, 3 * 60), ("3", "C", "D", 100, 3 * 60 + 24 * 60),
                ("4", "D", "A", 100, 3 * 60 + 24 * 60 + 6 * 24 * 60)]
        r = self.go(rows)
        self.assertEqual(len(r["paths"]), 1)
        self.assertEqual(r["paths"][0]["timing"]["waits_minutes"], [180, 1440, 8640])
        self.assertFalse(r["paths"][0]["timing"]["contributes_to_score"])
        short = self.go(rows, max_span=timedelta(days=2))                       # an explicit, reported limit
        self.assertEqual(short["paths"], [])
        self.assertEqual(short["limits"]["max_span_hours"], 48)
        self.assertEqual(short["status"], "none_found_within_limits")

    def test_irregular_timing_alone_adds_no_strength(self):
        r = self.go([("1", "A", "B", 100, 0), ("2", "B", "C", 100, 700), ("3", "C", "D", 100, 9000), ("4", "D", "A", 40, 20000)])
        self.assertEqual(r["paths"][0]["signals"], ["returns_to_origin"])
        self.assertEqual(r["paths"][0]["evidence_strength"], "weak")

    def test_several_intermediaries(self):
        r = self.go([(str(i), "ABCDEF"[i], "ABCDEF"[(i + 1) % 6], 50, i * 7) for i in range(6)])
        self.assertEqual(r["paths"][0]["hops"], 6)

    def test_partial_returns_not_double_counted(self):
        r = self.go([("1", "A", "B", 1000, 0), ("2", "B", "C", 1000, 5), ("3", "C", "A", 400, 30), ("4", "C", "A", 500, 90)])
        self.assertEqual(len(r["paths"]), 2)
        agg = r["aggregate"]
        self.assertTrue(agg["partial_returns"])
        self.assertEqual((agg["sent_total"], agg["returned_total"], agg["returned_to_sent"]), (1000, 900, 0.9))
        self.assertTrue(all("multiple_partial_returns" in p["signals"] for p in r["paths"]))

    def test_amount_differs(self):
        r = self.go([("1", "A", "B", 1000, 0), ("2", "B", "A", 300, 10)])
        self.assertEqual((r["paths"][0]["amount_relation"], r["paths"][0]["amount_ratio"]), ("reduced", 0.3))
        r = self.go([("1", "A", "B", 1000, 0), ("2", "B", "A", 1100, 10)])
        self.assertEqual(r["paths"][0]["amount_relation"], "similar")

    def test_coincidental_incoming_is_not_a_return(self):
        r = self.go([("1", "A", "B", 1000, 0), ("2", "B", "C", 1000, 10), ("9", "Q", "A", 1000, 60)])
        self.assertEqual(r["paths"], [])
        self.assertEqual([u["txn_id"] for u in r["unlinked_incoming"]], ["9"])
        self.assertIn("not a confirmed return", r["unlinked_incoming"][0]["note"])
        self.assertIn("does not show that none exists", r["statement"])

    def test_identical_timestamps_use_txn_id_order(self):
        fwd = self.go([("1", "A", "B", 5, 0), ("2", "B", "C", 5, 0), ("3", "C", "A", 5, 0)])
        self.assertEqual(len(fwd["paths"]), 1)
        rev = self.go([("3", "A", "B", 5, 0), ("2", "B", "C", 5, 0), ("1", "C", "A", 5, 0)])   # ids run against the chain
        self.assertEqual(rev["paths"], [])
        self.assertEqual(json.dumps(fwd, default=str), json.dumps(self.go([("1", "A", "B", 5, 0), ("2", "B", "C", 5, 0), ("3", "C", "A", 5, 0)]), default=str))

    def test_cycles_that_miss_the_origin_terminate(self):
        rows = [("0", "A", "B", 5, 0)] + [(f"b{i}", "BC"[i % 2], "CB"[i % 2], 5, 1 + i) for i in range(200)]
        r = self.go(rows)
        self.assertEqual(r["paths"], [])
        tight = self.go(rows, max_expansions=50)
        self.assertIn("max_expansions", tight["truncated"])
        self.assertLessEqual(tight["expansions"], 51)

    def test_long_path_respects_depth(self):
        names = "ABCDEFGHIJK"
        rows = [(f"{i:02d}", names[i], names[(i + 1) % 11], 5, i) for i in range(11)]
        cut = self.go(rows, max_depth=6)
        self.assertEqual(cut["paths"], [])
        self.assertIn("max_depth", cut["truncated"])
        self.assertEqual(self.go(rows, max_depth=12)["paths"][0]["hops"], 11)

    def test_multiple_routes(self):
        r = self.go([("1", "A", "B", 9, 0), ("2", "A", "C", 9, 1), ("3", "B", "D", 9, 5), ("4", "C", "D", 9, 6),
                     ("5", "D", "A", 9, 20)])
        self.assertEqual(sorted(p["txn_ids"] for p in r["paths"]), [["1", "3", "5"], ["2", "4", "5"]])
        self.assertEqual(r["aggregate"]["return_transfers"], 1)            # one incoming payment, not two returns
        self.assertEqual(len({p["id"] for p in r["paths"]}), 2)

    def test_max_paths_and_alerted_signal(self):
        txns, inc, out, _ = build([(f"r{i}", "A", "B", 5, i) for i in range(5)] + [(f"b{i}", "B", "A", 5, 10 + i) for i in range(5)])
        r = R.return_paths("A", out, R.ReturnLimits(max_paths=3))
        self.assertEqual(len(r["paths"]), 3)
        self.assertIn("max_paths", r["truncated"])
        r = R.return_paths("A", build([("1", "A", "B", 9, 0), ("2", "B", "C", 9, 4), ("3", "C", "A", 9, 8)])[2], alerted={"B"})
        self.assertIn("alerted_intermediary", r["paths"][0]["signals"])


class Closeness(unittest.TestCase):
    REF = T0 + timedelta(days=60)

    def score(self, rows, a="A", b="B", cfg=R.ClosenessConfig(), **kw):
        txns, inc, out, devs = build(rows)
        return R.closeness_score(a, b, inc, out, self.REF, cfg, devs=devs, **kw)

    def direct(self, days_ago, n=1, tag=""):
        return [(f"{tag}d{i}", "A", "B", 5000, (60 - days_ago) * 1440 + i) for i in range(n)]

    def test_recent_outweighs_old_and_decay_follows_config(self):
        new, old = self.score(self.direct(1)), self.score(self.direct(40))
        self.assertGreater(new["score"], old["score"])
        cfg = R.ClosenessConfig(half_life_days=14)
        half = self.score(self.direct(14), cfg=cfg)["observations"][0]["recency_weight"]
        self.assertAlmostEqual(half, 0.5, places=3)
        self.assertAlmostEqual(self.score(self.direct(7), cfg=cfg)["observations"][0]["recency_weight"], math.exp(-cfg.lam * 7), places=3)
        slow = self.score(self.direct(40), cfg=R.ClosenessConfig(half_life_days=60))
        self.assertGreater(slow["score"], old["score"])

    def cash(self, a, b, w_off, d_off, amt=49000, d_amt=None, tag=""):
        return [(f"{tag}w", a, "ATM1", amt, w_off, "atm"), (f"{tag}c", "WALKIN", b, d_amt or amt, d_off, "cash")]

    def test_strong_evidence_outweighs_weak_recent_coincidence(self):
        strong = self.score(self.direct(20, n=3))
        weak = self.score(self.cash("A", "B", 59 * 1440, 59 * 1440 + 300))
        self.assertGreater(strong["score"], weak["score"])

    def test_similar_cash_alone_is_never_strong_or_verified(self):
        r = self.score(self.cash("A", "B", 59 * 1440, 59 * 1440 + 300))
        self.assertLessEqual(r["score"], 0.30)
        self.assertEqual(r["strength"], "weak")
        self.assertEqual(r["components"]["undirected"], 0)
        self.assertEqual(self.score(self.cash("A", "B", 0, 300))["strength"], "insufficient")   # months old: decays away

    def test_missing_device_data_yields_no_device_evidence(self):
        r = self.score([("1", "A", "X", 100, 0), ("2", "B", "Y", 100, 1)])
        self.assertTrue(all(o["type"] != "shared_device" for o in r["observations"]))
        self.assertEqual([u["evidence"] for u in r["unavailable"]], ["shared_device", "shared_device"])
        with_dev = self.score([("1", "A", "X", 100, 40 * 1440, "imps", "D1"), ("2", "B", "Y", 100, 41 * 1440, "imps", "D1")])
        self.assertEqual(with_dev["observations"][0]["type"], "shared_device")
        self.assertEqual(with_dev["unavailable"], [])

    def test_same_transaction_cannot_inflate(self):
        o = lambda i, s, ids: dict(id=i, type="x", semantics="undirected", ts=T0, txn_ids=ids, weight=1, reliability=1, recency=1, score=s, direct=False, note="")
        kept, dropped = R._select([o("a", 0.4, ["T1", "T2"]), o("b", 0.3, ["T2", "T3"]), o("c", 0.2, ["T4"])])
        self.assertEqual([k["id"] for k in kept], ["a", "c"])
        self.assertEqual(dropped[0][0]["id"], "b")
        rows = self.direct(3)
        dup = rows + rows                                                        # the same transaction delivered twice
        self.assertEqual(self.score(rows)["score"], self.score(dup)["score"])

    def test_range_determinism_and_unknowns(self):
        rng = random.Random(3)
        for _ in range(60):
            rows = [(str(i), rng.choice("ABCDE"), rng.choice("ABCDE"), rng.choice([49000, 49500, 900, 9e5]), rng.randint(0, 60 * 1440),
                     rng.choice(["atm", "cash", "upi"]), rng.choice([None, "D1", "D2"])) for i in range(40)]
            rows = [r for r in rows if r[1] != r[2]]
            r = self.score(rows)
            self.assertTrue(0 <= r["score"] <= 1 and all(0 <= v <= 1 for v in r["components"].values()))
            self.assertEqual(json.dumps(r, default=str), json.dumps(self.score(rows), default=str))
        empty = self.score([("1", "X", "Y", 5, 0)])
        self.assertEqual((empty["score"], empty["strength"], empty["observations"]), (0.0, "insufficient", []))
        with self.assertRaises(ValueError):
            self.score([], a="A", b="A")

    def test_direction_semantics(self):
        r = self.score(self.direct(1))
        self.assertGreater(r["components"]["a_to_b"], 0)
        self.assertEqual((r["components"]["b_to_a"], r["components"]["undirected"]), (0, 0))
        r = self.score([("1", "A", "X", 1, 50 * 1440, "imps", "D1"), ("2", "B", "Y", 1, 50 * 1440, "imps", "D1")])
        self.assertGreater(r["components"]["undirected"], 0)
        self.assertEqual((r["components"]["a_to_b"], r["components"]["b_to_a"]), (0, 0))

    def test_future_observations_excluded(self):
        self.assertEqual(self.score([("1", "A", "B", 5, 61 * 1440)])["observations"], [])

    def test_no_direct_cap_and_corroboration(self):
        rows = (self.cash("A", "B", 59 * 1440, 59 * 1440 + 60, tag="x")
                + [("s1", "A", "X", 1, 59 * 1440, "imps", "D1"), ("s2", "B", "Y", 1, 59 * 1440, "imps", "D1")])
        r = self.score(rows)
        self.assertGreater(r["score"], self.score(self.cash("A", "B", 59 * 1440, 59 * 1440 + 60))["score"])  # two kinds corroborate
        self.assertLessEqual(r["score"], 0.60)


class Suspected(unittest.TestCase):
    REF = T0 + timedelta(days=1)

    def setUp(self):
        self.rows = [("w1", "A", "ATM1", 49000, 60, "atm", "DA"), ("c1", "WALKIN", "B", 49000, 60 + 5 * 60, "cash")]
        self.txns, self.inc, self.out, self.devs = build(self.rows)

    def edges(self, rows=None, ref=None):
        txns, inc, out, devs = (self.txns, self.inc, self.out, self.devs) if rows is None else build(rows)
        pairs = R.cash_matches(txns)
        return R.build_suspected(pairs, inc, out, ref or self.REF, devs=devs) + (txns,)

    def test_withdrawal_then_deposit_makes_suspected_not_verified(self):
        edges, insufficient, txns = self.edges()
        self.assertEqual(len(edges), 1)
        e = edges[0]
        self.assertEqual((e["source"], e["target"], e["relationship_type"], e["status"]), ("A", "B", "possible_cash_link", "suspected"))
        self.assertEqual((e["inferred"], e["verified"]), (True, False))
        self.assertEqual(e["supporting_txn_ids"], ["c1", "w1"])
        self.assertIn("INFERRED", e["statement"])
        self.assertTrue(e["alternative_explanations"] and e["missing_evidence"] and e["limitations"] and e["method"])
        self.assertEqual(e["score_kind"], "heuristic closeness on [0, 1]; not a probability")
        self.assertEqual(len(txns), 2)                                          # ledger unchanged
        self.assertFalse(any(t["sender_account"] == "A" and t["receiver_account"] == "B" for t in txns))
        self.assertEqual(R.suspected_id("possible_cash_link", "A", "B"), e["id"])

    def test_old_coincidence_is_insufficient_not_an_edge(self):
        edges, insufficient, _ = self.edges(ref=T0 + timedelta(days=200))
        self.assertEqual(edges, [])
        self.assertEqual(insufficient[0]["result"], "insufficient_evidence")
        self.assertEqual(insufficient[0]["txn_ids"], ["c1", "w1"])

    def test_look_alike_deposits_reduce_the_weight(self):
        solo = self.edges()[0][0]["score"]
        crowd = self.rows + [(f"c{i}", "WALKIN", f"B{i}", 49000, 60 + 6 * 60 + i, "cash") for i in range(2, 6)]
        e = [x for x in self.edges(crowd)[0] if x["target"] == "B"]
        self.assertTrue(not e or e[0]["score"] < solo)

    def test_direct_transfer_is_not_inferred(self):
        rows = [("w1", "A", "ATM1", 49000, 60, "atm"), ("c1", "A", "B", 49000, 360, "cash")]   # A itself sent the cash to B
        self.assertEqual(self.edges(rows)[0], [])

    def test_review_audit_and_status_persistence(self):
        store, now = R.SuspectedStore(), self.REF
        store.sync(self.edges()[0], now)
        eid = next(iter(store.edges))
        self.assertEqual(store.edges[eid]["history"][0]["action"], "created")
        with self.assertRaises(R.ReviewError):
            store.review(eid, "rejected", "priya", "", now)
        store.review(eid, "under_review", "priya", "", now)
        store.review(eid, "rejected", "priya", "Same branch payroll run", now)
        self.assertEqual(store.list(), [])                                       # rejected hidden by default
        self.assertEqual(len(store.list(include_rejected=True)), 1)
        with self.assertRaises(R.ReviewError):
            store.review(eid, "rejected", "priya", "again again", now)
        with self.assertRaises(KeyError):
            store.review("SE-nope", "rejected", "x", "xxxxx", now)
        more = self.rows + [("c9", "WALKIN2", "B", 49000, 60 + 7 * 60, "cash")]
        store.sync(self.edges(more)[0], now + timedelta(hours=1))
        e = store.edges[eid]
        self.assertEqual(e["status"], "rejected")                                # an analyst decision is not overwritten
        self.assertEqual([h["action"] for h in e["history"]], ["created", "review", "review"] + (["evidence_updated"] if e["new_evidence_since_rejection"] else []))
        self.assertEqual(e["history"][2]["actor"], "priya")

    def test_corroborated_needs_note_and_stays_inferred(self):
        store = R.SuspectedStore()
        store.sync(self.edges()[0], self.REF)
        eid = next(iter(store.edges))
        e = store.review(eid, "corroborated", "priya", "Branch CCTV shows same person", self.REF)
        self.assertEqual((e["status"], e["verified"]), ("corroborated", False))     # corroboration is not a ledger transaction


class Integration(unittest.TestCase):
    """Uses the project's own synthetic Bank when muletrace.py is importable."""

    def test_chain_ring_first_hop(self):
        try:
            import muletrace as mt
        except ImportError:
            self.skipTest("muletrace.py not importable here")
        live = mt.Bank(seed=7)
        live.normals = [live.account(0.1, 400) for _ in range(20)]
        plan = live.ring("chain", mt.NOW)
        for i, t in enumerate(plan):
            t["txn_id"] = f"TX{i:07d}"
        inc, out, _ = mt.index(plan)
        f = R.first_hop_findings(plan, inc, out, plan[0]["ts"] - timedelta(days=10), plan[-1]["ts"])
        self.assertEqual([x["account_id"] for x in f], [plan[0]["sender_account"]])
        self.assertEqual(f[0]["observed_incoming_count"], 0)
        self.assertEqual(f[0]["downstream_signals"]["hops_observed"], 4)
        self.assertEqual(f[0]["status"], "supported_by_observed_data")


if __name__ == "__main__":
    unittest.main()