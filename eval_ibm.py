"""Score MuleTrace's rules on the IBM AML dataset (labels it didn't create).
Download: kaggle datasets download ealtman2019/ibm-transactions-for-anti-money-laundering-aml -f HI-Small_Trans.csv
Run:      python eval_ibm.py HI-Small_Trans.csv [--limit 1000000] [--patterns HI-Small_Patterns.txt] [--ai] [--out data/eval.json]
Uses USD rows only (rule thresholds are in USD for this dataset); self-transfers are dropped.
--patterns scores whole laundering attempts (IBM's ring-level ground truth): an attempt counts as caught
when at least one of its accounts is flagged. --out writes the result for the dashboard's benchmark card.
--ai trains the classifier on IBM's earlier days and tests it on the later days (see ai())."""
import argparse
import csv
import json
from bisect import bisect_left
from collections import Counter
from datetime import date, datetime
from pathlib import Path

import lightgbm as lgb
import numpy as np

import muletrace as mt
import xai

BAND = (9000, 10000)  # USD: deposits just under the US $10,000 reporting rule


def load(path, limit=None):
    accounts, txns, bad = {}, [], set()
    with open(path, newline="") as f:
        rows = csv.reader(f)
        next(rows)
        for i, (ts, fb, fa, tb, ta, _, _, paid, cur, fmt, laund) in enumerate(rows):
            if limit and i >= limit:
                break
            s, r = f"{fb}-{fa}", f"{tb}-{ta}"
            if cur != "US Dollar" or s == r:
                continue
            t = datetime.strptime(ts, "%Y/%m/%d %H:%M")
            txns.append(dict(txn_id=f"TX{i}", ts=t, sender_account=s, receiver_account=r, amount=float(paid),
                             channel=fmt, device_id=s, ip="", laundering=laund == "1"))  # no device data: shared_device never fires
            if laund == "1":
                bad |= {s, r}
    txns.sort(key=mt.TS)
    for t in txns:
        for a in (t["sender_account"], t["receiver_account"]):
            accounts.setdefault(a, dict(kyc_risk=0, open_date=t["ts"].date().isoformat()))  # first seen = opened
    return accounts, txns, bad


def attempts(path):
    """IBM's laundering attempts: blocks between 'BEGIN LAUNDERING ATTEMPT - <TYPE>' and 'END …'."""
    out, cur = [], None
    with open(path, newline="") as f:
        for line in f:
            line = line.strip()
            if line.startswith("BEGIN LAUNDERING ATTEMPT"):
                cur = (line.split(" - ", 1)[-1].split(":")[0].strip(), set())
            elif line.startswith("END LAUNDERING ATTEMPT"):
                if cur and cur[1]:
                    out.append(cur)
                cur = None
            elif line and cur:
                r = next(csv.reader([line]))
                cur[1].update((f"{r[1]}-{r[2]}", f"{r[3]}-{r[4]}"))
    return out


def score_attempts(found, accounts, flagged):
    seen = [(k, a) for k, a in found if a & accounts.keys()]  # only attempts present in the rows we loaded
    caught = [(k, a) for k, a in seen if a & flagged]
    by = Counter(k for k, _ in seen)
    hit = Counter(k for k, _ in caught)
    return dict(attempts=len(seen), attempts_caught=len(caught),
                attempt_recall=round(len(caught) / len(seen), 3) if seen else 0,
                by_type={k: f"{hit[k]}/{n}" for k, n in by.most_common()})


def score(accounts, txns, bad):
    inc, out, devs = mt.index(txns)
    alerts = mt.detect(accounts, inc, out, devs, band=BAND, min_pass=5000, min_dormant=10000)
    flagged = {a["account_id"] for a in alerts}
    hit = flagged & bad
    precision = len(hit) / len(flagged) if flagged else 0
    base = len(bad) / len(accounts)
    return dict(transactions=len(txns), accounts=len(accounts), laundering_accounts=len(bad), alerts=len(flagged),
                caught=len(hit), precision=round(precision, 3), recall=round(len(hit) / len(bad), 3) if bad else 0,
                base_rate=round(base, 4), lift=round(precision / base, 1) if base else 0,
                networks=len(mt.networks(alerts, inc, out, devs, min_amt=5000))), flagged


