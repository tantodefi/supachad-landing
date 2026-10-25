<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->
# Manual test plan — signup, free tier, credits, premium (Square SANDBOX)

The live Worker runs `SQUARE_ENV = "sandbox"`: checkout pages are Square's sandbox and
**no real money moves**. Run every row below before switching to production (U6).

## Test cards (Square sandbox)

| Use | Card number | CVV | Expiry | Postal code |
|---|---|---|---|---|
| ✅ Success (Visa) | `4111 1111 1111 1111` | `111` | any future date | any valid, e.g. `M5V 2T6` / `94103` |
| ✅ Success (Mastercard) | `5105 1051 0510 5100` | `111` | any future | any valid |
| ✅ Success (Amex) | `3400 000000 00009` | `1111` | any future | any valid |
| ❌ Card declined | `4000 0000 0000 0002` | `111` | any future | any valid |
| ❌ Bad CVV | `4111 1111 1111 1111` | `911` | any future | any valid |
| ❌ Bad postal code | `4111 1111 1111 1111` | `111` | any future | `99999` |
| ❌ Bad expiry | `4111 1111 1111 1111` | `111` | `01/40` | any valid |

Currency is CAD, so a postal code is required.

## Test accounts

Use plus-aliases of an inbox you can read — each is a separate account everywhere
(Worker, Cloudflare Access, OpenWebUI) but lands in your inbox:

| Alias | Tests |
|---|---|
| `you+free1@proton.me` | free signup → phone approval → login → 50/day cap |
| `you+credits1@proton.me` | buy credits_1k → per-message credit burn |
| `you+premium1@proton.me` | premium subscription → unlimited |
| `you+decline1@proton.me` | declined / bad-CVV cards → nothing granted |

Check any account at any time, and wipe it to re-run (plus-aliases only; cancels any
active sandbox subscription first):

```bash
api/scripts/test-account.py status you+premium1@proton.me
api/scripts/test-account.py reset  you+premium1@proton.me
```

For a completely fresh run also delete the user in OpenWebUI (Admin → Users).

## 1. Free signup

1. supachad.com → Get started → **Free** → `you+free1@…` → Create account.
2. Expect: page says you're on the list; inbox gets "You're on the Chad list"; the operator
   inbox gets "New Chad signup" with a review link; within ~2 min a **Moshi card**.
3. Tap **Yes** → inbox gets "Your Chad access link" → open it → page says "You're in".
4. chad.supachad.com → sign in with the alias (Cloudflare emails a code).
5. Expect in OpenWebUI: default + pinned **Chad Lite**, ~13 models, **no "Chad"**, no terminal
   bar, no image button; skills under `$`; welcome prompts on the empty chat.
6. Cap: to test without sending 50 messages, Admin → Functions → *Chad Lite Rate Limit* →
   Valves → `free_daily_limit` = `3`. Message 4 shows the upgrade message. **Set it back to 50.**
7. `status` → `signup approved`, `tier free`, `CF Access allowed`.

Also try tapping **No** on a second alias → no access-link email, `signup denied`.

## 2. Credits (pay-as-you-go)

1. supachad.com → Get started → **Credits** → `you+credits1@…` → Continue to checkout.
2. Sandbox checkout: pay with the Visa success card.
3. Expect within ~10 s: inbox gets "Welcome to Chad"; `status` → `tier credits credits=1000`,
   one row in `payments` (status `paid`), `CF Access allowed` (no approval needed).
4. Sign in → chat with Chad Lite → each reply shows **"💳 999 credits remaining"** (then 998…)
   and the daily cap doesn't apply while credits last.
5. Refund (optional): Square sandbox dashboard → Transactions → refund → `status` shows the
   payment `refunded` and credits reduced by 1000 (never below 0).

## 3. Premium (monthly subscription)

1. supachad.com → **Premium** → `you+premium1@…` → checkout with the Visa success card.
2. Expect: "Welcome to Chad Premium" email; `status` → `tier premium`, premium KV with an
   `until` about a month out (+3 days grace), `CF Access allowed`.
3. Sign in → Chad Lite has **no daily cap** and **no credits are used** (no 💳 line).
4. Still **no access to "Chad"** — premium is unlimited Chad Lite, not the operators' agent.
5. Cancel (optional): `reset` cancels it, or cancel in the Square sandbox dashboard → premium
   stays until the paid-through date, then the tier returns to `free`.

## 4. Failure paths

1. Checkout with the **declined** card, then **bad CVV** → Square shows an error; `status` →
   `tier free`, no payment row, no welcome email, no Access.
2. Same email twice on the free form → only one confirmation email (no inbox flooding).

## Where things live

| What | Where |
|---|---|
| Worker logs (live) | `cd api && npx wrangler tail supachad-landing-api` |
| Signup list | `GET /api/signups?status=all` with `X-Admin-Secret` |
| Phone-approval watcher log | `~/.nemoclaw/openwebui/chad-signup-watch.log` |
| Credits ledger | D1 `supachad` tables `credits`, `square_payments` |
| Square sandbox dashboard | developer.squareup.com → your app → Sandbox test account → Open in Square Dashboard |
