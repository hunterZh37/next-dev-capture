#!/usr/bin/env node
/**
 * next-dev-capture runner: drives your app in Chrome from a scenario file and records it frame by frame. Each frame is
 * a real screenshot of the browser, paired with the console and network lines of every page in the tab (all
 * same-origin iframes, marked by frame) since the previous frame, and named after the step being run.
 *
 *   node ~/next-dev-capture/runner/run.mjs --url http://localhost:5381/__stage/ --scenario ./my.scenario.mjs [options]
 *
 * Options:
 *   --rounds N        run the scenario N times (default 1), one recording per run
 *   --every MS        also take a frame every MS while a step runs (default 1000; 0 = only after each step)
 *   --width W --height H   browser size (default 2500 x 950)
 *   --headful         show the browser window
 *   --chrome PATH     Chrome to use (default: Google Chrome in /Applications)
 *
 * The page must run next-dev-capture (the top page's hub). Output: the app's .dev-captures/rec-<time>-<name>/, with
 * frame-0001.png + frame-0001.txt (console) + frame-0001.net.txt (network), and summary.md for the run.
 */
import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
let puppeteer;
try {
  puppeteer = require("puppeteer-core");
} catch {
  console.error("puppeteer-core is missing: run  npm install --prefix ~/next-dev-capture/runner");
  process.exit(2);
}

// ---- arguments
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const URL_ = arg("url");
const SCENARIO = arg("scenario");
if (!URL_ || !SCENARIO) {
  console.error("usage: run.mjs --url <stage url> --scenario <file.mjs> [--rounds N] [--every MS] [--headful]");
  process.exit(2);
}
const ROUNDS = Math.max(1, Math.floor(Number(arg("rounds", 1))) || 1);
const EVERY = Math.max(0, Number(arg("every", 1000)) || 0);
const WIDTH = Number(arg("width", 2500)) || 2500;
const HEIGHT = Number(arg("height", 950)) || 950;
const HEADFUL = arg("headful", false) === true;
const CHROME = arg("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");

const scenarioMod = await import(pathToFileURL(path.resolve(SCENARIO)).href);
const scenario = scenarioMod.default;
if (typeof scenario !== "function") {
  console.error(`${SCENARIO} must export a default async function (t) => { ... }`);
  process.exit(2);
}
const NAME = scenarioMod.name || path.basename(SCENARIO).replace(/\.(scenario\.)?m?js$/, "");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);

// ---- browser
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADFUL ? false : "shell",
  defaultViewport: { width: WIDTH, height: HEIGHT },
  args: [`--window-size=${WIDTH},${HEIGHT + 90}`],
});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push({ at: now(), text: String(e?.message ?? e) }));
if (scenarioMod.setup) await scenarioMod.setup({ page, browser });

