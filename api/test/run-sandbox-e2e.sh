#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end paywall test: this Worker on localhost (wrangler dev, throwaway D1/KV)
# against Square SANDBOX — signup, invites, credits, premium, declined card,
# duplicate webhooks, foreign/underpaid payments, refunds. No real money moves;
# webhooks are signed locally with a throwaway key. Run before any deploy and
# before switching SQUARE_ENV to production.
#
# Needs SQUARE_SANDBOX_ACCESS_TOKEN in ~/.nemoclaw/credentials.json (or the env).
set -euo pipefail
cd "$(dirname "$0")/.."
E2E_DIR=$(mktemp -d "${TMPDIR:-/tmp}/supachad-e2e.XXXXXX")
export E2E_DIR
PORT=8799
trap 'kill "${DEV_PID:-}" 2>/dev/null || true; rm -rf "$E2E_DIR"' EXIT

python3 - "$E2E_DIR/dev.vars" "$PORT" <<'PY'
import json, os, secrets, sys
tok = os.environ.get("SQUARE_SANDBOX_ACCESS_TOKEN")
if not tok:
    tok = json.load(open(os.path.expanduser("~/.nemoclaw/credentials.json")))["SQUARE_SANDBOX_ACCESS_TOKEN"]
with open(sys.argv[1], "w") as fh:
    fh.write(f"ADMIN_SECRET=test-{secrets.token_hex(16)}\nSQUARE_ACCESS_TOKEN={tok}\n"
             f"SQUARE_WEBHOOK_SIGNATURE_KEY=localtest-{secrets.token_hex(16)}\n"
             f"SQUARE_WEBHOOK_URL=http://127.0.0.1:{sys.argv[2]}/api/square/webhook\n")
os.chmod(sys.argv[1], 0o600)
PY

npx wrangler d1 migrations apply supachad --local --persist-to "$E2E_DIR/state" >/dev/null
npx wrangler dev --local --ip 127.0.0.1 --port "$PORT" --env-file "$E2E_DIR/dev.vars" \
  --persist-to "$E2E_DIR/state" >"$E2E_DIR/dev.log" 2>&1 &
DEV_PID=$!
for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/api/x" && break
  sleep 1
done
python3 -I test/sandbox_e2e.py