def window_rows(txns):
    """Classifier features and labels from one time window only. IBM has no KYC, devices, expected volume or
    opening dates, so those features are missing, and every account counts as opened when the window starts."""
    inc, out, devs = mt.index(txns)
    bad = {a for t in txns if t["laundering"] for a in (t["sender_account"], t["receiver_account"])}
    ids = sorted(inc.keys() | out.keys())
    acc = dict(open_date=txns[0]["ts"].date().isoformat(), kyc_risk=None)
    X = np.asarray([xai.features({**acc, "account_id": a}, inc[a], out[a], {}, txns[-1]["ts"], band=BAND, big=10000)
                    for a in ids])
    return ids, X, np.array([a in bad for a in ids], dtype=int), (inc, out, devs, acc)


def ai(txns, train_share=0.65, rounds=300):
    """Train on the earliest `train_share` of the transactions, test on the rest: features and labels come from
    disjoint windows, so the test is the model meeting days it never saw. Compared at the same alert budget as the
    rules. Split by count, not time span: IBM's last days hold a sparse tail of almost only laundering rows."""
    cut = txns[int(len(txns) * train_share)]["ts"]
    i = bisect_left(txns, cut, key=mt.TS)
    _, Xa, ya, _ = window_rows(txns[:i])
    ids, Xb, yb, (inc, out, devs, acc) = window_rows(txns[i:])
    booster = lgb.train(xai.PARAMS, lgb.Dataset(Xa, ya, feature_name=xai.NAMES), num_boost_round=rounds)
    p = booster.predict(Xb)
    accounts = {a: {**acc, "account_id": a, "kyc_risk": 0} for a in ids}  # rules need a number, as in load()
    rules = {a["account_id"] for a in mt.detect(accounts, inc, out, devs, band=BAND, min_pass=5000, min_dormant=10000)}
    k = len(rules)  # alert budget: as many accounts as the rules flag on the test days
    top = np.argsort(-p)[:k]
    caught_ai, caught_rules = int(yb[top].sum()), int(sum(yb[n] for n, a in enumerate(ids) if a in rules))
    base = float(yb.mean())
    synthetic = xai.load()[0]
    imp = booster.feature_importance("gain")
    assert 0 < yb.sum() < len(yb), "the test window needs both laundering and clean accounts"
    return dict(train_days=f"{txns[0]['ts']:%Y-%m-%d} to {cut:%Y-%m-%d %H:%M}", test_days=f"{cut:%Y-%m-%d %H:%M} to {txns[-1]['ts']:%Y-%m-%d}",
                train_accounts=len(ya), train_laundering=int(ya.sum()), test_accounts=len(yb), test_laundering=int(yb.sum()),
                auc=round(xai.auc(yb, p), 3), auc_synthetic_model=round(xai.auc(yb, synthetic.predict(Xb)), 3) if synthetic else None,
                alert_budget=k, caught_rules=caught_rules, caught_ai=caught_ai,
                precision_rules=round(caught_rules / k, 3) if k else 0, precision_ai=round(caught_ai / k, 3) if k else 0,
                lift_rules=round(caught_rules / k / base, 1) if k else 0, lift_ai=round(caught_ai / k / base, 1) if k else 0,
                top_features=[xai.NAMES[j] for j in np.argsort(-imp)[:5]])


def run(path, limit=None, patterns=None, with_ai=False):
    accounts, txns, bad = load(path, limit)
    res, flagged = score(accounts, txns, bad)
    res = dict(dataset=f"IBM AML {Path(path).stem}", rows_read=limit or "all", currency="USD only",
               notes="No device data, so the shared-device rule never fires. Thresholds in USD (US $10,000 rule).",
               run_on=date.today().isoformat(), **res)
    if patterns:
        res |= score_attempts(attempts(patterns), accounts, flagged)
    if with_ai:
        res["ai"] = ai(txns)
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--limit", type=int, help="read only the first N rows (the full file needs a few GB of RAM)")
    ap.add_argument("--patterns", help="HI-Small_Patterns.txt, to score whole laundering attempts")
    ap.add_argument("--out", help="write the result as JSON (data/eval.json feeds the dashboard card)")
    ap.add_argument("--ai", action="store_true", help="also train the classifier on the earlier days, test on the later ones")
    args = ap.parse_args()
    res = run(args.csv, args.limit, args.patterns, args.ai)
    for k, v in res.items():
        print(f"{k:>20}: {v}")
    if args.out:
        Path(args.out).write_text(json.dumps(res, indent=2))
        print(f"wrote {args.out}")
