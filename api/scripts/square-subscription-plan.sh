#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Create (or find) the "Chad Premium" monthly subscription plan in Square's
# catalog and print its plan VARIATION id — the value for the Worker var
# SQUARE_SUBSCRIPTION_PLAN_ID (wrangler.toml). Idempotent: an existing plan
# with the same name and price is reused.
#
# Usage: square-subscription-plan.sh sandbox|production [amount_cents] [currency]
#   Token: SQUARE_<ENV>_ACCESS_TOKEN from the env or ~/.nemoclaw/credentials.json.
set -euo pipefail
ENV="${1:?usage: $0 sandbox|production [amount_cents] [currency]}"
AMOUNT="${2:-1500}"
CURRENCY="${3:-CAD}"
NAME="Chad Premium"
case "$ENV" in
  sandbox) BASE=https://connect.squareupsandbox.com ;;
  production) BASE=https://connect.squareup.com ;;
  *) echo "env must be sandbox or production" >&2; exit 2 ;;
esac
VAR="SQUARE_$(printf '%s' "$ENV" | tr '[:lower:]' '[:upper:]')_ACCESS_TOKEN"
TOKEN="${!VAR:-}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(python3 -c "import json,os,sys;print(json.load(open(os.path.expanduser('~/.nemoclaw/credentials.json')))[sys.argv[1]])" "$VAR")
fi

BASE="$BASE" TOKEN="$TOKEN" AMOUNT="$AMOUNT" CURRENCY="$CURRENCY" NAME="$NAME" python3 - <<'PY'
import json, os, sys, urllib.request, uuid

base, tok = os.environ["BASE"], os.environ["TOKEN"]
amount, cur, name = int(os.environ["AMOUNT"]), os.environ["CURRENCY"], os.environ["NAME"]


def call(method, path, body=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Authorization": f"Bearer {tok}", "Square-Version": "2025-01-23",
                                          "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit(f"Square {method} {path}: {e.code} {e.read().decode()[:400]}")


found = call("POST", "/v2/catalog/search", {"object_types": ["SUBSCRIPTION_PLAN"], "include_related_objects": True})
for plan in found.get("objects", []):
    if plan["subscription_plan_data"].get("name") != name:
        continue
    for v in found.get("related_objects", []) + plan["subscription_plan_data"].get("subscription_plan_variations", []):
        if v.get("type") != "SUBSCRIPTION_PLAN_VARIATION":
            continue
        d = v["subscription_plan_variation_data"]
        if d.get("subscription_plan_id") != plan["id"]:
            continue
        ph = d["phases"][0]
        price = ph.get("pricing", {}).get("price_money") or ph.get("recurring_price_money") or {}
        if ph.get("cadence") == "MONTHLY" and price.get("amount") == amount and price.get("currency") == cur:
            print(v["id"])
            sys.exit(0)

plan = call("POST", "/v2/catalog/object", {"idempotency_key": str(uuid.uuid4()), "object": {
    "type": "SUBSCRIPTION_PLAN", "id": "#plan", "subscription_plan_data": {"name": name}}})["catalog_object"]
var = call("POST", "/v2/catalog/object", {"idempotency_key": str(uuid.uuid4()), "object": {
    "type": "SUBSCRIPTION_PLAN_VARIATION", "id": "#variation", "subscription_plan_variation_data": {
        "name": f"{name} — monthly", "subscription_plan_id": plan["id"],
        "phases": [{"cadence": "MONTHLY", "ordinal": 0,
                    "pricing": {"type": "STATIC", "price_money": {"amount": amount, "currency": cur}}}]}}})["catalog_object"]
print(var["id"])
PY
