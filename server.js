/**
 * adsalim-vm-service
 *
 * HTTP wrapper around Playwright. Exposes one endpoint, /publish-draft,
 * that takes a TikTok draft (sketch) ID and clicks "Publish all" in
 * the real campaign editor. We can't do that from a serverless function
 * because TikTok's anti-bot rejects HTTP replays of the publish call
 * (X-Bogus signatures must come from a real browser context).
 *
 * The DUPLICATE step happens in adsalim itself via cURL replay (works
 * reliably). The VM is only used for the publish step.
 *
 * Endpoint:
 *   POST /publish-draft
 *   Auth: Authorization: Bearer <SHARED_SECRET>
 *   Body: {
 *     advertiserId: string,
 *     campaignSketchId: string,  // returned by the duplicate step
 *     cookies: string,           // TikTok session
 *   }
 *   Returns: { ok: boolean, newCampaignId?: string, error?: string }
 */

const express = require("express");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || "";
const MAX_CONCURRENT_PUBLISH = Number(process.env.MAX_CONCURRENT_PUBLISH || 1);
const SERVICE_VERSION = "1.1.3";

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) => {
  res.json({
    service: "adsalim-vm-service",
    status: "ok",
    version: SERVICE_VERSION,
    maxConcurrentPublish: MAX_CONCURRENT_PUBLISH,
    endpoints: ["/publish-draft", "/screenshots/:id"],
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

// In-memory screenshot store (last 20). Each /publish-draft failure
// saves a screenshot of the page state and surfaces a URL in the error.
const screenshots = new Map();
let screenshotCounter = 0;

let activePublishJobs = 0;
const publishWaiters = [];

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
      if (Number(style.opacity) < 0.1) return false;
      const text = (el.innerText || el.textContent || "").trim().toLowerCase();
      return /^publish all(\s*[▾▼⌄↓])?$|^publish$/.test(text);
    });
  }, publishAllSelector()).catch(() => false);
}

async function clickButtonMatching(page, patternSource, patternFlags) {
  if (page.isClosed()) return null;
  return page
    .evaluate(
      ({ sel, patSource, patFlags }) => {
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
      { sel: publishAllSelector(), patSource: patternSource, patFlags: patternFlags }
    )
    .catch(() => null);
}

async function prepareEditorForPublish(page, timeoutMs = 60_000) {
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
      await page.waitForTimeout(1200);
      continue;
    }

    const createAnyway = await clickButtonMatching(page, "create anyway", "i");
    if (createAnyway) {
      lastAction = "create_anyway";
      await page.waitForTimeout(3000);
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
      await page.waitForTimeout(2000);
      continue;
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1000);
  }

  return { ready: false, lastAction };
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
    return {
      hasSuccess,
      hasError,
      publishStillVisible,
      bodyText: bodyText.slice(0, 800),
      url: location.href,
    };
  });
}

async function waitForPublishOutcome(page, timeoutMs = 45_000) {
  let apiOk = false;
  let apiDetail = null;

  const responseWatcher = page
    .waitForResponse(
      (resp) => {
        const url = resp.url();
        if (!/ads\.tiktok\.com/i.test(url)) return false;
        if (resp.request().method() !== "POST") return false;
        return /publish|submit|creation|campaign|sketch/i.test(url);
      },
      { timeout: timeoutMs }
    )
    .then(async (resp) => {
      try {
        const json = await resp.json();
        const code = json?.code ?? json?.status_code ?? json?.statusCode;
        const msg = json?.msg ?? json?.message ?? "";
        if (code === 0 || code === "0" || /success/i.test(String(msg))) {
          apiOk = true;
          apiDetail = { code, msg };
        } else {
          apiDetail = { code, msg, url: resp.url() };
        }
      } catch {
        apiDetail = { url: resp.url(), parseError: true };
      }
    })
    .catch(() => {});

  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      return { verified: false, reason: "page_closed", state: lastState, apiDetail };
    }
    lastState = await readPublishPageState(page);
    if (lastState.hasError && !lastState.hasSuccess) {
      await responseWatcher;
      return { verified: false, reason: "ui_error", state: lastState, apiDetail };
    }
    if (lastState.hasSuccess || apiOk) {
      await responseWatcher;
      return { verified: true, reason: "success_signal", state: lastState, apiDetail };
    }
    if (!lastState.publishStillVisible && (lastState.hasSuccess || apiOk)) {
      await responseWatcher;
      return { verified: true, reason: "publish_ui_cleared", state: lastState, apiDetail };
    }
    await page.waitForTimeout(1000);
  }

  await responseWatcher;
  if (apiOk) {
    return { verified: true, reason: "api_ok", state: lastState, apiDetail };
  }
  if (apiDetail && apiDetail.code != null && apiDetail.code !== 0 && apiDetail.code !== "0") {
    return { verified: false, reason: "api_error", state: lastState, apiDetail };
  }
  return { verified: false, reason: "timeout", state: lastState, apiDetail };
}

