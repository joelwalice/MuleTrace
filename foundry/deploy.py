"""Deploy the explainable mule classifier to a Microsoft Foundry project as a managed online endpoint.

    az login
    pip install azure-ai-ml azure-identity
    python foundry/deploy.py --subscription <id> --resource-group <rg> --workspace <foundry-hub-project-or-aml-workspace>

Registers model/ (LightGBM + model card), builds an environment from foundry/conda.yaml, creates a key-auth
endpoint and a deployment running foundry/score.py, then prints the scoring URL. Re-running updates in place."""
import argparse
import shutil
import tempfile
from pathlib import Path

from azure.ai.ml import MLClient
from azure.ai.ml.entities import CodeConfiguration, Environment, ManagedOnlineDeployment, ManagedOnlineEndpoint, Model
from azure.identity import DefaultAzureCredential

ROOT = Path(__file__).resolve().parent.parent

ap = argparse.ArgumentParser()
ap.add_argument("--subscription", required=True)
ap.add_argument("--resource-group", required=True)
ap.add_argument("--workspace", required=True, help="Foundry hub-based project name, or an Azure ML workspace")
ap.add_argument("--endpoint", default="muletrace-xai", help="globally unique within the Azure region")
ap.add_argument("--sku", default="Standard_DS2_v2", help="VM size; DS2_v2 is the smallest that fits comfortably")
args = ap.parse_args()

ml = MLClient(DefaultAzureCredential(), args.subscription, args.resource_group, args.workspace)
model = ml.models.create_or_update(Model(path=str(ROOT / "model"), name="mule-classifier", type="custom_model",
                                         description="Explainable LightGBM mule-account classifier (TreeSHAP reasons)"))
env = ml.environments.create_or_update(Environment(name="mule-xai-env", conda_file=str(ROOT / "foundry" / "conda.yaml"),
                                                   image="mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu22.04:latest"))
print(f"model {model.name}:{model.version}, environment {env.name}:{env.version}")

ml.online_endpoints.begin_create_or_update(ManagedOnlineEndpoint(name=args.endpoint, auth_mode="key",
                                                                 description="MuleTrace explainable AI")).result()
with tempfile.TemporaryDirectory() as code:  # only what the scorer needs: score.py + xai.py
    for f in (ROOT / "foundry" / "score.py", ROOT / "xai.py"):
        shutil.copy(f, code)
    ml.online_deployments.begin_create_or_update(ManagedOnlineDeployment(
        name="blue", endpoint_name=args.endpoint, model=model, environment=env, instance_type=args.sku, instance_count=1,
        code_configuration=CodeConfiguration(code=code, scoring_script="score.py"))).result()
ep = ml.online_endpoints.get(args.endpoint)
ep.traffic = {"blue": 100}
ml.online_endpoints.begin_create_or_update(ep).result()
print(f"\nScoring URL: {ep.scoring_uri}")
print("Key: Foundry portal → your project → Models + endpoints → muletrace-xai → Consume (or `az ml online-endpoint get-credentials`).")
print("Then start the API with:\n  FOUNDRY_SCORING_URL='<scoring url>' FOUNDRY_KEY='<key>' .venv/bin/uvicorn app:app --reload")
