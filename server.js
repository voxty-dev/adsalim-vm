/**
 * adsalim-vm-service
 *
 * Duplicates and publishes TikTok Smart+ campaigns via Playwright.
 * adsalim should call POST /duplicate/async (not Vercel cURL) for 20 copies.
 *
 * Endpoints:
 *   POST /duplicate         — sync duplicate + publish (slow for 20; may timeout proxies)
 *   POST /duplicate/async   — start job, returns jobId immediately
 *   GET  /duplicate/jobs/:id — poll job progress/results
 *   POST /publish-draft     — single draft
 *   POST /publish-batch     — up to 20 drafts in parallel
 *   GET  /screenshots/:id
 */

const express = require("express");
const path = require("path");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || "";
const MAX_CONCURRENT_PUBLISH = Number(process.env.MAX_CONCURRENT_PUBLISH || 8);
const SERVICE_VERSION = "1.6.2";

function detectTikTokBlocker(bodyText) {
  const t = String(bodyText || "");
  if (/log in|sign in|passport/i.test(t) && !/campaign|dashboard/i.test(t)) {
    return "TikTok login page — cookies expired, re-export JSON";
  }
  return null;
}
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "https://www.adsalim.com,https://adsalim.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_DUPLICATE_JOBS = 30;

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.json({
    service: "adsalim-vm-service",
    status: "ok",
    version: SERVICE_VERSION,
    maxConcurrentPublish: MAX_CONCURRENT_PUBLISH,
    endpoints: [
      "/test-cookies",
      "/duplicate/inject",
      "/adsalim-bridge.user.js",
      "/duplicate/ui",
      "/duplicate",
      "/duplicate/async",
      "/duplicate/jobs/:id",
      "/publish-draft",
      "/publish-batch",
      "/screenshots/:id",
    ],
  });
});

function buildEditorUrl(advertiserId, campaignSketchId) {
  return (
    `https://ads.tiktok.com/i18n/creation/1nn/create/campaign?aadvid=${encodeURIComponent(advertiserId)}` +
    `&source=campaign_list` +
    `&campaign_draft_id=${encodeURIComponent(campaignSketchId)}` +
    `&creation_type=create_new` +
    `&objective_type=3` +
    `&temp_campaign_id=${encodeURIComponent(campaignSketchId)}`
  );
}

const screenshots = new Map();
const duplicateJobs = new Map();
let screenshotCounter = 0;
let activePublishJobs = 0;
const publishWaiters = [];
let sharedBrowserPromise = null;

function acquirePublishSlot() {
  if (activePublishJobs < MAX_CONCURRENT_PUBLISH) {
    activePublishJobs++;
    return Promise.resolve();
  }
  return new Promise((resolve) => publishWaiters.push(resolve));
}

function releasePublishSlot() {
  activePublishJobs--;
  const next = publishWaiters.shift();
  if (next) {
    activePublishJobs++;
    next();
  }
}

async function getSharedBrowser() {
  if (sharedBrowserPromise) {
    try {
      const browser = await sharedBrowserPromise;
      if (!browser.isConnected()) {
        sharedBrowserPromise = null;
      } else {
        return browser;
      }
    } catch {
      sharedBrowserPromise = null;
    }
  }
  sharedBrowserPromise = chromium.launch({
    headless: true,
    args: BROWSER_ARGS,
  }).catch((err) => {
    sharedBrowserPromise = null;
    throw err;
  });
  return sharedBrowserPromise;
}

async function resetSharedBrowser() {
  if (sharedBrowserPromise) {
    try {
      const b = await sharedBrowserPromise;
      await b.close().catch(() => {});
    } catch {
      /* ignore */
    }
    sharedBrowserPromise = null;
  }
}

async function verifyTikTokSession({ advertiserId, cookies }) {
  const cookieErr = validateCookies(cookies);
  if (cookieErr) return { ok: false, error: cookieErr };

  let context;
  try {
    const browser = await getSharedBrowser();
    context = await createTikTokContext(browser, cookies);
    const page = await context.newPage();
    const url = `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${encodeURIComponent(advertiserId || "")}`;
    const diag = await prepareCampaignListPage(page, url);
    if (page.url().includes("/login") || page.url().includes("/passport")) {
      return { ok: false, error: "Login page — sessionid_ads expired, re-copy JSON cookies" };
    }
    return {
      ok: true,
      message:
        diag.rowKeys > 0
          ? `TikTok OK — ${diag.rowKeys} campaigns visible`
          : "Session OK — will duplicate via campaign detail URL (phone popup ignored)",
      url: diag.url,
    };
  } catch (err) {
    await resetSharedBrowser();
    if (String(err.message) === "LOGIN") {
      return { ok: false, error: "Login page — sessionid_ads expired, re-copy from Application tab" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Session check failed" };
  } finally {
    await context?.close().catch(() => {});
  }
}

async function createTikTokContext(browser, cookies) {
  const parsed = parseCookies(cookies);
  if (parsed.length === 0) throw new Error("No usable cookies parsed");

  const isJsonExport = String(cookies).trim().startsWith("[");
  const toAdd = isJsonExport
    ? parsed
    : parsed.flatMap((c) => [
        { ...c, domain: ".tiktok.com", path: c.path || "/" },
        { ...c, domain: "ads.tiktok.com", path: c.path || "/" },
      ]);

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "Europe/Madrid",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  await context.addCookies(toAdd);
  return context;
}

async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const clicked = await page
      .evaluate(() => {
        let n = 0;
        const ok = (t) =>
          /^(got it|ok|close|skip|later|not now|später|abbrechen|cancel|dismiss|×|✕|i understand|confirm)$/i.test(
            t.trim()
          );
        for (const el of Array.from(
          document.querySelectorAll('button, [role="button"], a, span, [class*="close" i]')
        )) {
          const t = (el.innerText || el.textContent || "").trim();
          if (ok(t) && !el.disabled) {
            try {
              el.click();
              n++;
            } catch {
              /* ignore */
            }
          }
        }
        return n;
      })
      .catch(() => 0);
    if (!clicked) break;
    await page.waitForTimeout(500);
  }
}

