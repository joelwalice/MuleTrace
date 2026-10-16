# MuleTrace

AML SOC console that groups scattered alerts into mule rings, traces the money hop by hop in time order, and drafts the STR for FIU-IND.

> **Alerts collapse into rings.** Launch the three attacks and about 14 alerts become 3 rings. That alert reduction is the pitch in one number.

For the full change log, design rules and open items, see [`context.md`](context.md).

## Run it

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --reload        # API on :8000, docs at /docs
cd web && npm install && npm run dev      # dashboard on http://localhost:3000
```

Open http://localhost:3000. The bank is live straight away. Launch an attack from the **Red Team** console (keys 1–3), and open http://localhost:3000/send on a phone so judges can send their own transfers.

| Setting | Where | Default | What it does |
|---|---|---|---|
| `PLAYBOOK_WEBHOOK` | API | unset | Power Automate trigger URL. It contains a key, so never commit it. |
| `CORS_ORIGINS` | API | `http://localhost:3000` | Origins allowed to call the API |
| `NEXT_PUBLIC_API` | web, build time | `http://localhost:8000` | Where the dashboard finds the API |

- **Live feed:** the API starts a synthetic bank with 30 days of ordinary customer history. A **bank clock** then keeps running (30× real time by default; 1× is true real time) while ordinary transactions stream in at about 2 per second, with no end. Detection reruns on every tick.
- **Mule attacks:** each attack creates fresh accounts and plays out on the bank clock over the next 1–3 real minutes:
  - **Structuring:** 6 depositors, cash just under ₹50,000.
  - **Pass-Through Chain:** a dormant account wakes up, then 3 fast hops.
  - **Fan-In / Fan-Out:** 8 in → hub → 8 mules on one device → ATM.

  Launch one from the Red Team console, with keys 1–3, or with `POST /inject/{structuring|chain|fan}`. **Autopilot** launches a random attack every 1–2 minutes for an unattended booth.
- **Audience transfers:** `/send` is a phone page where anyone can send money into the live bank, or tap a "Try to Fool It" pattern. They see the moment their own transfers get caught. Scripts and Power Automate can push data through `POST /ingest` too (below).
- **Shared screens:** the dashboard subscribes to `GET /stream` (server-sent events). State lives on the server, so a laptop, the projector and every phone see the same bank.
- **New Bank** (two-step confirm) starts a fresh bank and clears rings, cases and signals. Each API start also writes the canonical 3-ring demo dataset to `data/*.csv` for Power BI.

## Using the dashboard

| Area | What it shows |
|---|---|
| **Red Team** | Launch attacks, toggle Autopilot, and watch each attack's transfers release |
| Ticker + **Signals** tab | A log of every ring found, alert linked and case opened, stamped with the bank clock time |
| Summary | Alerts → rings, transactions screened (hourly "barcode" chart), money into rings, accounts locked |
| Mule rings | One block per ring with its alerts nested underneath. The selected ring shows inverted. |
| Money trail | The graph, or the same data as tables (**Table**) |
| Case panel | Plain-English explanation, sources / mules / exits, **Draft STR**, **Dismantle Ring** |
| Ledger · Account 360 | Live transactions; the selected account's profile, pass-through % and why it's flagged |

**Reading the money trail:**
- **Columns are hops,** in time order. Sources are on the left, exits on the right, and each column header shows when money first arrived there.
- **+9m on a transfer** is how long the money sat before moving on. Short waits are the mule signature.
- **Squares are accounts.** Size shows money through the account, fill shows risk band, a red ring means alerted, a dashed border means source. **Diamonds** are shared devices.
- **Hover an account** to light its whole path upstream and downstream.
- **Trace Flow** replays the transfers one by one.
- **Controls:** + / − / Fit zoom the graph, and ⤢ opens it full screen.

**Keyboard:** `Space` pause/resume the feed · `1` `2` `3` launch an attack · `J` / `K` next/previous ring · `T` graph/table · `Esc` closes the STR.

**Links:** every view has its own URL, e.g. `/?ring=NET-2&acct=AC0510&panel=profile&view=table`. You can share or bookmark it, or Cmd/Ctrl+click any ring, alert or account to open it in a new tab.

**Dismantle:** **Dismantle Ring → Lock N Accounts** locks the mules and exits (simulated) and sends source accounts to review, because they may be fraud victims. It also opens a case and calls Power Automate.

## Demo flow (5 min)

1. **Problem:** analysts drown in alerts, and mule rings hide across many accounts.
2. **The bank is live.** Point at the ledger streaming and the bank clock running.
3. Press **2** to launch a Pass-Through Chain. The ticker logs it, the queued count drops as transfers release, and the ring assembles in the graph hop by hop.
4. Press **Trace Flow** to show the +9m / +20m waits, then tap an account for Account 360.
5. Hand a judge your phone at **/send**. They tap **Structuring**, and their own account appears as a ring on the big screen. Their phone says **Caught**.
6. Launch **1** and **3**. The headline settles at about **14 alerts → 3 rings**.
7. **Copilot:** "Explain this ring and draft the STR."
8. **Dismantle Ring → Lock N Accounts.** Sources go to review, and Teams and Planner fire.
9. **Credibility:** IBM AML results (below).

## Claims you can defend

