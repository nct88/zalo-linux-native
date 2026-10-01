/**
 * scripts/main.js
 *
 * The whole pipeline: SETUP=true prepares app/ (Zalo version, its macOS
 * DMG, extraction and patches), BUILD=true packages it into an AppImage.
 * npm run main does both.
 */

const logger = require('./utils/logger.js');

async function main() {
  try {
    if (process.env.SETUP === 'true') {
      logger.step('Step 1: Zalo version');
      await require('./check-versions.js').main();
      logger.step('Step 2: Downloading the Zalo DMG');
      await require('./download-dmg.js').main();
      logger.step('Step 3: Preparing the app (extract + patches)');
      await require('./prepare-app.js').main();
    }
    if (process.env.BUILD === 'true') {
      logger.step('Step 4: Building the AppImage');
      await require('./build.js').main();
    }
  } catch (error) {
    logger.error('Workflow failed:', error.message);
    process.exit(1);
  }
}

main();
