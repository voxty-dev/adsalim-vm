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
  res.json({
    service: "adsalim-vm-service",
    status: "ok",
    endpoints: [
      "/publish-draft",
      "/create-smart-plus-campaign",
      "/screenshots/:id",
    ],
  });
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

    // Wait just for DOM-ready instead of networkidle — TikTok's
    // analytics pings keep the network busy forever, so networkidle
    // wastes its full 30s timeout. domcontentloaded fires fast.
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});

    // Wait specifically until SOME button is rendered. Most of the
    // page's UI mounts within a second of DOM-ready.
    await page.waitForSelector('button, [role="button"]', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);

    // Step A: dismiss any onboarding tooltips ("Got it" buttons) so they
    // don't block subsequent clicks.
    await page.evaluate(() => {
      const gotItButtons = Array.from(document.querySelectorAll("button"))
        .filter(b => /^got it$/i.test((b.innerText || "").trim()));
      for (const b of gotItButtons) b.click();
    }).catch(() => {});

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
      // Editor transition is fast — 800ms is plenty.
      await page.waitForTimeout(800);
    }

    // Step C: scroll to surface the sticky-footer Publish button.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(400);

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

    // After clicking Publish all, TikTok may show a confirm dialog OR
    // immediately submit. We click any confirm button if present, then
    // wait briefly for the submit to fire. URL doesn't reliably change
    // (TikTok often stays on the same page post-publish + shows a
    // success toast), so we just trust the click — the campaign list
    // will show the new state.
    await page.waitForTimeout(800);
    await page.evaluate(() => {
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
    }).catch(() => {});

    // Poll for an explicit success/error signal for up to 15s. Previous
    // version was fail-OPEN (returned ok:true unless an explicit error
    // was visible) which silently masked publishes that quietly stalled
    // — the campaigns then showed up as drafts in TikTok while adsalim
    // reported "published". Now fail-CLOSED: no success toast within
    // the window = ok:false.
    let postState = { hasSuccess: false, hasError: false, bodyText: "", url: page.url() };
    const POLL_MS = 500;
    const POLL_MAX = 30; // 30 * 500ms = 15s
    for (let attempt = 0; attempt < POLL_MAX; attempt++) {
      await page.waitForTimeout(POLL_MS);
      postState = await page.evaluate(() => {
        const bodyText = (document.body.innerText || "").slice(0, 5000);
        const hasSuccess = /publish.*success|published successfully|create success|成功/i.test(bodyText);
        const hasError = /failed|error|insufficient|permission denied|risk/i.test(bodyText.slice(0, 2000));
        return { hasSuccess, hasError, bodyText: bodyText.slice(0, 800), url: location.href };
      });
      if (postState.hasSuccess || postState.hasError) break;
    }

    const shot = await page.screenshot({ fullPage: false }).catch(() => null);
    const shotId = shot ? saveScreenshot(shot) : null;
    const base = req.protocol + "://" + req.get("host");
    const shotUrl = shotId ? `${base}/screenshots/${shotId}` : "n/a";

    await browser.close();

    if (postState.hasError && !postState.hasSuccess) {
      return res.status(500).json({
        ok: false,
        error: `Post-publish shows error. screenshot=${shotUrl} | body=${postState.bodyText}`,
      });
    }

    if (!postState.hasSuccess) {
      return res.status(500).json({
        ok: false,
        error: `No publish success toast after 15s — draft likely still pending. screenshot=${shotUrl} | url=${postState.url} | body=${postState.bodyText}`,
      });
    }

    return res.json({
      ok: true,
      newCampaignId: campaignSketchId,
      screenshot: shotUrl !== "n/a" ? shotUrl : undefined,
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
  }
});

