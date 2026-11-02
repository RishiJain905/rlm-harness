// Modelled on Web-Bench's projects/react/playwright.config.js (Apache-2.0): the same port and timeout rules.
const { defineConfig } = require('@playwright/test')

const PORT = process.env.EVAL_PROJECT_PORT || 3211

module.exports = defineConfig({
  testDir: './test',
  timeout: process.env.IS_EVAL_PRODUCTION ? 30_000 : 2_000,
  expect: { timeout: process.env.IS_EVAL_PRODUCTION ? 5_000 : 1_000 },
  fullyParallel: true,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  webServer: {
    command: 'node server.js',
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: false,
  },
})
