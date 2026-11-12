/**
 * 管理端认证（设置页 / 监控台）
 *
 * 设计：
 *   - 密码通过环境变量 ADMIN_PASSWORD 配置（不落库、不进代码）
 *   - 登录成功后签发 HMAC 签名 cookie（HttpOnly + SameSite=Lax，HTTPS 下加 Secure）
 *   - 会话 7 天；改密码后旧会话自动失效（签名密钥由密码派生）
 *   - 本机访问（localhost/127.0.0.1）依旧免登录
 *   - 未配置 ADMIN_PASSWORD 时功能关闭，仅本机可访问（原行为）
 *   - 登录失败限流：同 IP 连续 5 次失败，锁 10 分钟
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const storage = require('./storage');

const COOKIE_NAME = 'af_admin';
const SESSION_DAYS = 7;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

const SALT_FILE = path.join(storage.DATA_DIR, 'admin-salt');

function getPassword() {
  return String(process.env.ADMIN_PASSWORD || '');
}

function isEnabled() {
  return getPassword().length > 0;
}

/** 持久化的随机盐（首次自动生成），使签名密钥与密码绑定 */
function getSalt() {
  try {
    if (!fs.existsSync(SALT_FILE)) {
      fs.writeFileSync(SALT_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    return fs.readFileSync(SALT_FILE, 'utf-8').trim();
  } catch (e) {
    return 'fallback-salt';
  }
}

function secret() {
  return crypto.createHash('sha256').update(`${getPassword()}::${getSalt()}`).digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** 签发会话 token */
function issueToken() {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return `${exp}.${sign(String(exp))}`;
}

/** 校验 token */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [expStr, mac] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(expStr);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 常量时间比较密码 */
function passwordOk(input) {
  const pw = getPassword();
  if (!pw) return false;
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(pw).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i === -1) return;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

/** 请求是否带有效管理会话 */
function hasSession(req) {
  if (!isEnabled()) return false;
  const cookies = parseCookies(req.headers.cookie);
  return verifyToken(cookies[COOKIE_NAME]);
}

// ---------- 限流 ----------
const fails = new Map(); // ip -> { count, first, until }

function isLocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (f.until && f.until > Date.now()) return true;
  return false;
}

function recordFail(ip) {
  const now = Date.now();
  const f = fails.get(ip);
  if (!f || now - f.first > FAIL_WINDOW_MS) {
    fails.set(ip, { count: 1, first: now, until: 0 });
    return;
  }
  f.count += 1;
  if (f.count >= MAX_FAILS) {
    f.until = now + LOCK_MS;
    f.count = 0;
    f.first = now;
  }
}

function recordSuccess(ip) {
  fails.delete(ip);
}

function lockRemainMs(ip) {
  const f = fails.get(ip);
  if (!f || !f.until) return 0;
  return Math.max(0, f.until - Date.now());
}

// ---------- 诊断（帮助定位"密码没生效"） ----------

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

function fileContains(p, needle) {
  try {
    if (!fs.existsSync(p)) return false;
    return fs.readFileSync(p, 'utf-8').includes(needle);
  } catch (e) {
    return false;
  }
}

/**
 * 返回"为什么密码没生效"的诊断信息（不含任何秘密值）。
 * 服务启动时打印 + /api/admin/status 返回，让登录页直接显示原因。
 */
function diagnostics() {
  const pw = getPassword();
  const envFile = '/etc/autofill.env';
  const unitFile = '/etc/systemd/system/autofill.service';
  const envExists = fileExists(envFile);
  const unitHasEnvFile = fileContains(unitFile, 'EnvironmentFile') && fileContains(unitFile, 'autofill.env');

  let hint = '';
  if (pw.length > 0) {
    hint = '';
  } else if (!envExists && !unitHasEnvFile) {
    hint = '未找到 /etc/autofill.env，且 systemd unit 缺少 EnvironmentFile 配置。' +
      '请执行：sudo cp /opt/autofill/deploy/autofill.service /etc/systemd/system/ && ' +
      'sudo bash -c \'echo "ADMIN_PASSWORD=你的强密码" > /etc/autofill.env\' && ' +
      'sudo chmod 600 /etc/autofill.env && sudo systemctl daemon-reload && sudo systemctl restart autofill';
  } else if (!envExists) {
    hint = '未找到 /etc/autofill.env（文件不存在或路径不对）。请执行：' +
      'sudo bash -c \'echo "ADMIN_PASSWORD=你的强密码" > /etc/autofill.env\' && ' +
      'sudo chmod 600 /etc/autofill.env && sudo systemctl restart autofill';
  } else if (!unitHasEnvFile) {
    hint = '/etc/autofill.env 存在，但 systemd unit 缺少 EnvironmentFile 配置（可能是旧版 unit）。请执行：' +
      'sudo cp /opt/autofill/deploy/autofill.service /etc/systemd/system/ && ' +
      'sudo systemctl daemon-reload && sudo systemctl restart autofill';
  } else {
    hint = '配置文件与 unit 都正常，但进程尚未读取到环境变量（未重启或未 daemon-reload）。请执行：' +
      'sudo systemctl daemon-reload && sudo systemctl restart autofill';
  }

  return {
    passwordSet: pw.length > 0,
    envFileExists: envExists,
    unitHasEnvFile,
    hint,
  };
}

/** 生成 Set-Cookie 字符串 */
function buildCookie(token, req) {
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  COOKIE_NAME,
  isEnabled,
  getPassword,
  issueToken,
  verifyToken,
  passwordOk,
  hasSession,
  isLocked,
  recordFail,
  recordSuccess,
  lockRemainMs,
  buildCookie,
  buildClearCookie,
  diagnostics,
};
