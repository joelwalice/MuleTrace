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
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

import muletrace as mt
from muletrace import inr

TICK = 0.25          # real seconds per tick
FEED_RATE = 2.0      # ordinary transactions per real second
SPEEDS = (1, 10, 30, 60)
RING_LABEL = {"structuring": "Structuring", "chain": "Pass-Through Chain", "fan": "Fan-In / Fan-Out"}


class Live:
    def __init__(self):
        self.requests = deque()  # injections and transfers from the API, applied inside the tick (never mid-detection)
        self.reset()

    def reset(self):
        now = datetime.now().replace(microsecond=0)
        self.bank = mt.Bank(seed=random.randrange(1 << 30), now=now)
        self.txns = mt.history(self.bank, rings=False)  # 30 days of ordinary customers; rings only arrive live
        self.seq, self.clock, self.running, self.speed, self.version = len(self.txns), now, True, 30, 0
        self.queue, self.attacks, self.autopilot, self.next_auto = [], [], False, 0.0
        self.frozen, self.cases, self.net_status, self.alert_ids, self.net_ids = set(), [], {}, {}, {}
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
        alerts = mt.detect(self.accounts, inc, out, devs)
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
        return {**a, "network_id": self.net_of[a["alert_id"]], "status": "frozen" if a["account_id"] in self.frozen else "new"}

    def net_view(self, n):
        return {k: v for k, v in n.items() if k not in ("edges", "devices")} | {"status": self.net_status.get(n["network_id"], "open")}

    def snapshot(self):
        hours = [0] * 48  # txn count per bank-clock hour, last 48h
        for t in self.txns[-6000:]:
            h = int((self.clock - t["ts"]).total_seconds() // 3600)
            if 0 <= h < 48:
                hours[47 - h] += 1
        alerted = {a["account_id"] for a in self.alerts}
        return dict(version=self.version, clock=self.clock, running=self.running, speed=self.speed, speeds=SPEEDS,
                    feed_rate=FEED_RATE, queued=len(self.queue), autopilot=self.autopilot,
                    attacks=[{k: v for k, v in a.items() if k != "accounts"} for a in self.attacks[-6:]][::-1],
                    stats=dict(transactions=len(self.txns), alerts=len(self.alerts), networks=len(self.nets),
                               total_in=round(sum(n["total_in"] for n in self.nets), 2), frozen=len(self.frozen),
                               cases=len(self.cases)),
                    hourly=hours, alerts=[self.alert_view(a) for a in self.alerts],
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


mt.export(Path(__file__).parent / "data", mt.ACCOUNTS, mt.TXNS, mt.ALERTS, mt.NETWORKS)
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
                yield f"data: {json.dumps(LIVE.snapshot(), default=iso)}\n\n"
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


@app.get("/alerts", summary="Alert queue, highest score first")
def alerts():
    return [LIVE.alert_view(a) for a in LIVE.alerts]


@app.get("/networks", summary="Alerts grouped into mule rings")
def networks():
    return [LIVE.net_view(n) for n in LIVE.nets]


@app.get("/account/{account_id}", summary="Account 360 / receiver-mule profile")
def account(account_id: str):
    lookup(LIVE.accounts, account_id, "account")
    return {**mt.profile(account_id, LIVE.accounts, LIVE.inc, LIVE.out), "risk": LIVE.risk(account_id),
            "frozen": account_id in LIVE.frozen,
            "alerts": [LIVE.alert_view(a) for a in LIVE.alerts if a["account_id"] == account_id]}


@app.get("/alert/{alert_id}/graph", summary="Money-trail graph for one alert")
def alert_graph(alert_id: str):
    a = lookup(LIVE.alert_by, alert_id, "alert")
    edges, up, down, lateral = mt.trace(a["account_id"], a["ts"], LIVE.inc, LIVE.out, LIVE.devs)
    role = lambda i: "subject" if i == a["account_id"] else "upstream" if i in up else "downstream" if i in down else "lateral"
    return graph(edges, mt.device_links({a["account_id"]} | lateral, LIVE.out, LIVE.devs), role)


@app.get("/alert/{alert_id}", summary="Alert detail with plain-English explanation and STR draft (Copilot grounding)")
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
    return {**a, "explanation": explanation, "str_draft": str_draft,
            "upstream": sorted(up), "downstream": sorted(down), "lateral": sorted(lateral),
            "account": {k: v for k, v in p.items() if k != "txns"}}


@app.get("/network/{network_id}/graph", summary="Money-trail graph for a whole mule ring")
def network_graph(network_id: str):
    n = lookup(LIVE.net_by, network_id, "network")
    role = lambda i: "subject" if i in n["alerted"] else "source" if i in n["sources"] else "member"
    return graph(n["edges"], n["devices"], role)


@app.get("/network/{network_id}", summary="Mule ring summary and network STR draft (Copilot grounding)")
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
                 f"Grounds for suspicion: Rapid pass-through, sub-threshold deposits and shared devices across accounts "
                 f"with no apparent economic purpose indicate layering of proceeds of crime.\n"
                 f"Action: freeze mule and exit accounts, review sources, file STR within 7 working days, notify LEA if fraud victims identified.")
    return LIVE.net_view(n) | {"explanation": explanation, "str_draft": str_draft, "mules": mules}


@app.post("/network/{network_id}/dismantle", summary="Freeze mule + exit accounts (simulated), open case, trigger Power Automate")
def dismantle(network_id: str):
    n = lookup(LIVE.net_by, network_id, "network")
    detail = network(network_id)
    LIVE.frozen.update(n["freeze"])
    LIVE.net_status[network_id] = "dismantled"
    case = dict(case_id=f"CASE-{len(LIVE.cases) + 1:03d}", network_id=network_id, alert_ids=n["alert_ids"],
                frozen=n["freeze"], review=n["sources"], summary=detail["explanation"], str_draft=detail["str_draft"],
                status="open")
    LIVE.cases.append(case)
    LIVE.version += 1
    return {**case, "webhook": notify({**case, "score": n["score"], "total_in": n["total_in"]})}


@app.get("/cases", summary="Open cases")
def cases():
    return LIVE.cases
