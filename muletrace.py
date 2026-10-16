"""MuleTrace core: synthetic data with 3 hidden mule rings, detection rules, time-ordered money trail,
ring grouping. Amounts in INR. Run `python muletrace.py` for the self-check."""
import csv
import random
from bisect import bisect_left, bisect_right
from collections import defaultdict
from datetime import datetime, timedelta
from operator import itemgetter
from pathlib import Path

NOW = datetime(2026, 10, 16, 9, 0)
M30, H1, H24, H72 = timedelta(minutes=30), timedelta(hours=1), timedelta(hours=24), timedelta(hours=72)
TS = itemgetter("ts")
FIRST = "Arun Priya Karthik Divya Vijay Meena Suresh Lakshmi Rahul Anitha Ravi Kavya Manoj Deepa Ganesh".split()
LAST = "Kumar Raj Iyer Nair Pillai Reddy Menon Sharma Das Rao".split()
BRANCHES = ["Chennai", "Coimbatore", "Madurai", "Bengaluru", "Hyderabad"]
PATTERN_BASE = {"structuring": 0.7, "passthrough": 0.75, "fan_in_out": 0.8, "dormant": 0.65, "shared_device": 0.4}


def inr(x):
    """Indian digit grouping: 480000 -> ₹4,80,000."""
    s = str(round(x))
    h, t = s[:-3], s[-3:]
    while len(h) > 2:
        h, t = h[:-2], h[-2:] + "," + t
    return "₹" + (h + "," + t if h else t)


def window(lst, a, b):
    """Items of a ts-sorted list with a <= ts <= b."""
    return lst[bisect_left(lst, a, key=TS):bisect_right(lst, b, key=TS)]


class Bank:
    """Accounts, devices and transaction minting, shared by the startup history and the live feed."""
    CHANNELS = ["upi", "imps", "neft", "card"]

    def __init__(self, seed=42, now=NOW):
        self.rng, self.now = random.Random(seed), now
        self.accounts, self.dev, self.normals = {}, {}, []

    def account(self, kyc, opened_days_ago, device=None, name=None):
        rng, aid = self.rng, f"AC{len(self.accounts):04d}"
        self.accounts[aid] = dict(account_id=aid, name=name or f"{rng.choice(FIRST)} {rng.choice(LAST)}",
                                  type=rng.choice(["savings", "current"]), kyc_risk=kyc,
                                  open_date=(self.now - timedelta(days=opened_days_ago)).date().isoformat(),
                                  home_branch=rng.choice(BRANCHES),
                                  expected_monthly_volume=rng.choice([50000, 200000, 500000]))
        self.dev[aid] = device or f"DEV{len(self.accounts):04d}"
        return aid

    def mule(self, device=None):
        return self.account(round(self.rng.uniform(0.5, 0.9), 2), self.rng.randint(20, 60), device)

    def txn(self, ts, s, r, amt, channel="imps"):
        d = self.dev[s]
        n = int(d[3:])
        return dict(ts=ts, sender_account=s, receiver_account=r, amount=round(amt, 2), channel=channel,
                    device_id=d, ip=f"10.{n // 256 % 256}.{n % 256}.7")

    def normal(self, ts):
        s, r = self.rng.sample(self.normals, 2)
        return self.txn(ts, s, r, self.rng.lognormvariate(8, 1), self.rng.choice(self.CHANNELS))

    def ring(self, kind, start):
        """One mule ring with fresh accounts, as transactions timed from `start` (bank clock)."""
        rng, mule, out = self.rng, self.mule, []
        tx = lambda m, s, r, amt, ch="imps": out.append(self.txn(start + timedelta(minutes=m), s, r, amt, ch))
        device = f"DEV9{rng.randint(100, 999)}"
        if kind == "structuring":  # 6 smurfs make cash deposits just under ₹50,000 (PAN threshold) into a collector
            collector, offshore = mule(), mule()
            t, total = 0, 0
            for smurf in [mule() for _ in range(6)]:
                for _ in range(2):
                    amt = rng.uniform(45000, 49900)
                    total += amt
                    tx(t, smurf, collector, amt, "cash")
                    t += rng.randint(6, 20)
            tx(t + 20, collector, offshore, total * 0.97, "rtgs")
        elif kind == "chain":  # a dormant mule wakes up and layers money through 2 mules sharing a device
            funder, dormant = mule(), self.account(0.6, 800)
            m2, m3, cashout = mule(device), mule(device), mule(device)
            t, amt = 0, rng.randint(30, 60) * 10000
            for s, r in [(funder, dormant), (dormant, m2), (m2, m3), (m3, cashout)]:
                tx(t, s, r, amt)
                t += rng.randint(8, 20)
                amt *= rng.uniform(0.9, 0.97)
        elif kind == "fan":  # 8 senders -> hub within 40 min -> 8 mules on one device -> one ATM cash-out
            hub, atm = mule(device), mule()
            ins = [rng.uniform(50000, 90000) for _ in range(8)]
            t = 0
            for s, a in zip([mule() for _ in range(8)], ins):
                tx(t, s, hub, a, "upi")
                t += 5
            for r, a in zip([mule(device) for _ in range(8)], ins):
                tx(t, hub, r, a * 0.95, "upi")
                tx(t + 15, r, atm, a * 0.9, "atm")
                t += 2
        else:
            raise ValueError(f"unknown ring kind {kind!r}")
        return sorted(out, key=TS)


