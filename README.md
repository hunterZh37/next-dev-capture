# next-dev-capture

Local bug capture for any Next.js App Router or Vite project (Vue, React, Svelte, plain). Nothing is committed.

## Install

    git clone https://github.com/hunterZh37/next-dev-capture.git ~/next-dev-capture
    ~/next-dev-capture/install.sh path/to/your-next-app

The installer detects the framework from `package.json`. Needs zsh (macOS default).

- **Next.js** (15.3+, App Router): restart `npm run dev`.
- **Vite** (5+): start the dev server with the capture config, plus your usual flags:

      npx vite --config vite.config.dev-capture.mjs

  Plain `npm run dev` stays exactly as before, so capture is on only when you ask for it.

## Use

- **Cmd+Shift+L:** one screenshot plus the last 300 console lines.
- **Cmd+Shift+K:** record a frame every 2 s with the console lines for each frame. Press again to stop.
- **Network:** every capture includes `network.txt`: each request's time, status, duration and method, plus anything still **PENDING** with how long it has waited. Recordings also write `frame-0001.net.txt` per frame. Bodies and headers are never kept, and secret-looking URL values are hidden.
- **Automatic:** captures when a console line matches `AUTO_TRIGGERS` in `instrumentation-client.ts` (by default: React update-in-render warnings, uncaught errors, unhandled rejections, and two example app patterns you can replace).
- **Output:** `<project>/.dev-captures/`.
- **Iframes:** pages in same-origin iframes (phones on a demo stage, a dashboard) hand the keys to the top page. One capture or recording then holds the whole tab, with every frame's console and network lines marked `[frame title]`. Name a frame with `title` or `data-capture-label`.

## Scenario runner

Drives the app in Chrome from a script and records it frame by frame. Each frame is a real screenshot of the browser,
named after the step being run, with the console and network lines of every page in the tab since the frame before.

    npm install --prefix ~/next-dev-capture/runner          # once: puppeteer-core, uses your installed Chrome
    node ~/next-dev-capture/runner/run.mjs --url http://localhost:5173/ --scenario my.scenario.mjs --rounds 3

- **Options:** `--rounds N`, `--every MS` (extra frames while a step runs, default 1000), `--width`/`--height`, `--headful`.
- **Output:** `.dev-captures/rec-<time>-<name>-r<round>/`: `frame-0001.png` + `.txt` (console) + `.net.txt` (network), and `summary.md` (every step, its time, and where it failed).
- **Exit code:** 0 when every round passed, 1 otherwise.

A scenario is a module whose default export gets `t`:

```js
export const name = 'checkout'
export default async function (t) {
  await t.step('Phone A: join', async () => {
    const f = await t.frame('Phone A')          // an iframe by its title (or t.page.mainFrame())
    await t.type(f, '#name', 'Ava')               // CSS selectors start with # . [ or css=
    await t.click(f, 'Join')                      // anything else is visible text; waits until enabled
    await t.waitText(f, "You're in")
  })
}
export async function teardown(t) {}             // optional, after the last round (also: setup, between)
```

Also: `t.waitUrl(f, /re/)`, `t.find(f, target)`, `t.stripeCard(f)` (Stripe test card into a nested Stripe iframe), `t.snap(name)`, `t.wait(ms)`, `t.page` (Puppeteer).

## How it stays local

**Next.js**
- **Client:** `instrumentation-client.ts`, which Next.js runs in the browser before the app loads.
- **Server:** `app/api/dev-capture/route.ts`, which writes the files.
- **Off by default:** it only runs with `NODE_ENV=development` and `NEXT_PUBLIC_DEV_CAPTURE=1` in `.env.local`.

**Vite**
- **Config:** `vite.config.dev-capture.mjs` loads your own `vite.config.*` and adds one plugin. Your config is not edited.
- **Plugin:** `dev-capture.vite.mjs` runs on the dev server only (`apply: "serve"`), so builds never include it.
- **Client:** `dev-capture.client.ts` (the same file as the Next.js client), added to the page by the plugin.
- **Server:** the plugin answers `POST /__dev-capture`, its own path, so an `/api` proxy or real `/api` functions are never in the way. It only accepts writes from the dev server's own pages, so other sites and other host names are refused.

**Both**
- **Git:** every added file is listed in `.git/info/exclude`, so git never sees them.

## Remove

    ~/next-dev-capture/uninstall.sh path/to/your-next-app

## Screenshots

- **Single capture:** redraws the page with html-to-image, loaded from a CDN only when you capture. Inner scroll positions may not show.
- **Recording:** asks once to share the tab and grabs real pixels from it.

## License

MIT
