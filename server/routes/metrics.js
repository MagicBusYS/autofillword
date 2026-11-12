/**
 * 访问统计路由
 *   POST /api/metrics/pageview  公开：记录页面访问
 *   GET  /api/metrics/summary   仅本机：后台监控数据
 *   POST /api/metrics/reset     仅本机：清空统计
 */
const express = require('express');
const metrics = require('../services/metrics');
const geo = require('../services/geo');

const router = express.Router();

/** 取真实客户端 IP：优先 Nginx 设置的 X-Real-IP（不可伪造），其次 X-Forwarded-For 首段 */
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// 记录页面访问（所有访客）
router.post('/api/metrics/pageview', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const ip = clientIp(req);
    // IP 归属地（省/市），失败或内网时返回 null / "本机/内网"
    let g = null;
    try {
      g = await geo.lookup(ip);
    } catch (e) { /* 忽略归属地失败，不影响统计 */ }

    metrics.recordPageView({
      vid: b.vid,
      page: b.page,
      referrer: b.referrer,
      ua: req.headers['user-agent'],
      lang: b.lang,
      tz: b.tz,
      screen: b.screen,
      ip,
      region: g ? g.region : '',
      isp: g ? g.isp : '',
    });
  } catch (e) {
    console.warn('[metrics] 记录访问失败:', e.message);
  }
  res.json({ ok: true });
});

// 后台数据（本机访问限制在 server/index.js 中间件里）
router.get('/api/metrics/summary', (req, res) => {
  const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 14));
  res.json(metrics.summary(days));
});

router.post('/api/metrics/reset', (req, res) => {
  metrics.reset();
  res.json({ ok: true });
});

module.exports = router;
