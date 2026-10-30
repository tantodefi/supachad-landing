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
//   POST /api/signup           {email, note?, turnstile?} → pending signup (KV) + confirmation
//                                                 email + operator alert (approval required)
//   GET  /api/signups?status=  admin; list signups (pending|notified|approved|denied|all)
//   POST /api/signups/claim    admin; pending → notified, returns them (host Moshi watcher)
//   POST /api/signups/decide   admin; {email, action: approve|deny|release, tier?}
//   GET|POST /api/signups/review?e=&s=  signed one-click review page (operator email link)
//   POST /api/invite/mint      {email, tier}   → admin-only; mints a single-use token (KV)
//   GET  /invite/<token>                        → redeem: one-time; grants access
//   POST /api/stripe/webhook                    → paid checkout → premium (sig-verified)
//   POST /api/square/checkout  {email, plan}    → returns a Square hosted-checkout URL
//   POST /api/square/webhook                    → credits once per payment; refund reverses;
//                                                 subscription/invoice events → premium until paid-through date
//   GET  /api/premium/list                      → admin-only; emails for pod allowlist sync
//
// Square bindings (wrangler.toml vars + secrets):
//   var    SQUARE_ENV              "sandbox" (default) | "production"
//   var    SQUARE_LOCATION_ID      e.g. L87VN9AXAYKQG (sandbox default test account)
//   var    SQUARE_CURRENCY         default "CAD"
//   var    SQUARE_SUBSCRIPTION_PLAN_ID  premium monthly plan variation id
//   var    SQUARE_SUBSCRIPTION_AMOUNT   its price in cents (default 1500)
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
// Signup → access (all Cloudflare): a signup is stored `pending`; the user gets a
// confirmation email and the operator an alert with a signed review link. The host
// watcher (nemoclaw scripts/openwebui/chad-signup-watch.sh) claims new signups and
// asks the operator on their phone (Moshi); approving mints an invite and emails
// it. Paid users (subscription / credits) skip approval and get a welcome email.
// Access grants that can't be applied yet are queued in KV `accessq:<email>` and
// the cron trigger applies them once CF_ACCESS_READY=1.
//
// Bindings (wrangler.toml):
//   KV  INVITES            token + signup + grant store
//   var CF_ACCESS_READY    "1" once the CF token can edit Access (else stub)
//   secret ADMIN_SECRET    required on /api/invite/mint (X-Admin-Secret header)
//   secret CF_API_TOKEN, CF_ACCOUNT_ID, CF_ACCESS_APP_ID, CF_ACCESS_POLICY_ID  (for step 1)
//   send_email EMAIL       Cloudflare Email Service (optional: without it nothing is emailed)
//   var    EMAIL_FROM      sender on the onboarded domain, e.g. "Chad <chad@supachad.com>"
//   secret OPERATOR_EMAIL  where signup alerts go (a verified address sends free on any plan)
//   secret TURNSTILE_SECRET  enables the Turnstile check on /api/signup
//   ratelimit SIGNUP_LIMITER  per-IP signup rate limit (optional)
//   var    SIGNUP_AUTO_APPROVE  "1" approves free signups without the operator

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

// Appends an email to the Access policy's "include" list. Anything that can't be
// applied now (not ready yet, or a CF API error) is queued in KV `accessq:<email>`
// for the cron trigger, so no grant is lost.
async function addToCloudflareAccess(env, email) {
  const res = env.CF_ACCESS_READY === "1"
    ? await applyAccessGrant(env, email).catch((e) => ({ applied: false, error: String(e) }))
    : { applied: false, reason: "cf_access_not_ready" };
  if (res.applied) {
    await env.INVITES.delete(`accessq:${email}`);
    return res;
  }
  await env.INVITES.put(`accessq:${email}`, JSON.stringify({ ts: Date.now(), last: res.reason || res.error }));
  return { ...res, queued: true };
}

function accessPolicyApi(env) {
  return {
    base: `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/apps/${env.CF_ACCESS_APP_ID}/policies/${env.CF_ACCESS_POLICY_ID}`,
    hdr: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
  };
}