async function readPageDiagnostics(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    rowKeys: document.querySelectorAll("[data-row-key]").length,
    tableRows: document.querySelectorAll("table tbody tr").length,
    bodyStart: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 350),
  }));
}

async function prepareCampaignListPage(page, listUrl) {
  await page.goto("https://ads.tiktok.com/", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  }).catch(() => {});
  await page.waitForTimeout(1200);

  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(2000);

  if (page.url().includes("/login") || page.url().includes("/passport")) {
    throw new Error("LOGIN");
  }

  for (let attempt = 0; attempt < 25; attempt++) {
    await dismissOverlays(page);
    const diag = await readPageDiagnostics(page);
    const blocker = detectTikTokBlocker(diag.bodyStart);
    if (blocker) throw new Error(blocker);
    if (diag.rowKeys > 0 || diag.tableRows > 1) return diag;

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2500);

    const tabClicked = await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll("button, a, [role='tab'], div, span"))) {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (t === "campaign" || t === "campaigns" || t.startsWith("campaigns ")) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (tabClicked) await page.waitForTimeout(2000);
  }

  return readPageDiagnostics(page);
}

function publishAllSelector() {
  return 'button, [role="button"], a, div, span, [class*="btn" i], [class*="button" i]';
}

async function isPublishAllVisible(page) {
  if (page.isClosed()) return false;
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel)).some((el) => {
      if (el.disabled) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const text = (el.innerText || el.textContent || "").trim().toLowerCase();
      return /^publish all(\s*[▾▼⌄↓])?$|^publish$/.test(text);
    });
  }, publishAllSelector()).catch(() => false);
}

async function clickButtonMatching(page, patternSource, patternFlags) {
  if (page.isClosed()) return null;
  return page
    .evaluate(
      ({ patSource, patFlags }) => {
        const pat = new RegExp(patSource, patFlags);
        for (const b of document.querySelectorAll("button, [role='button']")) {
          const t = (b.innerText || b.textContent || "").trim();
          if (pat.test(t) && !b.disabled) {
            b.click();
            return t;
          }
        }
        return null;
      },
      { patSource: patternSource, patFlags: patternFlags }
    )
    .catch(() => null);
}

async function prepareEditorForPublish(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastAction = "waiting";

  while (Date.now() < deadline) {
    if (page.isClosed()) return { ready: false, lastAction: "page_closed" };
    if (await isPublishAllVisible(page)) {
      return { ready: true, lastAction: "publish_visible" };
    }

    const gotIt = await clickButtonMatching(page, "^got it$", "i");
    if (gotIt) {
      lastAction = "got_it";
      await page.waitForTimeout(500);
      continue;
    }

    const createAnyway = await clickButtonMatching(page, "create anyway", "i");
    if (createAnyway) {
      lastAction = "create_anyway";
      await page.waitForTimeout(1500);
      continue;
    }

    const continued = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const cont = buttons.find((b) => {
        const t = (b.innerText || b.textContent || "").trim().toLowerCase();
        return t === "continue" && !b.disabled;
      });
      if (cont) {
        cont.click();
        return true;
      }
      return false;
    }).catch(() => false);
    if (continued) {
      lastAction = "continue";
      await page.waitForTimeout(1000);
      continue;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(400);
  }

  return { ready: false, lastAction };
}

function isPublishApiUrl(url) {
  return /\/publish|publish_all|batch_publish|submit_publish/i.test(String(url));
}

function isDuplicateApiUrl(url) {
  const u = String(url);
  if (!/ads\.tiktok\.com/i.test(u) || !/\/api\//i.test(u)) return false;
  return /duplicate|\/copy\/|sketch\/copy|campaign\/copy|smart.*copy|\/copy\?/i.test(u);
}

async function waitForDuplicateApiResponse(page, timeoutMs = 30_000) {
  try {
    const resp = await page.waitForResponse(
      (r) => {
        if (r.request().method() !== "POST") return false;
        if (!/ads\.tiktok\.com/i.test(r.url())) return false;
        return isDuplicateApiUrl(r.url());
      },
      { timeout: timeoutMs }
    );
    const req = resp.request();
    let body = null;
    try {
      const raw = req.postData();
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* ignore */
    }
    let json = null;
    try {
      json = await resp.json();
    } catch {
      /* ignore */
    }
    const draftId = extractDraftIdFromApiJson(json);
    const captured =
      draftId && body
        ? { url: resp.url().split("?")[0], query: resp.url().includes("?") ? resp.url().split("?")[1] : "", body }
        : null;
    return {
      draftId: draftId ? String(draftId) : null,
      captured,
      json,
      status: resp.status(),
      url: resp.url(),
    };
  } catch {
    return null;
  }
}

async function replayDuplicateRequest(page, template, newName) {
  if (!template?.url || !template?.body) return null;

  const body = { ...template.body };
  for (const k of ["campaign_name", "name", "new_name", "copy_name", "dest_campaign_name"]) {
    if (Object.prototype.hasOwnProperty.call(body, k)) body[k] = newName;
  }

  const csrf = await getCsrfToken(page);
  const url = template.query ? `${template.url}?${template.query}` : template.url;
  const result = await page.evaluate(
    async ({ fetchUrl, fetchBody, csrfToken }) => {
      try {
        const headers = { "Content-Type": "application/json", Accept: "application/json" };
        if (csrfToken) {
          headers["X-CSRFToken"] = csrfToken;
          headers["x-csrftoken"] = csrfToken;
        }
        const resp = await fetch(fetchUrl, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify(fetchBody),
        });
        const text = await resp.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* ignore */
        }
        return { status: resp.status, json, url: fetchUrl };
      } catch (e) {
        return { error: String(e), url: fetchUrl };
      }
    },
    { fetchUrl: url, fetchBody: body, csrfToken: csrf }
  );

  const draftId = extractDraftIdFromApiJson(result?.json);
  return draftId ? String(draftId) : null;
}

function isTikTokApiSuccess(apiDetail) {
  if (!apiDetail) return false;
  const code = apiDetail.code;
  if (code === 0 || code === "0") return true;
  return /success/i.test(String(apiDetail.msg || ""));
}

