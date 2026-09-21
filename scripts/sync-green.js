// 把 dist/win-unpacked 同步成绿色目录 dist/TodoManager，然后删掉中间产物。
// 用户自己的 config/ 和 data/ 必须跳过，否则会把他的待办和窗口状态覆盖掉。
// 用 /MIR 而不是 /E：少了清理步骤，被裁掉的资源（比如多语言 .pak）会一直留在旧目录里。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'dist', 'win-unpacked');
const dst = path.join(root, 'dist', 'TodoManager');
const exe = path.join(dst, 'TodoManager.exe');

if (!fs.existsSync(src)) {
  console.error('缺少 ' + src + '，先跑 electron-builder --win --dir');
  process.exit(1);
}

// 正在运行的 exe 锁着文件，robocopy 会失败，先给出明确提示
const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq TodoManager.exe', '/NH'], { encoding: 'utf8' });
if (/TodoManager\.exe/i.test(running.stdout || '')) {
  console.error('TodoManager.exe 正在运行，请先从托盘菜单「退出软件」再同步。');
  process.exit(1);
}

const r = spawnSync(
  'robocopy',
  [src, dst, '/MIR', '/XD', 'config', 'data', '/XF', 'sync.log', '/NFL', '/NDL', '/NJH', '/NP'],
  { stdio: 'inherit' }
);
// robocopy：0~7 都算成功
if (r.status === null || r.status > 7) {
  console.error('同步失败，robocopy 退出码 ' + r.status);
  process.exit(1);
}

fs.rmSync(src, { recursive: true, force: true });
const yml = path.join(root, 'dist', 'builder-debug.yml');
fs.rmSync(yml, { force: true });

const size = (p) => {
  let sum = 0;
  for (const f of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, f.name);
    sum += f.isDirectory() ? size(fp) : fs.statSync(fp).size;
  }
  return sum;
};
console.log(
  '已同步到 ' + dst + '（' + (size(dst) / 1048576).toFixed(0) + ' MB），exe ' +
  (fs.existsSync(exe) ? '就绪' : '缺失！')
);
