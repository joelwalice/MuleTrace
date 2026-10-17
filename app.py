"""MuleTrace API. `uvicorn app:app --reload` -> http://localhost:8000 (OpenAPI at /docs for Copilot Studio connector).

Live mode: a bank clock runs continuously (default 30x real time) and an endless feed of ordinary customer
transactions streams in. Mule attacks are launched on demand (POST /inject/{kind}) or by autopilot, and anyone can
send transfers in (POST /ingest). Every tick reruns detection, so alerts and rings appear as the money moves.
Clients subscribe to GET /stream (server-sent events)."""
import asyncio
import heapq
import json
import os
import random
import time
import urllib.request
from urllib.parse import quote, urlencode
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from io import StringIO
from statistics import median

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

import muletrace as mt
import xai
from muletrace import inr

TICK = 0.25          # real seconds per tick
FEED_RATE = 2.0      # ordinary transactions per real second
SPEEDS = (1, 10, 30, 60)
RING_LABEL = {"structuring": "Structuring", "chain": "Pass-Through Chain", "fan": "Fan-In / Fan-Out"}
DATA = Path(__file__).parent / "data"


class Policy(BaseModel):
    """Detection policy. Defaults reproduce the rules the demo and the self-check are built on."""
    rules: list[Literal[*mt.RULES]] = Field(default=list(mt.RULES), description="Rules switched on")
    band_floor: int = Field(45000, ge=30000, le=49000, description="Structuring: lowest cash deposit counted (₹); the ceiling is the ₹50,000 PAN threshold")
    pass_ratio: float = Field(0.8, ge=0.5, le=1.0, description="Pass-through: share of a deposit sent onward within 30 min")
    min_pass: int = Field(50000, ge=10000, le=1000000, description="Pass-through: smallest deposit checked (₹)")
    fan: int = Field(5, ge=2, le=20, description="Fan-in/fan-out: more than this many senders and receivers within 1h")
    dormant_days: int = Field(90, ge=30, le=365, description="Dormant: days without activity before a large transfer")

    def kwargs(self):
        return dict(band=(self.band_floor, 50000), min_pass=self.min_pass, rules=set(self.rules), ratio=self.pass_ratio,
                    fan=self.fan, dormant_days=self.dormant_days)


class Live:
    def __init__(self):
        self.sent = (None, "")  # (version, serialised snapshot): every SSE client shares one serialisation
        self.requests = deque()  # injections, transfers and policy changes, applied inside the tick (never mid-detection)
        self.policy = Policy()  # survives New Bank: it's the analyst's setting, not the bank's data
        self.reset()

    def reset(self):
        now = datetime.now().replace(microsecond=0)
        self.bank = mt.Bank(seed=random.randrange(1 << 30), now=now)
        self.txns = mt.history(self.bank, rings=False)  # 30 days of ordinary customers; rings only arrive live
        self.seq, self.clock, self.running, self.speed, self.version = len(self.txns), now, True, 30, 0
        self.queue, self.attacks, self.autopilot, self.next_auto = [], [], False, 0.0
        self.frozen, self.cases, self.net_status, self.alert_ids, self.net_ids = set(), [], {}, {}, {}
        self.labels = {}  # account id -> True (confirmed mule) / False (not a mule): analyst feedback for retraining
        self.recompute()

    @property
    def accounts(self):
        return self.bank.accounts

    # -- state changes, all run on the event loop inside tick() --------------------------------------------------
    def _schedule(self, txns, attack=None):
        for t in txns:
            heapq.heappush(self.queue, (t["ts"], self.seq, attack, t))
            self.seq += 1

    def _inject(self, kind):
        plan = self.bank.ring(kind, self.clock + timedelta(seconds=30))
        attack = dict(id=f"ATK-{len(self.attacks) + 1:02d}", kind=kind, label=RING_LABEL[kind], started=self.clock,
                      total=len(plan), left=len(plan), accounts=sorted({a for t in plan for a in (t["sender_account"], t["receiver_account"])}))
        self.attacks.append(attack)
        self._schedule(plan, attack)

    def _ingest(self, transfers):
        for t in transfers:
            for aid in (t.sender, t.receiver):
                if aid not in self.accounts:  # people and scripts can use any account id; it opens as a walk-in
                    self.bank.accounts[aid] = dict(account_id=aid, name=f"Walk-in {aid}", type="savings", kyc_risk=0.3,
                                                   open_date=(self.clock - timedelta(days=365)).date().isoformat(),
                                                   home_branch="Hackathon Floor", expected_monthly_volume=50000)
                    self.bank.dev[aid] = f"DEV{8000 + len(self.bank.dev) % 1000}"
            self._schedule([self.bank.txn(self.clock, t.sender, t.receiver, t.amount, t.channel)])

    def tick(self):
        changed = bool(self.requests)
        while self.requests:
            kind, arg = self.requests.popleft()
            if kind == "policy":
                self.policy = arg
            else:
                self._inject(arg) if kind == "inject" else self._ingest(arg)
        if not self.running:
            return changed
        start, self.clock = self.clock, self.clock + timedelta(seconds=TICK * self.speed)
        rng = self.bank.rng
        n = int(FEED_RATE * TICK) + (rng.random() < FEED_RATE * TICK % 1)
        fresh = [self.bank.normal(start + (self.clock - start) * rng.random()) for _ in range(n)]
        while self.queue and self.queue[0][0] <= self.clock:
            _, _, attack, t = heapq.heappop(self.queue)
            if attack:
                attack["left"] -= 1
            fresh.append(t)
        if self.autopilot and time.monotonic() >= self.next_auto:
            self._inject(rng.choice(mt.RING_KINDS))
            self.next_auto = time.monotonic() + rng.uniform(60, 120)
        for t in sorted(fresh, key=mt.TS):
            t["txn_id"] = f"TX{self.seq:07d}"
            self.seq += 1
            self.txns.append(t)
        return True

    def recompute(self):
        txns = self.txns
        inc, out, devs = mt.index(txns)
        alerts = mt.detect(self.accounts, inc, out, devs, **self.policy.kwargs())
        for a in alerts:  # stable ids: first time an account alerts, it keeps that id
            a["alert_id"] = self.alert_ids.setdefault(a["account_id"], f"AL-{101 + len(self.alert_ids)}")
        nets = mt.networks(alerts, inc, out, devs)
        order = lambda aid: int(aid[3:])
        for n in nets:  # a ring is named after its earliest alert, so it keeps its id as it grows
            n["network_id"] = self.net_ids.setdefault(min(n["alert_ids"], key=order), f"NET-{len(self.net_ids) + 1}")
        nets.sort(key=lambda n: int(n["network_id"][4:]))
        self.inc, self.out, self.devs, self.alerts, self.nets = inc, out, devs, alerts, nets
        self.alert_by = {a["alert_id"]: a for a in alerts}
        self.net_by = {n["network_id"]: n for n in nets}
        self.net_of = {aid: n["network_id"] for n in nets for aid in n["alert_ids"]}
        self.version += 1

    # -- read side ------------------------------------------------------------------------------------------------
    def risk(self, aid):
        return max((a["score"] for a in self.alerts if a["account_id"] == aid), default=self.accounts[aid]["kyc_risk"] * 0.5)

    def alert_view(self, a):
        return {k: v for k, v in a.items() if k != "evidence"} | {
            "network_id": self.net_of[a["alert_id"]], "status": "frozen" if a["account_id"] in self.frozen else "new"}

    def net_view(self, n):
        return {k: v for k, v in n.items() if k not in ("edges", "devices")} | {"status": self.net_status.get(n["network_id"], "open")}

    def snapshot(self):
        alerted = {a["account_id"] for a in self.alerts}
        return dict(version=self.version, clock=self.clock, running=self.running, speed=self.speed, speeds=SPEEDS,
                    feed_rate=FEED_RATE, queued=len(self.queue), autopilot=self.autopilot, policy=self.policy.model_dump(),
                    model_version=CARD.get("version", 1),
                    attacks=[{k: v for k, v in a.items() if k != "accounts"} for a in self.attacks[-6:]][::-1],
                    cases=[{k: c[k] for k in ("case_id", "network_id", "status")} for c in self.cases],
                    labels=dict(mule=sum(self.labels.values()), not_mule=len(self.labels) - sum(self.labels.values())),
                    stats=dict(transactions=len(self.txns), alerts=len(self.alerts), networks=len(self.nets),
                               total_in=round(sum(n["total_in"] for n in self.nets), 2), frozen=len(self.frozen),
                               cases=len(self.cases)),
                    alerts=[self.alert_view(a) for a in self.alerts],
                    networks=[self.net_view(n) for n in self.nets],
                    feed=[dict(t, suspicious=t["sender_account"] in alerted or t["receiver_account"] in alerted)
                          for t in self.txns[-40:][::-1]])