function isPublishApiSuccess(apiDetail) {
  return isTikTokApiSuccess(apiDetail) && isPublishApiUrl(apiDetail.url);
}

function waitForPublishApi(page, timeoutMs = 30_000) {
  return page
    .waitForResponse(
      (resp) => {
        if (!/ads\.tiktok\.com/i.test(resp.url())) return false;
        if (resp.request().method() !== "POST") return false;
        return isPublishApiUrl(resp.url());
      },
      { timeout: timeoutMs }
    )
    .then(async (resp) => {
      try {
        const json = await resp.json();
        const code = json?.code ?? json?.status_code ?? json?.statusCode;
        const msg = json?.msg ?? json?.message ?? "";
        const detail = { code, msg, url: resp.url() };
        return { ok: isTikTokApiSuccess(detail), detail };
      } catch {
        return { ok: false, detail: { url: resp.url(), parseError: true } };
      }
    })
    .catch(() => ({ ok: false, detail: { reason: "publish_api_timeout" } }));
}

async function waitForUiPublishSuccess(page, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) return { ok: false, reason: "page_closed" };
    const state = await readPublishPageState(page);
    if (state.hasError && !state.hasSuccess) {
      return { ok: false, reason: "ui_error", state };
    }
    if (state.hasSuccess) return { ok: true, reason: "ui_success_toast", state };
    await page.waitForTimeout(300);
  }
  return { ok: false, reason: "ui_timeout" };
}

async function readDraftCheckOnPage(page) {
  if (page.isClosed()) {
    return { publishStillVisible: true, draftStatus: true, bodyText: "page closed" };
  }
  return page.evaluate(() => {
    const bodyText = (document.body.innerText || "").slice(0, 5000);
    const publishStillVisible = Array.from(
      document.querySelectorAll(
        'button, [role="button"], a, div, span, [class*="btn" i], [class*="button" i]'
      )
    ).some((el) => {
      if (el.disabled) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const text = (el.innerText || el.textContent || "").trim().toLowerCase();
      return /^publish all(\s*[▾▼⌄↓])?$|^publish$/.test(text);
    });
    const draftStatus = /\bStatus\b[\s\S]{0,40}\bDraft\b/.test(bodyText);
    return { publishStillVisible, draftStatus, bodyText: bodyText.slice(0, 400) };
  });
}

async function resolveDraftCheck(page, advertiserId, campaignSketchId, apiResult, uiResult) {
  await page.waitForTimeout(600);
  let check = await readDraftCheckOnPage(page);
  if (!check.publishStillVisible && !check.draftStatus) {
    return { published: true, reason: "on_page_left_draft", check };
  }
  if (isPublishApiSuccess(apiResult?.detail) && !check.publishStillVisible) {
    return { published: true, reason: "publish_api+on_page", check };
  }
  if (uiResult?.ok && !check.publishStillVisible) {
    return { published: true, reason: "ui+on_page", check };
  }

  await page.goto(buildEditorUrl(advertiserId, campaignSketchId), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await page.waitForTimeout(800);
  check = await readDraftCheckOnPage(page);
  if (check.publishStillVisible) {
    return { published: false, reason: "publish_all_still_visible", check };
  }
  if (check.draftStatus) {
    return { published: false, reason: "draft_status_still_shown", check };
  }
  return { published: true, reason: "left_draft_state", check };
}

function publishSucceeded(apiResult, uiResult, draftCheck) {
  if (!draftCheck?.published) return false;
  if (isPublishApiSuccess(apiResult?.detail)) return true;
  if (uiResult?.ok) return true;
  return false;
}

async function readPublishPageState(page) {
  if (page.isClosed()) {
    return {
      hasSuccess: false,
      hasError: true,
      publishStillVisible: false,
      bodyText: "page closed",
      url: "",
    };
  }
  return page.evaluate(() => {
    const bodyText = (document.body.innerText || "").slice(0, 8000);
    const hasSuccess = /publish(ed)?(\s+all)?\s+success|published successfully|create success|submission successful|成功发布|发布成功/i.test(
      bodyText
    );
    const hasError = /publish.*fail|failed to publish|permission denied|insufficient balance|risk control|unable to publish/i.test(
      bodyText
    );
    return {
      hasSuccess,
      hasError,
      bodyText: bodyText.slice(0, 800),
      url: location.href,
    };
  });
}

async function clickPublishAll(page) {
  if (page.isClosed()) return false;
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(200);
  return page
    .evaluate((sel) => {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (el.disabled) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (/^publish all(\s*[▾▼⌄↓])?$|^publish$/.test(text)) {
          el.scrollIntoView({ block: "center" });
          el.click();
          return (el.innerText || el.textContent || "").trim();
        }
      }
      return false;
    }, publishAllSelector())
    .catch(() => false);
}

async function clickConfirmDialog(page) {
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    for (const b of Array.from(document.querySelectorAll("button")).reverse()) {
      const t = (b.innerText || b.textContent || "").trim().toLowerCase();
      if (/^(confirm|publish|publish all|submit|ok)$/.test(t) && !b.disabled) {
        const inDialog =
          b.closest('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="popup" i]');
        if (inDialog) {
          b.click();
          return true;
        }
      }
    }
    return false;
  }).catch(() => false);
}

async function savePageScreenshot(page, tag) {
  try {
    if (!page || page.isClosed()) return null;
    const buf = await page.screenshot({ fullPage: false });
    const id = saveScreenshot(buf);
    return `/screenshots/${id}?tag=${encodeURIComponent(tag)}`;
  } catch {
    return null;
  }
}

async function fillCampaignSearch(page, query) {
  try {
    const searchInput = page
      .locator(
        'input[placeholder*="Search" i], input[aria-label*="Search" i], input[type="search"], input[class*="search" i]'
      )
      .first();
    await searchInput.waitFor({ state: "visible", timeout: 5000 });
    await searchInput.click({ clickCount: 3 }).catch(() => {});
    await searchInput.fill("");
    await searchInput.fill(String(query));
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(2500);
    return true;
  } catch {
    return false;
  }
}

async function getCsrfToken(page) {
  return page.evaluate(() => {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
    const meta = document.querySelector('meta[name="csrf-token"], meta[name="csrf_token"]');
    return meta?.getAttribute("content") || "";
  });
}

