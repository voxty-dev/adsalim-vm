// ==UserScript==
// @name         AdsAlim VM Duplicate Bridge
// @namespace    https://adsalim.com
// @version      1.7.0
// @description  Intercept adsalim duplicate on Vercel → run on VM (20 copies, no timeout)
// @match        https://www.adsalim.com/*
// @match        https://adsalim.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const w = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (w.__adsalimVmBridge) return;

  const DEFAULT_VM = "http://gjn6q90i6z74r6thcxwcj199.178.105.105.85.sslip.io";
  let VM_URL = String(GM_getValue("adsalim_vm_url", DEFAULT_VM)).replace(/\/$/, "");
  let VM_SECRET = GM_getValue("adsalim_vm_secret", "") || "";

  if (!VM_SECRET) {
    VM_SECRET = prompt("TIKTOK_VM_SECRET (Coolify SHARED_SECRET):") || "";
    if (VM_SECRET) GM_setValue("adsalim_vm_secret", VM_SECRET);
  }
  if (!VM_SECRET) {
    alert("VM secret required — open VM /duplicate/inject");
    return;
  }

  w.__adsalimVmBridge = true;

  function pick(obj, keys) {
    if (!obj || typeof obj !== "object") return undefined;
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== "") return obj[k];
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
    if (raw instanceof FormData) return null;
    return raw;
  }

  function extractNames(body) {
    let names = pick(body, [
      "names",
      "newNames",
      "campaignNames",
      "newCampaignNames",
      "copies",
      "duplicateNames",
    ]);
    if (Array.isArray(names) && names.length) return names.map(String);

    const count = Number(
      pick(body, ["count", "numCopies", "duplicateCount", "copiesCount", "numberOfCopies", "copyCount"]) || 0
    );
    const base =
      pick(body, ["sourceCampaignName", "campaignName", "campaign_name", "baseName", "name"]) ||
      "Campaign";
    if (count > 0 && count <= 20) {
      return Array.from({ length: count }, (_, i) => `Copy ${i + 1} of ${base}`);
    }
    return [];
  }

  function extractCookies(body) {
    const c = pick(body, [
      "cookies",
      "cookie",
      "tiktokCookies",
      "tiktok_cookies",
      "tiktokCookie",
      "sessionCookies",
      "cookieString",
    ]);
    if (typeof c === "string" && c.length > 10) return c;
    if (c && typeof c === "object") return JSON.stringify(c);
    if (body.session?.cookies) return extractCookies(body.session);
    return "";
  }

  function toVmPayload(body) {
    const names = extractNames(body);
    return {
      advertiserId: String(
        pick(body, ["advertiserId", "advertiser_id", "aadvid", "advertiserID", "advertiser"]) || ""
      ),
      campaignId: String(
        pick(body, [
          "campaignId",
          "campaign_id",
          "sourceCampaignId",
          "sourceId",
          "id",
          "source_campaign_id",
        ]) || ""
      ),
      campaignName: pick(body, ["campaignName", "campaign_name", "sourceCampaignName", "name"]),
      names,
      cookies: extractCookies(body),
    };
  }

  function isDuplicateRequest(url, init) {
    const method = String(init?.method || "GET").toUpperCase();
    if (method !== "POST") return false;
    const u = String(url);
    if (/duplicate|bulk.*campaign|campaign.*bulk|smart\+|smartplus|tiktok.*copy/i.test(u)) return true;
    const body = normalizeBody(init?.body);
    if (!body || typeof body !== "object") return false;
    const names = extractNames(body);
    const cid = pick(body, ["campaignId", "campaign_id", "sourceCampaignId", "sourceId"]);
    const adv = pick(body, ["advertiserId", "advertiser_id", "aadvid"]);
    const cookies = extractCookies(body);
    if (names.length >= 1 && (cid || adv) && cookies) return true;
    if (names.length >= 1 && /api\//i.test(u) && cookies) return true;
    return false;
  }

  function gmRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: headers || {},
        data: body,
        onload(resp) {
          let json = {};
          try {
            json = JSON.parse(resp.responseText || "{}");
          } catch {
            json = { raw: (resp.responseText || "").slice(0, 200) };
          }
          resolve({ ok: resp.status >= 200 && resp.status < 300, status: resp.status, json });
        },
        onerror: () => reject(new Error("VM unreachable — redeploy Coolify?")),
      });
    });
  }

  async function vmDuplicate(payload) {
    const start = await gmRequest(
      "POST",
      `${VM_URL}/duplicate/async`,
      { "Content-Type": "application/json", Authorization: `Bearer ${VM_SECRET}` },
      JSON.stringify(payload)
    );
    if (!start.ok) throw new Error(start.json.error || start.json.raw || `VM start ${start.status}`);

    const jobId = start.json.jobId;
    console.info("[adsalim-vm] VM job", jobId, payload.names.length, "copies");

    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await gmRequest("GET", `${VM_URL}/duplicate/jobs/${jobId}`, {
        Authorization: `Bearer ${VM_SECRET}`,
      });
      if (!poll.ok) throw new Error(poll.json.error || `VM poll ${poll.status}`);
      const job = poll.json;
      console.info("[adsalim-vm]", job.phase, job.progress?.done, "/", job.progress?.total);
      if (job.status === "completed" || job.status === "failed") return job;
    }
  }

  function toAdsalimResponse(job) {
    const results = (job.results || []).map((r) => ({
      ok: r.ok,
      name: r.name,
      campaignId: r.newCampaignId,
      newCampaignId: r.newCampaignId,
      error: r.error,
    }));
    const okCount = results.filter((r) => r.ok).length;
    return {
      ok: job.ok !== false && okCount > 0,
      success: job.ok !== false && okCount > 0,
      duplicated: job.duplicated ?? okCount,
      published: job.published ?? okCount,
      total: job.total ?? results.length,
      results,
    };
  }

  async function handleDuplicate(input, init, origFetch) {
    const url = typeof input === "string" ? input : input?.url || "";
    const body = normalizeBody(init?.body);
    const payload = toVmPayload(body);

    if (!payload.names.length) {
      console.warn("[adsalim-vm] no names in body", body);
      return origFetch(input, init);
    }
    if (!payload.cookies) {
      console.warn("[adsalim-vm] no cookies — falling back to Vercel (will stop at ~5)");
      return origFetch(input, init);
    }
    if (!payload.advertiserId || !payload.campaignId) {
      console.warn("[adsalim-vm] missing advertiser/campaign id", payload);
      return origFetch(input, init);
    }

    console.info("[adsalim-vm] INTERCEPT → VM", payload.names.length, "copies", url);
    showBadge(true);

    try {
      const job = await vmDuplicate(payload);
      const out = toAdsalimResponse(job);
      return new Response(JSON.stringify(out), {
        status: out.ok ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[adsalim-vm]", err);
      return new Response(
        JSON.stringify({ ok: false, success: false, error: String(err.message || err) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  function showBadge(intercepted) {
    let badge = w.document.getElementById("adsalim-vm-badge");
    if (!badge && w.document.documentElement) {
      badge = w.document.createElement("div");
      badge.id = "adsalim-vm-badge";
      badge.style.cssText =
        "position:fixed;bottom:12px;right:12px;z-index:999999;padding:8px 12px;" +
        "background:#06b6d4;color:#042f2e;font:600 12px system-ui;border-radius:8px;" +
        "box-shadow:0 4px 20px rgba(0,0,0,.4)";
      w.document.documentElement.appendChild(badge);
    }
    if (badge) {
      badge.textContent = intercepted ? "VM bridge — intercepted ✓" : "VM duplicate bridge ON";
    }
  }

  const origFetch = w.fetch.bind(w);
  w.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (isDuplicateRequest(url, init || {})) {
      return handleDuplicate(input, init || {}, origFetch);
    }
    return origFetch(input, init);
  };

  const XHR = w.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__adsalimMethod = method;
      this.__adsalimUrl = url;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const self = this;
      if (isDuplicateRequest(this.__adsalimUrl, { method: this.__adsalimMethod, body })) {
        const payload = toVmPayload(normalizeBody(body));
        if (payload.names.length && payload.cookies && payload.advertiserId && payload.campaignId) {
          console.info("[adsalim-vm] INTERCEPT XHR → VM", payload.names.length);
          showBadge(true);
          vmDuplicate(payload)
            .then((job) => {
              const out = toAdsalimResponse(job);
              const text = JSON.stringify(out);
              Object.defineProperty(self, "status", { value: out.ok ? 200 : 500 });
              Object.defineProperty(self, "responseText", { value: text });
              Object.defineProperty(self, "response", { value: text });
              self.readyState = 4;
              self.dispatchEvent(new Event("readystatechange"));
              self.dispatchEvent(new Event("load"));
            })
            .catch((err) => {
              const text = JSON.stringify({ ok: false, error: String(err.message || err) });
              Object.defineProperty(self, "status", { value: 500 });
              Object.defineProperty(self, "responseText", { value: text });
              self.readyState = 4;
              self.dispatchEvent(new Event("load"));
            });
          return;
        }
      }
      return origSend.apply(this, arguments);
    };
  }

  w.addEventListener("DOMContentLoaded", () => showBadge(false));
  if (w.document.readyState !== "loading") showBadge(false);
  console.info("[adsalim-vm] bridge v1.7.0 active →", VM_URL);
})();