| Say | Not |
|---|---|
| "14 alerts become 3 cases" | "80% faster" (no measurement behind it) |
| "Time-ordered money trail: money can only move forward in time" | "Causal inference" |
| "STR draft in one click" | "Replaces the analyst" |
| IBM AML precision / recall / lift from `eval_ibm.py` | Accuracy on our own synthetic data (we planted those rings) |

## Judge Q&A

- **"You planted the rings."** Yes, for the demo. On IBM's public AML dataset, which we didn't create, the same rules score: _fill in from eval_ibm.py_.
- **"How is this different from RBI's MuleHunter.AI?"** MuleHunter flags individual mule accounts. MuleTrace starts after the flag: it groups the ring, traces the money, separates possible victims (sources) from mules, and produces the STR and freeze actions.
- **"Why review sources instead of freezing them?"** The first account money comes from may be a fraud victim, and freezing a victim's account harms them twice.
- **Indian thresholds:** structuring means repeated cash deposits just under ₹50,000, the PAN quoting threshold (Rule 114B). The STR is due to FIU-IND within 7 working days of forming suspicion (PML Rules). _Verify both against the official text before they go on a slide._

## Evaluation on public data

```
kaggle datasets download ealtman2019/ibm-transactions-for-anti-money-laundering-aml -f HI-Small_Trans.csv
python3 eval_ibm.py HI-Small_Trans.csv --limit 1000000
```

The script uses USD rows only, with USD thresholds (the US $10,000 reporting rule). The dataset has no device data, so shared-device detection is off. It reports precision, recall and **lift** (precision divided by the base rate of laundering accounts).

## Sending data in

```
curl -X POST localhost:8000/ingest -H 'content-type: application/json' \
  -d '[{"sender":"JUDGE-07","receiver":"JUDGE-07-POT","amount":49500,"channel":"cash"}]'
```

- **Fields:** `sender` and `receiver` take 3–24 letters, digits or dashes (new IDs open as walk-in accounts). `amount` is in rupees, above ₹0 and up to ₹1 crore. `channel` is one of upi, imps, neft, rtgs, cash, card or atm. Each request takes up to 500 transfers.
- **Clock:** transfers are stamped with the **bank clock**, not the client's time. When the feed is paused they queue until it resumes.
- **Other controls:** `POST /live/{play|pause|reset}?speed=1|10|30|60`, `POST /inject/{kind}`, `POST /autopilot?on=true|false`.

## Microsoft wiring

- **Copilot Studio:** build a custom connector from `/openapi.json`. Use the actions `GET /network/{id}` and `GET /alert/{id}`; both return `explanation` and `str_draft` for the agent.
- **Power BI:** load `data/*.csv`. `networks.csv` has one row per ring.
- **Azure:**
  - API on App Service: startup command `uvicorn app:app --host 0.0.0.0`, and set `CORS_ORIGINS` to the web URL.
  - `web/` on Static Web Apps or App Service: `npm run build && npm start`, with `NEXT_PUBLIC_API` set at build time.
  - Run the API as a **single worker**, because the live bank lives in memory.
- **Power Automate** (premium HTTP trigger):
  1. Create an instant cloud flow with the trigger **When an HTTP request is received**, and set **Who can trigger the flow** to **Anyone**.
  2. Paste this request schema:
     ```json
     {
       "type": "object",
       "properties": {
         "case_id": { "type": "string" }, "network_id": { "type": "string" },
         "alert_ids": { "type": "array", "items": { "type": "string" } },
         "frozen": { "type": "array", "items": { "type": "string" } },
         "review": { "type": "array", "items": { "type": "string" } },
         "summary": { "type": "string" }, "str_draft": { "type": "string" },
         "status": { "type": "string" }, "score": { "type": "number" }, "total_in": { "type": "number" }
       },
       "required": ["case_id", "network_id", "frozen", "review", "summary"]
     }
     ```
  3. Add the actions. Use the Expression tab for anything in `@{…}`.
     - **Teams** post:
       ```
       @{triggerBody()?['case_id']}: ring @{triggerBody()?['network_id']} dismantled
       @{triggerBody()?['summary']}
       Frozen: @{join(triggerBody()?['frozen'], ', ')}
       Review first: @{join(triggerBody()?['review'], ', ')}
       ```
     - **Planner** task due `@{addDays(utcNow(), 7)}`.
     - **Outlook** email with body `@{triggerBody()?['str_draft']}`.
  4. Save, copy the trigger URL, and restart the API. Keep the single quotes, because the URL contains `&`:
     ```
     PLAYBOOK_WEBHOOK='https://…' .venv/bin/uvicorn app:app --reload
     ```
  5. The dismantle message in the Signals log tells you whether the call was sent, isn't configured, or failed. A 401 or 403 usually means the trigger isn't set to Anyone. Each ring can only be dismantled once; launch another attack to test again.

## Checks

```
python3 muletrace.py          # engine: demo history → exactly 3 rings, none on normal accounts; every attack kind plans cleanly
cd web && node flow.check.mjs # graph layout: hop columns, ordering, device lane, wait times
cd web && npm run build       # type-check + production build
```

## Troubleshooting

- **Styles don't update in dev:** run `cd web && rm -rf .next && npm run dev`.
- **"No signal from the API":** start the API, and check that `NEXT_PUBLIC_API` and `CORS_ORIGINS` match your ports.
- **Copy the STR:** the STR dialog has **Copy** and **Save .txt**.
