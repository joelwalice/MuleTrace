# MuleTrace

AML investigation console that groups scattered alerts into mule rings, traces the money hop by hop in time order, shows the evidence behind every alert, and drafts the STR for FIU-IND. An **explainable AI classifier** (LightGBM with exact SHAP reasons, deployable to Microsoft Foundry) scores how mule-like each account is and shows why. A Copilot Studio agent investigates through the same API: it quotes the rules engine and cites transaction IDs, and it never calculates for itself.

> **Alerts collapse into rings.** Launch the three attacks and about 14 alerts become 3 rings. That alert reduction is the pitch in one number.

For the full change log, design rules and open items, see [`context.md`](context.md). The plan is in [`plan.md`](plan.md), and the Microsoft setup is in [`microsoft/README.md`](microsoft/README.md).

## Run it

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --reload        # API on :8000, docs at /docs
cd web && npm install && npm run dev      # dashboard on http://localhost:3000
```

Open http://localhost:3000. The bank is live straight away. Plant a mule ring from **Step 1** (keys 1–3). For judges' phones, see **Judge phones** below: a phone can't reach `localhost`.

**Windows (PowerShell):**
```
python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:PYTHONUTF8='1'; .\.venv\Scripts\python.exe -m uvicorn app:app --reload   # API on :8000
cd web; npm install; npm run dev                                               # dashboard on :3000
```
`PYTHONUTF8=1` keeps the ₹ sign from crashing Python's console output.

### Judge phones
```
powershell -ExecutionPolicy Bypass -File demo-lan.ps1      # add -Ip <address> to pick one, -SkipBuild to reuse the build
```
It finds the laptop's Wi-Fi address, bakes it into the dashboard (`NEXT_PUBLIC_API`), allows it in `CORS_ORIGINS`, builds, and serves both on all interfaces. Then phones open `http://<laptop-ip>:3000/send`, and **More → Judge Phone QR Code** shows that address.
- Phones must be on the same Wi-Fi. Venue Wi-Fi often isolates clients, so the laptop's own hotspot is the safer plan.
- On first run Windows asks to let Python and Node through the firewall: allow **Private** networks.
- It uses the production build on purpose. `npm run dev` blocks its own scripts for hosts other than localhost, so `/send` on a phone would load but never respond.

| Setting | Where | Default | What it does |
|---|---|---|---|
| `PLAYBOOK_WEBHOOK` | API | unset | Power Automate trigger URL. It contains a key, so never commit it. |
| `CORS_ORIGINS` | API | `http://localhost:3000` | Origins allowed to call the API |
| `NEXT_PUBLIC_API` | web, build time | `http://localhost:8000` | Where the dashboard finds the API |
| `FOUNDRY_SCORING_URL`, `FOUNDRY_KEY` | API | unset | Score through the Microsoft Foundry endpoint (see `foundry/README.md`). Unset: the local copy of the model |
| `PUBLIC_URL` | API | request host | Public HTTPS URL (Dev Tunnel / Azure), written into `/copilot/openapi.json` |
| `NEXT_PUBLIC_COPILOT_URL` | web, build time | unset | Copilot Studio web-chat URL. Shows **Ask Copilot** in the header |

- **Live feed:** the API starts a synthetic bank with 30 days of ordinary customer history. A **bank clock** then keeps running (30× real time by default; 1× is true real time) while ordinary transactions stream in at about 2 per second, with no end. Detection reruns on every tick.
- **Mule attacks:** each attack creates fresh accounts and plays out on the bank clock over the next 1–3 real minutes:
  - **Structuring:** 6 depositors, cash just under ₹50,000.
  - **Pass-Through Chain:** a dormant account wakes up, then 3 fast hops.
  - **Fan-In / Fan-Out:** 8 in → hub → 8 mules on one device → ATM.

  Launch one from Step 1, with keys 1–3, or with `POST /inject/{structuring|chain|fan}`. **Autopilot** (in **More**) launches a random attack every 1–2 minutes for an unattended booth.
