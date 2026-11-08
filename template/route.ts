/**
 * next-dev-capture (server). Local-dev only, git-excluded. Saves a capture bundle (screenshot + console lines) to
 * <repo>/.dev-captures/<time>/ so it can be read without copy and paste.
 * 404 outside development or without NEXT_PUBLIC_DEV_CAPTURE=1.
 */
import { NextRequest, NextResponse } from "next/server";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

type Line = { t: string; level: string; text: string };
type Net = {
  t: string;
  method: string;
  url: string;
  state: string;
  status: number | null;
  ms: number | null;
  error?: string;
  pendingMs?: number;
};

/** One line per request: time, state, status, duration, method, URL, error. */
function netText(net: Net[] | undefined): string {
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

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV !== "development" || process.env.NEXT_PUBLIC_DEV_CAPTURE !== "1") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => null)) as {
    recording?: string;
    frame?: number;
    reason?: string;
    url?: string;
    viewport?: string;
    lines?: Line[];
    network?: Net[];
    png?: string | null;
  } | null;
  if (!body) return NextResponse.json({ error: "bad body" }, { status: 400 });

  // Recording frame: append to .dev-captures/<recording>/ (frame-0001.png + console.txt).
  if (typeof body.recording === "string" && /^rec-[\w-]+$/.test(body.recording)) {
    const dir = path.join(process.cwd(), ".dev-captures", body.recording);
    await mkdir(dir, { recursive: true });
    const n = String(Math.max(0, Math.floor(Number(body.frame) || 0))).padStart(4, "0");
    const t = new Date().toISOString();
    const lines = Array.isArray(body.lines) ? body.lines.slice(-300) : [];
    const text =
      `----- frame ${n} at ${t} -----\n` +
      lines.map((l) => `${l.t} [${l.level}] ${l.text}`).join("\n") +
      (lines.length ? "\n" : "");
    await appendFile(path.join(dir, "console.txt"), text);
    // Paired with its image: frame-0001.png + frame-0001.txt (lines since the previous frame).
    await writeFile(path.join(dir, `frame-${n}.txt`), text);
    const net = netText(body.network);
    await writeFile(path.join(dir, `frame-${n}.net.txt`), net);
    await appendFile(path.join(dir, "network.txt"), `----- frame ${n} at ${t} -----\n${net}`);
    const m = typeof body.png === "string" ? body.png.match(/^data:image\/png;base64,(.+)$/) : null;
    if (m) await writeFile(path.join(dir, `frame-${n}.png`), Buffer.from(m[1]!, "base64"));
    return NextResponse.json({ dir, frame: n });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(process.cwd(), ".dev-captures", stamp);
  await mkdir(dir, { recursive: true });
  const lines = Array.isArray(body.lines) ? body.lines.slice(-300) : [];
  await writeFile(
    path.join(dir, "console.txt"),
    lines.map((l) => `${l.t} [${l.level}] ${l.text}`).join("\n") + "\n"
  );
  await writeFile(path.join(dir, "network.txt"), netText(body.network));
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ reason: body.reason, url: body.url, viewport: body.viewport, at: stamp }, null, 2)
  );
  const m = typeof body.png === "string" ? body.png.match(/^data:image\/png;base64,(.+)$/) : null;
  if (m) await writeFile(path.join(dir, "screenshot.png"), Buffer.from(m[1]!, "base64"));
  console.log(`[dev-capture] saved ${dir} (${body.reason ?? "?"})`);
  return NextResponse.json({ dir });
}
