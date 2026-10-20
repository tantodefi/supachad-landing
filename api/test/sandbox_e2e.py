# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""End-to-end paywall test: local Worker (wrangler dev) + Square SANDBOX.
No real money: sandbox token + Square's published test nonces only."""
import base64, hashlib, hmac, json, os, sys, time, urllib.error, urllib.request, uuid

S = os.environ["E2E_DIR"]  # dev.vars + local D1/KV state (run-sandbox-e2e.sh)
V = dict(l.split("=", 1) for l in open(os.path.join(S, "dev.vars")).read().split("\n") if "=" in l)
W = "http://127.0.0.1:8799"
SQ = "https://connect.squareupsandbox.com"
LOC = "L87VN9AXAYKQG"
ADMIN = {"X-Admin-Secret": V["ADMIN_SECRET"]}
RUN = uuid.uuid4().hex[:6]
FAILS = []


def req(method, url, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"content-type": "application/json", **(headers or {})}
    r = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            t = resp.read().decode()
            return resp.status, (json.loads(t) if t.startswith(("{", "[")) else t)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        return e.code, (json.loads(t) if t.startswith(("{", "[")) else t)


def sq(method, path, body=None):
    return req(method, SQ + path, body, {"Authorization": f"Bearer {V['SQUARE_ACCESS_TOKEN']}", "Square-Version": "2025-01-23"})


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  -> {detail}"))
    if not cond:
        FAILS.append(name)


def webhook(evt, sig_ok=True):
    raw = json.dumps(evt).encode()
    key = V["SQUARE_WEBHOOK_SIGNATURE_KEY"] if sig_ok else "wrong-key"
    sig = base64.b64encode(hmac.new(key.encode(), V["SQUARE_WEBHOOK_URL"].encode() + raw, hashlib.sha256).digest()).decode()
    return req("POST", W + "/api/square/webhook", raw=raw, headers={"x-square-hmacsha256-signature": sig})


def kv_put(key, value):
    import subprocess
    r = subprocess.run(["wrangler", "kv", "key", "put", "--binding", "INVITES", "--local", "--persist-to",
        os.path.join(S, "state"), key, value], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))), capture_output=True, text=True)
    assert r.returncode == 0, r.stderr[-400:]


def checkout_and_pay(email, plan, amount, nonce="cnon:card-nonce-ok"):
    st, d = req("POST", W + "/api/square/checkout", {"email": email, "plan": plan})
    assert st == 200 and d.get("ok") and "square.link" in d["url"], (st, d)
    # Payment-link orders stay DRAFT until a buyer opens Square's hosted page, so
    # pay an equivalent OPEN order and give it the same mapping the Worker writes.
    st, o = sq("POST", "/v2/orders", {"idempotency_key": str(uuid.uuid4()), "order": {"location_id": LOC,
        "line_items": [{"name": plan, "quantity": "1", "base_price_money": {"amount": amount, "currency": "CAD"}}]}})
    assert st == 200, o
    oid = o["order"]["id"]
    kv_put(f"sqorder:{oid}", json.dumps({"email": email, "plan": plan, "ts": int(time.time() * 1000)}))
    st, p = sq("POST", "/v2/payments", {
        "source_id": nonce, "idempotency_key": str(uuid.uuid4()), "location_id": LOC,
        "order_id": oid, "amount_money": {"amount": amount, "currency": "CAD"},
        "autocomplete": True, "buyer_email_address": email,
    })
    return st, p, oid


def credits(email):
    return req("GET", W + "/api/credits/" + email, headers=ADMIN)[1].get("balance")


def tier(email):
    return req("GET", W + "/api/tier/" + email, headers=ADMIN)[1].get("tier")


def premium_list():
    return req("GET", W + "/api/premium/list", headers=ADMIN)[1].get("emails", [])


u_free = f"supachad+e2e-free-{RUN}@proton.me"
u_cred = f"supachad+e2e-cred-{RUN}@proton.me"
u_prem = f"supachad+e2e-prem-{RUN}@proton.me"

print("== C7 signup + invite")
st, d = req("POST", W + "/api/signup", {"email": u_free, "note": "e2e"})
check("signup accepted", st == 200 and d.get("ok"), d)
check("signup rejects bad email", req("POST", W + "/api/signup", {"email": "nope"})[0] == 400)
check("mint needs admin", req("POST", W + "/api/invite/mint", {"email": u_free})[0] == 401)
st, d = req("POST", W + "/api/invite/mint", {"email": u_free, "tier": "lite"}, ADMIN)
check("mint lite invite", st == 200 and d.get("tier") == "lite", d)
path = d["url"].split("://", 1)[1].split("/", 1)[1]
st, page = req("GET", W + "/" + path)
check("redeem invite once", st == 200 and u_free in page, (st, str(page)[:200]))
check("redeem twice refused", req("GET", W + "/" + path)[0] == 410)
check("lite redeem is not premium", u_free not in premium_list())

