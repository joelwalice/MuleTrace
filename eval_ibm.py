"""Score MuleTrace's rules on the IBM AML dataset (labels it didn't create).
Download: kaggle datasets download ealtman2019/ibm-transactions-for-anti-money-laundering-aml -f HI-Small_Trans.csv
Run:      python eval_ibm.py HI-Small_Trans.csv [--limit 1000000] [--patterns HI-Small_Patterns.txt] [--out data/eval.json]
Uses USD rows only (rule thresholds are in USD for this dataset); self-transfers are dropped.
--patterns scores whole laundering attempts (IBM's ring-level ground truth): an attempt counts as caught
when at least one of its accounts is flagged. --out writes the result for the dashboard's benchmark card."""
import argparse
import csv
import json
from collections import Counter
from datetime import date, datetime
from pathlib import Path

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
    alerts = mt.detect(accounts, inc, out, devs, band=(9000, 10000), min_pass=5000, min_dormant=10000)
    flagged = {a["account_id"] for a in alerts}
    hit = flagged & bad
    precision = len(hit) / len(flagged) if flagged else 0
    base = len(bad) / len(accounts)
    return dict(transactions=len(txns), accounts=len(accounts), laundering_accounts=len(bad), alerts=len(flagged),
                caught=len(hit), precision=round(precision, 3), recall=round(len(hit) / len(bad), 3) if bad else 0,
                base_rate=round(base, 4), lift=round(precision / base, 1) if base else 0,
                networks=len(mt.networks(alerts, inc, out, devs, min_amt=5000))), flagged


def run(path, limit=None, patterns=None):
    accounts, txns, bad = load(path, limit)
    res, flagged = score(accounts, txns, bad)
    res = dict(dataset=f"IBM AML {Path(path).stem}", rows_read=limit or "all", currency="USD only",
               notes="No device data, so the shared-device rule never fires. Thresholds in USD (US $10,000 rule).",
               run_on=date.today().isoformat(), **res)
    if patterns:
        res |= score_attempts(attempts(patterns), accounts, flagged)
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--limit", type=int, help="read only the first N rows (the full file needs a few GB of RAM)")
    ap.add_argument("--patterns", help="HI-Small_Patterns.txt, to score whole laundering attempts")
    ap.add_argument("--out", help="write the result as JSON (data/eval.json feeds the dashboard card)")
    args = ap.parse_args()
    res = run(args.csv, args.limit, args.patterns)
    for k, v in res.items():
        print(f"{k:>20}: {v}")
    if args.out:
        Path(args.out).write_text(json.dumps(res, indent=2))
        print(f"wrote {args.out}")