RING_KINDS = ("structuring", "chain", "fan")


def history(bank, n_accounts=500, n_txns=10000, days=30, rings=True):
    """Normal customers over `days` before bank.now, optionally with the 3 demo rings in the last 3 days."""
    rng = bank.rng
    bank.normals = [bank.account(round(rng.uniform(0, 0.4), 2), rng.randint(200, 3000)) for _ in range(n_accounts)]
    txns = [bank.normal(bank.now - timedelta(minutes=rng.randint(0, days * 24 * 60))) for _ in range(n_txns)]
    if rings:
        for kind, days_ago in zip(RING_KINDS, (3, 2, 1)):
            txns += bank.ring(kind, bank.now - timedelta(days=days_ago))
    txns.sort(key=TS)
    for i, x in enumerate(txns):
        x["txn_id"] = f"TX{i:07d}"
    return txns


def generate(n_accounts=500, n_txns=10000, seed=42):
    bank = Bank(seed)
    txns = history(bank, n_accounts, n_txns)
    return bank.accounts, txns


def index(txns):
    """txns must be ts-sorted; the per-account lists inherit that order."""
    inc, out, devs = defaultdict(list), defaultdict(list), defaultdict(set)
    for t in txns:
        out[t["sender_account"]].append(t)
        inc[t["receiver_account"]].append(t)
        devs[t["device_id"]].add(t["sender_account"])
    return inc, out, devs


def detect(accounts, inc, out, devs, band=(45000, 50000), min_pass=50000, min_dormant=100000):
    """Defaults are INR (structuring under the ₹50,000 PAN threshold); eval_ibm.py passes USD values."""
    alerts = []
    for aid, acc in accounts.items():
        I, O, hits = inc[aid], out[aid], []  # hits: (pattern, trigger txn, reason)

        s = [t for t in I if band[0] <= t["amount"] < band[1]]
        for i, t in enumerate(s):
            n = bisect_right(s, t["ts"] + H24, key=TS) - i
            if n >= 3:
                hits.append(("structuring", t, f"{n} deposits of {inr(band[0])}-{inr(band[1] - 1)} within 24h, "
                                               f"just under the reporting threshold"))
                break

        for t in I:
            if t["amount"] < min_pass:
                continue
            fwd = sum(u["amount"] for u in window(O, t["ts"], t["ts"] + M30))
            if fwd >= 0.8 * t["amount"]:
                hits.append(("passthrough", t, f"Received {inr(t['amount'])} and sent {inr(fwd)} onward within 30 min"))
                break

        for t in I:
            ss = {u["sender_account"] for u in window(I, t["ts"], t["ts"] + H1)}
            if len(ss) <= 5:
                continue
            rr = {u["receiver_account"] for u in window(O, t["ts"], t["ts"] + H1)}
            if len(rr) > 5:
                hits.append(("fan_in_out", t, f"{len(ss)} senders and {len(rr)} receivers within 1h"))
                break

        prev = datetime.fromisoformat(acc["open_date"])
        for t in sorted(I + O, key=TS):
            if t["ts"] - prev >= timedelta(days=90) and t["amount"] >= min_dormant:
                hits.append(("dormant", t, f"Dormant {(t['ts'] - prev).days} days, then {inr(t['amount'])}"))
                break
            prev = t["ts"]

        shared = {a for d in {t["device_id"] for t in O} for a in devs[d]} - {aid}
        if len(shared) >= 2:
            hits.append(("shared_device", O[0], f"Device shared with {len(shared)} other accounts"))

        if not hits:
            continue
        miss = 1.0
        for p, _, _ in hits:
            miss *= 1 - PATTERN_BASE[p]
        score = round(min(0.99, 1 - miss + 0.2 * acc["kyc_risk"]), 2)
        trigger = min((h[1] for h in hits), key=TS)
        alerts.append(dict(account_id=aid, txn_id=trigger["txn_id"], ts=trigger["ts"], score=score,
                           severity=severity(score), pattern="+".join(h[0] for h in hits),
                           reasons=[h[2] for h in hits], amount=trigger["amount"], status="new",
                           assigned_to="", created_at=NOW))
    alerts.sort(key=lambda a: -a["score"])
    for i, a in enumerate(alerts):
        a["alert_id"] = f"AL-{101 + i}"
    return alerts


