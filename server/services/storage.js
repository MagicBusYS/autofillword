/**
 * 存储层 - 基于 JSON 文件的轻量持久化
 *
 * 目录默认在 server/storage/，可用环境变量 STORAGE_DIR 指向其他位置
 * （部署时建议放到 /var/lib/autofill，升级代码不会覆盖配置）：
 *   data/settings.json   AI 配置
 *   data/jobs.json       填充任务记录
 *   uploads/             上传原件（用完即删）
 *   outputs/             填充结果（下载后删）
 *
 * 注意：知识库不在服务器，保存在访问者浏览器本地。
 */
const fs = require('fs');
const path = require('path');

const STORAGE_ROOT = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.join(__dirname, '..', 'storage');
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
const UPLOAD_DIR = path.join(STORAGE_ROOT, 'uploads');
const OUTPUT_DIR = path.join(STORAGE_ROOT, 'outputs');

function ensureDirs() {
  for (const dir of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
ensureDirs();

/** 读取 JSON 文件，不存在或损坏时返回 fallback */
function readJson(fileName, fallback) {
  const filePath = path.join(DATA_DIR, fileName);
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error(`[storage] 读取 ${fileName} 失败:`, err.message);
    return fallback;
  }
}

/** 原子写入 JSON 文件（先写临时文件再重命名，避免写入中断导致数据损坏） */
function writeJson(fileName, data) {
  const filePath = path.join(DATA_DIR, fileName);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/** 删除 JSON 文件 */
function removeJson(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

/**
 * 修正上传文件名编码并清理 Windows 不允许的字符。
 * 旧版 busboy 按 latin1 解析 multipart 文件名，中文会变成乱码（无 CJK 且形如 "é¡¹ç®"）。
 * 这里只在"原文无中文但 latin1→utf8 还原后出现中文"时转换，兼容新版本行为。
 */
function decodeFileName(originalname) {
  let name = String(originalname || 'file');
  if (!/[\u4e00-\u9fff]/.test(name)) {
    try {
      const restored = Buffer.from(name, 'latin1').toString('utf8');
      if (restored && !restored.includes('\uFFFD') && /[\u4e00-\u9fff]/.test(restored)) {
        name = restored;
      }
    } catch (e) { /* 保留原值 */ }
  }
  return name.replace(/[\\/:*?"<>|]/g, '_') || 'file';
}

module.exports = {
  STORAGE_ROOT,
  DATA_DIR,
  UPLOAD_DIR,
  OUTPUT_DIR,
  readJson,
  writeJson,
  removeJson,
  decodeFileName,
  cleanupStale,
  safeRemove,
};

/**
 * 清理过期文件（上传原件 / 输出文件），默认保留 2 小时。
 * 部署到服务器时避免残留用户文档。
 */
function cleanupStale(maxAgeMs = 2 * 60 * 60 * 1000) {
  const now = Date.now();
  let removed = 0;
  for (const root of [UPLOAD_DIR, OUTPUT_DIR]) {
    if (!fs.existsSync(root)) continue;
    let dirs = [];
    try {
      dirs = fs.readdirSync(root);
    } catch (e) {
      continue;
    }
    for (const name of dirs) {
      const full = path.join(root, name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
        }
      } catch (e) { /* 忽略单个失败 */ }
    }
  }
  return removed;
}

/** 安全删除文件或目录 */
function safeRemove(target) {
  try {
    if (!target || !fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    console.warn('[storage] 删除失败:', e.message);
  }
}
