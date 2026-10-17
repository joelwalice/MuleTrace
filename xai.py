"""Explainable mule classifier: LightGBM on per-account behaviour, explained with exact TreeSHAP contributions.

    python3 xai.py train      # build the training set, train, evaluate on a held-out bank, save model/
    python3 xai.py            # self-check: explanations add up, constraints hold, held-out quality is sane

Rules (muletrace.detect) say *which pattern* fired; this model says *how mule-like the whole account looks*
and which behaviours pushed the score up or down. Every contribution is in log-odds and they sum exactly to
the model's raw score, so the explanation is the model, not a story about it.
Monotone constraints keep explanations sane: e.g. forwarding money faster can never make an account look safer.

Scoring code (FEATURES, features, explain) has no dependency on muletrace, so foundry/score.py reuses it as-is."""
import json
import math
import sys
from functools import cache
from bisect import bisect_left, bisect_right
from datetime import datetime, timedelta
from pathlib import Path

import lightgbm as lgb
import numpy as np

MODEL_DIR = Path(__file__).parent / "model"
M30, H1, H24, H72 = timedelta(minutes=30), timedelta(hours=1), timedelta(hours=24), timedelta(hours=72)
NEVER = 4320.0  # minutes: "didn't forward within 72h"

# name, plain-English template, monotone direction (+1 can only raise risk, -1 can only lower it, 0 free)
FEATURES = [
    ("passthrough_ratio", "Sent on {pct} of what it received", 1),
    ("fast_forward_share", "{pct} of incoming money left within 30 min", 1),
    ("min_minutes_to_forward", "Fastest onward transfer: {min}", -1),
    ("max_senders_1h", "Up to {n} different senders within one hour", 1),
    ("max_receivers_1h", "Paid up to {n} different accounts within one hour", 0),
    ("near_threshold_deposits", "{n} deposits just under ₹50,000 within 24h", 1),
    ("cash_share", "{pct} of incoming money was cash", 0),
    ("dormancy_days", "Quiet for {n} days before a large transfer", 1),
    ("account_age_days", "Account opened {n} days ago", -1),
    ("kyc_risk", "KYC risk rating {v}", 1),
    ("shared_device_accounts", "Device shared with {n} other accounts", 1),
    ("volume_vs_expected", "Received {x} its expected monthly volume", 1),
]
NAMES = [f[0] for f in FEATURES]


def _win(lst, a, b):
    k = lambda t: t["ts"]
    return lst[bisect_left(lst, a, key=k):bisect_right(lst, b, key=k)]


def features(acc, I, O, devs, now, band=(45000, 50000), big=50000):
    """One account's behaviour as numbers. I/O: its incoming/outgoing transfers, ts-sorted.
    Unknown inputs (e.g. no KYC on an external dataset) are NaN, which LightGBM treats as missing."""
    recv, sent = sum(t["amount"] for t in I), sum(t["amount"] for t in O)
    fast, waits, s1h = 0.0, [], 0
    r1h = max((len({u["receiver_account"] for u in _win(O, t["ts"], t["ts"] + H1)}) for t in O), default=0)
    for t in I:
        nxt = _win(O, t["ts"], t["ts"] + H72)
        if nxt:
            waits.append((nxt[0]["ts"] - t["ts"]).total_seconds() / 60)
        fast += min(t["amount"], sum(u["amount"] for u in _win(O, t["ts"], t["ts"] + M30)))
        s1h = max(s1h, len({u["sender_account"] for u in _win(I, t["ts"], t["ts"] + H1)}))
    near = [t for t in I if band[0] <= t["amount"] < band[1]]
    near_24h = max((bisect_right(near, t["ts"] + H24, key=lambda x: x["ts"]) - i for i, t in enumerate(near)), default=0)
    prev, dormant = datetime.fromisoformat(acc["open_date"]), 0
    for t in sorted(I + O, key=lambda x: x["ts"]):
        if t["amount"] >= big:
            dormant = max(dormant, (t["ts"] - prev).days)
        prev = t["ts"]
    shared = {a for d in {t["device_id"] for t in O} for a in devs.get(d, ())} - {acc["account_id"]}
    expected = acc.get("expected_monthly_volume")
    return [
        min(sent / recv, 2.0) if recv else 0.0,
        fast / recv if recv else 0.0,
        min(waits) if waits else NEVER,
        float(s1h),
        float(r1h),
        float(near_24h),
        sum(t["amount"] for t in I if t["channel"] == "cash") / recv if recv else 0.0,
        float(dormant),
        float((now.date() - datetime.fromisoformat(acc["open_date"]).date()).days),
        float(acc["kyc_risk"]) if acc.get("kyc_risk") is not None else math.nan,
        float(len(shared)) if devs else math.nan,
        recv / expected if expected else math.nan,
    ]