def severity(score):
    return "high" if score >= 0.85 else "medium" if score >= 0.7 else "low"


def trace(aid, anchor, inc, out, devs, hops=4, min_amt=25000):
    """Time-ordered money trail: money can only move forward in time, so each hop
    must happen before the one after it (backward) or after the one before it (forward)."""
    edges, up, down = {}, set(), set()
    frontier = [(aid, anchor + H24)]  # backward: money that arrived before it left
    for _ in range(hops):
        frontier, prev = [], frontier
        for acc, t in prev:
            for u in window(inc[acc], anchor - H72, t):
                if u["amount"] >= min_amt and u["txn_id"] not in edges:
                    edges[u["txn_id"]] = u
                    up.add(u["sender_account"])
                    frontier.append((u["sender_account"], u["ts"]))
    frontier = [(aid, anchor)]  # forward: money that left after it arrived
    for _ in range(hops):
        frontier, prev = [], frontier
        for acc, t in prev:
            for u in window(out[acc], t, anchor + H72):
                if u["amount"] >= min_amt and u["txn_id"] not in edges:
                    edges[u["txn_id"]] = u
                    down.add(u["receiver_account"])
                    frontier.append((u["receiver_account"], u["ts"]))
    lateral = {a for d in {t["device_id"] for t in out[aid]} for a in devs[d]} - {aid}
    return list(edges.values()), up - {aid}, down - {aid}, lateral


def device_links(accts, out, devs):
    """(account, device) pairs for devices used by more than one account."""
    return sorted({(a, t["device_id"]) for a in accts for t in out[a] if len(devs[t["device_id"]]) > 1})


def networks(alerts, inc, out, devs, min_amt=25000):
    """Group alerts into rings: alerts whose money trails or devices touch the same accounts are one network."""
    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    traces = {}
    for a in alerts:
        traces[a["alert_id"]] = edges, up, down, lat = trace(a["account_id"], a["ts"], inc, out, devs, min_amt=min_amt)
        for n in up | down | lat:
            parent[find(n)] = find(a["account_id"])
        find(a["account_id"])

    groups = defaultdict(list)
    for a in alerts:
        groups[find(a["account_id"])].append(a)
    nets = []
    for root, alist in groups.items():
        edges = {}
        for a in alist:
            edges.update((x["txn_id"], x) for x in traces[a["alert_id"]][0])
        members = {n for n in parent if find(n) == root}
        senders = {e["sender_account"] for e in edges.values()}
        receivers = {e["receiver_account"] for e in edges.values()}
        alerted = {a["account_id"] for a in alist}
        sources = (senders - receivers) - alerted  # first money in: victim or organiser, review before freezing
        score = max(a["score"] for a in alist)
        nets.append(dict(alert_ids=[a["alert_id"] for a in alist], accounts=sorted(members),
                         alerted=sorted(alerted), sources=sorted(sources), freeze=sorted(members - sources),
                         exits=sorted(receivers - senders), score=score, severity=severity(score),
                         patterns=sorted({p for a in alist for p in a["pattern"].split("+")}),
                         total_in=round(sum(e["amount"] for e in edges.values() if e["sender_account"] in sources)
                                        or max((e["amount"] for e in edges.values()), default=0), 2),
                         first_ts=min((e["ts"] for e in edges.values()), default=alist[0]["ts"]),
                         last_ts=max((e["ts"] for e in edges.values()), default=alist[0]["ts"]),
                         edges=sorted(edges.values(), key=TS), devices=device_links(members, out, devs), status="open"))
    nets.sort(key=lambda n: (-n["score"], -len(n["accounts"])))
    for i, n in enumerate(nets):
        n["network_id"] = f"NET-{i + 1}"
    return nets


