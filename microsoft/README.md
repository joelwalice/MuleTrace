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
| Investigator agent | Copilot Studio, MCP tools from `/mcp` (or REST API tools from `/copilot/openapi.json`) | `agent-instructions.md` |
| Agent in chat | Demo website embed in the dashboard's **Ask Copilot** sheet, and the Teams + Microsoft 365 channel | none |
| Dismantle playbook | Power Automate → Outlook email with the STR draft (Teams card and Planner where the tenant has them) | `teams-card.json` |
| Reporting | Power BI Desktop / Service on `/export/*.csv` | none |

## 1. Give the API a public URL

Copilot Studio and the Power BI service call the API from Microsoft's cloud, so `localhost` won't do.

**Dev Tunnels** (quickest; it's free and uses your Microsoft account):
```
brew install --cask devtunnel
devtunnel user login                              # opens the browser; sign in yourself
devtunnel create muletrace --allow-anonymous      # persistent: the URL survives restarts, so the agent's tools keep working
devtunnel port create muletrace -p 8000
devtunnel host muletrace                          # prints https://<id>-8000.<region>.devtunnels.ms
```
Restart the API with the tunnel URL. Keep the tunnel running during the demo (`demo-mac.sh` hosts it for you when `TUNNEL=muletrace` is in `.demo.env`).
```
PUBLIC_URL=https://<id>-8000.<region>.devtunnels.ms .venv/bin/uvicorn app:app --reload
```
Check: open `https://<id>-8000…/copilot/openapi.json`. Its `servers` entry should be the tunnel URL. The MCP endpoint is `https://<id>-8000…/mcp` (POST only; a browser GET returns 405).

**Azure App Service** (survives the laptop sleeping):
- Python 3.12+ web app, single worker. Startup command: `uvicorn app:app --host 0.0.0.0`.
- App settings: `PUBLIC_URL`, `CORS_ORIGINS`, `PLAYBOOK_WEBHOOK`.

## 2. Copilot Studio agent

1. **Create the agent:** go to https://copilotstudio.microsoft.com → **Agents → New agent** (→ **Skip to configure** if it opens a chat).
   - **Name:** `MuleTrace Investigator`
   - **Description:** `Explains mule-ring alerts with cited transactions and drafts FIU-IND STRs.`
   - **Instructions:** paste all of `agent-instructions.md`.
   - **Model:** Claude Opus 5.5 was tested. Its reasoning shows as a collapsed "Thought for N seconds" panel, separate from the answer.
2. **Ground it:** under **Knowledge**, remove **Search all websites**. In older layouts: **Settings → Generative AI**, orchestration **Generative**, and turn off **Use general knowledge** and **Web search**. The agent then answers only from the tools.
3. **Add the tools.** The newer Copilot Studio layout only offers **MCP** and **Workflow** under **Tools → + → Add**, so use the API's MCP endpoint:
   - **+ Add → Model Context Protocol (MCP)**. Server URL `$PUBLIC_URL/mcp`, Authentication **None** → **Create** → create the connection → **Add**.
   - All 17 tools appear (`explainAlert`, `traceRingMoney`, …), with names and descriptions from the API. `/mcp` forwards each call to the REST route, so answers match the dashboard.
   - Open the tool (**Edit tool**) and set **Authentication** to the maker's account instead of **End user account**. Otherwise the embedded chat shows "Connection Required" to every viewer.
   - MCP has no per-tool "ask before running" switch. Rule 6 in `agent-instructions.md` enforces the approval (tested: a repeated request doesn't count as a yes).
   - Older layouts with **New tool → REST API** can still upload `$PUBLIC_URL/copilot/openapi.json` instead.
   - **Lab tenants:** if Copilot Studio says Dataverse isn't set up, add Dataverse to the environment in the Power Platform admin center, and give your user the **System Administrator** role there.
4. **Test** in the test pane, after launching the 3 attacks on the dashboard:
   - "Why is AL-101 suspicious?" should come back with `[TX…]` citations, "Confidence: high" and a gaps list.
   - "Why are AC0509 and AC0510 connected?"
   - "What if pass-through is 60%?" should report the replay, with no live change.
   - "Draft the STR for NET-1" should return the draft plus the missing checklist items.
   - "Dismantle NET-1" should ask first, then call the tool. The Power Automate flow fires.
5. **Publish:** **Settings → Security → Authentication → No authentication**, then **Publish → Add channel → Demo website** (it's greyed out until authentication is off) → **Publish agent**. The web embed needs no sign-in.
6. **Embed it in the dashboard:**
   - Go to the **Demo website** channel → **Embed** and copy the `src` of the iframe code.
   - Put it in `web/.env.local`: `NEXT_PUBLIC_COPILOT_URL=https://copilotstudio.microsoft.com/environments/…/webchat?__version__=2`
   - Restart `npm run dev` (or rebuild with `demo-mac.sh`; the URL is baked in at build time). **Ask Copilot** now appears in the header, with one-tap prompts for whatever ring is selected.
   - "You don't have access to talk to this bot" means authentication is still on; "Connection Required" means the MCP tool is still set to **End user account** (step 3).
7. **Add it to Teams:** **Publish → Add channel → Teams + Microsoft 365**. Pin it in the team channel the Power Automate card posts to. Analysts can then ask about the ring right under its alert card.

**If the venue network blocks the web chat:** the dashboard's **Evidence** tab gives the same answers from the same endpoints, so the demo still works.

## 3. Power Automate playbook

Start from the flow in the main README (trigger **When an HTTP request is received**, using the schema there).
- **Schema:** paste it straight into **Request Body JSON Schema**. Pasted into **Use sample payload to generate schema**, it becomes a schema of the schema and the dynamic content (`case_id`, `summary`, …) disappears. Using the sample payload dialog with a real case JSON works too.

**What the demo uses (tested in the hackathon lab tenant):** one **Office 365 Outlook → Send an email (V2)** step, with the subject and HTML body from the main README. The lab user had no Teams, so the playbook emails instead. Dismantle → Log `sent (202)` → the email arrives within a minute with the case, frozen and review accounts, and the STR draft.

**Fuller playbook, where the tenant has Teams and Planner:**
1. **Variable:** add **Initialize variable** → `dashboardUrl` (String) = your dashboard URL, e.g. `http://localhost:3000`.
2. **Teams card:** **Post card in a chat or channel** (Post as: Flow bot). Paste `teams-card.json` as the card. The `@{…}` expressions resolve from the trigger.
3. **Approval (optional):** before Planner, add **Start and wait for an approval** (Approve/Reject), assigned to the team lead. Create the Planner task only if `outcome` is `Approve`.
4. **Planner:** task due `@{addDays(utcNow(), 7)}`, titled `STR due: @{triggerBody()?['network_id']}`.
5. **Outlook:** the email above.

**Connect it:** save, copy the trigger URL, and put it in `.demo.env` as `PLAYBOOK_WEBHOOK='…'` (or start the API with it). Keep the single quotes, because the URL contains `&`. Never commit it. **Run history** on the flow is a good on-stage fallback if mail is slow.

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
