/**
 * adsalim-vm-service
 *
 * HTTP wrapper around Playwright that drives TikTok Ads Manager UI to
 * duplicate Smart+ campaigns AND publish them (something serverless
 * Vercel can't do because (a) chromium libs are missing, (b) X-Bogus
 * signatures are body-dependent and TikTok rejects server-side replays).
 *
 * Endpoint:
 *   POST /duplicate
 *   Auth: header `Authorization: Bearer <SHARED_SECRET>`
 *   Body: {
 *     advertiserId: string,
 *     campaignId: string,
 *     names: string[],   // one new name per copy
 *     cookies: string,   // user's TikTok session (Cookie header string OR JSON array)
 *   }
 *   Returns: {
 *     results: Array<{ name, ok, newCampaignId?, error? }>,
 *     screenshot?: string // base64, on failure for debugging
 *   }
 *
 * Deploy on Railway / Render / Fly / a $5 Hetzner VPS.
 */

const express = require("express");
const { chromium } = require("playwright");

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || "";

const app = express();
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) => {
  res.json({ service: "adsalim-vm-service", status: "ok" });
});

app.post("/duplicate", async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!SHARED_SECRET || auth !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { advertiserId, campaignId, names, cookies } = req.body || {};
  if (!advertiserId || !campaignId || !Array.isArray(names) || names.length === 0 || !cookies) {
    return res.status(400).json({ error: "advertiserId, campaignId, names[], cookies required" });
  }
  if (names.length > 20) {
    return res.status(400).json({ error: "Max 20 copies per request" });
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
    const listUrl = `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${encodeURIComponent(advertiserId)}`;
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (page.url().includes("/login") || page.url().includes("/passport")) {
      await browser.close();
      return res.status(401).json({ error: "TikTok session expired. Re-paste cookies." });
    }

    // Wait for the campaign list table to render.
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    const results = [];
    for (const name of names) {
      try {
        const newId = await duplicateAndPublishOnce(page, campaignId, name);
        results.push({ name, ok: true, newCampaignId: newId });
      } catch (e) {
        results.push({ name, ok: false, error: e instanceof Error ? e.message : "unknown error" });
      }
    }

    await browser.close();
    return res.json({ results });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

/**
 * Drive TikTok's UI for one duplicate:
 *   1. Find the source campaign row
 *   2. Open its action menu and click Duplicate
 *   3. Fill the modal's name field and submit (creates the draft)
 *   4. The duplicate redirects to the draft editor
 *   5. Click "Publish all" in the editor
 *   6. Wait for the publish to complete
 *   7. Read the new campaign_id from the redirected list URL
 *
 * Selectors target TikTok's current production DOM. They WILL break
 * when TikTok ships a UI refactor — when that happens, update this
 * function with new selectors.
 */
async function duplicateAndPublishOnce(page, sourceCampaignId, newName) {
  // Search/filter for the source campaign so the row is visible.
  // TikTok's table is virtualized; filtering pins the row to the top.
  const searchInput = page.locator('input[placeholder*="Search" i]').first();
  await searchInput.waitFor({ state: "visible", timeout: 15_000 });
  await searchInput.fill("");
  await searchInput.type(sourceCampaignId);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);

  // Find the row that visibly contains the campaign_id text. TikTok's
  // DOM uses different attribute names per UI version — searching the
  // raw text is the most resilient.
  const rowFound = await page.evaluate((id) => {
    // Try common row containers: tr, [role="row"], or any direct table row
    const rows = Array.from(document.querySelectorAll(
      'tr, [role="row"], [class*="row" i]'
    ));
    for (const r of rows) {
      const t = (r.innerText || r.textContent || "");
      if (t.includes(id)) {
        // scroll the row into view so subsequent click works
        r.scrollIntoView({ block: "center" });
        return true;
      }
    }
    return false;
  }, sourceCampaignId);
  if (!rowFound) throw new Error(`Could not find row containing campaign id "${sourceCampaignId}" in the table`);
  await page.waitForTimeout(500);

  // Click Duplicate inside the row's action area. We re-find the row
  // by id text, then look for action buttons (icons, menus, etc.).
  // TikTok may render the Duplicate action behind a 3-dot menu or
  // directly as an icon on hover.
  const dupClicked = await page.evaluate((id) => {
    const rows = Array.from(document.querySelectorAll(
      'tr, [role="row"], [class*="row" i]'
    ));
    let row = null;
    for (const r of rows) {
      if ((r.innerText || "").includes(id)) { row = r; break; }
    }
    if (!row) return false;
    // Hover the row to expose action icons
    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

    // First try: a button / link with Duplicate / Copy text inside the row
    const inline = Array.from(row.querySelectorAll("button, a, [role='button']"));
    for (const el of inline) {
      const t = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().toLowerCase();
      if (/duplicate|copy/.test(t)) {
        el.click();
        return true;
      }
    }
    // Second try: open the row's action menu (3-dot icon) then look
    // for a Duplicate menu item in the popup that appears.
    for (const el of inline) {
      const t = (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().toLowerCase();
      if (/more|menu|action|⋯|⋮/.test(t) || el.querySelector('[class*="more" i], [class*="menu" i]')) {
        el.click();
        return "menu-opened";
      }
    }
    return false;
  }, sourceCampaignId);

  if (dupClicked === "menu-opened") {
    // Menu opened, wait for popup and click Duplicate inside it
    await page.waitForTimeout(500);
    const menuClicked = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(
        '[role="menuitem"], [class*="menu-item" i], li, button'
      ));
      for (const el of items) {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        if (/^(duplicate|copy)$/.test(t) || /duplicate campaign|copy campaign/.test(t)) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (!menuClicked) throw new Error("Opened row menu but no Duplicate item inside");
  } else if (!dupClicked) {
    throw new Error("Duplicate button/menu not found on source row");
  }

  // Fill the name input in the modal.
  const nameInput = page
    .locator('input[placeholder*="name" i], input[placeholder*="Name"]')
    .first();
  await nameInput.waitFor({ state: "visible", timeout: 15_000 });
  await nameInput.fill("");
  await nameInput.type(newName, { delay: 30 });

  // Submit the modal — usually the last enabled button.
  const submitted = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const el of buttons.reverse()) {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      if (/^(duplicate|confirm|submit|ok)$/.test(t) && !el.disabled) {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!submitted) throw new Error("Modal submit button not found");

  // TikTok navigates to the draft editor. Wait for "Publish all".
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  const publishBtn = page.getByRole("button", { name: /publish all|publish/i }).first();
  await publishBtn.waitFor({ state: "visible", timeout: 20_000 });
  await publishBtn.click();

  // Wait for publish to complete — TikTok redirects back to campaign list.
  await page.waitForURL(/manage\/campaign/, { timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

  // Pull the new campaign_id by searching the list for the new name.
  const newId = await page.evaluate((name) => {
    const rows = Array.from(document.querySelectorAll("[data-row-key], [data-id]"));
    for (const r of rows) {
      const t = (r.innerText || r.textContent || "");
      if (t.includes(name)) {
        return r.getAttribute("data-row-key") || r.getAttribute("data-id");
      }
    }
    return null;
  }, newName);
  return newId;
}

/**
 * Parse cookies pasted from DevTools. Accepts:
 *   - "name=value; name=value" (Cookie header form)
 *   - JSON array from extensions like EditThisCookie
 */
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