function extractDraftIdFromApiJson(json) {
  if (!json || typeof json !== "object") return null;
  const code = json.code ?? json.status_code ?? json.statusCode;
  if (code != null && code !== 0 && code !== "0" && code !== 200) return null;
  const d = json.data ?? json;
  if (!d || typeof d !== "object") return null;
  return (
    d.campaign_draft_id ||
    d.temp_campaign_id ||
    d.sketch_id ||
    d.new_campaign_id ||
    d.campaign_sketch_id ||
    d.draft_id ||
    null
  );
}

async function tryDuplicateViaHttp(page, advertiserId, campaignId, newName) {
  if (!campaignId) return null;

  await page
    .goto(
      `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${encodeURIComponent(advertiserId)}`,
      { waitUntil: "domcontentloaded", timeout: 60_000 }
    )
    .catch(() => {});
  await dismissOverlays(page);
  await page.waitForTimeout(800);

  const csrf = await getCsrfToken(page);
  const attempts = [
    {
      url: `https://ads.tiktok.com/api/v2/i18n/manage/campaign/duplicate/?aadvid=${encodeURIComponent(advertiserId)}`,
      body: { aadvid: advertiserId, campaign_id: String(campaignId), campaign_name: newName },
    },
    {
      url: `https://ads.tiktok.com/api/v2/i18n/creation/1nn/campaign/duplicate/?aadvid=${encodeURIComponent(advertiserId)}`,
      body: { aadvid: advertiserId, campaign_id: String(campaignId), campaign_name: newName },
    },
    {
      url: `https://ads.tiktok.com/api/v2/i18n/creation/1nn/campaign/copy/?aadvid=${encodeURIComponent(advertiserId)}`,
      body: { aadvid: advertiserId, src_campaign_id: String(campaignId), campaign_name: newName },
    },
    {
      url: `https://ads.tiktok.com/api/v2/i18n/creation/1nn/campaign/copy/?aadvid=${encodeURIComponent(advertiserId)}`,
      body: { aadvid: advertiserId, campaign_id: String(campaignId), campaign_name: newName },
    },
    {
      url: `https://ads.tiktok.com/api/v2/i18n/creation/1nn/campaign/sketch/copy/?aadvid=${encodeURIComponent(advertiserId)}`,
      body: { aadvid: advertiserId, campaign_id: String(campaignId), name: newName },
    },
    {
      url: `https://ads.tiktok.com/api/v2/i18n/creation/1nn/smart_campaign/copy/?aadvid=${encodeURIComponent(advertiserId)}`,
      body: { aadvid: advertiserId, campaign_id: String(campaignId), campaign_name: newName },
    },
    {
      url: `https://ads.tiktok.com/api/v3/i18n/manage/campaign/duplicate/?aadvid=${encodeURIComponent(advertiserId)}`,
      body: { aadvid: advertiserId, campaign_id: String(campaignId), name: newName },
    },
  ];

  for (const attempt of attempts) {
    const result = await page.evaluate(
      async ({ url, body, csrfToken }) => {
        try {
          const headers = { "Content-Type": "application/json", Accept: "application/json" };
          if (csrfToken) {
            headers["X-CSRFToken"] = csrfToken;
            headers["x-csrftoken"] = csrfToken;
          }
          const resp = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers,
            body: JSON.stringify(body),
          });
          const text = await resp.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* ignore */
          }
          return { status: resp.status, json, text: text.slice(0, 400), url };
        } catch (e) {
          return { error: String(e), url };
        }
      },
      { url: attempt.url, body: attempt.body, csrfToken: csrf }
    );

    const draftId = extractDraftIdFromApiJson(result?.json);
    if (draftId) return String(draftId);
  }
  return null;
}