LIVE = Live()
iso = lambda o: o.isoformat() if hasattr(o, "isoformat") else str(o)


async def ticker():
    while True:
        await asyncio.sleep(TICK)
        if LIVE.tick():
            await asyncio.to_thread(LIVE.recompute)


@asynccontextmanager
async def lifespan(_):
    task = asyncio.create_task(ticker())
    yield
    task.cancel()


mt.export(DATA, mt.ACCOUNTS, mt.TXNS, mt.ALERTS, mt.NETWORKS)
app = FastAPI(title="MuleTrace", lifespan=lifespan,
              description="AML SOC: mule network detection with time-ordered money trails (INR, FIU-IND STR)")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:3000").split(","),
                   allow_methods=["*"], allow_headers=["*"])


def lookup(table, key, what):
    if key not in table:
        raise HTTPException(404, f"No {what} {key}")
    return table[key]


PATTERN = {"structuring": "structuring", "passthrough": "rapid pass-through", "fan_in_out": "fan-in/fan-out",
           "dormant": "dormant account wake-up", "shared_device": "shared device"}
GROUNDS = {"structuring": "repeated cash deposits just under the ₹50,000 PAN threshold",
           "passthrough": "rapid pass-through with funds forwarded within minutes",
           "fan_in_out": "many senders funnelled through a hub to many receivers",
           "dormant": "a dormant account suddenly moving large sums",
           "shared_device": "several accounts operated from the same device"}


def pats(ps):
    return ", ".join(PATTERN[p] for p in ps)


def names(ids):
    return ", ".join(f"{i} ({LIVE.accounts[i]['name']})" for i in sorted(ids)) or "none found"


def by_device(links):
    d = {}
    for acc, dev in links:
        d.setdefault(dev, []).append(acc)
    return "; ".join(f"{dev}: {', '.join(accs)}" for dev, accs in d.items()) or "none"


def graph(edges, devices, role):
    ids = {e["sender_account"] for e in edges} | {e["receiver_account"] for e in edges} | {a for a, _ in devices}
    return {"nodes": [dict(id=i, name=LIVE.accounts[i]["name"], risk=LIVE.risk(i), role=role(i), frozen=i in LIVE.frozen)
                      for i in sorted(ids)]
                     + [dict(id=d, name="shared device", role="device", risk=0, frozen=False) for d in sorted({d for _, d in devices})],
            "edges": [dict(id=e["txn_id"], source=e["sender_account"], target=e["receiver_account"], amount=e["amount"],
                           ts=e["ts"], kind="money") for e in edges]
                     + [dict(id=f"{a}-{d}", source=a, target=d, kind="shared_device") for a, d in devices]}


