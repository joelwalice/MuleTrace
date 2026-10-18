# MuleTrace: Investigation Copilot Plan

Status: **P0–P2 built.** CSV upload was cut, because `/ingest` already covers incoming data. The IBM run is done (`context.md` item 16). The Copilot Studio agent and the Power Automate playbook are live (`context.md` item 17). The connector below became an MCP tool on `/mcp`, because the current Copilot Studio has no REST API tool, and the lab playbook emails the STR because the lab user has no Teams. The Foundry endpoint is still optional. **What's left is in [`TODO.md`](TODO.md).**

See `microsoft/README.md`.
Sources: the two DeepSeek threads (the "which idea wins" verdict and the "go" build pack), checked against this repo.

## 1. Verdict: can the codebase take this idea?

**Yes. About 70% of it already exists.** The DeepSeek pick is direction #1, an evidence-grounded investigation copilot, with a light policy tab (#3) and one evaluation card (#4). That is an interface layer on top of what MuleTrace already has.

| DeepSeek asks for | Already here | Gap |
|---|---|---|
| Alert queue → Account 360 → graph | Rings, alerts, Account 360, time-ordered graph, live feed | none |
| Copilot grounding endpoints | `GET /alert/{id}`, `GET /network/{id}` (explanation + STR draft), `/openapi.json` | No structured **evidence bundle** (transaction IDs, computations, confidence, gaps) |
| Evidence panel beside answers | Reasons as text, ledger, graph | **New panel** with clickable citations |
| Draft SAR | STR draft for FIU-IND (alert and ring) | **Completeness checklist** (supported vs missing) |
| Money-flow trace / "why connected?" | `mt.trace`, `device_links`, ring union-find | `GET /compare?accounts=` |
| Policy toggles + replay | `detect()` already takes `band`, `min_pass`, `min_dormant` | **Rule toggles, the 80% ratio, fan size and dormant days as parameters**, plus `POST /policy/replay` and a Policy tab |
| Evaluation card | `eval_ibm.py` prints precision / recall / lift | **Write results to `data/eval.json`**, plus `GET /evaluation` and a card |
| Upload CSV | `POST /ingest` (JSON, bank clock) | `POST /upload` CSV that keeps the original timestamps (P2) |
| Power Automate playbook | Dismantle → webhook → Teams / Planner / Outlook | none |
| API key for the connector | none | Optional `API_KEY` env var (header `X-API-Key`) |

## 2. Where we deliberately differ from the DeepSeek pack

These are corrections. Following the pack literally would be wrong for Indian banks.

1. **STR, not SAR.** India files an STR (Suspicious Transaction Report) with FIU-IND. Keep every label and route as STR.
2. **No invented numbers.** The pack hard-codes "precision 0.72, recall 0.61, 3 of 5 rings". Those were never measured. The card shows only what `eval_ibm.py` writes, and reads "not run yet" until then.
3. **Our thresholds, our currency.** The pack's "₹9,500 just under 10K" is the US rule. Ours is ₹45,000–49,999 under the ₹50,000 PAN threshold. The USD band stays only in `eval_ibm.py`.
4. **"Time-ordered", not "causal".** Already a design rule in `context.md`.
5. **Real ID formats.** Citations use our IDs, `[TX0001234]` and `[AC0508]`, not `TXN-`/`ACC-`.
6. **No hard-coded API key in code.** The key comes from an env var, like `PLAYBOOK_WEBHOOK`. When unset (local use), the API stays open.
7. **Live bank first.** The pack starts with "upload CSV → run detection". Ours is already live, so upload becomes an optional "bring your own data" path.
8. **Honest gaps.** "Gaps" lists only what our data truly lacks: no KYC refresh dates, no beneficial ownership, no device data on ingested or uploaded rows. We don't make up "no KYC refresh in 14 months".
9. **Unverified claims.** "MuleHunter in 26 banks" and "analysts spend 4–6 hours per case" need a source before they're used. Otherwise say "MuleHunter.AI is live in Indian banks" and drop the hours figure.

