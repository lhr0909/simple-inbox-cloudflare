import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env['CI']),
  fullyParallel: false,
  outputDir: 'test-results',
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { height: 900, width: 1_440 } },
    },
    {
      name: 'tablet-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { height: 820, width: 900 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { height: 844, width: 390 } },
    },
  ],
  reporter: process.env['CI'] ? [['line']] : [['list']],
  retries: process.env['CI'] ? 1 : 0,
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  timeout: 60_000,
  workers: 1,
})
