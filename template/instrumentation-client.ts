/**
 * next-dev-capture (client). Installed locally by ~/Desktop/next-dev-capture/install.sh as
 * instrumentation-client.ts, git-excluded, never committed.
 * Off unless NODE_ENV=development and NEXT_PUBLIC_DEV_CAPTURE=1.
 * - Keeps the last 300 console lines (with times).
 * - Ctrl+Shift+L (Cmd+Shift+L on Mac) saves a page screenshot + those lines to .dev-captures/<time>/ via /api/dev-capture.
 * - Cmd/Ctrl+Shift+K toggles recording: a frame every 2 s plus the console lines since the
 *   last frame, into .dev-captures/rec-<time>/ (stops by itself after 10 minutes).
 * - Also captures on its own when a watched line appears (stuck connect, React update-in-render,
 *   uncaught errors), at most once per 30 s.
 */

const ENABLED =
  process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_DEV_CAPTURE === "1";

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

type Line = { n: number; t: string; level: string; text: string };
type Net = {
  t: string;
  method: string;
  url: string;
  state: "pending" | "done" | "failed";
  status: number | null;
  ms: number | null;
  error?: string;
  changed: number;
};
const MAX_NET = 300;

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
  const w = window as unknown as { __devCaptureOn?: boolean };
  if (w.__devCaptureOn) return;
  w.__devCaptureOn = true;

  const lines: Line[] = [];
  let seq = 0;

  // Network: every fetch / XHR with method, URL (secrets hidden), status, time, and whether it is
  // still pending. No bodies or headers are kept.
  const net: Net[] = [];
  const skipNet = (url: string) => /\/api\/dev-capture|webpack-hmr|\/_next\/static|__nextjs|hot-update/.test(url);
  const track = (method: string, url: string): Net | null => {
    if (skipNet(url)) return null;
    const e: Net = { t: new Date().toISOString(), method: method.toUpperCase(), url: cleanUrl(url), state: "pending", status: null, ms: null, changed: Date.now() };
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
  const netSince = (since: number) =>
    net
      .filter((x) => x.state === "pending" || x.changed >= since)
      .map(({ changed: _c, ...rest }) => ({
        ...rest,
        ...(rest.state === "pending" ? { pendingMs: Math.round(Date.now() - Date.parse(rest.t)) } : {}),
      }));
  let busy = false;
  let lastAuto = 0;

  let lib: { toPng: (n: HTMLElement, o?: object) => Promise<string> } | null = null;
  const shoot = async (): Promise<string | null> => {
    try {
      if (!lib) {
        // Loaded at capture time in local dev only, so the app gains no dependency.
        const libUrl = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm";
        lib = (await import(/* webpackIgnore: true */ libUrl)) as typeof lib;
      }
      return await lib!.toPng(document.body, {
        pixelRatio: 1,
        skipFonts: true,
        filter: (n: Node) => !(n instanceof HTMLElement && n.dataset.devCaptureToast === "1"),
      });
    } catch (e) {
      lines.push({ n: ++seq, t: new Date().toISOString(), level: "capture", text: `screenshot failed: ${fmt(e)}` });
      return null;
    }
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
      const png = grabTab() ?? (await shoot());
      const res = await fetch("/api/dev-capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason,
          url: location.href,
          viewport: `${innerWidth}x${innerHeight}`,
          lines,
          network: netSince(0),
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
  let rec: { id: string; timer: number; started: number; sent: number; netSince: number; frame: number } | null = null;
  let recBusy = false;
  let badge: HTMLDivElement | null = null;
  const recFrame = async () => {
    if (!rec || recBusy) return;
    if (Date.now() - rec.started > REC_MAX_MS) return void stopRec("10 minute limit");
    recBusy = true;
    const r = rec;
    try {
      const fresh = lines.filter((l) => l.n > r.sent);
      r.sent = seq;
      const netFresh = netSince(r.netSince);
      r.netSince = Date.now();
      const png = grabTab() ?? (await shoot());
      r.frame += 1;
      await fetch("/api/dev-capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recording: r.id,
          frame: r.frame,
          url: location.href,
          viewport: `${innerWidth}x${innerHeight}`,
          lines: fresh,
          network: netFresh,
          png,
        }),
      });
    } catch {
      /* keep recording */
    } finally {
      recBusy = false;
    }
  };
  const startRec = async () => {
    const shared = await startTabStream();
    const id = `rec-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    rec = { id, timer: 0, started: Date.now(), sent: Math.max(0, seq - 50), netSince: Date.now() - 30_000, frame: 0 };
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
    window.clearInterval(rec.timer);
    const frames = rec.frame;
    void recFrame();
    rec = null;
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
      lines.push({ n: ++seq, t: new Date().toISOString(), level, text });
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      const hit = AUTO_TRIGGERS.find((re) => re.test(text));
      if (hit && Date.now() - lastAuto > AUTO_GAP_MS) {
        lastAuto = Date.now();
        // Let the UI settle a moment so the screenshot shows the state the line is about.
        setTimeout(() => void capture(`auto: ${text.slice(0, 80)}`), 600);
      }
    };
  }
  const onErr = (e: ErrorEvent) => console.error(`Uncaught ${e.message}`);
  const onRej = (e: PromiseRejectionEvent) => console.error(`Unhandled rejection ${fmt(e.reason)}`);
  const onKey = (e: KeyboardEvent) => {
    // Ctrl+Shift+L, or Cmd+Shift+L on a Mac.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "K" || e.key === "k")) {
      e.preventDefault();
      if (rec) stopRec();
      else void startRec();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "L" || e.key === "l")) {
      e.preventDefault();
      void capture("manual (Ctrl+Shift+L)");
    }
  };
  addEventListener("error", onErr);
  addEventListener("unhandledrejection", onRej);
  addEventListener("keydown", onKey);
  orig.info?.("[dev-capture] on: Cmd/Ctrl+Shift+L saves a screenshot + console to .dev-captures/");
}

installDevCapture();
