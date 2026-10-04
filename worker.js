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
//   GET  /api/premium/list                      → admin-only; emails for pod allowlist sync
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