def _text(name, tmpl, v):
    if math.isnan(v):
        return f"{name.replace('_', ' ')}: not available"
    if name == "min_minutes_to_forward" and v >= NEVER:
        return "Never sent money on within 72h of receiving it"
    if name == "max_receivers_1h" and v == 0:
        return "Never sent money out"
    if name == "max_senders_1h" and v == 0:
        return "Never received money"
    if name == "dormancy_days" and v == 0:
        return "No quiet spell before a large transfer"
    m = f"{v:.0f} min" if v < 120 else f"{v / 60:.1f} h"
    out = tmpl.format(pct=f"{v:.0%}", n=f"{v:,.0f}", v=f"{v:.2f}", x=f"{v:.1f}×", min=m)
    if v == 1:  # "1 different accounts" → "1 account"
        out = out.replace("1 different accounts", "1 account").replace("1 different senders", "1 sender").replace("1 days", "1 day")
    return out


def explain(booster, rows, top=6):
    """Probability plus exact per-feature contributions (log-odds) for each feature row."""
    X = np.asarray(rows, dtype=float)
    contrib = booster.predict(X, pred_contrib=True)
    out = []
    for x, c in zip(X, contrib):
        raw = float(c.sum())
        parts = sorted(({"feature": n, "text": _text(n, t, float(v)), "value": None if math.isnan(v) else round(float(v), 3),
                         "contribution": round(float(ci), 3)} for (n, t, _), v, ci in zip(FEATURES, x, c[:-1])),
                       key=lambda p: -abs(p["contribution"]))
        out.append(dict(score=round(1 / (1 + math.exp(-raw)), 3), raw=round(raw, 3), base=round(float(c[-1]), 3),
                        reasons=[p for p in parts if abs(p["contribution"]) >= 0.01][:top], contributions=parts))
    return out


def load(path=MODEL_DIR):
    f = Path(path) / "mule_classifier.txt"
    if not f.exists():
        return None, None
    card = Path(path) / "card.json"
    # model_str, not model_file: a CRLF copy of the file (Windows checkout) is otherwise a "Model format error"
    return lgb.Booster(model_str=f.read_text().replace("\r", "")), json.loads(card.read_text()) if card.exists() else {}


