// ==UserScript==
// @name         AdsAlim VM Duplicate Bridge
// @namespace    https://adsalim.com
// @version      1.9.0
// @description  Hijack adsalim Duplicate → VM (20 copies, no Vercel timeout)
// @match        https://www.adsalim.com/*
// @match        https://adsalim.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const w = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  if (w.__adsalimVmBridgeV19) return;
  w.__adsalimVmBridgeV19 = true;

  const DEFAULT_VM = "http://gjn6q90i6z74r6thcxwcj199.178.105.105.85.sslip.io";
  const VM_URL = String(GM_getValue("adsalim_vm_url", DEFAULT_VM)).replace(/\/$/, "");
  let VM_SECRET = GM_getValue("adsalim_vm_secret", "") || "";

  if (!VM_SECRET) {
    VM_SECRET = prompt("TIKTOK_VM_SECRET (Coolify SHARED_SECRET):") || "";
    if (VM_SECRET) GM_setValue("adsalim_vm_secret", VM_SECRET);
  }
  if (!VM_SECRET) return;

  const ADSALIM_COOKIE_PATHS = [
    "/api/tiktok/cookies",
    "/api/tiktok/session",
    "/api/integrations/tiktok/cookies",
    "/api/integrations/tiktok/session",
    "/api/browser/tiktok/cookies",
    "/api/ad-accounts/tiktok/cookies",
    "/api/tiktok/browser/cookies",
  ];

  function pick(obj, keys) {
    if (!obj || typeof obj !== "object") return undefined;
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== "") return obj[k];
    }
    return undefined;
  }

  function isCookieEditorArray(val) {
    return (
      Array.isArray(val) &&
      val.length > 0 &&
      val.every((c) => c && typeof c === "object" && c.name && c.value)
    );
  }

  function cookiesFromObject(obj, depth) {
    if (depth > 10 || obj == null) return "";
    if (typeof obj === "string") {
      const t = obj.trim();
      if (/sessionid_ads/i.test(t)) {
        if (t.startsWith("[")) {
          try {
            const arr = JSON.parse(t);
            if (isCookieEditorArray(arr)) return t;
          } catch {
            /* ignore */
          }
        }
        if (t.includes("sessionid_ads=")) return t;
      }
      return "";
    }
    if (Array.isArray(obj)) {
      if (isCookieEditorArray(obj)) return JSON.stringify(obj);
      for (const item of obj) {
        const hit = cookiesFromObject(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    if (typeof obj === "object") {
      for (const key of ["cookies", "tiktokCookies", "cookie", "session", "data", "value"]) {
        if (obj[key] != null) {
          const hit = cookiesFromObject(obj[key], depth + 1);
          if (hit) return hit;
        }
      }
      for (const v of Object.values(obj)) {
        const hit = cookiesFromObject(v, depth + 1);
        if (hit) return hit;
      }
    }
    return "";
  }

  function findCookiesAnywhere(body) {
    const fromBody = cookiesFromObject(body, 0);
    if (fromBody) return fromBody;

    for (const store of [w.localStorage, w.sessionStorage]) {
      if (!store) continue;
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        const val = store.getItem(key);
        if (!val) continue;
        if (/tiktok|cookie|session|ads/i.test(key)) {
          const hit = cookiesFromObject(val, 0);
          if (hit) return hit;
          try {
            const hit2 = cookiesFromObject(JSON.parse(val), 0);
            if (hit2) return hit2;
          } catch {
            /* ignore */
          }
        }
        if (/sessionid_ads/i.test(val)) {
          const hit = cookiesFromObject(val, 0);
          if (hit) return hit;
          try {
            const hit2 = cookiesFromObject(JSON.parse(val), 0);
            if (hit2) return hit2;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return "";
  }

  function gmRequest(method, url, headers, body, withCredentials) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: headers || {},
        data: body,
        withCredentials: Boolean(withCredentials),
        onload(resp) {
          let json = {};
          try {
            json = JSON.parse(resp.responseText || "{}");
          } catch {
            json = { raw: (resp.responseText || "").slice(0, 500) };
          }
          resolve({ ok: resp.status >= 200 && resp.status < 300, status: resp.status, json, text: resp.responseText || "" });
        },
        onerror: () => reject(new Error("Request failed")),
      });
    });
  }

  async function fetchCookiesFromAdsalimApi() {
    for (const path of ADSALIM_COOKIE_PATHS) {
      try {
        const resp = await gmRequest("GET", `${w.location.origin}${path}`, { Accept: "application/json" }, null, true);
        const hit = cookiesFromObject(resp.json, 0) || cookiesFromObject(resp.text, 0);
        if (hit) {
          console.info("[adsalim-vm] cookies from", path);
          return hit;
        }
      } catch {
        /* try next */
      }
    }
    return "";
  }

  async function resolveCookies(body) {
    let cookies = findCookiesAnywhere(body || {});
    if (cookies) return cookies;
    cookies = await fetchCookiesFromAdsalimApi();
    return cookies;
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

  function extractNames(body) {
    let names = pick(body, ["names", "newNames", "campaignNames", "newCampaignNames", "duplicateNames"]);
    if (Array.isArray(names) && names.length) return names.map(String);

    const count = Number(
      pick(body, ["count", "numCopies", "duplicateCount", "numberOfCopies", "copyCount"]) || 0
    );
    const base = pick(body, ["sourceCampaignName", "campaignName", "campaign_name", "name"]) || "";
    if (count > 0 && base) {
      return Array.from({ length: count }, (_, i) => `Copy ${i + 1} of ${base}`);
    }
    return [];
  }

  function parseModalPayload() {
    const modal =
      w.document.querySelector('[role="dialog"]') ||
      [...w.document.querySelectorAll("div")].find((el) => {
        const t = el.innerText || "";
        return /duplicate campaign/i.test(t) && el.offsetHeight > 80;
      });
    if (!modal) return null;

    const text = modal.innerText || "";
    const sourceLine = text.match(/Source:\s*\n?\s*([^\n]+)/i);
    const sourceName = sourceLine?.[1]?.trim() || "";

    const names = [];
    for (const el of modal.querySelectorAll("li, p, span, div, input, textarea")) {
      const t = (el.value || el.textContent || "").trim();
      if (/^Copy \d+ of /i.test(t)) names.push(t);
    }

    let count = names.length;
    const numInput = modal.querySelector('input[type="number"]');
    if (numInput?.value) count = Math.max(count, Number(numInput.value) || 0);

    if (count > names.length && sourceName) {
      for (let i = names.length + 1; i <= count && i <= 20; i++) {
        names.push(`Copy ${i} of ${sourceName}`);
      }
    }

    const selected =
      w.document.querySelector('[aria-selected="true"][data-campaign-id], tr[data-state="selected"], .selected [data-campaign-id]') ||
      w.document.querySelector('input[type="checkbox"]:checked')?.closest("[data-campaign-id], tr, [data-row-key]");

    const row =
      selected ||
      w.document.querySelector("[data-campaign-id], [data-row-key], tr[data-id]");

    const campaignId =
      selected?.getAttribute("data-campaign-id") ||
      row?.getAttribute("data-campaign-id") ||
      row?.getAttribute("data-row-key") ||
      row?.getAttribute("data-id") ||
      text.match(/campaign[_\s-]?id[:\s]+(\d{10,})/i)?.[1] ||
      "";

    const urlParams = new URLSearchParams(w.location.search);
    const advertiserId =
      urlParams.get("aadvid") ||
      urlParams.get("advertiserId") ||
      w.document.querySelector("[data-advertiser-id]")?.getAttribute("data-advertiser-id") ||
      text.match(/advertiser[_\s-]?id[:\s]+(\d{10,})/i)?.[1] ||
      "";

    return {
      advertiserId: String(advertiserId),
      campaignId: String(campaignId),
      campaignName: sourceName,
      names: names.slice(0, 20),
    };
  }

  function toVmPayload(body, modalFallback, cookies) {
    const modal = modalFallback || parseModalPayload();
    const names = extractNames(body || {});
    const finalNames = names.length ? names : modal?.names || [];

    return {
      advertiserId: String(
        pick(body || {}, ["advertiserId", "advertiser_id", "aadvid"]) || modal?.advertiserId || ""
      ),
      campaignId: String(
        pick(body || {}, ["campaignId", "campaign_id", "sourceCampaignId", "sourceId"]) ||
          modal?.campaignId ||
          ""
      ),
      campaignName:
        pick(body || {}, ["campaignName", "campaign_name", "sourceCampaignName"]) || modal?.campaignName,
      names: finalNames,
      cookies,
    };
  }

  async function vmDuplicate(payload) {
    const start = await gmRequest(
      "POST",
      `${VM_URL}/duplicate/async`,
      { "Content-Type": "application/json", Authorization: `Bearer ${VM_SECRET}` },
      JSON.stringify(payload)
    );
    if (!start.ok) throw new Error(start.json.error || start.json.raw || `VM ${start.status}`);

    const jobId = start.json.jobId;
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await gmRequest("GET", `${VM_URL}/duplicate/jobs/${jobId}`, {
        Authorization: `Bearer ${VM_SECRET}`,
      });
      if (!poll.ok) throw new Error(poll.json.error || "poll failed");
      const job = poll.json;
      updateBadge(`VM ${job.progress?.done || 0}/${job.progress?.total || payload.names.length}`);
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
      ok: okCount > 0,
      success: okCount > 0,
      duplicated: job.duplicated ?? okCount,
      published: job.published ?? okCount,
      total: job.total ?? results.length,
      results,
    };
  }

  function updateBadge(text) {
    let badge = w.document.getElementById("adsalim-vm-badge");
    if (!badge && w.document.documentElement) {
      badge = w.document.createElement("div");
      badge.id = "adsalim-vm-badge";
      badge.style.cssText =
        "position:fixed;bottom:12px;right:12px;z-index:9999999;padding:8px 12px;" +
        "background:#06b6d4;color:#042f2e;font:600 12px system-ui;border-radius:8px;" +
        "box-shadow:0 4px 20px rgba(0,0,0,.4)";
      w.document.documentElement.appendChild(badge);
    }
    if (badge) badge.textContent = text;
  }

  async function runVmDuplicate(body) {
    const modal = parseModalPayload();
    const cookies = await resolveCookies(body);
    const payload = toVmPayload(body, modal, cookies);

    if (!payload.names.length) throw new Error("No campaign names — open Duplicate modal first");
    if (!payload.cookies) {
      throw new Error(
        "No TikTok cookies found — reconnect TikTok in adsalim Settings, then retry"
      );
    }
    if (!payload.advertiserId) throw new Error("Missing advertiser ID");
    if (!payload.campaignId && !payload.campaignName) {
      throw new Error("Missing campaign ID — select campaign row before Duplicate");
    }

    console.info("[adsalim-vm] → VM", payload.names.length, "copies", {
      advertiserId: payload.advertiserId,
      campaignId: payload.campaignId,
      campaignName: payload.campaignName,
      cookieLen: payload.cookies.length,
    });
    updateBadge(`VM running 0/${payload.names.length}…`);

    const job = await vmDuplicate(payload);
    const out = toAdsalimResponse(job);
    const ok = out.published || out.duplicated || 0;
    updateBadge(`VM done ${ok}/${payload.names.length} ✓`);

    try {
      GM_notification({
        title: "AdsAlim VM",
        text: `Duplicate done ${ok}/${payload.names.length}`,
        timeout: 8000,
      });
    } catch {
      /* ignore */
    }

    setTimeout(() => w.location.reload(), 1500);
    return out;
  }

  function isDuplicateButton(el) {
    if (!el) return false;
    const t = (el.innerText || el.textContent || "").trim();
    return /^Duplicate(\s+\d+\s*x)?$/i.test(t) || /^Duplicate$/i.test(t);
  }

  function isDuplicateRequest(url, init) {
    if (String(init?.method || "GET").toUpperCase() !== "POST") return false;
    const u = String(url);
    if (/adsalim\.com/i.test(u) && /duplicate|bulk|campaign|tiktok|smart/i.test(u)) return true;
    const body = normalizeBody(init?.body);
    if (!body) return false;
    return extractNames(body).length > 0 || Boolean(findCookiesAnywhere(body));
  }

  async function handleDuplicateNetwork(_input, init) {
    const body = normalizeBody(init?.body);
    try {
      const out = await runVmDuplicate(body);
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[adsalim-vm]", err);
      return new Response(JSON.stringify({ ok: false, error: String(err.message) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  w.addEventListener(
    "click",
    async (e) => {
      const btn = e.target.closest("button, [role='button']");
      if (!btn || !isDuplicateButton(btn)) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();

      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = "VM duplicating…";

      try {
        await runVmDuplicate(null);
      } catch (err) {
        alert("VM duplicate failed: " + err.message);
        btn.disabled = false;
        btn.textContent = oldText;
      }
    },
    true
  );

  const origFetch = w.fetch.bind(w);
  w.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (isDuplicateRequest(url, init || {})) {
      console.info("[adsalim-vm] fetch intercept", url);
      return handleDuplicateNetwork(input, init || {});
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
      if (isDuplicateRequest(this.__adsalimUrl, { method: this.__adsalimMethod, body })) {
        const self = this;
        handleDuplicateNetwork(this.__adsalimUrl, { body })
          .then(async (resp) => {
            const text = await resp.text();
            Object.defineProperty(self, "status", { value: resp.status });
            Object.defineProperty(self, "responseText", { value: text });
            Object.defineProperty(self, "response", { value: text });
            self.readyState = 4;
            self.dispatchEvent(new Event("readystatechange"));
            self.dispatchEvent(new Event("load"));
          })
          .catch(() => origSend.apply(self, arguments));
        return;
      }
      return origSend.apply(this, arguments);
    };
  }

  w.addEventListener("DOMContentLoaded", () => updateBadge("VM bridge v1.9 ON"));
  if (w.document.readyState !== "loading") updateBadge("VM bridge v1.9 ON");
  console.info("[adsalim-vm] v1.9.0 — button hijack + cookie discovery →", VM_URL);
})();