- **Audience transfers:** `/send` is a phone page where anyone can send money into the live bank, or tap a "Try to Fool It" pattern. They see the moment their own transfers get caught. Scripts and Power Automate can push data through `POST /ingest` too (below).
- **Shared screens:** the dashboard subscribes to `GET /stream` (server-sent events). State lives on the server, so a laptop, the projector and every phone see the same bank.
- **New Bank** (in **More**, two-step confirm) starts a fresh bank and clears rings, cases and signals. Each API start also writes the canonical 3-ring demo dataset to `data/*.csv` for Power BI.

## Using the dashboard

| Area | What it shows |
|---|---|
| Summary pipeline | Transfers checked → alerts raised → mule rings → accounts locked, each with a one-line plain caption |
| **Step 1 · Plant a Mule Ring** | Launch attacks and watch each attack's transfers release; link to the judge phone page |
| **Step 2 · Pick a Ring** | One block per ring. Its alerts open underneath only when it's selected |
| **Step 3 · Follow the Money** | The graph, or the same data as tables (**Table**) |
| **Step 4 · Check the Evidence** | Opens on **Evidence** when you pick a ring; also Live Feed, Account and Log |
| Ticker + **Log** tab | A log of every ring found, alert linked and case opened, stamped with the bank clock time |
| **Cases** (header) | Every dismantled ring as a case: Open → STR Filed (simulated FIU-IND acknowledgement) → Closed, with a timestamped audit trail. **Teach the Classifier:** analyst verdicts plus dismantled rings retrain the AI into a new version |
| **More** (header) | Clock speed, Autopilot, **Judge Phone QR Code** (for the projector), New Bank, keyboard shortcuts |
| Mule rings | One block per ring with its alerts nested underneath. The selected ring shows inverted. |
| Money trail | The graph, or the same data as tables (**Table**) |
| Case panel | Plain-English explanation, sources / mules / exits, **Draft STR**, **Dismantle Ring** |
| **AI Classifier** (Evidence + Account) | Mule likelihood from the LightGBM model, with a bar for each behaviour that raised (red) or lowered (grey) it. Ring view: an AI score per account, plus the accounts the AI flags that no rule did |
| **Evidence** | Claim + confidence (or **Insufficient**), computed figures with formulas, cited transactions, gaps. Hover any figure or row to light exactly those transfers in the graph; click to pin. **Ask** answers trace / compare / STR questions inline |
| Ledger · Acct 360 | Live transactions; the selected account's profile, pass-through % and why it's flagged |
| **Rules** (header) | Switch rules and move thresholds, **Replay** on today's data (alerts and rings before → after, rings missed), then **Apply Live** |
| **Ask Copilot** (header) | The Copilot Studio agent, with one-tap prompts for the selected ring |
| Accuracy · IBM Data | Lift, precision and recall from `eval_ibm.py`. Hidden until the benchmark has run, so it never shows a placeholder |

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
7. **Evidence, then Copilot:**
   - Open **Evidence**: "Every number has its transactions." Hover → edges light.
   - **Ask Copilot:** "Why is AL-10x suspicious?" The answer cites `[TX…]`.
   - "Draft the STR": the checklist shows what's still missing.
   - **Policy:** turn off Structuring → Replay → "a ring would be missed" → Defaults.
8. **Dismantle Ring → Lock N Accounts.** Sources go to review, and Teams and Planner fire. Then **File STR** (acknowledgement number) → **Close**. **Cases** shows the audit trail.
9. **Human in the loop:** on an account the AI over-scores, press **Not a Mule**, then **Cases → Retrain Model v1 → v2**. The score updates, and the panel says "LightGBM v2".
10. **Credibility:** IBM AML results (below): the classifier retrained on IBM history gets 7.7× lift where the rules get 1.7×. Then the model card (`GET /ai/model`).

## Claims you can defend