def notify(payload):
    url = os.environ.get("PLAYBOOK_WEBHOOK")  # Power Automate "When an HTTP request is received" URL
    if not url:
        return "not configured (set PLAYBOOK_WEBHOOK)"
    req = urllib.request.Request(url, json.dumps(payload, default=iso).encode(), {"Content-Type": "application/json"})
    try:
        return f"sent ({urllib.request.urlopen(req, timeout=10).status})"
    except Exception as e:
        return f"failed: {e}"


@app.get("/stream", summary="Server-sent events: a full snapshot whenever the live state changes")
async def stream():
    async def events():
        seen, idle = None, 0
        while True:
            if LIVE.version != seen:
                seen, idle = LIVE.version, 0
                if LIVE.sent[0] != seen:
                    LIVE.sent = (seen, json.dumps(LIVE.snapshot(), default=iso))
                yield f"data: {LIVE.sent[1]}\n\n"
            elif (idle := idle + 1) % 60 == 0:
                yield ": keepalive\n\n"
            await asyncio.sleep(TICK)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/live/{action}", summary="Live feed control: play, pause or reset (reset starts a fresh bank)")
def live(action: Literal["play", "pause", "reset"], speed: int | None = None):
    if speed is not None and speed not in SPEEDS:
        raise HTTPException(422, f"speed must be one of {', '.join(map(str, SPEEDS))}")
    if action == "reset":
        LIVE.reset()
    else:
        LIVE.running = action == "play"
    if speed:
        LIVE.speed = speed
    LIVE.version += 1
    return {"running": LIVE.running, "speed": LIVE.speed, "clock": LIVE.clock}


@app.post("/inject/{kind}", summary="Launch a mule attack with fresh accounts; its transfers play out on the bank clock")
async def inject(kind: Literal["structuring", "chain", "fan"]):
    LIVE.requests.append(("inject", kind))
    return {"queued": kind, "label": RING_LABEL[kind]}


@app.post("/autopilot", summary="Launch a random mule attack every 1-2 minutes (for an unattended booth)")
async def autopilot(on: bool):
    LIVE.autopilot, LIVE.next_auto = on, time.monotonic() + 5
    LIVE.version += 1
    return {"autopilot": on}


ACCOUNT_ID = r"^[A-Z0-9][A-Z0-9-]{2,23}$"


class Transfer(BaseModel):
    sender: str = Field(pattern=ACCOUNT_ID, description="Account id, e.g. AC0042 or JUDGE-01 (new ids open as walk-ins)")
    receiver: str = Field(pattern=ACCOUNT_ID)
    amount: float = Field(gt=0, le=10_000_000, description="Rupees, up to ₹1 crore per transfer")
    channel: Literal["upi", "imps", "neft", "rtgs", "cash", "card", "atm"] = "upi"

    @field_validator("sender", "receiver", mode="before")
    @classmethod
    def _normalise(cls, v):
        return v.strip().upper() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _distinct(self):
        if self.sender == self.receiver:
            raise ValueError("sender and receiver must be different accounts")
        return self


@app.post("/ingest", summary="Send transfers into the live bank (stamped with the bank clock, not client time)")
async def ingest(transfers: Transfer | list[Transfer]):
    batch = transfers if isinstance(transfers, list) else [transfers]
    if len(batch) > 500:
        raise HTTPException(413, "Send at most 500 transfers per request")
    LIVE.requests.append(("ingest", batch))
    return {"accepted": len(batch), "clock": LIVE.clock, "running": LIVE.running}


@app.get("/snapshot", summary="Current live state (same payload as /stream)")
def snapshot():
    return LIVE.snapshot()


@app.get("/stats", summary="Headline numbers: alerts vs networks")
def stats():
    return LIVE.snapshot()["stats"]


@app.get("/alerts", operation_id="listAlerts", summary="Alert queue, highest score first. Each alert names the ring (network_id) it belongs to.")
def alerts():
    return [LIVE.alert_view(a) for a in LIVE.alerts]


@app.get("/networks", operation_id="listRings", summary="Mule rings (networks): alerts grouped by linked money and devices")
def networks():
    return [LIVE.net_view(n) for n in LIVE.nets]


@app.get("/account/{account_id}", operation_id="getAccount", summary="Account 360: KYC, money in and out, pass-through %, devices, alerts and the last 50 transactions")
def account(account_id: str):
    lookup(LIVE.accounts, account_id, "account")
    return {**mt.profile(account_id, LIVE.accounts, LIVE.inc, LIVE.out), "risk": LIVE.risk(account_id),
            "label": LIVE.labels.get(account_id),
            "frozen": account_id in LIVE.frozen,
            "alerts": [LIVE.alert_view(a) for a in LIVE.alerts if a["account_id"] == account_id]}


@app.get("/alert/{alert_id}/graph", operation_id="traceAlertMoney", summary="Time-ordered money trail for one alert: every transfer (id, amount, time) upstream and downstream")
def alert_graph(alert_id: str):
    a = lookup(LIVE.alert_by, alert_id, "alert")
    edges, up, down, lateral = mt.trace(a["account_id"], a["ts"], LIVE.inc, LIVE.out, LIVE.devs)
    role = lambda i: "subject" if i == a["account_id"] else "upstream" if i in up else "downstream" if i in down else "lateral"
    return graph(edges, mt.device_links({a["account_id"]} | lateral, LIVE.out, LIVE.devs), role)