## 3. What to build

### P0: Evidence bundle (backend, the core of the idea)
`GET /alert/{id}/evidence`, also `GET /network/{id}/evidence`, returning:
```json
{
  "alert_id": "AL-102", "network_id": "NET-1", "pattern": "passthrough+dormant", "score": 0.91,
  "claim": "AC0508 forwarded 96% of ₹4,80,000 within 9 minutes, after 800 days dormant.",
  "confidence": "high | medium | low | insufficient",
  "reasons": ["…existing reason strings…"],
  "transactions": [{"id": "TX0010231", "ts": "…", "sender": "AC0412", "receiver": "AC0508", "amount": 480000,
                    "channel": "neft", "relation": "trigger | supports", "why": "inflow ≥ ₹50k"}],
  "computations": [{"name": "passthrough_ratio", "value": 0.96, "formula": "sent within 30 min / received",
                    "inputs": ["TX0010231", "TX0010236"]}],
  "gaps": ["No beneficial-ownership data in this dataset"],
  "next_questions": ["Trace the money for AC0508", "Why are AC0508 and AC0511 connected?", "Draft the STR"],
  "links": {"graph": "/?alert=AL-102", "api_graph": "/alert/AL-102/graph"}
}
```
- **Build it inside `detect()`:** each hit already knows its trigger transaction. Have it also return the supporting window's transaction IDs and the numbers it computed. That's one place, so the rule and its evidence can never disagree.
- **Confidence:** `high` with 2+ independent patterns or score ≥ 0.85, `medium` ≥ 0.70, `low` below that. `insufficient` when the only signal is shared-device or the trail has fewer than 2 transfers above `min_amt`. Pure function, covered by the self-check.
- **Self-check:** for each canonical ring, every cited transaction ID exists, and each ratio recomputes from its `inputs`.

### P0: Evidence panel (frontend)
- **Placement:** a new **Evidence** tab beside Feed / Profile / Signals in the right column, so the graph stays on screen.
- **Content:** the claim and confidence first, then computations (value, formula), transactions (cited rows), gaps, and the next questions as buttons.
- **Interaction:** hover or click a transaction row and its edge lights in the graph, reusing the hover-path highlight in `graph.tsx`. Each `[TX…]` / `[AC…]` in text is a link that sets `acct` / `alert` in the URL, reusing `AccountLink`/`SelLink`.
- **Style:** current industrial theme, `.tl` labels, ≥ 4.5:1 contrast. Show confidence as a word plus a glyph, never colour alone.

### P0: Copilot Studio agent (Person D, mostly no code)
1. **Connector:** a custom connector from `/openapi.json`. This needs a public URL: Azure App Service, or a dev tunnel.
2. **Actions:** `GET /alert/{id}/evidence`, `GET /network/{id}/evidence`, `GET /alert/{id}/graph`, `GET /compare`, `GET /network/{id}` (STR draft), `POST /network/{id}/dismantle`.
3. **Instructions:** the pack's hard rules, with our fixes:
   - Never calculate. Quote tool output only, and cite `[TX…]` / `[AC…]`.
   - When `confidence` is `insufficient`, say so and list the gaps.
   - Any freeze or filing step needs analyst approval. Ask "Confirm dismantle NET-x?" before calling dismantle.
   - Out-of-scope questions get "Out of scope for MuleTrace."
   - Turn general knowledge off.
4. **Topics:**
   - Explain Alert
   - Trace Money
   - Why Connected
   - Draft STR (with checklist)
   - Insufficient Evidence (fallback)
5. **Dashboard embed:** `NEXT_PUBLIC_COPILOT_URL` (Copilot Studio web-chat URL) shows an **Ask Copilot** drawer as an iframe.
   - **If it's unset or the network blocks it,** the drawer falls back to the next-question buttons. They call the same evidence endpoints and print the deterministic answer, so nothing depends on Copilot Studio being up.

