/**
 * next-dev-capture (client). Installed locally by ~/next-dev-capture/install.sh, git-excluded, never committed.
 * - Next.js: as instrumentation-client.ts. Off unless NODE_ENV=development and NEXT_PUBLIC_DEV_CAPTURE=1.
 * - Vite: as dev-capture.client.ts, loaded only by the dev-capture plugin (dev server only, never in a build).
 * - Keeps the last 300 console lines (with times).
 * - Ctrl+Shift+L (Cmd+Shift+L on Mac) saves a page screenshot + those lines to .dev-captures/<time>/ via /api/dev-capture.
 * - Cmd/Ctrl+Shift+K toggles recording: a frame every 2 s plus the console lines since the
 *   last frame, into .dev-captures/rec-<time>/ (stops by itself after 10 minutes).
 * - Also captures on its own when a watched line appears (stuck connect, React update-in-render,
 *   uncaught errors), at most once per 30 s.
 * - Pages in same-origin iframes (phones on a demo stage) hand their keys and auto captures to the top page, which
 *   captures the whole tab with every frame's console and network, each line marked with its frame.
 */

// A constant at build time, so a production build drops all of this. Next.js inlines these env values; under Vite
// the dev-capture plugin replaces the same three expressions in this file (dev server only).
const ENABLED =
  process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_DEV_CAPTURE === "1";
const ENDPOINT = process.env.DEV_CAPTURE_ENDPOINT || "/api/dev-capture";

const AUTO_TRIGGERS = [
  /connect still waiting on/i,
  /Cannot update a component/i,
  /Uncaught|Unhandled/i,
  /token request timed out/i,
];
const MAX_LINES = 300;
const REC_EVERY_MS = 2000;
const REC_MAX_MS = 10 * 60_000;
const AUTO_GAP_MS = 30_000;

type Line = { n: number; ms: number; t: string; level: string; text: string };
type Net = {
  t: string;
  at: number;
  method: string;
  url: string;
  state: "pending" | "done" | "failed";
  status: number | null;
  ms: number | null;
  error?: string;
  changed: number;
};
const MAX_NET = 300;

type SentNet = Omit<Net, "changed"> & { pendingMs?: number };
/** What each page's capture shares with the top page (same origin only). */
type FrameState = {
  label: string;
  lines: () => Line[];
  netSince: (since: number) => SentNet[];
  shoot?: () => Promise<string | null>;
  /** a kept copy's original lines, so a recording does not send them twice */
  from?: Line[];
};
/** The top page's capture, which frames hand their keys and auto captures to. */
type Hub = {
  key: (k: "k" | "l") => void;
  auto: (reason: string) => void;
  /** a frame about to unload hands over what it logged, so a crash right before a reload is not lost */
  keep: (st: FrameState) => void;
  /**
   * For a test runner driving the browser (Puppeteer and the like): a recording whose frames it sends itself, each
   * with its own screenshot (real pixels from the browser) and a step name, paired with the console and network
   * lines since the previous frame.
   */
  run?: {
    start: (name?: string) => string;
    frame: (png: string | null, step?: string) => Promise<{ frame: string } | null>;
    stop: () => Promise<{ frames: number; dir: string | null }>;
  };
};
/** Per page, the last line number already sent in a recording. */
type Cursor = WeakMap<Line[], number>;
type CaptureWindow = Window & { __devCaptureOn?: boolean; __devCaptureState?: FrameState; __devCaptureHub?: Hub };

/** This page's name in a merged capture: the iframe's data-capture-label, title or name, else its address. */
function frameLabel(): string {
  try {
    const fe = window.frameElement as HTMLElement | null;
    if (fe) return fe.dataset.captureLabel || fe.title || fe.getAttribute("name") || `${location.pathname}${location.search}${location.hash}`;
  } catch {
    /* cross-origin parent */
  }
  return "page";
}

/** Every same-origin page in this tab that runs capture: this one, then its frames, depth first. */
function allFrames(): FrameState[] {
  const out: FrameState[] = [];
  const walk = (win: Window, depth: number) => {
    try {
      const st = (win as CaptureWindow).__devCaptureState;
      if (st) out.push(st);
    } catch {
      /* another origin: its console stays its own */
    }
    if (depth < 4) for (let i = 0; i < win.frames.length; i++) walk(win.frames[i]!, depth + 1);
  };
  walk(window, 0);
  return out;
}

/** Same-origin URLs as path + query; secret-looking query values hidden; long URLs cut. */
function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw, location.href);
    for (const k of [...u.searchParams.keys()]) {
      if (/token|key|secret|sig|signature|auth|password|code|session/i.test(k)) u.searchParams.set(k, "…");
    }
    const s = u.origin === location.origin ? `${u.pathname}${u.search}` : `${u.origin}${u.pathname}${u.search}`;
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return String(raw).slice(0, 200);
  }
}

