// next-dev-capture: Vite's defaults plus the capture plugin (this project has no vite.config). Local only, git-excluded.
// Start the dev server with it:  npx vite --config vite.config.dev-capture.mjs
import { defineConfig } from "vite";
import devCapture from "./dev-capture.vite.mjs";

export default defineConfig({ plugins: [devCapture()] });