@app.get("/alert/{alert_id}", operation_id="draftAlertStr", summary="Alert detail: plain-English explanation, STR draft for FIU-IND and its completeness checklist")
def alert(alert_id: str):
    a = LIVE.alert_view(lookup(LIVE.alert_by, alert_id, "alert"))
    p = mt.profile(a["account_id"], LIVE.accounts, LIVE.inc, LIVE.out)
    _, up, down, lateral = mt.trace(a["account_id"], a["ts"], LIVE.inc, LIVE.out, LIVE.devs)
    explanation = (f"{p['name']} ({p['account_id']}) is flagged {a['severity']} risk ({a['score']}): " + "; ".join(a["reasons"])
                   + f". It forwarded {p['passthrough_pct']}% of what it received"
                   + (f", typically within {p['avg_minutes_to_forward']} minutes" if p["avg_minutes_to_forward"] else "")
                   + f", which is typical of a money mule. It belongs to network {a['network_id']}.")
    str_draft = (f"SUSPICIOUS TRANSACTION REPORT (DRAFT) - for FIU-IND\n\nSubject: {p['name']}, account {p['account_id']}, "
                 f"{p['type']} account opened {p['open_date']} at {p['home_branch']} branch, KYC risk {p['kyc_risk']}.\n\n"
                 f"Activity: The account received {inr(p['total_received'])} from {p['unique_senders']} counterparties and sent "
                 f"{inr(p['total_sent'])} to {p['unique_receivers']} counterparties ({p['passthrough_pct']}% pass-through). "
                 f"Detected patterns: {'; '.join(a['reasons'])}.\n\n"
                 f"Money trail: Sources: {names(up)}. Recipients: {names(down)}. Accounts sharing a device: {names(lateral)}.\n\n"
                 f"Grounds for suspicion: Activity is consistent with a money mule account layering funds as part of "
                 f"network {a['network_id']}. Recommended: freeze, file STR within 7 working days, review linked accounts, re-KYC.")
    cited = list(dict.fromkeys(i for ev in LIVE.alert_by[alert_id]["evidence"] for c in ev["computations"]
                               for i in c["inputs"] if i.startswith("TX")))
    return {**a, "explanation": explanation, "str_draft": str_draft,
            "checklist": checklist([a["account_id"]], cited, bool(up or down), sorted(lateral)),
            "upstream": sorted(up), "downstream": sorted(down), "lateral": sorted(lateral),
            "account": {k: v for k, v in p.items() if k != "txns"}}


@app.get("/network/{network_id}/graph", operation_id="traceRingMoney", summary="Time-ordered money trail for a whole ring: every transfer from source accounts to exits")
def network_graph(network_id: str):
    n = lookup(LIVE.net_by, network_id, "network")
    role = lambda i: "subject" if i in n["alerted"] else "source" if i in n["sources"] else "member"
    return graph(n["edges"], n["devices"], role)


@app.get("/network/{network_id}", operation_id="draftRingStr", summary="Ring summary: sources, mules, exits, STR draft for FIU-IND and its completeness checklist")
def network(network_id: str):
    n = lookup(LIVE.net_by, network_id, "network")
    mules = sorted(set(n["freeze"]) - set(n["exits"]))
    span = f"{n['first_ts']:%d %b %H:%M} and {n['last_ts']:%d %b %H:%M}"
    explanation = (f"{network_id} is a {n['severity']}-risk mule ring of {len(n['accounts'])} accounts. "
                   f"{inr(n['total_in'])} entered the ring between {span}. {len(n['alert_ids'])} alert(s) "
                   f"({', '.join(n['alert_ids'])}) belong to this one ring. Patterns: {pats(n['patterns'])}. "
                   f"Sources: {len(n['sources'])}, mule accounts: {len(mules)}, exit accounts: {len(n['exits'])}.")
    str_draft = (f"SUSPICIOUS TRANSACTION REPORT (DRAFT) - for FIU-IND\nNetwork {network_id}, {len(n['accounts'])} accounts\n\n"
                 f"Summary: Between {span}, {inr(n['total_in'])} entered a network of linked accounts and was layered onward. "
                 f"Alerts raised: {', '.join(n['alert_ids'])}. Patterns: {pats(n['patterns'])}.\n\n"
                 f"Source accounts (possible victims or organisers, review before action): {names(n['sources'])}.\n"
                 f"Mule accounts: {names(mules)}.\nExit accounts: {names(n['exits'])}.\n"
                 f"Shared devices: {by_device(n['devices'])}.\n\n"
                 f"Grounds for suspicion: {'; '.join(GROUNDS[p] for p in n['patterns'])}, across linked accounts "
                 f"with no apparent economic purpose, indicating layering of proceeds of crime.\n"
                 f"Action: freeze mule and exit accounts, review sources, file STR within 7 working days, notify LEA if fraud victims identified.")
    return LIVE.net_view(n) | {"explanation": explanation, "str_draft": str_draft, "mules": mules,
                               "checklist": checklist(n["alerted"], [e["txn_id"] for e in n["edges"]], bool(n["edges"]),
                                                      sorted({a for a, _ in n["devices"]}))}


@app.post("/network/{network_id}/dismantle", operation_id="dismantleRing", summary="Freeze mule and exit accounts (simulated), open a case and trigger the Power Automate playbook. Only call after the analyst confirms.")
def dismantle(network_id: str):
    n = lookup(LIVE.net_by, network_id, "network")
    if LIVE.net_status.get(network_id) == "dismantled":
        raise HTTPException(409, f"{network_id} is already dismantled")
    detail = network(network_id)
    LIVE.frozen.update(n["freeze"])
    for a in n["freeze"]:  # a dismantled ring is a confirmed label for the classifier; sources stay unlabelled (may be victims)
        LIVE.labels.setdefault(a, True)
    LIVE.net_status[network_id] = "dismantled"
    case = dict(case_id=f"CASE-{len(LIVE.cases) + 1:03d}", network_id=network_id, alert_ids=n["alert_ids"],
                frozen=n["freeze"], review=n["sources"], summary=detail["explanation"], str_draft=detail["str_draft"],
                status="open", opened=LIVE.clock, events=[])
    k, r = len(n["freeze"]), len(n["sources"])
    log(case, f"Ring dismantled: {k} account{'s' * (k != 1)} locked, {r} sent to review")
    LIVE.cases.append(case)
    LIVE.version += 1
    return {**case, "webhook": notify({**case, "score": n["score"], "total_in": n["total_in"]})}


