import { defineConfig } from '@playwright/test';
import { config } from 'dotenv';
config({ quiet: true });
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: 'list',
});
