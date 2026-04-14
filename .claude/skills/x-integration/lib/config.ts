/**
 * X Integration - Configuration
 *
 * All environment-specific settings in one place.
 * Override via environment variables or modify defaults here.
 */

import path from 'path';

// Project root - can be overridden for different deployments
const PROJECT_ROOT = process.env.NANOCLAW_ROOT || process.cwd();

/**
 * Configuration object with all settings
 */
export const config = {
  // Chrome executable path — override via CHROME_PATH env var.
  // Default: Windows standard path (macOS/Linux should set CHROME_PATH).
  chromePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',

  // Browser profile directory for persistent login sessions
  browserDataDir: path.join(PROJECT_ROOT, 'data', 'x-browser-profile'),

  // Auth state marker file
  authPath: path.join(PROJECT_ROOT, 'data', 'x-auth.json'),

  // Browser viewport settings
  viewport: {
    width: 1280,
    height: 800,
  },

  // Timeouts (in milliseconds)
  timeouts: {
    navigation: 30000,
    elementWait: 5000,
    afterClick: 1000,
    afterFill: 1000,
    afterSubmit: 3000,
    pageLoad: 3000,
  },

  // X character limits
  limits: {
    tweetMaxLength: 280,
  },

  // Chrome launch arguments
  chromeArgs: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    // --no-sandbox and --disable-setuid-sandbox are Linux-only;
    // on Windows they cause Chrome to crash in headless mode.
  ],

  // Args to ignore when launching Chrome
  chromeIgnoreDefaultArgs: ['--enable-automation'],
};

