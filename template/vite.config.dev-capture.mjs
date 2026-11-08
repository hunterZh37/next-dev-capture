// next-dev-capture: this project's own Vite config plus the capture plugin. Local only, git-excluded.
// Start the dev server with it:  npx vite --config vite.config.dev-capture.mjs
import { defineConfig, mergeConfig } from "vite";
import devCapture from "./dev-capture.vite.mjs";
import base from "./__BASE__";

export default defineConfig(async (env) => {
  const own = typeof base === "function" ? await base(env) : await base;
  return mergeConfig(own ?? {}, { plugins: [devCapture()] });
});
