const fs = require('fs-extra');
const path = require('path');
let logger;
try {
  logger = require('../utils/logger');
} catch (_) {
  logger = {
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    success: (...args) => console.log('[SUCCESS]', ...args),
    dim: (...args) => console.log(' ', ...args)
  };
}

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const { useChildPreload, CHILD_PRELOAD_EXPR } = require('./patch-window-appearance');

// 1. Needles for getMaxNumChildWindow()
const ORIGINAL_NEEDLE = 'const e=this.getConfigFeature("multi_window");return e&&e.enable&&e.config.num_max_child_window?e.config.num_max_child_window:0';
const PREV_REPLACEMENT = 'const e=this.getConfigFeature("multi_window");if(e&&(e.enable===!1||0===e.enable))return 0;if(e&&e.enable&&e.config&&"number"==typeof e.config.num_max_child_window&&e.config.num_max_child_window>0)return e.config.num_max_child_window;const _tot=("undefined"!=typeof $znode&&$znode&&$znode.os&&"function"==typeof $znode.os.totalmem)?$znode.os.totalmem():("undefined"!=typeof navigator&&navigator.deviceMemory?1073741824*navigator.deviceMemory:4294967296),_gb=_tot/1073741824,_l=(e&&e.config&&e.config.limit_child_window)||("undefined"!=typeof s&&s.default&&s.default.limitChildWindow)||("undefined"!=typeof o&&o.default&&o.default.limitChildWindow)||("undefined"!=typeof r&&r.default&&r.default.limitChildWindow)||{max_1gb:0,max_2gb:2,max_4gb:4,max_8gb:8,max_16gb:12};return _gb<=1.2?(_l.max_1gb||0):_gb<=2.5?(_l.max_2gb||2):_gb<=4.5?(_l.max_4gb||4):_gb<=8.5?(_l.max_8gb||8):(_l.max_16gb||12)';

const NEW_REPLACEMENT = 'const e=this.getConfigFeature("multi_window");const _cfg=("undefined"!=typeof s&&s&&s.default)?s.default:("undefined"!=typeof o&&o&&o.default)?o.default:("undefined"!=typeof r&&r&&r.default)?r.default:null;const _en=(_cfg&&void 0!==_cfg.enable_multi_window)?_cfg.enable_multi_window:1;if(!_en||_en===0||_en===!1)return 0;if(e&&e.enable&&e.config&&"number"==typeof e.config.num_max_child_window&&e.config.num_max_child_window>0)return e.config.num_max_child_window;const _tot=("undefined"!=typeof $znode&&$znode&&$znode.os&&"function"==typeof $znode.os.totalmem)?$znode.os.totalmem():("undefined"!=typeof navigator&&navigator.deviceMemory?1073741824*navigator.deviceMemory:4294967296),_gb=_tot/1073741824,_l=(e&&e.config&&e.config.limit_child_window)||(_cfg&&_cfg.limitChildWindow)||{max_1gb:0,max_2gb:2,max_4gb:4,max_8gb:8,max_16gb:12};return _gb<=1.2?(_l.max_1gb||0):_gb<=2.5?(_l.max_2gb||2):_gb<=4.5?(_l.max_4gb||4):_gb<=8.5?(_l.max_8gb||8):(_l.max_16gb||12)';

// 2. Needles for getConfigFeature("multi_window")
const CFG_NEEDLE = 'getConfigFeature(e){return this.data_config_all_feature?this.data_config_all_feature[e]:null}';
const CFG_REPLACEMENT = 'getConfigFeature(e){let t=this.data_config_all_feature?this.data_config_all_feature[e]:null;if("multi_window"===e)return t?Object.assign({},t,{enable:!0}):{enable:!0,config:{}};return t}';