async function scanCampaignRows(page) {
  return page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    const add = (key, text) => {
      const t = String(text || "").replace(/\s+/g, " ").trim();
      if (t.length < 4 || t.length > 400) return;
      const sig = `${key}|${t.slice(0, 70)}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      rows.push({ key: key || "", text: t.slice(0, 150) });
    };

    for (const el of document.querySelectorAll("[data-row-key], [data-id]")) {
      add(el.getAttribute("data-row-key") || el.getAttribute("data-id") || "", el.innerText || el.textContent);
    }
    for (const tr of document.querySelectorAll("table tbody tr, [role='row'], [class*='TableRow' i]")) {
      const nested = tr.querySelector("[data-row-key]");
      const key = nested?.getAttribute("data-row-key") || tr.getAttribute("data-row-key") || "";
      add(key, tr.innerText || tr.textContent);
    }
    for (const a of document.querySelectorAll("a[href*='campaign'], [class*='campaign-name' i]")) {
      const row = a.closest("[data-row-key], tr, [role='row']");
      const key = row?.getAttribute("data-row-key") || "";
      add(key, a.innerText || row?.innerText);
    }
    return rows.slice(0, 60);
  });
}

async function findCampaignRowMeta(page, sourceCampaignId, sourceCampaignName) {
  const id = String(sourceCampaignId || "").trim();
  const name = String(sourceCampaignName || "").trim().toLowerCase();

  const matchInRows = (rows) => {
    if (id) {
      const byId = rows.find(
        (r) => r.key === id || r.key.endsWith(id) || r.text.includes(id)
      );
      if (byId?.key) return { key: byId.key, method: "id", sample: rows.slice(0, 5) };
    }
    if (name) {
      const byName = rows.find((r) => r.text.toLowerCase().includes(name));
      if (byName?.key) return { key: byName.key, method: "name", sample: rows.slice(0, 5) };
    }
    return null;
  };

  let rows = await scanCampaignRows(page);
  let hit = matchInRows(rows);
  if (hit) return hit;

  if (name) {
    if (await fillCampaignSearch(page, sourceCampaignName)) {
      rows = await scanCampaignRows(page);
      hit = matchInRows(rows);
      if (hit) return hit;
    }
  }

  if (id) {
    if (await fillCampaignSearch(page, id)) {
      rows = await scanCampaignRows(page);
      hit = matchInRows(rows);
      if (hit) return hit;
    }
  }

  return { key: null, sample: rows.slice(0, 8) };
}

async function locateSourceCampaignRow(page, sourceCampaignId, sourceCampaignName) {
  const meta = await findCampaignRowMeta(page, sourceCampaignId, sourceCampaignName);
  if (!meta.key) {
    const shot = await savePageScreenshot(page, "row-not-found");
    const diag = await readPageDiagnostics(page).catch(() => ({}));
    const hint = (meta.sample || [])
      .map((r) => `${r.key || "?"} → ${r.text.slice(0, 50)}`)
      .join(" | ");
    throw new Error(
      `Campaign not found (rows=${diag.rowKeys ?? 0}, table=${diag.tableRows ?? 0}). ` +
        (hint ? `Seen: ${hint}. ` : "TikTok list empty — export ALL cookies (JSON) from Application tab, not just 2. ") +
        `Screenshot: ${shot || "n/a"}`
    );
  }

  const row = page.locator(`[data-row-key="${meta.key}"], [data-id="${meta.key}"]`).first();
  if (await row.isVisible().catch(() => false)) return row;

  return page.locator("*").filter({ hasText: sourceCampaignName || meta.key }).first();
}

async function clickDuplicateOnRow(page, row) {
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.hover().catch(() => {});
  await page.waitForTimeout(700);

  const clicked = await row.evaluate((r) => {
    for (const el of Array.from(r.querySelectorAll("a, button, span, [role='button']"))) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (t === "duplicate" || t.startsWith("duplicate ")) {
        el.click();
        return "dup";
      }
    }
    const more = r.querySelector(
      '[class*="more" i], [aria-label*="more" i], [class*="action" i] button, [class*="Action"]'
    );
    if (more) {
      more.click();
      return "menu";
    }
    return false;
  });

  if (clicked === "menu") {
    await page.waitForTimeout(600);
    const menuDup = await page.evaluate(() => {
      for (const el of Array.from(
        document.querySelectorAll("button, a, li, span, [role='menuitem'], [class*='dropdown' i] *")
      )) {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (t === "duplicate" || /^duplicate\b/.test(t)) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (!menuDup) throw new Error("Duplicate not in row menu — open campaign in TikTok and check UI");
  } else if (clicked !== "dup") {
    const globalDup = page.getByText(/^duplicate$/i).first();
    if (await globalDup.isVisible().catch(() => false)) {
      await globalDup.click();
    } else {
      throw new Error("Duplicate button not found — hover row in TikTok and check Actions menu");
    }
  }
}

async function submitDuplicateNameModal(page, newName) {
  const nameInput = page.locator(
    'input[placeholder*="name" i], input[placeholder*="Name"], input[class*="name" i]'
  ).first();
  await nameInput.waitFor({ state: "visible", timeout: 20_000 });
  await nameInput.fill("");
  await nameInput.fill(newName);

  const submitted = await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("button")).reverse()) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (/^(duplicate|confirm|submit|ok)$/.test(t) && !el.disabled) {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!submitted) throw new Error("Modal submit button not found");
}

async function extractDraftIdFromPage(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  await page.waitForSelector('button, [role="button"]', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);
  const sketchMatch = page.url().match(/campaign_draft_id=([^&]+)/);
  return sketchMatch?.[1] || page.url().match(/temp_campaign_id=([^&]+)/)?.[1] || "";
}

async function clickPageDuplicateButton(page) {
  await dismissOverlays(page);
  const clicked = await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("button, a, [role='button'], span"))) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (t === "duplicate" || t.startsWith("duplicate ")) {
        el.click();
        return true;
      }
    }
    for (const el of Array.from(document.querySelectorAll("button, [role='button']"))) {
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (/more|action|menu/.test(label)) {
        el.click();
        return "menu";
      }
    }
    return false;
  });

  if (clicked === "menu") {
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      for (const el of Array.from(
        document.querySelectorAll("button, a, li, span, [role='menuitem']")
      )) {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (t === "duplicate" || /^duplicate\b/.test(t)) {
          el.click();
          return true;
        }
      }
      return false;
    });
  }
  return Boolean(clicked);
}

async function tryDuplicateFromDetailPage(page, advertiserId, campaignId, newName, apiTemplateRef) {
  if (apiTemplateRef?.url) {
    const replayed = await replayDuplicateRequest(page, apiTemplateRef, newName);
    if (replayed) return replayed;
  }

  const urls = [
    `https://ads.tiktok.com/i18n/manage/campaign/detail?aadvid=${encodeURIComponent(advertiserId)}&campaign_id=${encodeURIComponent(campaignId)}`,
    `https://ads.tiktok.com/i18n/creation/1nn/create/campaign?aadvid=${encodeURIComponent(advertiserId)}&campaign_id=${encodeURIComponent(campaignId)}`,
    `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${encodeURIComponent(advertiserId)}&campaign_id=${encodeURIComponent(campaignId)}`,
  ];

  for (const url of urls) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await dismissOverlays(page);
    await page.waitForTimeout(1500);
    if (page.url().includes("/login") || page.url().includes("/passport")) continue;

    if (await clickPageDuplicateButton(page)) {
      const apiWait = waitForDuplicateApiResponse(page, 35_000);
      await submitDuplicateNameModal(page, newName);
      const apiHit = await apiWait;
      if (apiHit?.captured && apiTemplateRef && !apiTemplateRef.url) {
        apiTemplateRef.url = apiHit.captured.url;
        apiTemplateRef.query = apiHit.captured.query;
        apiTemplateRef.body = apiHit.captured.body;
      }
      if (apiHit?.draftId) return apiHit.draftId;

      const sketchId = await extractDraftIdFromPage(page);
      if (sketchId) return sketchId;
    }
  }
  return null;
}

