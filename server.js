/**
 * adsalim-vm-service   (build: auto-deploy test — Location picker + age chips)
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

    // Step A: dismiss any onboarding/announcement modals so they don't
    // block subsequent clicks. TikTok mounts these async (e.g. the
    // "Find your tools in a new place" announcement appears ~1-2s after
    // the editor renders), so a single pass at t=0 misses them. Loop
    // for ~4s, dismissing every pass — multiple modals can stack.
    const dismissBlockingModals = async () => {
      return page.evaluate(() => {
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        let dismissed = 0;
        // Pass 1: any visible "Got it" / "Skip" / "Maybe later" / "Close" / "Dismiss" button.
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
        for (const b of buttons) {
          if (b.disabled || !isVisible(b)) continue;
          const t = (b.innerText || b.textContent || "").trim().toLowerCase();
          if (/^(got it|skip|maybe later|close|dismiss|i understand|next|done|continue tour|skip tour)$/.test(t)) {
            b.click();
            dismissed++;
          }
        }
        // Pass 2: modal close ✕ buttons (TikTok renders them as svg-only
        // icons with aria-label="close" or class containing "close").
        const closes = Array.from(document.querySelectorAll(
          '[role="dialog"] [aria-label*="close" i], [role="dialog"] [class*="close" i], [class*="modal" i] [aria-label*="close" i], [class*="modal" i] [class*="close" i], [class*="dialog" i] [aria-label*="close" i]'
        ));
        for (const x of closes) {
          if (!isVisible(x)) continue;
          x.click();
          dismissed++;
        }
        return dismissed;
      }).catch(() => 0);
    };
    // First pass right now, then re-poll every 400ms for ~4s to catch
    // async-mounted announcements like "Find your tools in a new place".
    for (let i = 0; i < 10; i++) {
      const n = await dismissBlockingModals();
      if (i > 0 && n === 0) break;
      await page.waitForTimeout(400);
    }

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

    // Step C.5: one more modal sweep — scrolling can lazy-mount the
    // announcement carousel ("Find your tools in a new place") which
    // overlays the Publish button at the bottom-right.
    await dismissBlockingModals();
    await page.waitForTimeout(200);
    await dismissBlockingModals();

    // Step D: click "Publish all". TikTok renders this as a styled <div>
    // (with a dropdown arrow), not a <button> — so we widen the
    // selector to any clickable element. Match strictly on visible text
    // so we don't accidentally click the dropdown arrow's own item.
    const findAndClickPublish = () => page.evaluate(() => {
      const all = Array.from(document.querySelectorAll(
        'button, [role="button"], a, [class*="btn" i], [class*="button" i], div[class*="publish" i]'
      ));
      const patterns = [/^publish all$/, /^publish$/];
      for (const pat of patterns) {
        const match = all.find(el => {
          if (el.disabled) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const text = (el.innerText || el.textContent || "").trim().toLowerCase();
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

    // Try up to 4 times: between attempts, sweep modals + scroll. TikTok's
    // announcement carousel can re-mount after dismissal, and the publish
    // button can be obscured by a tooltip the first time we look.
    let publishClicked = await findAndClickPublish();
    for (let i = 0; i < 3 && !publishClicked; i++) {
      await dismissBlockingModals();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(600);
      publishClicked = await findAndClickPublish();
    }

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

    // Poll for an explicit success/error signal for up to 20s. Previous
    // version was fail-OPEN (returned ok:true unless an explicit error
    // was visible) which silently masked publishes that quietly stalled
    // — the campaigns then showed up as drafts in TikTok while adsalim
    // reported "published". Now fail-CLOSED: no success signal within
    // the window = ok:false. PRIMARY success signal is URL change to
    // /manage/campaign — TikTok always navigates there on real success.
    // Toast text was missing successes (G1 actually published as Active
    // but our narrow regex didn't catch the toast text TikTok used).
    let postState = { hasSuccess: false, hasError: false, bodyText: "", url: page.url() };
    const POLL_MS = 500;
    const POLL_MAX = 40; // 40 * 500ms = 20s
    for (let attempt = 0; attempt < POLL_MAX; attempt++) {
      await page.waitForTimeout(POLL_MS);
      postState = await page.evaluate(() => {
        const url = location.href;
        const bodyText = (document.body.innerText || "").slice(0, 5000);
        // Primary: URL navigated away from the editor to the campaign
        // manager → unambiguous success. TikTok always does this.
        const navigatedToManager = /\/i18n\/manage\/campaign/i.test(url);
        // Secondary: any of the known success toast strings.
        const toastSuccess = /publish.*success|publish.*succeed|published successfully|create success|submitted|submitted for review|pending review|saved successfully|成功|创建成功/i.test(bodyText);
        const hasSuccess = navigatedToManager || toastSuccess;
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
    // Loop a few times so multi-step tours ("1/3 → 2/3 → 3/3") get
    // fully dismissed if Skip isn't accepted and we end up advancing.
    for (let i = 0; i < 4; i++) {
      const dismissedAny = await page.evaluate(() => {
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const cs = window.getComputedStyle(el);
          return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
        };
        let n = 0;
        // 0) NEUTRALIZE TOUR SPOTLIGHT OVERLAYS. TikTok's product tour
        // ("Easily manage multiple ad groups and ads" / 1-of-3) renders
        // a full-page dark spotlight overlay with pointer-events:auto
        // that catches EVERY click on the form. Even after Skip is
        // clicked, some overlays linger — set their pointer-events to
        // none so form clicks reach the intended element.
        const overlaySel = [
          '[class*="tour" i]:not([class*="tooltip" i])',
          '[class*="onboarding" i]',
          '[class*="spotlight" i]',
          '[class*="mask" i]:not([class*="pattern" i])',
          '[class*="highlight-overlay" i]',
          '[class*="tutorial" i]',
          '[class*="walkthrough" i]',
          '[class*="coach-mark" i]',
          '[data-testid*="tour" i]',
          '[data-testid*="onboard" i]',
        ].join(", ");
        const overlays = Array.from(document.querySelectorAll(overlaySel));
        for (const o of overlays) {
          try {
            o.style.pointerEvents = "none";
            o.style.opacity = "0";
            o.style.display = "none";
            n++;
          } catch {}
        }
        // 1) Close icons inside dialogs.
        const closes = Array.from(document.querySelectorAll(
          '[role="dialog"] [aria-label*="close" i], [role="dialog"] [class*="close" i], [class*="modal" i] [aria-label*="close" i], [class*="popover" i] [aria-label*="close" i]',
        ));
        for (const c of closes) {
          if (!isVisible(c)) continue;
          try { c.click(); n++; } catch {}
        }
        // 2) Any clickable text matching tour/onboarding dismiss verbs.
        const dismissRe = /^(got\s*it|skip|skip\s*tour|skip\s*all|maybe\s*later|dismiss|close|i\s*understand|done|don'?t\s*show\s*again|no\s*thanks|no,?\s*thanks)$/i;
        const clickables = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="ks-link" i], [class*="link" i], span[class*="tour" i]'));
        for (const b of clickables) {
          if (!isVisible(b)) continue;
          const t = (b.innerText || b.textContent || "").trim();
          if (!t || t.length > 30) continue;
          if (dismissRe.test(t)) { try { b.click(); n++; } catch {} }
        }
        return n;
      }).catch(() => 0);
      await page.keyboard.press("Escape").catch(() => {});
      if (dismissedAny === 0) break;
      await page.waitForTimeout(200);
    }
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

  // Same story as pickFromDropdown for toggles: TikTok uses custom
  // elements like <ks-switch-*> that may have display:contents on the
  // outer wrapper, so plain-CSS + in-page .click() misses them. This
  // helper mirrors the doc-order + effectiveRect + trusted-mouse-click
  // pipeline. Use for Goal-based budget increase and any other toggle
  // on the aio_adgroup page.
  async function toggleOffByDocOrder(page, labelText) {
    await dismissModals(page);
    await page.waitForTimeout(200);
    const info = await page.evaluate((needle) => {
      const labelRe = new RegExp(`^${needle.replace(/\s+/g, "\\s*")}(?:\\s*[\\?ⓘ\\(\\)i ])?$`, "i");
      const visible = (el) => {
        const cs = window.getComputedStyle(el);
        return cs.display !== "none" && cs.visibility !== "hidden";
      };
      const effectiveRect = (el) => {
        const own = el.getBoundingClientRect();
        if (own.width > 0 && own.height > 0) return own;
        const stack = Array.from(el.children || []);
        let bestRect = null, bestArea = 0;
        while (stack.length) {
          const c = stack.pop();
          if (c.children) for (const gc of c.children) stack.push(gc);
          const r = c.getBoundingClientRect();
          if (r.width < 5 || r.height < 5) continue;
          const cs = window.getComputedStyle(c);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          if (cs.display === "contents") continue;
          const area = r.width * r.height;
          if (area > bestArea) { bestArea = area; bestRect = r; }
        }
        return bestRect;
      };
      const all = Array.from(document.querySelectorAll("*"));
      const labels = [];
      for (const el of all) {
        if (el.children.length > 4) continue;
        const t = (el.innerText || el.textContent || "").trim();
        if (!t || !labelRe.test(t)) continue;
        if (!visible(el) || !effectiveRect(el)) continue;
        labels.push(el);
      }
      if (!labels.length) return { ok: false, reason: "label-not-found" };

      // Toggles come as ks-switch-*, [role="switch"], or a wrapping
      // input[type="checkbox"].
      const TOGGLE_PREFIXES = [/^ks-switch(-|$)/, /^ks-toggle(-|$)/];
      const toggles = all.filter((el) => {
        const tag = el.tagName ? el.tagName.toLowerCase() : "";
        if (TOGGLE_PREFIXES.some((re) => re.test(tag))) return true;
        if (el.matches?.('[role="switch"], input[type="checkbox"]')) return true;
        if (el.className && typeof el.className === "string" && /(?:^|\s)ks-switch(?:$|\s|_)/.test(el.className)) return true;
        return false;
      }).filter((el) => visible(el) && effectiveRect(el));

      let best = null;
      for (const label of labels) {
        const lr = label.getBoundingClientRect();
        for (const t of toggles) {
          if (t.contains(label) || label.contains(t)) continue;
          const pos = label.compareDocumentPosition(t);
          if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          const r = effectiveRect(t);
          if (!r) continue;
          // Toggles for horizontal-labeled rows sit to the RIGHT of the
          // label, not below. Accept either.
          const dy = Math.abs(r.top + r.height / 2 - (lr.top + lr.height / 2));
          const dx = r.left - lr.right;
          const isRight = dx > -10 && dx < 800 && dy < 40;
          const dyBelow = r.top - lr.bottom;
          const isBelow = dyBelow > -10 && dyBelow < 200;
          if (!isRight && !isBelow) continue;
          const dist = isRight ? Math.max(0, dx) + dy : dyBelow;
          if (!best || dist < best.dist) best = { label, toggle: t, dist, r };
          break;
        }
      }
      if (!best) return { ok: false, reason: "no-toggle-found", labels: labels.length, toggles: toggles.length };

      // Is it on?
      const t = best.toggle;
      const aria = t.getAttribute && t.getAttribute("aria-checked");
      let checked = null;
      if (aria === "true") checked = true;
      else if (aria === "false") checked = false;
      else {
        const cls = (t.className && typeof t.className === "string") ? t.className : "";
        if (/(?:^|[\s_-])(checked|active|on|open|true)(?:[\s_-]|$)/i.test(cls)) checked = true;
        // TikTok's ks-switch has a colored inner track when on — look
        // for a descendant with a "checked" / "on" / "active" class.
        if (checked === null) {
          const descChecked = Array.from(t.querySelectorAll("*")).some((el) => {
            const c = (el.className && typeof el.className === "string") ? el.className : "";
            return /(?:^|[\s_-])(checked|active|on|open|true)(?:[\s_-]|$)/i.test(c);
          });
          if (descChecked) checked = true;
        }
      }

      // Scroll into view FIRST, then measure — the pre-scroll rect is
      // stale after scrollIntoView and the trusted click landed on a
      // random element (Goal-based looked "clicked" but stayed ON).
      t.scrollIntoView({ block: "center" });
      const rNow = effectiveRect(t) || t.getBoundingClientRect();
      return {
        ok: true,
        checked,
        cx: rNow.left + rNow.width / 2,
        cy: rNow.top + rNow.height / 2,
        tag: t.tagName.toLowerCase(),
      };
    }, labelText);

    if (!info || !info.ok) return `error:${(info && info.reason) || "eval-null"}`;
    if (info.checked === false) return `already-off|tag=${info.tag}`;

    // Click, verify, re-click if still on. TikTok's ks-switch sometimes
    // re-enables Goal-based budget after our first click; also a click
    // on an off toggle would turn it ON, so we always verify state and
    // re-click only if we see it in the ON state.
    const isNowOn = async () => await page.evaluate((tagHash) => {
      // Re-find the same toggle by hash-suffixed tagName.
      const el = Array.from(document.querySelectorAll("*")).find((e) => e.tagName && e.tagName.toLowerCase() === tagHash);
      if (!el) return null;
      const inner = el.querySelector('[role="switch"], input[type="checkbox"]');
      if (inner) {
        if (inner.getAttribute("aria-checked") === "true") return true;
        if (inner.getAttribute("aria-checked") === "false") return false;
        if (typeof inner.checked === "boolean") return inner.checked;
      }
      const cls = (el.className && typeof el.className === "string") ? el.className : "";
      if (/(?:^|[\s_-])(checked|active|on|open|true)(?:[\s_-]|$)/i.test(cls)) return true;
      const descOn = Array.from(el.querySelectorAll("*")).some((c) => {
        const cc = (c.className && typeof c.className === "string") ? c.className : "";
        return /(?:^|[\s_-])(checked|active|on|open|true)(?:[\s_-]|$)/i.test(cc);
      });
      return descOn;
    }, info.tag);

    let attempts = 0;
    let final = null;
    while (attempts < 3) {
      try {
        await page.mouse.move(info.cx, info.cy);
        await page.waitForTimeout(80);
        await page.mouse.click(info.cx, info.cy, { delay: 60 });
      } catch {}
      await page.waitForTimeout(500);
      final = await isNowOn();
      if (final === false) break;
      attempts++;
    }
    return `attempts=${attempts + 1}|tag=${info.tag}|wasChecked=${info.checked === null ? "unknown" : info.checked}|nowOn=${final}`;
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

    // The campaign-creation SPA sometimes renders a BLANK white body
    // (hydration didnt fire). Detect that and reload up to 2 times —
    // this is a transient TikTok load flake, not a logic error.
    for (let attempt = 0; attempt < 2; attempt++) {
      const hasContent = await page.evaluate(() => {
        const t = (document.body.innerText || "").trim();
        // A rendered editor shows objective/campaign text; blank body is
        // just the top nav (a few words).
        return t.length > 120 || /objective|campaign|sales|website|advertising/i.test(t);
      }).catch(() => false);
      if (hasContent) break;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await page.waitForSelector('button, [role="button"]', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }

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

    // 5.5. NEW unified-campaign flow (intermittent A/B): TikTok sometimes
    // opens a "Create new campaign" MODAL ("Manual and Smart+ campaigns
    // have been unified into one workflow") with objective + destination
    // pickers and a "Confirm" button that must be clicked to enter the
    // editor. Other times it drops straight into the editor. Poll up to
    // ~7s for a visible "Confirm" button and trusted-click it; if the
    // modal never appears, we're already in the editor and skip.
    let confirmClicked = "not-present";
    for (let attempt = 0; attempt < 10; attempt++) {
      const confirmInfo = await page.evaluate(() => {
        const isVisible = (el) => {
          const cs = window.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        // Confirm lives in the modal footer next to Cancel. Match a
        // clickable whose exact text is Confirm and that sits near a
        // Cancel sibling (to avoid other "confirm" buttons).
        const clickables = Array.from(document.querySelectorAll('button, [role="button"], [class*="btn" i], a'));
        let confirmEl = null;
        for (const b of clickables) {
          const t = (b.innerText || b.textContent || "").trim();
          if (!/^confirm$/i.test(t)) continue;
          if (!isVisible(b)) continue;
          if (b.disabled || b.getAttribute("aria-disabled") === "true") continue;
          confirmEl = b; break;
        }
        if (!confirmEl) return null;
        const r = confirmEl.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      });
      if (confirmInfo) {
        try {
          await page.mouse.move(confirmInfo.cx, confirmInfo.cy);
          await page.waitForTimeout(80);
          await page.mouse.click(confirmInfo.cx, confirmInfo.cy, { delay: 60 });
        } catch {}
        confirmClicked = `clicked@attempt${attempt}`;
        await page.waitForTimeout(2500);
        await dismissModals(page);
        await shot(page, "03b-after-confirm");
        break;
      }
      // No Confirm yet — if the ad-group form is already present, we're
      // in the editor (no modal on this run); stop polling.
      const inEditor = await page.evaluate(() =>
        /ad group|optimization|data connection|bid strategy/i.test(document.body.innerText || "")
      ).catch(() => false);
      if (inEditor) { confirmClicked = "editor-direct"; break; }
      await page.waitForTimeout(700);
    }

    // 5.6. WAIT FOR THE EDITOR + PAYMENT-REDIRECT RECOVERY. On modal
    // runs, Confirm sometimes redirects to account/payment/v1 instead of
    // the editor (TikTok billing interstitial) — every prior such run
    // then cascaded into label-not-found on all fields. And even on good
    // runs the editor shows a spinner for several seconds; scanning too
    // early also fails. So: poll up to 20s for real editor content; if
    // we detect the payment URL (or time out), re-goto the creation URL
    // and re-run the objective/destination/Confirm dance — up to 2
    // recovery rounds.
    // "Editor ready" = the CAMPAIGN step is truly interactive: modal
    // gone (no visible Confirm), campaign text present, AND a visible
    // text input exists (the Campaign-name field) — text alone matches
    // through the modal backdrop, which fooled the previous check.
    const editorReady = async () => await page.evaluate(() => {
      const visible = (el) => {
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const modalConfirm = Array.from(document.querySelectorAll('button, [role="button"]')).some((b) => {
        const t = (b.innerText || b.textContent || "").trim();
        return /^confirm$/i.test(t) && visible(b);
      });
      if (modalConfirm) return false; // modal still open
      // Accept either the campaign step OR the new unified editor's
      // combined layout. The NEW campaign step has NO text input at all
      // (just objective radios + budget strategy + split test), so the
      // old visible-input requirement rejected a perfectly good page.
      // "Interactive editor" now = editor headings present AND the
      // Exit/Continue footer is rendered.
      const body = document.body.innerText || "";
      if (!/advertising objective|campaign details|campaign name|ad group name|optimization and bidding/i.test(body)) return false;
      return /\bexit\b/i.test(body) && /\bcontinue\b/i.test(body);
    }).catch(() => false);

    // STRATEGY (updated): TikTok has permanently rolled out the unified
    // flow on this account — 5 rerolls all served the modal, the old
    // direct variant is gone. So we CONFIRM the modal and wait for the
    // new editor. (The account/payment drift in earlier runs was NOT
    // caused by Confirm — the audience-pencil finder was clicking a
    // 40x40 LEFT-NAV icon (ks-nav-item inside <a>), i.e. the Payment nav
    // entry. Nav clicks are now excluded elsewhere.)
    const clickConfirmIfPresent = async () => {
      const pos = await page.evaluate(() => {
        const visible = (el) => {
          const cs = window.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const btns = Array.from(document.querySelectorAll('button, [role="button"], [class*="btn" i]'));
        for (const b of btns) {
          const t = (b.innerText || b.textContent || "").trim();
          if (!/^confirm$/i.test(t)) continue;
          if (!visible(b) || b.disabled) continue;
          // Disabled-by-class ks-buttons carry a "disabled" class instead
          // of the attribute — skip those too.
          const cls = (typeof b.className === "string") ? b.className : "";
          if (/disabled/i.test(cls)) continue;
          const r = b.getBoundingClientRect();
          b.setAttribute("data-vm-confirm", "1");
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        }
        return null;
      });
      if (!pos) return false;
      // Trusted click first (isTrusted handlers)...
      try {
        await page.mouse.move(pos.cx, pos.cy);
        await page.waitForTimeout(80);
        await page.mouse.click(pos.cx, pos.cy, { delay: 60 });
      } catch {}
      // ...then an in-page click as backup — the floating "Ad Assistant"
      // widget sits right over the modal footer, so the coordinate click
      // can hit the overlay instead of Confirm. Element.click() ignores
      // overlay hit-testing entirely.
      await page.evaluate(() => {
        const b = document.querySelector('[data-vm-confirm="1"]');
        if (!b) return;
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
          try {
            const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
            b.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
          } catch {}
        }
        try { b.click(); } catch {}
        b.removeAttribute("data-vm-confirm");
      }).catch(() => {});
      return true;
    };

    // Fully resolve the unified objective modal: pick Sales + Website,
    // force the Search-campaign toggle OFF (our own stray clicks flipped
    // it ON in one run, which added validation errors), click Confirm,
    // and VERIFY the modal actually closed. Safe to call repeatedly —
    // returns immediately when no modal is open. TikTok re-opens this
    // modal at later steps when campaign details are incomplete, so
    // every major step calls this first.
    const ensureObjectiveConfirmed = async () => {
      for (let t = 0; t < 4; t++) {
        const modalOpen = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('button, [role="button"]')).some((b) => {
            const txt = (b.innerText || b.textContent || "").trim();
            if (!/^confirm$/i.test(txt)) return false;
            const cs = window.getComputedStyle(b);
            const r = b.getBoundingClientRect();
            return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0;
          });
        }).catch(() => false);
        if (!modalOpen) return t === 0 ? "no-modal" : `confirmed@try${t}`;
        // Re-assert objective + destination inside the modal.
        await clickByText(page, new RegExp(`^\\s*${objectiveLabel}\\s*$`, "i"), "modal-objective");
        await page.waitForTimeout(400);
        await clickByText(page, new RegExp(`^\\s*${destLabel}\\s*$`, "i"), "modal-destination");
        await page.waitForTimeout(400);
        // Force the "Search campaign" toggle OFF if some stray click
        // turned it on (it renders as ks-switch-* inside the modal).
        await page.evaluate(() => {
          const labels = Array.from(document.querySelectorAll("*")).filter((el) => {
            if (el.children.length > 2) return false;
            const t2 = (el.innerText || el.textContent || "").trim();
            return /^search campaign$/i.test(t2);
          });
          for (const lab of labels) {
            const lr = lab.getBoundingClientRect();
            if (lr.width === 0) continue;
            const switches = Array.from(document.querySelectorAll("*")).filter((el) => /^ks-switch/.test((el.tagName || "").toLowerCase()));
            for (const sw of switches) {
              const r = sw.getBoundingClientRect();
              if (r.width === 0) continue;
              if (Math.abs((r.top + r.height / 2) - (lr.top + lr.height / 2)) > 30) continue;
              const on = sw.getAttribute("aria-checked") === "true" ||
                /checked|active|on/.test((typeof sw.className === "string" ? sw.className : "")) ||
                Array.from(sw.querySelectorAll("*")).some((c) => /checked|active/.test(typeof c.className === "string" ? c.className : ""));
              if (on) { try { sw.click(); } catch {} }
            }
          }
        }).catch(() => {});
        await page.waitForTimeout(300);
        await clickConfirmIfPresent();
        await page.waitForTimeout(2500);
      }
      return "modal-stuck";
    };

    let editorState = "unknown";
    recovery: for (let round = 0; round < 3; round++) {
      // Within a round: resolve the modal whenever it shows, then poll
      // for a truly-interactive editor.
      for (let i = 0; i < 8; i++) {
        await ensureObjectiveConfirmed();
        if (await editorReady()) { editorState = round === 0 ? "ready" : `recovered@round${round}`; break recovery; }
        const url = page.url();
        if (/account\/payment/i.test(url)) break; // genuine payment bounce — re-enter
        await page.waitForTimeout(1000);
      }
      editorState = `recovering@round${round + 1}`;
      // Re-enter the creation flow from scratch.
      await page.goto(
        `https://ads.tiktok.com/i18n/creation/1nn/create/campaign?aadvid=${encodeURIComponent(advertiserId)}&creation_type=create_new`,
        { waitUntil: "domcontentloaded", timeout: 45_000 },
      ).catch(() => {});
      await page.waitForSelector('button, [role="button"]', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await dismissModals(page);
    }
    confirmClicked = `${confirmClicked}|editor=${editorState}`;
    await shot(page, "03c-editor-state");

    if (editorState.startsWith("recovering")) {
      // Still no interactive editor after all rerolls — fail loud with
      // the URL + a body excerpt so we can see exactly what blocked it.
      const finalUrlNow = page.url();
      const bodyNow = await page.evaluate(() =>
        (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 350)
      ).catch(() => "");
      const shotBuf = await page.screenshot({ fullPage: false }).catch(() => null);
      const shotId = shotBuf ? saveScreenshot(shotBuf) : null;
      await browser.close();
      return res.status(500).json({
        error: `Editor never became interactive after 3 rounds. Last URL: ${finalUrlNow}` +
          (/account\/payment/i.test(finalUrlNow)
            ? " — TikTok keeps redirecting to the PAYMENT page."
            : "") +
          ` | body="${bodyNow}"`,
        confirmClicked,
        screenshots: shots.concat(shotId ? [{ label: "final-state", url: `${base}/screenshots/${shotId}` }] : []),
      });
    }

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
          // Allow up to 3 children — TikTok often wraps labels with an
          // info icon and a tooltip ("Data connection ⓘ").
          if (el.children.length > 3) continue;
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
      // Wait briefly for options to render — TikTok ks-cascader needs ~800ms.
      await page.waitForTimeout(900);
      return await page.evaluate((rs) => {
        const re = new RegExp(rs);
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const cs = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
        };
        const clickIt = (el) => {
          el.scrollIntoView({ block: "center" });
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          el.click();
        };

        // Find HIGH Z-INDEX overlays — these are the open popups. Filter
        // out the top nav (full-width sticky bar with "Ads Manager" /
        // advertiser-name) which is also position:fixed with high z but
        // contains no dropdown options.
        const all = Array.from(document.querySelectorAll("*"));
        const popups = all.filter((el) => {
          const cs = window.getComputedStyle(el);
          if (cs.position !== "fixed" && cs.position !== "absolute") return false;
          if (!visible(el)) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 100 || r.height < 40) return false;
          const z = parseInt(cs.zIndex);
          if (isNaN(z) || z < 100) return false;
          // Skip full-width sticky bars (top nav / left sidebar).
          if (r.width >= window.innerWidth - 50 && r.height < 80) return false;
          if (r.height >= window.innerHeight - 50 && r.width < 100) return false;
          // Skip elements that are themselves containers wrapping the
          // whole viewport (modals' backdrops).
          if (r.width >= window.innerWidth - 50 && r.height >= window.innerHeight - 50) return false;
          return true;
        });
        popups.sort((a, b) => {
          const za = parseInt(window.getComputedStyle(a).zIndex) || 0;
          const zb = parseInt(window.getComputedStyle(b).zIndex) || 0;
          return zb - za;
        });

        const seen = [];
        const scopes = popups.length ? popups.slice(0, 3) : [document.body];

        for (const scope of scopes) {
          // Pass 1: structured option-like elements with matching text.
          const optionLikes = Array.from(scope.querySelectorAll(
            '[role="option"], ks-option, ks-cascader-item, ' +
            '[class*="option" i]:not([class*="options" i]), li, ' +
            '[class*="dropdown-item" i], [class*="select-item" i], ' +
            '[class*="cascader-item" i], [class*="menu-item" i], ' +
            '[class*="lego-list-item" i], [class*="row" i][class*="item" i]',
          ));
          for (const o of optionLikes) {
            if (o.children.length > 6) continue;
            const t = (o.innerText || o.textContent || "").trim();
            if (!t || t.length > 200) continue;
            if (!visible(o)) continue;
            if (seen.length < 30) seen.push(t.slice(0, 60));
            if (!re.test(t)) continue;
            clickIt(o);
            return "pass1:" + t.slice(0, 60);
          }

          // Pass 2: walk leaf text inside the popup. If text matches,
          // click the leaf or its nearest clickable parent.
          const leaves = Array.from(scope.querySelectorAll("*"));
          for (const el of leaves) {
            if (el.children.length > 0) continue;
            const t = (el.innerText || el.textContent || "").trim();
            if (!t || t.length > 200) continue;
            if (!visible(el)) continue;
            if (seen.length < 30) seen.push(t.slice(0, 60));
            if (!re.test(t)) continue;
            let cursor = el;
            for (let i = 0; i < 8 && cursor; i++) {
              const cs = window.getComputedStyle(cursor);
              if (cs.cursor === "pointer" ||
                  cursor.matches?.('button, [role="option"], [role="button"], li, a')) {
                if (visible(cursor)) {
                  clickIt(cursor);
                  return "pass2:" + t.slice(0, 60);
                }
              }
              cursor = cursor.parentElement;
            }
            // Fallback: click the leaf itself.
            clickIt(el);
            return "pass3:" + t.slice(0, 60);
          }
        }

        return "no-match | popups=" + popups.length + " | seen=[" + seen.slice(0, 10).join(" | ") + "]";
      }, optionRe.source);
    }

    // Scoped helpers — find the LABEL element with EXACT text match, then
    // click the nearest dropdown trigger within its form-row ancestor.
    // Playwright's getByLabel was matching audience-targeting labels
    // ("All", "Search or select interests & behaviors") because TikTok's
    // labels don't have proper accessibility wiring.
    async function pickFromDropdown(labelText, optionText) {
      // Strategy: find the label by exact text, then click the FIRST
      // dropdown-trigger element that appears AFTER the label in document
      // order. TikTok's aio_adgroup form always lays out as label →
      // description → trigger in document order, so "first trigger
      // following the label" is unambiguous regardless of how deeply
      // nested or how wide the trigger row is.
      try {
        // Tour modals ("1/3 Skip Next") and announcement overlays silently
        // intercept clicks. Sweep before every trigger lookup — they
        // re-mount async during the form flow.
        await dismissModals(page);
        await page.waitForTimeout(200);
        const triggered = await page.evaluate((needle) => {
          // TikTok ads_aio_adgroup uses custom elements with hash-suffixed
          // tag names that change every deploy:
          //   <ks-input-selector-8ezba0f7>  -> Data connection-style picker
          //   <ks-dropdown-menu-u27mrjdv>   -> Optimization event / Bid strategy
          //   <ks-input-number-fkwyrc8l>    -> numeric inputs (Target CPA)
          // CSS can't match a tag-name prefix, so we filter by tagName in JS.
          const TAG_PREFIXES = [
            /^ks-input-selector(-|$)/,
            /^ks-dropdown-menu(-|$)/,
            /^ks-select(-|$)/,
            /^ks-cascader(-|$)/,
          ];
          const STATIC_SEL = [
            '[role="combobox"]',
            'button[aria-haspopup="listbox"]',
            'button[aria-haspopup="true"]',
            'div[role="textbox"]',
            'input[readonly]',
          ].join(", ");

          // 1. Find ALL elements whose visible text exactly matches the
          //    label (allowing optional trailing icon char). Pick the one
          //    that has a trigger nearby AFTER it in document order.
          const labelRe = new RegExp(`^${needle.replace(/\s+/g, "\\s*")}(?:\\s*[\\?ⓘ\\(\\)i ])?$`, "i");
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            const cs = window.getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") return false;
            return true;
          };
          const allEls = Array.from(document.querySelectorAll("*"));
          const labelCandidates = [];
          for (const el of allEls) {
            if (el.children.length > 4) continue;
            const t = (el.innerText || el.textContent || "").trim();
            if (!t || !labelRe.test(t)) continue;
            if (!visible(el)) continue;
            labelCandidates.push(el);
          }
          if (!labelCandidates.length) {
            return { ok: false, reason: "label-not-found" };
          }

          // Custom elements like <ks-dropdown-menu-*> may have
          // style="display: contents" on themselves — no bounding box.
          // Compute an effective rect by walking descendants and taking
          // the largest visible box. Falls back to null if truly nothing.
          const effectiveRect = (el) => {
            const own = el.getBoundingClientRect();
            if (own.width > 0 && own.height > 0) return own;
            const stack = Array.from(el.children || []);
            let best = null;
            let bestArea = 0;
            while (stack.length) {
              const c = stack.pop();
              if (c.children) for (const gc of c.children) stack.push(gc);
              const cr = c.getBoundingClientRect();
              if (cr.width < 5 || cr.height < 5) continue;
              const cs = window.getComputedStyle(c);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              if (cs.display === "contents") continue;
              const area = cr.width * cr.height;
              if (area > bestArea) { best = cr; bestArea = area; }
            }
            return best;
          };
          const isTriggerVisible = (el) => {
            const cs = window.getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") return false;
            // Accept display:contents — the effective rect handler below
            // will resolve to a real descendant box.
            return effectiveRect(el) !== null;
          };

          const tagPrefixMatches = allEls.filter((el) => {
            const tag = el.tagName ? el.tagName.toLowerCase() : "";
            return TAG_PREFIXES.some((re) => re.test(tag));
          });
          const staticMatches = Array.from(document.querySelectorAll(STATIC_SEL));
          const allTriggers = Array.from(new Set([...tagPrefixMatches, ...staticMatches])).filter(isTriggerVisible);

          // 2. For each label candidate, find the FIRST trigger that:
          //    - appears after the label in document order
          //    - is visually below the label (top >= label.bottom - 10)
          //    - has its top within 600px of label.bottom
          //    Pick the (label, trigger) pair where the vertical gap is
          //    smallest — that's the one TikTok actually rendered as a
          //    pair.
          // NOTE: allTriggers is NOT in document order (tag-prefix matches
          // then static-CSS matches, deduped) — so "break on first array
          // hit" used to pick an arbitrary trigger or none at all (that's
          // why Bid strategy came back trig=none while its dropdown sat
          // right there). Instead: consider EVERY following trigger and
          // keep the one with the smallest vertical gap to the label.
          let bestPair = null;
          for (const label of labelCandidates) {
            const labelRect = label.getBoundingClientRect();
            for (const t of allTriggers) {
              if (t.contains(label) || label.contains(t)) continue;
              const pos = label.compareDocumentPosition(t);
              if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
              const r = effectiveRect(t);
              if (!r) continue;
              if (r.top < labelRect.bottom - 10) continue;
              const gap = r.top - labelRect.bottom;
              if (gap > 600) continue;
              // Horizontal sanity: the paired trigger starts near the
              // label's column (within 250px) — rejects sidebar widgets.
              if (Math.abs(r.left - labelRect.left) > 250) continue;
              if (!bestPair || gap < bestPair.gap) {
                bestPair = { label, trigger: t, gap, labelRect, triggerRect: r };
              }
            }
          }
          if (!bestPair) {
            // Diagnostic: for the FIRST label candidate, walk forward in
            // document order and dump tag+class of the next ~30 elements.
            // This tells us what TikTok actually puts after the label,
            // so we know which class/role to add to TRIGGER_SEL.
            const firstLabel = labelCandidates[0];
            const forwardDump = [];
            if (firstLabel) {
              const labelRect = firstLabel.getBoundingClientRect();
              const allDoc = Array.from(document.querySelectorAll("*"));
              const labelIndex = allDoc.indexOf(firstLabel);
              let dumped = 0;
              for (let i = labelIndex + 1; i < allDoc.length && dumped < 30; i++) {
                const el = allDoc[i];
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                if (r.top < labelRect.bottom - 10) continue;
                if (r.top - labelRect.bottom > 400) break;
                const cs = window.getComputedStyle(el);
                if (cs.display === "none" || cs.visibility === "hidden") continue;
                const cls = (el.className && typeof el.className === "string") ? el.className.toString().slice(0, 50) : "";
                const role = el.getAttribute && el.getAttribute("role") || "";
                const ariaHasPopup = el.getAttribute && el.getAttribute("aria-haspopup") || "";
                const cursor = cs.cursor;
                const tag = el.tagName.toLowerCase();
                forwardDump.push(`${tag}${role ? "[" + role + "]" : ""}${ariaHasPopup ? "[hp=" + ariaHasPopup + "]" : ""}${cursor === "pointer" ? "[p]" : ""}.${cls}`.slice(0, 90));
                dumped++;
              }
            }
            return {
              ok: false,
              reason: "no-following-trigger",
              labelCount: labelCandidates.length,
              triggerCount: allTriggers.length,
              dump: forwardDump.join(" | "),
            };
          }

          const t = bestPair.trigger;
          t.scrollIntoView({ block: "center" });
          // Custom-element wrapper <ks-input-selector-*> has a child with
          // style="display: contents;" (Vue slot passthrough) that has NO
          // bounding box. TikTok's actual clickable row is a nested
          // descendant with a real box (typically has "max-h-[38px]" or
          // "flex" utility classes). Skip the display:contents layer and
          // find the deepest visible descendant with a real box.
          const findRealClickable = (root) => {
            const stack = Array.from(root.children);
            let best = null;
            let bestArea = 0;
            while (stack.length) {
              const el = stack.pop();
              if (el.children) for (const c of el.children) stack.push(c);
              const cs = window.getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              if (cs.display === "contents") continue;
              const r = el.getBoundingClientRect();
              if (r.width < 10 || r.height < 10) continue;
              // Prefer larger elements — actual dropdown rows are bigger
              // than icon/arrow spans inside them.
              const area = r.width * r.height;
              if (area > bestArea) {
                best = el;
                bestArea = area;
              }
            }
            return best;
          };
          const innerClickable = findRealClickable(t);
          // Do NOT dispatch any synthetic clicks here. Dispatching the
          // full pointer/mouse/click sequence on 3 successive targets
          // toggled the dropdown open->closed->open unpredictably (pixel
          // happened to land open, event/bid landed closed with popups=0).
          // We only RETURN coordinates; the Node side does ONE trusted
          // mouse click and verifies the popup after each attempt.
          const tr = t.getBoundingClientRect();
          const inner = innerClickable ? innerClickable.getBoundingClientRect() : null;
          return {
            ok: true,
            tag: t.tagName.toLowerCase(),
            cls: (t.className && typeof t.className === "string") ? t.className.slice(0, 60) : "",
            gap: Math.round(bestPair.gap),
            cx: tr.left + tr.width / 2,
            cy: tr.top + tr.height / 2,
            innerCx: inner ? inner.left + inner.width / 2 : null,
            innerCy: inner ? inner.top + inner.height / 2 : null,
            innerTag: innerClickable ? innerClickable.tagName.toLowerCase() : null,
            innerHTML: t.innerHTML.slice(0, 400).replace(/\s+/g, " "),
          };
        }, labelText);

        // For custom elements like <ks-input-selector-*>, programmatic
        // events in-page often DONT trigger the popup mount because
        // TikTok listens for trusted (isTrusted=true) events. Follow up
        // with Playwrights real mouse click (fires OS-level trusted
        // events) at the INNER clickable's center. If that still fails,
        // try Enter/Space keyboard on the focused element.
        const popupCheck = async () => await page.evaluate(() => {
          return Array.from(document.querySelectorAll("*")).some((el) => {
            const cs = window.getComputedStyle(el);
            if (cs.position !== "fixed" && cs.position !== "absolute") return false;
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 40) return false;
            if (cs.display === "none" || cs.visibility === "hidden") return false;
            const z = parseInt(cs.zIndex);
            if (isNaN(z) || z < 100) return false;
            if (r.width >= window.innerWidth - 50 && r.height < 80) return false;
            if (r.width >= window.innerWidth - 50 && r.height >= window.innerHeight - 50) return false;
            return true;
          });
        });

        // "Dropdown open" = portal popup mounted, OR the target option's
        // text is visible, OR the count of visible option-ish rows grew
        // (covers inline dropdowns whose options don't match the needle
        // — e.g. the pixel's event list not containing "Shopping").
        const countVisibleOptions = async () => await page.evaluate(() => {
          let n = 0;
          const els = Array.from(document.querySelectorAll('[role="option"], li, [class*="option" i]:not([class*="options" i]), [class*="menu-item" i], [class*="select-item" i]'));
          for (const o of els) {
            const r = o.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const cs = window.getComputedStyle(o);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            n++;
          }
          return n;
        }).catch(() => 0);
        const optCountBefore = await countVisibleOptions();
        const dropdownOpen = async () => {
          if (await popupCheck()) return true;
          const needleVisible = await page.evaluate((needle) => {
            const re = new RegExp("^\\s*" + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            const els = Array.from(document.querySelectorAll('[role="option"], li, [class*="option" i], [class*="item" i], [class*="menu" i] *'));
            for (const o of els) {
              if (o.children.length > 3) continue;
              const t = (o.innerText || o.textContent || "").trim();
              if (!t || t.length > 80) continue;
              const r = o.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (re.test(t)) return true;
            }
            return false;
          }, optionText).catch(() => false);
          if (needleVisible) return true;
          return (await countVisibleOptions()) >= optCountBefore + 2;
        };

        if (triggered && triggered.ok) {
          // ONE trusted click at a time, verify after each — never click
          // again once the dropdown is open (second click toggles it
          // shut). NO keyboard fallback: pressing Enter/Space on "whatever
          // is focused" once activated the budget-recommendation Apply
          // link and rewrote the budget to 254.79 USD.
          let popupAfter = false;
          if (triggered.innerCx != null) {
            try {
              await page.mouse.move(triggered.innerCx, triggered.innerCy);
              await page.waitForTimeout(80);
              await page.mouse.click(triggered.innerCx, triggered.innerCy, { delay: 60 });
            } catch {}
            await page.waitForTimeout(1000);
            popupAfter = await dropdownOpen();
          }
          // Strategy 2: mouse click at outer trigger center — only when
          // we're confident the dropdown is still closed.
          if (!popupAfter && triggered.cx != null) {
            try {
              await page.mouse.move(triggered.cx, triggered.cy);
              await page.waitForTimeout(80);
              await page.mouse.click(triggered.cx, triggered.cy, { delay: 60 });
            } catch {}
            await page.waitForTimeout(1000);
            popupAfter = await dropdownOpen();
          }
        }

        let triggerVia = triggered && triggered.ok ? `ok:${triggered.tag}|gap=${triggered.gap}` : "";

        // Brute-force fallback: if document-order pairing failed,
        // simulate a mouse click at calculated coordinates below each
        // label candidate. This bypasses ALL selector matching — we
        // just hit the area where TikTok renders the dropdown trigger
        // and check whether a popup appeared.
        if (!triggered || !triggered.ok) {
          const labelPositions = await page.evaluate((needle) => {
            const labelRe = new RegExp(`^${needle.replace(/\s+/g, "\\s*")}(?:\\s*[\\?ⓘ\\(\\)i ])?$`, "i");
            const allEls = Array.from(document.querySelectorAll("*"));
            const out = [];
            for (const el of allEls) {
              if (el.children.length > 4) continue;
              const t = (el.innerText || el.textContent || "").trim();
              if (!t || !labelRe.test(t)) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const cs = window.getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
            }
            return out;
          }, labelText);

          let bruteOpened = false;
          outer: for (const lp of labelPositions) {
            for (const offset of [55, 95, 140, 190, 250]) {
              const cx = lp.x + Math.min(lp.w / 2, 120);
              const cy = lp.y + lp.h + offset;
              try { await page.mouse.click(cx, cy); } catch {}
              await page.waitForTimeout(350);
              const opened = await page.evaluate(() => {
                return !!document.querySelector(
                  '[role="listbox"], [class*="select-popup" i], [class*="select-dropdown" i]:not([class*="dropdown-arrow"]), [class*="cascader-popup" i], [class*="dropdown-menu" i]'
                );
              });
              if (opened) {
                triggerVia = `brute-click|offset=${offset}`;
                bruteOpened = true;
                break outer;
              }
            }
          }

          if (!bruteOpened) {
            const why = triggered ? triggered.reason : "evaluate-null";
            const extra = triggered ? `|labels=${triggered.labelCount || 0}|triggers=${triggered.triggerCount || 0}` : "";
            const dump = triggered && triggered.dump ? `|dump=${triggered.dump}` : "";
            return `error:trigger-not-found:${labelText}|why=${why}${extra}|brute-tried=${labelPositions.length}${dump}`;
          }
        }
        await page.waitForTimeout(900);

        // EXACT match via DOM scan first. Playwright :has-text() was
        // doing substring match, so picking "PRST TR 3" matched any
        // option containing "PRST" + "TR" — TikTok ended up with the
        // wrong pixel selected. Use anchored regex via the existing
        // pickDropdownOption helper.
        const escaped = optionText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const exactRe = new RegExp(`^\\s*${escaped}(?:\\s*\\([^)]*\\))?\\s*$`, "i");
        let picked = await pickDropdownOption(page, exactRe);
        if (typeof picked === "string" && /^pass[123]:/.test(picked)) {
          return `picked:${optionText}|via:${picked}`;
        }
        // The min-age failure screenshot showed the dropdown OPEN with
        // the target option visible — the scan had simply run before the
        // open animation finished. One patient rescan.
        await page.waitForTimeout(900);
        picked = await pickDropdownOption(page, exactRe);
        if (typeof picked === "string" && /^pass[123]:/.test(picked)) {
          return `picked:${optionText}|via:rescan:${picked}`;
        }

        // Fallback: type-ahead. Find a visible input INSIDE a recently
        // mounted high-z overlay (the open popup) and type the option
        // text to filter. Scope to the highest-z popup so we don't end
        // up typing into Target CPA's input or some unrelated field.
        const typed = await page.evaluate((needle) => {
          const all = Array.from(document.querySelectorAll("*"));
          const popups = all.filter((el) => {
            const cs = window.getComputedStyle(el);
            if (cs.position !== "fixed" && cs.position !== "absolute") return false;
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 40) return false;
            if (cs.display === "none" || cs.visibility === "hidden") return false;
            const z = parseInt(cs.zIndex);
            if (isNaN(z) || z < 100) return false;
            return true;
          });
          popups.sort((a, b) => (parseInt(window.getComputedStyle(b).zIndex) || 0) - (parseInt(window.getComputedStyle(a).zIndex) || 0));
          // NEVER fall back to document.body here — with no popup open,
          // the "first visible input on the page" was the global search
          // bar / campaign fields and we typed option text into them.
          const scopes = popups.slice(0, 3);
          if (!scopes.length) return false;
          let candidate = null;
          for (const sc of scopes) {
            const inputs = Array.from(sc.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'));
            for (const i of inputs) {
              const r = i.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const cs = window.getComputedStyle(i);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              candidate = i;
              break;
            }
            if (candidate) break;
          }
          if (!candidate) return false;
          candidate.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) {
            setter.call(candidate, "");
            candidate.dispatchEvent(new Event("input", { bubbles: true }));
            setter.call(candidate, needle);
            candidate.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            candidate.value = needle;
            candidate.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return true;
        }, optionText);

        if (typed) {
          await page.waitForTimeout(700);
          picked = await pickDropdownOption(page, exactRe);
          if (typeof picked === "string" && /^pass[123]:/.test(picked)) {
            return `picked:${optionText}|via:type-ahead:${picked}`;
          }
        }

        // Last resort: substring match — but for FULLY-NUMERIC options
        // (Minimum age "25") the loose pass is disabled entirely: it
        // matched the "25-34" age-suggestion chip and toggled it. A
        // numeric dropdown option must match exactly or not at all.
        const isNumeric = /^\d+$/.test(optionText.trim());
        if (!isNumeric) {
          const loose = await pickDropdownOption(page, new RegExp(`\\b${escaped}\\b`, "i"));
          if (typeof loose === "string" && /^pass[123]:/.test(loose)) {
            return `picked:${optionText}|via:loose-fallback:${loose}`;
          }
        }

        // Put diag INFO first — the error text gets truncated in the
        // adsalim UI at ~250 chars so the seen=[...] list was pushing
        // trigger-html/screenshot out of view.
        let dbgUrl = "";
        try {
          const buf = await page.screenshot({ fullPage: false });
          if (buf && typeof saveScreenshot === "function") {
            const id = saveScreenshot(buf);
            dbgUrl = `|shot=${id}`;
          }
        } catch {}
        const triggerSnippet = triggered && triggered.innerHTML
          ? `|trig=${triggered.tag}|ihtml=${triggered.innerHTML.slice(0, 120).replace(/\s+/g, " ")}`
          : `|trig=none|why=${(triggered && triggered.reason) || "?"}`;
        // Close any half-open popup so it doesn't cover the NEXT field's
        // trigger (a lingering event-dropdown was blocking the bid pick).
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(200);
        return `error:option-not-found:${optionText}${triggerSnippet}${dbgUrl}|picked=${String(picked).slice(0, 100)}`;
      } catch (e) {
        const msg = (e.message || "").slice(0, 120).replace(/\s+/g, " ");
        return `error:${msg}`;
      }
    }

    async function fillLabeledInput(labelText, value) {
      try {
        const label = page.getByText(labelText, { exact: true }).first();
        await label.scrollIntoViewIfNeeded({ timeout: 3000 });
        const row = label.locator("xpath=ancestor::*[position()<=5]").first();
        const inp = row.locator('input[type="text"], input[type="number"], input:not([type])').first();
        await inp.fill(String(value), { timeout: 3000 });
        return true;
      } catch {
        return false;
      }
    }

    // Retry wrapper: after the pixel changes, TikTok runs a server-side
    // revalidation ("Your data connection has no recent activity" banner)
    // during which the event/bid selectors are temporarily inert — a
    // single attempt lands popups=0. Retry the whole open-and-pick up to
    // 3 times with a growing pause.
    const pickWithRetry = async (labelText, optionText) => {
      let last = "";
      for (let i = 0; i < 3; i++) {
        last = await pickFromDropdown(labelText, optionText);
        if (typeof last === "string" && last.startsWith("picked:")) return i === 0 ? last : `${last}|retry=${i}`;
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(2000 + i * 1000);
      }
      return last;
    };

    // TikTok re-opens the objective modal whenever campaign details are
    // incomplete (e.g. after the page-footer Continue) — resolve it
    // before touching any ad-group field, else every pick fights the
    // modal backdrop and stray clicks hit modal controls.
    adGroupReport.modalBeforeAdgroup = await ensureObjectiveConfirmed();

    // 10a. Data connection (Pixel)
    if (pixelName) {
      adGroupReport.pixelPick = await pickWithRetry("Data connection", pixelName);
      // Let TikTok's pixel revalidation settle before touching event/bid.
      await page.waitForTimeout(3000);
    }
    void pixelId;

    // 10b. Optimization event — TikTok shows event names as the form
    //      labels ("Purchase", "Add to Cart", "Shopping") rather than
    //      the API enum values. Map the API enum to its UI label here.
    if (optimizationEvent) {
      const eventLabelMap = {
        SHOPPING: "Shopping",
        PURCHASE: "Purchase",
        ADD_TO_CART: "Add to Cart",
        ADD_PAYMENT_INFO: "Add Payment Info",
        SUBSCRIBE: "Subscribe",
        FORM: "Submit Form",
        CONTACT: "Contact",
        ON_WEB_ORDER: "Place an Order",
        ON_WEB_DETAIL: "View Content",
        ON_WEB_REGISTER: "Complete Registration",
        ON_WEB_SUBSCRIBE: "Subscribe",
      };
      const eventLabel = eventLabelMap[optimizationEvent] || optimizationEvent;
      adGroupReport.eventPick = await pickWithRetry("Optimization event", eventLabel);
      await page.waitForTimeout(600);
    }

    // 10c. Bid strategy dropdown
    if (bidStrategy) {
      const bidLabel = bidStrategy === "BID_TYPE_CUSTOM"
        ? "Target cost per result"
        : "Maximum delivery";
      adGroupReport.bidPick = await pickWithRetry("Bid strategy", bidLabel);
      await page.waitForTimeout(400);
    }

    // 10d. Target CPA input
    if (typeof targetCPA === "number" && targetCPA > 0) {
      adGroupReport.targetCPAFilled = await fillLabeledInput("Target CPA", targetCPA);
    }

    // 10e. Daily budget input
    if (adgroupBudgetUSD && adgroupBudgetUSD > 0) {
      adGroupReport.budgetFilled = await fillLabeledInput("Budget", adgroupBudgetUSD);
    }

    // 10f. Goal-based budget increase — TikTok auto-enables this when
    // you enter a daily budget. We force it OFF so the budget the user
    // typed is the actual hard cap (no automatic 20-200% increase).
    // Toggle mounts a moment after budget input, so wait + scroll first.
    await page.waitForTimeout(700);
    await page.evaluate(() => window.scrollBy(0, 250));
    await page.waitForTimeout(300);
    adGroupReport.goalBasedBudgetOff = await toggleOffByDocOrder(page, "Goal-based budget increase");

    // 11. Scroll down so the rest of the ad-group form (audience,
    //     placements, budget, schedule) is in view for screenshots.
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(600);
    await dismissModals(page);
    await shot(page, "06-adgroup-mid");

    // 12. AUDIENCE TARGETING — keep AUTOMATIC targeting (Smart+ default),
    //     do NOT switch to manual. The account-level automatic mode shows
    //     two editable sub-sections with pencil (✏️) icons:
    //       - "Audience controls"          -> Location (+ min age)
    //       - "Automatic targeting guidance" -> Age groups
    //     We click each pencil to open its editor, then fill the values.
    if ((countryIds && countryIds.length) || (ageGroupIds && ageGroupIds.length)) {
      // Resolve the objective modal if it re-opened — one run's audience
      // pencil finder matched the modal's Search-campaign ks-switch and
      // toggled it because the modal was covering the page here.
      await ensureObjectiveConfirmed();
      const COUNTRY_MAP = {
        "6252001": "United States", "3175395": "Italy", "2510769": "Spain",
        "3017382": "France", "2635167": "United Kingdom", "2750405": "Netherlands",
        "2921044": "Germany", "2802361": "Belgium", "2658434": "Switzerland",
        "2782113": "Austria", "2264397": "Portugal", "2960313": "Luxembourg",
        "3144096": "Norway", "2661886": "Sweden", "2623032": "Denmark",
        "660013": "Finland", "294640": "Israel", "298795": "Turkey",
        "2017370": "Russia", "1814991": "China", "1835841": "South Korea",
        "1861060": "Japan",
      };

      // Scroll the Audience targeting section into view.
      await page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll("*")).find((el) => {
          if (el.children.length > 4) return false;
          const t = (el.innerText || el.textContent || "").trim();
          return /^audience targeting(?:\s*[\?ⓘ])?$/i.test(t);
        });
        if (heading) heading.scrollIntoView({ block: "start" });
      });
      await page.waitForTimeout(500);
      await dismissModals(page);

      // Helper: click the edit pencil in the same row as a section
      // heading. TikTok's pencil is a <div class="lego-icons_*"> (hash
      // rotates); the chevron next to it is lego-arrow_* / chevron. We
      // target lego-icons, EXCLUDE arrows/chevrons, and click the nearest
      // clickable ancestor with a trusted mouse event. Returns whether an
      // editor opened.
      const clickEditPencil = async (headingRe, shotLabel) => {
        // Scroll the heading to center first so positions are stable.
        await page.evaluate((reSrc) => {
          const re = new RegExp(reSrc, "i");
          const all = Array.from(document.querySelectorAll("*"));
          for (const el of all) {
            if (el.children.length > 2) continue;
            const t = (el.innerText || el.textContent || "").trim();
            if (re.test(t)) {
              const cs = window.getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              el.scrollIntoView({ block: "center" });
              break;
            }
          }
        }, headingRe.source);
        await page.waitForTimeout(400);

        const info = await page.evaluate((reSrc) => {
          const re = new RegExp(reSrc, "i");
          const isVisible = (el) => {
            const cs = window.getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const clsOf = (el) => {
            if (!el.className) return "";
            if (typeof el.className === "string") return el.className;
            if (el.className.baseVal) return el.className.baseVal;
            return "";
          };
          // Chevron/arrow test now checks TAG NAME too — TikTok renders
          // <ks-icon-chevron-up class="ks-icon">, so the "chevron" is in
          // the tag, not the class. That leaked through before.
          const isChevron = (el) => {
            const tag = (el.tagName || "").toLowerCase();
            const cls = clsOf(el).toLowerCase();
            return /arrow|chevron|caret|expand|collapse|angle/.test(tag) ||
                   /arrow|chevron|caret|expand|collapse|angle/.test(cls);
          };
          const isPencilEl = (el) => {
            const tag = (el.tagName || "").toLowerCase();
            const cls = clsOf(el).toLowerCase();
            return /lego-icons|edit|pencil/.test(tag) || /lego-icons|edit|pencil/.test(cls);
          };
          const all = Array.from(document.querySelectorAll("*"));
          let heading = null;
          for (const el of all) {
            if (el.children.length > 2) continue;
            const t = (el.innerText || el.textContent || "").trim();
            if (re.test(t) && isVisible(el)) { heading = el; break; }
          }
          if (!heading) return { ok: false, reason: "heading-not-found" };
          const hr = heading.getBoundingClientRect();

          // Reject anything living in the LEFT NAV / any nav / inside an
          // <a href> — a prior run's "pencil" was the nav Payment icon
          // (ks-icon > ks-nav-item > a) and clicking it navigated the
          // whole page to account/payment.
          const inNavOrLink = (el) => {
            let cur = el;
            for (let i = 0; i < 8 && cur; i++) {
              const tag = (cur.tagName || "").toLowerCase();
              if (tag === "nav" || /^ks-nav/.test(tag) || tag === "a") return true;
              const cls = clsOf(cur).toLowerCase();
              if (/\bnav\b|sidebar|ksnav/.test(cls)) return true;
              cur = cur.parentElement;
            }
            const r = el.getBoundingClientRect();
            if (r.left < 100) return true; // left rail
            return false;
          };

          // PRIMARY: walk up ancestors from the heading; at each, find a
          // pencil descendant (lego-icons/edit, NOT chevron) that is
          // visible + icon-sized. This ties the pencil to the heading's
          // own row subtree, avoiding the card-level collapse chevron.
          const diag = [];
          let pencil = null;
          let cursor = heading;
          for (let i = 0; i < 6 && cursor && !pencil; i++) {
            const parent = cursor.parentElement;
            if (!parent) break;
            const descendants = Array.from(parent.querySelectorAll("*"));
            for (const d of descendants) {
              if (d === heading || d.contains(heading)) continue;
              if (!isVisible(d)) continue;
              if (isChevron(d)) continue;
              if (!isPencilEl(d)) continue;
              if (inNavOrLink(d)) continue;
              const r = d.getBoundingClientRect();
              if (r.width > 60 || r.height > 60 || r.width < 6 || r.height < 6) continue;
              pencil = d;
              if (diag.length < 6) diag.push(`P:${d.tagName.toLowerCase()}@${Math.round(r.left)},${Math.round(r.top)}.${clsOf(d).slice(0, 20)}`);
              break;
            }
            cursor = parent;
          }

          // FALLBACK: same-row position scan across the doc, pencil-class
          // preferred, chevrons excluded (tag+class).
          if (!pencil) {
            const hCenterY = hr.top + hr.height / 2;
            const minLeft = hr.left + 120;
            const cands = Array.from(document.querySelectorAll("*"));
            const matches = [];
            for (const c of cands) {
              if (c === heading || c.contains(heading) || heading.contains(c)) continue;
              if (!isVisible(c)) continue;
              if (isChevron(c)) continue;
              if (inNavOrLink(c)) continue;
              const r = c.getBoundingClientRect();
              if (Math.abs((r.top + r.height / 2) - hCenterY) > 60) continue;
              if (r.width > 60 || r.height > 60 || r.width < 6 || r.height < 6) continue;
              if (r.left < minLeft) continue;
              const pen = isPencilEl(c);
              matches.push({ el: c, left: r.left, pen });
              if (diag.length < 8) diag.push(`F:${c.tagName.toLowerCase()}@${Math.round(r.left)},${Math.round(r.top)}.${clsOf(c).slice(0, 18)}`);
            }
            matches.sort((a, b) => (b.pen - a.pen) || (b.left - a.left));
            if (matches.length) pencil = matches[0].el;
          }

          if (!pencil) {
            return { ok: false, reason: "pencil-not-found", headingRect: `${Math.round(hr.left)},${Math.round(hr.top)},${Math.round(hr.width)}x${Math.round(hr.height)}`, diag: diag.join(" | ") };
          }

          // Dump the pencil's ancestor chain (4 levels) so we can see
          // which wrapper actually carries the click handler.
          const chain = [];
          let ch = pencil;
          for (let i = 0; i < 5 && ch; i++) {
            const cs = window.getComputedStyle(ch);
            const r = ch.getBoundingClientRect();
            chain.push(`${ch.tagName.toLowerCase()}.${clsOf(ch).slice(0, 16)}[cur=${cs.cursor.slice(0, 4)}|${Math.round(r.width)}x${Math.round(r.height)}]`);
            ch = ch.parentElement;
          }

          // Prefer a clickable ancestor (button/[role=button]/cursor:pointer)
          // but fall back to the pencil itself. NEVER settle on an <a>
          // (anchors navigate — that's how we ended up on the payment
          // page). Also mark the pencil for direct in-page dispatch.
          let clickTarget = pencil;
          let hops = 0;
          let cur = pencil;
          while (cur && hops < 5) {
            const tag = (cur.tagName || "").toLowerCase();
            if (tag === "a") break; // stop before an anchor
            const cs = window.getComputedStyle(cur);
            if (cur.matches?.('button, [role="button"], [class*="btn" i]') || cs.cursor === "pointer") { clickTarget = cur; break; }
            cur = cur.parentElement; hops++;
          }
          // Scroll FIRST, then measure — pre-scroll coords go stale.
          clickTarget.scrollIntoView({ block: "center" });
          const tr = clickTarget.getBoundingClientRect();
          // Tag the pencil so we can re-find it for in-page dispatch.
          pencil.setAttribute("data-vm-pencil", "1");
          return {
            ok: true,
            cx: tr.left + tr.width / 2,
            cy: tr.top + tr.height / 2,
            tag: clickTarget.tagName.toLowerCase(),
            cls: clsOf(clickTarget).slice(0, 30),
            hops,
            diag: diag.join(" | "),
            chain: chain.join(" > "),
          };
        }, headingRe.source);

        if (info && info.ok) {
          // Count visible form controls BEFORE — include TikTok custom
          // tags (ks-input-selector-*, ks-dropdown-menu-*) whose tagName
          // starts with ks-, not just class matches.
          const countFields = () => page.evaluate(() => {
            const els = Array.from(document.querySelectorAll("input, [class*='select'], [class*='input']"));
            const custom = Array.from(document.querySelectorAll("*")).filter((e) => /^ks-(input|dropdown|select|cascader)/.test((e.tagName || "").toLowerCase()));
            let n = 0;
            for (const e of [...els, ...custom]) {
              const r = e.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) n++;
            }
            return n;
          });
          const beforeFields = await countFields();
          // Attempt 1: trusted mouse click at the target center.
          try {
            await page.mouse.move(info.cx, info.cy);
            await page.waitForTimeout(80);
            await page.mouse.click(info.cx, info.cy, { delay: 60 });
          } catch {}
          await page.waitForTimeout(600);
          let mid = await countFields();
          // Attempt 2: if nothing changed, dispatch a full pointer+mouse
          // sequence on the tagged pencil AND each ancestor up to 4 levels
          // (the handler may be on a wrapper the mouse click missed).
          if (mid <= beforeFields) {
            await page.evaluate(() => {
              const pen = document.querySelector('[data-vm-pencil="1"]');
              if (!pen) return;
              let el = pen;
              for (let i = 0; i < 4 && el; i++) {
                for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
                  try {
                    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
                    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
                  } catch {}
                }
                el = el.parentElement;
              }
            });
            await page.waitForTimeout(800);
          }
          // Snapshot so we can SEE what the pencil click actually did.
          if (shotLabel) await shot(page, shotLabel);
          // Do NOT call dismissModals here — the edit panel can look like
          // a modal/drawer and dismissModals would close it.
          const afterFields = await countFields();
          info.editorOpened = afterFields > beforeFields;
          info.fieldDelta = `${beforeFields}=>${afterFields}`;
          info.urlAfter = page.url();
          // If nothing changed, retry once with a click on the pencils
          // parent (hops+1) — the glyph may not carry the handler.
          if (!info.editorOpened) {
            const retried = await page.evaluate((reSrc) => {
              const re = new RegExp(reSrc, "i");
              const all = Array.from(document.querySelectorAll("*"));
              let heading = null;
              for (const el of all) {
                if (el.children.length > 2) continue;
                const t = (el.innerText || el.textContent || "").trim();
                if (re.test(t)) { const cs = window.getComputedStyle(el); if (cs.display !== "none" && cs.visibility !== "hidden") { heading = el; break; } }
              }
              if (!heading) return null;
              const hr = heading.getBoundingClientRect();
              // Find the lego-editIcon in the heading subtree, click IT and
              // its parent with full pointer sequence.
              let cur = heading;
              for (let i = 0; i < 6 && cur; i++) {
                const p = cur.parentElement; if (!p) break;
                const pen = Array.from(p.querySelectorAll("*")).find((d) => {
                  const tag = (d.tagName || "").toLowerCase();
                  const cls = (d.className && typeof d.className === "string") ? d.className.toLowerCase() : "";
                  return /lego-editicon|lego-icons|edit|pencil/.test(tag + " " + cls) && !/arrow|chevron|caret/.test(tag + " " + cls);
                });
                if (pen) {
                  const targets = [pen, pen.parentElement, pen.parentElement && pen.parentElement.parentElement].filter(Boolean);
                  for (const t of targets) {
                    t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
                    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                    t.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
                    t.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                    t.click();
                  }
                  const r = pen.getBoundingClientRect();
                  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                }
                cur = p;
              }
              return null;
            }, headingRe.source);
            await page.waitForTimeout(1000);
            const after2 = await page.evaluate(() => document.querySelectorAll('input, [class*="ks-select" i], [class*="ks-input" i]').length);
            info.editorOpened = after2 > beforeFields;
            info.fieldDelta = `${beforeFields}=>${afterFields}=>${after2}`;
            info.retried = !!retried;
          }
        }
        return info;
      };

      // 12a. LOCATION via "Audience controls" pencil.
      if (countryIds && countryIds.length) {
        const editInfo = await clickEditPencil(/^audience controls(?:\s*[\?ⓘ])?$/i, "08-after-audctrl-pencil");
        adGroupReport.audienceControlsEdit = editInfo && editInfo.ok
          ? `clicked|opened=${editInfo.editorOpened}|fields=${editInfo.fieldDelta}|chain=${editInfo.chain}`
          : `error:${editInfo && editInfo.reason}|hr=${editInfo && editInfo.headingRect}|diag=${editInfo && editInfo.diag}`;
        if (editInfo && editInfo.ok) {
          const countryNames = countryIds.map((id) => COUNTRY_MAP[id]).filter(Boolean);

          // The Locations field is a search-as-you-type multi-select, not
          // a plain dropdown. Dedicated handler: focus its input, type the
          // country name, wait for the results, click the match.
          const pickLocation = async (name) => {
            // Find the Locations FIELD BOX (the container showing the
            // Vietnam chip + dropdown). Its search <input> is zero-width
            // until the box is focused, so we click the box first, then
            // type — the focused input receives the keystrokes.
            const boxPos = await page.evaluate(() => {
              // Find the "Locations" label. The field box sits directly
              // below it (a bordered container with the Vietnam chip + a
              // dropdown arrow). "Bulk upload" is the button right under
              // that box, so the field box lives between the label bottom
              // and the Bulk-upload top. Click the RIGHT-empty area of the
              // box to focus its search input.
              const all = Array.from(document.querySelectorAll("*"));
              const isVis = (el) => {
                const cs = window.getComputedStyle(el);
                if (cs.display === "none" || cs.visibility === "hidden") return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              };
              let label = null;
              for (const el of all) {
                if (el.children.length > 2) continue;
                const t = (el.innerText || el.textContent || "").trim();
                if (/^locations(?:\s*[\?ⓘ])?$/i.test(t) && isVis(el)) { label = el; break; }
              }
              if (!label) return null;
              const lr = label.getBoundingClientRect();
              // Find the widest bordered box within ~110px below the label.
              let box = null, bestScore = -1;
              for (const el of all) {
                const r = el.getBoundingClientRect();
                if (r.width < 250 || r.height < 24 || r.height > 120) continue;
                const gap = r.top - lr.bottom;
                if (gap < -5 || gap > 110) continue;
                if (!isVis(el)) continue;
                // Prefer a box that contains the current chip text.
                const txt = (el.innerText || el.textContent || "");
                const hasChip = /vietnam|\bx\b/i.test(txt) ? 1 : 0;
                const score = hasChip * 500 + (110 - gap) + r.width / 100;
                if (score > bestScore) { box = el; bestScore = score; }
              }
              if (!box) {
                // Fallback: click a computed point in the field row.
                return { x: lr.left + 220, y: lr.bottom + 35, fallback: true };
              }
              const br = box.getBoundingClientRect();
              return { x: br.right - 40, y: br.top + br.height / 2 };
            });
            if (!boxPos) return "no-box";
            // Click the box to focus its search input, then type.
            try {
              await page.mouse.click(boxPos.x, boxPos.y);
              await page.waitForTimeout(400);
              await page.keyboard.type(name, { delay: 45 });
            } catch {}
            // Poll up to 15s for the results to load (typing shows a
            // "Loading..." state first — last run was still loading when
            // the 6s poll gave up), then click the matching option.
            let picked = "no-option";
            for (let attempt = 0; attempt < 30; attempt++) {
              await page.waitForTimeout(500);
              picked = await page.evaluate((needle) => {
                const re = new RegExp("(?:^|\\b)" + needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
                const visible = (el) => {
                  const r = el.getBoundingClientRect();
                  const cs = window.getComputedStyle(el);
                  return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
                };
                // Scan for the MATCH first — an unrelated element that
                // permanently says "Loading" was short-circuiting every
                // round and we never even looked at the real results.
                const opts = Array.from(document.querySelectorAll('[role="option"], li, [class*="option" i], [class*="item" i], [class*="lego-list" i], [class*="cascader" i], [class*="dropdown" i] *, [class*="select" i] *'));
                const seen = [];
                let sawLoading = false;
                for (const o of opts) {
                  if (o.children.length > 2) continue;
                  const t = (o.innerText || o.textContent || "").trim();
                  if (!t || t.length > 60) continue;
                  if (!visible(o)) continue;
                  if (/loading/i.test(t)) { sawLoading = true; continue; }
                  if (seen.length < 12) seen.push(t.slice(0, 20));
                  if (!re.test(t)) continue;
                  o.scrollIntoView({ block: "center" });
                  o.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
                  o.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                  o.click();
                  return "picked:" + t.slice(0, 30);
                }
                if (sawLoading) return "loading";
                return "no-option|seen=[" + seen.slice(0, 8).join(", ") + "]";
              }, name);
              if (picked.startsWith("picked:")) break;
              if (picked === "loading") continue;
              // non-loading, non-picked: options render progressively, so
              // allow several no-match rounds before giving up.
              if (attempt >= 10) break;
            }
            await shot(page, `10-loc-typed-${name}`);
            await page.waitForTimeout(500);
            return picked;
          };

          // Remove the pre-applied Vietnam chip: find ✕ inside the
          // Locations field only (near the Locations label).
          await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll("*"));
            let label = null;
            for (const el of all) {
              if (el.children.length > 2) continue;
              const t = (el.innerText || el.textContent || "").trim();
              if (/^locations(?:\s*[\?ⓘ])?$/i.test(t)) { label = el; break; }
            }
            if (!label) return;
            const lr = label.getBoundingClientRect();
            const closes = Array.from(document.querySelectorAll('[class*="tag" i] [class*="close" i], [class*="chip" i] [class*="close" i], [aria-label*="remove" i], [aria-label*="close" i], svg'));
            for (const b of closes) {
              const r = b.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              // Only chips within ~120px below the Locations label.
              if (r.top < lr.bottom - 5 || r.top - lr.bottom > 120) continue;
              const cls = (b.className && typeof b.className === "string") ? b.className : "";
              const parentCls = (b.parentElement && typeof b.parentElement.className === "string") ? b.parentElement.className : "";
              if (!/close|remove|tag|chip/i.test(cls + " " + parentCls)) continue;
              try { b.click(); } catch {}
            }
          });
          await page.waitForTimeout(500);

          adGroupReport.countryPicks = [];
          for (const name of countryNames) {
            const r = await pickLocation(name);
            adGroupReport.countryPicks.push(`${name}=>${r}`);
            await page.waitForTimeout(600);
          }

          // MINIMUM AGE — the real, reliable age control lives in
          // Audience controls (already expanded here). The "Ages" chips
          // in Automatic targeting guidance are only soft SUGGESTIONS
          // ("delivery isn't guaranteed"), so we skip those and set the
          // hard floor via the Minimum age dropdown instead.
          if (ageGroupIds && ageGroupIds.length) {
            const AGE_FLOOR = {
              AGE_13_17: 13, AGE_18_24: 18, AGE_25_34: 25,
              AGE_35_44: 35, AGE_45_54: 45, AGE_55_100: 55,
            };
            const floors = ageGroupIds.map((id) => AGE_FLOOR[id]).filter((n) => typeof n === "number");
            if (floors.length) {
              const minAge = Math.min(...floors);
              adGroupReport.minAgePick = await pickFromDropdown("Minimum age", String(minAge));
            }
          }
        }
      }
    }

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
      confirmClicked,
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
