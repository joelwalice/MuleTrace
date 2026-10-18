# MuleTrace: Project Context

Last updated: 18 Oct 2026, demo day.

**Start with the Team briefing (5 minutes).** Sections 1–9 below it are the full reference: architecture, every endpoint, the change log and the design rules. Use them when you're changing code or answering a hard judge question.

## Team briefing

### Where we are
- **Everything in the demo works end to end:** live bank feed → Red Team attacks → alerts → rings → money trail → evidence → STR draft → Dismantle → Power Automate email.
- **Live on Microsoft:** the Copilot Studio agent `MuleTrace Investigator` (MCP tools, embedded as **Ask Copilot**, also in Teams) and the Power Automate playbook (Outlook email with the STR on Dismantle, tested `sent (202)`).
- **Today's change: guardrails** (change log item 18; the full write-up is in [`AUDIT.md`](AUDIT.md)).
  - The agent can no longer freeze anything. It calls `proposeDismantle`, and the console shows **Awaiting your approval** with **Reject** and **Review & Approve**.
  - Through the public tunnel, only the agent's tools answer. Everything else returns 403.
  - Every agent call, approval and case action goes into a hash-chained audit trail (`GET /audit`).
  - `python3 check_guardrails.py` passes **31/31**.
- **Not pushed yet:** today's changes are uncommitted on `feat/copilot-mcp-playbook`. Until they're pushed, pulling won't get you the guardrails.
- **Optional, not done:** the Foundry endpoint (the classifier runs locally; don't claim it runs in Foundry) and Power BI.

### The pitch in four lines
1. Analysts drown in single-account alerts, while mule rings hide across many accounts.
2. MuleTrace groups alerts into rings: **about 14 alerts → 3 rings** once the three attacks are launched.
3. It traces the money hop by hop. Every figure cites its transaction IDs, and possible victims are sent to review, not frozen.
4. The Copilot agent investigates through the same API. It quotes the engine and never calculates for itself. It can only *propose* a freeze, and a human approves it.

**Against RBI's MuleHunter.AI:** MuleHunter flags individual mule accounts. MuleTrace starts after the flag: it groups the ring, traces the money, separates victims from mules and drafts the STR for FIU-IND.

### Numbers you can say (and how to say them)
| Claim | Say it like this |
|---|---|
| Alert reduction | "About 14 alerts become 3 rings." It's measured on our own synthetic attacks, so call it that. |
| IBM AML benchmark | "Our classifier, retrained on IBM history, gets **7.7× lift**; the rules alone get 1.7×." The sample is small (118-alert budget), so say so if asked. Never show the rules-only number as a win. |
| Classifier | LightGBM with exact SHAP reasons. Held-out AUC is about 0.96–0.98 on synthetic data and 0.68 on IBM. |
| STR deadline | "Within 7 days of establishing suspicion." That wording holds under both FIU-IND (working days) and RBI (days). |
| ₹50,000 PAN band | Say "the long-standing ₹50,000 PAN threshold". It may have been replaced by the Income-tax Rules, 2026, which we haven't confirmed. |

**If a judge pushes:** there's no sign-in, and approvals are recorded as "analyst (console)". There's no database, so a restart loses cases and the audit trail. All data is synthetic. We use one agent, not several. Say these plainly; `AUDIT.md` §1 has the wording.

### Run it
```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once (Mac: brew install libomp)
cd web && npm install                                                 # once
.venv/bin/uvicorn app:app --reload        # API on :8000
cd web && npm run dev                     # dashboard on :3000
./demo-mac.sh                             # demo day on the Mac: tunnel + API + phone build in one go
```
Secrets (`PUBLIC_URL`, `PLAYBOOK_WEBHOOK`, `TUNNEL`) live in the git-ignored `.demo.env` on the demo laptop. Never commit them or paste them in chat. Windows steps are in [`README.md`](README.md).

**Checks before you push:** `python3 muletrace.py`, `python3 check_guardrails.py`, `cd web && node flow.check.mjs`, `NEXT_DIST_DIR=.next-test npm run build`.

### Demo flow (5 min)
1. Start from **More → New Bank**, with the clock at 30× and Autopilot off.
2. Press **2** (Pass-Through Chain) and use **Trace Flow** to show the waits between hops.
3. A judge scans the QR code (**More → Judge Phone QR Code**), opens `/send` and taps **Structuring**. Their phone says **Caught**.
4. Press **1** and **3**, and the headline settles at about 14 alerts → 3 rings.
5. **Evidence → Ask Copilot:** "Why is AL-x suspicious?", then "Draft the STR", then the Policy replay (turn off Structuring, Replay, and rings drop from 3 to 2).
6. Ask Copilot to "Dismantle NET-x". It answers that the proposal is **awaiting approval**. In the console, **Review & Approve** locks the accounts, and the playbook email arrives.
7. Close on the IBM lift and the MuleHunter answer.

The full script and the morning checklist are in [`TODO.md`](TODO.md) §3.

### Before judging (open items)
- [ ] **Push** today's changes.
- [ ] In Copilot Studio, refresh the MCP tool's tools: `proposeDismantle` should appear and `dismantleRing` should be gone. Paste the new [`microsoft/agent-instructions.md`](microsoft/agent-instructions.md) and publish.
- [ ] Through the real tunnel, `curl -X POST $PUBLIC_URL/live/reset` should return 403, and Ask Copilot should still answer "List the mule rings".
- [ ] Rehearse the new approval step, test from a real phone on the laptop hotspot, and record a backup video.
- [ ] Check the ₹50k PAN rule on incometaxindia.gov.in (this only changes the slide wording, not the code).

### Gotchas
- **Dashboard shows stale CSS or "Failed to load chunk":** run `rm -rf web/.next && npm run dev`. Test builds always use `NEXT_DIST_DIR=.next-test`.
- **Phones can't load `/send`:** use `./demo-mac.sh` (a production build) rather than `npm run dev`, and put phones on the laptop hotspot. Venue Wi-Fi often isolates devices.
- **The agent's tools fail:** the dev tunnel `muletrace` isn't being hosted. `demo-mac.sh` hosts it.
- **Dismantle says "not configured":** the API didn't get `PLAYBOOK_WEBHOOK`.
- **The AI endpoints error on Windows:** pull the latest; it has the CRLF fix for `model/`.
- **A weak 2-account "insufficient" ring appears by itself:** that's the random feed. It's harmless and shows honest confidence, but start the demo from New Bank.

### Where things are
| File | What it is |
|---|---|
| [`README.md`](README.md) | Run steps, dashboard guide, Judge Q&A, "Claims you can defend" |
| [`TODO.md`](TODO.md) | What's left, team decisions, demo-day checklist |
| [`AUDIT.md`](AUDIT.md) | Audit against Microsoft's *AI Apps That Matter*: guardrails, scorecard, submission narrative |
| [`microsoft/`](microsoft/README.md) | Copilot Studio, Power Automate and Power BI setup; agent instructions |
| [`plan.md`](plan.md) | Original plan for the Investigation Copilot |
| `muletrace.py` · `app.py` · `xai.py` · `web/` | Engine · API (+ MCP) · classifier · dashboard |

---

## 1. What MuleTrace is

An AML (anti-money-laundering) SOC console that finds **money-mule networks**, not individual fraud alerts.

> A live bank feed streams in (plus red-team attacks and audience transfers) → rules raise alerts → alerts are grouped into rings → the money trail is drawn in time order → an STR (Suspicious Transaction Report) is drafted → one click dismantles the ring and triggers Power Automate.

- **Context:** a Microsoft-themed hackathon, 16–18 Oct 2026, with a 4-person team.
- **Audience:** Indian judges, so amounts are in ₹ and reports are written for FIU-IND.
- **Pitch number:** **about 14 alerts → 3 rings** once the three attacks are launched (alert reduction).
- **Positioning against RBI's MuleHunter.AI:** MuleHunter flags individual mule accounts. MuleTrace starts after the flag: it groups the ring, traces the money, separates possible victims from mules, and drafts the STR.

## 2. Architecture

```
muletrace.py   Python engine: synthetic data, detection rules, money trail, ring grouping (stdlib only)
app.py         FastAPI: live bank engine (feed, attacks, ingest) + SSE stream + REST endpoints + MCP endpoint (/mcp) + Power Automate webhook
eval_ibm.py    Scores the rules on the public IBM AML dataset (precision / recall / lift, attempt recall) → data/eval.json
microsoft/     Copilot Studio agent instructions, Teams adaptive card, setup for Dev Tunnels / Copilot Studio / Power Automate / Power BI
demo-mac.sh    Demo day on macOS: dev tunnel + API (webhook) + LAN production build; secrets from git-ignored .demo.env
demo-lan.ps1   Same LAN build for Windows (no tunnel/webhook handling)
data/*.csv     Written on API start, for Power BI
web/           Next.js 16 (App Router) + Tailwind v4 + cytoscape: the SOC dashboard
  app/dashboard.tsx  page state, URL sync, SSE, panels, keyboard shortcuts, signals log
  app/graph.tsx      money-trail graph (cytoscape, preset layout from flow.ts)
  app/flow.ts        pure layout maths: hop columns, ordering, device lane, wait times
  app/send/          /send: phone page for judges to send transfers and see them caught
  app/evidence.tsx   Evidence tab, STR checklist, Policy sheet, Ask Copilot sheet
  app/ui.tsx         primitives: NavLink/AccountLink (deep links), SevTag, Barcode chart, Readout…
  app/lib.ts         types, API helpers, Intl formatters (₹, en-IN dates), risk bands
  app/globals.css    theme tokens (dark telemetry), CRT overlay, blueprint grid, hazard stripes
  flow.check.mjs     self-check for flow.ts  →  node flow.check.mjs
```

### Run it
```
.venv/bin/uvicorn app:app --reload          # API :8000 (docs at /docs)
cd web && npm run dev                       # dashboard :3000
python3 muletrace.py                        # engine self-check
cd web && node flow.check.mjs               # graph layout self-check
```

### Environment variables
| Var | Where | Default | Purpose |
|---|---|---|---|
| `PLAYBOOK_WEBHOOK` | API | unset | Power Automate "When an HTTP request is received" URL. Keep it secret, never commit it. |
| `CORS_ORIGINS` | API | `http://localhost:3000` | Dashboard origin(s), comma-separated |
| `NEXT_PUBLIC_API` | web (build time) | `http://localhost:8000` | API base URL |
| `PUBLIC_URL` | API | request host | Public tunnel URL; Copilot Studio calls `<PUBLIC_URL>/mcp` |
| `NEXT_PUBLIC_COPILOT_URL` | web (build time, `web/.env.local`) | unset | Copilot Studio Demo website embed URL; shows **Ask Copilot** |
| `FOUNDRY_SCORING_URL`, `FOUNDRY_KEY` | API | unset | Score through the Foundry endpoint |

`demo-mac.sh` loads `PUBLIC_URL`, `PLAYBOOK_WEBHOOK`, `TUNNEL` and `FOUNDRY_*` from `.demo.env` (git-ignored).

## 3. Engine (muletrace.py)

- **`Bank` class:** mints accounts, devices and transfers. It's shared by `history()` (startup data, plus the CSV export with the 3 canonical rings) and the live feed. `bank.ring(kind, start)` builds a fresh ring of any kind at any bank-clock time.
- **Canonical demo history** (self-check and CSV export): fixed seed 42. 500 normal accounts and about 10k transactions over 30 days, plus **3 hidden rings**:
  1. **Structuring:** 6 small depositors make deposits of ₹45,000–49,900, just under the ₹50,000 PAN threshold, into a collector, who wires the money out.
  2. **Pass-through chain:** a dormant account (800 days) wakes up, ₹4,80,000 passes through 2 mules sharing device DEV9001, then exits.
  3. **Fan-in/fan-out:** 8 senders → a hub → 8 mules sharing DEV9002 → one ATM exit.
- **Rules** (thresholds are in INR; `eval_ibm.py` passes USD values):
  - **Structuring:** at least 3 deposits in the band within 24h.
  - **Pass-through:** at least 80% of a deposit of ₹50k+ sent onward within 30 minutes.
  - **Fan-in/fan-out:** more than 5 senders and more than 5 receivers within 1h.
  - **Dormant:** no activity for 90+ days, then ₹1L+.
  - **Shared device:** a device used by 3 or more accounts.
- **Score:** 1 − ∏(1 − base) + 0.2 × KYC risk. Severity is High (≥ 0.85), Medium (≥ 0.70), otherwise Low.
- **Money trail (`trace`):** a time-ordered trail, 4 hops back and 4 forward, within 72h, counting only transfers of ₹25k+. Earlier it was called "causal"; it was renamed because it isn't causal inference.
- **Rings (`networks`):** alerts whose trails or devices touch the same accounts are merged into one ring. Each ring's accounts are split into:
  - **sources:** the first money in. These may be fraud victims, so they go to **review**, not freeze.
  - **mules:** accounts that pass the money on.
  - **exits:** where the money leaves.

  `total_in` counts money that **entered** the ring. It used to sum every hop, which inflated ₹4.8L to ₹17L.
- **Self-check result:** 14 alerts form exactly 3 rings, with 0 alerts on normal accounts.

## 4. API (app.py)

- **Live feed:**
  - On start and on **New Bank**, the API builds a fresh bank: 30 days of ordinary history with a random seed, and **no rings**.
  - A bank clock then runs at 1/10/**30**/60× real time, with ordinary transfers arriving at about 2 per real second, forever.
  - Each tick is 0.25s and reruns detection, which takes about 11 ms at 10k transactions and grows with the feed.
  - State is **in memory**, so run a single worker.
- **Attacks:** `POST /inject/{structuring|chain|fan}` schedules a fresh ring 30s ahead on the bank clock. Its transfers sit in a heap and release as the clock passes them; the snapshot reports `attacks` (left/total) and `queued`. **Autopilot** launches a random attack every 60–120 real seconds.
- **Ingest:** `POST /ingest` takes up to 500 transfers, validated by pydantic: ID pattern, amount from ₹0 to ₹1 crore, a channel enum, and sender ≠ receiver. Unknown IDs open as walk-in accounts. Transfers are stamped with the bank clock.
- **Concurrency rule:** API requests only append to `LIVE.requests`. The tick applies them on the event loop *before* detection runs in a worker thread, so accounts are never mutated mid-detection.
- **IDs:** alert and ring IDs are stable for the life of a bank. A ring is named after its earliest alert.
- **Endpoints:**
  - `GET /stream` (server-sent events snapshot)
  - `POST /live/{play|pause|reset}?speed=`, `POST /inject/{kind}`, `POST /autopilot?on=`, `POST /ingest`
  - `GET /snapshot`, `/stats`, `/alerts`, `/networks`, `/cases`
  - `GET /account/{id}`
  - `GET /alert/{id}`, `/alert/{id}/graph`
  - `GET /network/{id}`, `/network/{id}/graph`
  - `POST /network/{id}/dismantle`
- **Investigation (Copilot grounding):**
  - `GET /alert/{id}/evidence` and `GET /network/{id}/evidence` return the claim, a confidence of high/medium/low/**insufficient**, computations (value, formula, input IDs), cited transactions, gaps and next questions.
  - `GET /compare?accounts=A,B` returns direct transfers, shared devices, the same ring, and common counterparties.
  - `GET /alert/{id}` and `GET /network/{id}` now include an STR `checklist` (supported vs missing).
- **Policy:**
  - `GET /policy` returns the rules in force.
  - `POST /policy/replay` reruns detection on the current bank and changes nothing.
  - `POST /policy/apply` is queued into the tick, like every other state change. The policy survives New Bank.
- **Benchmark and exports:**
  - `GET /evaluation` reads `data/eval.json`, or returns `status: "not run"`.
  - `GET /export/{accounts|transactions|alerts|networks}.csv` serves the live tables for Power BI.
- **Copilot Studio tools:** `COPILOT_TOOLS` lists the 22 investigator operations (17 core plus 5 relationship tools from PR #3) (camelCase `operationId`s).
  - `POST /mcp`: MCP over streamable HTTP, stateless JSON responses (initialize, tools/list, tools/call, ping). Tool schemas are generated from the same OpenAPI routes, and each call is forwarded in-process to the REST route, so answers are identical. This is what the current Copilot Studio uses (its **Add tool** dialog offers only MCP and Workflow).
  - `GET /copilot/openapi.json`: the same tools as OpenAPI 3.0, for older layouts with a REST API tool. `servers` comes from `PUBLIC_URL`.
- **Dismantle:** freezes mules and exits (simulated), sends sources to review, opens a case, and POSTs the case JSON to `PLAYBOOK_WEBHOOK`. The response reports `sent (status)`, `not configured`, or `failed: …`. It runs from the console only; the agent gets `POST /network/{id}/propose-dismantle` (item 18).
- **Guardrails (item 18):** `PublicLockdown` middleware, the hash-chained `GET /audit`, optional `MCP_KEY`, and `PUBLIC_LOCKDOWN` (default `1`).
- **STR drafts:** the ring draft's "Grounds for suspicion" is built from the patterns that fired (`GROUNDS` in `app.py`), not fixed text.

## 5. Change log (in order)

1. **v1, one HTML page.** FastAPI plus a single `index.html` using Cytoscape. Since removed.
2. **Critique-driven upgrades.**
   - Rings now group alerts (14 → 3).
   - Added the IBM AML evaluation script.
   - Claims made defensible: "time-ordered trail" instead of "causal", and "14 alerts → 3 cases" instead of an unmeasured "80% faster".
   - India localisation: ₹ with lakh formatting, the PAN ₹50k structuring band, and STR for FIU-IND within 7 working days.
   - Fixed `total_in` inflation, collapsed shared devices into one node, and dropped `exits` that had been excluding alerted accounts.
3. **Next.js app.** Live replay over SSE, a ring/alert queue, the graph, Account 360, a live feed, toasts, dismantle with a confirmation step, and a mobile tab bar.
4. **dataviz + artifact-design pass.**
   - Risk became a validated one-hue ordinal ramp, with status colours reserved for state (icon plus label).
   - Added a table-view twin of the graph, hover tooltips and a hero figure.
   - Added light and dark themes with a toggle.
5. **Web Interface Guidelines pass** (vercel `web-design-guidelines`, plus `redesign-existing-projects`).
   - **URL state:** the URL mirrors ring, alert, account, panel, view and tab, and every selection is a real `<a href>` deep link.
   - **Accessibility:** skip link, h1 and heading hierarchy, ARIA for tabs and meters, and focus returns after the dialog closes.
   - **Motion:** animations use transform and opacity only, and reduced motion is respected.
   - **Formatting:** all numbers and dates go through `Intl`; buttons and headings are Title Case.
   - **States:** skeleton loading, holding the previous render while refetching, an offline banner, a 404 page, a favicon and Open Graph meta.
6. **industrial-brutalist-ui redesign** (the user said v5 looked AI-generated).
   - **Look:** dark tactical-telemetry theme only, with hazard red as the single accent and terminal green used for one element.
   - **Shapes and type:** square corners, 1px grid-gap lines, and Archivo Black macro numerals.
   - **Glyphs:** ASCII glyphs replace hand-drawn icons, and the light theme and toggle were removed.
   - **New features:** a signals log and ticker replace toasts; keyboard shortcuts Space, J/K and T; an ASCII progress bar; a barcode chart for hourly volume; and a hazard-striped armed state for dismantle.
7. **Readability pass.**
   - The muted grey had measured 3.3–3.7:1 against the backgrounds (below AA), so it was raised to ≥ 5.7:1.
   - The minimum font size went from 10px to 11.5px, and letter-spacing was halved.
   - Long messages use normal case.
   - The CRT overlay strength was halved.
8. **Graph redesign (flow timeline).**
   - **Layout:** hop columns left to right with time headers, wait times on edges (+9m), and node size by money through it.
   - **Interaction:** hover traces the path, **Trace Flow** replays transfers in order, plus zoom, fit and full screen.
   - **Responsive:** the orientation is chosen by best fit (phones go top-to-bottom), and tall columns pack tighter.
   - **Copy:** the pass-through reason now says "Received ₹X and sent ₹Y onward", replacing "forwarded 216%".

9. **Live bank instead of replay** (the user wanted a "hackathon based live transaction view", not a canned demo).
   - **Engine:** an endless feed on a bank clock, with Red Team attacks (console, keys 1–3, autopilot), `POST /ingest`, and the `/send` judge page ("Try to Fool It" scenarios plus a live "Caught" readout).
   - **Controls:** **New Bank** gets a two-step confirm.
   - **Copy:** the ticker and empty states were rewritten for a feed with no end.
   - **Tests:** verified end to end. A chain attack was caught as a ring, and judge structuring from a phone was caught.

10. **Investigation Copilot** (plan.md; DeepSeek's "winning idea", corrected for India and honesty).
   - **Engine:** each rule hit records its evidence (the transaction IDs plus computed figures with formulas). `detect()` takes policy parameters (`rules`, `ratio`, `fan`, `dormant_days`), and `confidence()` returns `insufficient` when only the device rule fires or the trail has fewer than 2 transfers.
   - **Self-check:** every cited ID exists, and each pass-through ratio recomputes from its own inputs.
   - **API:** evidence bundles, compare, STR checklist, policy replay/apply, the evaluation endpoint, live CSV exports, and the Copilot spec.
   - **UI:**
     - **Evidence** tab: hovering a figure or row lights exactly those transfers in the graph; clicking pins them. "Ask" questions answer inline (trace, compare, STR).
     - **Policy** side sheet: Replay before Apply, with a two-step confirm. The header shows "Policy · Custom" when the policy differs from the defaults.
     - **Ask Copilot** sheet: a Copilot Studio iframe, shown only when `NEXT_PUBLIC_COPILOT_URL` is set.
     - **IBM AML Benchmark** card (xl+): shows only measured numbers.
     - The STR dialog shows the checklist.
   - **Fixed:** a side-sheet focus effect re-ran on every live tick, which stole focus from the sliders. The effect is now keyed once per open, with a ref for `onClose`.
   - **Microsoft:** `microsoft/` holds the agent instructions, a Teams adaptive card, and step-by-step setup for Dev Tunnels, Copilot Studio (REST API tools, Web app and Teams channels), Power Automate and Power BI.

11. **Judge-readability pass** (the user said the dashboard was information-overloaded for a demo video).
   - **Reading order:** panels are headed **Step 1 Plant a Mule Ring → Step 2 Pick a Ring → Step 3 Follow the Money → Step 4 Check the Evidence**. Picking a ring opens the Evidence tab.
   - **Summary:** now a plain pipeline (transfers checked → alerts raised → mule rings → accounts locked), each with a one-line caption. The barcode chart and the hero block were removed (snapshot `hourly` dropped).
   - **Header:** status, time, Pause, Rules, Ask Copilot, and **More**. More holds clock speed, Autopilot, the judge phone page, New Bank and shortcuts. The footer was removed.
   - **Graph:**
     - The legend is cut to Low→High risk, Flagged, Source (maybe a victim) and Shared phone.
     - One plain caption replaces the corner annotations.
     - The ring list shows alerts only under the selected ring.
   - **Accuracy card:** hidden until `data/eval.json` exists, instead of showing "Not Run".

12. **Light workspace redesign** (the user said the terminal look wasn't easy for bank employees).
   - **Theme:** dark → light, using `minimalist-ui` tokens in `globals.css`.
   - **Type:** `.tl` and `.macro` are now normal-case Plex Sans. Archivo Black and the CRT overlay were removed.
   - **Components:**
     - severity and confidence as pastel pills
     - numbered circle badges for the Steps
     - underline tabs
     - rounded controls
     - real progress bars
     - a soft-shadow dialog and side sheet
     - a dot-grid graph surface
     - rounded graph nodes with hairline borders
   - **Text:** the STR draft is shown in sans.
   - **Checked:** text contrast at 1440, 1920 and 390 px.

13. **Explainable AI classifier for Microsoft Foundry** (`xai.py`, `model/`, `foundry/`).
   - **Model:** LightGBM with monotone constraints and 12 behavioural features. Explanations are exact TreeSHAP contributions from `pred_contrib`, with no `shap` dependency.
   - **Training data:** synthetic banks of varied size, with rings, jittered rings, and legitimate look-alikes (payroll, merchant, cash shop, sweep, quiet account, one-off big credit).
   - **Shortcuts removed during development:**
     - KYC rating and account age (mules were always new and high-risk), fixed by adding rented old mule accounts and new legitimate customers
     - transaction counts and counterparty counts (they depend on how busy the bank is), replaced by burst-per-hour features
   - **Results:** held-out AUC about 0.96–0.98, with about 1.6% of ordinary customers in a live-style bank flagged (the self-check fails above 5%).
   - **API:**
     - `GET /account/{id}/ai` and `GET /ai/model`
     - the `ai` block in alert evidence, and `ai_accounts` (scores plus `ai_only`) in ring evidence
     - two new Copilot tools: `explainAccountRisk` and `getModelCard`
   - **Foundry:** `FOUNDRY_SCORING_URL` + `FOUNDRY_KEY` switch scoring to the endpoint, with local fallback noted on screen. `foundry/deploy.py` uses azure-ai-ml to create the managed online endpoint (hub-based project).
   - **UI:** an AI Classifier panel (diverging SHAP bars) in Evidence and in the Account view; a ring view of AI scores per account, highlighting "AI flags accounts no rule alerted". Scores are capped at 1–99%.
   - **Dependencies:** `lightgbm` and `numpy` are in `requirements.txt`. On a Mac, LightGBM needs `brew install libomp`.

14. **Ponytail pass: lighter layout, leaner serving.**
   - **Evidence:** opens with a verdict line, "Rules: High · AI: 99% Mule" (for a ring: "AI: 5/5 accounts flagged"), then "Why · AI" and "Why · Rules".
     - Transactions and data gaps fold away in native `<details>`.
     - "Alerts in this ring" was deleted, because the ring list shows it.
   - **Case panel:** the paragraph that repeated the Evidence claim was deleted, so the graph gets the space.
   - **Server:** the SSE snapshot is serialised once per version and shared by every client (projector plus judge phones), instead of once per client per tick.
   - **Graph:** if cytoscape's chunk fails to load, it says so, with Reload and Table options, instead of drawing nothing.
   - **Builds:** `next.config.ts` reads `NEXT_DIST_DIR`. Test builds use `.next-test`, so they never touch the dev server's `.next`. A shared `.next` caused the "Failed to load chunk … cytoscape" error.

15. **Close the loop: cases, analyst feedback, retraining, judge QR.**
   - **Cases:** status runs open → str_filed (simulated FIU-IND acknowledgement) → closed, with an `events` audit trail. `POST /case/{id}/{file_str|close}` returns 409 for an out-of-order step. A second dismantle of the same ring now also returns 409.
   - **Labels:** `POST /account/{id}/label?mule=` stores the analyst verdict (no value clears it). Dismantling auto-labels the frozen accounts as mules; sources are not labelled, since they may be victims.
   - **Retraining:**
     - `POST /ai/retrain` trains the next model version in a worker thread, with analyst rows weighted ×30. It uses the cached synthetic base and takes about 2 s.
     - The new version is in memory only; `model/` on disk stays v1.
     - The snapshot carries `cases`, `labels` and `model_version`. AI panels show the model version and refetch when it changes.
   - **UI:**
     - **Cases** sheet: timeline, File STR / Close buttons, and "Teach the Classifier · Retrain".
     - **Case panel:** next-step button (File STR → Close).
     - **Account tab:** Confirm Mule / Not a Mule.
     - **More → Judge Phone QR Code:** a `qrcode` npm package rendering an SVG locally; it warns on localhost.
   - **Self-check:** an analyst "not a mule" on the top-scoring account yields v2, which scores it lower.

16. **IBM benchmark run, Windows fixes, judge phones over LAN** (17 Oct, evening).
   - **IBM AML HI-Small** downloaded with `kagglehub` (no token needed) into `data/ibm/` (git-ignored). First 2.5M rows: 732k USD transactions, 153k accounts, 1,236 laundering.
     - **Rules:** 0.9× lift, 12 of 260 attempts touched. They're tuned to the demo's attacks: IBM laundering waits a median 9.5 h before forwarding and has a median of 2 senders / 1 receiver, so 30-minute pass-through and >5 fan rarely fire.
     - **`eval_ibm.py --ai`:** trains the classifier on the earliest 65% of transactions, tests on the rest (features and labels from disjoint windows, no KYC/device/opening dates). AUC 0.68 (synthetic-only model: 0.60). At the rules' alert budget (118): AI caught 9, rules 2, so **7.7× vs 1.7× lift**. Small sample; say so.
     - The split is by transaction count, not time span: IBM's last days hold a sparse tail of almost only laundering rows.
   - **Accuracy card:** leads with the classifier's IBM lift when `eval.json` has an `ai` block, with "rules alone 1.7×" beside it; the tooltip holds the counts.
   - **Copilot instructions:** "How accurate is it?" now leads with the `ai` block and states the rules' weakness on IBM plainly.
   - **Fixed: model unreadable on Windows.** Git's `core.autocrlf` checked `model/mule_classifier.txt` out with CRLF, which LightGBM rejects ("Model format error"), so every AI endpoint failed. `.gitattributes` now marks `model/*.txt -text`, and `xai.load()` strips `\r` anyway.
   - **Judge phones:** `demo-lan.ps1` builds and serves the API and dashboard on the laptop's Wi-Fi address. Production build on purpose: the Next dev server blocks its scripts for non-localhost hosts.
   - **Repo hygiene:** root `.gitignore` (`.venv/`, `__pycache__/`, `data/ibm/`, `.next-test/`); compiled `.pyc` files untracked.
   - **Remaining work and sign-ins:** `TODO.md`.

17. **Microsoft integrations live** (18 Oct, demo day, in the hackathon lab tenant on a Mac).
   - **Copilot Studio agent** `MuleTrace Investigator` (Claude Opus 5.5), published with the Demo website and Teams + Microsoft 365 channels, no authentication, embedded in **Ask Copilot**.
     - The new Copilot Studio has no REST API tool, so `app.py` gained `POST /mcp` (MCP, stateless JSON) exposing the same 17 tools by forwarding to the REST routes.
     - Lab-tenant hurdles: the default environment had no Dataverse (added in the Power Platform admin center), the user needed the System Administrator role there, web channels stay greyed out until authentication is off, and the MCP tool's Authentication had to change from **End user account** to the maker's, or the embed shows "Connection Required".
     - Rule 6 tightened after a test where the agent treated a repeated "Dismantle NET-1" as approval: only an explicit yes in the very next message counts. Retested: it asks again on a repeat and acts on "yes".
     - The "I should…" text seen in testing is the model's collapsed thinking panel, not the answer; the instructions also forbid narrating.
   - **Power Automate:** HTTP trigger → Outlook **Send an email (V2)** with an HTML body (case, frozen and review accounts, STR draft in a `<pre>`). The lab user had no Teams. Tested: `sent (202)` → email received. HTML must be pasted after switching the body to `</>`, or the tags arrive as text.
   - **STR grounds fix:** the ring STR always said "rapid pass-through, sub-threshold deposits and shared devices". The agent itself flagged this on a dormant-only ring. It now lists only the patterns that fired.
   - **`demo-mac.sh`:** tunnel + API + LAN build in one command, secrets in `.demo.env`. This Mac's own dev tunnel is `muletrace-mac` (`https://rj2pcsz0-8000.inc1.devtunnels.ms`); both MuleTrace custom connectors point at it.
     - Why not the shared `muletrace` tunnel: another machine kept hosting it, which kicked this Mac off and gave Copilot Studio 404s and timeouts. One host per tunnel.
     - Copilot Studio caches the MCP tool list: after the API's tools change, refresh the tool, click **Done** and **Publish** again, or the agent keeps stale tools (it still offered `dismantleRing` until republished).
     - **Model switched to Claude Sonnet 5.5** (was Opus 5.5) because answers were slow. Tool calls take about 0.4 s through the tunnel, so the wait was the model's thinking across 2–3 tool rounds; answer quality was unchanged in testing.
     - **Playbook email:** subject now starts "Mule ring eradicated | STR due in 7 days: ring …" and the body opens with a green "Mule ring eradicated" line. It fires on every dismantle, including **Review & Approve** of an agent proposal. `PLAYBOOK_WEBHOOK` lives in `.demo.env`.
     - **One-click approve link:** `proposeDismantle` returns `approve_link` (`$DASHBOARD_URL/?ring=NET-x`, set by `demo-mac.sh`/`demo-lan.ps1`), and rule 6 makes the agent end with "Open PRP-xxx to approve". Approval stays in the console on purpose: an in-chat approve tool was considered and dropped, because MCP can't prove a human said yes and the tunnel is anonymous.
     - **Designed eradication email:** the API builds it (`eradication_email()` in `app.py`: table layout, inline styles, Outlook-safe) and sends `email_subject` + `email_html`; the flow's Subject and Body are just `triggerBody()?['email_subject']` / `['email_html']`. Change the look in code, not in the flow.
     - **Agent rule 14:** every answer = bold verdict line, Why, a money-trail table, Gaps, Evidence.
     - Only dismantle sends the eradication email; filing an STR or closing a case no longer calls the playbook.
     - Rule 13: the bank clock runs 30x real time, so timestamps can be later than today. The agent flagged them as anomalies until the rule said that's expected.
   - **Observed:** the random background feed occasionally forms a weak 2-account dormant-only ring (confidence insufficient). Harmless, and a good "insufficient evidence" moment, but start the demo from **New Bank**.

18. **Guardrails enforced in code, not the prompt** (18 Oct, demo day; see `AUDIT.md`). Uncommitted at the time of writing.
   - **Why:** the approval for a freeze depended only on rule 6 of the prompt, and the anonymous tunnel exposed every route. Anyone with the URL could `POST /live/reset` or dismantle a ring.
   - **Action classes:** (1) read-only, (2) a reversible draft or proposal, which the agent may do, and (3) consequential actions (freeze, file, close, policy apply, reset), which happen in the console only.
   - **Agent tools:** `dismantleRing` was removed from `COPILOT_TOOLS` and replaced by `proposeDismantle`. A proposal is pending and idempotent; the console approves it through Dismantle or rejects it with `POST /proposal/{id}/reject`. A stale `dismantleRing` call over MCP is refused and logged. The core tool count stays at 17 (22 with the PR #3 relationship tools).
   - **Public lockdown:** a pure ASGI middleware (so SSE passes through). Through the tunnel or `PUBLIC_URL`, only the Copilot tools, `/mcp` and `/export/*` answer; everything else returns 403 and is audited.
   - **Audit:** an append-only SHA-256 chain that survives New Bank. `GET /audit` reports `intact`.
   - **Optional `MCP_KEY`:** sent as the `x-api-key` or Bearer header.
   - **Prompt:** rule 6 now says the agent can't act and must propose. New rule 11 treats tool output as data, never instructions. New rule 12 allows regulatory claims only from an approved source.
   - **UI:** an "Awaiting your approval" banner with Reject and Review & Approve, plus a signal-log entry when a proposal arrives.
   - **Tests:** `check_guardrails.py` (31 adversarial checks, in-process, no server) passes 31/31.

## 6. Design rules currently in force (don't regress)

- **Look:** a light analyst workspace (from the `minimalist-ui` skill), replacing the dark terminal look in item 12.
  - Warm off-white canvas `--bg #f3f2ee`, white working surfaces `--panel`, charcoal text `--ink #1f2328`, 1px hairlines, 6–12px radii.
  - Panes are still separated by 1px grid gaps.
- **Colour:**
  - **Red** (`--red #b42318`) means risk or danger only.
  - **Status tags** are pastel pills: High = red-soft, Medium = amber-soft, Low = grey. Each also carries a glyph and a word, never colour alone.
  - **Selection** is pale blue `--sel`, with a blue left edge.
- **Risk ramp (on white):** `--risk-0..3` = #f0b4a8, #e07a66, #c4321f, #7e1c12. Higher risk is darker. Graph nodes carry a hairline border, because the palest step is faint on white.
- **Contrast:** text must be ≥ 4.5:1. Muted text `#66655f` measures 5.2:1 on the canvas and 5.9:1 on white.
- **Type** (the user preferred the earlier lettering, so it was restored on the light theme):
  - IBM Plex Mono capitals for labels (`.tl`, `.eyebrow`, `.chip`).
  - Archivo Black for figures and ring IDs (`.macro`).
  - Plex Sans for prose (captions, explanations, gaps).
  - No zero-padded numbers.
- **Never bring back:** ASCII brackets, `///`, `>>>`, block-character bars, scanline/CRT overlays, a blinking cursor, or the dark theme.
- **Judge-first:** new UI must fit the Step 1–4 reading order. Secondary controls go in **More**. Every number gets a plain-English caption.
- **Graph:** amounts appear in tooltips and the table view, not on lines. Wait labels show only when a ring has ≤ 12 transfers.
- **URLs:** every selection must stay a real link.
- **Destructive actions:** need the in-page two-step confirmation (now a red-soft panel). Never use `confirm()`.

## 7. Integrations

- **Power Automate** (set up in the portal):
  1. Instant cloud flow → trigger "When an HTTP request is received" (a **premium** connector), with **Who can trigger** set to **Anyone**. Paste the JSON schema with the case fields: `case_id, network_id, alert_ids[], frozen[], review[], summary, str_draft, status, score, total_in`.
  2. Actions: Outlook email with the STR draft (live in the demo). Teams post and a Planner task due in 7 days where the tenant has them.
  3. Run the API with `PLAYBOOK_WEBHOOK='…'` (`demo-mac.sh` reads it from `.demo.env`).
- **Copilot Studio:** an MCP tool on `<PUBLIC_URL>/mcp` (22 tools; or a REST API tool from `/copilot/openapi.json` in older layouts), with the instructions in `microsoft/agent-instructions.md`. Embedded via the Demo website channel. See `microsoft/README.md`.
- **Power BI:** use the live `/export/*.csv` through Get data → Web, or the static `data/*.csv` (the canonical demo dataset).
- **Azure:** API on App Service (`uvicorn app:app --host 0.0.0.0`, set `CORS_ORIGINS`); `web/` on Static Web Apps or App Service, with `NEXT_PUBLIC_API` set at build time.

## 8. Known issues and open items

- **IBM AML run done** (item 16). The rules alone barely beat chance on IBM; pitch the retrained classifier's 7.7× and be upfront about the rules.
- **Foundry endpoint not deployed yet.** It needs an Azure subscription, `az login` and a hub-based Foundry project. See `foundry/README.md`.
- **Copilot Studio agent and Power Automate are live** (item 17). They depend on the dev tunnel running and the webhook URL being passed to the API; `demo-mac.sh` handles both.
- **Facts to verify before the slides:** the STR deadline checks out (7 days from the Principal Officer establishing suspicion; FIU-IND says working days, RBI says days). The **₹50k PAN rule may be out of date:** reports say the Income-tax Rules, 2026 (from 1 April 2026) replaced Rule 114B's daily test with an annual ₹10 lakh aggregate. Unconfirmed against the official notification; see `TODO.md`.
- **Next dev server stale CSS or "Failed to load chunk":** run `rm -rf .next && npm run dev`. Agents must build with `NEXT_DIST_DIR=.next-test` so they never touch the dev server's `.next`.
- **Leftover processes:** three uvicorn processes (ports 8765, 8770, 8771) were started inside the agent sandbox and can't be killed, not even with `sudo`. They're harmless and should go away after quitting Claude Code or rebooting.
- **Not built:** CSV upload (cut, since `/ingest` covers incoming data), user sign-in and roles (only `/mcp` has an optional key), a database (cases and the audit trail are lost on restart), an ML anomaly score, and an LLM call inside the app (Copilot Studio handles that).
- **Minor:**
  - The explanation text says "3 alert(s)".
  - The selected ring card's white header picks up faint scanlines.
  - Node prints a harmless module-type warning when running `flow.check.mjs`.

## 9. Demo script (5 min)

1. **Problem:** analysts drown in alerts, and mule rings hide across many accounts.
2. **The bank is live:** the ledger streams and the bank clock runs.
3. Press **2** (Pass-Through Chain). The ring assembles hop by hop. Use **Trace Flow** for the waits.
4. A judge opens **/send** on a phone and taps **Structuring**. Their account becomes a ring on the big screen, and their phone says **Caught**.
5. Launch **1** and **3**. The headline settles at about 14 alerts → 3 rings.
6. **Evidence tab, then Ask Copilot:**
   - "Why is AL-10x suspicious?" The answer cites `[TX…]` and the graph lights those edges.
   - "Draft the STR." The checklist shows 4 supported and 3 missing items.
   - **Policy:** turn off Structuring → Replay → "Rings 3 → 2, missed NET-x" → Defaults.
7. **Dismantle Ring → Lock N Accounts** (the fan-in/fan-out ring). Sources go to review, and the playbook emails the STR draft.
8. **Credibility:** IBM AML lift, and the answer on MuleHunter.AI.
