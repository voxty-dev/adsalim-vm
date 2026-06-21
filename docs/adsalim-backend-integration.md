# adsalim backend → VM integration

Permanent fix: adsalim duplicate route calls the VM instead of running Playwright on Vercel.

## Environment (Vercel / adsalim)

```env
TIKTOK_VM_URL=http://gjn6q90i6z74r6thcxwcj199.178.105.105.85.sslip.io
TIKTOK_VM_SECRET=<same as Coolify SHARED_SECRET>
```

## Replace Browser (Smart+) duplicate handler

Where adsalim currently loops duplicate+publish on Vercel (~4–5 copies then timeout), use async VM job:

```typescript
const VM_URL = process.env.TIKTOK_VM_URL!;
const VM_SECRET = process.env.TIKTOK_VM_SECRET!;

export async function duplicateCampaignsViaVm(params: {
  advertiserId: string;
  campaignId?: string;
  campaignName?: string;
  names: string[];
  cookies: string | unknown[]; // Cookie-Editor JSON from stored TikTok session
}) {
  const start = await fetch(`${VM_URL}/duplicate/async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VM_SECRET}`,
    },
    body: JSON.stringify(params),
  });
  if (!start.ok) {
    const err = await start.json().catch(() => ({}));
    throw new Error(err.error || `VM start failed ${start.status}`);
  }
  const { jobId } = await start.json();

  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${VM_URL}/duplicate/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${VM_SECRET}` },
    });
    const job = await poll.json();
    if (job.status === "completed" || job.status === "failed") {
      return job;
    }
  }
}
```

## Response shape (match existing adsalim UI)

VM returns:

```json
{
  "ok": true,
  "duplicated": 17,
  "published": 17,
  "total": 17,
  "results": [{ "name": "Copy 1 of …", "ok": true, "newCampaignId": "…" }]
}
```

Map `published` / `duplicated` to whatever the Smart+ UI expects today.

## Until backend is updated

Users can install Tampermonkey bridge v1.9 from VM `/duplicate/inject` — hijacks Duplicate button and sends full payload to VM.

## Coolify

Redeploy `adsalim-vm` from `main` after each VM update. Confirm version at `GET /` → `"version": "1.9.0"`.