// ---- the API a scenario gets
// a target is a CSS selector when it starts with # . [ or css= (css=button.pay); anything else is visible text
// (#id, .class and [attr] shapes only, so text like ".5 off" or "#1 pick" stays text)
const isSelector = (s) => /^(css=|#[A-Za-z_-]|\.[A-Za-z_-]|\[[A-Za-z_-])/.test(s);
// a navigation or a reloading frame: try again; anything else (a bad selector) is a real error
const transient = (e) => /context was destroyed|detached|Target closed|Cannot find context|navigat/i.test(String(e?.message ?? e));
const css = (s) => s.replace(/^css=/, "");

/**
 * Finds a visible element in `frame` by CSS selector, or by its text (exact first, then starts with, then contains).
 * Waits for it to be enabled too, unless { enabled: false }: clicking a disabled button does nothing, silently.
 */
async function find(frame, target, { timeout = 10_000, enabled = true } = {}) {
  const start = Date.now();
  for (;;) {
    const handle = await frame
      .evaluateHandle(
        (target, bySelector, enabled) => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (enabled && (el.matches(":disabled") || el.closest('[aria-disabled="true"]'))) return false;
            return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && !el.closest("[inert]");
          };
          if (bySelector) return [...document.querySelectorAll(target.replace(/^css=/, ""))].find(visible) ?? null;
          const want = target.trim().toLowerCase();
          const pool = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="radio"], [role="option"], label, input[type="submit"], [tabindex="0"]')].filter(visible);
          const text = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").toLowerCase();
          // the innermost match: a wrapper whose text happens to contain the target never wins over the control in it
          // ...and of two same-named controls (one under an open sheet), the one on top
          const onTop = (el) => {
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !top || top === el || el.contains(top) || top.contains(el);
          };
          const pick = (test) => {
            const hits = pool.filter((el) => test(text(el))).filter((el, _, all) => !all.some((o) => o !== el && el.contains(o)));
            return hits.find(onTop) ?? hits[0] ?? null;
          };
          return pick((x) => x === want) ?? pick((x) => x.startsWith(want)) ?? pick((x) => x.includes(want));
        },
        target,
        isSelector(target),
        enabled
      )
      .catch((e) => {
        if (transient(e)) return null;
        throw new Error(`${target}: ${String(e?.message ?? e).split("\n")[0]}`);
      });
    const el = handle?.asElement?.();
    if (el) return el;
    if (Date.now() - start > timeout) throw new Error(`not found${enabled ? " (or still disabled)" : ""} within ${timeout} ms: ${target}`);
    await wait(150);
  }
}

let snapping = Promise.resolve();
let inFlight = 0;
let lost = 0; // frames the page did not take: its recording is gone (the top page reloaded) or a save failed
/** One frame: a real screenshot of the whole browser window plus the lines since the last frame. Serialized. */
function snap(step, { tick = false } = {}) {
  // a timed frame while one is still saving is skipped, so slow saves never pile up behind a step
  if (tick && inFlight) return snapping;
  inFlight++;
  snapping = snapping.then(async () => {
    try {
      const png = await page.screenshot({ encoding: "base64" });
      const r = await page.evaluate(
        (png, step) => window.__devCaptureHub?.run?.frame(`data:image/png;base64,${png}`, step) ?? null,
        png,
        step
      );
      if (!r) lost++;
    } catch {
      lost++;
    } finally {
      inFlight--;
    }
  });
  return snapping;
}

