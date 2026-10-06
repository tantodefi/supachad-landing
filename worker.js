// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// supachad-landing Worker — signup intake + single-use invite links + paywall.
//
// Deployment model: the static landing site stays on Cloudflare Pages
// (deploy-landing Action, main -> supachad.com). This Worker is routed ONLY on
// `supachad.com/api/*` and `supachad.com/invite/*` (Worker routes take precedence
// over Pages for matching paths), so it adds the API without touching the site.
//
// Routes the Worker is mounted on:
//   POST /api/signup           {email, note?}  → records a signup request (KV + optional email)
//   POST /api/invite/mint      {email, tier}   → admin-only; mints a single-use token (KV)
//   GET  /invite/<token>                        → redeem: one-time; grants access
//   POST /api/stripe/webhook                    → paid checkout → premium (sig-verified)
//   POST /api/square/checkout  {email, plan}    → returns a Square hosted-checkout URL
//   POST /api/square/webhook                    → paid → premium/credits (sig-verified)
//   GET  /api/premium/list                      → admin-only; emails for pod allowlist sync
//
// Square bindings (wrangler.toml vars + secrets):
//   var    SQUARE_ENV              "sandbox" (default) | "production"
//   var    SQUARE_LOCATION_ID      e.g. L87VN9AXAYKQG (sandbox default test account)
//   var    SQUARE_CURRENCY         default "CAD"
//   secret SQUARE_ACCESS_TOKEN     sandbox/prod access token (EAAA…)
//   secret SQUARE_WEBHOOK_SIGNATURE_KEY  from the dashboard webhook subscription
//   var    SQUARE_WEBHOOK_URL      exact subscribed URL (defaults to this route's origin)
//
// Access grant on redeem:
//   1. Adds the email to the Cloudflare Access policy via the CF API —
//      GATED behind env.CF_ACCESS_READY until the API token has
//      `Access: Apps and Policies:Edit` (the current token lacks it). Until
//      then redemption RECORDS the grant for a manual/cron apply and tells the
//      user they're queued.
//   2. tier="premium" is recorded to KV key `premium:<email>`; a pod-side step
//      (or manual edit) adds it to CHAD_OPERATOR_ALLOWLIST in credentials.json.
//      tier="lite" needs no pod change (chad-lite is public once CF Access lets
//      the email in).
//
// Bindings (wrangler.toml):
//   KV  INVITES            token + signup + grant store
//   var CF_ACCESS_READY    "1" once the CF token can edit Access (else stub)
//   secret ADMIN_SECRET    required on /api/invite/mint (X-Admin-Secret header)
//   secret CF_API_TOKEN, CF_ACCOUNT_ID, CF_ACCESS_APP_ID, CF_ACCESS_POLICY_ID  (for step 1)

const JSON_HEADERS = { "content-type": "application/json" };

function j(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}
function token() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function validEmail(e) {
  return typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e.length < 255;
}

function ctEqual(a, b) {
  // constant-time-ish string compare (equal length required for timing safety)
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyStripeSig(rawBody, sigHeader, secret) {
  // Stripe-Signature: "t=<ts>,v1=<hex-hmac>"; signed payload is `${t}.${rawBody}`.
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((kv) => kv.split("=")));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5-min replay window
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return ctEqual(hex, v1);
}

// Record a premium grant: KV flag + CF Access (queued until ready). Idempotent.
async function grantPremium(env, email, source) {
  const grant = await addToCloudflareAccess(env, email);
  await env.INVITES.put(`premium:${email}`, JSON.stringify({ ts: Date.now(), source, grant }));
  return grant;
}

async function addToCloudflareAccess(env, email) {
  // Appends an email to the Access policy's "include" list. No-op (queued) until
  // CF_ACCESS_READY=1 and the token has Access:Edit.
  if (env.CF_ACCESS_READY !== "1") return { applied: false, queued: true, reason: "cf_access_not_ready" };
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/apps/${env.CF_ACCESS_APP_ID}/policies/${env.CF_ACCESS_POLICY_ID}`;
  const hdr = { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" };
  const cur = await (await fetch(base, { headers: hdr })).json();
  if (!cur.success) return { applied: false, error: "policy_read_failed", detail: cur.errors };
  const include = cur.result.include || [];
  if (!include.some((r) => r.email && r.email.email === email)) include.push({ email: { email } });
  const put = await (await fetch(base, { method: "PUT", headers: hdr, body: JSON.stringify({ ...cur.result, include }) })).json();
  return put.success ? { applied: true } : { applied: false, error: "policy_write_failed", detail: put.errors };
}

// ── Square (payments) ────────────────────────────────────────────────────────
// Plans map a checkout to an outcome: a premium grant and/or a credit top-up.
// Amounts are in the smallest currency unit (cents). Adjust freely.
const SQUARE_PLANS = {
  premium:       { name: "Chad Premium",            amount: 500,  grant: "premium" },
  credits_1k:    { name: "Chad Credits — 1,000",    amount: 500,  credits: 1000 },
  credits_5k:    { name: "Chad Credits — 5,000",    amount: 2000, credits: 5000 },
};

function squareBase(env) {
  return env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

async function squareCreatePaymentLink(env, plan, email, origin) {
  const p = SQUARE_PLANS[plan];
  if (!p) return { error: "unknown_plan" };
  const body = {
    idempotency_key: crypto.randomUUID(),
    quick_pay: {
      name: p.name,
      price_money: { amount: p.amount, currency: env.SQUARE_CURRENCY || "CAD" },
      location_id: env.SQUARE_LOCATION_ID,
    },
    checkout_options: { redirect_url: `${origin}/?paid=1` },
    pre_populated_data: { buyer_email: email },
  };
  const r = await fetch(`${squareBase(env)}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Square-Version": "2025-01-23",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (d.errors) return { error: "square_create_failed", detail: d.errors };
  const pl = d.payment_link;
  // Map order_id → {email, plan} so the webhook knows who paid for what.
  if (pl.order_id) {
    await env.INVITES.put(`sqorder:${pl.order_id}`, JSON.stringify({ email, plan, ts: Date.now() }), { expirationTtl: 7 * 86400 });
  }
  return { url: pl.url, order_id: pl.order_id, id: pl.id };
}