async function duplicateDraftOnce(
  page,
  listUrl,
  advertiserId,
  sourceCampaignId,
  newName,
  sourceCampaignName,
  apiTemplateRef
) {
  if (sourceCampaignId) {
    if (apiTemplateRef?.url) {
      const replayed = await replayDuplicateRequest(page, apiTemplateRef, newName);
      if (replayed) return replayed;
    }

    const fromHttp = await tryDuplicateViaHttp(page, advertiserId, sourceCampaignId, newName);
    if (fromHttp) return fromHttp;

    const fromDetail = await tryDuplicateFromDetailPage(
      page,
      advertiserId,
      sourceCampaignId,
      newName,
      apiTemplateRef
    );
    if (fromDetail) {
      await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      return fromDetail;
    }

    const shot = await savePageScreenshot(page, "fast-dup-fail");
    throw new Error(
      `Fast duplicate failed. Campaign ID ${sourceCampaignId} — re-export Cookie-Editor JSON. Screenshot: ${shot || "n/a"}`
    );
  }

  const row = await locateSourceCampaignRow(page, sourceCampaignId, sourceCampaignName);
  await clickDuplicateOnRow(page, row);
  await submitDuplicateNameModal(page, newName);
  const campaignSketchId = await extractDraftIdFromPage(page);
  if (!campaignSketchId) throw new Error("No draft ID after duplicate");
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  return campaignSketchId;
}

async function publishDraftsParallel({ advertiserId, cookies, drafts, onProgress }) {
  const results = await Promise.all(
    drafts.map(async (draft, index) => {
      await acquirePublishSlot();
      try {
        const result = await publishDraftCore({
          advertiserId,
          campaignSketchId: draft.campaignSketchId,
          cookies,
          skipAccountWarmup: index > 0,
        });
        onProgress?.({ phase: "publishing", done: index + 1, total: drafts.length });
        return {
          name: draft.name,
          campaignSketchId: draft.campaignSketchId,
          ...result,
        };
      } catch (err) {
        onProgress?.({ phase: "publishing", done: index + 1, total: drafts.length });
        return {
          name: draft.name,
          campaignSketchId: draft.campaignSketchId,
          ok: false,
          error: err instanceof Error ? err.message : "Internal error",
        };
      } finally {
        releasePublishSlot();
      }
    })
  );

  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount > 0, published: okCount, total: results.length, results };
}

async function duplicateCampaignsCore({
  advertiserId,
  campaignId,
  campaignName,
  names,
  cookies,
  onProgress,
}) {
  onProgress?.({
    phase: "duplicating",
    done: 0,
    total: names.length,
    currentStep: "Launching browser…",
  });

  const browser = await getSharedBrowser();
  const context = await createTikTokContext(browser, cookies);
  const page = await context.newPage();
  const listUrl = `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${encodeURIComponent(advertiserId)}`;

  const draftResults = [];
  const duplicateApiTemplate = {};
  try {
    onProgress?.({
      phase: "duplicating",
      done: 0,
      total: names.length,
      currentStep: campaignId
        ? "Fast mode — Campaign ID (no search/list)…"
        : "Opening TikTok (dismiss popups, then duplicate)…",
    });
    if (campaignId) {
      await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await dismissOverlays(page);
      if (page.url().includes("/login") || page.url().includes("/passport")) {
        const shot = await savePageScreenshot(page, "login");
        return {
          ok: false,
          error: "TikTok session expired — re-export Cookie-Editor JSON",
          screenshot: shot,
          results: [],
        };
      }
    } else {
      try {
        const diag = await prepareCampaignListPage(page, listUrl);
        onProgress?.({
          phase: "duplicating",
          done: 0,
          total: names.length,
          currentStep:
            diag.rowKeys > 0
              ? `List loaded (${diag.rowKeys} campaigns)`
              : "List hidden — trying campaign name search",
        });
      } catch (e) {
        if (String(e.message) === "LOGIN") {
          const shot = await savePageScreenshot(page, "login");
          return {
            ok: false,
            error: "TikTok session expired — re-export Cookie-Editor JSON",
            screenshot: shot,
            results: [],
          };
        }
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        await dismissOverlays(page);
      }
    }
    await page.waitForSelector('button, [role="button"], input', { timeout: 20_000 }).catch(() => {});

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      onProgress?.({
        phase: "duplicating",
        done: i,
        total: names.length,
        currentStep:
          i === 0
            ? `Duplicating "${name}" (capturing TikTok API if needed)…`
            : duplicateApiTemplate.url
              ? `Fast API copy ${i + 1}/${names.length} — "${name}"…`
              : `Duplicating "${name}" (${i + 1}/${names.length})…`,
        draftResults,
      });
      try {
        const campaignSketchId = await duplicateDraftOnce(
          page,
          listUrl,
          advertiserId,
          campaignId,
          name,
          campaignName,
          duplicateApiTemplate
        );
        draftResults.push({ name, ok: true, campaignSketchId });
      } catch (e) {
        const shot = await savePageScreenshot(page, `dup-fail-${i + 1}`);
        draftResults.push({
          name,
          ok: false,
          error: e instanceof Error ? e.message : "unknown error",
          screenshot: shot,
        });
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
      onProgress?.({
        phase: "duplicating",
        done: i + 1,
        total: names.length,
        currentStep: draftResults.at(-1)?.ok ? `Created draft for "${name}"` : `Failed "${name}"`,
        draftResults,
      });
    }
  } finally {
    await context.close().catch(() => {});
  }

  const draftsToPublish = draftResults
    .filter((r) => r.ok && r.campaignSketchId)
    .map((r) => ({ name: r.name, campaignSketchId: r.campaignSketchId }));

  if (draftsToPublish.length === 0) {
    return {
      ok: false,
      error: "No drafts created",
      duplicated: 0,
      published: 0,
      total: names.length,
      results: draftResults.map((r) => ({
        name: r.name,
        ok: false,
        error: r.error || "duplicate_failed",
      })),
    };
  }

  onProgress?.({ phase: "publishing", done: 0, total: draftsToPublish.length });
  const publishOut = await publishDraftsParallel({
    advertiserId,
    cookies,
    drafts: draftsToPublish,
    onProgress,
  });

  const publishByName = new Map(publishOut.results.map((r) => [r.name, r]));
  const results = draftResults.map((draft) => {
    const pub = publishByName.get(draft.name);
    if (!draft.ok) {
      return { name: draft.name, ok: false, error: draft.error || "duplicate_failed" };
    }
    if (!pub) {
      return { name: draft.name, ok: false, error: "publish_not_attempted" };
    }
    return {
      name: draft.name,
      ok: pub.ok,
      newCampaignId: pub.newCampaignId || draft.campaignSketchId,
      verifiedBy: pub.verifiedBy,
      error: pub.error,
    };
  });

  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: okCount > 0,
    duplicated: draftResults.filter((r) => r.ok).length,
    published: okCount,
    total: results.length,
    results,
  };
}

