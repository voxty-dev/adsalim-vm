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

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) => {
  res.json({ service: "adsalim-vm-service", status: "ok", endpoints: ["/publish-draft", "/screenshots/:id"] });
});

// In-memory screenshot store (last 20). Each /publish-draft failure
// saves a screenshot of the page state and surfaces a URL in the error.
const screenshots = new Map();
let screenshotCounter = 0;

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

    // Navigate to the draft editor using TikTok's exact URL shape from
    // the captured publish-request referer. Both campaign_draft_id and
    // temp_campaign_id point at the sketch id.
    const editorUrl =
      `https://ads.tiktok.com/i18n/creation/1nn/create/campaign?aadvid=${encodeURIComponent(advertiserId)}` +
      `&source=campaign_list` +
      `&campaign_draft_id=${encodeURIComponent(campaignSketchId)}` +
      `&creation_type=create_new` +
      `&objective_type=3` +
      `&temp_campaign_id=${encodeURIComponent(campaignSketchId)}`;
    await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (page.url().includes("/login") || page.url().includes("/passport")) {
      await browser.close();
      return res.status(401).json({ error: "TikTok session expired. Re-paste cookies." });
    }

    // Wait for editor to render fully.
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Step A: dismiss any onboarding tooltips ("Got it" buttons) so they
    // don't block subsequent clicks.
    await page.evaluate(() => {
      const gotItButtons = Array.from(document.querySelectorAll("button"))
        .filter(b => /^got it$/i.test((b.innerText || "").trim()));
      for (const b of gotItButtons) b.click();
    }).catch(() => {});
    await page.waitForTimeout(500);

    // Step B: if a validation warning is shown ("Check ad groups" +
    // "Create anyway"), click "Create anyway" to dismiss and transition
    // to the real editor. The URL won't change but the DOM will.
    const dismissedWarning = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const createAnyway = buttons.find(b => {
        const t = (b.innerText || "").trim().toLowerCase();
        return /create anyway/.test(t) && !b.disabled;
      });
      if (createAnyway) {
        createAnyway.click();
        return true;
      }
      return false;
    });
    if (dismissedWarning) {
      await page.waitForTimeout(2000); // let the editor transition render
    }

    // Step C: scroll to surface the sticky-footer Publish button.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    // Step D: click "Publish all". TikTok renders this as a styled <div>
    // (with a dropdown arrow), not a <button> — so we widen the
    // selector to any clickable element. Match strictly on visible text
    // so we don't accidentally click the dropdown arrow's own item.
    const publishClicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll(
        'button, [role="button"], a, [class*="btn" i], [class*="button" i]'
      ));
      const patterns = [/^publish all$/, /^publish$/];
      for (const pat of patterns) {
        const match = all.find(el => {
          if (el.disabled) return false;
          // Skip hidden elements
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const text = (el.innerText || el.textContent || "").trim().toLowerCase();
          // Some elements wrap "Publish all" with a dropdown arrow icon
          // ("Publish all ▾") — match if text starts with publish all.
          return pat.test(text) || /^publish all\s*[▾▼⌄]/i.test(text);
        });
        if (match) {
          match.scrollIntoView({ block: "center" });
          match.click();
          return (match.innerText || match.textContent || "").trim();
        }
      }
      return false;
    });

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
      return res.status(500).json({
        error: `Publish button not found. url=${diag.url} | screenshot=${shotId ? `${base}/screenshots/${shotId}` : "n/a"} | clickables=${JSON.stringify(diag.all).slice(0, 1500)}`,
      });
    }

    // After clicking Publish all, TikTok shows a confirm dialog OR
    // immediately submits + redirects. Wait briefly then look for a
    // confirm button in any visible dialog.
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      for (const b of buttons.reverse()) {
        const t = (b.innerText || b.textContent || "").trim().toLowerCase();
        if (/^(confirm|publish|publish all|submit|ok)$/.test(t) && !b.disabled) {
          // Only click confirm buttons in a dialog/popup — skip the
          // original publish button we already clicked.
          const inDialog =
            b.closest('[role="dialog"], [class*="modal" i], [class*="dialog" i], [class*="popup" i]');
          if (inDialog) {
            b.click();
            return true;
          }
        }
      }
      return false;
    }).catch(() => {});

    // Wait for navigation back to campaign list (= publish completed).
    const navigated = await page.waitForURL(
      /manage\/campaign|manage\/ad/,
      { timeout: 60_000 }
    ).then(() => true).catch(() => false);
    await page.waitForTimeout(2000);

    // If we never navigated away, publish probably didn't happen.
    if (!navigated) {
      const diag = await page.evaluate(() => {
        const url = location.href;
        const buttons = Array.from(document.querySelectorAll("button")).map(b => ({
          text: (b.innerText || "").trim().slice(0, 40),
          disabled: b.disabled,
        })).filter(b => b.text).slice(0, 25);
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i]')).length;
        return { url, buttons, dialogs };
      });
      const shot = await page.screenshot({ fullPage: true }).catch(() => null);
      const shotId = shot ? saveScreenshot(shot) : null;
      const base = req.protocol + "://" + req.get("host");
      await browser.close();
      return res.status(500).json({
        ok: false,
        error: `Clicked "${publishClicked}" but didn't navigate to campaign list. screenshot=${shotId ? `${base}/screenshots/${shotId}` : "n/a"} | url=${diag.url} | dialogs=${diag.dialogs} | buttons=${JSON.stringify(diag.buttons).slice(0, 800)}`,
      });
    }

    await browser.close();
    return res.json({
      ok: true,
      newCampaignId: campaignSketchId,
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
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
