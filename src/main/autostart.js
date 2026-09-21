const { app } = require('electron');
const paths = require('./paths');
const store = require('./store');

// 绿色版自启：只写当前用户的 Run 键，不装服务、不装运行库
function isEnabled() {
  if (!app.isPackaged) return !!store.getSettings().autoStart;
  return app.getLoginItemSettings({ path: paths.exePath }).openAtLogin;
}

function setEnabled(on) {
  store.patchSettings({ autoStart: !!on });
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!on, path: paths.exePath, args: [] });
  // 写完立刻回读：管家 / 安全软件会静默把启动项挪走或改成 rem|，
  // 不回读的话界面一直显示「已开启」，而开机根本不会启动。
  store.patchSettings({ autoStart: isEnabled() });
}

module.exports = { isEnabled, setEnabled };