function saveScreenshot(buf) {
  const id = `${Date.now()}-${++screenshotCounter}`;
  screenshots.set(id, buf);
  if (screenshots.size > 20) screenshots.delete(screenshots.keys().next().value);
  return id;
}

async function publishDraftCore({ advertiserId, campaignSketchId, cookies, skipAccountWarmup }) {
  const browser = await getSharedBrowser();
  const context = await createTikTokContext(browser, cookies);
  const page = await context.newPage();

  try {
    if (!skipAccountWarmup) {
      await page.goto(
        `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${encodeURIComponent(advertiserId)}`,
        { waitUntil: "domcontentloaded", timeout: 20_000 }
      ).catch(() => {});
      await page.waitForTimeout(600);
    }

    const editorUrl = buildEditorUrl(advertiserId, campaignSketchId);

    async function loadEditorAndPrepare() {
      await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      if (page.url().includes("/login") || page.url().includes("/passport")) {
        return { loginExpired: true };
      }
      await page.waitForSelector('button, [role="button"]', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(400);
      const prep = await prepareEditorForPublish(page);
      return { loginExpired: false, prep };
    }

    const initial = await loadEditorAndPrepare();
    if (initial.loginExpired) {
      return { ok: false, error: "TikTok session expired. Re-paste cookies." };
    }
    if (!initial.prep.ready) {
      return {
        ok: false,
        error: `Editor not ready for publish (last=${initial.prep.lastAction})`,
      };
    }

    let apiResult = null;
    let uiResult = null;
    let draftCheck = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const publishApiPromise = waitForPublishApi(page, 30_000);
      const publishClicked = await clickPublishAll(page);
      if (!publishClicked) {
        return { ok: false, error: "Publish button not found" };
      }

      await clickConfirmDialog(page);
      [apiResult, uiResult] = await Promise.all([
        publishApiPromise,
        waitForUiPublishSuccess(page, 8_000),
      ]);
      draftCheck = await resolveDraftCheck(page, advertiserId, campaignSketchId, apiResult, uiResult);

      if (publishSucceeded(apiResult, uiResult, draftCheck)) break;
      if (attempt === 1) {
        const retry = await loadEditorAndPrepare();
        if (retry.loginExpired || !retry.prep?.ready) break;
      }
    }

    if (!publishSucceeded(apiResult, uiResult, draftCheck)) {
      return {
        ok: false,
        error: [
          draftCheck?.published ? null : `draft=${draftCheck?.reason || "still_draft"}`,
          apiResult?.ok ? null : `publish_api=${JSON.stringify(apiResult?.detail || { reason: "no_publish_api" })}`,
          uiResult?.ok ? null : `ui=${uiResult?.reason || "no_ui_success"}`,
        ]
          .filter(Boolean)
          .join(" | "),
      };
    }

    const verifiedBy = isPublishApiSuccess(apiResult?.detail)
      ? "publish_api"
      : `${uiResult?.reason || "ui"}+${draftCheck?.reason || "left_draft"}`;

    return { ok: true, newCampaignId: campaignSketchId, verifiedBy };
  } finally {
    await context.close().catch(() => {});
  }
}

function checkAuth(req, res) {
  const auth = req.headers.authorization || "";
  if (!SHARED_SECRET || auth !== `Bearer ${SHARED_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.get("/screenshots/:id", (req, res) => {
  const buf = screenshots.get(req.params.id);
  if (!buf) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "image/png");
  res.send(buf);
});

function validateDuplicateBody(body) {
  const { advertiserId, campaignId, campaignName, names, cookies } = body || {};
  if (!advertiserId || !Array.isArray(names) || names.length === 0 || !cookies) {
    return { error: "advertiserId, names[], cookies required" };
  }
  if (!campaignId && !campaignName) {
    return { error: "campaignId or campaignName required" };
  }
  if (names.length > 20) {
    return { error: "Max 20 copies per request" };
  }
  const cookieErr = validateCookies(cookies);
  if (cookieErr) return { error: cookieErr };
  return { advertiserId, campaignId, campaignName, names, cookies };
}

function validateCookies(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) return "Cookies empty";
  const parsed = parseCookies(trimmed);
  if (parsed.length === 0) {
    return "Cookies not parsed. On ads.tiktok.com → F12 → Console → copy(document.cookie)";
  }
  const names = parsed.map((c) => c.name);
  const hasSessionAds = names.some((n) => n === "sessionid_ads" || n === "sessionid");
  if (!hasSessionAds) {
    if (names.includes("msToken") && names.length <= 5) {
      return "WRONG: copy(document.cookie) misses sessionid_ads (HttpOnly). F12 → Application → Cookies → ads.tiktok.com → copy sessionid_ads Value";
    }
    return "Missing sessionid_ads. F12 → Application → Cookies → https://ads.tiktok.com → copy sessionid_ads + csrftoken";
  }
  if (parsed.length < 4) {
    return `Only ${parsed.length} cookie(s) — export ALL cookies as JSON (Cookie-Editor extension on ads.tiktok.com)`;
  }
  return null;
}

function newDuplicateJobId() {
  return `dup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function trimDuplicateJobs() {
  while (duplicateJobs.size > MAX_DUPLICATE_JOBS) {
    duplicateJobs.delete(duplicateJobs.keys().next().value);
  }
}

function startDuplicateJob(params) {
  const jobId = newDuplicateJobId();
  const job = {
    jobId,
    status: "running",
    phase: "duplicating",
    progress: { done: 0, total: params.names.length },
    results: [],
    startedAt: Date.now(),
  };
  duplicateJobs.set(jobId, job);
  trimDuplicateJobs();

  const heartbeat = setInterval(() => {
    const current = duplicateJobs.get(jobId);
    if (!current || current.status !== "running") {
      clearInterval(heartbeat);
      return;
    }
    duplicateJobs.set(jobId, {
      ...current,
      elapsedMs: Date.now() - job.startedAt,
    });
  }, 10_000);

  duplicateCampaignsCore({
    ...params,
    onProgress: (progress) => {
      const current = duplicateJobs.get(jobId);
      if (!current || current.status !== "running") return;
      duplicateJobs.set(jobId, {
        ...current,
        phase: progress.phase,
        progress: { done: progress.done, total: progress.total },
        currentStep: progress.currentStep || current.currentStep,
        results: progress.draftResults || current.results,
      });
    },
  })
    .then((out) => {
      clearInterval(heartbeat);
      duplicateJobs.set(jobId, {
        ...duplicateJobs.get(jobId),
        ...out,
        status: out.ok ? "completed" : "failed",
        finishedAt: Date.now(),
        elapsedMs: Date.now() - job.startedAt,
      });
    })
    .catch((err) => {
      clearInterval(heartbeat);
      duplicateJobs.set(jobId, {
        ...duplicateJobs.get(jobId),
        status: "failed",
        error: err instanceof Error ? err.message : "Internal error",
        finishedAt: Date.now(),
        elapsedMs: Date.now() - job.startedAt,
      });
    });

  return jobId;
}

app.post("/test-cookies", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { advertiserId, cookies } = req.body || {};
  if (!cookies) return res.status(400).json({ error: "cookies required" });
  const out = await verifyTikTokSession({ advertiserId, cookies });
  return res.status(out.ok ? 200 : 400).json(out);
});

app.get("/duplicate/inject", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "duplicate-inject.html"));
});

