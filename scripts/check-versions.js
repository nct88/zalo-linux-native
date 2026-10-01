/**
 * scripts/check-versions.js
 *
 * The Zalo version to build: ZALO_VERSION if set, else the latest macOS
 * release (zalo.me redirects to its DMG). Sets process.env.ZALO_VERSION
 * for download-dmg.js and, on CI, writes zalo_version to GITHUB_OUTPUT.
 */

const fs = require('fs');
const https = require('https');
const logger = require('./utils/logger');

function latestZaloVersion() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://zalo.me/download/zalo-pc?utm=90000', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    }, (res) => {
      res.resume();
      const match = /ZaloSetup-universal-([0-9.]+)\.dmg/.exec(res.headers.location || '');
      if ((res.statusCode === 301 || res.statusCode === 302) && match) resolve(match[1]);
      else reject(new Error(`no DMG redirect (HTTP ${res.statusCode})`));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

async function main() {
  const version = (process.env.ZALO_VERSION || '').trim() || await latestZaloVersion();
  process.env.ZALO_VERSION = version;
  logger.info(`Zalo version: ${version}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `zalo_version=${version}\n`);
}

if (require.main === module) {
  main().catch((e) => { logger.error('Version check failed:', e.message); process.exit(1); });
}

module.exports = { main };