# -- training (needs muletrace; not used by the scoring endpoint) -----------------------------------------------
def dataset(seed, n_normal=700, n_txns=14000, days=30, n_rings=36, n_legit=140):
    """A bank with mule rings (label 1) and legitimate look-alikes (label 0): payroll fan-out, busy merchants,
    cash-heavy shops, savings sweeps. Ring parameters are jittered so the patterns overlap with real business."""
    import muletrace as mt
    bank = mt.Bank(seed=seed, now=mt.NOW)
    rng = bank.rng
    txns = mt.history(bank, n_normal, n_txns, days, rings=False)
    labels = dict.fromkeys(bank.accounts, 0)
    at = lambda: bank.now - timedelta(minutes=rng.randint(6 * 60, days * 24 * 60))

    def grow(fn, label):
        before = set(bank.accounts)
        txns.extend(fn())
        labels.update(dict.fromkeys(set(bank.accounts) - before, label))

    def slow_chain():  # mules that wait longer and keep a bigger cut: harder to tell from normal transfers
        start, out = at(), []
        acc = [bank.mule() for _ in range(rng.randint(3, 5))]
        t, amt = 0, rng.randint(15, 60) * 10000
        for s, r in zip(acc, acc[1:]):
            out.append(bank.txn(start + timedelta(minutes=t), s, r, amt, "imps"))
            t += rng.randint(35, 240)
            amt *= rng.uniform(0.6, 0.9)
        return out

    def small_fan():  # a hub just under the fan-in rule's threshold
        start, hub = at(), bank.mule()
        out = [bank.txn(start + timedelta(minutes=5 * i), bank.mule(), hub, rng.uniform(15000, 45000), "upi") for i in range(rng.randint(3, 5))]
        out += [bank.txn(start + timedelta(minutes=40 + 3 * i), hub, bank.mule(), rng.uniform(15000, 40000), "upi") for i in range(rng.randint(2, 4))]
        return out

    def payroll():  # one big monthly credit, then many salaries the same day: fast fan-out, but legitimate
        co = bank.account(round(rng.uniform(0, 0.3), 2), rng.randint(900, 4000))
        start = at()
        pay = rng.randint(20, 80) * 10000
        out = [bank.txn(start, rng.choice(bank.normals), co, pay, "neft")]
        staff = rng.sample(bank.normals, rng.randint(8, 20))
        out += [bank.txn(start + timedelta(minutes=rng.randint(20, 300)), co, s, pay * 0.9 / len(staff), "neft") for s in staff]
        return out

    def merchant():  # many small customer payments, a weekly supplier payment
        m = bank.account(round(rng.uniform(0, 0.3), 2), rng.randint(400, 3000))
        out = []
        for d in range(rng.randint(5, 20)):
            day = bank.now - timedelta(days=d + 1)
            out += [bank.txn(day + timedelta(minutes=rng.randint(0, 720)), rng.choice(bank.normals), m, rng.uniform(100, 3000), "upi")
                    for _ in range(rng.randint(5, 25))]
        out.append(bank.txn(bank.now - timedelta(days=rng.randint(1, 5)), m, rng.choice(bank.normals), rng.uniform(20000, 90000), "neft"))
        return out

    def cash_shop():  # daily takings deposited in cash, sometimes near ₹50,000
        shop = bank.account(round(rng.uniform(0, 0.35), 2), rng.randint(600, 4000))
        return [bank.txn(bank.now - timedelta(days=d, minutes=rng.randint(0, 600)), rng.choice(bank.normals), shop,
                         rng.uniform(20000, 60000), "cash") for d in range(rng.randint(3, 12))]

    def sweep():  # salary in, most of it moved to a deposit a day or two later
        a = bank.account(round(rng.uniform(0, 0.3), 2), rng.randint(300, 3000))
        start, sal = at(), rng.randint(5, 20) * 10000
        return [bank.txn(start, rng.choice(bank.normals), a, sal, "neft"),
                bank.txn(start + timedelta(hours=rng.randint(20, 60)), a, rng.choice(bank.normals), sal * rng.uniform(0.7, 0.95), "imps")]

    def quiet():  # a customer who barely uses the account
        a = bank.account(round(rng.uniform(0, 0.5), 2), rng.randint(30, 3000))
        return [bank.txn(at(), *rng.sample([a, rng.choice(bank.normals)], 2), rng.lognormvariate(8, 1), "upi") for _ in range(rng.randint(1, 3))]

    def big_once():  # a one-off large credit (a property sale, a loan) partly moved on days later
        a = bank.account(round(rng.uniform(0, 0.5), 2), rng.randint(60, 3000))
        start, amt = at(), rng.randint(10, 50) * 10000
        return [bank.txn(start, rng.choice(bank.normals), a, amt, "rtgs"),
                bank.txn(start + timedelta(hours=rng.randint(6, 120)), a, rng.choice(bank.normals), amt * rng.uniform(0.3, 0.9), "neft")]

    def everyday(fn, share=1.0):  # ordinary activity, so "no history" or "few transactions" isn't a giveaway
        def run():
            before = set(bank.accounts)
            out = fn()
            for a in set(bank.accounts) - before:
                if rng.random() < share:
                    out += [bank.txn(bank.now - timedelta(minutes=rng.randint(60, days * 24 * 60)), *rng.sample([a, rng.choice(bank.normals)], 2),
                                     rng.lognormvariate(8, 1), rng.choice(bank.CHANNELS)) for _ in range(rng.randint(3, 45))]
            return out
        return run

    rings = [lambda k=k: bank.ring(k, at()) for k in mt.RING_KINDS] + [slow_chain, small_fan]
    for _ in range(n_rings):
        grow(everyday(rng.choice(rings), share=0.5), 1)  # half the mules also live an ordinary banking life
    for _ in range(n_legit):
        fn = rng.choice([payroll, merchant, cash_shop, sweep, quiet, big_once])
        grow(fn if fn is quiet else everyday(fn), 0)
    # Break the synthetic shortcut "new account + high KYC = mule": many real mules are rented, long-standing,
    # low-risk accounts, and many legitimate customers are new.
    for a, y in labels.items():
        acc = bank.accounts[a]
        if y and rng.random() < 0.4:
            acc.update(kyc_risk=round(rng.uniform(0.05, 0.45), 2),
                       open_date=(bank.now - timedelta(days=rng.randint(200, 3000))).date().isoformat())
        elif not y and rng.random() < 0.15:
            acc.update(kyc_risk=round(rng.uniform(0.3, 0.8), 2),
                       open_date=(bank.now - timedelta(days=rng.randint(31, 120))).date().isoformat())
    txns.sort(key=mt.TS)
    for i, x in enumerate(txns):
        x["txn_id"] = f"TX{i:07d}"
    inc, out, devs = mt.index(txns)
    X = [features(bank.accounts[a], inc[a], out[a], devs, bank.now) for a in labels]
    return np.asarray(X), np.asarray([labels[a] for a in labels])


