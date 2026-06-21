// ==UserScript==
// @name         AdsAlim VM Duplicate Bridge
// @namespace    https://adsalim.com
// @version      1.6.1
// @description  Send adsalim duplicate requests to adsalim-vm (bypasses Vercel timeout + Mixed Content)
// @match        https://www.adsalim.com/*
// @match        https://adsalim.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// ==/UserScript==

(function () {
  if (window.__adsalimVmBridge) {
    console.info("[adsalim-vm] bridge already active");
    return;
  }
  window.__adsalimVmBridge = true;

  const DEFAULT_VM =
    "http://gjn6q90i6z74r6thcxwcj199.178.105.105.85.sslip.io";

  const cfg = {
    url: GM_getValue("adsalim_vm_url", DEFAULT_VM),
    secret: GM_getValue("adsalim_vm_secret", ""),
  };

  let VM_URL = String(cfg.url || DEFAULT_VM).replace(/\/$/, "");
  let VM_SECRET = cfg.secret || "";

  if (!VM_SECRET) {
    VM_SECRET = prompt("TIKTOK_VM_SECRET / SHARED_SECRET:") || "";
    if (VM_SECRET) GM_setValue("adsalim_vm_secret", VM_SECRET);
  }
  if (!VM_SECRET) {
    alert("VM secret required. Open your VM /duplicate/inject page for setup.");
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
      campaignName: pick(body, ["campaignName", "campaign_name", "sourceCampaignName"]),
      names: Array.isArray(names) ? names.map(String) : [],
      cookies: typeof cookies === "string" ? cookies : cookies ? JSON.stringify(cookies) : "",
    };
  }

  function gmRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body,
        onload(resp) {
          let json = {};
          try {
            json = JSON.parse(resp.responseText || "{}");
          } catch {
            /* ignore */
          }
          resolve({ ok: resp.status >= 200 && resp.status < 300, status: resp.status, json });
        },
        onerror: () => reject(new Error("VM network error — check VM URL is running")),
      });
    });
  }

  async function vmDuplicate(payload) {
    const start = await gmRequest(
      "POST",
      `${VM_URL}/duplicate/async`,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VM_SECRET}`,
      },
      JSON.stringify(payload)
    );
    if (!start.ok) throw new Error(start.json.error || `VM start failed (${start.status})`);

    const jobId = start.json.jobId;
    console.info("[adsalim-vm] job started", jobId);

    while (true) {
      await new Promise((r) => setTimeout(r, 2500));
      const poll = await gmRequest("GET", `${VM_URL}/duplicate/jobs/${jobId}`, {
        Authorization: `Bearer ${VM_SECRET}`,
      });
      if (!poll.ok) throw new Error(poll.json.error || `VM poll failed (${poll.status})`);

      const job = poll.json;
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
  console.info("[adsalim-vm] Tampermonkey bridge active →", VM_URL);
})();
