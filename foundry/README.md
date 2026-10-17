# Explainable AI on Microsoft Foundry

MuleTrace's classifier is a **LightGBM** model. It scores how mule-like an account's behaviour is, and explains every score with **exact SHAP contributions**: how much each behaviour pushed the score up or down. Those contributions add up exactly to the model's output, so the explanation *is* the model, not a story about it. Monotone constraints keep explanations sensible: forwarding money faster can never make an account look safer.

The model runs inside the API by default. This folder deploys the same model to a **Microsoft Foundry managed online endpoint**, and the API then scores through Foundry. If the endpoint is unreachable, it falls back to the local copy and says so on screen.

| File | What it is |
|---|---|
| `../xai.py` | Features, training data, model, explanations, and a self-check (`python3 xai.py train`, `python3 xai.py`) |
| `../model/` | The trained model (`mule_classifier.txt`) and its model card (`card.json`) |
| `score.py` | The endpoint's scoring script. It reuses `xai.explain`, so both paths return identical answers |
| `conda.yaml` | The endpoint environment (Python 3.11, LightGBM 4.7, Azure ML inference server) |
| `deploy.py` | Registers the model and environment, and creates the endpoint and deployment |

## Deploy

1. **In Foundry** (https://ai.azure.com), create a **hub-based project**. Custom-model endpoints need a hub, because they run on Azure Machine Learning compute. An existing Azure ML workspace also works. Note the subscription ID, resource group and project name.
2. **Sign in and install the SDK.** Do this yourself; it opens a browser:
   ```
   brew install azure-cli && az login
   python3 -m venv .venv-azure && .venv-azure/bin/pip install azure-ai-ml azure-identity
   ```
3. **Deploy.** It takes about 10–15 minutes, mostly building the container:
   ```
   .venv-azure/bin/python foundry/deploy.py --subscription <id> --resource-group <rg> --workspace <project>
   ```
   - The VM defaults to `Standard_DS2_v2`, which bills while the endpoint exists. **Delete the endpoint after the demo.**
   - If your subscription has no quota for that size, request quota or pass `--sku` with a size you have.
4. **Get the key:** Foundry → your project → **Models + endpoints** → `muletrace-xai` → **Consume**.
5. **Point the API at Foundry:**
   ```
   FOUNDRY_SCORING_URL='https://muletrace-xai.<region>.inference.ml.azure.com/score' FOUNDRY_KEY='<key>' .venv/bin/uvicorn app:app --reload
   ```
   The dashboard's AI panels then say **"Scored live by the Microsoft Foundry endpoint"**, and `GET /ai/model` reports `serving: Microsoft Foundry endpoint`.

## Test the endpoint directly

```
curl -s $FOUNDRY_SCORING_URL -H "Authorization: Bearer $FOUNDRY_KEY" -H 'content-type: application/json' \
  -d '{"rows": [[0.95, 0.92, 14, 1, 1, 0, 0, 800, 800, 0.6, 2, 9.2]]}'
```

The 12 values follow `xai.NAMES`, in order: passthrough ratio, fast-forward share, minutes to first forward, max senders per hour, max receivers per hour, near-threshold deposits, cash share, dormancy days, account age, KYC risk, shared-device accounts, and volume vs expected. Use `null` for an unknown value. The response gives the probability plus `reasons[]`, each with `text` and `contribution`.

## What to say to judges

- **What it does:** "The rules say *which* pattern fired. The classifier says how mule-like the *whole account* looks, and why, using exact SHAP values from the model itself."
- **What it adds:** "It complements the rules. In the demo it flags ring sources and exits that no rule alerted, and it scores the rules' false alarms on ordinary customers low."
- **Honesty:** "It's trained on synthetic banks that include legitimate look-alikes: payroll, merchants, cash shops and one-off big transfers. On a bank it never saw, AUC is about 0.96 and it flags about 1.6% of ordinary customers. Real deployment means retraining on the bank's labelled cases."