// Already a Chad user: the operator, a paid account, or anyone already on the
// chad.supachad.com Access policy (operators + every approved/paid user). A
// signup for one of these must not alert the operator or email the address —
// on 2026-10-30 a scanner signed up with the admin's own address. Fails open
// (treated as new) only if the policy can't be read.
async function isExistingUser(env, email) {
  if (env.OPERATOR_EMAIL && email === env.OPERATOR_EMAIL.trim().toLowerCase()) return true;
  if ((await env.INVITES.get(`premium:${email}`)) || (await env.INVITES.get(`welcomed:${email}`))) return true;
  if (env.CF_ACCESS_READY !== "1" || !env.CF_API_TOKEN) return false;
  try {
    const { base, hdr } = accessPolicyApi(env);
    const cur = await (await fetch(base, { headers: hdr })).json();
    return !!cur.success && (cur.result.include || []).some((r) => (r.email?.email || "").toLowerCase() === email);
  } catch {
    return false;
  }
}

async function applyAccessGrant(env, email) {
  const { base, hdr } = accessPolicyApi(env);
  const cur = await (await fetch(base, { headers: hdr })).json();
  if (!cur.success) return { applied: false, error: "policy_read_failed", detail: cur.errors };
  const include = cur.result.include || [];
  if (!include.some((r) => r.email && r.email.email === email)) include.push({ email: { email } });
  // Send back only the writable fields (id/uid/timestamps/reusable are read-only).
  const { name, decision, exclude, require, precedence } = cur.result;
  const body = { name, decision, include, exclude: exclude || [], require: require || [], ...(precedence != null ? { precedence } : {}) };
  const put = await (await fetch(base, { method: "PUT", headers: hdr, body: JSON.stringify(body) })).json();
  return put.success ? { applied: true } : { applied: false, error: "policy_write_failed", detail: put.errors };
}

// ── Square (payments) ────────────────────────────────────────────────────────
// Plans map a checkout to an outcome: a premium grant and/or a credit top-up.
// Amounts are in the smallest currency unit (cents). Adjust freely.
const SQUARE_PLANS = {
  // Monthly subscription (Square catalog plan SQUARE_SUBSCRIPTION_PLAN_ID). The
  // grant comes from subscription/invoice webhooks, not from the payment itself.
  premium:       { name: "Chad Premium — monthly",  subscription: true },
  credits_1k:    { name: "Chad Credits — 1,000",    amount: 500,  credits: 1000 },
  credits_5k:    { name: "Chad Credits — 5,000",    amount: 2000, credits: 5000 },
};

