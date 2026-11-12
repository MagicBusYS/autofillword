/**
 * IP 归属地查询（省 / 市）
 *
 * 说明与隐私：
 *   - 使用第三方免费接口 ip-api.com（中文省市名）；可用环境变量 GEOIP=off 关闭
 *   - 仅把访客 IP 发给该接口用于查询，不发送任何其他信息
 *   - 结果按"网段"缓存（IPv4 取前三段 / IPv6 取前四组），缓存键为网段哈希，
 *     **不保存原始 IP**
 *   - 内网 / 本机地址直接标记为"本机/内网"，不外发
 */
const crypto = require('crypto');
const storage = require('./storage');
const fetch = require('node-fetch');

const CACHE_FILE = 'geo-cache.json';
const TTL = 30 * 24 * 60 * 60 * 1000; // 30 天
const MAX_ENTRIES = 5000;
const TIMEOUT = 4000;

function enabled() {
  return String(process.env.GEOIP || '').toLowerCase() !== 'off';
}

/** 本机 / 内网地址 */
function isPrivate(ip) {
  const raw = String(ip || '').replace(/^::ffff:/, '').trim();
  if (!raw) return true;
  if (raw === '::1' || raw === '127.0.0.1' || raw === 'localhost') return true;
  if (raw.indexOf(':') === -1) {
    const p = raw.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => isNaN(n))) return true;
    if (p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  const lower = raw.toLowerCase();
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  return false;
}

/** 网段前缀（用于缓存，避免存原始 IP） */
function prefixOf(ip) {
  const raw = String(ip || '').replace(/^::ffff:/, '');
  if (raw.indexOf(':') === -1) {
    const p = raw.split('.');
    return p.slice(0, 3).join('.');
  }
  return raw.split(':').slice(0, 4).join(':');
}

function cacheKey(ip) {
  return crypto.createHash('sha256').update(prefixOf(ip)).digest('hex').slice(0, 16);
}

function loadCache() {
  const c = storage.readJson(CACHE_FILE, {});
  return c && typeof c === 'object' ? c : {};
}

function saveCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[k];
  }
  storage.writeJson(CACHE_FILE, cache);
}

async function queryProvider(ip) {
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,country,regionName,city,isp`;
  const res = await fetch(url, { timeout: TIMEOUT });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (j.status !== 'success') throw new Error(j.message || '查询未成功');
  const region = [j.regionName, j.city].filter(Boolean).join(' ') || j.country || '未知';
  return { region, isp: j.isp || '', country: j.country || '' };
}

/**
 * 查询 IP 归属地
 * @returns {Promise<{region:string, isp:string, country:string, private?:boolean} | null>}
 */
async function lookup(ip) {
  if (!ip) return null;
  if (isPrivate(ip)) return { region: '本机/内网', isp: '', country: '', private: true };
  if (!enabled()) return null;

  const key = cacheKey(ip);
  const cache = loadCache();
  const hit = cache[key];
  if (hit && Date.now() - (hit.ts || 0) < TTL) {
    return { region: hit.region, isp: hit.isp, country: hit.country };
  }

  try {
    const g = await queryProvider(ip);
    cache[key] = { region: g.region, isp: g.isp, country: g.country, ts: Date.now() };
    saveCache(cache);
    return g;
  } catch (e) {
    console.warn('[geo] 归属地查询失败:', e.message);
    return null;
  }
}

module.exports = { lookup, isPrivate, prefixOf, cacheKey, enabled };