| Say | Not |
|---|---|
| "14 alerts become 3 cases" | "80% faster" (no measurement behind it) |
| "Time-ordered money trail: money can only move forward in time" | "Causal inference" |
| "STR draft in one click" | "Replaces the analyst" |
| "The Copilot can't calculate. It quotes the rules engine and cites transaction IDs" | "AI detects the mules" |
| "Says *insufficient evidence* when the data doesn't support a conclusion" | "Never wrong" |
| "On IBM's public data, the classifier retrained on earlier days finds 7.7× more laundering than chance on later days" | "The rules work on any bank's data" (on IBM they reach 0.9–1.7×) |
| IBM AML precision / recall / lift from `eval_ibm.py` | Accuracy on our own synthetic data (we planted those rings) |

## Judge Q&A

- **"You planted the rings."** Yes, for the demo. On IBM's public AML dataset, which we didn't create, we trained the classifier on the first days and tested it on later days it never saw. With the same number of alerts (118), it caught 9 laundering accounts against the rules' 2: **7.7× lift over chance vs 1.7×**, AUC 0.68. The sample is small, and IBM has no KYC or device data.
- **"So your rules don't work?"** They're tuned for Indian UPI mule patterns: minutes-long pass-through, shared phones, cash just under ₹50,000. IBM's synthetic US-style laundering waits hours and uses few counterparties, so the rules alone barely beat chance there. That's exactly why the classifier learns from analyst labels instead of fixed thresholds.
- **"How is this different from RBI's MuleHunter.AI?"** MuleHunter flags individual mule accounts. MuleTrace starts after the flag: it groups the ring, traces the money, separates possible victims (sources) from mules, and produces the STR and freeze actions.
- **"Why review sources instead of freezing them?"** The first account money comes from may be a fraud victim, and freezing a victim's account harms them twice.
- **Indian thresholds:** structuring means repeated cash deposits just under ₹50,000, the PAN quoting threshold under Rule 114B (more than ₹50,000 cash in one day). The STR is due to FIU-IND within 7 days of the Principal Officer establishing suspicion (PML Rules, Rule 8; FIU-IND says "working days", RBI circulars say "days").
  - **Check before slides:** news reports say the Income-tax Rules, 2026 (from 1 April 2026) replaced Rule 114B's daily ₹50,000 test with an annual ₹10 lakh aggregate. If the official text confirms it, say "the long-standing ₹50,000 PAN threshold" rather than "the PAN threshold". See `TODO.md`.

## Evaluation on public data

**Quickest (no Kaggle token needed, any OS):**
```
pip install kagglehub
python -c "import kagglehub as k; [k.dataset_download('ealtman2019/ibm-transactions-for-anti-money-laundering-aml', path=f, output_dir='data/ibm') for f in ('HI-Small_Trans.csv','HI-Small_Patterns.txt')]"
python eval_ibm.py data/ibm/HI-Small_Trans.csv --limit 2500000 --patterns data/ibm/HI-Small_Patterns.txt --ai --out data/eval.json
```
`--ai` also trains the classifier on the earliest 65% of transactions and tests it on the rest, at the same alert budget as the rules. 2.5M rows need about 3 GB of free RAM and take about 30 s. `data/ibm/` (454 MB) is git-ignored; `data/eval.json` is committed so the card shows on any laptop.

**With the Kaggle CLI:**
1. **Get a token:** kaggle.com → Settings → API → **Create New Token**. That downloads `kaggle.json`; then run `mkdir -p ~/.kaggle && mv ~/Downloads/kaggle.json ~/.kaggle/ && chmod 600 ~/.kaggle/kaggle.json`.
2. **Download and score:**
```
mkdir -p data/ibm && cd data/ibm
../../.venv/bin/kaggle datasets download ealtman2019/ibm-transactions-for-anti-money-laundering-aml -f HI-Small_Trans.csv
../../.venv/bin/kaggle datasets download ealtman2019/ibm-transactions-for-anti-money-laundering-aml -f HI-Small_Patterns.txt
unzip -o '*.zip'; cd ../..
python3 eval_ibm.py data/ibm/HI-Small_Trans.csv --limit 1000000 --patterns data/ibm/HI-Small_Patterns.txt --out data/eval.json
```
The dashboard card and `GET /evaluation` pick up `data/eval.json` on the next page load.

