import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
const stack = process.env.WEB_BASE_URL ? null : JSON.parse(readFileSync('.local/stack.json', 'utf8')); 
export default defineConfig({ testDir: './tests/browser', workers: 1, timeout: 45000, reporter: [['list'], ['html', { open: 'never' }]], use: { baseURL: process.env.WEB_BASE_URL || `http://127.0.0.1:${stack.webPort}`, headless: true, actionTimeout:10000, screenshot: 'only-on-failure', trace: 'off', timezoneId:'Asia/Ho_Chi_Minh', launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {} } });