// ===========================================================
//  /create-smart-plus-campaign
//  MVP — drive TikTok's "Create Campaign" UI via Playwright instead
//  of guessing the public-API field shape. Body:
//    {
//      advertiserId: string,
//      cookies: string,
//      objective: "SALES" | "TRAFFIC" | ...,  // default SALES
//      destination: "WEBSITE" | "APP" | ...,  // default WEBSITE
//      campaignName: string,
//      adgroupBudgetUSD: number,              // daily, per adgroup
//    }
//  Returns: { ok, screenshots: string[], url, bodyExcerpt, error? }
//  Each navigation step takes a screenshot so the caller can see
//  exactly what the VM saw at every stage. This is intentionally
//  a "navigate + observe" first cut — once selectors are confirmed
//  via the screenshots we layer in form-filling + submit.
// ===========================================================
app.post("/create-smart-plus-campaign", async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!SHARED_SECRET || auth !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const {
    advertiserId,
    cookies,
    objective = "SALES",
    destination = "WEBSITE",
    campaignName = "VM-created campaign",
    adgroupBudgetUSD = 20,
    // Ad-group settings applied on step 2.
    pixelId = null,
    pixelName = null,           // Human-readable label TikTok shows ("PRST TR 3")
    optimizationEvent = null,   // e.g. "SHOPPING", "PURCHASE", "ADD_TO_CART"
    countryIds = [],            // TikTok numeric location IDs
    ageGroupIds = [],           // ["AGE_18_24", ...]
    gender = null,              // "GENDER_UNLIMITED" | "GENDER_MALE" | "GENDER_FEMALE"
    targetCPA = null,           // number or null
    bidStrategy = null,         // "BID_TYPE_NO_BID" or "BID_TYPE_CUSTOM"
  } = req.body || {};
  if (!advertiserId || !cookies) {
    return res.status(400).json({ error: "advertiserId and cookies required" });
  }

  const base = req.protocol + "://" + req.get("host");
  const shots = [];

  async function shot(page, label) {
    try {
      const buf = await page.screenshot({ fullPage: false });
      const id = saveScreenshot(buf);
      shots.push({ label, url: `${base}/screenshots/${id}` });
    } catch {}
  }

  // Click any clickable element whose visible text matches `re`.
  // Strategy: try radio/label/row-style containers FIRST (TikTok renders
  // objectives as <label> wrapping a radio input — clicking a random span
  // inside doesn't toggle the radio). Fall back to broader pool only if
  // the first pass finds nothing.
  async function clickByText(page, re, label) {
    const clicked = await page.evaluate((rs) => {
      const re = new RegExp(rs);
      function visible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (style.pointerEvents === "none") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      function clickFor(el) {
        el.scrollIntoView({ block: "center" });
        // Trigger a real-looking click sequence — some React forms ignore
        // a bare .click() and only respond to pointerdown/mouseup chains.
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.click();
        // If the matched element contains a radio input, also click it
        // directly so its state actually toggles.
        const radio = el.querySelector?.('input[type="radio"], [role="radio"]');
        if (radio) {
          radio.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          radio.click();
        }
      }

      // Pass 1: prefer radio-like rows / labels / option cards.
      const radioRows = Array.from(document.querySelectorAll(
        'label, [role="radio"], [role="option"], [class*="radio" i], [class*="option-item" i], [class*="objective" i], [class*="card" i], [class*="row" i]',
      ));
      for (const el of radioRows) {
        if (el.disabled || !visible(el)) continue;
        const text = (el.innerText || "").trim();
        if (!text || text.length > 120) continue;
        if (!re.test(text)) continue;
        clickFor(el);
        return text;
      }

      // Pass 2: broader pool (any clickable-ish element).
      const all = Array.from(document.querySelectorAll(
        'button, [role="button"], a, li, div, span',
      ));
      for (const el of all) {
        if (el.children.length > 6) continue;
        if (el.disabled || !visible(el)) continue;
        const text = (el.innerText || el.textContent || "").trim();
        if (!text || text.length > 120) continue;
        if (!re.test(text)) continue;
        clickFor(el);
        return text;
      }
      return null;
    }, re.source);
    if (!clicked) console.warn(`[create-campaign] could not click "${label}" via ${re}`);
    return clicked;
  }

  // Dismiss any onboarding / announcement modal blocking the page.
  // Tries (in order): the modal's top-right close button, "Got It",
  // "Got it", and falls back to ESC.
  async function dismissModals(page) {
    await page.evaluate(() => {
      // 1) Close icons inside dialogs.
      const closes = Array.from(document.querySelectorAll(
        '[role="dialog"] [aria-label*="close" i], [role="dialog"] [class*="close" i], [class*="modal" i] [aria-label*="close" i]',
      ));
      for (const c of closes) {
        try { c.click(); } catch {}
      }
      // 2) "Got It" / "Got it" buttons (scans every button — covers both
      //    the announcement modal and inline "Choose your X" tooltips).
      const btns = Array.from(document.querySelectorAll("button"));
      for (const b of btns) {
        const t = (b.innerText || "").trim();
        if (/^got\s*it$/i.test(t)) { try { b.click(); } catch {} }
      }
    }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }

  // Find a labelled toggle (e.g. "Catalog campaign") and force it OFF.
  // TikTok toggles render as <button role="switch">, <div class="switch">,
  // or a wrapped <input type="checkbox">. Different parts of the form use
  // different patterns, so the search casts a wide net + falls back to
  // clicking the label itself.
  async function setToggleOff(page, labelRe) {
    return await page.evaluate((rs) => {
      const re = new RegExp(rs);

      function visible(el) {
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
      }

      function clickFor(el) {
        try { el.scrollIntoView({ block: "center" }); } catch {}
        try { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); } catch {}
        try { el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); } catch {}
        try { el.click(); } catch {}
      }

      function isChecked(el) {
        const aria = el.getAttribute("aria-checked");
        if (aria === "true") return true;
        if (aria === "false") return false;
        const cls = (el.className && typeof el.className === "string") ? el.className : "";
        if (/(?:^|[\s_-])(checked|active|on|open|true)(?:[\s_-]|$)/i.test(cls)) return true;
        // Wrapped <input>
        const input = el.querySelector?.('input[type="checkbox"], input[type="radio"]');
        if (input && input.checked) return true;
        return false;
      }

      // Find the label/text node.
      let label = null;
      const all = Array.from(document.querySelectorAll("*"));
      for (const el of all) {
        if (el.children.length > 1) continue;
        const t = (el.innerText || el.textContent || "").trim();
        if (!t || t.length > 60) continue;
        if (re.test(t)) { label = el; break; }
      }
      if (!label) return { found: false, reason: "label-text-not-found" };

      // Walk ancestors collecting toggle candidates within each subtree.
      let cursor = label;
      for (let i = 0; i < 8 && cursor; i++) {
        const parent = cursor.parentElement;
        if (!parent) break;
        const candidates = Array.from(parent.querySelectorAll(
          '[role="switch"], button[role="checkbox"], [aria-checked], ' +
          '[class*="switch" i]:not([class*="switcher" i]), ' +
          '[class*="toggle" i], [class*="checkbox" i]',
        )).filter(visible);
        for (const c of candidates) {
          // Don't accept the label container itself as the toggle.
          if (c.contains(label) || label.contains(c)) {
            const checked = isChecked(c);
            if (checked) { clickFor(c); return { found: true, wasOn: true, strategy: "inside" }; }
          } else {
            const checked = isChecked(c);
            if (checked) { clickFor(c); return { found: true, wasOn: true, strategy: "sibling" }; }
            // Found a toggle but it's already off — done.
            return { found: true, wasOn: false, strategy: "sibling-off" };
          }
        }
        cursor = parent;
      }

      // Fallback — click the label itself; toggles inside <label> respond
      // to label clicks via input association.
      clickFor(label);
      return { found: true, wasOn: "unknown", strategy: "label-click" };
    }, labelRe.source);
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

    // 1. Activate the advertiser context.
    await page.goto(
      `https://ads.tiktok.com/i18n/manage/campaign?aadvid=${encodeURIComponent(advertiserId)}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    ).catch(() => {});
    await page.waitForTimeout(1500);

    // 2. Open the Create Campaign flow directly.
    await page.goto(
      `https://ads.tiktok.com/i18n/creation/1nn/create/campaign?aadvid=${encodeURIComponent(advertiserId)}&creation_type=create_new`,
      { waitUntil: "domcontentloaded", timeout: 45_000 },
    );

    if (page.url().includes("/login") || page.url().includes("/passport")) {
      await browser.close();
      return res.status(401).json({ error: "TikTok session expired. Re-paste cookies." });
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await page.waitForSelector('button, [role="button"]', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);

    await shot(page, "01-initial");

    // 3. Dismiss the "Find your tools in a new place" / coachmark modals.
    //    They render late, so loop a few times until either no modal
    //    remains or we run out of attempts.
    for (let i = 0; i < 4; i++) {
      await dismissModals(page);
      await page.waitForTimeout(400);
      const stillBlocked = await page.evaluate(() =>
        !!document.querySelector('[role="dialog"]:not([aria-hidden="true"])'),
      ).catch(() => false);
      if (!stillBlocked) break;
    }
    await shot(page, "01b-after-modal-dismiss");

    // 4. Pick objective (default Sales). The objective rows are radio
    //    inputs labeled by adjacent text — clickByText now prefers
    //    radio/label/row-style containers.
    const objectiveLabel = objective === "TRAFFIC" ? "Traffic"
      : objective === "REACH" ? "Reach"
      : "Sales";
    const objClicked = await clickByText(page, new RegExp(`^\\s*${objectiveLabel}\\s*$`, "i"), `objective:${objectiveLabel}`);
    await page.waitForTimeout(1500);
    await dismissModals(page); // TikTok re-renders the announcement after objective change
    await shot(page, "02-after-objective");

    // 5. Pick destination (default Website). Same announcement modal
    //    sometimes pops back during this transition.
    const destLabel = destination === "APP" ? "App"
      : destination === "TIKTOK_SHOP" ? "TikTok Shop"
      : "Website";
    const destClicked = await clickByText(page, new RegExp(`^\\s*${destLabel}\\s*$`, "i"), `destination:${destLabel}`);
    await page.waitForTimeout(1200);
    await dismissModals(page);
    await shot(page, "03-after-destination");

    // 6. Fill campaign name. The input is below the fold and TikTok
    //    pre-fills it with an auto-generated name ("Sales20260629…"),
    //    so we scroll into view, clear, then type. The label "Campaign
    //    name" is a sibling div, not a <label for=…>, so we look at
    //    nearby text instead of using closest('label').
    const nameFilled = await page.evaluate((name) => {
      const inputs = Array.from(document.querySelectorAll(
        'input[type="text"], input:not([type])',
      )).filter(inp => {
        const r = inp.getBoundingClientRect();
        const style = window.getComputedStyle(inp);
        return r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });

      function nearbyText(inp) {
        // Walk up to 6 ancestors looking at siblings for "Campaign name".
        let cursor = inp;
        for (let i = 0; i < 6 && cursor; i++) {
          const parent = cursor.parentElement;
          if (!parent) break;
          for (const sib of parent.children) {
            if (sib === cursor) continue;
            const t = (sib.innerText || sib.textContent || "").trim();
            if (!t || t.length > 60) continue;
            if (/^campaign\s*name$/i.test(t) || /^name$/i.test(t)) return true;
          }
          cursor = parent;
        }
        return false;
      }

      for (const inp of inputs) {
        const placeholder = (inp.getAttribute("placeholder") || "").toLowerCase();
        const ariaLabel = (inp.getAttribute("aria-label") || "").toLowerCase();
        const hitAttr = /campaign\s*name|^name$/.test(placeholder + " " + ariaLabel);
        // TikTok seeds the input with "Sales20260629…" etc. — recognise that
        // as the campaign-name input even if no label/aria text is present.
        const hitSeed = /^Sales\d{6,}|^Conversions?\d{6,}|^Traffic\d{6,}|^Reach\d{6,}/.test(inp.value || "");
        if (hitAttr || hitSeed || nearbyText(inp)) {
          inp.scrollIntoView({ block: "center" });
          inp.focus();
          // Select-all + clear, then type the new value via the native setter
          // so React's controlled-input value tracker actually updates.
          inp.select();
          const proto = window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(inp, "");
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          setter.call(inp, name);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          inp.dispatchEvent(new Event("blur", { bubbles: true }));
          return true;
        }
      }
      return false;
    }, campaignName);

    await page.waitForTimeout(500);
    await shot(page, "04-after-name");

    // 7. Force "Catalog campaign" toggle OFF — TikTok turns it on by
    //    default on some accounts when Sales→Website is selected, but
    //    a catalog campaign needs a catalog feed configured, which we
    //    don't have. Continue stays disabled until the toggle is off.
    //    Retry up to 3 times with a coordinate-click fallback between
    //    attempts in case the toggle isn't reachable by selector.
    let catalogOff = await setToggleOff(page, /^\s*Catalog\s*campaign\s*$/i);
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(600);
      // Check if it's still on by looking at any aria-checked=true near
      // the label, or a class with "checked|active|on".
      const stillOn = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*"));
        let label = null;
        for (const el of all) {
          if (el.children.length > 1) continue;
          const t = (el.innerText || "").trim();
          if (/^\s*Catalog\s*campaign\s*$/i.test(t)) { label = el; break; }
        }
        if (!label) return false;
        let cursor = label;
        for (let i = 0; i < 10 && cursor; i++) {
          const cands = Array.from(cursor.parentElement?.querySelectorAll(
            '[role="switch"], [aria-checked], [class*="switch" i], [class*="toggle" i]',
          ) ?? []);
          for (const c of cands) {
            const aria = c.getAttribute("aria-checked");
            const cls = (typeof c.className === "string") ? c.className : "";
            if (aria === "true") return true;
            if (/(?:^|[\s_-])(checked|active|on|true)(?:[\s_-]|$)/i.test(cls)) return true;
          }
          cursor = cursor.parentElement;
        }
        return false;
      });
      if (!stillOn) break;
      // Coordinate-based fallback: click ~28px to the LEFT of the label
      // (where TikTok's switch visually lives).
      const clicked = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*"));
        for (const el of all) {
          if (el.children.length > 1) continue;
          const t = (el.innerText || "").trim();
          if (!/^\s*Catalog\s*campaign\s*$/i.test(t)) continue;
          const r = el.getBoundingClientRect();
          const x = r.left - 28;
          const y = r.top + r.height / 2;
          const target = document.elementFromPoint(x, y);
          if (!target) return false;
          target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
          target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
          target.click();
          return true;
        }
        return false;
      });
      catalogOff = { found: true, wasOn: true, strategy: `coord-fallback-${attempt + 1}`, coordClicked: clicked };
    }

    // 8. Dismiss any inline tooltip popups (e.g. "Choose your budget
    //    strategy") that block the Continue button.
    await dismissModals(page);
    await page.waitForTimeout(300);

    // 9. Click "Continue" at the bottom of the page to advance to the
    //    ad-group step. Three-pass search since TikTok's primary action
    //    button isn't always a real <button>: it can be <a>, a div with
    //    role="button", or a span wrapped in a custom React component.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(600);
    await dismissModals(page);
    const continueClicked = await page.evaluate(() => {
      function visible(el) {
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && cs.pointerEvents !== "none";
      }
      function isDisabled(el) {
        if (el.disabled) return true;
        if (el.getAttribute("aria-disabled") === "true") return true;
        const cls = (typeof el.className === "string") ? el.className : "";
        return /disabled/i.test(cls);
      }
      function clickIt(el) {
        el.scrollIntoView({ block: "center" });
        try { el.focus(); } catch {}
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.click();
      }

      // Pass 1: real <button> or role="button" with innerText exactly "Continue".
      let candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const btn of candidates) {
        const text = (btn.innerText || btn.textContent || "").trim();
        if (!/^continue$/i.test(text)) continue;
        if (!visible(btn) || isDisabled(btn)) continue;
        clickIt(btn);
        return "pass1:button:" + text;
      }

      // Pass 2: any clickable with aria-label="Continue" / data-testid containing "continue".
      candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], a, [class*="btn" i], [class*="button" i]',
      ));
      for (const btn of candidates) {
        const aria = (btn.getAttribute("aria-label") || "").trim();
        const testid = (btn.getAttribute("data-testid") || "").toLowerCase();
        const matches = /^continue$/i.test(aria) || /continue/i.test(testid);
        if (!matches) continue;
        if (!visible(btn) || isDisabled(btn)) continue;
        clickIt(btn);
        return "pass2:aria-or-testid";
      }

      // Pass 3: walk up from any leaf with text "Continue" to a clickable parent.
      const all = Array.from(document.querySelectorAll("*"));
      for (const el of all) {
        if (el.children.length > 0) continue;
        const text = (el.innerText || el.textContent || "").trim();
        if (!/^continue$/i.test(text)) continue;
        let cursor = el;
        for (let i = 0; i < 8 && cursor; i++) {
          if (cursor.matches?.('button, [role="button"], a, [class*="btn" i], [class*="button" i]')) {
            if (visible(cursor) && !isDisabled(cursor)) {
              clickIt(cursor);
              return "pass3:walk-up:" + cursor.tagName.toLowerCase();
            }
          }
          cursor = cursor.parentElement;
        }
      }

      return null;
    });
    await page.waitForTimeout(4000);
    await dismissModals(page);
    await shot(page, "05-after-continue");
    // Carry the catalog result forward for the response so we can see
    // whether the toggle was actually found + turned off.
    void catalogOff;

    // ============================================================
    // STEP 2: AD GROUP page (Optimization + Targeting + Budget)
    // ============================================================
    // We're (hopefully) on the ad-group editor now. Fill the fields
    // the user configured on Launch v2 form, then click Continue
    // again to reach the Ad step.

    // 10. Set the data-connection (Pixel) dropdown by visible label
    //     match. Stored as { found, picked } in adGroupReport.
    const adGroupReport = {};

    async function openLabeledDropdown(page, labelRe) {
      return await page.evaluate((rs) => {
        const re = new RegExp(rs);
        const all = Array.from(document.querySelectorAll("*"));
        let label = null;
        for (const el of all) {
          if (el.children.length > 1) continue;
          const t = (el.innerText || el.textContent || "").trim();
          if (!t || t.length > 80) continue;
          if (re.test(t)) { label = el; break; }
        }
        if (!label) return false;
        function visible(el) {
          const r = el.getBoundingClientRect();
          const cs = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
        }
        let cursor = label;
        for (let i = 0; i < 8 && cursor; i++) {
          const parent = cursor.parentElement;
          if (!parent) break;
          // Look for ANY clickable-looking element near the label that
          // could be the dropdown trigger. TikTok uses Kuaishou design
          // system — ks-select, ks-button, etc. — so we cast a wide net.
          const candidates = Array.from(parent.querySelectorAll(
            '[role="combobox"], [role="button"], button, ' +
            'ks-select, ks-button, ks-input, ks-cascader, ' +
            '[class*="select" i]:not([class*="selected" i]):not([class*="selector" i]), ' +
            '[class*="dropdown" i], [class*="picker" i], [class*="trigger" i]',
          ));
          for (const c of candidates) {
            if (!visible(c) || c.contains(label) || label.contains(c)) continue;
            c.scrollIntoView({ block: "center" });
            c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            c.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            c.click();
            return true;
          }
          cursor = parent;
        }
        return false;
      }, labelRe.source);
    }

    async function pickDropdownOption(page, optionRe) {
      // Wait briefly for options to render.
      await page.waitForTimeout(500);
      return await page.evaluate((rs) => {
        const re = new RegExp(rs);
        // Wide net: TikTok uses Kuaishou ks-option/ks-cascader-item, and
        // also plain li/div. Allow substring match within longer items.
        const options = Array.from(document.querySelectorAll(
          '[role="option"], ks-option, ks-cascader-item, ' +
          '[class*="option" i]:not([class*="options" i]), li, ' +
          '[class*="dropdown-item" i], [class*="select-item" i], ' +
          '[class*="cascader-item" i], [class*="menu-item" i]',
        ));
        for (const o of options) {
          // Skip parent containers — focus on leaf-ish options.
          if (o.children.length > 4) continue;
          const t = (o.innerText || o.textContent || "").trim();
          if (!t || t.length > 200) continue;
          if (!re.test(t)) continue;
          const r = o.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = window.getComputedStyle(o);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          o.scrollIntoView({ block: "center" });
          o.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          o.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          o.click();
          return t;
        }
        return null;
      }, optionRe.source);
    }

    // 10a. Data connection (Pixel) — match by visible pixel NAME ("PRST TR 3").
    //      The numeric pixel_id never appears in the dropdown UI.
    if (pixelName) {
      const opened = await openLabeledDropdown(page, /^\s*Data\s*connection\s*$/i);
      if (opened) {
        // Escape regex specials in the name before turning it into a RegExp.
        const safeName = pixelName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const picked = await pickDropdownOption(page, new RegExp(`^\\s*${safeName}\\s*$`, "i"));
        adGroupReport.pixelPick = picked ? `picked:${picked}` : `no-match:${pixelName}`;
        await page.waitForTimeout(400);
        await page.keyboard.press("Escape").catch(() => {});
      } else {
        adGroupReport.pixelPick = "no-dropdown";
      }
    }
    void pixelId; // numeric id kept for future API-based wiring

    // 10b. Optimization event — TikTok shows event names as the form
    //      labels ("Purchase", "Add to Cart", "Shopping") rather than
    //      the API enum values. Map the API enum to its UI label here.
    if (optimizationEvent) {
      const eventLabelMap = {
        SHOPPING: /^\s*(Shopping|Place an Order|Purchase)\s*$/i,
        PURCHASE: /^\s*(Purchase|Place an Order)\s*$/i,
        ADD_TO_CART: /^\s*(Add to Cart|Cart)\s*$/i,
        ADD_PAYMENT_INFO: /^\s*Add Payment Info\s*$/i,
        SUBSCRIBE: /^\s*Subscribe\s*$/i,
        FORM: /^\s*(Form|Submit Form|Lead)\s*$/i,
        CONTACT: /^\s*Contact\s*$/i,
        ON_WEB_ORDER: /^\s*(Place an Order|Purchase)\s*$/i,
        ON_WEB_DETAIL: /^\s*View Content\s*$/i,
        ON_WEB_REGISTER: /^\s*Complete Registration\s*$/i,
        ON_WEB_SUBSCRIBE: /^\s*Subscribe\s*$/i,
      };
      const labelRe = eventLabelMap[optimizationEvent] || new RegExp(`^\\s*${optimizationEvent}\\s*$`, "i");
      const opened = await openLabeledDropdown(page, /^\s*Optimization\s*event\s*$/i);
      if (opened) {
        const picked = await pickDropdownOption(page, labelRe);
        adGroupReport.eventPick = picked ? `picked:${picked}` : `no-match:${optimizationEvent}`;
        await page.waitForTimeout(400);
        await page.keyboard.press("Escape").catch(() => {});
      } else {
        adGroupReport.eventPick = "no-dropdown";
      }
    }

    // 10c. Bid strategy dropdown — "Target cost per result" / "Maximum delivery".
    //      TikTok wording varies: "Maximum delivery", "Maximum delivery
    //      (lowest cost)", "Highest volume", etc. Match permissively.
    if (bidStrategy) {
      const bidLabelRe = bidStrategy === "BID_TYPE_CUSTOM"
        ? /target\s*cost/i
        : /maximum\s*delivery|lowest\s*cost|highest\s*volume|auto\s*bid/i;
      const opened = await openLabeledDropdown(page, /^\s*Bid\s*strategy\s*$/i);
      if (opened) {
        const picked = await pickDropdownOption(page, bidLabelRe);
        adGroupReport.bidPick = picked ? `picked:${picked}` : `no-match:${bidStrategy}`;
        await page.waitForTimeout(400);
        await page.keyboard.press("Escape").catch(() => {});
      } else {
        adGroupReport.bidPick = "no-dropdown";
      }
    }

    // 10d. Target CPA input — labelled <input> with a USD/Conversion suffix.
    if (typeof targetCPA === "number" && targetCPA > 0) {
      const filled = await page.evaluate((cpa) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'));
        for (const inp of inputs) {
          let cursor = inp;
          let hasLabel = false;
          for (let i = 0; i < 5 && cursor && !hasLabel; i++) {
            const parent = cursor.parentElement;
            if (!parent) break;
            for (const sib of parent.children) {
              if (sib === cursor) continue;
              const t = (sib.innerText || "").trim();
              if (/^Target\s*CPA(\s*\(USD\))?$/i.test(t)) { hasLabel = true; break; }
            }
            cursor = parent;
          }
          if (!hasLabel) continue;
          inp.scrollIntoView({ block: "center" });
          inp.focus();
          inp.select();
          const proto = window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(inp, "");
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          setter.call(inp, String(cpa));
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          inp.dispatchEvent(new Event("blur", { bubbles: true }));
          return true;
        }
        return false;
      }, targetCPA);
      adGroupReport.targetCPAFilled = filled;
    }

    // 10e. Daily budget input — TikTok exposes it labelled "Budget" with
    //      a Daily/Lifetime selector before the amount and a USD suffix.
    if (adgroupBudgetUSD && adgroupBudgetUSD > 0) {
      const filled = await page.evaluate((amount) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'));
        for (const inp of inputs) {
          let cursor = inp;
          let hasLabel = false;
          for (let i = 0; i < 6 && cursor && !hasLabel; i++) {
            const parent = cursor.parentElement;
            if (!parent) break;
            for (const sib of parent.children) {
              if (sib === cursor) continue;
              const t = (sib.innerText || "").trim();
              if (/^Budget$/i.test(t)) { hasLabel = true; break; }
            }
            cursor = parent;
          }
          if (!hasLabel) continue;
          // Skip the small Daily/Lifetime select that lives next to the
          // amount — its value is "Daily" not a number.
          if (/^(Daily|Lifetime)$/i.test(inp.value || "")) continue;
          inp.scrollIntoView({ block: "center" });
          inp.focus();
          inp.select();
          const proto = window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(inp, "");
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          setter.call(inp, String(amount));
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          inp.dispatchEvent(new Event("blur", { bubbles: true }));
          return true;
        }
        return false;
      }, adgroupBudgetUSD);
      adGroupReport.budgetFilled = filled;
    }

    // 11. Scroll down so the rest of the ad-group form (audience,
    //     placements, budget, schedule) is in view for screenshots.
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(600);
    await dismissModals(page);
    await shot(page, "06-adgroup-mid");

    // 12. (Future) Set country / age / gender / budget / bid strategy.
    //     We surface what we did via adGroupReport and let the next
    //     iteration wire each form-fill.

    // 13. Click Continue at the bottom to advance to the Ad step.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await dismissModals(page);
    const adgroupContinueClicked = await page.evaluate(() => {
      function visible(el) {
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && cs.pointerEvents !== "none";
      }
      function isDisabled(el) {
        if (el.disabled) return true;
        if (el.getAttribute("aria-disabled") === "true") return true;
        const cls = (typeof el.className === "string") ? el.className : "";
        return /disabled/i.test(cls);
      }
      function clickIt(el) {
        el.scrollIntoView({ block: "center" });
        try { el.focus(); } catch {}
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.click();
      }
      const all = Array.from(document.querySelectorAll("*"));
      for (const el of all) {
        if (el.children.length > 0) continue;
        const text = (el.innerText || el.textContent || "").trim();
        if (!/^continue$/i.test(text)) continue;
        let cursor = el;
        for (let i = 0; i < 8 && cursor; i++) {
          if (cursor.matches?.('button, [role="button"], a, [class*="btn" i], [class*="button" i]')) {
            if (visible(cursor) && !isDisabled(cursor)) {
              clickIt(cursor);
              return "walk-up:" + cursor.tagName.toLowerCase();
            }
          }
          cursor = cursor.parentElement;
        }
      }
      return null;
    });
    await page.waitForTimeout(4000);
    await dismissModals(page);
    await shot(page, "07-after-adgroup-continue");
    adGroupReport.continueClicked = adgroupContinueClicked;
    void pixelId; void optimizationEvent; void countryIds; void ageGroupIds;
    void gender; void targetCPA; void bidStrategy;

    // 8. (Next pass: fill ad-group targeting + budget + pixel +
    //    optimization event, then Continue again into the ad step.
    //    For now we stop here so the next debug round can see what
    //    the ad-group page looks like.)

    const bodyExcerpt = await page.evaluate(() => (document.body.innerText || "").slice(0, 1500));
    const finalUrl = page.url();

    await browser.close();
    return res.json({
      ok: true,
      url: finalUrl,
      objectiveClicked: objClicked,
      destinationClicked: destClicked,
      nameFilled,
      catalogOff,
      continueClicked,
      adGroupReport,
      adgroupBudgetUSD,
      bodyExcerpt,
      screenshots: shots,
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Internal error",
      screenshots: shots,
    });
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
