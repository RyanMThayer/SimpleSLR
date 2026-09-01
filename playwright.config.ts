import { defineConfig } from "@playwright/test";

/**
 * Smoke tests against a production build. Run `npm run build` first
 * (the NEXT_PUBLIC_* variables must be available, e.g. from
 * .env.local), then `npm run test:e2e`. First time on a new machine:
 * `npx playwright install chromium`.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3106",
    // Escape hatch for environments with a preinstalled Chromium that
    // does not match this Playwright version (CI images, sandboxes).
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: "npm run start -- --port 3106",
    url: "http://localhost:3106",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
