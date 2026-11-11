/**
 * AI 客户端 - 兼容 DeepSeek / OpenAI / 智谱 GLM 等 OpenAI 风格接口
 * 未配置 API Key 时所有 AI 调用降级跳过，返回 null，由上层走知识库规则匹配。
 */
const storage = require('./storage');
const fetch = require('node-fetch'); // Node 16 无内置 fetch，使用 node-fetch@2

// 默认使用 DeepSeek（api.deepseek.com 为 OpenAI 兼容接口）
const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
};

// 早期版本默认值：用于无 Key 时自动迁移到新默认，避免用户看到失效的旧地址
const LEGACY_DEFAULTS = {
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4-flash',
};

/**
 * 规范化用户填写的 API 地址：
 * - 去掉首尾空白与末尾斜杠
 * - 用户若粘贴了完整端点（.../chat/completions），去掉该后缀
 * - DeepSeek 的 Anthropic 兼容端点（/anthropic）不适用本客户端，回退到 OpenAI 兼容根地址
 */
function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url; // 用户只填域名时补协议
  url = url.replace(/\/chat\/completions$/i, '');
  if (/^https?:\/\/api\.deepseek\.com\/anthropic$/i.test(url)) {
    url = 'https://api.deepseek.com';
  }
  return url;
}

/** 服务商与模型名不匹配时的兜底修正（如 DeepSeek 地址配了 glm-4-flash 或 deepseek-flash） */
function fixModelForProvider(baseUrl, model) {
  const url = String(baseUrl || '');
  const m = String(model || '').trim();
  if (url.indexOf('api.deepseek.com') !== -1) {
    // DeepSeek 只有 deepseek-chat / deepseek-reasoner；纠正常见误写
    if (!m || /^glm|^gpt|^claude/i.test(m)) return 'deepseek-chat';
    if (/^deepseek-(flash|lite|plus|pro|max|turbo|mini|v\d+(\.\d+)?)$/i.test(m)) return 'deepseek-chat';
    return m;
  }
  if (url.indexOf('bigmodel.cn') !== -1 && (!m || /^deepseek|^gpt|^claude/i.test(m))) return 'glm-4-flash';
  if (url.indexOf('api.openai.com') !== -1 && /^glm|^deepseek/i.test(m)) return 'gpt-4o-mini';
  return m;
}

function getAiSettings() {
  const saved = storage.readJson('settings.json', {});
  const merged = { ...DEFAULT_SETTINGS, ...saved };
  // 未配置 Key 且仍是旧版默认值时，静默升级为新默认
  if (!merged.apiKey && saved.baseUrl === LEGACY_DEFAULTS.baseUrl && saved.model === LEGACY_DEFAULTS.model) {
    return { ...merged, baseUrl: DEFAULT_SETTINGS.baseUrl, model: DEFAULT_SETTINGS.model };
  }
  const baseUrl = normalizeBaseUrl(merged.baseUrl) || DEFAULT_SETTINGS.baseUrl;
  return { ...merged, baseUrl, model: fixModelForProvider(baseUrl, merged.model) };
}

function isAiEnabled() {
  const s = getAiSettings();
  return Boolean(s.apiKey && s.baseUrl && s.model);
}

/**
 * 合并"表单临时值"与已保存设置，用于"测试连接"不落盘直接验证。
 * override 中 apiKey 为空或为打码值时沿用已保存的 Key。
 */
function resolveSettings(override) {
  const base = getAiSettings();
  if (!override) return base;
  const merged = { ...base };
  if (override.baseUrl && String(override.baseUrl).trim()) {
    merged.baseUrl = normalizeBaseUrl(String(override.baseUrl).trim()) || base.baseUrl;
  }
  const model = override.model != null ? String(override.model).trim() : '';
  merged.model = model ? fixModelForProvider(merged.baseUrl, model) : base.model;
  const key = override.apiKey != null ? String(override.apiKey).trim() : '';
  if (key && !/^[•·*]+/.test(key)) merged.apiKey = key;
  return merged;
}

/**
 * 调用 chat/completions，返回助手消息文本。
 * options: { temperature, maxTokens, timeoutMs, settings }
 */
async function chat(messages, options = {}) {
  const s = resolveSettings(options.settings);
  if (!s.apiKey || !s.baseUrl || !s.model) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 120000);
  try {
    const url = s.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify({
        model: s.model,
        messages,
        temperature: options.temperature != null ? options.temperature : 0.1,
        max_tokens: options.maxTokens || 4096,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI 接口返回 ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    return text || null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 调用 AI 并解析 JSON 输出。
 * 大模型输出可能带 ```json 代码块包裹，这里做容错提取。
 * 返回解析后的对象；AI 未启用/调用失败/解析失败返回 null。
 */
async function chatJson(messages, options = {}) {
  let text;
  try {
    text = await chat(messages, options);
  } catch (err) {
    console.error('[ai] 调用失败:', err.message);
    return null;
  }
  if (!text) return null;

  // 容错：剥离 markdown 代码块、截取首个 { 或 [ 开始的 JSON
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.search(/[{[]/);
  if (start > 0) cleaned = cleaned.slice(start);
  // 截到与之匹配的结尾
  const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  if (lastBrace !== -1) cleaned = cleaned.slice(0, lastBrace + 1);

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[ai] JSON 解析失败, 原始输出前500字:', text.slice(0, 500));
    return null;
  }
}

/**
 * 测试 AI 连接是否可用，返回 { ok, message }
 * @param {{baseUrl?:string, model?:string, apiKey?:string}} [override] 表单当前值（不落盘）
 */
async function testConnection(override) {
  const s = resolveSettings(override);
  if (!s.apiKey) {
    return { ok: false, message: '未填写 API Key。请在上方输入框填入 Key 后直接点「测试连接」，无需先保存。' };
  }
  try {
    const text = await chat(
      [{ role: 'user', content: '请只回复两个字：正常' }],
      { maxTokens: 20, timeoutMs: 30000, settings: override }
    );
    if (text == null) return { ok: false, message: '未填写 API Key。' };
    return { ok: true, message: `连接成功（${s.model}），模型回复：${String(text).trim().slice(0, 50)}` };
  } catch (err) {
    return { ok: false, message: `连接失败：${err.message}` };
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  getAiSettings,
  isAiEnabled,
  chat,
  chatJson,
  testConnection,
  normalizeBaseUrl,
};
