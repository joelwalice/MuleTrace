"""Score MuleTrace's rules on the IBM AML dataset (labels it didn't create).
Download: kaggle datasets download ealtman2019/ibm-transactions-for-anti-money-laundering-aml -f HI-Small_Trans.csv
Run:      python eval_ibm.py HI-Small_Trans.csv [--limit 1000000]
Uses USD rows only (rule thresholds are in USD for this dataset); self-transfers are dropped."""
import argparse
import csv
from datetime import datetime

import muletrace as mt


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
                             channel=fmt, device_id=s, ip=""))  # no device data: shared_device never fires
            if laund == "1":
                bad |= {s, r}
    txns.sort(key=mt.TS)
    for t in txns:
        for a in (t["sender_account"], t["receiver_account"]):
            accounts.setdefault(a, dict(kyc_risk=0, open_date=t["ts"].date().isoformat()))  # first seen = opened
    return accounts, txns, bad


def score(accounts, txns, bad):
    inc, out, devs = mt.index(txns)
    alerts = mt.detect(accounts, inc, out, devs, band=(9000, 10000), min_pass=5000, min_dormant=10000)
    flagged = {a["account_id"] for a in alerts}
    hit = flagged & bad
    precision = len(hit) / len(flagged) if flagged else 0
    base = len(bad) / len(accounts)
    return dict(transactions=len(txns), accounts=len(accounts), laundering_accounts=len(bad), alerts=len(flagged),
                caught=len(hit), precision=round(precision, 3), recall=round(len(hit) / len(bad), 3) if bad else 0,
                base_rate=round(base, 4), lift=round(precision / base, 1) if base else 0,
                networks=len(mt.networks(alerts, inc, out, devs, min_amt=5000)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--limit", type=int, help="read only the first N rows (the full file needs a few GB of RAM)")
    args = ap.parse_args()
    for k, v in score(*load(args.csv, args.limit)).items():
        print(f"{k:>20}: {v}")
