/**
 * 知识库 - 多档案管理 + 字段条目存储 + 三级检索
 *
 * 数据文件：
 *   profiles.json    [{ id, name, description, createdAt }]
 *   kb-{id}.json     [{ id, fieldName, value, aliases[], category, source, sourceFile, updatedAt }]
 *
 * 检索优先级：精确匹配(规范名/别名) > 包含匹配 > 模糊匹配(bigram 相似度)
 */
const crypto = require('crypto');
const storage = require('./storage');

const PROFILES_FILE = 'profiles.json';

// ---------------- 档案管理 ----------------

function listProfiles() {
  const profiles = storage.readJson(PROFILES_FILE, []);
  const result = [];
  for (const p of profiles) {
    const entries = storage.readJson(`kb-${p.id}.json`, []);
    result.push({ ...p, entryCount: entries.length });
  }
  return result;
}

function getProfile(id) {
  return storage.readJson(PROFILES_FILE, []).find((p) => p.id === id) || null;
}

function createProfile(name, description = '') {
  const profiles = storage.readJson(PROFILES_FILE, []);
  const profile = {
    id: crypto.randomUUID(),
    name: String(name || '').trim() || '未命名档案',
    description: String(description || '').trim(),
    createdAt: new Date().toISOString(),
  };
  profiles.push(profile);
  storage.writeJson(PROFILES_FILE, profiles);
  storage.writeJson(`kb-${profile.id}.json`, []);
  return profile;
}

function updateProfile(id, patch) {
  const profiles = storage.readJson(PROFILES_FILE, []);
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  if (patch.name != null) profiles[idx].name = String(patch.name).trim() || profiles[idx].name;
  if (patch.description != null) profiles[idx].description = String(patch.description).trim();
  storage.writeJson(PROFILES_FILE, profiles);
  return profiles[idx];
}

function deleteProfile(id) {
  const profiles = storage.readJson(PROFILES_FILE, []);
  const next = profiles.filter((p) => p.id !== id);
  if (next.length === profiles.length) return false;
  storage.writeJson(PROFILES_FILE, next);
  storage.removeJson(`kb-${id}.json`);
  return true;
}

// ---------------- 条目管理 ----------------

function listEntries(profileId) {
  return storage.readJson(`kb-${profileId}.json`, []);
}

function saveEntries(profileId, entries) {
  storage.writeJson(`kb-${profileId}.json`, entries);
}

/** 规范化字段名用于比较：小写、去空白与标点 */
function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[（）()：:、，,。.；;“”"'‘’《》<>\[\]【】\-—_·*]/g, '');
}

/** bigram 相似度（Dice 系数），适合中文短文本 */
function bigramSimilarity(a, b) {
  const sa = normalizeKey(a);
  const sb = normalizeKey(b);
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const grams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) || 0) + 1);
    }
    return set;
  };
  const ga = grams(sa);
  const gb = grams(sb);
  let overlap = 0;
  for (const [g, n] of ga) {
    if (gb.has(g)) overlap += Math.min(n, gb.get(g));
  }
  const total = (sa.length - 1) + (sb.length - 1);
  return total > 0 ? (2 * overlap) / total : 0;
}

/** upsert 条目：按规范字段名合并，值更新并保留别名 */
function upsertEntries(profileId, incoming) {
  const entries = listEntries(profileId);
  let added = 0;
  let updated = 0;

  for (const item of incoming) {
    const fieldName = String(item.fieldName || '').trim();
    if (!fieldName) continue;
    const value = item.value == null ? '' : String(item.value);
    const key = normalizeKey(fieldName);
    const isTable = item.type === 'table';
    // 表格条目只与同类型（表格）条目合并，避免"学习经历"标量与明细表互相覆盖
    const exist = entries.find((e) => normalizeKey(e.fieldName) === key && (e.type === 'table') === isTable);
    const now = new Date().toISOString();

    if (exist) {
      if (isTable) {
        exist.columns = Array.isArray(item.columns) ? item.columns.map(String) : exist.columns;
        exist.rows = Array.isArray(item.rows) ? item.rows.map((r) => r.map(String)) : exist.rows;
        if (value) exist.value = value;
      } else if (value && value !== exist.value) {
        exist.value = value;
      }
      exist.updatedAt = now;
      // 合并别名
      const aliases = new Set(exist.aliases || []);
      for (const a of item.aliases || []) {
        if (a && normalizeKey(a) !== key) aliases.add(a);
      }
      if (item.sourceFile) exist.sourceFile = item.sourceFile;
      if (item.category) exist.category = item.category;
      exist.aliases = Array.from(aliases);
      updated++;
    } else {
      const entry = {
        id: crypto.randomUUID(),
        fieldName,
        value,
        aliases: (item.aliases || []).filter((a) => a && normalizeKey(a) !== key).slice(0, 8),
        category: item.category || '其他',
        source: item.source || 'manual',
        sourceFile: item.sourceFile || null,
        updatedAt: now,
      };
      if (isTable) {
        entry.type = 'table';
        entry.columns = Array.isArray(item.columns) ? item.columns.map(String) : [];
        entry.rows = Array.isArray(item.rows) ? item.rows.map((r) => r.map(String)) : [];
      }
      entries.push(entry);
      added++;
    }
  }

  saveEntries(profileId, entries);
  return { added, updated };
}

