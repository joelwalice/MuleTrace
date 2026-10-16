# MuleTrace: Project Context

Hand-off notes for anyone (person or AI agent) picking up this repo. They cover what was built, why each decision was made, and what is still open. Last updated: 16 Oct 2026, day 1 of the 48-hour hackathon.

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
app.py         FastAPI: live bank engine (feed, attacks, ingest) + SSE stream + REST endpoints + Power Automate webhook
eval_ibm.py    Scores the rules on the public IBM AML dataset (precision / recall / lift)
data/*.csv     Written on API start, for Power BI
web/           Next.js 16 (App Router) + Tailwind v4 + cytoscape: the SOC dashboard
  app/dashboard.tsx  page state, URL sync, SSE, panels, keyboard shortcuts, signals log
  app/graph.tsx      money-trail graph (cytoscape, preset layout from flow.ts)
  app/flow.ts        pure layout maths: hop columns, ordering, device lane, wait times
  app/send/          /send: phone page for judges to send transfers and see them caught
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
- **Copilot Studio grounding:** `GET /alert/{id}` and `GET /network/{id}` return `explanation` and `str_draft`. Use `/openapi.json` to build a custom connector.
- **Dismantle:** freezes mules and exits (simulated), sends sources to review, opens a case, and POSTs the case JSON to `PLAYBOOK_WEBHOOK`. The response reports `sent (status)`, `not configured`, or `failed: …`.

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

## 6. Design rules currently in force (don't regress)

- **Colour:**
  - The theme is dark telemetry only, defined by tokens in `globals.css`.
  - Red is the only accent and also means High severity.
  - Severity always carries a glyph (▲ ◆ ●) and a word, never colour alone.
- **Risk ramp:** `--risk-0..3` (#842a2a, #b82c2c, #ec3a30, #ff9282). It is validated with `validate_palette.js --ordinal --mode dark --surface #111111`. Re-run the validator if you change it.
- **Text contrast:** must be ≥ 4.5:1. The current muted grey #949494 sits at about 5.7–6.5:1.
- **Case:** uppercase only for short labels (`.tl`). Long text uses `.msg` (normal case). Source strings stay Title Case and are uppercased by CSS.
- **Graph:**
  - Amounts appear in tooltips and the table view, not on lines.
  - Wait-time labels show only when a ring has ≤ 12 transfers; busy rings show them on hover.
- **URLs:** every selection must stay a real link, and URL params must keep working.
- **Destructive actions:** need the in-page two-step confirmation. Never use `confirm()`.

## 7. Integrations

- **Power Automate** (set up in the portal):
  1. Instant cloud flow → trigger "When an HTTP request is received" (a **premium** connector), with **Who can trigger** set to **Anyone**. Paste the JSON schema with the case fields: `case_id, network_id, alert_ids[], frozen[], review[], summary, str_draft, status, score, total_in`.
  2. Actions: Teams post, a Planner task due in 7 days, and Outlook email.
  3. Run the API with `PLAYBOOK_WEBHOOK='…'`.
- **Copilot Studio:** a custom connector from `/openapi.json`, using actions `GET /network/{id}` and `GET /alert/{id}`.
- **Power BI:** connect to `data/*.csv` (`networks.csv` has one row per ring).
- **Azure:** API on App Service (`uvicorn app:app --host 0.0.0.0`, set `CORS_ORIGINS`); `web/` on Static Web Apps or App Service, with `NEXT_PUBLIC_API` set at build time.

## 8. Known issues and open items

- **IBM AML numbers not run yet.** This needs a Kaggle login: `kaggle datasets download ealtman2019/ibm-transactions-for-anti-money-laundering-aml -f HI-Small_Trans.csv`, then `python3 eval_ibm.py HI-Small_Trans.csv --limit 1000000`. Put the result in the README's Q&A.
- **Facts to verify before the slides:** the PAN rule (Rule 114B, ₹50k cash) and the STR deadline (7 working days, PML Rules) were written from memory.
- **Next dev server stale CSS:** if styles don't update, run `rm -rf .next && npm run dev`.
- **Leftover processes:** three uvicorn processes (ports 8765, 8770, 8771) were started inside the agent sandbox and can't be killed, not even with `sudo`. They're harmless and should go away after quitting Claude Code or rebooting.
- **Not built:** CSV upload and ingest, a database or auth (cases are lost on restart), an ML anomaly score, and an LLM call inside the app (Copilot Studio handles that).
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
6. **Copilot:** "Explain this ring and draft the STR."
7. **Dismantle Ring → Lock N Accounts.** Sources go to review, and Teams and Planner fire.
8. **Credibility:** IBM AML lift, and the answer on MuleHunter.AI.
