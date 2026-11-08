/**
 * next-dev-capture (Vite plugin). Installed locally by ~/next-dev-capture/install.sh as dev-capture.vite.mjs,
 * git-excluded, never committed. Dev server only (apply: "serve"): a build never sees it.
 * - Adds the capture client (dev-capture.client.ts, next to this file) to the dev server's page, and fills in the
 *   env values it reads (Next.js inlines the same ones).
 * - Answers POST /__dev-capture by writing the bundle to <project>/.dev-captures/, like the Next.js route.
 *   Its own path, so an /api proxy or real /api functions are never in the way. Only this dev server's own pages
 *   may write: other sites and other host names are refused.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, "dev-capture.client.ts");
const OUT = path.join(HERE, ".dev-captures");
const ENDPOINT = "/__dev-capture";
const MAX_BODY = 40 * 1024 * 1024; // a full-page PNG as base64, with room to spare
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const IP = /^(\d{1,3}\.){3}\d{1,3}$|^\[[\da-f:.]+\]$/i;

/** One line per request: time, state, status, duration, method, URL, error. */
function netText(net) {
  if (!Array.isArray(net) || !net.length) return "(no requests)\n";
  return (
    net
      .slice(-300)
      .map((n) => {
        const state =
          n.state === "pending" ? `PENDING ${n.pendingMs ?? "?"}ms` : n.state === "failed" ? "FAILED" : "ok";
        return `${n.t} ${state.padEnd(16)} ${String(n.status ?? "-").padEnd(4)} ${String(n.ms ?? "-").padStart(6)}ms ${n.method} ${n.url}${n.error ? `  (${n.error})` : ""}`;
      })
      .join("\n") + "\n"
  );
}

const consoleText = (lines) => lines.map((l) => `${l.t} [${l.level}] ${l.text}`).join("\n");
const pngOf = (png) => (typeof png === "string" ? png.match(/^data:image\/png;base64,(.+)$/) : null);

/** Same files as the Next.js route: a capture folder, or one frame appended to a recording. */
async function save(body) {
  const lines = Array.isArray(body.lines) ? body.lines.filter((l) => l && typeof l === "object").slice(-300) : [];
  if (Array.isArray(body.network)) body.network = body.network.filter((n) => n && typeof n === "object");
  if (typeof body.recording === "string" && /^rec-[\w-]+$/.test(body.recording)) {
    const dir = path.join(OUT, body.recording);
    await mkdir(dir, { recursive: true });
    const n = String(Math.min(99999, Math.max(0, Math.floor(Number(body.frame) || 0)))).padStart(4, "0");
    const t = new Date().toISOString();
    const text = `----- frame ${n} at ${t} -----\n` + consoleText(lines) + (lines.length ? "\n" : "");
    await appendFile(path.join(dir, "console.txt"), text);
    await writeFile(path.join(dir, `frame-${n}.txt`), text);
    const net = netText(body.network);
    await writeFile(path.join(dir, `frame-${n}.net.txt`), net);
    await appendFile(path.join(dir, "network.txt"), `----- frame ${n} at ${t} -----\n${net}`);
    const m = pngOf(body.png);
    if (m) await writeFile(path.join(dir, `frame-${n}.png`), Buffer.from(m[1], "base64"));
    return { dir, frame: n };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(OUT, stamp);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "console.txt"), consoleText(lines) + "\n");
  await writeFile(path.join(dir, "network.txt"), netText(body.network));
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ reason: body.reason, url: body.url, viewport: body.viewport, at: stamp }, null, 2)
  );
  const m = pngOf(body.png);
  if (m) await writeFile(path.join(dir, "screenshot.png"), Buffer.from(m[1], "base64"));
  console.log(`[dev-capture] saved ${dir} (${body.reason ?? "?"})`);
  return { dir };
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

/** Host names this dev server answers to, as Vite 6 decides it: local names, IP addresses, server.allowedHosts. */
function hostAllowed(hostHeader, allowedHosts) {
  const host = String(hostHeader || "").replace(/:\d+$/, "").toLowerCase();
  if (!host) return false;
  if (LOCAL_HOSTS.has(host) || host.endsWith(".localhost") || IP.test(host)) return true;
  if (allowedHosts === true) return true;
  return Array.isArray(allowedHosts) && allowedHosts.some((h) => (h.startsWith(".") ? host === h.slice(1) || host.endsWith(h) : host === h));
}

export default function devCapture() {
  let base = "/";
  return {
    name: "next-dev-capture",
    apply: "serve",
    configResolved(c) {
      base = c.base || "/";
    },
    // the same three expressions Next.js inlines, filled in for the dev server
    transform(code, id) {
      if (id.split("?")[0] !== CLIENT) return null;
      return code
        .replaceAll("process.env.NODE_ENV", JSON.stringify("development"))
        .replaceAll("process.env.NEXT_PUBLIC_DEV_CAPTURE", JSON.stringify("1"))
        .replaceAll("process.env.DEV_CAPTURE_ENDPOINT", JSON.stringify(ENDPOINT));
    },
    transformIndexHtml: () => [
      {
        tag: "script",
        attrs: { type: "module", src: `${base.replace(/\/$/, "")}/@fs/${CLIENT.replace(/\\/g, "/").replace(/^\//, "")}` },
        injectTo: "head-prepend",
      },
    ],
    configureServer(server) {
      // added before Vite's own middlewares, so this answers ahead of any /api proxy
      server.middlewares.use(ENDPOINT, async (req, res) => {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        // only this server's own pages: the custom header makes another site's fetch need a preflight (never
        // granted), Sec-Fetch-Site names the caller, and the Host check stops DNS rebinding
        const site = req.headers["sec-fetch-site"];
        if (req.headers["x-dev-capture"] !== "1" || (site && site !== "same-origin") || !hostAllowed(req.headers.host, server.config.server.allowedHosts))
          return send(res, 403, { error: "not allowed" });
        const body = await readJson(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { error: "bad body" });
        try {
          send(res, 200, await save(body));
        } catch (e) {
          send(res, 500, { error: String(e?.message ?? e) });
        }
      });
    },
  };
}