async function confirmDraftGone(page, advertiserId, campaignSketchId) {
  await page.goto(buildEditorUrl(advertiserId, campaignSketchId), {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForTimeout(2500);

  const check = await page.evaluate(() => {
    const bodyText = (document.body.innerText || "").slice(0, 4000);
    const publishStillVisible = Array.from(
      document.querySelectorAll(
        'button, [role="button"], a, [class*="btn" i], [class*="button" i]'
      )
    ).some((el) => {
      if (el.disabled) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const text = (el.innerText || el.textContent || "").trim().toLowerCase();
      return /^publish all(\s*[▾▼⌄])?$|^publish$/.test(text);
    });
    const draftMissing = /draft.*not found|no longer available|doesn't exist|已删除|不存在|invalid draft/i.test(
      bodyText
    );
    return {
      publishStillVisible,
      draftMissing,
      bodyText: bodyText.slice(0, 400),
      url: location.href,
    };
  });

  if (check.draftMissing) return { gone: true, reason: "draft_not_found" };
  if (check.publishStillVisible) {
    return { gone: false, reason: "publish_button_still_visible", check };
  }
  if (!check.url.includes("campaign_draft_id")) {
    return { gone: true, reason: "redirected_from_editor" };
  }
  return { gone: false, reason: "draft_editor_still_accessible", check };
}

async function clickPublishAll(page) {
  if (page.isClosed()) return false;
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(400);
  return page
    .evaluate((sel) => {
      const all = Array.from(document.querySelectorAll(sel));
      for (const el of all) {
        if (el.disabled) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (Number(style.opacity) < 0.1) continue;
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
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const b of buttons.reverse()) {
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

function saveScreenshot(buf) {
  const id = `${Date.now()}-${++screenshotCounter}`;
  screenshots.set(id, buf);
  // Keep only the last 20.
  if (screenshots.size > 20) {
    const oldest = screenshots.keys().next().value;
    screenshots.delete(oldest);
  }
  return id;
}

app.get("/screenshots/:id", (req, res) => {
  const buf = screenshots.get(req.params.id);
  if (!buf) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "image/png");
  res.send(buf);
});

app.post("/publish-draft", async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!SHARED_SECRET || auth !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { advertiserId, campaignSketchId, cookies } = req.body || {};
  if (!advertiserId || !campaignSketchId || !cookies) {
    return res.status(400).json({
      error: "advertiserId, campaignSketchId, cookies required",
    });
  }

  await acquirePublishSlot();

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
    });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
    });

    const parsedCookies = parseCookies(cookies);
    if (parsedCookies.length === 0) {
      await browser.close();
      return res.status(400).json({ error: "No usable cookies parsed" });
    }
    await context.addCookies(parsedCookies);

    const page = await context.newPage();

    // First, hit the campaign manager for THIS advertiser. The captured
    // cookies' "last active" advertiser may differ from the one we want
    // to publish in — this initial navigation tells TikTok to activate
    // the requested account so subsequent draft-editor calls have the
    // right context.
    await page.goto(
      `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${encodeURIComponent(advertiserId)}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 }
    ).catch(() => {});
    await page.waitForTimeout(1500);

    // Now navigate to the draft editor using TikTok's exact URL shape
    // from the captured publish-request referer.
    const editorUrl = buildEditorUrl(advertiserId, campaignSketchId);

    async function loadEditorAndPrepare() {
      await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      if (page.url().includes("/login") || page.url().includes("/passport")) {
        return { loginExpired: true };
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForSelector('button, [role="button"]', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(800);
      const prep = await prepareEditorForPublish(page);
      return { loginExpired: false, prep };
    }

    const initial = await loadEditorAndPrepare();
    if (initial.loginExpired) {
      await browser.close();
      return res.status(401).json({ error: "TikTok session expired. Re-paste cookies." });
    }
    if (!initial.prep.ready) {
      const diag = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll(
          'button, [role="button"], a, div, span, [class*="btn" i], [class*="button" i]'
        )).map(b => ({
          tag: b.tagName.toLowerCase(),
          text: (b.innerText || b.textContent || "").trim().slice(0, 60),
          disabled: !!b.disabled,
        })).filter(b => b.text).slice(0, 50);
        return { url: location.href, all };
      });
      const shot = await page.screenshot({ fullPage: true }).catch(() => null);
      const shotId = shot ? saveScreenshot(shot) : null;
      const base = req.protocol + "://" + req.get("host");
      await browser.close();
      browser = null;
      return res.status(500).json({
        error: `Editor not ready for publish (last=${initial.prep.lastAction}). url=${diag.url} | screenshot=${shotId ? `${base}/screenshots/${shotId}` : "n/a"} | clickables=${JSON.stringify(diag.all).slice(0, 1500)}`,
      });
    }

    // Step C/D: click Publish all (retry once if verification fails).
    let outcome = null;
    let draftCheck = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const publishClicked = await clickPublishAll(page);
      if (!publishClicked) {
        const diag = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll(
            'button, [role="button"], a, [class*="btn" i], [class*="button" i]'
          )).map(b => ({
            tag: b.tagName.toLowerCase(),
            text: (b.innerText || b.textContent || "").trim().slice(0, 60),
            disabled: !!b.disabled,
          })).filter(b => b.text).slice(0, 50);
          return { url: location.href, all };
        });
        const shot = await page.screenshot({ fullPage: true }).catch(() => null);
        const shotId = shot ? saveScreenshot(shot) : null;
        const base = req.protocol + "://" + req.get("host");
        await browser.close();
        browser = null;
        return res.status(500).json({
          error: `Publish button not found. url=${diag.url} | screenshot=${shotId ? `${base}/screenshots/${shotId}` : "n/a"} | clickables=${JSON.stringify(diag.all).slice(0, 1500)}`,
        });
      }

      await clickConfirmDialog(page);
      outcome = await waitForPublishOutcome(page);
      draftCheck = await confirmDraftGone(page, advertiserId, campaignSketchId);

      if (outcome.verified && draftCheck.gone) break;

      if (attempt === 1) {
        const retry = await loadEditorAndPrepare();
        if (retry.loginExpired) break;
        if (!retry.prep.ready) break;
      }
    }

    const shot = await page.screenshot({ fullPage: false }).catch(() => null);
    const shotId = shot ? saveScreenshot(shot) : null;
    const base = req.protocol + "://" + req.get("host");

    await browser.close();
    browser = null;

    if (!outcome?.verified || !draftCheck?.gone) {
      const detail = [
        outcome?.verified ? null : `outcome=${outcome?.reason || "unknown"}`,
        draftCheck?.gone ? null : `draft=${draftCheck?.reason || "still_present"}`,
        outcome?.apiDetail ? `api=${JSON.stringify(outcome.apiDetail)}` : null,
        draftCheck?.check?.bodyText ? `body=${draftCheck.check.bodyText}` : outcome?.state?.bodyText ? `body=${outcome.state.bodyText}` : null,
        shotId ? `screenshot=${base}/screenshots/${shotId}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      return res.status(500).json({
        ok: false,
        error: `Publish not verified. ${detail}`,
        screenshot: shotId ? `${base}/screenshots/${shotId}` : undefined,
      });
    }

    return res.json({
      ok: true,
      newCampaignId: campaignSketchId,
      verifiedBy: `${outcome.reason}+${draftCheck.reason}`,
      screenshot: shotId ? `${base}/screenshots/${shotId}` : undefined,
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  } finally {
    releasePublishSlot();
  }
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
  console.log(`adsalim-vm-service listening on :${PORT}`);
});
