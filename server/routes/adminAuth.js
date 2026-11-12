/**
 * 管理端登录路由
 *   POST /api/admin/login   密码登录（限流）
 *   POST /api/admin/logout  退出
 *   GET  /api/admin/status  当前是否已授权（本机或已登录）
 */
const express = require('express');
const adminAuth = require('../services/adminAuth');

const router = express.Router();

function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function isLocal(req) {
  const raw = String(req.headers.host || '').trim();
  const name = raw.charAt(0) === '[' ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
  const host = name.toLowerCase();
  if (host) return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const addr = (req.socket && req.socket.remoteAddress) || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

router.get('/api/admin/status', (req, res) => {
  const enabled = adminAuth.isEnabled();
  const local = isLocal(req);
  const session = adminAuth.hasSession(req);
  res.json({ enabled, local, authorized: local || session });
});

router.post('/api/admin/login', express.json({ limit: '4kb' }), (req, res) => {
  if (!adminAuth.isEnabled()) {
    return res.status(400).json({ ok: false, error: '服务器未配置管理密码（ADMIN_PASSWORD），请在服务器上设置后重启服务' });
  }
  const ip = clientIp(req);
  const remain = adminAuth.lockRemainMs(ip);
  if (remain > 0) {
    return res.status(429).json({ ok: false, error: `尝试次数过多，请 ${Math.ceil(remain / 60000)} 分钟后再试` });
  }
  const password = req.body && req.body.password;
  if (!adminAuth.passwordOk(password)) {
    adminAuth.recordFail(ip);
    console.warn(`[admin] 登录失败 IP=${ip}`);
    return res.status(401).json({ ok: false, error: '密码不正确' });
  }
  adminAuth.recordSuccess(ip);
  res.setHeader('Set-Cookie', adminAuth.buildCookie(adminAuth.issueToken(), req));
  console.log(`[admin] 登录成功 IP=${ip}`);
  res.json({ ok: true });
});

router.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', adminAuth.buildClearCookie());
  res.json({ ok: true });
});

module.exports = router;