function makeT(round) {
  const steps = [];
  const t = {
    page,
    round,
    rounds: ROUNDS,
    wait,
    /** The frame inside an iframe, by the iframe's title (or any CSS selector for the iframe). */
    async frame(titleOrSelector, { timeout = 15_000 } = {}) {
      const sel = isSelector(titleOrSelector) ? css(titleOrSelector) : `iframe[title="${String(titleOrSelector).replace(/["\\]/g, "\\$&")}"]`;
      const start = Date.now();
      for (;;) {
        const h = await page.$(sel);
        const f = h && (await h.contentFrame());
        if (f) return f;
        if (Date.now() - start > timeout) throw new Error(`no frame ${titleOrSelector}`);
        await wait(150);
      }
    },
    find,
    /** Clicks a visible element by selector or text. */
    async click(frame, target, opts = {}) {
      const timeout = opts.timeout ?? 10_000;
      const start = Date.now();
      for (;;) {
        const el = await find(frame, target, { ...opts, timeout: Math.max(500, timeout - (Date.now() - start)) });
        // still moving (a sheet sliding in) or covered (an overlay): a click there lands on something else
        const ready = await el
          .evaluate(async (e) => {
            e.scrollIntoView({ block: "center", inline: "center" });
            const box = () => JSON.stringify(e.getBoundingClientRect());
            const a = box();
            await new Promise((r) => setTimeout(r, 120));
            if (box() !== a) return "moving";
            const r = e.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (top && top !== e && !e.contains(top) && !top.contains(e)) return `covered by ${top.tagName.toLowerCase()}${top.className ? "." + String(top.className).split(" ")[0] : ""}`;
            return "ok";
          })
          .catch((e) => (transient(e) ? "moving" : Promise.reject(e)));
        if (ready === "ok") {
          await el.click();
          return;
        }
        if (Date.now() - start > timeout) throw new Error(`${target}: ${ready} for ${timeout} ms`);
        await wait(150);
      }
    },
    /** Types into an input by selector (cleared first). */
    async type(frame, selector, text, opts) {
      const el = await find(frame, selector, { enabled: false, ...opts });
      await el.click({ clickCount: 3 }).catch(() => {});
      await el.evaluate((e) => {
        e.value = "";
        e.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await el.type(String(text), { delay: 15 });
    },
    /** Waits until the frame's visible text contains `text` (a string or RegExp). */
    async waitText(frame, text, { timeout = 15_000 } = {}) {
      const src = text instanceof RegExp ? { re: text.source, flags: text.flags } : { s: String(text).toLowerCase() };
      await frame.waitForFunction(
        (src) => {
          const body = document.body?.innerText ?? "";
          return src.re ? new RegExp(src.re, src.flags).test(body) : body.toLowerCase().includes(src.s);
        },
        { timeout, polling: 200 },
        src
      );
    },
    /** Waits until the frame's address (path + query + hash) matches. */
    async waitUrl(frame, re, { timeout = 15_000 } = {}) {
      const start = Date.now();
      while (!re.test(frame.url())) {
        if (Date.now() - start > timeout) throw new Error(`still at ${frame.url()}, wanted ${re}`);
        await wait(150);
      }
    },
    /** Types a card into a Stripe Elements iframe nested in `frame` (test cards only). */
    async stripeCard(frame, { number = "4242424242424242", exp = "12/34", cvc = "123", zip = "60601" } = {}, { timeout = 20_000 } = {}) {
      const start = Date.now();
      const fill = async (names, value, within = timeout) => {
        const until = Date.now() + within;
        for (;;) {
          for (const f of frame.childFrames()) {
            if (!/stripe\.com/.test(f.url())) continue;
            const el = await f.$(names.map((n) => `input[name="${n}"]`).join(",")).catch(() => null);
            if (el) {
              await el.click().catch(() => {});
              await el.type(value, { delay: 20 });
              return true;
            }
          }
          if (Date.now() > until) return false;
          await wait(250);
        }
      };
      // Payment Element names first, then the older Card Element's
      if (!(await fill(["number", "cardnumber"], number))) throw new Error("no Stripe card field found");
      if (!(await fill(["expiry", "exp-date"], exp))) throw new Error("no Stripe expiry field found");
      if (!(await fill(["cvc"], cvc))) throw new Error("no Stripe CVC field found");
      await fill(["postalCode", "postal"], zip, 1500);
    },
    /** A frame right now, named. */
    snap,
    /** Runs one named step; a frame is taken when it ends, and one marked FAILED when it throws. */
    async step(name, fn) {
      const started = Date.now();
      const rec = { name, ms: 0, ok: true, error: null };
      steps.push(rec);
      console.log(`  ${now()}  ${name}`);
      let ticker = null;
      if (EVERY) ticker = setInterval(() => void snap(`${name} (running)`, { tick: true }), EVERY);
      try {
        await fn();
        rec.ms = Date.now() - started;
        clearInterval(ticker);
        await snap(name);
      } catch (e) {
        clearInterval(ticker);
        rec.ms = Date.now() - started;
        rec.ok = false;
        rec.error = String(e?.message ?? e).split("\n")[0];
        await snap(`FAILED ${name}: ${rec.error}`);
        throw e;
      }
    },
    steps,
  };
  return t;
}

// ---- run
console.log(`runner: ${NAME}, ${ROUNDS} round(s), ${URL_}`);
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.__devCaptureHub?.run, { timeout: 20_000 }).catch(() => {
  console.error("the page has no next-dev-capture hub with run support: is capture installed and up to date?");
  process.exit(2);
});

// Ctrl-C: still run teardown (it may clean up test data), then close the browser
let stopping = false;
process.on("SIGINT", async () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nstopping: teardown, then exit (Ctrl-C again to quit now)");
  if (scenarioMod.teardown) await scenarioMod.teardown(makeT(0)).catch((e) => console.log(`teardown: ${e.message}`));
  await browser.close().catch(() => {});
  process.exit(130);
});
const cell = (x) => String(x ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
/** summary.md goes only into the recording folder the capture server made on this machine */
const safeDir = (dir) => typeof dir === "string" && path.isAbsolute(dir) && /[\\/]\.dev-captures[\\/]rec-[\w-]+$/.test(dir) && existsSync(dir);

const results = [];
for (let round = 1; round <= ROUNDS; round++) {
  const id = await page.evaluate((n) => window.__devCaptureHub.run.start(n), `${NAME}-r${round}`);
  const errorsBefore = pageErrors.length;
  lost = 0;
  const t = makeT(round);
  const started = Date.now();
  console.log(`round ${round}/${ROUNDS}  (${id})`);
  let ok = true;
  let error = null;
  await snap(`round ${round}: start`);
  try {
    await scenario(t);
  } catch (e) {
    ok = false;
    error = String(e?.message ?? e).split("\n")[0];
    console.log(`  FAILED: ${error}`);
  }
  await snap(`round ${round}: ${ok ? "done" : "failed"}`);
  await snapping;
  const { frames: n, dir } = await page.evaluate(() => window.__devCaptureHub?.run?.stop() ?? { frames: 0, dir: null }).catch(() => ({ frames: 0, dir: null }));
  // a recording that lost frames is not a clean pass: the top page reloaded mid-run, or saves failed
  if (lost && ok) {
    ok = false;
    error = `${lost} frame(s) not recorded: the top page reloaded mid-run or the capture server refused them`;
    console.log(`  FAILED: ${error}`);
  }
  const res = { round, ok, error, ms: Date.now() - started, frames: n, dir, steps: t.steps, pageErrors: pageErrors.slice(errorsBefore) };
  results.push(res);
  if (dir && !safeDir(dir)) console.log(`  summary.md not written: ${dir} is not a local .dev-captures recording folder`);
  if (safeDir(dir)) {
    const lines = [
      `# ${NAME}, round ${round}: ${ok ? "passed" : "FAILED"}`,
      "",
      `- **Time:** ${(res.ms / 1000).toFixed(1)} s, ${n} frames`,
      error ? `- **Failed at:** ${error}` : null,
      `- **Uncaught page errors:** ${res.pageErrors.length}`,
      "",
      "| Step | Time | Result |",
      "|---|---|---|",
      ...t.steps.map((s) => `| ${cell(s.name)} | ${(s.ms / 1000).toFixed(1)} s | ${s.ok ? "ok" : `FAILED: ${cell(s.error)}`} |`),
      "",
      ...res.pageErrors.map((e) => `- ${e.at} ${cell(e.text)}`),
    ].filter((l) => l !== null);
    try {
      writeFileSync(path.join(dir, "summary.md"), lines.join("\n") + "\n");
    } catch (e) {
      console.log(`  summary.md not written: ${e.message}`);
    }
  }
  console.log(`  ${ok ? "passed" : "FAILED"} in ${(res.ms / 1000).toFixed(1)} s, ${n} frames${dir ? `  ->  ${dir}` : ""}`);
  if (scenarioMod.between && round < ROUNDS) await scenarioMod.between(makeT(round)).catch((e) => console.log(`  between rounds: ${e.message}`));
}
if (scenarioMod.teardown) await scenarioMod.teardown(makeT(ROUNDS)).catch((e) => console.log(`teardown: ${e.message}`));
await browser.close();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} rounds passed`);
process.exit(passed === results.length ? 0 : 1);
