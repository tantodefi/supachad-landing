#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Inspect or reset a TEST account across the whole funnel while Square is in sandbox.
#
#   test-account.py status <email>   signup status, tier, credits, premium window,
#                                    Access membership, queued grants
#   test-account.py reset  <email>   wipe it so the flow can be tested again:
#                                    KV signup/premium/welcomed/accessq, D1 credits +
#                                    payments, Cloudflare Access entry, and any ACTIVE
#                                    Square SANDBOX subscription for that email
#
# reset only accepts plus-alias addresses (you+anything@domain) so a real account
# can't be wiped by a typo, and refuses unless the Worker is on SQUARE_ENV=sandbox.
#
# Secrets come from ~/.nemoclaw/credentials.json: SUPACHAD_ADMIN_SECRET,
# CF_ACCESS_API_TOKEN, SQUARE_SANDBOX_ACCESS_TOKEN. KV/D1 go through wrangler
# (run from anywhere; it cds into api/).

import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

API_DIR = Path(__file__).resolve().parent.parent
CREDS = json.loads((Path.home() / ".nemoclaw/credentials.json").read_text())
SITE = "https://supachad.com"
KV_NS = "eef92b56e778469890d27a2769d33b24"
CF_ACCOUNT = "556b6b580ce9785aa058afa1a8eb17d1"
CF_APP = "0d94a423-45ee-40e1-8810-049204a9a4bc"
CF_POLICY = "93c1c04d-c1d2-4067-aa77-a1090b584c0d"
SQUARE = "https://connect.squareupsandbox.com"


def http(method, url, headers=None, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", "User-Agent": "supachad-test-account/1",
                                          **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"http_error": e.code}


def admin(path):
    return http("GET", SITE + path, {"X-Admin-Secret": CREDS["SUPACHAD_ADMIN_SECRET"]})


def wrangler(*args):
    r = subprocess.run(["npx", "wrangler", *args], cwd=API_DIR, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def kv_get(key):
    out = wrangler("kv", "key", "get", "--namespace-id", KV_NS, "--remote", key)
    return None if not out or "Value not found" in out else out


def d1(sql):
    out = wrangler("d1", "execute", "supachad", "--remote", "--json", "--command", sql) or ""
    try:
        return json.loads(out)[0].get("results", [])
    except Exception:
        return out


def cf_policy():
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/access/apps/{CF_APP}/policies/{CF_POLICY}"
    return url, {"Authorization": "Bearer " + CREDS["CF_ACCESS_API_TOKEN"]}


def status(email):
    signups = admin("/api/signups?status=all").get("signups", [])
    tier = admin("/api/tier/" + urllib.parse.quote(email))
    url, h = cf_policy()
    include = (http("GET", url, h).get("result") or {}).get("include", [])
    in_access = any((r.get("email") or {}).get("email") == email for r in include)
    print(f"email        {email}")
    print(f"signup       {next((s['status'] for s in signups if s['email'] == email), '(none)')}")
    print(f"tier         {tier.get('tier')}   credits={tier.get('credits')}")
    print(f"premium KV   {kv_get('premium:' + email) or '(none)'}")
    print(f"welcomed     {'yes' if kv_get('welcomed:' + email) else 'no'}")
    print(f"access queue {'QUEUED' if kv_get('accessq:' + email) else '-'}")
    print(f"CF Access    {'allowed' if in_access else 'not on the policy'}")
    print(f"payments     {d1(f'SELECT payment_id, plan, credits, amount, status FROM square_payments WHERE email = {sql_str(email)}')}")


def sql_str(s):
    return "'" + s.replace("'", "''") + "'"


def reset(email):
    if not re.match(r"^[^@+\s]+\+[^@\s]+@[^@\s]+$", email):
        sys.exit("refusing: reset only takes plus-alias test addresses (you+test@domain)")
    if 'SQUARE_ENV = "sandbox"' not in (API_DIR / "wrangler.toml").read_text():
        sys.exit("refusing: the Worker is not on SQUARE_ENV=sandbox")
    # 1. Cancel active sandbox subscriptions first, so a late webhook can't re-grant premium.
    sq = {"Authorization": "Bearer " + CREDS["SQUARE_SANDBOX_ACCESS_TOKEN"], "Square-Version": "2025-01-23"}
    custs = http("POST", SQUARE + "/v2/customers/search", sq,
                 {"query": {"filter": {"email_address": {"exact": email}}}}).get("customers", [])
    for c in custs:
        subs = http("POST", SQUARE + "/v2/subscriptions/search", sq,
                    {"query": {"filter": {"customer_ids": [c["id"]]}}}).get("subscriptions", [])
        for s in subs:
            if s.get("status") == "ACTIVE" and not s.get("canceled_date"):
                r = http("POST", f"{SQUARE}/v2/subscriptions/{s['id']}/cancel", sq, {})
                print(f"cancelled sandbox subscription {s['id']}: {'ok' if 'subscription' in r else r}")
    # 2. Worker state.
    for key in ("signup:", "premium:", "welcomed:", "accessq:"):
        wrangler("kv", "key", "delete", "--namespace-id", KV_NS, "--remote", key + email)
    d1(f"DELETE FROM credits WHERE email = {sql_str(email)}")
    d1(f"DELETE FROM square_payments WHERE email = {sql_str(email)}")
    print("cleared KV signup/premium/welcomed/accessq and D1 credits/payments")
    # 3. Cloudflare Access.
    url, h = cf_policy()
    pol = http("GET", url, h).get("result") or {}
    include = pol.get("include", [])
    kept = [r for r in include if (r.get("email") or {}).get("email") != email]
    if len(kept) != len(include):
        body = {k: pol[k] for k in ("name", "decision") if k in pol}
        body.update(include=kept, exclude=pol.get("exclude") or [], require=pol.get("require") or [])
        if pol.get("precedence") is not None:
            body["precedence"] = pol["precedence"]
        print("removed from CF Access:", http("PUT", url, h, body).get("success"))
    print("note: the OpenWebUI account (chats, memory) is kept; delete it in Admin > Users for a fully fresh test")


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("status", "reset"):
        sys.exit(__doc__ or "usage: test-account.py status|reset <email>")
    em = sys.argv[2].strip().lower()
    status(em) if sys.argv[1] == "status" else reset(em)
