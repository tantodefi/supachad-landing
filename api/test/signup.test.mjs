// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Signup → approval → invite flow against an in-memory KV and a fake EMAIL
// binding. No network: fetch is stubbed. Run: node --test api/test/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k).v : null; }
  async put(k, v, o = {}) { this.m.set(k, { v, metadata: o.metadata }); }
  async delete(k) { this.m.delete(k); }
  async list({ prefix = "" } = {}) {
    const keys = [...this.m].filter(([k]) => k.startsWith(prefix)).map(([name, { metadata }]) => ({ name, metadata }));
    return { keys, list_complete: true };
  }
}

const ADMIN = "s3cret-admin";
let env, sent, waits, fetches;

beforeEach(() => {
  sent = [];
  waits = [];
  fetches = [];
  env = {
    INVITES: new FakeKV(),
    ADMIN_SECRET: ADMIN,
    OPERATOR_EMAIL: "op@example.com",
    EMAIL: { send: async (m) => { sent.push(m); return { messageId: `m${sent.length}` }; } },
  };
  globalThis.fetch = async (u, init) => { fetches.push({ u: String(u), init }); return new Response(JSON.stringify({ success: true })); };
});

const ctx = { waitUntil: (p) => waits.push(p) };
const settle = () => Promise.all(waits.splice(0));

async function call(method, path, body, headers = {}) {
  const init = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const r = await worker.fetch(new Request(`https://supachad.com${path}`, init), env, ctx);
  const t = await r.text();
  await settle();
  return { status: r.status, body: t.startsWith("{") ? JSON.parse(t) : t };
}
const admin = { "X-Admin-Secret": ADMIN };

test("signup stores pending, lowercases, emails user + operator once", async () => {
  const r = await call("POST", "/api/signup", { email: "  New@Example.COM " });
  assert.equal(r.status, 200);
  assert.ok(r.body.ok);
  const rec = JSON.parse(await env.INVITES.get("signup:new@example.com"));
  assert.equal(rec.status, "pending");
  assert.deepEqual(sent.map((m) => m.to), ["new@example.com", "op@example.com"]);
  assert.match(sent[1].text, /\/api\/signups\/review\?e=new%40example\.com&s=[0-9a-f]{64}/);

  await call("POST", "/api/signup", { email: "new@example.com" });
  assert.equal(sent.length, 2, "a repeat signup must not re-email");
});

test("signup without the EMAIL binding still succeeds", async () => {
  delete env.EMAIL;
  const r = await call("POST", "/api/signup", { email: "a@b.co" });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(await env.INVITES.get("signup:a@b.co")).status, "pending");
});

test("invalid email, rate limit and turnstile are enforced", async () => {
  assert.equal((await call("POST", "/api/signup", { email: "nope" })).status, 400);
  env.SIGNUP_LIMITER = { limit: async () => ({ success: false }) };
  assert.equal((await call("POST", "/api/signup", { email: "a@b.co" })).status, 429);
  delete env.SIGNUP_LIMITER;
  env.TURNSTILE_SECRET = "ts";
  assert.equal((await call("POST", "/api/signup", { email: "a@b.co" })).status, 400, "missing token");
  assert.equal((await call("POST", "/api/signup", { email: "a@b.co", turnstile: "tok" })).status, 200);
  assert.ok(fetches.some((f) => f.u.includes("turnstile/v0/siteverify")));
});

test("claim → approve mints an invite and emails the link; redeem queues Access", async () => {
  await call("POST", "/api/signup", { email: "u@x.io" });
  sent = [];
  assert.equal((await call("POST", "/api/signups/claim", {})).status, 401);
  const c = await call("POST", "/api/signups/claim", {}, admin);
  assert.deepEqual(c.body.signups.map((s) => s.email), ["u@x.io"]);
  assert.equal((await call("POST", "/api/signups/claim", {}, admin)).body.signups.length, 0, "claimed once");

  const d = await call("POST", "/api/signups/decide", { email: "U@x.io", action: "approve" }, admin);
  assert.ok(d.body.ok && d.body.emailed);
  assert.equal(sent.length, 1);
  const link = sent[0].text.match(/https:\/\/supachad\.com\/invite\/[0-9a-f]+/)[0];
  assert.equal(JSON.parse(await env.INVITES.get("signup:u@x.io")).status, "approved");

  const again = await call("POST", "/api/signups/decide", { email: "u@x.io", action: "approve" }, admin);
  assert.ok(again.body.already);
  assert.equal(sent.length, 1, "approving twice sends one invite");

  const red = await call("GET", new URL(link).pathname);
  assert.equal(red.status, 200);
  assert.ok(await env.INVITES.get("accessq:u@x.io"), "grant queued while CF_ACCESS_READY=0");
});

