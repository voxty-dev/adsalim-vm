/**
 * adsalim-vm-service
 *
 * Publishes TikTok Smart+ campaign drafts via Playwright.
 * Duplicate happens in adsalim (Vercel) via cURL replay.
 *
 * Endpoints:
 *   POST /publish-draft   — single draft
 *   POST /publish-batch   — up to 20 drafts in parallel (fast path)
 *   GET  /screenshots/:id
 */

const express = require("express");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || "";
const MAX_CONCURRENT_PUBLISH = Number(process.env.MAX_CONCURRENT_PUBLISH || 8);
const SERVICE_VERSION = "1.3.0";

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({
    service: "adsalim-vm-service",
    status: "ok",
    version: SERVICE_VERSION,
    maxConcurrentPublish: MAX_CONCURRENT_PUBLISH,
    endpoints: ["/duplicate", "/publish-draft", "/publish-batch", "/screenshots/:id"],
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
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = chromium.launch({
      headless: true,
      args: BROWSER_ARGS,
    }).catch((err) => {
      sharedBrowserPromise = null;
      throw err;
    });
  }
  return sharedBrowserPromise;
}

async function createTikTokContext(browser, cookies) {
  const parsed = parseCookies(cookies);
  if (parsed.length === 0) throw new Error("No usable cookies parsed");
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });
  await context.addCookies(parsed);
  return context;
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

async function publishOnCurrentEditor(page, advertiserId, campaignSketchId) {
  const prep = await prepareEditorForPublish(page);
  if (!prep.ready) {
    return { ok: false, error: `Editor not ready (${prep.lastAction})` };
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

    if (publishSucceeded(apiResult, uiResult, draftCheck)) {
      return {
        ok: true,
        verifiedBy: isPublishApiSuccess(apiResult?.detail) ? "publish_api" : "ui",
      };
    }
    if (attempt === 1) {
      const retryPrep = await prepareEditorForPublish(page, 15_000);
      if (!retryPrep.ready) break;
    }
  }

  return {
    ok: false,
    error: [
      draftCheck?.published ? null : `draft=${draftCheck?.reason || "still_draft"}`,
      apiResult?.ok ? null : "publish_api_failed",
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

async function duplicateAndPublishOnce(page, listUrl, sourceCampaignId, newName, advertiserId) {
  const searchInput = page.locator('input[placeholder*="Search" i]').first();
  await searchInput.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await searchInput.fill("").catch(() => {});
  await searchInput.fill(sourceCampaignId).catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await page.waitForTimeout(1500);

  const rowSelector = `[data-row-key="${sourceCampaignId}"], [data-id="${sourceCampaignId}"]`;
  const row = page.locator(rowSelector).first();
  await row.waitFor({ state: "visible", timeout: 15_000 });
  await row.hover().catch(() => {});

  const dupClicked = await page.evaluate((id) => {
    const sel = `[data-row-key="${id}"], [data-id="${id}"]`;
    const r = document.querySelector(sel);
    if (!r) return false;
    for (const el of Array.from(r.querySelectorAll("button, a, [role='button']"))) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (/duplicate|copy/.test(t)) {
        el.click();
        return true;
      }
    }
    return false;
  }, sourceCampaignId);
  if (!dupClicked) throw new Error("Duplicate button not found on source row");

  const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="Name"]').first();
  await nameInput.waitFor({ state: "visible", timeout: 15_000 });
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

  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  await page.waitForSelector('button, [role="button"]', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(800);

  const sketchMatch = page.url().match(/campaign_draft_id=([^&]+)/);
  const campaignSketchId = sketchMatch?.[1] || page.url().match(/temp_campaign_id=([^&]+)/)?.[1] || "";

  const published = await publishOnCurrentEditor(page, advertiserId, campaignSketchId);
  if (!published.ok) throw new Error(published.error || "Publish failed");

  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const newId = await page.evaluate((name) => {
    for (const r of Array.from(document.querySelectorAll("[data-row-key], [data-id]"))) {
      const t = r.innerText || r.textContent || "";
      if (t.includes(name)) {
        return r.getAttribute("data-row-key") || r.getAttribute("data-id");
      }
    }
    return null;
  }, newName);

  return newId || campaignSketchId || null;
}

async function duplicateCampaignsCore({ advertiserId, campaignId, names, cookies }) {
  const browser = await getSharedBrowser();
  const context = await createTikTokContext(browser, cookies);
  const page = await context.newPage();
  const listUrl = `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${encodeURIComponent(advertiserId)}`;

  try {
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (page.url().includes("/login") || page.url().includes("/passport")) {
      return { ok: false, error: "TikTok session expired. Re-paste cookies.", results: [] };
    }
    await page.waitForSelector('button, [role="button"], input', { timeout: 15_000 }).catch(() => {});

    const results = [];
    for (const name of names) {
      try {
        const newCampaignId = await duplicateAndPublishOnce(
          page,
          listUrl,
          campaignId,
          name,
          advertiserId
        );
        results.push({ name, ok: true, newCampaignId });
      } catch (e) {
        results.push({
          name,
          ok: false,
          error: e instanceof Error ? e.message : "unknown error",
        });
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    return { ok: okCount > 0, published: okCount, total: results.length, results };
  } finally {
    await context.close().catch(() => {});
  }
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

app.post("/duplicate", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { advertiserId, campaignId, names, cookies } = req.body || {};
  if (!advertiserId || !campaignId || !Array.isArray(names) || names.length === 0 || !cookies) {
    return res.status(400).json({
      error: "advertiserId, campaignId, names[], cookies required",
    });
  }
  if (names.length > 20) {
    return res.status(400).json({ error: "Max 20 copies per request" });
  }

  await acquirePublishSlot();
  const started = Date.now();
  try {
    const out = await duplicateCampaignsCore({ advertiserId, campaignId, names, cookies });
    if (out.error?.includes("expired")) {
      return res.status(401).json(out);
    }
    return res.json({
      ...out,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  } finally {
    releasePublishSlot();
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
  const results = await Promise.all(
    drafts.map(async (draft, index) => {
      const campaignSketchId = String(draft?.campaignSketchId || draft?.sketchId || "");
      const name = draft?.name ? String(draft.name) : undefined;
      if (!campaignSketchId) {
        return { name, campaignSketchId: "", ok: false, error: "campaignSketchId required" };
      }

      await acquirePublishSlot();
      try {
        const result = await publishDraftCore({
          advertiserId,
          campaignSketchId,
          cookies,
          skipAccountWarmup: index > 0,
        });
        return { name, campaignSketchId, ...result };
      } catch (err) {
        return {
          name,
          campaignSketchId,
          ok: false,
          error: err instanceof Error ? err.message : "Internal error",
        };
      } finally {
        releasePublishSlot();
      }
    })
  );

  const okCount = results.filter((r) => r.ok).length;
  return res.json({
    ok: okCount === results.length,
    published: okCount,
    total: results.length,
    elapsedMs: Date.now() - started,
    results,
  });
});

function parseCookies(raw) {
  const trimmed = String(raw).trim();
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
          sameSite: c.sameSite || "Lax",
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