function b64(buf) {
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

async function verifySquareSig(rawBody, sigHeader, key, notificationUrl) {
  // Square signs HMAC-SHA256(key, notificationUrl + rawBody), base64-encoded;
  // header x-square-hmacsha256-signature. notificationUrl must match the dashboard
  // subscription URL exactly.
  if (!sigHeader || !key) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(notificationUrl + rawBody));
  return ctEqual(b64(mac), sigHeader);
}

// Apply a paid plan: premium grant and/or credit top-up (balance in KV credits:<email>).
async function applySquarePlan(env, email, plan, source) {
  const p = SQUARE_PLANS[plan] || {};
  const out = { plan };
  if (p.grant === "premium") out.grant = await grantPremium(env, email, source);
  if (p.credits) {
    const cur = JSON.parse((await env.INVITES.get(`credits:${email}`)) || '{"balance":0}');
    cur.balance = (cur.balance || 0) + p.credits;
    cur.ts = Date.now();
    cur.source = source;
    await env.INVITES.put(`credits:${email}`, JSON.stringify(cur));
    out.credits_added = p.credits;
    out.balance = cur.balance;
  }
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── Signup intake ──────────────────────────────────────────────────────
    if (request.method === "POST" && pathname === "/api/signup") {
      const { email, note } = await request.json().catch(() => ({}));
      if (!validEmail(email)) return j({ ok: false, error: "invalid_email" }, 400);
      const key = `signup:${email}`;
      await env.INVITES.put(key, JSON.stringify({ email, note: String(note || "").slice(0, 500), ts: Date.now() }));
      return j({ ok: true, message: "Thanks — you're on the list. We'll send an invite link." });
    }

    // ── Mint a single-use invite (admin only) ───────────────────────────────
    if (request.method === "POST" && pathname === "/api/invite/mint") {
      if (!env.ADMIN_SECRET || request.headers.get("X-Admin-Secret") !== env.ADMIN_SECRET) {
        return j({ ok: false, error: "unauthorized" }, 401);
      }
      const { email, tier } = await request.json().catch(() => ({}));
      if (!validEmail(email)) return j({ ok: false, error: "invalid_email" }, 400);
      const t = tier === "premium" ? "premium" : "lite";
      const tok = token();
      // 14-day TTL; single-use enforced by deleting on redeem.
      await env.INVITES.put(`invite:${tok}`, JSON.stringify({ email, tier: t, used: false, ts: Date.now() }), {
        expirationTtl: 14 * 86400,
      });
      return j({ ok: true, token: tok, url: `${url.origin}/invite/${tok}`, email, tier: t });
    }

    // ── Redeem a single-use invite ──────────────────────────────────────────
    if (request.method === "GET" && pathname.startsWith("/invite/")) {
      const tok = pathname.slice("/invite/".length);
      const raw = await env.INVITES.get(`invite:${tok}`);
      if (!raw) return new Response(redeemPage("This invite link is invalid or has expired."), { status: 410, headers: { "content-type": "text/html" } });
      const inv = JSON.parse(raw);
      if (inv.used) return new Response(redeemPage("This invite has already been used."), { status: 410, headers: { "content-type": "text/html" } });

      const grant = await addToCloudflareAccess(env, inv.email);
      if (inv.tier === "premium") await env.INVITES.put(`premium:${inv.email}`, JSON.stringify({ ts: Date.now() }));
      // Single-use: consume the token.
      await env.INVITES.put(`invite:${tok}`, JSON.stringify({ ...inv, used: true, redeemed: Date.now(), grant }), { expirationTtl: 14 * 86400 });

      const msg = grant.applied
        ? `You're in, ${inv.email}. Sign in at chad.supachad.com — you have the ${inv.tier === "premium" ? "premium Chad" : "Chad Lite"} tier.`
        : `Thanks ${inv.email} — your ${inv.tier} invite is recorded and being provisioned. You'll get access shortly.`;
      return new Response(redeemPage(msg), { status: 200, headers: { "content-type": "text/html" } });
    }

    // ── Stripe webhook: paid checkout → premium ─────────────────────────────
    // Point a Stripe Payment Link / Checkout at chad.supachad.com, then add a
    // webhook endpoint → https://<this-worker>/api/stripe/webhook listening for
    // `checkout.session.completed`. STRIPE_WEBHOOK_SECRET is the whsec_… value.
    if (request.method === "POST" && pathname === "/api/stripe/webhook") {
      const raw = await request.text();
      const ok = await verifyStripeSig(raw, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
      if (!ok) return j({ ok: false, error: "bad_signature" }, 400);
      let evt;
      try { evt = JSON.parse(raw); } catch { return j({ ok: false, error: "bad_json" }, 400); }
      if (evt.type === "checkout.session.completed" || evt.type === "invoice.paid") {
        const obj = evt.data?.object || {};
        const email = obj.customer_details?.email || obj.customer_email || obj.receipt_email;
        if (validEmail(email)) {
          const grant = await grantPremium(env, email.toLowerCase(), `stripe:${evt.type}`);
          return j({ ok: true, premium: email, grant });
        }
        return j({ ok: true, note: "no email on session" }); // still 200 so Stripe stops retrying
      }
      return j({ ok: true, ignored: evt.type }); // ack unhandled events
    }

    // ── Square: create a hosted checkout link ────────────────────────────────
    // POST {email, plan} → returns {url}. plan ∈ SQUARE_PLANS (default "premium").
    if (request.method === "POST" && pathname === "/api/square/checkout") {
      const { email, plan } = await request.json().catch(() => ({}));
      const chosen = plan || "premium";
      if (!validEmail(email)) return j({ ok: false, error: "invalid_email" }, 400);
      if (!SQUARE_PLANS[chosen]) return j({ ok: false, error: "unknown_plan", plans: Object.keys(SQUARE_PLANS) }, 400);
      if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return j({ ok: false, error: "square_not_configured" }, 503);
      const res = await squareCreatePaymentLink(env, chosen, email.toLowerCase(), url.origin);
      if (res.error) return j({ ok: false, ...res }, 502);
      return j({ ok: true, url: res.url });
    }

    // ── Square webhook: paid → premium / credits (sig-verified) ──────────────
    if (request.method === "POST" && pathname === "/api/square/webhook") {
      const raw = await request.text();
      const notifUrl = env.SQUARE_WEBHOOK_URL || `${url.origin}/api/square/webhook`;
      const ok = await verifySquareSig(raw, request.headers.get("x-square-hmacsha256-signature"), env.SQUARE_WEBHOOK_SIGNATURE_KEY, notifUrl);
      if (!ok) return j({ ok: false, error: "bad_signature" }, 400);
      let evt;
      try { evt = JSON.parse(raw); } catch { return j({ ok: false, error: "bad_json" }, 400); }
      const type = evt.type || "";
      if (type === "payment.created" || type === "payment.updated") {
        const pay = evt.data?.object?.payment || {};
        if (pay.status === "COMPLETED") {
          const orderId = pay.order_id;
          let email = pay.buyer_email_address;
          let plan = "premium";
          if (orderId) {
            const m = await env.INVITES.get(`sqorder:${orderId}`);
            if (m) { const o = JSON.parse(m); email = o.email || email; plan = o.plan || plan; }
          }
          if (validEmail(email)) {
            const applied = await applySquarePlan(env, email.toLowerCase(), plan, `square:${type}`);
            return j({ ok: true, email, ...applied });
          }
          return j({ ok: true, note: "no email resolved" }); // 200 so Square stops retrying
        }
      }
      return j({ ok: true, ignored: type });
    }

    // ── Premium list (admin only) → pod allowlist sync bridge ────────────────
    // A pod cron pulls this and merges emails into CHAD_OPERATOR_ALLOWLIST.
    if (request.method === "GET" && pathname === "/api/premium/list") {
      if (!env.ADMIN_SECRET || request.headers.get("X-Admin-Secret") !== env.ADMIN_SECRET) {
        return j({ ok: false, error: "unauthorized" }, 401);
      }
      const out = [];
      let cursor;
      do {
        const page = await env.INVITES.list({ prefix: "premium:", cursor });
        for (const k of page.keys) out.push(k.name.slice("premium:".length));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return j({ ok: true, emails: out });
    }

    // ── Unmatched path on an API route → 404 (Pages serves the real site) ────
    // The Worker is only routed on /api/* and /invite/*, so anything else here is
    // an unknown API path. The static site is served by Cloudflare Pages.
    return j({ ok: false, error: "not_found" }, 404);
  },
};

function redeemPage(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chad invite</title><style>body{font:16px/1.6 ui-sans-serif,system-ui;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#e4e4e7;background:#0b0b0d}
.card{background:#18181b;border:1px solid #27272a;border-radius:14px;padding:1.75rem}a{color:#818cf8}</style></head>
<body><div class="card"><h1>Chad</h1><p>${message}</p><p><a href="https://chad.supachad.com">Open Chad →</a></p></div></body></html>`;
}
