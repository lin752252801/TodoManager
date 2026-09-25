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

// 建目录这步在模块加载期执行，原来是一句裸的 mkdirSync：目录建不出来主进程会当场抛异常
// 静默退出，用户连个提示都看不到。绿色版恰恰最容易踩到——整个文件夹被放进
// C:\Program Files（普通用户无写权限）、放在只读介质/只读共享盘、被 Defender 的
// 「受控文件夹访问」拦住、或者被同步盘锁着。
//
// 判断「真的能写」不能只看 mkdirSync：对已经存在的只读目录它不报错；
// fs.accessSync(W_OK) 在 Windows 上对目录也不可靠。只有真的写一个文件再删掉才算数。
function canWrite(dir) {
  const probe = path.join(dir, '.write-probe');
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir, fallbackName) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (canWrite(dir)) return dir;
    console.error(`[paths] 目录不可写：${dir}`);
  } catch (err) {
    console.error(`[paths] 无法创建目录：${dir}`, err);
  }
  // 退到 userData：位置变了总比整个软件起不来强，界面里也照常显示实际生效的目录
  const fb = path.join(app.getPath('userData'), fallbackName);
  try {
    fs.mkdirSync(fb, { recursive: true });
    console.error(`[paths] 已改用回退目录：${fb}`);
    return fb;
  } catch (fbErr) {
    console.error(`[paths] 回退目录同样不可写：${fb}`, fbErr);
    throw fbErr;
  }
}

const dataDir = ensureDir(path.join(root, 'data'), 'data');
const configDir = ensureDir(path.join(root, 'config'), 'config');

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
  // exe 名不写死：build.productName 改过几次（TodoManager → 待办事项管理 → TodoManager），
  // 写死的话绿色版把 exe 放进 PORTABLE_EXECUTABLE_DIR 之后，开机自启会指到一个不存在的文件。
  // 直接拿当前进程的 exe 文件名，永远和实际产物一致。
  exePath: process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, path.basename(process.execPath))
    : process.execPath
};