def profile(aid, accounts, inc, out):
    I, O = inc[aid], out[aid]
    recv, sent = sum(t["amount"] for t in I), sum(t["amount"] for t in O)
    waits = []
    for t in I:
        nxt = window(O, t["ts"], t["ts"] + H72)
        if nxt:
            waits.append((nxt[0]["ts"] - t["ts"]).total_seconds() / 60)
    return dict(**accounts[aid], total_received=round(recv, 2), unique_senders=len({t["sender_account"] for t in I}),
                total_sent=round(sent, 2), unique_receivers=len({t["receiver_account"] for t in O}),
                passthrough_pct=round(sent / recv * 100, 1) if recv else 0,
                avg_minutes_to_forward=round(sum(waits) / len(waits), 1) if waits else None,
                devices=sorted({t["device_id"] for t in O}), ips=sorted({t["ip"] for t in O}),
                txns=sorted(I + O, key=TS, reverse=True)[:50])


def export(path, accounts, txns, alerts, nets):
    """CSV dump for Power BI."""
    path.mkdir(exist_ok=True)
    for name, rows in [("accounts", list(accounts.values())), ("transactions", txns),
                       ("alerts", [{**a, "reasons": "; ".join(a["reasons"])} for a in alerts]),
                       ("networks", [{k: "; ".join(map(str, v)) if isinstance(v, list) else v for k, v in n.items()
                                      if k not in ("edges", "devices")} for n in nets])]:
        with open(path / f"{name}.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)


ACCOUNTS, TXNS = generate()
INC, OUT, DEVS = index(TXNS)
ALERTS = detect(ACCOUNTS, INC, OUT, DEVS)
NETWORKS = networks(ALERTS, INC, OUT, DEVS)

if __name__ == "__main__":
    assert inr(480000) == "₹4,80,000" and inr(999) == "₹999" and inr(12345678) == "₹1,23,45,678"
    pats = {p for a in ALERTS for p in a["pattern"].split("+")}
    assert pats >= {"structuring", "passthrough", "fan_in_out", "dormant"}, pats
    is_ring = lambda aid: int(aid[2:]) >= 500  # ring accounts are created after the 500 normals
    normal_hits = [a for a in ALERTS if not is_ring(a["account_id"])]
    ring_nets = [n for n in NETWORKS if any(map(is_ring, n["accounts"]))]
    print(f"{len(TXNS)} txns, {len(ALERTS)} alerts ({len(normal_hits)} on normal accounts) -> {len(NETWORKS)} networks")
    assert len(normal_hits) <= 10, normal_hits
    assert len(ring_nets) == 3, [n["accounts"] for n in ring_nets]
    chain = next(n for n in NETWORKS if "dormant" in n["patterns"])
    assert chain["total_in"] == chain["edges"][0]["amount"], chain["total_in"]  # money in from the funder, not the sum of hops
    live = Bank(seed=7)
    live.normals = [live.account(0.1, 400) for _ in range(20)]
    for kind in RING_KINDS:  # every ring kind mints fresh accounts and time-ordered transfers
        plan = live.ring(kind, NOW)
        assert plan and plan == sorted(plan, key=TS) and all(t["ts"] >= NOW for t in plan), kind
    assert all(not any(map(is_ring, n["accounts"])) for n in NETWORKS if n not in ring_nets)
    for n in NETWORKS:
        print(n["network_id"], n["severity"], len(n["alert_ids"]), "alerts", len(n["accounts"]), "accounts",
              inr(n["total_in"]), n["patterns"], "sources:", n["sources"])
    print("self-check ok")
