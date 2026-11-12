/**
 * 智能文档填充系统 - 服务器入口
 * 启动: node server/index.js  →  http://localhost:3000
 */
const express = require('express');
const path = require('path');

const fillRoutes = require('./routes/fill');
const kbRoutes = require('./routes/kb');
const settingsRoutes = require('./routes/settings');
const metricsRoutes = require('./routes/metrics');
const adminAuthRoutes = require('./routes/adminAuth');
const storage = require('./services/storage');
const adminAuth = require('./services/adminAuth');

const app = express();
const PORT = process.env.PORT || 3000;
// 默认只监听本机，避免知识库（含个人信息）暴露到局域网；需要局域网访问时设 HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';

/**
 * 是否本机访问（localhost / 127.0.0.1 / [::1]）
 * 依据请求的 Host 头判断：用 IP 或域名访问时 Host 不是 localhost，即视为远程。
 * 反向代理若把 Host 改写为 localhost，则远程也会被当作本机——请保留 Host 透传。
 */
function isLocalRequest(req) {
  const raw = String(req.headers.host || '').trim();
  if (raw) {
    const name = raw.charAt(0) === '[' ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
    const host = name.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }
  // 无 Host 头（极少数 HTTP/1.0 客户端）：退回看来源地址
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** 设置页 / 监控台 与对应接口仅限本机访问 */
const LOCAL_ONLY_PAGES = new Set(['/settings.html', '/admin.html', '/admin.html/']);
const LOCAL_ONLY_API_PREFIXES = ['/api/settings', '/api/metrics/summary', '/api/metrics/reset'];

function isLocalOnlyPath(p) {
  if (LOCAL_ONLY_PAGES.has(p)) return true;
  return LOCAL_ONLY_API_PREFIXES.some((prefix) => p.startsWith(prefix));
}

app.use((req, res, next) => {
  if (!isLocalOnlyPath(req.path)) return next();
  // 登录页与登录接口本身放行，否则无法登录
  if (req.path === '/admin-login.html' || req.path.startsWith('/api/admin/')) return next();
  // 本机访问免登录
  if (isLocalRequest(req)) return next();
  // 远程但已登录（签名 cookie 有效）
  if (adminAuth.hasSession(req)) return next();

  // 未授权：页面一律跳登录页（未配置密码时登录页会说明如何配置），接口返回 401
  if (req.path === '/settings.html' || req.path === '/admin.html' || req.path === '/admin.html/') {
    const nextPath = req.originalUrl || req.path;
    return res.redirect(302, `/admin-login.html?next=${encodeURIComponent(nextPath)}`);
  }
  return res.status(401).json({
    error: adminAuth.isEnabled()
      ? '未登录或会话已过期'
      : '服务器未配置管理密码（ADMIN_PASSWORD），远程管理未启用',
    needLogin: true,
    loginPath: '/admin-login.html',
  });
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(fillRoutes);
app.use(kbRoutes);
app.use(settingsRoutes);
app.use(metricsRoutes);
app.use(adminAuthRoutes);

// 健康检查（供 Nginx / 监控探活）
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), storage: storage.STORAGE_ROOT });
});

// 兜底错误处理（multer 错误等）
app.use((err, req, res, next) => {
  console.error('[server]', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, HOST, () => {
  const adminEnabled = adminAuth.isEnabled();
  const pwLen = adminAuth.getPassword().length;
  console.log('');
  console.log('  ========================================');
  console.log('   智能文档填充系统已启动');
  console.log(`   请用浏览器打开: http://localhost:${PORT}`);
  console.log('   知识库保存在访问者浏览器本地，服务器不落盘');
  console.log(`   管理端远程访问: ${adminEnabled ? '✅ 已启用（需密码登录）' : '⚠️ 未启用（仅本机可访问）'}`);
  if (adminEnabled && pwLen < 8) {
    console.log('   ⚠️  ADMIN_PASSWORD 少于 8 位，建议改用更长的强密码');
  }
  if (!adminEnabled) {
    const diag = adminAuth.diagnostics();
    console.log('   📋 诊断: ' + (diag.hint || '未配置 ADMIN_PASSWORD'));
  }
  console.log('  =========================================');
  console.log('');

  // 定期清理上传原件与填充结果（默认保留 2 小时），避免服务器残留用户文档
  const removed = storage.cleanupStale(2 * 60 * 60 * 1000);
  if (removed) console.log(`  [清理] 已删除 ${removed} 个过期临时目录`);
  const timer = setInterval(() => {
    const n = storage.cleanupStale(2 * 60 * 60 * 1000);
    if (n) console.log(`  [清理] 删除 ${n} 个过期临时目录`);
  }, 60 * 60 * 1000);
  timer.unref();
});