def auc(y, p):
    order = np.argsort(p)
    ranks = np.empty(len(p))
    ranks[order] = np.arange(1, len(p) + 1)
    pos = y == 1
    return float((ranks[pos].sum() - pos.sum() * (pos.sum() + 1) / 2) / (pos.sum() * (~pos).sum()))


def metrics(y, p, threshold=0.5):
    hit = p >= threshold
    tp, fp, fn = int((hit & (y == 1)).sum()), int((hit & (y == 0)).sum()), int((~hit & (y == 1)).sum())
    return dict(auc=round(auc(y, p), 3), precision=round(tp / (tp + fp), 3) if tp + fp else 0.0,
                recall=round(tp / (tp + fn), 3) if tp + fn else 0.0, threshold=threshold,
                accounts=int(len(y)), mules=int(y.sum()))


PARAMS = dict(objective="binary", learning_rate=0.05, num_leaves=15, min_data_in_leaf=15, feature_fraction=0.9,
              bagging_fraction=0.9, bagging_freq=1, lambda_l2=1.0, monotone_constraints=[f[2] for f in FEATURES],
              monotone_constraints_method="advanced", verbose=-1, seed=7)


# Banks of different sizes and activity levels, so counterparty counts alone can't decide the score.
# (500, 10000) is the live demo bank's shape; the held-out bank uses it too.
BANKS = [(11, 500, 10000), (12, 500, 7000), (13, 700, 14000), (14, 600, 16000), (15, 400, 6000), (16, 500, 12000)]


def live_false_alarms(booster, seed=123):
    """Share of ordinary customers in a live-style bank (no rings) the model would flag."""
    import muletrace as mt
    bank = mt.Bank(seed=seed, now=mt.NOW)
    txns = mt.history(bank, rings=False)
    inc, out, devs = mt.index(txns)
    p = booster.predict(np.asarray([features(bank.accounts[a], inc[a], out[a], devs, bank.now) for a in bank.accounts]))
    return round(float((p >= 0.5).mean()), 3)