app.get("/adsalim-bridge.user.js", (req, res) => {
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.sendFile(path.join(__dirname, "public", "adsalim-bridge.user.js"));
});

// Alias — static hosting may 404 nested paths on older deploys
app.get("/inject", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "duplicate-inject.html"));
});

app.get("/duplicate/ui", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "duplicate-ui.html"));
});

app.post("/duplicate/async", (req, res) => {
  if (!checkAuth(req, res)) return;

  const parsed = validateDuplicateBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const jobId = startDuplicateJob(parsed);
  return res.status(202).json({
    jobId,
    status: "running",
    pollUrl: `/duplicate/jobs/${jobId}`,
  });
});

app.get("/duplicate/jobs/:id", (req, res) => {
  if (!checkAuth(req, res)) return;

  const job = duplicateJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json(job);
});

app.post("/duplicate", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const parsed = validateDuplicateBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  // More than 5 copies usually exceeds Vercel/proxy timeouts — use async.
  if (parsed.names.length > 5 && req.query.sync !== "1") {
    const jobId = startDuplicateJob(parsed);
    return res.status(202).json({
      jobId,
      status: "running",
      async: true,
      message: "Use GET /duplicate/jobs/:jobId to poll. For sync, add ?sync=1",
      pollUrl: `/duplicate/jobs/${jobId}`,
    });
  }

  const started = Date.now();
  try {
    const out = await duplicateCampaignsCore(parsed);
    if (out.error?.includes("expired")) {
      return res.status(401).json(out);
    }
    return res.json({
      ...out,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

app.post("/publish-draft", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { advertiserId, campaignSketchId, cookies } = req.body || {};
  if (!advertiserId || !campaignSketchId || !cookies) {
    return res.status(400).json({
      error: "advertiserId, campaignSketchId, cookies required",
    });
  }

  await acquirePublishSlot();
  try {
    const result = await publishDraftCore({ advertiserId, campaignSketchId, cookies });
    if (!result.ok) return res.status(result.error?.includes("expired") ? 401 : 500).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  } finally {
    releasePublishSlot();
  }
});

app.post("/publish-batch", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { advertiserId, cookies, drafts } = req.body || {};
  if (!advertiserId || !cookies || !Array.isArray(drafts) || drafts.length === 0) {
    return res.status(400).json({
      error: "advertiserId, cookies, drafts[] required",
    });
  }
  if (drafts.length > 20) {
    return res.status(400).json({ error: "Max 20 drafts per batch" });
  }

  const started = Date.now();
  const normalized = drafts.map((draft) => ({
    name: draft?.name ? String(draft.name) : undefined,
    campaignSketchId: String(draft?.campaignSketchId || draft?.sketchId || ""),
  }));
  const invalid = normalized.find((d) => !d.campaignSketchId);
  if (invalid) {
    return res.status(400).json({ error: "campaignSketchId required for each draft" });
  }

  const publishOut = await publishDraftsParallel({
    advertiserId,
    cookies,
    drafts: normalized,
  });

  return res.json({
    ok: publishOut.published === publishOut.total,
    published: publishOut.published,
    total: publishOut.total,
    elapsedMs: Date.now() - started,
    results: publishOut.results,
  });
});

function normalizeSameSite(value) {
  if (value == null || value === "" || value === "unspecified") return "Lax";
  const v = String(value).toLowerCase();
  if (v === "no_restriction" || v === "none") return "None";
  if (v === "strict") return "Strict";
  if (v === "lax") return "Lax";
  return "Lax";
}

function parseCookies(raw) {
  let trimmed = String(raw).trim();
  trimmed = trimmed.replace(/^cookie:\s*/i, "").replace(/^["']|["']$/g, "");
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return arr
        .map((c) => ({
          name: String(c.name || ""),
          value: String(c.value || ""),
          domain: String(c.domain || ".tiktok.com"),
          path: String(c.path || "/"),
          expires: typeof c.expirationDate === "number" ? c.expirationDate : -1,
          httpOnly: Boolean(c.httpOnly),
          secure: Boolean(c.secure ?? true),
          sameSite: normalizeSameSite(c.sameSite),
        }))
        .filter((c) => c.name && c.value);
    } catch {
      return [];
    }
  }
  const out = [];
  for (const pair of trimmed.split(";")) {
    const p = pair.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!name || !value) continue;
    out.push({
      name,
      value,
      domain: ".tiktok.com",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    });
  }
  return out;
}

app.listen(PORT, () => {
  console.log(`adsalim-vm-service v${SERVICE_VERSION} listening on :${PORT} (concurrency=${MAX_CONCURRENT_PUBLISH})`);
});
