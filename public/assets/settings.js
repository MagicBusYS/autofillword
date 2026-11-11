/* 设置页前端逻辑 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var hasSavedKey = false;

  // 服务商预设
  var PRESETS = {
    deepseek: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      baseHint: 'DeepSeek：<code>https://api.deepseek.com</code>　密钥在 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">platform.deepseek.com</a> 获取',
      modelHint: 'DeepSeek 只有两个模型：deepseek-chat（通用对话，推荐）、deepseek-reasoner（推理增强）。其他名称会报错。',
    },
    zhipu: {
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash',
      models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
      baseHint: '智谱 GLM：<code>https://open.bigmodel.cn/api/paas/v4</code>　密钥在 <a href="https://open.bigmodel.cn" target="_blank" rel="noreferrer">open.bigmodel.cn</a> 获取',
      modelHint: '智谱常用：glm-4-flash（快、免费额度友好）、glm-4-plus（更强）',
    },
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      models: ['gpt-4o-mini', 'gpt-4o'],
      baseHint: 'OpenAI：<code>https://api.openai.com/v1</code>　国内网络需自备代理或中转地址',
      modelHint: 'OpenAI 常用：gpt-4o-mini（便宜）、gpt-4o（更强）',
    },
    custom: {
      baseUrl: '',
      model: '',
      models: [],
      baseHint: '填写任意 OpenAI 兼容服务的地址（通常以 /v1 结尾，如公司内部网关、第三方中转）',
      modelHint: '填写该服务支持的模型名称',
    },
  };

  function detectPreset(baseUrl) {
    var url = String(baseUrl || '');
    if (url.indexOf('api.deepseek.com') !== -1) return 'deepseek';
    if (url.indexOf('bigmodel.cn') !== -1) return 'zhipu';
    if (url.indexOf('api.openai.com') !== -1) return 'openai';
    return 'custom';
  }

  function applyPreset(name, opts) {
    var p = PRESETS[name] || PRESETS.custom;
    if (!opts || opts.kind !== 'detect') {
      if (p.baseUrl) $('base-url').value = p.baseUrl;
      if (p.model) $('model').value = p.model;
    }
    $('base-url').placeholder = p.baseUrl || 'https://…';
    $('model').placeholder = p.model || '模型名称';
    $('base-url-hint').innerHTML = p.baseHint;
    $('model-hint').textContent = p.modelHint;
    // 模型下拉建议
    $('model-options').innerHTML = (p.models || []).map(function (m) {
      return '<option value="' + m + '"></option>';
    }).join('');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function loadSettings() {
    fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
      hasSavedKey = Boolean(s.hasKey);
      $('base-url').value = s.baseUrl || '';
      $('model').value = s.model || '';
      $('preset').value = detectPreset(s.baseUrl);
      applyPreset($('preset').value, { kind: 'detect' });
      $('api-key').value = '';
      $('api-key').placeholder = s.hasKey ? '已保存（' + s.apiKey + '），留空表示不修改' : '填写 API Key';
      $('status-line').innerHTML = s.aiEnabled
        ? '<div class="alert success"><span>✅</span><span>AI 已启用，模型：<b>' + esc(s.model) + '</b></span></div>'
        : '<div class="alert warning"><span>⚠️</span><span>尚未配置 API Key，系统将以规则匹配模式运行（知识库仍可用）。</span></div>';
      $('btn-clear-key').style.display = s.hasKey ? '' : 'none';
    }).catch(function (err) {
      $('status-line').innerHTML = '<div class="alert error">读取配置失败：' + esc(err.message) + '</div>';
    });
  }

  $('preset').addEventListener('change', function () {
    applyPreset(this.value);
  });

  function saveSettings(extra) {
    var body = {
      baseUrl: $('base-url').value.trim(),
      model: $('model').value.trim(),
    };
    var key = $('api-key').value.trim();
    if (key) body.apiKey = key;
    if (extra && extra.clearKey) body.apiKey = 'CLEAR';

    return fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error); return d; }); });
  }

  $('btn-save').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    saveSettings()
      .then(function () {
        $('test-result').innerHTML = '<div class="alert success"><span>✅</span><span>配置已保存。</span></div>';
        loadSettings();
      })
      .catch(function (err) {
        $('test-result').innerHTML = '<div class="alert error"><span>❌</span><span>' + esc(err.message) + '</span></div>';
      })
      .finally(function () { btn.disabled = false; });
  });

  $('btn-clear-key').addEventListener('click', function () {
    if (!confirm('确定清除已保存的 API Key 吗？')) return;
    saveSettings({ clearKey: true }).then(function () {
      $('test-result').innerHTML = '<div class="alert success"><span>✅</span><span>API Key 已清除。</span></div>';
      loadSettings();
    });
  });

  $('btn-test').addEventListener('click', function () {
    var btn = this;
    var body = {
      baseUrl: $('base-url').value.trim(),
      model: $('model').value.trim(),
      apiKey: $('api-key').value.trim(),
    };
    if (!body.apiKey && !hasSavedKey) {
      $('test-result').innerHTML = '<div class="alert error"><span>❌</span><span>请先在「API Key」输入框填入 Key，再点测试（无需先保存）。</span></div>';
      return;
    }
    btn.disabled = true;
    $('test-result').innerHTML = '<div class="alert info"><span class="spinner dark"></span><span>正在测试连接…</span></div>';
    fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        $('test-result').innerHTML = '<div class="alert ' + (result.ok ? 'success' : 'error') + '"><span>' +
          (result.ok ? '✅' : '❌') + '</span><span>' + esc(result.message) +
          (result.ok ? '<br>确认无误后请点「保存配置」使其长期生效。' : '') + '</span></div>';
      })
      .catch(function (err) {
        $('test-result').innerHTML = '<div class="alert error"><span>❌</span><span>测试失败：' + esc(err.message) + '</span></div>';
      })
      .finally(function () { btn.disabled = false; });
  });

  loadSettings();
})();
