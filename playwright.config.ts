import { defineConfig } from "@playwright/test";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const baseURL = "http://127.0.0.1:3100";
const signalingURL = "http://127.0.0.1:3101";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL,
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
  },
  webServer: [
    {
      command: `${npm} run signal`,
      url: signalingURL,
      env: { NODE_ENV: "production", PORT: "3101", CLIENT_ORIGIN: baseURL },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // NEXT_PUBLIC_* is baked into the build; do not reuse an unrelated local build/server.
      command: `${npm} run build && ${npm} run start -- --hostname 127.0.0.1 --port 3100`,
      url: baseURL,
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_PUBLIC_SIGNALING_URL: signalingURL,
        METERED_DOMAIN: "",
        METERED_TURN_API_KEY: "",
        SUPABASE_URL: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        CRON_SECRET: "",
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