@cache
def _synthetic(banks, holdout):  # built once per process, so an analyst-triggered retrain takes seconds
    X, y = zip(*(dataset(s, n_normal=n, n_txns=t) for s, n, t in banks))
    return np.vstack(X), np.concatenate(y), *dataset(holdout, n_normal=500, n_txns=10000)


def train(banks=BANKS, holdout=99, rounds=300, extra=None, weight=30.0, version=1, save=True):
    """extra = (rows, labels) from analysts. Each analyst label weighs `weight` synthetic accounts: a handful of
    confirmed cases visibly moves the model, which is the point of a feedback loop (and its risk: see the card)."""
    X, y, Xt, yt = _synthetic(tuple(banks), holdout)
    w = np.ones(len(y))
    if extra and extra[0]:
        X, y = np.vstack([X, np.asarray(extra[0], dtype=float)]), np.concatenate([y, np.asarray(extra[1])])
        w = np.concatenate([w, np.full(len(extra[1]), weight)])
    booster = lgb.train(PARAMS, lgb.Dataset(X, y, weight=w, feature_name=NAMES), num_boost_round=rounds)
    held = metrics(yt, booster.predict(Xt)) | {"false_alarms_on_ordinary_customers": live_false_alarms(booster)}
    imp = booster.feature_importance("gain")
    card = dict(model="LightGBM gradient-boosted trees (binary classifier)", explanation="Exact TreeSHAP contributions (log-odds)",
                features=[dict(name=n, monotone=m) for n, _, m in FEATURES], trained_on=f"{len(y)} accounts from {len(banks)} synthetic banks of different sizes "
                f"({int(y.sum())} mule accounts; legitimate look-alikes: payroll, merchants, cash shops, savings sweeps)",
                holdout=dict(description="A separate synthetic bank the model never saw", **held),
                top_features=[NAMES[i] for i in np.argsort(-imp)[:5]], trained=datetime.now().isoformat(timespec="seconds"),
                rounds=rounds, version=version, analyst_labels=len(extra[1]) if extra else 0,
                caveat="Synthetic training data. Validate on real labelled data before production use.")
    if save:
        MODEL_DIR.mkdir(exist_ok=True)
        booster.save_model(str(MODEL_DIR / "mule_classifier.txt"))
        (MODEL_DIR / "card.json").write_text(json.dumps(card, indent=2))
    return booster, card


if __name__ == "__main__":
    if sys.argv[1:] == ["train"]:
        _, card = train()
        print(json.dumps(card["holdout"], indent=2), "\ntop features:", card["top_features"])
        sys.exit()
    booster, card = load()
    assert booster, "no model yet: run `python3 xai.py train`"
    Xt, yt = dataset(98, n_normal=500, n_txns=10000, n_rings=20, n_legit=40)
    p = booster.predict(Xt)
    m = metrics(yt, p)
    assert m["auc"] >= 0.9, m
    fa = live_false_alarms(booster, seed=321)
    assert fa <= 0.05, f"flags {fa:.0%} of ordinary customers"
    ex = explain(booster, Xt[:50])
    for e, x in zip(ex, Xt[:50]):  # contributions + base add up to the raw score, and the score is its sigmoid
        assert abs(sum(c["contribution"] for c in e["contributions"]) + e["base"] - e["raw"]) < 0.05, e
        assert abs(e["score"] - booster.predict(x[None])[0]) < 0.002
    i = NAMES.index("min_minutes_to_forward")  # monotone: forwarding faster never lowers the score
    row = Xt[np.argmax(p)].copy()
    slow, quick = row.copy(), row.copy()
    slow[i], quick[i] = 600, 5
    assert booster.predict(quick[None])[0] >= booster.predict(slow[None])[0]
    # Feedback loop: an analyst's "not a mule" on a high-scoring account pulls that account's score down.
    hi = Xt[np.argmax(p)]
    b2, c2 = train(extra=([hi], [0]), version=2, save=False)
    assert c2["version"] == 2 and c2["analyst_labels"] == 1 and b2.predict(hi[None])[0] < booster.predict(hi[None])[0]
    print("held-out:", m, "| ordinary customers flagged:", fa)
    print("xai self-check ok")