function fmt(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
  try {
    const s = JSON.stringify(arg);
    return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
  } catch {
    return String(arg);
  }
}

function installDevCapture() {
  if (!ENABLED || typeof window === "undefined") return;
  const w = window as CaptureWindow;
  if (w.__devCaptureOn) return;
  w.__devCaptureOn = true;

  const lines: Line[] = [];
  let seq = 0;

  // Network: every fetch / XHR with method, URL (secrets hidden), status, time, and whether it is
  // still pending. No bodies or headers are kept.
  const net: Net[] = [];
  const skipNet = (url: string) => /\/api\/dev-capture|\/__dev-capture|webpack-hmr|\/_next\/static|__nextjs|hot-update|\/@vite\/|\/@id\/|\/@fs\/|\.vite\/deps|__vite/.test(url);
  const track = (method: string, url: string): Net | null => {
    if (skipNet(url)) return null;
    const e: Net = { t: new Date().toISOString(), at: Date.now(), method: method.toUpperCase(), url: cleanUrl(url), state: "pending", status: null, ms: null, changed: Date.now() };
    net.push(e);
    if (net.length > MAX_NET) {
      // Drop the oldest finished entries first; keep anything still pending.
      const i = net.findIndex((x) => x.state !== "pending");
      net.splice(i >= 0 ? i : 0, 1);
    }
    return e;
  };
  const finish = (e: Net | null, started: number, status: number | null, error?: string) => {
    if (!e) return;
    e.ms = Math.round(performance.now() - started);
    e.status = status;
    e.state = error ? "failed" : "done";
    if (error) e.error = error;
    e.changed = Date.now();
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const e = track(method, url);
    const t0 = performance.now();
    try {
      const res = await origFetch(input, init);
      finish(e, t0, res.status, res.ok ? undefined : `HTTP ${res.status}`);
      return res;
    } catch (err) {
      finish(e, t0, null, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      throw err;
    }
  };
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __dc?: { m: string; u: string } }, m: string, u: string | URL, ...rest: unknown[]) {
    this.__dc = { m, u: String(u) };
    return (XO as (...a: unknown[]) => void).call(this, m, u, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __dc?: { m: string; u: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
    const e = this.__dc ? track(this.__dc.m, this.__dc.u) : null;
    const t0 = performance.now();
    this.addEventListener("loadend", () =>
      finish(e, t0, this.status || null, this.status === 0 ? "network error or aborted" : this.status >= 400 ? `HTTP ${this.status}` : undefined)
    );
    return XS.call(this, body);
  };
  /** Requests changed since `since` (ms) plus everything still pending, oldest first. */
  const netSince = (since: number): SentNet[] =>
    net
      .filter((x) => x.state === "pending" || x.changed >= since)
      .map(({ changed: _c, ...rest }) => ({
        ...rest,
        ...(rest.state === "pending" ? { pendingMs: Math.round(Date.now() - Date.parse(rest.t)) } : {}),
      }));
  w.__devCaptureState = { label: frameLabel(), lines: () => lines, netSince, shoot: () => shoot() };
  // pages that unloaded while this tab was open (top page only): their last lines, kept for the next capture
  const gone: FrameState[] = [];

  // In a frame whose top page runs capture too: that page captures for the whole tab
  const hub = (): Hub | null => {
    try {
      return window.top && window.top !== window ? ((window.top as CaptureWindow).__devCaptureHub ?? null) : null;
    } catch {
      return null;
    }
  };
  /** Every page whose lines belong in a capture: the live ones, then those that unloaded. */
  const sources = (): FrameState[] => [...allFrames(), ...gone];
  // marked by page whenever this page has frames, so one capture never mixes marked and unmarked lines
  const many = () => window.frames.length > 0 || gone.length > 0;
  const mark = (f: FrameState, text: string) => (many() ? `[${f.label}] ${text}` : text);
  /**
   * Console lines of every page in the tab, oldest first. With a cursor: only lines not sent yet, and the cursor
   * moves past them (by each page's own line number, so two lines in the same millisecond are never lost).
   */
  const tabLines = (cursor?: Cursor): Line[] =>
    sources()
      .flatMap((f) => {
        const all = f.lines();
        const after = cursor?.get(all) ?? 0;
        const fresh = all.filter((l) => l.n > after);
        if (cursor && all.length) cursor.set(all, all[all.length - 1]!.n);
        return fresh.map((l) => ({ ...l, text: mark(f, l.text) }));
      })
      .sort((a, b) => a.ms - b.ms);
  /** Requests of every page, oldest first; past the cap, finished ones go first so a stuck request stays. */
  const tabNet = (since: number): SentNet[] => {
    const all = sources()
      .flatMap((f) => f.netSince(since).map((n) => ({ ...n, url: mark(f, n.url) })))
      .sort((a, b) => a.at - b.at);
    let extra = all.length - MAX_NET;
    return extra <= 0 ? all : all.filter((n) => n.state === "pending" || extra-- <= 0);
  };
  let busy = false;
  let lastAuto = 0;
  let lastManual = 0;

  let lib: { toPng: (n: HTMLElement, o?: object) => Promise<string> } | null = null;
  const shoot = async (skipFrames = false): Promise<string | null> => {
    try {
      if (!lib) {
        // Loaded at capture time in local dev only, so the app gains no dependency.
        const libUrl = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm";
        lib = (await import(/* webpackIgnore: true */ /* @vite-ignore */ libUrl)) as typeof lib;
      }
      return await lib!.toPng(document.body, {
        pixelRatio: 1,
        skipFonts: true,
        filter: (n: Node) =>
          !(n instanceof HTMLElement && n.dataset.devCaptureToast === "1") && !(skipFrames && n instanceof HTMLIFrameElement),
      });
    } catch (e) {
      lines.push({ n: ++seq, ms: Date.now(), t: new Date().toISOString(), level: "capture", text: `screenshot failed: ${fmt(e)}` });
      return null;
    }
  };

  /**
   * The page with each same-origin frame drawn by that frame's own capture, at its place on the page. Redrawing the
   * whole page at once draws frames wrongly (sized and placed as the outer page, overlapping).
   */
  const shootTab = async (): Promise<string | null> => {
    const iframes = [...document.querySelectorAll("iframe")];
    if (!iframes.length) return shoot();
    const load = (src: string) =>
      new Promise<HTMLImageElement | null>((ok) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = () => ok(null);
        img.src = src;
      });
    const base = await shoot(true);
    const page = base ? await load(base) : null;
    if (!page) return base;
    const c = document.createElement("canvas");
    c.width = page.width;
    c.height = page.height;
    const g = c.getContext("2d");
    if (!g) return base;
    g.drawImage(page, 0, 0);
    const origin = document.body.getBoundingClientRect();
    for (const fe of iframes) {
      let st: FrameState | undefined;
      try {
        st = (fe.contentWindow as CaptureWindow | null)?.__devCaptureState;
      } catch {
        continue; // another origin: left as the blank box the page drew
      }
      const shot = st?.shoot ? await st.shoot() : null;
      const img = shot ? await load(shot) : null;
      if (!img) continue;
      const r = fe.getBoundingClientRect();
      const x = r.left - origin.left + fe.clientLeft;
      const y = r.top - origin.top + fe.clientTop;
      // the frame's visible box at 1:1, cropped like the frame itself crops its page
      g.drawImage(img, 0, 0, fe.clientWidth, fe.clientHeight, x, y, fe.clientWidth, fe.clientHeight);
    }
    return c.toDataURL("image/png");
  };

  // Real pixels of this tab (scroll position, images exactly as seen). Asked once per
  // recording via the browser's share picker; html-to-image redraws the DOM and lost the chat's
  // scroll position (every frame showed the top of the chat) and mixed up partner photos.
  let tabStream: MediaStream | null = null;
  let tabVideo: HTMLVideoElement | null = null;
  const startTabStream = async (): Promise<boolean> => {
    try {
      const md = navigator.mediaDevices as MediaDevices & {
        getDisplayMedia: (o: object) => Promise<MediaStream>;
      };
      tabStream = await md.getDisplayMedia({
        video: { displaySurface: "browser", frameRate: 2 },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
      });
      tabVideo = document.createElement("video");
      tabVideo.muted = true;
      tabVideo.srcObject = tabStream;
      await tabVideo.play();
      tabStream.getVideoTracks()[0]?.addEventListener("ended", () => stopRec("share ended"));
      return true;
    } catch {
      tabStream = null;
      tabVideo = null;
      return false;
    }
  };
  const stopTabStream = () => {
    tabStream?.getTracks().forEach((t) => t.stop());
    tabStream = null;
    tabVideo = null;
  };
  const grabTab = (): string | null => {
    const v = tabVideo;
    if (!v || !v.videoWidth) return null;
    const c = document.createElement("canvas");
    const scale = Math.min(1, 1600 / v.videoWidth);
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  };

  const capture = async (reason: string) => {
    if (busy) return;
    busy = true;
    try {
      const png = grabTab() ?? (await shootTab());
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dev-Capture": "1" },
        body: JSON.stringify({
          reason,
          url: location.href,
          viewport: `${innerWidth}x${innerHeight}`,
          lines: tabLines().slice(-MAX_LINES),
          network: tabNet(0),
          png,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { dir?: string };
      toast(j.dir ? `Captured: ${reason}` : "Capture failed");
    } finally {
      busy = false;
    }
  };

  // Recording: a frame every 2 s with the console lines since the previous frame.
  type Rec = { id: string; timer: number; started: number; cursor: Cursor; first: boolean; netSince: number; frame: number; external?: boolean; dir?: string };
  let rec: Rec | null = null;
  let starting = false;
  let recBusy = false;
  let badge: HTMLDivElement | null = null;
  /** One frame of a recording. The last one (on stop) waits for a frame still saving, so the final lines arrive. */
  const recFrame = async (r: Rec | null = rec, last = false, given?: { png: string | null }): Promise<string | null> => {
    if (!r) return null;
    // the last frame, and every frame a runner sends, waits its turn instead of being skipped
    if (last || given) for (let i = 0; recBusy && i < 400; i++) await new Promise((ok) => setTimeout(ok, 50));
    else if (recBusy) return null;
    if (!last && !r.external && Date.now() - r.started > REC_MAX_MS) {
      stopRec("10 minute limit");
      return null;
    }
    recBusy = true;
    try {
      const now = Date.now();
      // the first frame carries the last 50 lines from before the recording, as on a single page before
      const fresh = tabLines(r.cursor).slice(r.first ? -50 : -MAX_LINES);
      r.first = false;
      const netFresh = tabNet(r.netSince);
      r.netSince = now;
      const png = given ? given.png : grabTab() ?? (await shootTab());
      const n = r.frame + 1;
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dev-Capture": "1" },
        body: JSON.stringify({
          recording: r.id,
          frame: n,
          url: location.href,
          viewport: `${innerWidth}x${innerHeight}`,
          lines: fresh,
          network: netFresh,
          png,
        }),
      });
      if (!res.ok) return null;
      r.frame = n; // a frame counts once the server has it
      r.dir ??= ((await res.json().catch(() => ({}))) as { dir?: string }).dir;
      return String(n).padStart(4, "0");
    } catch {
      return null; // keep recording
    } finally {
      recBusy = false;
    }
  };
  const startRec = async () => {
    // a second press while the share picker is open must not start a second recording
    if (starting || rec) return;
    starting = true;
    let shared = false;
    try {
      shared = await startTabStream();
    } finally {
      starting = false;
    }
    const id = `rec-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    rec = { id, timer: 0, started: Date.now(), cursor: new WeakMap(), first: true, netSince: Date.now() - 30_000, frame: 0 };
    rec.timer = window.setInterval(() => void recFrame(), REC_EVERY_MS);
    void recFrame();
    badge = document.createElement("div");
    badge.dataset.devCaptureToast = "1";
    badge.textContent = "● REC";
    badge.style.cssText =
      "position:fixed;top:10px;right:10px;z-index:2147483647;background:#dc2626;color:#fff;padding:4px 8px;border-radius:6px;font:600 11px system-ui;opacity:.9";
    document.body.appendChild(badge);
    toast(
      shared
        ? "Recording this tab: Cmd+Shift+K to stop"
        : "Recording (page redraw, share was declined): Cmd+Shift+K to stop"
    );
  };
  const stopRec = (why = "stopped") => {
    if (!rec) return;
    const r = rec;
    window.clearInterval(r.timer);
    rec = null;
    void recFrame(r, true);
    const frames = r.frame + 1;
    window.setTimeout(stopTabStream, 1500);
    badge?.remove();
    badge = null;
    toast(`Recording ${why}: ${frames} frames`);
  };

  const toast = (msg: string) => {
    const el = document.createElement("div");
    el.dataset.devCaptureToast = "1";
    el.textContent = msg;
    el.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#1f2937;color:#fff;padding:8px 12px;border-radius:8px;font:12px system-ui;opacity:.92";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  };

  const levels = ["log", "info", "warn", "error", "debug"] as const;
  const orig: Partial<Record<(typeof levels)[number], (...a: unknown[]) => void>> = {};
  for (const level of levels) {
    orig[level] = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig[level]!(...args);
      const text = args.map(fmt).join(" ");
      lines.push({ n: ++seq, ms: Date.now(), t: new Date().toISOString(), level, text });
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      const hit = AUTO_TRIGGERS.find((re) => re.test(text));
      if (hit && Date.now() - lastAuto > AUTO_GAP_MS) {
        lastAuto = Date.now();
        // Let the UI settle a moment so the screenshot shows the state the line is about.
        const reason = `auto: ${hub() ? `[${w.__devCaptureState?.label}] ` : ""}${text.slice(0, 80)}`;
        setTimeout(() => {
          const h = hub();
          if (h) h.auto(reason);
          else void capture(reason);
        }, 600);
      }
    };
  }
  // Chrome already starts the message with "Uncaught"; add it only where the browser does not.
  const onErr = (e: ErrorEvent) => console.error(/^Uncaught/.test(e.message) ? e.message : `Uncaught ${e.message}`);
  const onRej = (e: PromiseRejectionEvent) => console.error(`Unhandled rejection ${fmt(e.reason)}`);
  const handleKey = (k: "k" | "l") => {
    if (k === "k") {
      if (starting) return;
      if (rec?.external) return void toast("A test run is recording");
      if (rec) stopRec();
      else void startRec();
    } else {
      // presses within a second are one capture (a quick save would otherwise take one per press)
      if (Date.now() - lastManual < 1000) return;
      lastManual = Date.now();
      void capture("manual (Ctrl+Shift+L)");
    }
  };
  const onKey = (e: KeyboardEvent) => {
    // Cmd/Ctrl+Shift+K records, Cmd/Ctrl+Shift+L captures once
    if (!((e.ctrlKey || e.metaKey) && e.shiftKey)) return;
    const k = e.key.toLowerCase();
    if (k !== "k" && k !== "l") return;
    e.preventDefault();
    if (e.repeat) return; // a held key is one press
    // a page in a frame hands the key to the top page, which captures the whole tab
    const h = hub();
    if (h) h.key(k);
    else handleKey(k);
  };
  if (window.top === window) {
    w.__devCaptureHub = {
      key: handleKey,
      // one auto capture for the whole tab at a time, whichever frame saw the line
      auto: (reason) => {
        // only a capture that actually starts holds the next one off
        if (busy || Date.now() - lastAuto < AUTO_GAP_MS) return;
        lastAuto = Date.now();
        void capture(reason);
      },
      run: {
        start: (name) => {
          if (rec) stopRec("replaced by a test run");
          const slug = String(name ?? "run").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "run";
          const id = `rec-${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}`;
          rec = { id, timer: 0, started: Date.now(), cursor: new WeakMap(), first: true, netSince: Date.now() - 30_000, frame: 0, external: true };
          return id;
        },
        frame: async (png, step) => {
          const r = rec;
          if (!r?.external) return null;
          // the step name goes in this frame's console lines, so each picture reads with what was being done
          if (step) lines.push({ n: ++seq, ms: Date.now(), t: new Date().toISOString(), level: "step", text: step });
          const frame = await recFrame(r, false, { png });
          return frame ? { frame } : null;
        },
        stop: async () => {
          const r = rec;
          if (!r?.external) return { frames: 0, dir: null };
          for (let i = 0; recBusy && i < 400; i++) await new Promise((ok) => setTimeout(ok, 50));
          rec = null;
          return { frames: r.frame, dir: r.dir ?? null };
        },
      },
      keep: (st) => {
        if (rec && st.from) rec.cursor.set(st.lines(), rec.cursor.get(st.from) ?? 0);
        gone.push(st);
        if (gone.length > 6) gone.shift();
      },
    };
  }
  // a frame that unloads (reload, navigation) leaves its last lines with the top page
  addEventListener("pagehide", () => {
    const h = hub();
    if (!h) return;
    const kept = lines.slice(-100);
    // a request still open when the page leaves never finishes: say so, rather than showing it pending forever
    const left = Date.now();
    const keptNet = netSince(0).map((n) =>
      n.state === "pending" ? { ...n, state: "failed" as const, error: "page left before it finished", pendingMs: undefined, leftAt: left } : { ...n, leftAt: 0 }
    );
    h.keep({
      label: `${w.__devCaptureState?.label ?? "frame"} (before reload)`,
      lines: () => kept,
      from: lines,
      // a request cut off by the page leaving shows in the next frame (stamped when the page left), then not again
      netSince: (since) => keptNet.filter((n) => (n.leftAt ? n.leftAt >= since : Date.parse(n.t) >= since)).map(({ leftAt: _l, ...n }) => n),
    });
  });
  addEventListener("error", onErr);
  addEventListener("unhandledrejection", onRej);
  addEventListener("keydown", onKey);
  orig.info?.("[dev-capture] on: Cmd/Ctrl+Shift+L saves a screenshot + console to .dev-captures/");
}

installDevCapture();