def log(case, text):
    case["events"].append(dict(at=LIVE.clock, text=text))


@app.get("/cases", operation_id="listCases", summary="Cases with status (open → STR filed → closed) and their audit trail")
def cases():
    return LIVE.cases


@app.post("/case/{case_id}/{action}", summary="Move a case on: file the STR with FIU-IND (simulated), or close it")
def case_action(case_id: str, action: Literal["file_str", "close"]):
    c = lookup({c["case_id"]: c for c in LIVE.cases}, case_id, "case")
    if action == "file_str":
        if c["status"] != "open":
            raise HTTPException(409, f"{case_id} is {c['status'].replace('_', ' ')}")
        c["ack"] = f"FIU-ACK-{random.randint(100000, 999999)}"
        c["status"] = "str_filed"
        log(c, f"STR filed with FIU-IND (simulated) · acknowledgement {c['ack']}")
    else:
        if c["status"] == "closed":
            raise HTTPException(409, f"{case_id} is already closed")
        c["status"] = "closed"
        log(c, "Case closed")
    LIVE.version += 1
    c["webhook"] = notify({k: v for k, v in c.items() if k != "events"})
    return c


@app.post("/account/{account_id}/label", summary="Analyst verdict on an account (feeds the classifier's next retrain)")
def label_account(account_id: str, mule: bool | None = None):
    lookup(LIVE.accounts, account_id, "account")
    if mule is None:
        LIVE.labels.pop(account_id, None)
    else:
        LIVE.labels[account_id] = mule
    LIVE.version += 1
    return {"account_id": account_id, "label": LIVE.labels.get(account_id), "labels": len(LIVE.labels)}


# -- Investigation Copilot: evidence bundles, comparisons, STR checklist -----------------------------------------
# Every number here comes from the rules, with the transaction ids it rests on, so Copilot Studio can quote
# and cite but never has to calculate. "insufficient" means: don't conclude, show the gaps.
CONF_ORDER = ["high", "medium", "low", "insufficient"]
WALK_IN = "Hackathon Floor"


def row(t, **extra):
    return dict(id=t["txn_id"], ts=t["ts"], sender=t["sender_account"], receiver=t["receiver_account"],
                amount=t["amount"], channel=t["channel"], **extra)


def walk_ins(ids):
    return [a for a in ids if LIVE.accounts[a]["home_branch"] == WALK_IN]


def gaps(subjects, edges, conf, pattern):
    g = []
    if conf == "insufficient":
        if set(pattern.split("+")) <= {"shared_device"}:
            g.append("Only the shared-device rule fired; no money-movement rule supports it")
        if len(edges) < 2:
            g.append("Fewer than 2 transfers of ₹25,000 or more in the 72h money trail")
    if w := walk_ins(subjects):
        g.append(f"No KYC documents on file for walk-in account(s) {', '.join(w)}")
    senders = {e["sender_account"] for e in edges}
    exits = sorted({e["receiver_account"] for e in edges} - senders)
    if exits:
        g.append(f"The trail leaves this bank's records at {', '.join(exits[:3])}{' and others' if len(exits) > 3 else ''}; "
                 "beyond that needs the receiving bank's records")
    return g + ["No beneficial-owner records in this dataset", "No customer explanation or source-of-funds documents on file"]


def item(label, ok, evidence=None, needs=None):
    return dict(item=label, status="supported", evidence=evidence) if ok else dict(item=label, status="missing", needs=needs)


def checklist(subjects, cited, trail, linked):
    w = walk_ins(subjects)
    return [item("Subject identity and KYC", not w, ", ".join(subjects), f"KYC documents for {', '.join(w)}"),
            item("Suspicious pattern, with transactions", bool(cited), ", ".join(cited[:4]) + (" …" if len(cited) > 4 else ""),
                 "At least one rule hit with its transactions"),
            item("Money trail: sources and recipients", trail, "Time-ordered trail (see the money-trail tool)",
                 "Transfers in or out of the subject in the 72h window"),
            item("Linked accounts or shared devices", bool(linked), ", ".join(linked[:6]),
                 "A check with other banks through FIU-IND (none found in this bank's data)"),
            item("Beneficial owner", False, needs="Beneficial-owner declaration for each subject"),
            item("Source of funds", False, needs="Customer explanation or source-of-funds documents"),
            item("Principal Officer sign-off", False, needs="Principal Officer review before the STR is filed with FIU-IND")]


def next_questions(subject, network_id, others):
    q = [dict(q=f"Trace the money through {subject}", action="trace", target=subject)]
    if others:
        q.append(dict(q=f"Why are {subject} and {others[0]} connected?", action="compare", accounts=[subject, others[0]]))
    return q + [dict(q=f"Draft the STR for {network_id}", action="str", target=network_id)]


@app.get("/alert/{alert_id}/evidence", operation_id="explainAlert",
         summary="Why an alert fired: claim, confidence, the transactions cited, computed figures with formulas, and evidence gaps")
def alert_evidence(alert_id: str):
    a = lookup(LIVE.alert_by, alert_id, "alert")
    aid, acc = a["account_id"], LIVE.accounts[a["account_id"]]
    edges, up, down, lateral = mt.trace(aid, a["ts"], LIVE.inc, LIVE.out, LIVE.devs)
    pool = {t["txn_id"]: t for t in LIVE.inc[aid] + LIVE.out[aid]}
    cited = {}
    for ev in a["evidence"]:
        for c in ev["computations"]:
            for i in c["inputs"]:
                if i in pool and i not in cited:
                    cited[i] = row(pool[i], relation="trigger" if i == ev["trigger"] else "supports", why=PATTERN[ev["pattern"]])
    conf = mt.confidence(a, len(edges))
    return dict(alert_id=alert_id, network_id=LIVE.net_of[alert_id], account_id=aid, name=acc["name"],
                pattern=a["pattern"], score=a["score"], severity=a["severity"], confidence=conf,
                claim=f"{aid} ({acc['name']}): " + "; ".join(a["reasons"]) + ".",
                reasons=a["reasons"],
                computations=[dict(c, pattern=ev["pattern"]) for ev in a["evidence"] for c in ev["computations"]],
                transactions=sorted(cited.values(), key=lambda r: r["ts"])[:25],
                ai=ai_safe([aid]),
                gaps=gaps([aid], edges, conf, a["pattern"]),
                next_questions=next_questions(aid, LIVE.net_of[alert_id], sorted(lateral) or sorted(up) or sorted(down)),
                links=dict(dashboard=f"/?alert={alert_id}", trail=f"/alert/{alert_id}/graph"))


