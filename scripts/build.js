/**
 * scripts/build.js
 *
 * Packages app/ (made by prepare-app.js) into
 *   dist/Zalo-Linux-Native-<version>-<arch>.AppImage
 * <version> is this project's (package.json). The app inside keeps Zalo's
 * own version (from app/package.json.bak): Zalo reports it to its servers.
 * electron-builder makes the AppImage; build-stage2.sh repacks it with
 * quick-sharun and embeds the update information. On CI, appimage_file,
 * appimage_name and zalo_version go to GITHUB_OUTPUT.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

const BASE_DIR = path.join(__dirname, '..');
const APP_DIR = path.join(BASE_DIR, 'app');
const DIST_DIR = path.join(BASE_DIR, 'dist');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const version = readJson(path.join(BASE_DIR, 'package.json')).version;
  const zaloVersion = readJson(path.join(APP_DIR, 'package.json.bak')).version;
  const commit = execSync('git rev-parse --short HEAD', { cwd: BASE_DIR, encoding: 'utf8' }).trim();
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const name = `Zalo-Linux-Native-${version}-${arch}.AppImage`;
  logger.info(`Building ${name} (Zalo ${zaloVersion}, commit ${commit})`);

  const mainJs = path.join(APP_DIR, 'main-dist', 'main.js');
  if (!fs.existsSync(mainJs) || !fs.readFileSync(mainJs, 'utf8').includes('ZCALL_ENGINE_JS')) {
    throw new Error('native call patch missing from app/main-dist/main.js; refusing to package');
  }
  const sqliteArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const sqlite = path.join(APP_DIR, 'native', 'nativelibs', 'sqlite3', 'binding',
    `napi-v6-linux-${sqliteArch}`, 'node_sqlite3.node');
  if (!fs.existsSync(sqlite)) {
    throw new Error('sqlite3 linux binding missing: ' + sqlite);
  }

  fs.writeFileSync(path.join(APP_DIR, 'pc-dist', 'build-info.json'),
    JSON.stringify({ version, zaloVersion, commit, buildDate: new Date().toISOString() }, null, 2));

  const stage2 = path.join(BASE_DIR, 'scripts', 'build-stage2.sh');
  execSync([
    `npx electron-builder --linux --config.linux.artifactName="${name}" -c.extraMetadata.version=${zaloVersion} --publish=never`,
    `bash "${stage2}" "${version}" "${name}" "${DIST_DIR}"`
  ].join(' && '), { cwd: BASE_DIR, stdio: 'inherit' });

  const file = path.join(DIST_DIR, name);
  if (!fs.existsSync(file)) throw new Error(`${name} not found in dist/`);
  const size = Math.round(fs.statSync(file).size / 1024 / 1024);
  const sha256 = execSync(`sha256sum "${file}"`, { encoding: 'utf8' }).split(' ')[0];
  logger.success(`Built ${name} (${size} MB)`);
  logger.dim(`SHA256: ${sha256}`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `appimage_file=dist/${name}\nappimage_name=${name}\nzalo_version=${zaloVersion}\n`);
  }
}

if (require.main === module) {
  main().catch((e) => { logger.error('Build failed:', e.message); process.exit(1); });
}

module.exports = { main };
