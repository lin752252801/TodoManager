// 把 dist/win-unpacked 同步成绿色目录 dist/TodoManager，然后删掉中间产物。
// 用户自己的 config/ 和 data/ 必须跳过，否则会把他的待办和窗口状态覆盖掉。
// 用 /MIR 而不是 /E：少了清理步骤，被裁掉的资源（比如多语言 .pak）会一直留在旧目录里。
//
// exe 名跟 package.json 的 build.productName 是一体的：productName 决定 exe 文件名。
// 改名之后如果这里还写死旧名，就既找不到文件、也检测不到「正在运行」。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const EXE = 'TodoManager.exe';

// 正在运行的 exe 锁着文件，robocopy 会失败，先给出明确提示。
// 用「能不能以可写方式打开」判断，而不是 tasklist：中文 exe 名经 tasklist 输出
// 会过一遍控制台代码页，字符串比对容易失配。
function isLocked(p) {
  if (!fs.existsSync(p)) return false;
  try {
    const fd = fs.openSync(p, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
  }
}

function dirSize(p) {
  let sum = 0;
  for (const f of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, f.name);
    sum += f.isDirectory() ? dirSize(fp) : fs.statSync(fp).size;
  }
  return sum;
}

function syncGreen() {
  const src = path.join(root, 'dist', 'win-unpacked');
  const dst = path.join(root, 'dist', 'TodoManager');
  const exe = path.join(dst, EXE);

  if (!fs.existsSync(src)) {
    console.error('缺少 ' + src + '，先跑 electron-builder --win --dir');
    return 1;
  }
  if (isLocked(exe)) {
    console.error(EXE + ' 正在运行，请先从托盘菜单「退出软件」再同步。');
    return 1;
  }

  const r = spawnSync(
    'robocopy',
    [src, dst, '/MIR', '/XD', 'config', 'data', '/XF', 'sync.log', '/NFL', '/NDL', '/NJH', '/NP'],
    { stdio: 'inherit' }
  );
  // robocopy：0~7 都算成功
  if (r.status === null || r.status > 7) {
    console.error('同步失败，robocopy 退出码 ' + r.status);
    return 1;
  }

  // 清中间产物。这一步可能被环境的批量删除保护拦下（一次删几千个文件），
  // 那不该算同步失败 —— 产物已经到位了，清不掉只是留个临时目录。
  try {
    fs.rmSync(src, { recursive: true, force: true });
  } catch (e) {
    console.warn('提示：中间产物没删干净（' + e.code + '），可以手动删 ' + src);
  }
  try {
    fs.rmSync(path.join(root, 'dist', 'builder-debug.yml'), { force: true });
  } catch (e) {
    /* 同上，无关紧要 */
  }

  const ok = fs.existsSync(exe);
  console.log(
    '已同步到 ' + dst + '（' + (dirSize(dst) / 1048576).toFixed(0) + ' MB），exe ' +
    (ok ? '就绪' : '缺失！')
  );
  return ok ? 0 : 1;
}

module.exports = { syncGreen, EXE };

if (require.main === module) {
  process.exit(syncGreen());
}