@app.get("/network/{network_id}/evidence", operation_id="explainRing",
         summary="Why a ring is one ring: money in from sources, share reaching exits, hop timing, shared devices, every transfer cited")
def network_evidence(network_id: str):
    n = lookup(LIVE.net_by, network_id, "network")
    edges, srcs, exits = n["edges"], set(n["sources"]), set(n["exits"])
    alerts = [LIVE.alert_by[i] for i in n["alert_ids"]]
    per_alert = [dict(alert_id=a["alert_id"], account_id=a["account_id"], pattern=a["pattern"],
                      confidence=mt.confidence(a, len(edges))) for a in alerts]
    conf = min((x["confidence"] for x in per_alert), key=CONF_ORDER.index)
    src_e = [e for e in edges if e["sender_account"] in srcs]
    exit_e = [e for e in edges if e["receiver_account"] in exits]
    waits, pairs = [], []  # minutes each account held money before passing it on, within this ring
    for e in edges:
        nxt = next((x for x in edges if x["sender_account"] == e["receiver_account"] and x["ts"] >= e["ts"]), None)
        if nxt:
            waits.append((nxt["ts"] - e["ts"]).total_seconds() / 60)
            pairs += [e["txn_id"], nxt["txn_id"]]
    to_exits = sum(e["amount"] for e in exit_e)
    comps = [mt.comp("money_in", n["total_in"], "sum of transfers sent by source accounts", [e["txn_id"] for e in src_e]),
             mt.comp("money_to_exits", round(to_exits, 2), "sum of transfers into exit accounts", [e["txn_id"] for e in exit_e])]
    if n["total_in"]:
        comps.append(mt.comp("share_reaching_exits", round(to_exits / n["total_in"], 2), "money_to_exits / money_in",
                             [e["txn_id"] for e in src_e + exit_e]))
    if waits:
        comps.append(mt.comp("median_minutes_held", round(median(waits), 1),
                             "median minutes an account held money before sending it on", list(dict.fromkeys(pairs))))
    if n["devices"]:
        comps.append(mt.comp("accounts_on_shared_devices", len({a for a, _ in n["devices"]}),
                             "ring accounts that send from a device another account also uses", sorted({d for _, d in n["devices"]})))
    span = f"{n['first_ts']:%d %b %H:%M}-{n['last_ts']:%H:%M}"
    pct = round(to_exits / n["total_in"] * 100) if n["total_in"] else 0
    lead = n["alerted"][0]
    return dict(network_id=network_id, score=n["score"], severity=n["severity"], confidence=conf, patterns=n["patterns"],
                claim=f"{network_id}: {inr(n['total_in'])} entered from {len(srcs)} source account(s) and {pct}% of it reached "
                      f"{len(exits)} exit account(s) between {span}. {len(alerts)} alert(s) belong to this one ring.",
                alerts=per_alert, computations=comps,
                transactions=[row(e, relation="source" if e["sender_account"] in srcs else "exit" if e["receiver_account"] in exits
                                  else "hop") for e in edges][:40],
                gaps=gaps(n["alerted"], edges, conf, "+".join(n["patterns"])),
                ai_accounts=ai_ring(n),
                next_questions=next_questions(lead, network_id, [a for a in n["alerted"] if a != lead]),
                links=dict(dashboard=f"/?ring={network_id}", trail=f"/network/{network_id}/graph"))


@app.get("/compare", operation_id="compareAccounts",
         summary="Why accounts are connected: direct transfers, shared devices, same ring, common counterparties")
def compare(accounts: str = Query(description="2 to 10 comma-separated account ids, e.g. AC0508,AC0511")):
    ids = list(dict.fromkeys(a.strip().upper() for a in accounts.split(",") if a.strip()))
    if not 2 <= len(ids) <= 10:
        raise HTTPException(422, "Give 2 to 10 comma-separated account ids")
    for a in ids:
        lookup(LIVE.accounts, a, "account")
    S = set(ids)
    direct = sorted((t for a in ids for t in LIVE.out[a] if t["receiver_account"] in S), key=mt.TS)
    used = {}
    for a in ids:
        for t in LIVE.out[a]:
            used.setdefault(t["device_id"], set()).add(a)
    shared = [dict(device=d, accounts=sorted(x)) for d, x in sorted(used.items()) if len(x) > 1]
    rings = [dict(network_id=n["network_id"], accounts=sorted(S & set(n["accounts"])))
             for n in LIVE.nets if len(S & set(n["accounts"])) > 1]
    seen = {}
    for a in ids:
        for x in {t["receiver_account"] for t in LIVE.out[a]} | {t["sender_account"] for t in LIVE.inc[a]}:
            if x not in S:
                seen.setdefault(x, set()).add(a)
    common = [dict(account=x, linked=sorted(v)) for x, v in sorted(seen.items()) if len(v) > 1][:10]
    kinds = sum(map(bool, (direct, shared, rings)))
    parts = [f"{len(direct)} direct transfer(s)" if direct else "", f"{len(shared)} shared device(s)" if shared else "",
             f"same ring {', '.join(r['network_id'] for r in rings)}" if rings else ""]
    return dict(accounts=ids, connected=kinds > 0,
                confidence="high" if kinds >= 2 else "medium" if kinds else "insufficient",
                summary=(f"{', '.join(ids)} are linked by " + "; ".join(p for p in parts if p) + ".") if kinds
                        else f"No direct transfers, shared devices or common ring between {', '.join(ids)} in this bank's data.",
                direct_transfers=[row(t) for t in direct[:20]], shared_devices=shared, same_ring=rings, common_counterparties=common)


