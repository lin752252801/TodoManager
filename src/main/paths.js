const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// 绿色版：数据永远写在 exe 同级目录，不碰 AppData / 注册表安装项
function baseDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (!app.isPackaged) return app.getAppPath();
  return path.dirname(process.execPath);
}

const root = baseDir();
const dataDir = path.join(root, 'data');
const configDir = path.join(root, 'config');

for (const dir of [dataDir, configDir]) fs.mkdirSync(dir, { recursive: true });

// 打包后 nativeImage 读不到 asar 内部路径，resources 通过 asarUnpack 解出
const resourcesDir = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'resources')
  : path.join(app.getAppPath(), 'resources');

module.exports = {
  root,
  dataDir,
  configDir,
  resourcesDir,
  iconPng: path.join(resourcesDir, 'icons', 'tray.png'),
  todosFile: path.join(dataDir, 'todos.json'),
  settingsFile: path.join(configDir, 'settings.json'),
  exePath: process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'TodoManager.exe')
    : process.execPath
};