### P1: STR completeness checklist
Add `checklist` to `GET /alert/{id}` and `GET /network/{id}`:
- **Supported** items name the evidence they rest on: subject KYC, the trail, the patterns, the time window.
- **Missing** items say what's needed: beneficial owner, source of funds, LEA reference, analyst sign-off.
- **The draft stays labelled DRAFT** until the analyst approves.

### P1: Policy tab + replay
- **Engine:** `detect()` gains `rules=set(...)`, `ratio=0.8`, `fan=5` and `dormant_days=90`. Defaults stay the same, so the self-check still says 3 rings.
- **`GET /policy`:** returns the current values.
- **`POST /policy/replay`:** reruns detection on the **current live bank** with the proposed values. It returns alerts / rings / accounts before and after, plus the alert IDs added and removed. No state changes.
- **`POST /policy/apply`:** makes the proposed values live. API-key gated when `API_KEY` is set.
- **UI:**
  - A **Policy** panel, a drawer from the header: 5 rule switches, sliders for the structuring band floor, pass-through % and min amount, fan size, and dormant days.
  - **Replay** shows "14 alerts → 9 · 3 rings → 2 · lost: NET-3".
  - **Apply** has a two-step confirm, like New Bank.

### P2: Evaluation card
- **`eval_ibm.py --out data/eval.json`:** writes the score dict with the dataset name, row limit and run date.
- **Optional ring-level recall:** IBM ships `HI-Small_Patterns.txt`, a list of laundering attempts. Score "attempts with ≥ 1 flagged account". This is the honest version of "rings detected X of Y".
- **`GET /evaluation`:** returns the file, or `{"status": "not run"}`.
- **Card:** in the Summary strip, showing precision, recall, lift, base rate, and "IBM AML HI-Small, n rows, USD only, no device data". Until the run lands it reads "Benchmark not run yet". **Blocked on a Kaggle login.**

### P2: Bring your own data
- **`POST /upload`:** takes CSV (`txn_id?, ts, sender, receiver, amount, channel, device_id?`), max 50k rows / 10 MB. Rows are validated exactly like `/ingest`, and bad rows are counted and returned (`imported`, `rejected`, first 5 errors).
- **Effect:** it replaces the bank with the uploaded data, keeps the original timestamps, pauses the live feed, and sets the clock to the last row. **New Bank** returns to live mode.
- **UI:** an "Upload CSV" button in the New Bank menu, with a result toast.
- **Cut first** if time is short. `/ingest` already proves data can come in.

### P2: Compare
`GET /compare?accounts=AC1,AC2`, at most 10 accounts. It returns:
- direct transfers between them
- shared devices
- a shared ring
- the shortest money path within the trace window

## 4. Skills and tools to use

- **UI** (all in `~/.agents/skills`):
  - `industrial-brutalist-ui` (the current theme) for the Evidence tab and Policy drawer
  - `design-taste-frontend` / `redesign-existing-projects` against the generic AI look
  - `web-design-guidelines` audit before freeze
  - `minimalist-ui` for the `/send`-style phone views
  - `full-output-enforcement` so components ship complete, with no placeholder stubs
- **Discovery:** run `find-skills` for a Copilot Studio / Power Platform skill before Person D starts.
- **Verification:**
  - Playwright screenshots at 390 / 1280 / 1920
  - `python3 muletrace.py`, `node web/flow.check.mjs`, `npm run build`
  - temp servers started and killed in one command
- **Memory:**
  - this file and `context.md` (change log item 10 when it lands)
  - the project memory, which points here

## 5. Open questions for the team

1. **Public URL for Copilot Studio:** Azure App Service (needs the subscription), or a dev tunnel on a laptop?
2. **Kaggle login** for the IBM run. Who has it?
3. **Embed or not:** does the network allow the Copilot Studio web chat? If not, the fallback buttons answer the same questions.
4. **Upload:** keep it in scope (P2), or cut now and save ~3h?
