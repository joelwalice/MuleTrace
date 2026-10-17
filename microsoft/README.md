# Microsoft wiring

This sets up four Microsoft pieces around the MuleTrace API:
- a **Copilot Studio** agent that investigates through the API
- the agent in **Teams**
- **Power Automate** to act when a ring is dismantled
- **Power BI** on the live tables

The rules stay in the API. The agent only calls tools and quotes their answers.

| Piece | Uses | File here |
|---|---|---|
| Public HTTPS URL for the API | Microsoft Dev Tunnels (or Azure App Service) | none |
| Investigator agent | Copilot Studio, REST API tools | `agent-instructions.md` |
| Agent in chat | Teams + Microsoft 365 Copilot channel, and the dashboard's **Ask Copilot** sheet | none |
| Dismantle playbook | Power Automate → Teams card, Planner, Outlook | `teams-card.json` |
| Reporting | Power BI Desktop / Service on `/export/*.csv` | none |

## 1. Give the API a public URL

Copilot Studio and the Power BI service call the API from Microsoft's cloud, so `localhost` won't do.

**Dev Tunnels** (quickest; it's free and uses your Microsoft account):
```
brew install --cask devtunnel
devtunnel user login                              # opens the browser; sign in yourself
devtunnel host -p 8000 --allow-anonymous          # prints https://<id>-8000.<region>.devtunnels.ms
```
Restart the API so the Copilot spec carries the tunnel URL. Keep the tunnel window open during the demo.
```
PUBLIC_URL=https://<id>-8000.<region>.devtunnels.ms .venv/bin/uvicorn app:app --reload
```
Check: open `https://<id>-8000…/copilot/openapi.json`. Its `servers` entry should be the tunnel URL.

**Azure App Service** (survives the laptop sleeping):
- Python 3.12+ web app, single worker. Startup command: `uvicorn app:app --host 0.0.0.0`.
- App settings: `PUBLIC_URL`, `CORS_ORIGINS`, `PLAYBOOK_WEBHOOK`.

## 2. Copilot Studio agent

1. **Create the agent:** go to https://copilotstudio.microsoft.com → **Create** → **New agent** → **Skip to configure**.
   - **Name:** `MuleTrace Investigator`
   - **Description:** `Explains mule-ring alerts with cited transactions and drafts FIU-IND STRs.`
   - **Instructions:** paste all of `agent-instructions.md`.
2. **Ground it:** go to **Settings → Generative AI**.
   - Set orchestration to **Generative**.
   - Under **Knowledge**, turn off **Use general knowledge** and **Web search**. The agent then answers only from the tools.
3. **Add the tools:** **Tools → Add a tool → New tool → REST API**.
   - Upload `copilot-openapi.json`. Download it first with `curl -o copilot-openapi.json $PUBLIC_URL/copilot/openapi.json`.
   - **Authentication:** None.
   - Select all 14 tools → **Add**. The tool names (`explainAlert`, `traceRingMoney`, …) and descriptions come from the API.
   - Open **dismantleRing** and turn on **Ask the user before running** (wording may vary by version). That makes the approval step real.
4. **Test** in the test pane, after launching the 3 attacks on the dashboard:
   - "Why is AL-101 suspicious?" should come back with `[TX…]` citations, "Confidence: high" and a gaps list.
   - "Why are AC0509 and AC0510 connected?"
   - "What if pass-through is 60%?" should report the replay, with no live change.
   - "Draft the STR for NET-1" should return the draft plus the missing checklist items.
   - "Dismantle NET-1" should ask first, then call the tool. The Power Automate flow fires.
5. **Publish:** **Publish**, then **Settings → Security → Authentication → No authentication**, then publish again. The web embed needs no sign-in.
6. **Embed it in the dashboard:**
   - Go to **Channels → Web app** and copy the `src` of the iframe code.
   - Put it in `web/.env.local`: `NEXT_PUBLIC_COPILOT_URL=https://copilotstudio.microsoft.com/environments/…/webchat?__version__=2`
   - Restart `npm run dev`. **Ask Copilot** now appears in the header, with one-tap prompts for whatever ring is selected.
7. **Add it to Teams:** **Channels → Teams and Microsoft 365 Copilot → Add channel → See agent in Teams**. Pin it in the team channel the Power Automate card posts to. Analysts can then ask about the ring right under its alert card.

**If the venue network blocks the web chat:** the dashboard's **Evidence** tab gives the same answers from the same endpoints, so the demo still works.

## 3. Power Automate playbook

Start from the flow in the main README (trigger **When an HTTP request is received**, using the schema there). Then:
1. **Variable:** add **Initialize variable** → `dashboardUrl` (String) = your dashboard URL, e.g. `http://localhost:3000`.
2. **Teams card:** replace the Teams "post message" step with **Post card in a chat or channel** (Post as: Flow bot). Paste `teams-card.json` as the card. The `@{…}` expressions resolve from the trigger.
3. **Approval (optional):** before Planner, add **Start and wait for an approval** (Approve/Reject), assigned to the team lead. Create the Planner task only if `outcome` is `Approve`.
4. **Planner:** task due `@{addDays(utcNow(), 7)}`, titled `STR due: @{triggerBody()?['network_id']}`.
5. **Outlook:** email with body `@{triggerBody()?['str_draft']}`.
6. **Connect it:** save, copy the trigger URL, and start the API with `PLAYBOOK_WEBHOOK='…'`. Keep the single quotes, because the URL contains `&`. Never commit it.

## 4. Power BI

The live bank is served as CSV at `/export/{accounts|transactions|alerts|networks}.csv`.

1. **Load the tables:** Power BI Desktop → **Get data → Web** → `$PUBLIC_URL/export/alerts.csv`, with anonymous access. Repeat for `networks`, `transactions` and `accounts`. Locally, `http://localhost:8000/export/…` works the same way.
2. **Relationships:**
   - `alerts[network_id]` → `networks[network_id]`
   - `alerts[account_id]` → `accounts[account_id]`
   - `transactions[sender_account]` → `accounts[account_id]`, inactive; activate it in DAX when needed.
3. **Visuals that tell the story:**
   - a **card pair**, alert count → ring count (the pitch number)
   - a **bar** of money into each ring, from `networks[total_in]` by `network_id`
   - a **table** of rings with status (open / dismantled)
   - a **line** of transactions per hour
4. **Benchmark:** **Get data → Web** → `$PUBLIC_URL/evaluation`. It's JSON: convert it to a table and put precision, recall and lift on cards.
5. **Publish:** publish to the Power BI service. With an anonymous tunnel URL, scheduled refresh works without a gateway.
