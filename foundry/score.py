"""Scoring script for the Microsoft Foundry (Azure ML) managed online endpoint.
Request:  {"rows": [[one value per xai.FEATURES entry, in order, null = missing], ...]}
Response: [{"score", "raw", "base", "reasons": [...], "contributions": [...]}, ...]  (same as xai.explain)"""
import json
import math
import os
from pathlib import Path

import lightgbm as lgb

import xai  # copied next to this file at deploy time

booster = None


def init():
    global booster
    model_file = next(Path(os.environ.get("AZUREML_MODEL_DIR", ".")).rglob("mule_classifier.txt"))
    booster = lgb.Booster(model_file=str(model_file))


def run(raw_data):
    rows = json.loads(raw_data)["rows"]
    if not rows or any(len(r) != len(xai.FEATURES) for r in rows):
        return {"error": f"each row needs {len(xai.FEATURES)} values in this order: {xai.NAMES}"}
    return xai.explain(booster, [[math.nan if v is None else float(v) for v in r] for r in rows])
