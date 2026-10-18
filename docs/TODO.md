# MuleTrace: Open Items

Copilot Studio (MCP tools, web-chat embed, Teams channel) and the Power Automate playbook (Outlook email on Dismantle) are live. Setup: `microsoft/README.md`.

## 1. Needs access (someone's sign-in or licence)

| # | Task | Status | If it isn't done |
|---|---|---|---|
| 1 | **Foundry endpoint** for the classifier | Open, optional. About 30 min setup + 10–15 min deploy | The local model is used and the panels say so. |
| 2 | **Power BI** report | Open, optional. Power BI Desktop is Windows-only; use the Power BI service on a Mac | Use the `/export/*.csv` routes directly. |

### What Copilot and Power Automate depend on
- **The dev tunnel** must be hosted (its URL is fixed: `PUBLIC_URL` in `.demo.env`). If it stops, the agent's tools fail.
- **The webhook URL** must reach the API (`PLAYBOOK_WEBHOOK` in `.demo.env`). Without it, Dismantle says "not configured".
- **One command does both:** `./demo-mac.sh` (or `--skip-build` when nothing changed). It also builds the dashboard with the Copilot embed URL from `web/.env.local`.
- **Health check:** Ask Copilot → "List the mule rings" answers; Dismantle a test ring → Log says `sent (202)` and the email arrives.
- The agent's authentication is off and the MCP tool uses the maker's connection, so the embed needs no sign-in.

### Foundry
Full guide: `foundry/README.md`. `az login`, then
`python3 -m venv .venv-azure && .venv-azure/bin/pip install azure-ai-ml azure-identity`, then `deploy.py`. Add `FOUNDRY_SCORING_URL` and `FOUNDRY_KEY` to `.demo.env`.
- **Delete the endpoint when you're done with it.** It bills by the hour.

## 2. Decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | **The ₹50,000 PAN rule may be out of date.** News reports say the Income-tax Rules, 2026 (reportedly Notification 22/2026, Rules 161–162) replaced Rule 114B's ">₹50,000 cash in one day" test with an annual ₹10 lakh aggregate. Not confirmed against the official notification. | Check incometaxindia.gov.in. If it's confirmed, keep the rule (₹49k deposits are still a classic structuring pattern) but call it "the long-standing ₹50,000 PAN threshold". |
| D2 | **STR deadline wording.** FIU-IND says "7 working days", RBI circulars for banks say "7 days", both counted from the Principal Officer establishing suspicion. | Say "within 7 days of establishing suspicion". That's true under both. |
| D3 | **How to report IBM.** The rules alone get 0.9–1.7× lift on IBM, while the classifier retrained on IBM history gets 7.7×. | Lead with 7.7×, and explain the rules' gap (README → FAQ). Never present the rules-only number as a win. |

## 3. Later
- **IBM-tuned rule profile:** multi-hour pass-through windows and low-degree cycle and gather-scatter detection, then rerun `eval_ibm.py --ai`.
- **Full IBM file:** needs at least 8 GB of free RAM (2.5M of 5M rows were run so far).
- **Small fixes:** "3 alert(s)" wording; node module-type warning in `flow.check.mjs`.
- **Production gaps:** no database (cases are lost on restart), no named users or roles, synthetic training data.
