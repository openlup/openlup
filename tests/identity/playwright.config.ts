import { env as processEnvironment } from "node:process";
import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
const directory = processEnvironment.OPENLUP_IDENTITY_RUN_DIR;
if (!directory) throw new Error("Identity browser acceptance requires an owned run");
const marker = JSON.parse(readFileSync(join(directory, "identity-owner.json"), "utf8"));
if (marker.runId !== processEnvironment.OPENLUP_IDENTITY_RUN_ID || marker.origin !== processEnvironment.APP_BASE_URL) throw new Error("Identity browser ownership mismatch");
export default defineConfig({
  testDir: "../preview/account", testMatch: "identity-composition.spec.ts", workers: 1, retries: 0,
  reporter: [], outputDir: join(directory, "browser-output"),
  use: { baseURL: marker.origin, trace: "off", screenshot: "off", video: "off" },
});
