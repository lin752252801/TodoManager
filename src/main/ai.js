const store = require('./store');

// 服务商预设：全部走 OpenAI 兼容的 /models 与 /chat/completions，选完只是把接入点填上，仍可改
const PRESETS = [
  { key: 'openai', label: 'OpenAI 兼容', url: 'https://api.openai.com/v1' },
  { key: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { key: 'zhipu', label: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'moonshot', label: 'Kimi（月之暗面）', url: 'https://api.moonshot.cn/v1' },
  { key: 'qwen', label: '阿里通义', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'silicon', label: '硅基流动', url: 'https://api.siliconflow.cn/v1' },
  { key: 'ollama', label: 'Ollama（本机）', url: 'http://127.0.0.1:11434/v1' },
  { key: 'custom', label: '自定义', url: '' }
];

const TIMEOUT_MS = 8000;
const TITLE_MAX = 24;

const PROMPT =
  '你在帮用户把随手写的一段话整理成待办清单里的一条。只输出一个 JSON 对象，不要解释、不要代码块：\n' +
  '{"title":"不超过20字的中文标题，动词开头，只说要做的那件事","detail":"整理后的详细内容，保留原文里所有时间、地点、人名、数字等具体信息，去掉口语和重复，可用 1、2、3 分点"}\n' +
  '原文里提到好几件事时，标题取最主要的那一件，其余的写进 detail。';

function cfg() {
  const s = store.getSettings();
  return {
    base: String(s.aiBaseUrl || '').trim().replace(/\/+$/, ''),
    key: String(s.aiKey || '').trim(),
    model: String(s.aiModel || '').trim()
  };
}

function guard() {
  const c = cfg();
  if (!c.base) return '还没填接入点';
  if (!/^https?:\/\//i.test(c.base)) return '接入点要以 http:// 或 https:// 开头';
  if (!c.key) return '还没填 API 密钥';
  return '';
}

// 错误文案要能直接给用户看：不带 HTTP 状态码，也不说「请求失败」这种没信息量的话
function explain(err, res) {
  if (res) {
    if (res.status === 401 || res.status === 403) return '密钥不对或没有权限';
    if (res.status === 404) return '接入点地址不对，检查一下是不是少了一段或者多了一段';
    if (res.status === 429) return '这个接口暂时限流，等一会儿再试';
    return `服务器返回了 ${res.status}`;
  }
  const m = String((err && err.name) === 'TimeoutError' ? 'timeout' : (err && err.message) || err);
  if (m.includes('timeout') || m.includes('abort')) return `没有回应（超过 ${TIMEOUT_MS / 1000} 秒）`;
  if (m.includes('ENOTFOUND') || m.includes('getaddrinfo')) return '找不到这个地址，检查一下接入点';
  if (m.includes('ECONNREFUSED')) return '对方拒绝连接，检查一下接入点或本地服务是否开着';
  if (m.includes('certificate') || m.includes('SSL')) return '证书校验没过';
  return '连不上这个地址';
}

async function call(pathname, { method = 'GET', body } = {}) {
  const c = cfg();
  const bad = guard();
  if (bad) return { ok: false, error: bad };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), TIMEOUT_MS);
  let res = null;
  try {
    res = await fetch(c.base + pathname, {
      method,
      signal: ctrl.signal,
      headers: Object.assign(
        { Authorization: 'Bearer ' + c.key, Accept: 'application/json' },
        body ? { 'Content-Type': 'application/json' } : null
      ),
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    return { ok: false, error: explain(err === 'timeout' || (err && err.reason === 'timeout') ? { name: 'TimeoutError' } : err, null) };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = String((j && j.error && (j.error.message || j.error.msg)) || '').slice(0, 80);
    } catch {}
    return { ok: false, error: explain(null, res) + (detail ? '：' + detail : '') };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, error: '返回的内容不是 JSON，检查一下接入点' };
  }
}

function parseJsonLoose(text) {
  const s = String(text || '').replace(/```/g, '').trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    const o = JSON.parse(s.slice(i, j + 1));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

async function models() {
  const r = await call('/models');
  if (!r.ok) return r;
  const raw = Array.isArray(r.data) ? r.data : Array.isArray(r.data && r.data.data) ? r.data.data : [];
  const list = raw
    .map((m) => (typeof m === 'string' ? m : String((m && (m.id || m.name)) || '').trim()))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  if (!list.length) return { ok: false, error: '这个接入点没返回可用的模型列表，模型那一栏直接手输就行' };
  return { ok: true, models: list };
}

// 测试连接要验的是「这套配置能不能真的用起来」，不是能不能列出模型：
// 拉一次最短的对话，密钥错、模型名错、额度用完都会在这里暴露出来
async function test() {
  const c = cfg();
  if (!c.model) return { ok: false, error: '还没选模型' };
  const started = Date.now();
  const r = await call('/chat/completions', {
    method: 'POST',
    body: {
      model: c.model,
      max_tokens: 16,
      messages: [{ role: 'user', content: '只回复两个字：收到' }]
    }
  });
  if (!r.ok) return r;
  let reply = '';
  try {
    reply = String(((r.data.choices || [])[0] || {}).message?.content || '').trim();
  } catch {}
  return { ok: true, ms: Date.now() - started, reply: reply.slice(0, 10) };
}

async function summarize(text) {
  const raw = String(text || '').trim();
  if (raw.length < 2) return { ok: false, error: '内容太短，不用整理' };
  const c = cfg();
  if (!c.model) return { ok: false, error: '还没选模型' };
  const r = await call('/chat/completions', {
    method: 'POST',
    body: {
      model: c.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: raw.slice(0, 4000) }
      ]
    }
  });
  if (!r.ok) return r;
  let content = '';
  try {
    content = r.data.choices[0].message.content;
  } catch {}
  const o = parseJsonLoose(content);
  if (!o) return { ok: false, error: '返回的格式不对，没整理成' };
  const title = String(o.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return { ok: false, error: '返回的格式不对，没整理成' };
  const chars = [...title];
  return {
    ok: true,
    title: chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') : title,
    detail: String(o.detail || '').trim()
  };
}

module.exports = { PRESETS, summarize, models, test };
