import { defineConfig } from "@playwright/test";

// Isolate server-client UI checks from a developer's running desktop/Vite app.
const port = Number(process.env.ATHENA_TEST_PORT ?? 5193);
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "remote-app.spec.ts",
  outputDir: "../reports/server-browser",
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, screenshot: "only-on-failure" },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`, reuseExistingServer: false,
  },
});
