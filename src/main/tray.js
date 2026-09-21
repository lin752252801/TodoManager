const { Tray, Menu, nativeImage } = require('electron');
const paths = require('./paths');

let tray = null;

function sendToWindow(getWin, channel, payload) {
  const win = getWin();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createTray(getWin, quit) {
  if (tray) return tray;
  const image = nativeImage.createFromPath(paths.iconPng);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('待办事项管理');

  const show = () => {
    const win = getWin();
    if (!win) return;
    if (!win.isVisible()) win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  };

  const menu = Menu.buildFromTemplate([
    { label: '显示待办事项', click: show },
    {
      label: '新建待办',
      click: () => {
        show();
        sendToWindow(getWin, 'tray:new');
      }
    },
    { type: 'separator' },
    {
      label: '设置',
      click: () => {
        show();
        sendToWindow(getWin, 'tray:settings');
      }
    },
    { type: 'separator' },
    { label: '退出软件', click: quit }
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => {
    const win = getWin();
    if (win && win.isVisible() && win.isFocused()) {
      win.hide();
    } else {
      show();
    }
  });
  return tray;
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, destroyTray, sendToWindow };