# -- Policy: test rule changes on today's data before switching them on ----------------------------------------
@app.get("/policy", operation_id="getPolicy", summary="Detection policy in force")
def get_policy():
    return LIVE.policy


@app.post("/policy/replay", operation_id="replayPolicy",
          summary="Rerun detection on the current bank with a proposed policy and report what changes. Changes nothing.")
def replay_policy(p: Policy):
    accts = dict(LIVE.accounts)  # copy: the live tick may add walk-in accounts while this runs in a worker thread
    inc, out, devs, cur_nets = LIVE.inc, LIVE.out, LIVE.devs, LIVE.nets
    before = {a["account_id"] for a in LIVE.alerts}
    after = mt.detect(accts, inc, out, devs, **p.kwargs())
    nets = mt.networks(after, inc, out, devs)
    now = {a["account_id"] for a in after}
    return dict(policy=p, before=dict(alerts=len(before), rings=len(cur_nets)), after=dict(alerts=len(after), rings=len(nets)),
                removed=sorted(LIVE.alert_ids.get(a, a) for a in before - now), added=sorted(now - before),
                lost_rings=[n["network_id"] for n in cur_nets if not set(n["alerted"]) & now],
                new_rings=sum(not any(set(m["accounts"]) & set(c["accounts"]) for c in cur_nets) for m in nets))


@app.post("/policy/apply", summary="Switch the live engine to this policy (takes effect on the next tick)")
async def apply_policy(p: Policy):
    LIVE.requests.append(("policy", p))
    return {"applied": p}


# -- Benchmark, Power BI exports and the Copilot Studio connector spec -------------------------------------------
@app.get("/evaluation", operation_id="getEvaluation",
         summary="Benchmark on the public IBM AML dataset (labels we didn't create): precision, recall, lift")
def evaluation():
    f = DATA / "eval.json"
    if not f.exists():
        return {"status": "not run", "how": "python3 eval_ibm.py HI-Small_Trans.csv --patterns HI-Small_Patterns.txt --out data/eval.json"}
    return {"status": "ok", **json.loads(f.read_text())}


@app.get("/export/{table}.csv", response_class=PlainTextResponse, summary="Live tables as CSV for Power BI (Get data → Web)")
def export_csv(table: Literal["accounts", "transactions", "alerts", "networks"]):
    rows = dict(mt.tables(dict(LIVE.accounts), LIVE.txns[:], LIVE.alerts, LIVE.nets))[table]
    if table == "alerts":
        rows = [r | {"network_id": LIVE.net_of.get(r["alert_id"], "")} for r in rows]
    if table == "networks":
        rows = [r | {"status": LIVE.net_status.get(r["network_id"], "open")} for r in rows]
    buf = StringIO()
    mt.write_csv(buf, rows)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv")


COPILOT_TOOLS = {"explainAlert", "explainRing", "traceAlertMoney", "traceRingMoney", "compareAccounts", "draftAlertStr",
                 "draftRingStr", "getAccount", "listAlerts", "listRings", "replayPolicy", "getPolicy", "getEvaluation", "dismantleRing",
                 "explainAccountRisk", "getModelCard", "listCases"}


@app.get("/copilot/openapi.json", include_in_schema=False)
def copilot_spec(request: Request):
    """OpenAPI 3.0 spec with only the investigator tools, for Copilot Studio (Add tool → REST API)."""
    spec = get_openapi(title="MuleTrace Investigator", version="1.0.0", openapi_version="3.0.3",
                       description="Evidence-grounded AML investigation tools. Every figure comes with the transaction ids it rests on.",
                       routes=[r for r in app.routes if getattr(r, "operation_id", None) in COPILOT_TOOLS])
    spec["servers"] = [{"url": os.environ.get("PUBLIC_URL") or str(request.base_url).rstrip("/")}]
    return spec


# The same tools over MCP (streamable HTTP, stateless JSON responses), for Copilot Studio's Add tool → MCP.
# Each call is forwarded in-process to the REST route, so both paths return identical answers.
MCP_TOOLS = {}


def mcp_tools():
    if not MCP_TOOLS:
        spec = get_openapi(title="MuleTrace", version="1.0.0", routes=[r for r in app.routes if getattr(r, "operation_id", None) in COPILOT_TOOLS])
        schemas = spec.get("components", {}).get("schemas", {})
        for path, ops in spec["paths"].items():
            for method, op in ops.items():
                props, req = {}, []
                for p in op.get("parameters", []):
                    props[p["name"]] = {k: v for k, v in p["schema"].items() if k != "title"} | ({"description": p["description"]} if p.get("description") else {})
                    req += [p["name"]] if p.get("required") else []
                body = op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema")
                if body:
                    body = schemas[body["$ref"].split("/")[-1]] if "$ref" in body else body
                    props |= body.get("properties", {})
                    req += body.get("required", [])
                MCP_TOOLS[op["operationId"]] = dict(method=method.upper(), path=path, params=op.get("parameters", []), body=bool(body), spec=dict(
                    name=op["operationId"], description=" ".join(filter(None, [op.get("summary"), op.get("description")])),
                    inputSchema=dict(type="object", properties=props, required=req),
                    annotations=dict(readOnlyHint=method == "get", destructiveHint=op["operationId"] == "dismantleRing")))
    return MCP_TOOLS


