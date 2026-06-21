/**
 * Paste on www.adsalim.com (DevTools console) OR install as Tampermonkey userscript.
 * Intercepts adsalim duplicate API calls and runs them on the VM (no Vercel timeout).
 */
(function () {
  if (window.__adsalimVmBridge) {
    console.info("[adsalim-vm] bridge already active");
    return;
  }
  window.__adsalimVmBridge = true;

  const DEFAULT_VM =
    "http://gjn6q90i6z74r6thcxwcj199.178.105.105.85.sslip.io";
  const cfg = (() => {
    try {
      return JSON.parse(localStorage.getItem("adsalim_vm_bridge") || "{}");
    } catch {
      return {};
    }
  })();

  const VM_URL = (cfg.url || DEFAULT_VM).replace(/\/$/, "");
  let VM_SECRET = cfg.secret || "";
  if (!VM_SECRET) {
    VM_SECRET = prompt("TIKTOK_VM_SECRET / SHARED_SECRET:") || "";
    if (VM_SECRET) {
      localStorage.setItem(
        "adsalim_vm_bridge",
        JSON.stringify({ url: VM_URL, secret: VM_SECRET })
      );
    }
  }
  if (!VM_SECRET) {
    alert("VM secret required. Open /duplicate/inject on the VM for setup.");
    return;
  }

  function pick(obj, keys) {
    for (const k of keys) {
      if (obj && obj[k] != null && obj[k] !== "") return obj[k];
    }
    return undefined;
  }

  function normalizeBody(raw) {
    if (!raw) return null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  }

  function toVmPayload(body) {
    const names = pick(body, ["names", "newNames", "campaignNames", "copies"]);
    const cookies = pick(body, ["cookies", "cookie", "tiktokCookies", "tiktok_cookies"]);
    return {
      advertiserId: String(
        pick(body, ["advertiserId", "advertiser_id", "aadvid", "advertiserID"]) || ""
      ),
      campaignId: String(
        pick(body, ["campaignId", "campaign_id", "sourceCampaignId", "sourceId"]) || ""
      ),
      names: Array.isArray(names) ? names.map(String) : [],
      cookies: typeof cookies === "string" ? cookies : cookies ? JSON.stringify(cookies) : "",
    };
  }

  async function vmDuplicate(payload) {
    const start = await fetch(`${VM_URL}/duplicate/async`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VM_SECRET}`,
      },
      body: JSON.stringify(payload),
    });
    const startBody = await start.json().catch(() => ({}));
    if (!start.ok) throw new Error(startBody.error || `VM start failed (${start.status})`);

    const jobId = startBody.jobId;
    console.info("[adsalim-vm] job started", jobId);

    while (true) {
      await new Promise((r) => setTimeout(r, 2500));
      const poll = await fetch(`${VM_URL}/duplicate/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${VM_SECRET}` },
      });
      const job = await poll.json().catch(() => ({}));
      if (!poll.ok) throw new Error(job.error || `VM poll failed (${poll.status})`);

      const done = job.progress?.done ?? 0;
      const total = job.progress?.total ?? payload.names.length;
      console.info(`[adsalim-vm] ${job.phase || job.status} ${done}/${total}`);

      if (job.status === "completed" || job.status === "failed") {
        return job;
      }
    }
  }

  function isDuplicateRequest(url, init) {
    const method = (init?.method || "GET").toUpperCase();
    if (method !== "POST") return false;
    const u = String(url);
    if (/duplicate/i.test(u)) return true;
    const body = normalizeBody(init?.body);
    if (!body || typeof body !== "object") return false;
    const names = pick(body, ["names", "newNames", "campaignNames"]);
    const cid = pick(body, ["campaignId", "campaign_id", "sourceCampaignId"]);
    return Array.isArray(names) && names.length > 0 && !!cid;
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (isDuplicateRequest(url, init)) {
      const body = normalizeBody(init?.body);
      const payload = toVmPayload(body);
      if (!payload.advertiserId || !payload.campaignId || !payload.names.length || !payload.cookies) {
        console.warn("[adsalim-vm] could not map duplicate body, falling back", body);
        return origFetch(input, init);
      }

      console.info("[adsalim-vm] intercepting duplicate → VM", payload.names.length, "copies");
      try {
        const job = await vmDuplicate(payload);
        return new Response(JSON.stringify(job), {
          status: job.ok ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: String(err.message || err) }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }
    return origFetch(input, init);
  };

  const badge = document.createElement("div");
  badge.textContent = "VM duplicate bridge ON";
  badge.style.cssText =
    "position:fixed;bottom:12px;right:12px;z-index:999999;padding:8px 12px;" +
    "background:#06b6d4;color:#042f2e;font:600 12px system-ui;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.4)";
  document.documentElement.appendChild(badge);
  console.info("[adsalim-vm] bridge active →", VM_URL);
})();
