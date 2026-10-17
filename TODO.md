# MuleTrace: What's Left Before the Demo

Written 17 Oct 2026 (evening). **Demo day is 18 Oct.** Everything that needs no sign-in is done (see the end of this file). What remains needs someone's account, a team decision, or rehearsal time.

**Rule for tonight:** no new features. Every item below either makes the demo work in the room or keeps the pitch honest.

---

## 1. Needs access (someone's sign-in or licence)

Ordered by how much the demo loses without it. Each has a fallback, so none of them can sink the demo.

| # | Task | Access needed | Time | If it isn't done |
|---|---|---|---|---|
| 1 | **Copilot Studio agent** live and embedded | A **work or school Microsoft account** (Entra ID) with Copilot Studio (trial is fine; personal accounts such as Gmail or Outlook.com usually can't sign up), plus a Microsoft account for **Dev Tunnels** | 1–1.5 h | The Evidence tab's **Ask** buttons answer the same questions from the same endpoints. Skip the "Ask Copilot" beat. |
| 2 | **Power Automate** playbook (Teams card, Planner, Outlook on Dismantle) | The same work account with **Power Automate Premium** or a trial (the HTTP trigger is a premium connector), plus **Teams** and **Planner** in that tenant | 45 min | The Log tab says "not configured". Show the case audit trail in **Cases** instead. |
| 3 | **Foundry endpoint** for the classifier | An **Azure subscription** with credit, permission to create a hub-based Foundry project, and VM quota for `Standard_DS2_v2` | 30 min of setup + 10–15 min deploy | The local model is used and the panels say so. Don't claim it runs in Foundry. |
| 4 | **Power BI** report (optional) | Power BI Desktop (free); publishing needs a Power BI account | 30 min | Skip it. It's not in the 5-minute demo. |
| 5 | **Push this work to GitHub** | Push rights on `joelwalice/MuleTrace` (owner or collaborator) and a signed-in `gh` or git credential | 5 min | The work exists only on this laptop. |

### 1.1 Copilot Studio agent (step by step, Windows)
Full guide: `microsoft/README.md` §1–2. Its install commands are for macOS; on Windows use the ones below.
1. **Install and sign in to Dev Tunnels** (sign-in opens the browser, so do it yourself):
   ```
   winget install Microsoft.devtunnel
   devtunnel user login
   devtunnel host -p 8000 --allow-anonymous      # keep this window open; copy the https://…devtunnels.ms URL
   ```
2. **Restart the API with that URL**, so the Copilot spec points at it:
   ```
   $env:PUBLIC_URL='https://<id>-8000.<region>.devtunnels.ms'; $env:PYTHONUTF8='1'
   .\.venv\Scripts\python.exe -m uvicorn app:app --host 0.0.0.0 --port 8000
   ```
   Check that `<tunnel>/copilot/openapi.json` lists the tunnel URL under `servers`.
3. **Build the agent** at copilotstudio.microsoft.com:
   - Instructions: paste `microsoft/agent-instructions.md`. **It was updated today** for the IBM numbers, so paste the new version.
   - Orchestration: Generative. Turn general knowledge and web search **off**.
   - Tools: REST API → upload the spec, Authentication **None**, all 14 tools. On **dismantleRing**, require confirmation.
4. **Test** after launching attacks 1–3: "Why is AL-101 suspicious?", "Draft the STR for NET-1", "How accurate is it?" (it should lead with 7.7× vs 1.7×), "Dismantle NET-1" (it must ask first).
5. **Publish** with No authentication, copy the Web app iframe `src`, and put it in `web/.env.local` as `NEXT_PUBLIC_COPILOT_URL=…`. Then **rebuild** (`demo-lan.ps1`, without `-SkipBuild`), because the URL is baked in at build time.
- **The dev tunnel URL changes** each time unless you create a persistent tunnel (`devtunnel create`, then `devtunnel port create -p 8000`, then `devtunnel host <name>`). Do that, or the agent's tools break after a restart.

### 1.2 Power Automate
Full guide: `README.md` → "Power Automate" and `microsoft/README.md` §3.
- Flow: **When an HTTP request is received** (Who can trigger: **Anyone**) → Teams card (`microsoft/teams-card.json`) → Planner task due in 7 days → Outlook email with the STR draft.
- Start the API with `$env:PLAYBOOK_WEBHOOK='<trigger URL>'` in the same window as the other variables. **Never commit this URL**; it contains a key.
- Test: launch an attack → **Dismantle** → the Log tab should say `sent (202)`, and the card appears in Teams.

### 1.3 Foundry
Full guide: `foundry/README.md`. On Windows: `winget install Microsoft.AzureCLI`, then `az login`, then
`python -m venv .venv-azure; .\.venv-azure\Scripts\pip install azure-ai-ml azure-identity`, then `deploy.py`.
- The model file is fixed (it was unreadable on Windows before today), so deploy from this laptop or after pulling the fix.
- **Delete the endpoint after the demo.** It bills by the hour.

---

## 2. Team decisions (no access needed, but someone has to choose)

| # | Decision | Recommendation |
|---|---|---|
| D1 | **The ₹50,000 PAN rule may be out of date.** News reports say the Income-tax Rules, 2026 (from 1 April 2026; reportedly Notification 22/2026, Rules 161–162) replaced Rule 114B's ">₹50,000 cash in one day" test with an annual ₹10 lakh aggregate. Not confirmed against the official notification. | Check incometaxindia.gov.in tonight. If it's confirmed, keep the rule (₹49k deposits are still a classic structuring pattern) but say "the long-standing ₹50,000 PAN threshold" on slides. Don't change code the night before. |
| D2 | **STR deadline wording.** FIU-IND says "7 working days", RBI circulars for banks say "7 days", both counted from the Principal Officer establishing suspicion. | Say "within 7 days of establishing suspicion". That's true under both. |
| D3 | **How to present IBM.** The rules alone get 0.9–1.7× lift on IBM, while the classifier retrained on IBM history gets 7.7×. | Lead with 7.7×, and when asked, explain the rules' gap (README → Judge Q&A). Never show the rules-only number as a win. |
| D4 | **Dev tunnel or Azure App Service** for the public API URL | A persistent dev tunnel. App Service is more work tonight. |
| D5 | **Venue Wi-Fi** for judge phones | Use the laptop's own hotspot. Venue Wi-Fi often blocks device-to-device traffic. |

---

## 3. Rehearsal and demo-day checklist (no access needed)

**Tonight**
- [ ] Run `demo-lan.ps1`, open `/send` on a **real phone** and send a Structuring pattern. Allow the firewall prompt (Private). This step can't be tested from the laptop alone.
- [ ] Rehearse the 5-minute script (`README.md` → Demo flow) **3 times** with a timer, on the projector resolution and a phone.
- [ ] Record a **backup video** of the full flow, in case Wi-Fi or a projector fails.
- [ ] **5-slide deck:** problem → live demo → explainable AI → Microsoft stack → honest numbers (14 alerts → 3 rings; IBM 7.7× vs 1.7×).
- [ ] Each presenter reads `README.md` → "Claims you can defend" and "Judge Q&A".

**Demo morning (15 minutes before)**
- [ ] Laptop on charge, sleep off, notifications off, browser zoom 100%.
- [ ] Hotspot on; phones connected to it.
- [ ] `demo-lan.ps1 -SkipBuild` running (or the full build if anything changed). Dev tunnel window open if the Copilot is used.
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

## Done on 17 Oct (evening)
- IBM AML benchmark run. `eval_ibm.py --ai` trains and tests the classifier on IBM data, and `data/eval.json` is updated.
- Accuracy card leads with the classifier's 7.7× lift, with the rules' 1.7× beside it.
- Fixed: AI model unreadable on Windows (CRLF). `.gitattributes` plus a tolerant `xai.load()`.
- Copilot instructions updated for the IBM result.
- `demo-lan.ps1`: one command for judge phones over Wi-Fi. Tested through the LAN address from the laptop.
- Root `.gitignore`; `.pyc` files untracked; README, `context.md` (item 16) and `plan.md` updated.
- All checks pass: `muletrace.py`, `xai.py`, `flow.check.mjs`, `npm run build`.