async function main() {
  const pcDistDir = path.join(APP_DIR, 'pc-dist');
  const mainDistDir = path.join(APP_DIR, 'main-dist');

  // 1. Walk and patch all JS files in pc-dist
  if (fs.existsSync(pcDistDir)) {
    const walk = (dir) => {
      let results = [];
      const list = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of list) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          results = results.concat(walk(fullPath));
        } else if (item.name.endsWith('.js')) {
          results.push(fullPath);
        }
      }
      return results;
    };

    const jsFiles = walk(pcDistDir);
    let patchedCount = 0;
    for (const filePath of jsFiles) {
      let content = fs.readFileSync(filePath, 'utf8');
      let changed = false;

      // Replace getMaxNumChildWindow logic
      if (content.includes(PREV_REPLACEMENT)) {
        content = content.replace(PREV_REPLACEMENT, NEW_REPLACEMENT);
        changed = true;
      } else if (content.includes(ORIGINAL_NEEDLE)) {
        content = content.replace(ORIGINAL_NEEDLE, NEW_REPLACEMENT);
        changed = true;
      }

      // Replace getConfigFeature logic for multi_window
      if (content.includes(CFG_NEEDLE)) {
        content = content.replace(CFG_NEEDLE, CFG_REPLACEMENT);
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(filePath, content, 'utf8');
        logger.dim(`Patched multi-window feature in ${path.relative(pcDistDir, filePath)}`);
        patchedCount++;
      }
    }
    if (patchedCount > 0) {
      logger.success(`Patched ${patchedCount} files in pc-dist for multi-window support`);
    } else {
      logger.dim('Multi-window logic already up to date in pc-dist');
    }
  }

  // 2. Patch main-dist/main.js & compact-app.js for child window transparency & frameless options
  const mainFiles = ['main.js', 'compact-app.js'].map(f => path.join(mainDistDir, f));
  for (const mainPath of mainFiles) {
    if (fs.existsSync(mainPath)) {
      let content = fs.readFileSync(mainPath, 'utf8');
      let changed = false;

      const childOptsNeedle = 't&&(this.childOpts=t,this.childOpts.modal=!0,this.childOpts.frame=!0)';
      const childOptsReplacement = 't&&(this.childOpts=t,this.childOpts.modal=!1,this.childOpts.frame=!1,this.childOpts.transparent=!0,this.childOpts.backgroundColor="#00000000",this.childOpts.hasShadow=!1,this.childOpts.titleBarStyle="hidden",this.childOpts.webPreferences=Object.assign({},(this.mainOpts&&this.mainOpts.webPreferences)||{},{preload:'+CHILD_PRELOAD_EXPR+'}))';
      if (content.includes(childOptsNeedle)) {
        content = content.replace(childOptsNeedle, childOptsReplacement);
        changed = true;
      }

      const winOpenNeedle = 'overrideBrowserWindowOptions:r(r(r({frame:!1,show:!1,titleBarStyle:"hidden",resizable:!0,transparent:!0,backgroundColor:"#00000000",hasShadow:!1},e),this.childOpts),this.childWindowSize)}}';
      const winOpenReplacement = 'overrideBrowserWindowOptions:r(r(r(r({frame:!1,show:!1,titleBarStyle:"hidden",resizable:!0,transparent:!0,backgroundColor:"#00000000",hasShadow:!1},e),this.childOpts),this.childWindowSize),{frame:!1,transparent:!0,backgroundColor:"#00000000",hasShadow:!1,titleBarStyle:"hidden",webPreferences:Object.assign({},(this.mainOpts&&this.mainOpts.webPreferences)||{},{preload:'+CHILD_PRELOAD_EXPR+'})})}}';
      if (content.includes(winOpenNeedle)) {
        content = content.replace(winOpenNeedle, winOpenReplacement);
        changed = true;
      }

      const setupWinNeedle = '_setupWindowEvent(e,t){if(f(e),e){';
      const setupWinReplacement = '_setupWindowEvent(e,t){if(f(e),e){try{e.removeMenu&&e.removeMenu();e.setMenuBarVisibility&&e.setMenuBarVisibility(!1);e.autoHideMenuBar=!0}catch(_){};e.on("maximize",(()=>{try{e.webContents.send("zalo-window-maximized",!0)}catch(_){}}));e.on("unmaximize",(()=>{try{e.webContents.send("zalo-window-maximized",!1)}catch(_){}}));';
      if (content.includes(setupWinNeedle) && !content.includes('e.removeMenu&&e.removeMenu()')) {
        content = content.replace(setupWinNeedle, setupWinReplacement);
        changed = true;
      }

      const withChildPreload = useChildPreload(content);
      if (withChildPreload !== content) {
        content = withChildPreload;
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(mainPath, content, 'utf8');
        logger.dim(`Patched child window options in ${path.basename(mainPath)}`);
      }
    }
  }

  logger.success('Multi-window patch applied successfully');
}

if (require.main === module) {
  main();
}

module.exports = { main };
