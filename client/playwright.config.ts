import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "../reports/chat-browser",
  use: { baseURL: "http://127.0.0.1:5173", headless: true, screenshot: "only-on-failure" },
  webServer: { command: "npx vite --host 127.0.0.1", url: "http://127.0.0.1:5173", reuseExistingServer: !process.env.CI },
});