async def asgi_call(method, path, query, body):
    raw, out, sent = json.dumps(body).encode() if body is not None else b"", dict(status=500, body=b""), False
    scope = dict(type="http", asgi={"version": "3.0"}, http_version="1.1", method=method, scheme="http", path=path,
                 raw_path=path.encode(), root_path="", query_string=urlencode(query).encode(), client=("127.0.0.1", 0),
                 server=("mcp.local", 80), headers=[(b"host", b"mcp.local"), (b"content-type", b"application/json")])

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": raw, "more_body": False}

    async def send(m):
        if m["type"] == "http.response.start":
            out["status"] = m["status"]
        elif m["type"] == "http.response.body":
            out["body"] += m.get("body", b"")
    await app(scope, receive, send)
    return out["status"], out["body"].decode()


@app.post("/mcp", include_in_schema=False)
async def mcp(request: Request):
    msg = await request.json()
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if mid is None:
        return Response(status_code=202)  # notification, e.g. notifications/initialized
    if method == "initialize":
        result = dict(protocolVersion=params.get("protocolVersion", "2025-03-26"), capabilities={"tools": {}},
                      serverInfo={"name": "MuleTrace Investigator", "version": "1.0.0"})
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [t["spec"] for t in mcp_tools().values()]}
    elif method == "tools/call" and params.get("name") in mcp_tools():
        t, args = mcp_tools()[params["name"]], params.get("arguments") or {}
        path, query, names = t["path"], {}, {p["name"] for p in t["params"]}
        for p in t["params"]:
            if args.get(p["name"]) is not None:
                if p["in"] == "path":
                    path = path.replace("{%s}" % p["name"], quote(str(args[p["name"]]), safe=""))
                else:
                    query[p["name"]] = args[p["name"]]
        status, text = await asgi_call(t["method"], path, query, {k: v for k, v in args.items() if k not in names} if t["body"] else None)
        result = {"content": [{"type": "text", "text": text}], "isError": status >= 400}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Unknown method or tool: {method} {params.get('name', '')}".strip()}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


# -- Explainable classifier (xai.py), served locally or from a Microsoft Foundry managed online endpoint ----------
# Same contract both ways: feature rows in, {score, reasons[], contributions[]} out. Foundry wins when configured;
# if it fails, scoring falls back to the local copy of the same model and says so.
MODEL, CARD = xai.load()


def ai_rows(ids):
    return [xai.features(LIVE.accounts[a], LIVE.inc[a], LIVE.out[a], LIVE.devs, LIVE.clock) for a in ids]


def foundry(rows):
    body = json.dumps({"rows": [[None if v != v else v for v in r] for r in rows]}).encode()  # NaN → null
    req = urllib.request.Request(os.environ["FOUNDRY_SCORING_URL"], body, {
        "Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get('FOUNDRY_KEY', '')}"})
    with urllib.request.urlopen(req, timeout=8) as r:
        out = json.loads(r.read())
    return json.loads(out) if isinstance(out, str) else out


def ai_explain(ids):
    rows, note = ai_rows(ids), None
    if os.environ.get("FOUNDRY_SCORING_URL"):
        try:
            return foundry(rows), "Microsoft Foundry endpoint", None
        except Exception as e:
            note = f"Foundry endpoint unavailable ({type(e).__name__}); scored with the local copy of the model"
    if MODEL is None:
        raise HTTPException(503, "Classifier not trained yet: run `python3 xai.py train`")
    return xai.explain(MODEL, rows), "local model", note


def ai_safe(ids):
    try:
        (res,), by, note = ai_explain(ids)
        return res | {"scored_by": by, "note": note, "model_version": CARD.get("version", 1)}
    except HTTPException:
        return None


def ai_ring(n):
    try:
        res, by, _ = ai_explain(n["accounts"])
    except HTTPException:
        return None
    rows = [dict(account_id=a, score=r["score"], alerted=a in n["alerted"], source=a in n["sources"],
                 top=r["reasons"][0]["text"] if r["reasons"] else "") for a, r in zip(n["accounts"], res)]
    return dict(scored_by=by, accounts=sorted(rows, key=lambda r: -r["score"]),
                ai_only=[r["account_id"] for r in rows if r["score"] >= 0.5 and not r["alerted"]])


@app.get("/account/{account_id}/ai", operation_id="explainAccountRisk",
         summary="Explainable AI: mule-risk probability from the classifier and the behaviours that pushed it up or down")
def account_ai(account_id: str):
    lookup(LIVE.accounts, account_id, "account")
    (res,), by, note = ai_explain([account_id])
    return dict(account_id=account_id, **res, scored_by=by, note=note, model_version=CARD.get("version", 1),
                model=dict(name=CARD.get("model"), explanation=CARD.get("explanation"), holdout=CARD.get("holdout")))


@app.get("/ai/model", operation_id="getModelCard", summary="Model card: what the classifier is, what it was trained on, and how it scored on held-out data")
def model_card():
    return (CARD or {"status": "not trained"}) | {"serving": "Microsoft Foundry endpoint" if os.environ.get("FOUNDRY_SCORING_URL") else "local model"}


@app.post("/ai/retrain", summary="Retrain the classifier with the analysts' labels (a new local model version; redeploy to Foundry to serve it there)")
async def retrain():
    global MODEL, CARD
    if not LIVE.labels:
        raise HTTPException(409, "No analyst labels yet: confirm or reject an account, or dismantle a ring")
    ids = list(LIVE.labels)
    rows, y = ai_rows(ids), [int(LIVE.labels[a]) for a in ids]
    MODEL, CARD = await asyncio.to_thread(xai.train, extra=(rows, y), version=CARD.get("version", 1) + 1, save=False)
    LIVE.version += 1
    return {"version": CARD["version"], "analyst_labels": len(ids), "holdout": CARD["holdout"],
            "note": "Serving locally. Run foundry/deploy.py to serve this version from Microsoft Foundry." if os.environ.get("FOUNDRY_SCORING_URL") else None}