function squareBase(env) {
  return env.SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

function planAmount(env, p) {
  return p.subscription ? Number(env.SQUARE_SUBSCRIPTION_AMOUNT || 1500) : p.amount;
}

async function squareCreatePaymentLink(env, plan, email, origin) {
  const p = SQUARE_PLANS[plan];
  if (!p) return { error: "unknown_plan" };
  if (p.subscription && !env.SQUARE_SUBSCRIPTION_PLAN_ID) return { error: "subscription_not_configured" };
  const body = {
    idempotency_key: crypto.randomUUID(),
    quick_pay: {
      name: p.name,
      price_money: { amount: planAmount(env, p), currency: env.SQUARE_CURRENCY || "CAD" },
      location_id: env.SQUARE_LOCATION_ID,
    },
    checkout_options: {
      redirect_url: `${origin}/?paid=1`,
      ...(p.subscription ? { subscription_plan_id: env.SQUARE_SUBSCRIPTION_PLAN_ID } : {}),
    },
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

// Apply a paid plan: premium grant and/or credit top-up. Credits live in D1
// (atomic ledger). If D1 isn't bound yet, the top-up is recorded to KV as a
// fallback queue so no purchase is lost before provisioning.
async function applySquarePlan(env, email, plan, source) {
  const p = SQUARE_PLANS[plan] || {};
  const out = { plan };
  if (p.grant === "premium") out.grant = await grantPremium(env, email, source);
  if (p.credits) {
    if (env.DB) {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO credits (email, balance, lifetime, updated_ms) VALUES (?1, ?2, ?2, ?3)
         ON CONFLICT(email) DO UPDATE SET balance = balance + ?2, lifetime = lifetime + ?2, updated_ms = ?3`,
      ).bind(email, p.credits, now).run();
      const row = await env.DB.prepare(`SELECT balance FROM credits WHERE email = ?1`).bind(email).first();
      out.balance = row ? row.balance : p.credits;
    } else {
      const cur = JSON.parse((await env.INVITES.get(`credits_queue:${email}`)) || '{"pending":0}');
      cur.pending = (cur.pending || 0) + p.credits;
      await env.INVITES.put(`credits_queue:${email}`, JSON.stringify(cur));
      out.queued = cur.pending; // apply to D1 once provisioned
    }
    out.credits_added = p.credits;
  }
  return out;
}

// A COMPLETED payment → apply its plan exactly once. Only payments made through
// our own checkout links (an `sqorder:` mapping) count: any other sale at the
// same Square location must never grant premium. Every outcome returns 200 so
// Square stops retrying; a missing mapping is kept in KV for a manual look.
async function handleSquarePayment(env, pay, type) {
  const m = pay.order_id ? await env.INVITES.get(`sqorder:${pay.order_id}`) : null;
  if (!m) {
    await env.INVITES.put(`sqorphan:${pay.id}`, JSON.stringify({ order_id: pay.order_id, ts: Date.now() }), { expirationTtl: 30 * 86400 });
    return { ok: true, note: "not_our_checkout" };
  }
  const o = JSON.parse(m);
  const p = SQUARE_PLANS[o.plan];
  const email = String(o.email || "").toLowerCase();
  if (!p || !validEmail(email)) return { ok: true, note: "bad_order_mapping" };
  // The first subscription charge also arrives here; premium is granted by the
  // subscription events, which carry the paid-through date.
  if (p.subscription) return { ok: true, note: "subscription_payment", email };
  const paid = Number(pay.amount_money?.amount || 0);
  if (paid < p.amount) return { ok: true, note: "underpaid", paid, expected: p.amount };
  if (!env.DB) return { ok: false, error: "credits_not_provisioned" };
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO square_payments (payment_id, order_id, email, plan, credits, amount, created_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(pay.id, pay.order_id, email, o.plan, p.credits || 0, paid, Date.now()).run();
  if (!ins.meta || ins.meta.changes === 0) return { ok: true, duplicate: true, email };
  const applied = await applySquarePlan(env, email, o.plan, `square:${type}`);
  return { ok: true, email, ...applied, access: await welcomePaid(env, email, "credits") };
}

// A COMPLETED refund → reverse the payment's grant once. Credits already spent
// can't be clawed back past zero; a premium refund removes premium.
async function handleSquareRefund(env, ref) {
  if (!env.DB || !ref.payment_id) return { ok: true, note: "no_payment" };
  const row = await env.DB.prepare(`SELECT * FROM square_payments WHERE payment_id = ?1`).bind(ref.payment_id).first();
  if (!row) return { ok: true, note: "unknown_payment" };
  const upd = await env.DB.prepare(
    `UPDATE square_payments SET status = 'refunded', refunded_ms = ?2 WHERE payment_id = ?1 AND status = 'paid'`,
  ).bind(ref.payment_id, Date.now()).run();
  if (!upd.meta || upd.meta.changes === 0) return { ok: true, duplicate: true };
  if (row.credits > 0) {
    await env.DB.prepare(
      `UPDATE credits SET balance = MAX(0, balance - ?2), updated_ms = ?3 WHERE email = ?1`,
    ).bind(row.email, row.credits, Date.now()).run();
  }
  if (SQUARE_PLANS[row.plan]?.grant === "premium") await env.INVITES.delete(`premium:${row.email}`);
  return { ok: true, refunded: row.payment_id, email: row.email, plan: row.plan };
}

// ── Subscriptions ────────────────────────────────────────────────────────────
// Premium from a subscription lasts until Square's charged_through_date, plus a
// grace period while active (renewal events can lag the period end). A cancelled
// subscription stays ACTIVE until its canceled_date: honour that, no grace.
// A record with no `until` is a lifetime grant (admin invite) and is never
// shortened or removed by subscription events.
const SUB_GRACE_MS = 3 * 86400 * 1000;

function endOfDayMs(d) {
  return d ? Date.parse(`${d}T23:59:59Z`) : 0;
}

function premiumActive(rec, now = Date.now()) {
  return !!rec && (!rec.until || rec.until > now);
}

async function squareGet(env, path) {
  const r = await fetch(`${squareBase(env)}${path}`, {
    headers: { Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`, "Square-Version": "2025-01-23" },
  });
  return r.ok ? r.json() : null;
}

function subscriptionUntil(sub) {
  if (sub.status === "ACTIVE" && sub.canceled_date) return endOfDayMs(sub.canceled_date);
  if (sub.status === "ACTIVE") return endOfDayMs(sub.charged_through_date) + SUB_GRACE_MS;
  return endOfDayMs(sub.charged_through_date); // PAUSED / DEACTIVATED / CANCELED
}

// Re-read the subscription from Square (events can arrive out of order, so the
// payload is only a pointer) and set the subscriber's premium window from it.
async function handleSquareSubscription(env, subId, now = Date.now()) {
  if (!subId) return { ok: true, note: "no_subscription" };
  const sub = (await squareGet(env, `/v2/subscriptions/${encodeURIComponent(subId)}`))?.subscription;
  if (!sub) return { ok: false, error: "subscription_fetch_failed" }; // non-200 → Square retries
  if (sub.plan_variation_id !== env.SQUARE_SUBSCRIPTION_PLAN_ID) return { ok: true, note: "other_plan" };
  const cust = sub.customer_id ? (await squareGet(env, `/v2/customers/${sub.customer_id}`))?.customer : null;
  const email = String(cust?.email_address || "").toLowerCase();
  if (!validEmail(email)) return { ok: true, note: "no_customer_email", subscription: sub.id };
  const key = `premium:${email}`;
  const cur = JSON.parse((await env.INVITES.get(key)) || "null");
  if (cur && !cur.until) return { ok: true, email, lifetime: true };
  const until = subscriptionUntil(sub);
  if (until > now) {
    await env.INVITES.put(key, JSON.stringify({ ts: now, source: "square:subscription", sub: sub.id, until }), {
      metadata: { until },
    });
    const access = await welcomePaid(env, email, "premium"); // idempotent: one welcome ever
    return { ok: true, email, status: sub.status, until: new Date(until).toISOString(), access };
  }
  if (cur) await env.INVITES.delete(key);
  return { ok: true, email, status: sub.status, expired: true };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ── Email (Cloudflare Email Service) ─────────────────────────────────────────
// Never throws: a missing binding or a send error is returned, so email can't
// break a signup, a redemption or a webhook.
async function sendEmail(env, { to, subject, text, html }) {
  if (!env.EMAIL) return { sent: false, error: "email_not_configured" };
  const msg = { to, from: env.EMAIL_FROM || "Chad <chad@supachad.com>", subject, text, html: html || emailHtml(text) };
  if (env.EMAIL_REPLY_TO) msg.replyTo = env.EMAIL_REPLY_TO;
  try {
    const r = await env.EMAIL.send(msg);
    return { sent: true, id: r?.messageId };
  } catch (e) {
    console.log(`email to ${to} failed: ${e.code || e.message}`);
    return { sent: false, error: e.code || String(e.message || e) };
  }
}

function emailHtml(text) {
  const body = esc(text)
    .replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .split("\n\n").map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  return `<div style="font:15px/1.6 system-ui,sans-serif;max-width:32rem;color:#18181b">${body}</div>`;
}

// ── Access grant queue (cron) ────────────────────────────────────────────────
// Applies queued grants once CF_ACCESS_READY=1 and tells each user they're in.
async function drainAccessQueue(env) {
  if (env.CF_ACCESS_READY !== "1") return { skipped: "cf_access_not_ready" };
  const out = { applied: 0, failed: 0 };
  let cursor;
  do {
    const page = await env.INVITES.list({ prefix: "accessq:", cursor });
    for (const k of page.keys) {
      const email = k.name.slice("accessq:".length);
      const res = await addToCloudflareAccess(env, email);
      if (!res.applied) { out.failed++; continue; }
      out.applied++;
      await sendEmail(env, {
        to: email,
        subject: "Your Chad access is live",
        text: `You're in. Sign in at https://chad.supachad.com with this email address (${email}).`,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// ── Signup → approval → invite ───────────────────────────────────────────────
// KV `signup:<email>` = {email, note, ts, status, ...}; status in metadata too, so
// listing needs no reads. Records from before this flow have no status: pending.
const SIGNUP_STATUSES = ["pending", "notified", "approved", "denied"];

function isAdmin(request, env) {
  return !!env.ADMIN_SECRET && ctEqual(request.headers.get("X-Admin-Secret") || "", env.ADMIN_SECRET);
}

async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(mac)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function reviewUrl(env, origin, email) {
  const s = await hmacHex(env.ADMIN_SECRET, `review:${email}`);
  return `${origin}/api/signups/review?e=${encodeURIComponent(email)}&s=${s}`;
}

async function getSignup(env, email) {
  return JSON.parse((await env.INVITES.get(`signup:${email}`)) || "null");
}

async function putSignup(env, rec) {
  await env.INVITES.put(`signup:${rec.email}`, JSON.stringify(rec), { metadata: { status: rec.status, ts: rec.ts } });
}

async function verifyTurnstile(env, tok, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!tok) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", tok);
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  return !!(await r.json().catch(() => ({}))).success;
}

async function mintInvite(env, email, tier, origin) {
  const tok = token();
  // 14-day TTL; single-use enforced by marking used on redeem.
  await env.INVITES.put(`invite:${tok}`, JSON.stringify({ email, tier, used: false, ts: Date.now() }), {
    expirationTtl: 14 * 86400,
  });
  return { token: tok, url: `${origin}/invite/${tok}` };
}

const SIGNUP_OK = "Thanks — you're on the list. Check your inbox; your access link follows once you're approved.";

async function handleSignup(request, env, ctx, origin) {
  const { email: raw, note, turnstile } = await request.json().catch(() => ({}));
  const email = String(raw || "").trim().toLowerCase();
  if (!validEmail(email)) return j({ ok: false, error: "invalid_email" }, 400);
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (env.SIGNUP_LIMITER) {
    const { success } = await env.SIGNUP_LIMITER.limit({ key: ip || "unknown" });
    if (!success) return j({ ok: false, error: "rate_limited" }, 429);
  }
  if (!(await verifyTurnstile(env, turnstile, ip))) return j({ ok: false, error: "captcha_failed" }, 400);

  // Repeat signups and existing users never email or alert anyone (no inbox
  // bombing through this form), and every case gets the same answer so the form
  // can't be used to find out who has an account.
  if ((await getSignup(env, email)) || (await isExistingUser(env, email))) return j({ ok: true, message: SIGNUP_OK });

  const rec = { email, note: String(note || "").slice(0, 500), ts: Date.now(), status: "pending", country: request.cf?.country || "" };
  await putSignup(env, rec);
  ctx.waitUntil((async () => {
    if (env.SIGNUP_AUTO_APPROVE === "1") return approveSignup(env, email, "lite", origin, "auto");
    await sendEmail(env, {
      to: email,
      subject: "You're on the Chad list",
      text: "Thanks for signing up for Chad. We review new accounts by hand; your access link arrives in a separate email once you're approved.\n\nIf you didn't sign up, ignore this email.",
    });
    if (env.OPERATOR_EMAIL) {
      await sendEmail(env, {
        to: env.OPERATOR_EMAIL,
        subject: `New Chad signup: ${email}`,
        text: `${email} signed up${rec.country ? ` (${rec.country})` : ""}${rec.note ? `\nNote: ${rec.note}` : ""}.\n\nReview: ${await reviewUrl(env, origin, email)}`,
      });
    }
  })());
  return j({ ok: true, message: SIGNUP_OK });
}

async function approveSignup(env, email, tier, origin, by) {
  const cur = (await getSignup(env, email)) || { email, ts: Date.now() };
  if (cur.status === "approved") return { ok: true, email, already: true };
  const t = tier === "premium" ? "premium" : "lite";
  const inv = await mintInvite(env, email, t, origin);
  const mail = await sendEmail(env, {
    to: email,
    subject: "Your Chad access link",
    text: `You're approved for Chad${t === "premium" ? " Premium" : ""}.\n\nOpen this link to activate your account (single use, valid 14 days):\n${inv.url}\n\nThen sign in at https://chad.supachad.com with this email address.`,
  });
  await putSignup(env, { ...cur, status: "approved", tier: t, decided_ts: Date.now(), by, emailed: mail.sent });
  return { ok: true, email, tier: t, emailed: mail.sent, email_error: mail.error, url: inv.url };
}

async function decideSignup(env, email, action, tier, origin, by) {
  if (action === "approve") return approveSignup(env, email, tier, origin, by);
  const cur = await getSignup(env, email);
  if (!cur) return { ok: false, error: "unknown_signup" };
  if (action === "deny") {
    if (cur.status === "approved") return { ok: false, error: "already_approved" };
    await putSignup(env, { ...cur, status: "denied", decided_ts: Date.now(), by });
    return { ok: true, email, status: "denied" };
  }
  if (action === "release") {
    // The watcher couldn't reach the phone: back to pending for the next pass.
    if (cur.status !== "notified") return { ok: true, email, status: cur.status || "pending" };
    await putSignup(env, { ...cur, status: "pending" });
    return { ok: true, email, status: "pending" };
  }
  return { ok: false, error: "unknown_action" };
}

async function listSignups(env, status) {
  const out = [];
  let cursor;
  do {
    const page = await env.INVITES.list({ prefix: "signup:", cursor });
    for (const k of page.keys) {
      let st = k.metadata?.status;
      let ts = k.metadata?.ts;
      if (!st) { // pre-approval-flow record: read it
        const rec = JSON.parse((await env.INVITES.get(k.name)) || "{}");
        st = rec.status || "pending";
        ts = rec.ts;
      }
      if (status === "all" || st === status) out.push({ email: k.name.slice("signup:".length), status: st, ts });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

// pending → notified for signups younger than maxAgeH (a stale backlog must never
// arrive on the phone as a burst of live cards), returning the full records.
async function claimSignups(env, maxAgeH) {
  const cutoff = Date.now() - maxAgeH * 3600 * 1000;
  const out = [];
  for (const s of await listSignups(env, "pending")) {
    if (!s.ts || s.ts < cutoff) continue;
    const rec = await getSignup(env, s.email);
    if (!rec || (rec.status && rec.status !== "pending")) continue;
    await putSignup(env, { ...rec, status: "notified", notified_ts: Date.now() });
    out.push({ email: rec.email, note: rec.note || "", country: rec.country || "", ts: rec.ts });
  }
  return out;
}

async function handleReview(request, env, url) {
  const email = String(url.searchParams.get("e") || "").toLowerCase();
  const s = url.searchParams.get("s") || "";
  const html = (msg, status = 200, form = "") =>
    new Response(redeemPage(msg, form), { status, headers: { "content-type": "text/html" } });
  if (!env.ADMIN_SECRET || !validEmail(email) || !ctEqual(s, await hmacHex(env.ADMIN_SECRET, `review:${email}`))) {
    return html("This review link is invalid.", 403);
  }
  // GET only shows the page; mail scanners prefetch links, so acting needs a POST.
  if (request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const action = form?.get("action");
    if (action !== "approve" && action !== "deny") return html("Unknown action.", 400);
    const r = await decideSignup(env, email, action, "lite", url.origin, "review-link");
    if (!r.ok) return html(`Couldn't ${action} ${email}: ${r.error}.`, 409);
    return html(action === "approve"
      ? `Approved ${email}.${r.already ? " (Already approved.)" : r.emailed ? " Their access link was emailed." : ` Email failed (${r.email_error}); send this link by hand: ${r.url}`}`
      : `Denied ${email}.`);
  }
  const rec = await getSignup(env, email);
  const status = rec?.status || (rec ? "pending" : "unknown");
  const btn = (a, label) => `<button name="action" value="${a}" style="font:inherit;padding:.6rem 1.2rem;margin-right:.5rem;border-radius:9px;border:1px solid #3f3f46;background:${a === "approve" ? "#4f46e5" : "#27272a"};color:#fff;cursor:pointer">${label}</button>`;
  const form = status === "approved" ? "" : `<form method="post">${btn("approve", "Approve")}${btn("deny", "Deny")}</form>`;
  return html(`Signup: ${email} — status ${status}${rec?.note ? `. Note: ${rec.note}` : ""}.`, 200, form);
}

// Paid users skip approval: grant Access and send one welcome email ever.
async function welcomePaid(env, email, what) {
  const grant = await addToCloudflareAccess(env, email);
  if (await env.INVITES.get(`welcomed:${email}`)) return grant;
  await env.INVITES.put(`welcomed:${email}`, JSON.stringify({ ts: Date.now(), what }));
  await sendEmail(env, {
    to: email,
    subject: `Welcome to Chad${what === "premium" ? " Premium" : ""}`,
    text: `Thanks for your purchase (${what === "premium" ? "Chad Premium" : "Chad credits"}).\n\n${grant.applied
      ? `Sign in at https://chad.supachad.com with this email address (${email}).`
      : `We're setting up your login now; you'll get one more email when https://chad.supachad.com is ready for ${email}.`}`,
  });
  return grant;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── Signup intake ──────────────────────────────────────────────────────
    if (request.method === "POST" && pathname === "/api/signup") return handleSignup(request, env, ctx, url.origin);

    // ── Signup review (admin header, or the signed link from the operator email) ──
    if (pathname === "/api/signups/review" && (request.method === "GET" || request.method === "POST")) {
      return handleReview(request, env, url);
    }
    if (pathname === "/api/signups" || pathname.startsWith("/api/signups/")) {
      if (!isAdmin(request, env)) return j({ ok: false, error: "unauthorized" }, 401);
      if (request.method === "GET" && pathname === "/api/signups") {
        const status = url.searchParams.get("status") || "pending";
        if (status !== "all" && !SIGNUP_STATUSES.includes(status)) return j({ ok: false, error: "bad_status" }, 400);
        return j({ ok: true, signups: await listSignups(env, status) });
      }
      if (request.method === "POST" && pathname === "/api/signups/claim") {
        const { max_age_hours } = await request.json().catch(() => ({}));
        const h = Math.min(Math.max(Number(max_age_hours) || 24, 1), 24 * 30);
        return j({ ok: true, signups: await claimSignups(env, h) });
      }
      if (request.method === "POST" && pathname === "/api/signups/decide") {
        const { email, action, tier, by } = await request.json().catch(() => ({}));
        const em = String(email || "").trim().toLowerCase();
        if (!validEmail(em)) return j({ ok: false, error: "invalid_email" }, 400);
        const r = await decideSignup(env, em, action, tier, url.origin, String(by || "admin").slice(0, 40));
        return j(r, r.ok ? 200 : 409);
      }
      return j({ ok: false, error: "not_found" }, 404);
    }

    // ── Mint a single-use invite (admin only) ───────────────────────────────
    if (request.method === "POST" && pathname === "/api/invite/mint") {
      if (!isAdmin(request, env)) return j({ ok: false, error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      if (!validEmail(email)) return j({ ok: false, error: "invalid_email" }, 400);
      const t = body.tier === "premium" ? "premium" : "lite";
      const inv = await mintInvite(env, email, t, url.origin);
      return j({ ok: true, token: inv.token, url: inv.url, email, tier: t });
    }

    // ── Redeem a single-use invite ──────────────────────────────────────────
    if (request.method === "GET" && pathname.startsWith("/invite/")) {
      const tok = pathname.slice("/invite/".length);
      const raw = await env.INVITES.get(`invite:${tok}`);
      if (!raw) return new Response(redeemPage("This invite link is invalid or has expired."), { status: 410, headers: { "content-type": "text/html" } });
      const inv = JSON.parse(raw);
      inv.email = String(inv.email || "").toLowerCase();
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
      // Same per-IP limiter as signup: each call creates a Square payment link.
      if (env.SIGNUP_LIMITER) {
        const { success } = await env.SIGNUP_LIMITER.limit({ key: `checkout:${request.headers.get("CF-Connecting-IP") || "unknown"}` });
        if (!success) return j({ ok: false, error: "rate_limited" }, 429);
      }
      if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return j({ ok: false, error: "square_not_configured" }, 503);
      const res = await squareCreatePaymentLink(env, chosen, email.toLowerCase(), url.origin);
      if (res.error) return j({ ok: false, ...res }, 502);
      return j({ ok: true, url: res.url });
    }

    // ── Square webhook: paid → premium / credits (sig-verified) ──────────────
    // Square forbids the same URL for both environments, so production subscribes
    // to /api/square/webhook/prod (its own signature key). Both share grant logic.
    if (request.method === "POST" && (pathname === "/api/square/webhook" || pathname === "/api/square/webhook/prod")) {
      const isProd = pathname.endsWith("/prod");
      const sigKey = isProd ? env.SQUARE_WEBHOOK_SIGNATURE_KEY_PROD : env.SQUARE_WEBHOOK_SIGNATURE_KEY;
      const raw = await request.text();
      const notifUrl = (isProd ? env.SQUARE_WEBHOOK_URL_PROD : env.SQUARE_WEBHOOK_URL) || `${url.origin}${pathname}`;
      const ok = await verifySquareSig(raw, request.headers.get("x-square-hmacsha256-signature"), sigKey, notifUrl);
      if (!ok) return j({ ok: false, error: "bad_signature" }, 400);
      let evt;
      try { evt = JSON.parse(raw); } catch { return j({ ok: false, error: "bad_json" }, 400); }
      const type = evt.type || "";
      if (type === "payment.created" || type === "payment.updated") {
        const pay = evt.data?.object?.payment || {};
        if (pay.status !== "COMPLETED") return j({ ok: true, ignored: `${type}:${pay.status}` });
        return j(await handleSquarePayment(env, pay, type));
      }
      if (type === "subscription.created" || type === "subscription.updated") {
        const r = await handleSquareSubscription(env, evt.data?.object?.subscription?.id);
        return j(r, r.ok ? 200 : 502);
      }
      if (type === "invoice.payment_made" || type === "invoice.updated") {
        const subId = evt.data?.object?.invoice?.subscription_id;
        if (!subId) return j({ ok: true, ignored: `${type}:no_subscription` });
        const r = await handleSquareSubscription(env, subId);
        return j(r, r.ok ? 200 : 502);
      }
      if (type === "refund.created" || type === "refund.updated") {
        const ref = evt.data?.object?.refund || {};
        if (ref.status !== "COMPLETED") return j({ ok: true, ignored: `${type}:${ref.status}` });
        return j(await handleSquareRefund(env, ref));
      }
      return j({ ok: true, ignored: type });
    }

    // ── Credits: consume (admin; called per-message by the OWUI rate-limit filter) ──
    // D1 makes this ATOMIC: `UPDATE ... WHERE balance >= n` deducts fully or not at
    // all, so concurrent messages can't double-spend.
    if (request.method === "POST" && pathname === "/api/credits/consume") {
      if (!isAdmin(request, env)) {
        return j({ ok: false, error: "unauthorized" }, 401);
      }
      if (!env.DB) return j({ ok: false, error: "credits_not_provisioned" }, 503);
      const { email, amount } = await request.json().catch(() => ({}));
      if (!validEmail(email)) return j({ ok: false, error: "invalid_email" }, 400);
      const n = Math.max(1, Math.floor(Number(amount) || 1));
      const em = email.toLowerCase();
      const upd = await env.DB.prepare(
        `UPDATE credits SET balance = balance - ?2, updated_ms = ?3 WHERE email = ?1 AND balance >= ?2`,
      ).bind(em, n, Date.now()).run();
      const row = await env.DB.prepare(`SELECT balance FROM credits WHERE email = ?1`).bind(em).first();
      const bal = row ? row.balance : 0;
      if (!upd.meta || upd.meta.changes === 0) return j({ ok: false, error: "insufficient", balance: bal }, 402);
      return j({ ok: true, balance: bal, consumed: n });
    }

    // ── Tier lookup (admin): premium | credits | free ────────────────────────
    if (request.method === "GET" && pathname.startsWith("/api/tier/")) {
      if (!isAdmin(request, env)) {
        return j({ ok: false, error: "unauthorized" }, 401);
      }
      const email = decodeURIComponent(pathname.slice("/api/tier/".length)).toLowerCase();
      if (!validEmail(email)) return j({ ok: false, error: "invalid_email" }, 400);
      const prem = premiumActive(JSON.parse((await env.INVITES.get(`premium:${email}`)) || "null"));
      const row = env.DB ? await env.DB.prepare(`SELECT balance FROM credits WHERE email = ?1`).bind(email).first() : null;
      const bal = row ? row.balance : 0;
      return j({ ok: true, email, tier: prem ? "premium" : (bal > 0 ? "credits" : "free"), credits: bal });
    }

    // ── Credits: balance lookup (admin) ──────────────────────────────────────
    if (request.method === "GET" && pathname.startsWith("/api/credits/")) {
      if (!isAdmin(request, env)) {
        return j({ ok: false, error: "unauthorized" }, 401);
      }
      const email = decodeURIComponent(pathname.slice("/api/credits/".length)).toLowerCase();
      if (!validEmail(email)) return j({ ok: false, error: "invalid_email" }, 400);
      const row = env.DB ? await env.DB.prepare(`SELECT balance, lifetime FROM credits WHERE email = ?1`).bind(email).first() : null;
      return j({ ok: true, email, balance: row ? row.balance : 0, lifetime: row ? row.lifetime : 0 });
    }

    // ── Premium list (admin only) → pod allowlist sync bridge ────────────────
    // A pod cron pulls this and merges emails into CHAD_OPERATOR_ALLOWLIST.
    if (request.method === "GET" && pathname === "/api/premium/list") {
      if (!isAdmin(request, env)) {
        return j({ ok: false, error: "unauthorized" }, 401);
      }
      const out = [];
      let cursor;
      do {
        const page = await env.INVITES.list({ prefix: "premium:", cursor });
        // Subscription grants carry `until` in metadata, so expiry needs no reads.
        for (const k of page.keys) if (premiumActive(k.metadata || {})) out.push(k.name.slice("premium:".length));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return j({ ok: true, emails: out });
    }

    // ── Unmatched path on an API route → 404 (Pages serves the real site) ────
    // The Worker is only routed on /api/* and /invite/*, so anything else here is
    // an unknown API path. The static site is served by Cloudflare Pages.
    return j({ ok: false, error: "not_found" }, 404);
  },

  // Cron trigger (wrangler.toml [triggers]): apply queued Access grants.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(drainAccessQueue(env).then((r) => console.log("access queue", JSON.stringify(r))));
  },
};

function redeemPage(message, extra = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chad invite</title><style>body{font:16px/1.6 ui-sans-serif,system-ui;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#e4e4e7;background:#0b0b0d}
.card{background:#18181b;border:1px solid #27272a;border-radius:14px;padding:1.75rem}a{color:#818cf8}</style></head>
<body><div class="card"><h1>Chad</h1><p>${esc(message)}</p>${extra}<p><a href="https://chad.supachad.com">Open Chad →</a></p></div></body></html>`;
}
