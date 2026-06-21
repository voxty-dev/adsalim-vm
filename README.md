# adsalim-vm-service

Headless-browser microservice that duplicates **and publishes** TikTok Smart+
campaigns. adsalim's main app (on Vercel) calls this service over HTTP; this
service runs real Chromium via Playwright on a long-running VM, which is the
only way to bypass TikTok's anti-bot validation on the publish endpoint.

## Why a separate service

- Vercel serverless can't run Chromium reliably (missing shared libraries,
  function size limits).
- Direct HTTP replay of TikTok's UI requests fails on the publish step
  because TikTok's X-Bogus signature is body-dependent — changing the body
  invalidates it and TikTok silently drops the request.
- Real Chromium driving the UI generates fresh signatures per click, so
  TikTok accepts both the duplicate AND the publish.

## Deploy on Railway (~5 minutes, $5/month)

1. Push the `vm-service/` folder to its own GitHub repo (or set the
   "Root Directory" in Railway to `/vm-service`).
2. Sign up at <https://railway.app> → New Project → Deploy from GitHub.
3. Railway detects the `Dockerfile` and builds.
4. In Railway → Variables, set:
   - `SHARED_SECRET=<random long string>` — adsalim must send this as
     `Authorization: Bearer …`.
   - `PORT=3000` (Railway provides one automatically — usually fine to skip).
5. Once deployed, Railway gives you a public URL like
   `https://adsalim-vm-service-production.up.railway.app`.
6. Test:

   ```bash
   curl https://<your-railway-url>/
   # → {"service":"adsalim-vm-service","status":"ok"}
   ```

7. In adsalim Vercel env vars, add:
   - `TIKTOK_VM_URL=https://<your-railway-url>`
   - `TIKTOK_VM_SECRET=<same SHARED_SECRET>`

   Redeploy adsalim.

## Alternative hosts

- **Render**: same Docker flow, $7/mo
- **Fly.io**: `flyctl deploy` from this folder, ~$2-5/mo
- **Hetzner / DigitalOcean droplet**: $5/mo, install Docker + `docker run`

## API

### `POST /duplicate`

Headers: `Authorization: Bearer <SHARED_SECRET>`, `Content-Type: application/json`

Body:
```json
{
  "advertiserId": "7559481394611798032",
  "campaignId": "1863630626273666",
  "names": ["Copy 1 of PRST TR G6", "Copy 2 of PRST TR G6"],
  "cookies": "sessionid_ads=...; csrftoken=...; ..."
}
```

Response:
```json
{
  "ok": true,
  "duplicated": 20,
  "published": 18,
  "total": 20,
  "results": [
    { "name": "Copy 1 of PRST TR G6", "ok": true, "newCampaignId": "1866..." },
    { "name": "Copy 2 of PRST TR G6", "ok": false, "error": "..." }
  ]
}
```

Flow: duplicate all drafts in one browser session, then publish in parallel (up to 8 at once).

### `POST /duplicate/async` (recommended for 20 copies)

Same body as `/duplicate`. Returns immediately with a job id so Vercel/adsalim does not time out:

```json
{ "jobId": "dup-171...", "status": "running", "pollUrl": "/duplicate/jobs/dup-171..." }
```

Poll `GET /duplicate/jobs/:jobId` until `status` is `completed` or `failed`. Progress fields: `phase` (`duplicating` | `publishing`), `progress.done`, `progress.total`.

**adsalim Browser (Smart+) mode should call this instead of replaying duplicate on Vercel.**

### `GET /duplicate/inject`

One-time browser fix for adsalim.com (when duplicate stops at ~4–5):

1. Open `https://<your-vm-url>/duplicate/inject`
2. Copy the script → paste in adsalim.com DevTools console
3. Duplicate 10x/20x as normal — requests go to VM async, not Vercel

Requires CORS (`CORS_ORIGINS` defaults to `https://www.adsalim.com`).

Browser tool to run 6–20 copies directly on the VM (bypasses adsalim.com timeout). Open:

`https://<your-vm-url>/duplicate/ui`

Paste `SHARED_SECRET`, advertiser/campaign IDs, names, and cookies. Uses `/duplicate/async` with live polling.

**Why adsalim stops at ~5:** Vercel serverless times out after ~5 serial duplicate+publish cycles. The UI error `Unexpected token 'A'` is Vercel returning `"An error occurred..."` instead of JSON.

## When selectors break

TikTok ships UI changes regularly. When the duplicate flow stops working,
the selectors in `duplicateAndPublishOnce()` in `server.js` are the only
piece that needs updating:
- Row finder: `[data-row-key="${campaignId}"]` / `[data-id="${campaignId}"]`
- Duplicate trigger: button with text matching `/duplicate|copy/`
- Modal submit: button with text matching `/^(duplicate|confirm|submit|ok)$/`
- Publish trigger: button accessible name matching `/publish all|publish/`

Re-test locally with `npm start` and a debugger.