print("== C8 free tier")
check("new user tier=free", tier(u_free) == "free")
st, d = req("POST", W + "/api/credits/consume", {"email": u_free}, ADMIN)
check("free user has no credits to spend (402)", st == 402 and d.get("balance") == 0, (st, d))
check("consume needs admin", req("POST", W + "/api/credits/consume", {"email": u_free})[0] == 401)

print("== C9 credits purchase")
st, pay, order = checkout_and_pay(u_cred, "credits_1k", 500)
check("sandbox payment completed", st == 200 and pay["payment"]["status"] == "COMPLETED", (st, pay))
payment = pay["payment"]
check("bad signature rejected", webhook({"type": "payment.updated", "data": {"object": {"payment": payment}}}, sig_ok=False)[0] == 400)
st, d = webhook({"type": "payment.created", "data": {"object": {"payment": payment}}})
check("webhook adds 1000 credits", st == 200 and d.get("credits_added") == 1000 and d.get("balance") == 1000, d)
st, d = webhook({"type": "payment.updated", "data": {"object": {"payment": payment}}})
check("duplicate webhook ignored", d.get("duplicate") is True, d)
check("balance still 1000 after duplicate", credits(u_cred) == 1000)
check("tier=credits", tier(u_cred) == "credits")
st, d = req("POST", W + "/api/credits/consume", {"email": u_cred, "amount": 1}, ADMIN)
check("message consumes 1 credit", st == 200 and d.get("balance") == 999, d)
check("credits buyer is not premium", u_cred not in premium_list())

print("== C9 declined card")
st, pay2, _ = checkout_and_pay(u_free, "credits_1k", 500, nonce="cnon:card-nonce-declined")
check("declined card -> no payment", st >= 400 and "payment" not in pay2 or pay2.get("payment", {}).get("status") != "COMPLETED", (st, pay2))
check("declined -> no credits", credits(u_free) == 0)

print("== C9 payment not from our checkout")
st, other = sq("POST", "/v2/payments", {"source_id": "cnon:card-nonce-ok", "idempotency_key": str(uuid.uuid4()),
    "location_id": LOC, "amount_money": {"amount": 500, "currency": "CAD"}, "buyer_email_address": u_free})
st, d = webhook({"type": "payment.updated", "data": {"object": {"payment": other["payment"]}}})
check("unrelated sale grants nothing", d.get("note") == "not_our_checkout" and u_free not in premium_list(), d)

print("== C9 underpaid (forged amount on a real order)")
o5 = "e2e-order-" + RUN
kv_put(f"sqorder:{o5}", json.dumps({"email": u_free, "plan": "credits_5k"}))
fake = {"id": "fake-" + RUN, "status": "COMPLETED", "order_id": o5, "amount_money": {"amount": 100, "currency": "CAD"}}
st, d = webhook({"type": "payment.updated", "data": {"object": {"payment": fake}}})
check("underpaid order grants nothing", d.get("note") == "underpaid" and credits(u_free) == 0, d)

print("== C9 premium purchase")
st, pp, _ = checkout_and_pay(u_prem, "premium", 500)
check("premium sandbox payment completed", st == 200, pp)
st, d = webhook({"type": "payment.updated", "data": {"object": {"payment": pp["payment"]}}})
check("premium granted", u_prem in premium_list() and tier(u_prem) == "premium", d)

print("== C9 refunds")
for who, p in ((u_cred, payment), (u_prem, pp["payment"])):
    st, rf = sq("POST", "/v2/refunds", {"idempotency_key": str(uuid.uuid4()), "payment_id": p["id"],
        "amount_money": p["amount_money"], "reason": "e2e test"})
    check(f"sandbox refund created ({who.split('-')[2]})", st == 200, rf)
    refund = rf["refund"]
    for _ in range(10):
        if refund["status"] == "COMPLETED":
            break
        time.sleep(2)
        refund = sq("GET", "/v2/refunds/" + refund["id"])[1]["refund"]
    st, d = webhook({"type": "refund.updated", "data": {"object": {"refund": refund}}})
    check(f"refund webhook reverses ({who.split('-')[2]})", d.get("refunded") == p["id"], (refund["status"], d))
    st, d = webhook({"type": "refund.updated", "data": {"object": {"refund": refund}}})
    check(f"duplicate refund ignored ({who.split('-')[2]})", d.get("duplicate") is True, d)
check("credits refund -> balance 0 (never negative)", credits(u_cred) == 0)
check("premium refund -> premium removed", u_prem not in premium_list())

print(f"\n{'ALL PASS' if not FAILS else 'FAILED: ' + ', '.join(FAILS)}")
sys.exit(1 if FAILS else 0)