function updateEntry(profileId, entryId, patch) {
  const entries = listEntries(profileId);
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) return null;
  if (patch.fieldName != null) entry.fieldName = String(patch.fieldName).trim() || entry.fieldName;
  if (patch.value != null) entry.value = String(patch.value);
  if (patch.category != null) entry.category = String(patch.category);
  if (patch.aliases != null) entry.aliases = Array.isArray(patch.aliases) ? patch.aliases.map(String).filter(Boolean) : [];
  entry.updatedAt = new Date().toISOString();
  saveEntries(profileId, entries);
  return entry;
}

function deleteEntry(profileId, entryId) {
  const entries = listEntries(profileId);
  const next = entries.filter((e) => e.id !== entryId);
  if (next.length === entries.length) return false;
  saveEntries(profileId, next);
  return true;
}

// ---------------- 检索 ----------------

const FUZZY_THRESHOLD = 0.6;

/**
 * 内置同义词组：不同模板对同一信息的叫法差异极大，
 * 命中同组即视为同一字段（对求职/申报场景覆盖度最高的一批）。
 */
const SYNONYM_GROUPS = [
  ['姓名', '名字', '真实姓名', '填表人', '填报人', '申请人', '联系人', '本人姓名', '姓名签字'],
  ['性别'],
  ['出生日期', '出生年月', '生日', '出生年月日'],
  ['身份证号', '身份证号码', '身份证', '证件号码', '证件号'],
  ['联系电话', '手机号码', '手机号', '手机', '电话', '联系方式', '移动电话', '联系手机', '电话号码'],
  ['电子邮箱', '邮箱', '电子邮件', 'email', 'e-mail', '邮件地址', '电子信箱'],
  ['学历', '最高学历', '文化程度', '学历层次'],
  ['学位'],
  ['毕业院校', '毕业学校', '院校', '学校', '毕业院校名称', '就读院校'],
  ['所学专业', '专业', '专业名称'],
  ['毕业时间', '毕业日期'],
  ['工作单位', '单位', '所在单位', '工作单位名称', '公司名称', '现工作单位', '任职单位'],
  ['职称', '专业技术职称', '职称等级'],
  ['职务', '职位', '岗位', '应聘岗位', '拟聘岗位'],
  ['民族'],
  ['政治面貌'],
  ['婚姻状况', '婚否'],
  ['籍贯'],
  ['户籍所在地', '户口所在地'],
  ['通信地址', '通讯地址', '联系地址', '地址', '现居住地址'],
  ['邮政编码', '邮编'],
  ['项目名称', '项目名', '课题名称', '项目标题', '申报项目名称'],
  ['项目简介', '项目介绍', '项目概述', '项目描述', '项目内容简介', '项目主要内容'],
  ['项目负责人', '负责人', '项目主持人'],
  ['申报单位', '申请单位', '申报单位名称'],
  ['统一社会信用代码', '社会信用代码', '信用代码', '营业执照号'],
  ['填表日期', '填报日期', '申报日期', '提交日期', '申请日期'],
  ['个人简介', '自我介绍', '个人介绍', '自我评价', '个人评价', '个人陈述'],
  ['工作经历', '工作简历', '履历'],
  ['教育经历', '教育背景', '学习经历'],
  ['紧急联系人', '紧急联系人姓名'],
];

/** 归一化名称 → 同组成员集合 */
const SYNONYM_INDEX = (() => {
  const index = new Map();
  for (const group of SYNONYM_GROUPS) {
    const keys = group.map(normalizeKey);
    for (const k of keys) {
      if (!index.has(k)) index.set(k, new Set());
      for (const k2 of keys) index.get(k).add(k2);
    }
  }
  return index;
})();

/**
 * 三级检索：给定字段标签，在档案条目中找最佳匹配
 * @returns {null | { entry, score, method }}
 */
function matchLabel(label, entries) {
  if (!label) return null;
  const key = normalizeKey(label);
  if (!key) return null;

  // 1) 精确：规范名或别名
  for (const e of entries) {
    if (normalizeKey(e.fieldName) === key || (e.aliases || []).some((a) => normalizeKey(a) === key)) {
      return { entry: e, score: 1, method: 'kb-exact' };
    }
  }
  // 2) 同义词：命中内置同义词组
  const syn = SYNONYM_INDEX.get(key);
  if (syn) {
    for (const e of entries) {
      const ek = normalizeKey(e.fieldName);
      if (syn.has(ek) || (e.aliases || []).some((a) => syn.has(normalizeKey(a)))) {
        return { entry: e, score: 0.95, method: 'kb-synonym' };
      }
    }
  }
  // 3) 包含：短字段名被长标签包含（如 "姓名" ⊂ "申请人姓名"），至少 2 字
  let best = null;
  for (const e of entries) {
    const ek = normalizeKey(e.fieldName);
    if (ek.length >= 2 && (key.includes(ek) || ek.includes(key))) {
      const score = 0.9 - Math.abs(ek.length - key.length) * 0.02;
      if (!best || score > best.score) best = { entry: e, score, method: 'kb-contains' };
    }
  }
  if (best) return best;
  // 4) 模糊：bigram 相似度
  for (const e of entries) {
    const score = bigramSimilarity(label, e.fieldName);
    if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) {
      best = { entry: e, score, method: 'kb-fuzzy' };
    }
  }
  return best;
}

module.exports = {
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  listEntries,
  saveEntries,
  upsertEntries,
  updateEntry,
  deleteEntry,
  matchLabel,
  normalizeKey,
  bigramSimilarity,
};
