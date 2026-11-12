/**
 * 访问统计服务（服务端 JSON 存储）
 *
 * 统计内容：
 *   - 页面访问量 / 独立访客数（按页面、按天）
 *   - 访客信息：匿名访客 ID、设备类型、浏览器、操作系统、语言、时区、
 *     来源页面、首次/最近访问时间、脱敏 IP（不保存原始 IP）
 *   - 完成自动填充的文件数（每次写回成功计 1）
 *   - 文件下载次数（每次下载成功计 1）
 *
 * 隐私：不记录文件名、不记录知识库内容、不保存原始 IP；
 *       访客表最多保留 2000 条，明细事件最多 200 条，按天统计保留 90 天。
 */
const crypto = require('crypto');
const storage = require('./storage');

const FILE = 'metrics.json';
const MAX_VISITORS = 2000;
const MAX_EVENTS = 200;
const KEEP_DAYS = 90;

function todayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function emptyStats() {
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    totals: { pageViews: 0, visitors: 0, fills: 0, downloads: 0, learns: 0 },
    daily: {},
    pages: {},
    regions: {},
    visitors: {},
    recent: [],
  };
}

function load() {
  const s = storage.readJson(FILE, null);
  if (!s || typeof s !== 'object' || !s.totals) return emptyStats();
  if (!s.regions || typeof s.regions !== 'object') s.regions = {};
  return s;
}

function save(s) {
  // 限制体积
  const keys = Object.keys(s.visitors || {});
  if (keys.length > MAX_VISITORS) {
    keys.sort((a, b) => String(s.visitors[a].lastSeen).localeCompare(String(s.visitors[b].lastSeen)));
    for (const k of keys.slice(0, keys.length - MAX_VISITORS)) delete s.visitors[k];
  }
  if (s.recent.length > MAX_EVENTS) s.recent = s.recent.slice(-MAX_EVENTS);
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const day of Object.keys(s.daily)) {
    const t = new Date(day + 'T00:00:00').getTime();
    if (Number.isFinite(t) && t < cutoff) delete s.daily[day];
  }
  storage.writeJson(FILE, s);
}

function dayBucket(s, day) {
  if (!s.daily[day]) s.daily[day] = { views: 0, visitors: [], fills: 0, downloads: 0 };
  const b = s.daily[day];
  if (!Array.isArray(b.visitors)) b.visitors = [];
  return b;
}

/** 脱敏 IP：IPv4 隐藏后两段，IPv6 只留前两组 */
function maskIp(ip) {
  const raw = String(ip || '').replace(/^::ffff:/, '');
  if (!raw) return '';
  if (raw.indexOf(':') === -1) {
    const p = raw.split('.');
    if (p.length === 4) return `${p[0]}.${p[1]}.*.*`;
    return raw;
  }
  const g = raw.split(':').filter(Boolean);
  return (g.slice(0, 2).join(':') || raw) + ':****';
}