**Result (17 Oct, first 2.5M rows):** rules 0.9× lift on all accounts, 12 of 260 laundering attempts touched. Classifier retrained on IBM: AUC 0.68, 7.7× lift vs the rules' 1.7× at 118 alerts. The classifier trained only on synthetic data scores AUC 0.60 on the same test days.

The script uses USD rows only, with USD thresholds (the US $10,000 reporting rule). `--patterns` scores IBM's whole laundering attempts: an attempt counts as caught when at least one of its accounts is flagged. The dataset has no device data, so shared-device detection is off. It reports precision, recall and **lift** (precision divided by the base rate of laundering accounts).

## Sending data in

```
curl -X POST localhost:8000/ingest -H 'content-type: application/json' \
  -d '[{"sender":"JUDGE-07","receiver":"JUDGE-07-POT","amount":49500,"channel":"cash"}]'
```

- **Fields:** `sender` and `receiver` take 3–24 letters, digits or dashes (new IDs open as walk-in accounts). `amount` is in rupees, above ₹0 and up to ₹1 crore. `channel` is one of upi, imps, neft, rtgs, cash, card or atm. Each request takes up to 500 transfers.
- **Clock:** transfers are stamped with the **bank clock**, not the client's time. When the feed is paused they queue until it resumes.
- **Other controls:** `POST /live/{play|pause|reset}?speed=1|10|30|60`, `POST /inject/{kind}`, `POST /autopilot?on=true|false`.

## Microsoft wiring

- **Microsoft Foundry (explainable AI):** `foundry/deploy.py` deploys the classifier as a managed online endpoint in your Foundry project. The API then scores through it, falling back to the local model if it's unreachable. See [`foundry/README.md`](foundry/README.md).

- **Copilot Studio:** **Tools → Add a tool → REST API**, then upload `/copilot/openapi.json` (14 tools such as `explainAlert`, `traceRingMoney`, `compareAccounts`, `draftRingStr`, `replayPolicy` and `dismantleRing`). Paste `microsoft/agent-instructions.md` as the instructions. Full steps, including Dev Tunnels for a public URL and the Teams channel, are in [`microsoft/README.md`](microsoft/README.md).
- **Power BI:** use **Get data → Web** on `/export/alerts.csv` (and `networks`, `transactions`, `accounts`) for live data, or `data/*.csv` for the fixed demo dataset.
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
     - **Teams** card: use **Post card in a chat or channel** with `microsoft/teams-card.json`, or a plain post:
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
  5. The dismantle message in the Log tab tells you whether the call was sent, isn't configured, or failed. A 401 or 403 usually means the trigger isn't set to Anyone. Each ring can only be dismantled once; launch another attack to test again.

## Checks

```
python3 xai.py train          # retrain the classifier → model/ (about 5 s)
python3 xai.py                # classifier: SHAP sums exact, monotone constraints hold, held-out AUC ≥ 0.9, ≤ 5% ordinary customers flagged
python3 muletrace.py          # engine: demo history → exactly 3 rings, none on normal accounts; evidence ids exist and ratios recompute; policy toggles work
cd web && node flow.check.mjs # graph layout: hop columns, ordering, device lane, wait times
cd web && npm run build       # type-check + production build
```

## Troubleshooting

- **Styles don't update, or "Failed to load chunk" in dev:** run `cd web && rm -rf .next && npm run dev`. For a production test build next to a running dev server, use `NEXT_DIST_DIR=.next-test npm run build`.
- **"No signal from the API":** start the API, and check that `NEXT_PUBLIC_API` and `CORS_ORIGINS` match your ports.
- **Copy the STR:** the STR dialog has **Copy** and **Save .txt**.
