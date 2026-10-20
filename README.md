# supachad-landing

Single-page landing site for **supachad.com**.

Pure static — `index.html` plus an `assets/` dir. No build step, no
framework, no JS framework dependencies. Embedded CSS keeps the deploy
artifact to one HTTP request for first paint.

## Local preview

```bash
python3 -m http.server 8000   # or: bunx serve .
open http://localhost:8000
```

## Deploy

The site is the Workers static-assets Worker `supachad-landing`, deployed by Cloudflare
Workers Builds on every push to `main` (root `wrangler.toml`, no build step). Pull
requests get a preview build. Only `index.html` and `assets/` are published: see
`.assetsignore`, and add any new top-level site file there.

## Editing

- Visual identity is dark navy + warm amber + cool teal. Tokens live
  at the top of the `<style>` block in `index.html` as CSS custom
  properties (`--bg`, `--accent`, etc).
- "Recent ships" section is hand-curated. Update on each significant
  feat commit to `chad-dev`. Auto-syncing from git log is a future
  improvement (build-time fetch via a Pages function).
- The Chad mark is at `assets/chad-mark.svg`. Three concentric circles
  (matching the three-ring isolation diagram on the page) plus a
  delegated-spawn dot.

## License

Site content: see repo root LICENSE (or operator's choice).

The visual identity (mark, palette, copy) is original. Upstream
dependency wordmarks in the "Built on" section are nominative
references — no brand assets are reproduced; each card is plain text
linking to the upstream's official site.

## API Worker (`api/`)

`supachad.com/api/*` and `/invite/*` are served by a separate Worker,
`supachad-landing-api` (signup, invites, Square checkout/webhooks, credits). Deploy it from
`api/` with `npx wrangler deploy`; secrets are set with `wrangler secret put`. See
`api/INVITE-SETUP.md`. Its routes take precedence over the site Worker on those paths.