/** 简单 UA 解析：设备 / 浏览器 / 系统 */
function parseUa(ua) {
  const s = String(ua || '');
  const device = /Mobile|Android|iPhone|iPad|HarmonyOS/i.test(s)
    ? (/iPad|Tablet/i.test(s) ? '平板' : '手机')
    : '桌面';
  let browser = '其他';
  if (/Edg\//i.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(s)) browser = 'Opera';
  else if (/Firefox\//i.test(s)) browser = 'Firefox';
  else if (/Chrome\//i.test(s)) browser = 'Chrome';
  else if (/Safari\//i.test(s)) browser = 'Safari';
  else if (/curl|Wget/i.test(s)) browser = '命令行';

  let os = '其他';
  if (/Windows NT 10/i.test(s)) os = 'Windows 10/11';
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Android/i.test(s)) os = 'Android';
  else if (/iPhone|iPad|iPod/i.test(s)) os = 'iOS';
  else if (/Mac OS X/i.test(s)) os = 'macOS';
  else if (/Linux/i.test(s)) os = 'Linux';
  return { device, browser, os };
}

/** 访客键：优先用浏览器本地匿名 ID，否则用 脱敏IP+UA 的哈希 */
function visitorKey(vid, ip, ua) {
  if (vid && typeof vid === 'string' && vid.length >= 8) return 'v_' + vid.slice(0, 36);
  const h = crypto.createHash('sha256').update(`${maskIp(ip)}|${ua || ''}`).digest('hex');
  return 'h_' + h.slice(0, 16);
}

function touchVisitor(s, key, info) {
  const now = new Date().toISOString();
  let v = s.visitors[key];
  const isNew = !v;
  if (!v) {
    v = {
      id: key,
      firstSeen: now,
      views: 0,
      fills: 0,
      downloads: 0,
    };
    s.visitors[key] = v;
    s.totals.visitors = Object.keys(s.visitors).length;
  }
  v.lastSeen = now;
  if (info) {
    if (info.ipMasked) v.ip = info.ipMasked;
    if (info.device) v.device = info.device;
    if (info.browser) v.browser = info.browser;
    if (info.os) v.os = info.os;
    if (info.lang) v.lang = info.lang;
    if (info.tz) v.tz = info.tz;
    if (info.screen) v.screen = info.screen;
    if (info.referrer) v.referrer = info.referrer;
    if (info.region) v.region = info.region;
    if (info.isp) v.isp = info.isp;
  }
  return { visitor: v, isNew };
}

function pushEvent(s, type, payload) {
  s.recent.push({ t: new Date().toISOString(), type, ...payload });
  if (s.recent.length > MAX_EVENTS) s.recent = s.recent.slice(-MAX_EVENTS);
}

/** 记录一次页面访问 */
function recordPageView({ vid, page, referrer, ua, lang, tz, screen, ip, region, isp }) {
  const s = load();
  const day = todayKey();
  const bucket = dayBucket(s, day);
  const key = visitorKey(vid, ip, ua);
  const parsed = parseUa(ua);
  const { visitor, isNew } = touchVisitor(s, key, {
    ipMasked: maskIp(ip),
    ...parsed,
    lang,
    tz,
    screen,
    referrer: referrer ? String(referrer).slice(0, 200) : '',
    region: region ? String(region).slice(0, 40) : '',
    isp: isp ? String(isp).slice(0, 40) : '',
  });

  s.totals.pageViews += 1;
  bucket.views += 1;
  visitor.views += 1;

  const safePage = String(page || '/').slice(0, 60);
  s.pages[safePage] = (s.pages[safePage] || 0) + 1;

  // 地区分布（按访问次数）
  if (region) {
    const rk = String(region).slice(0, 40);
    s.regions[rk] = (s.regions[rk] || 0) + 1;
  }

  if (bucket.visitors.length < 1000 && bucket.visitors.indexOf(key) === -1) {
    bucket.visitors.push(key);
  }

  pushEvent(s, 'view', { page: safePage, visitor: key, region: region || '' });
  save(s);
  return { ok: true };
}

/** 记录"完成自动填充"或"下载"（只记次数，不记文件名） */
function recordAction(type, { vid, ip, ua } = {}) {
  const s = load();
  const day = todayKey();
  const bucket = dayBucket(s, day);
  const key = visitorKey(vid, ip, ua);
  const { visitor } = touchVisitor(s, key, { ipMasked: maskIp(ip) });

  if (type === 'fill') {
    s.totals.fills += 1;
    bucket.fills += 1;
    visitor.fills += 1;
  } else if (type === 'download') {
    s.totals.downloads += 1;
    bucket.downloads += 1;
    visitor.downloads += 1;
  } else if (type === 'learn') {
    s.totals.learns = (s.totals.learns || 0) + 1;
  }

  pushEvent(s, type, { visitor: key });
  save(s);
}

/**
 * 汇总（供后台页面）
 * @param {number} days 最近多少天
 */
function summary(days = 14) {
  const s = load();
  const series = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = todayKey(d);
    const b = s.daily[key] || { views: 0, visitors: [], fills: 0, downloads: 0 };
    series.push({
      date: key,
      views: b.views || 0,
      visitors: (b.visitors || []).length,
      fills: b.fills || 0,
      downloads: b.downloads || 0,
    });
  }

  const visitorList = Object.values(s.visitors || {})
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
    .slice(0, 50)
    .map((v) => ({
      id: String(v.id).slice(0, 12),
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      views: v.views || 0,
      fills: v.fills || 0,
      downloads: v.downloads || 0,
      device: v.device || '-',
      browser: v.browser || '-',
      os: v.os || '-',
      lang: v.lang || '-',
      tz: v.tz || '-',
      screen: v.screen || '-',
      referrer: v.referrer || '直接访问',
      ip: v.ip || '-',
      region: v.region || '-',
      isp: v.isp || '',
    }));

  // 今日概览
  const today = s.daily[todayKey()] || { views: 0, visitors: [], fills: 0, downloads: 0 };

  return {
    startedAt: s.startedAt,
    generatedAt: new Date().toISOString(),
    totals: s.totals,
    today: {
      views: today.views || 0,
      visitors: (today.visitors || []).length,
      fills: today.fills || 0,
      downloads: today.downloads || 0,
    },
    series,
    pages: Object.entries(s.pages || {})
      .map(([page, views]) => ({ page, views }))
      .sort((a, b) => b.views - a.views),
    regions: Object.entries(s.regions || {})
      .map(([region, views]) => ({ region, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 20),
    visitors: visitorList,
    recent: (s.recent || []).slice(-60).reverse(),
  };
}

function reset() {
  storage.writeJson(FILE, emptyStats());
}

module.exports = { recordPageView, recordAction, summary, reset, maskIp, parseUa };
