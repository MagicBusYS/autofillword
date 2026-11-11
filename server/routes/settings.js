/**
 * 设置路由 - AI 配置读写与连接测试
 */
const express = require('express');
const ai = require('../services/ai');

const { normalizeBaseUrl } = ai;

const router = express.Router();

// 获取设置（API Key 打码返回）
router.get('/api/settings', (req, res) => {
  const s = ai.getAiSettings();
  res.json({
    baseUrl: s.baseUrl,
    model: s.model,
    apiKey: s.apiKey ? '••••••••' + s.apiKey.slice(-4) : '',
    hasKey: Boolean(s.apiKey),
    aiEnabled: ai.isAiEnabled(),
  });
});

// 保存设置（apiKey 为空字符串表示不修改；'CLEAR' 表示清除）
router.post('/api/settings', express.json({ limit: '256kb' }), (req, res) => {
  const { baseUrl, apiKey, model } = req.body || {};
  const current = ai.getAiSettings();
  const next = {
    baseUrl: normalizeBaseUrl((baseUrl != null && String(baseUrl).trim()) || current.baseUrl) || ai.DEFAULT_SETTINGS.baseUrl,
    model: (model != null && String(model).trim()) || current.model,
    apiKey: current.apiKey,
  };
  if (apiKey === 'CLEAR') next.apiKey = '';
  else if (apiKey != null && String(apiKey).trim()) next.apiKey = String(apiKey).trim();

  require('../services/storage').writeJson('settings.json', next);
  res.json({ ok: true, settings: { baseUrl: next.baseUrl, model: next.model, hasKey: Boolean(next.apiKey) } });
});

// 测试 AI 连接（可用表单当前值，无需先保存）
router.post('/api/settings/test', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { baseUrl, model, apiKey } = req.body || {};
    const result = await ai.testConnection({ baseUrl, model, apiKey });
    res.json(result);
  } catch (err) {
    res.json({ ok: false, message: `测试失败：${err.message}` });
  }
});

module.exports = router;