test("deny, release and listing", async () => {
  await call("POST", "/api/signup", { email: "d@x.io" });
  await call("POST", "/api/signup", { email: "r@x.io" });
  await call("POST", "/api/signups/claim", {}, admin);
  assert.equal((await call("POST", "/api/signups/decide", { email: "d@x.io", action: "deny" }, admin)).body.status, "denied");
  assert.equal((await call("POST", "/api/signups/decide", { email: "r@x.io", action: "release" }, admin)).body.status, "pending");
  const l = await call("GET", "/api/signups?status=all", undefined, admin);
  assert.deepEqual(Object.fromEntries(l.body.signups.map((s) => [s.email, s.status])), { "d@x.io": "denied", "r@x.io": "pending" });
  // a denied signup gets the generic answer, no new mail
  sent = [];
  await call("POST", "/api/signup", { email: "d@x.io" });
  assert.equal(sent.length, 0);
});

test("claim skips stale and legacy records (no backlog burst on the phone)", async () => {
  await env.INVITES.put("signup:old@x.io", JSON.stringify({ email: "old@x.io", ts: Date.now() - 3 * 86400e3 }));
  await call("POST", "/api/signup", { email: "new@x.io" });
  const c = await call("POST", "/api/signups/claim", { max_age_hours: 24 }, admin);
  assert.deepEqual(c.body.signups.map((s) => s.email), ["new@x.io"]);
  const l = await call("GET", "/api/signups?status=pending", undefined, admin);
  assert.deepEqual(l.body.signups.map((s) => s.email), ["old@x.io"], "legacy record still listed as pending");
});

test("signed review link: GET shows, POST approves, bad sig rejected", async () => {
  await call("POST", "/api/signup", { email: "rv@x.io" });
  const link = sent.find((m) => m.to === "op@example.com").text.match(/https:\S+/)[0];
  const path = new URL(link).pathname + new URL(link).search;
  const g = await call("GET", path);
  assert.equal(g.status, 200);
  assert.match(g.body, /Approve/);
  assert.equal(JSON.parse(await env.INVITES.get("signup:rv@x.io")).status, "pending", "GET has no side effect");

  assert.equal((await call("GET", path.replace(/s=[0-9a-f]{4}/, "s=0000"))).status, 403);

  const r = await worker.fetch(new Request(link, { method: "POST", body: new URLSearchParams({ action: "approve" }) }), env, ctx);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(await env.INVITES.get("signup:rv@x.io")).status, "approved");
});

test("auto-approve sends the invite straight away", async () => {
  env.SIGNUP_AUTO_APPROVE = "1";
  await call("POST", "/api/signup", { email: "auto@x.io" });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /access link/);
});

test("cron drains the Access queue once ready and emails the user", async () => {
  await env.INVITES.put("accessq:q@x.io", "{}");
  await worker.scheduled({}, env, ctx);
  await settle();
  assert.ok(await env.INVITES.get("accessq:q@x.io"), "not ready → stays queued");

  Object.assign(env, { CF_ACCESS_READY: "1", CF_ACCOUNT_ID: "a", CF_ACCESS_APP_ID: "b", CF_ACCESS_POLICY_ID: "c", CF_API_TOKEN: "t" });
  globalThis.fetch = async (u, init) => {
    fetches.push({ u: String(u), init });
    return new Response(JSON.stringify({ success: true, result: { name: "p", include: [] } }));
  };
  await worker.scheduled({}, env, ctx);
  await settle();
  assert.equal(await env.INVITES.get("accessq:q@x.io"), null);
  const put = fetches.find((f) => f.init?.method === "PUT");
  assert.deepEqual(JSON.parse(put.init.body).include, [{ email: { email: "q@x.io" } }]);
  assert.match(sent.at(-1).subject, /access is live/);
});
