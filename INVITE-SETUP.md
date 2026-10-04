<!-- SPDX-License-Identifier: Apache-2.0 -->
# Signup + invite + paywall setup (supachad-landing-api worker)

`worker.js` adds the signup/invite/paywall API. **Deployment model:** the static
landing site stays on **Cloudflare Pages** (the `deploy-landing` Action,
`main → supachad.com`). This Worker (`supachad-landing-api`) is mounted ONLY on
`supachad.com/api/*` and `supachad.com/invite/*` — Worker routes take precedence
over Pages for matching paths, so the site is untouched. The Worker serves no
static assets (every response is generated JSON or the invite HTML).

## Log in to wrangler (one-time)
`wrangler` is the Cloudflare CLI; it needs to be logged in to your Cloudflare
account before it can create KV / set secrets / deploy.

```sh
cd /Users/r/.nemoclaw/supachad-landing
wrangler login
```
This opens your browser to a Cloudflare "Allow wrangler access?" page — click
**Allow**. The terminal then prints "Successfully logged in." Verify with:
```sh
wrangler whoami     # shows your account email + account id (that's CF_ACCOUNT_ID)
```
If the browser doesn't open, wrangler prints a URL — paste it into a browser
manually. (In this Claude session you can run these by typing `! wrangler login`.)

## One-time setup
1. **KV namespace:** `wrangler kv namespace create INVITES` → paste the printed id
   into `wrangler.toml` (`[[kv_namespaces]] id`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`).
2. **Admin secret** (needed now — gates invite minting + `/api/premium/list`):
   ```sh
   wrangler secret put ADMIN_SECRET          # paste a long random string; save it
   ```
3. **Deploy:** `wrangler deploy`  → invite links + signup are live immediately.
4. **Later — Stripe** (see Paywall below): `wrangler secret put STRIPE_WEBHOOK_SECRET`.
5. **Later — CF Access auto-grant** (see CF token scope below): set the 4 CF secrets
   and flip `CF_ACCESS_READY = "1"` in `wrangler.toml`, then `wrangler deploy`.

## Host bridge (premium → shim allowlist)
After the worker is deployed, install the host cron that turns premium grants into
real `chad` access:
1. Add to `~/.nemoclaw/credentials.json`:
   `"PREMIUM_LIST_URL": "https://supachad.com/api/premium/list"`,
   `"PREMIUM_ADMIN_SECRET": "<the ADMIN_SECRET above>"`.
2. Dry-run once: `scripts/openwebui/sync-premium-allowlist.sh`.
3. Install the 15-min launchd job:
   ```sh
   cp scripts/openwebui/dev.nemoclaw.chad-premium-sync.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/dev.nemoclaw.chad-premium-sync.plist
   ```

## Use
- **Signup:** `POST /api/signup {email, note?}` (wire a form on index.html to this).
- **Mint invite:** `POST /api/invite/mint {email, tier}` with `X-Admin-Secret`
  → returns `{url: https://.../invite/<token>}` (single-use, 14-day TTL).
  `tier` = `lite` (default) or `premium`.
- **Redeem:** the user opens `/invite/<token>` → email added to CF Access
  (queued until `CF_ACCESS_READY=1`); premium tier recorded to KV `premium:<email>`.

## Paywall (Stripe) — `POST /api/stripe/webhook`
1. Create a Stripe **Payment Link** (or Checkout) for the premium plan; set its
   success URL to `https://chad.supachad.com`.
2. Stripe Dashboard → Developers → Webhooks → add endpoint
   `https://<worker-host>/api/stripe/webhook`, event `checkout.session.completed`
   (add `invoice.paid` too for renewals). Copy the signing secret (`whsec_…`).
3. `wrangler secret put STRIPE_WEBHOOK_SECRET`.
4. On a paid checkout the worker verifies the `Stripe-Signature` HMAC (5-min replay
   window), extracts the customer email, and records a premium grant exactly like a
   `premium` invite redemption (KV `premium:<email>` + queued CF Access add).

## Premium tier → pod allowlist (automated bridge)
A premium grant (invite **or** Stripe) writes KV `premium:<email>`. The shim gate
reads `CHAD_OPERATOR_ALLOWLIST` from the pod's `credentials.json` — the Worker can't
write there. The bridge is `scripts/openwebui/sync-premium-allowlist.sh` (run from
the host; wire as a cron): it GETs `/api/premium/list` with `X-Admin-Secret`, merges
the emails into `CHAD_OPERATOR_ALLOWLIST` in `credentials.json`, and runs
`chad-ops gate-sync`. Free (`lite`) needs no pod change — chad-lite is public once CF
Access lets the email in.

## CF API token scope — the blocker for auto-grant
`addToCloudflareAccess()` and `CF_ACCESS_READY="1"` stay off until the token can edit
Access. See the "CF token scope" section below; until then every grant is **queued**
in KV (redemption still succeeds and the user is told they're being provisioned).

### Required token scope
Create at Cloudflare dashboard → **My Profile → API Tokens → Create Token → Custom token**:

| Permission group | Resource | Access |
|---|---|---|
| **Access: Apps and Policies** | Account → *(your account)* | **Edit** |
| Access: Organizations, Identity Providers, and Groups | Account | Read *(optional, for lookups)* |

- Scope it to the single account (`CF_ACCOUNT_ID`); no Zone perms are needed for the
  Access policy edit.
- The worker calls `GET/PUT /accounts/{CF_ACCOUNT_ID}/access/apps/{CF_ACCESS_APP_ID}/policies/{CF_ACCESS_POLICY_ID}`
  — appends `{email:{email}}` to the policy's `include` list. That single endpoint
  needs **Access: Apps and Policies: Edit** and nothing more.
- The existing `CF_API_TOKEN` in `scripts/openwebui/.env` is a *different, narrower*
  token (lacks both Cache-Purge and Access:Edit). Mint a dedicated token for the
  worker rather than widening that one.
- Find `CF_ACCESS_APP_ID` / `CF_ACCESS_POLICY_ID` via
  `GET /accounts/{acct}/access/apps` then `…/apps/{app}/policies` (needs the new
  token, or do it in the dashboard: Zero Trust → Access → Applications →
  chad.supachad.com → Policies).
