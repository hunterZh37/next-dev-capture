# next-dev-capture

Local bug capture for any Next.js App Router project. Nothing is committed.

## Install

    git clone https://github.com/hunterZh37/next-dev-capture.git ~/next-dev-capture
    ~/next-dev-capture/install.sh path/to/your-next-app

Then restart `npm run dev`. Needs Next.js 15.3+ (App Router) and zsh (macOS default).

## Use

- **Cmd+Shift+L:** one screenshot plus the last 300 console lines.
- **Cmd+Shift+K:** record a frame every 2 s with the console lines for each frame. Press again to stop.
- **Network:** every capture includes `network.txt`: each request's time, status, duration and method, plus anything still **PENDING** with how long it has waited. Recordings also write `frame-0001.net.txt` per frame. Bodies and headers are never kept, and secret-looking URL values are hidden.
- **Automatic:** captures when a console line matches `AUTO_TRIGGERS` in `instrumentation-client.ts` (by default: React update-in-render warnings, uncaught errors, unhandled rejections, and two example app patterns you can replace).
- **Output:** `<project>/.dev-captures/`.

## How it stays local

- **Client:** `instrumentation-client.ts`, which Next.js runs in the browser before the app loads.
- **Server:** `app/api/dev-capture/route.ts`, which writes the files.
- **Git:** both are listed in `.git/info/exclude`, so git never sees them.
- **Off by default:** it only runs with `NODE_ENV=development` and `NEXT_PUBLIC_DEV_CAPTURE=1` in `.env.local`.

## Remove

    ~/next-dev-capture/uninstall.sh path/to/your-next-app

## Screenshots

- **Single capture:** redraws the page with html-to-image, loaded from a CDN only when you capture. Inner scroll positions may not show.
- **Recording:** asks once to share the tab and grabs real pixels from it.

## License

MIT
