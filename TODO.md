# MuleTrace: What's Left Before the Demo

Written 17 Oct 2026 (evening), updated 18 Oct (demo day). Copilot Studio and Power Automate are now live (see the end of this file). What remains is optional Microsoft pieces, team decisions and rehearsal.

**Rule for today:** no new features. Every item below either makes the demo work in the room or keeps the pitch honest.

---

## 1. Needs access (someone's sign-in or licence)

The hackathon lab tenant provides Azure credits ($200), M365 E7, Power Platform, Copilot Studio and GitHub Copilot licences. Each item has a fallback, so none of them can sink the demo.

| # | Task | Status | If it isn't done |
|---|---|---|---|
| 1 | **Copilot Studio agent** live and embedded | ✅ Done 18 Oct (MCP tools, Demo website embed, Teams channel) | The Evidence tab's **Ask** buttons answer the same questions. |
| 2 | **Power Automate** playbook on Dismantle | ✅ Done 18 Oct (Outlook email with the STR draft; the lab user has no Teams) | The Log tab says "not configured". Show **Cases** instead. |
| 3 | **Foundry endpoint** for the classifier | Open, optional. Azure credit is available; about 30 min setup + 10–15 min deploy | The local model is used and the panels say so. Don't claim it runs in Foundry. |
| 4 | **Power BI** report | Open, optional. Power BI Desktop is Windows-only; use the Power BI service on a Mac | Skip it. It's not in the 5-minute demo. |
| 5 | **Push this work to GitHub** | 17 Oct work merged (PR #2); 18 Oct changes still to push | The work exists only on this laptop. |

### 1.1 Keeping Copilot and Power Automate working on demo day
Setup steps: `microsoft/README.md` §1–3. What they depend on:
- **The dev tunnel** `muletrace` must be hosted (its URL is fixed: `PUBLIC_URL` in `.demo.env`). If it stops, the agent's tools fail.
- **The webhook URL** must reach the API (`PLAYBOOK_WEBHOOK` in `.demo.env`). Without it, Dismantle says "not configured".
- **One command does both:** `./demo-mac.sh` (or `--skip-build` when nothing changed). It also builds the dashboard with the Copilot embed URL from `web/.env.local`.
- **Check before going on:** Ask Copilot → "List the mule rings" answers; Dismantle a test ring → Log says `sent (202)` and the email arrives. Then **New Bank**.
- **Lab tenant facts:** the agent lives in the default environment "Sandbox Labs - 100036" (Dataverse added, user is System Administrator). The agent's authentication is off and the MCP tool uses the maker's connection, so the embed needs no sign-in.

### 1.3 Foundry
Full guide: `foundry/README.md`. On the Mac, `az` is already installed: `az login`, then
`python3 -m venv .venv-azure && .venv-azure/bin/pip install azure-ai-ml azure-identity`, then `deploy.py`. Add `FOUNDRY_SCORING_URL` and `FOUNDRY_KEY` to `.demo.env`.
- The model file is fixed (it was unreadable on Windows before today), so deploy from this laptop or after pulling the fix.
- **Delete the endpoint after the demo.** It bills by the hour.

---

## 2. Team decisions (no access needed, but someone has to choose)

| # | Decision | Recommendation |
|---|---|---|
| D1 | **The ₹50,000 PAN rule may be out of date.** News reports say the Income-tax Rules, 2026 (from 1 April 2026; reportedly Notification 22/2026, Rules 161–162) replaced Rule 114B's ">₹50,000 cash in one day" test with an annual ₹10 lakh aggregate. Not confirmed against the official notification. | Check incometaxindia.gov.in tonight. If it's confirmed, keep the rule (₹49k deposits are still a classic structuring pattern) but say "the long-standing ₹50,000 PAN threshold" on slides. Don't change code the night before. |
| D2 | **STR deadline wording.** FIU-IND says "7 working days", RBI circulars for banks say "7 days", both counted from the Principal Officer establishing suspicion. | Say "within 7 days of establishing suspicion". That's true under both. |
| D3 | **How to present IBM.** The rules alone get 0.9–1.7× lift on IBM, while the classifier retrained on IBM history gets 7.7×. | Lead with 7.7×, and when asked, explain the rules' gap (README → Judge Q&A). Never show the rules-only number as a win. |
| D4 | **Dev tunnel or Azure App Service** for the public API URL | ✅ Decided: persistent dev tunnel `muletrace`. |
| D5 | **Venue Wi-Fi** for judge phones | Use the laptop's own hotspot. Venue Wi-Fi often blocks device-to-device traffic. |

---

## 3. Rehearsal and demo-day checklist (no access needed)

**Tonight**
- [ ] Run `./demo-mac.sh`, open `/send` on a **real phone** and send a Structuring pattern. Allow the incoming-connections prompt. This step can't be tested from the laptop alone.
- [ ] Rehearse the 5-minute script (`README.md` → Demo flow) **3 times** with a timer, on the projector resolution and a phone.
- [ ] Record a **backup video** of the full flow, in case Wi-Fi or a projector fails.
- [ ] **5-slide deck:** problem → live demo → explainable AI → Microsoft stack (Copilot Studio agent over MCP, Power Automate playbook, Foundry if deployed) → honest numbers (14 alerts → 3 rings; IBM 7.7× vs 1.7×).
- [ ] Each presenter reads `README.md` → "Claims you can defend" and "Judge Q&A".

**Guardrails (18 Oct, before judging; see `AUDIT.md`)**
- [ ] Copilot Studio → the MCP tool → refresh tools: `proposeDismantle` appears, `dismantleRing` is gone. Paste the new `microsoft/agent-instructions.md` (rules 6, 11, 12) and publish.
- [ ] Through the real tunnel: `curl -X POST $PUBLIC_URL/live/reset` returns 403, and Ask Copilot "List the mule rings" still answers.
- [ ] Rehearse the new step: "Dismantle NET-x" → Awaiting your approval → Review & Approve.
- [ ] `python3 check_guardrails.py` → 31/31.

**Demo morning (15 minutes before)**
- [ ] Laptop on charge, sleep off, notifications off, browser zoom 100%.
- [ ] Hotspot on; phones connected to it.
- [ ] `./demo-mac.sh --skip-build` running (or the full build if anything changed). It hosts the dev tunnel and passes the webhook.
- [ ] Ask Copilot answers "List the mule rings"; a test Dismantle logs `sent (202)` and the email arrives.
- [ ] Dashboard: **More → New Bank**, clock **30×**, **Autopilot off**, Accuracy card showing **7.7×**.
- [ ] **More → Judge Phone QR Code** shows the LAN address, not `localhost`.
- [ ] One test attack, then **New Bank** again so the demo starts clean.
- [ ] Backup video open in another tab.

---

## 4. Only if everything above is done (otherwise after the hackathon)
- **IBM-tuned rule profile:** multi-hour pass-through windows and low-degree cycle and gather-scatter detection, then rerun `eval_ibm.py --ai`.
- **Full IBM file:** needs at least 8 GB of free RAM (this laptop had 2.9 GB, so it ran 2.5M of 5M rows).
- **Small fixes:** "3 alert(s)" wording; node module-type warning in `flow.check.mjs`.
- **Production gaps** (say so if asked): no database (cases are lost on restart), no API auth, synthetic training data.

---

## Done on 18 Oct
- **Copilot Studio agent live and embedded** (item 1). Persistent dev tunnel `muletrace`. Tools connect through the new `/mcp` endpoint, because Copilot Studio's new layout has no REST API tool; `microsoft/README.md` §2 is updated. Instructions now forbid treating a repeated request as approval. Tested: citations, confidence, ask-before-dismantle, end-user view.
- **Power Automate playbook** (item 2). HTTP trigger → Outlook email with the case, frozen/review accounts and the STR draft. Teams isn't available to the lab user, so the playbook uses email. Tested: Dismantle → `sent (202)` → email received.
- `demo-mac.sh`: one command on the Mac for the dev tunnel, the API (with the webhook) and the LAN build. Secrets go in the git-ignored `.demo.env`.
- Ring STR draft: "Grounds for suspicion" now lists only the patterns that fired (it was fixed text naming every pattern).

## Done on 17 Oct (evening)
- IBM AML benchmark run. `eval_ibm.py --ai` trains and tests the classifier on IBM data, and `data/eval.json` is updated.
- Accuracy card leads with the classifier's 7.7× lift, with the rules' 1.7× beside it.
- Fixed: AI model unreadable on Windows (CRLF). `.gitattributes` plus a tolerant `xai.load()`.
- Copilot instructions updated for the IBM result.
- `demo-lan.ps1`: one command for judge phones over Wi-Fi. Tested through the LAN address from the laptop.
- Root `.gitignore`; `.pyc` files untracked; README, `context.md` (item 16) and `plan.md` updated.
- All checks pass: `muletrace.py`, `xai.py`, `flow.check.mjs`, `npm run build`.
