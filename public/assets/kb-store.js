/**
 * 本地知识库存储（浏览器 localStorage）
 *
 * 设计目标：知识库内容只保存在访问者本机浏览器里，服务器只做"解析文档 / 写回文件"，
 * 不落盘任何知识数据。部署到服务器后，每个访问者的资料互不可见。
 *
 * 数据结构（localStorage['autofill.kb.v2']）：
 * {
 *   migrated: true,
 *   profiles: [{ id, name, description, createdAt, isDefault?, entries: [...] }]
 * }
 * entry: { id, fieldName, value, aliases[], category, source, sourceFile, updatedAt,
 *          type?: 'table', columns?: [], rows?: [[]] }
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'autofill.kb.v2';
  var LEGACY_KEY = 'autofill.kb.v1';
  var DEFAULT_PROFILE_NAME = '默认知识库（示例）';

  // 默认知识库的 10 条示例数据（可在页面上一键删除或修改）
  var SAMPLE_ENTRIES = [
    { fieldName: '姓名', value: '张三', category: '个人信息' },
    { fieldName: '性别', value: '男', category: '个人信息' },
    { fieldName: '出生日期', value: '1990-01-01', category: '个人信息' },
    { fieldName: '身份证号码', value: '110101199001011234', category: '个人信息' },
    { fieldName: '联系电话', value: '13800138000', category: '联系方式' },
    { fieldName: '电子邮箱', value: 'zhangsan@example.com', category: '联系方式' },
    { fieldName: '学历', value: '本科', category: '教育背景' },
    { fieldName: '毕业院校', value: '某某大学', category: '教育背景' },
    { fieldName: '所学专业', value: '计算机科学与技术', category: '教育背景' },
    { fieldName: '工作单位', value: '某某科技有限公司', category: '工作经历' },
  ];

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) {
      try { return global.crypto.randomUUID(); } catch (e) { /* 非 https 环境可能不可用 */ }
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function normalizeKey(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[\s\u3000]/g, '')
      .replace(/[（）()：:、，,。.；;“”"'‘’《》<>\[\]【】\-—_·*]/g, '');
  }

  function readRaw() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var db = JSON.parse(raw);
      if (!db || !Array.isArray(db.profiles)) return null;
      return db;
    } catch (e) {
      console.warn('[kb] 读取本地知识库失败:', e.message);
      return null;
    }
  }

  function writeDb(db) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      return true;
    } catch (e) {
      // 容量超限等
      console.error('[kb] 保存本地知识库失败:', e.message);
      throw new Error('浏览器本地存储空间不足，请删除部分知识库内容后重试');
    }
  }

  function emptyDb() {
    return { migrated: false, profiles: [] };
  }

  function createDefaultProfile(profiles) {
    var now = new Date().toISOString();
    var profile = {
      id: uuid(),
      name: DEFAULT_PROFILE_NAME,
      description: '内置示例数据，可直接修改或删除',
      isDefault: true,
      createdAt: now,
      entries: SAMPLE_ENTRIES.map(function (s) {
        return {
          id: uuid(),
          fieldName: s.fieldName,
          value: s.value,
          aliases: [],
          category: s.category,
          source: 'sample',
          sourceFile: null,
          updatedAt: now,
        };
      }),
    };
    profiles.push(profile);
    return profile;
  }

  /** 从服务端旧版本迁移（一次性）：把以前存在服务器上的知识库搬到本地 */
  function migrateLegacy(db) {
    if (db.migrated) return Promise.resolve(false);
    var base = (global.location && global.location.origin) || '';
    return fetch(base + '/api/profiles')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var serverProfiles = (data && data.profiles) || [];
        if (!serverProfiles.length) return false;
        return Promise.all(serverProfiles.map(function (p) {
          return fetch(base + '/api/profiles/' + p.id + '/entries')
            .then(function (r) { return r.ok ? r.json() : { entries: [] }; })
            .then(function (d) {
              var entries = d.entries || [];
              if (!entries.length) return null;
              return {
                id: uuid(),
                name: p.name,
                description: p.description || '',
                createdAt: p.createdAt || new Date().toISOString(),
                entries: entries.map(function (e) {
                  var item = {
                    id: e.id || uuid(),
                    fieldName: e.fieldName,
                    value: e.value,
                    aliases: e.aliases || [],
                    category: e.category || '其他',
                    source: e.source || 'legacy',
                    sourceFile: e.sourceFile || null,
                    updatedAt: e.updatedAt || new Date().toISOString(),
                  };
                  if (e.type === 'table') {
                    item.type = 'table';
                    item.columns = e.columns || [];
                    item.rows = e.rows || [];
                  }
                  return item;
                }),
              };
            });
        })).then(function (list) {
          var valid = list.filter(Boolean);
          if (valid.length) {
            valid.forEach(function (p) { db.profiles.push(p); });
          }
          return valid.length > 0;
        });
      })
      .catch(function () { return false; });
  }

  var readyPromise = null;

  var KB = {
    DEFAULT_PROFILE_NAME: DEFAULT_PROFILE_NAME,

    /** 初始化：读取本地 → 迁移旧数据 → 没有档案时创建默认知识库 */
    init: function () {
      if (readyPromise) return readyPromise;
      var db = readRaw() || emptyDb();
      // 兼容早期键名
      if (!db.profiles.length) {
        try {
          var legacy = global.localStorage.getItem(LEGACY_KEY);
          if (legacy) {
            var old = JSON.parse(legacy);
            if (old && Array.isArray(old.profiles)) db = old;
          }
        } catch (e) { /* ignore */ }
      }
      readyPromise = migrateLegacy(db)
        .then(function (migrated) {
          // 始终保证有一个"默认知识库"（用户主动删除后不再重建）
          var hasDefault = db.profiles.some(function (p) { return p.isDefault; });
          if (!hasDefault && !db.defaultRemoved) createDefaultProfile(db.profiles);
          db.migrated = true;
          writeDb(db);
          return { migrated: migrated, profiles: KB.listProfiles() };
        })
        .catch(function (err) {
          console.error('[kb] 初始化失败:', err.message);
          if (!db.profiles.length) createDefaultProfile(db.profiles);
          try { writeDb(db); } catch (e) { /* ignore */ }
          return { migrated: false, profiles: KB.listProfiles() };
        });
      return readyPromise;
    },

    // ---------- 档案 ----------
    listProfiles: function () {
      var db = readRaw() || emptyDb();
      return db.profiles.map(function (p) {
        return {
          id: p.id,
          name: p.name,
          description: p.description || '',
          createdAt: p.createdAt,
          isDefault: Boolean(p.isDefault),
          entryCount: (p.entries || []).length,
          tableCount: (p.entries || []).filter(function (e) { return e.type === 'table'; }).length,
        };
      });
    },

    getProfile: function (id) {
      var db = readRaw() || emptyDb();
      return db.profiles.find(function (p) { return p.id === id; }) || null;
    },

    /** 默认档案（内置示例；被删除后回退到第一个） */
    getDefaultProfileId: function () {
      var list = KB.listProfiles();
      var def = list.find(function (p) { return p.isDefault; });
      if (def) return def.id;
      return list.length ? list[0].id : null;
    },

    createProfile: function (name, description) {
      var db = readRaw() || emptyDb();
      var profile = {
        id: uuid(),
        name: String(name || '').trim() || '未命名档案',
        description: String(description || '').trim(),
        createdAt: new Date().toISOString(),
        entries: [],
      };
      db.profiles.push(profile);
      writeDb(db);
      return profile;
    },

    updateProfile: function (id, patch) {
      var db = readRaw() || emptyDb();
      var p = db.profiles.find(function (x) { return x.id === id; });
      if (!p) return null;
      if (patch.name != null) p.name = String(patch.name).trim() || p.name;
      if (patch.description != null) p.description = String(patch.description).trim();
      writeDb(db);
      return p;
    },

    deleteProfile: function (id) {
      var db = readRaw() || emptyDb();
      var before = db.profiles.length;
      var target = db.profiles.find(function (p) { return p.id === id; });
      if (target && target.isDefault) db.defaultRemoved = true;
      db.profiles = db.profiles.filter(function (p) { return p.id !== id; });
      if (db.profiles.length === before) return false;
      writeDb(db);
      return true;
    },

    // ---------- 条目 ----------
    listEntries: function (profileId) {
      var p = KB.getProfile(profileId);
      return p ? (p.entries || []) : [];
    },

    /** 批量 upsert（按字段名合并；表格条目单独合并） */
    upsertEntries: function (profileId, incoming) {
      var db = readRaw() || emptyDb();
      var p = db.profiles.find(function (x) { return x.id === profileId; });
      if (!p) throw new Error('档案不存在');
      if (!Array.isArray(p.entries)) p.entries = [];

      var added = 0;
      var updated = 0;
      (incoming || []).forEach(function (item) {
        var fieldName = String(item.fieldName || '').trim();
        if (!fieldName) return;
        var key = normalizeKey(fieldName);
        var isTable = item.type === 'table';
        var now = new Date().toISOString();
        var exist = p.entries.find(function (e) {
          return normalizeKey(e.fieldName) === key && (e.type === 'table') === isTable;
        });

        if (exist) {
          if (isTable) {
            if (Array.isArray(item.columns)) exist.columns = item.columns.map(String);
            if (Array.isArray(item.rows)) exist.rows = item.rows.map(function (r) { return r.map(String); });
            if (item.value) exist.value = String(item.value);
          } else if (item.value != null && String(item.value) !== '') {
            exist.value = String(item.value);
          }
          var aliases = {};
          (exist.aliases || []).concat(item.aliases || []).forEach(function (a) {
            if (a && normalizeKey(a) !== key) aliases[a] = true;
          });
          exist.aliases = Object.keys(aliases).slice(0, 8);
          if (item.category) exist.category = item.category;
          if (item.sourceFile) exist.sourceFile = item.sourceFile;
          exist.updatedAt = now;
          updated++;
        } else {
          var entry = {
            id: uuid(),
            fieldName: fieldName,
            value: item.value == null ? '' : String(item.value),
            aliases: (item.aliases || []).filter(function (a) {
              return a && normalizeKey(a) !== key;
            }).slice(0, 8),
            category: item.category || '其他',
            source: item.source || 'manual',
            sourceFile: item.sourceFile || null,
            updatedAt: now,
          };
          if (isTable) {
            entry.type = 'table';
            entry.columns = Array.isArray(item.columns) ? item.columns.map(String) : [];
            entry.rows = Array.isArray(item.rows) ? item.rows.map(function (r) { return r.map(String); }) : [];
          }
          p.entries.push(entry);
          added++;
        }
      });

      writeDb(db);
      return { added: added, updated: updated, entries: p.entries };
    },

    updateEntry: function (profileId, entryId, patch) {
      var db = readRaw() || emptyDb();
      var p = db.profiles.find(function (x) { return x.id === profileId; });
      if (!p) return null;
      var e = (p.entries || []).find(function (x) { return x.id === entryId; });
      if (!e) return null;
      if (patch.fieldName != null) e.fieldName = String(patch.fieldName).trim() || e.fieldName;
      if (patch.value != null) e.value = String(patch.value);
      if (patch.category != null) e.category = String(patch.category);
      if (patch.aliases != null) e.aliases = patch.aliases.map(String).filter(Boolean);
      e.updatedAt = new Date().toISOString();
      writeDb(db);
      return e;
    },

    deleteEntry: function (profileId, entryId) {
      var db = readRaw() || emptyDb();
      var p = db.profiles.find(function (x) { return x.id === profileId; });
      if (!p) return false;
      var before = (p.entries || []).length;
      p.entries = (p.entries || []).filter(function (e) { return e.id !== entryId; });
      if (p.entries.length === before) return false;
      writeDb(db);
      return true;
    },

    clearProfileEntries: function (profileId) {
      var db = readRaw() || emptyDb();
      var p = db.profiles.find(function (x) { return x.id === profileId; });
      if (!p) return false;
      p.entries = [];
      writeDb(db);
      return true;
    },

    // ---------- 备份 / 恢复 ----------
    exportAll: function () {
      var db = readRaw() || emptyDb();
      return JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), profiles: db.profiles }, null, 2);
    },

    importAll: function (jsonText, mode) {
      var data;
      try {
        data = JSON.parse(jsonText);
      } catch (e) {
        throw new Error('文件不是有效的 JSON');
      }
      var incoming = Array.isArray(data) ? data : data && data.profiles;
      if (!Array.isArray(incoming)) throw new Error('文件格式不正确（缺少 profiles）');

      var db = readRaw() || emptyDb();
      if (mode === 'replace') db.profiles = [];
      incoming.forEach(function (p) {
        if (!p || !p.name) return;
        db.profiles.push({
          id: uuid(),
          name: String(p.name),
          description: String(p.description || ''),
          createdAt: p.createdAt || new Date().toISOString(),
          entries: (p.entries || []).map(function (e) {
            var item = {
              id: uuid(),
              fieldName: String(e.fieldName || ''),
              value: e.value == null ? '' : String(e.value),
              aliases: e.aliases || [],
              category: e.category || '其他',
              source: e.source || 'import',
              sourceFile: e.sourceFile || null,
              updatedAt: e.updatedAt || new Date().toISOString(),
            };
            if (e.type === 'table') {
              item.type = 'table';
              item.columns = e.columns || [];
              item.rows = e.rows || [];
            }
            return item;
          }).filter(function (e) { return e.fieldName; }),
        });
      });
      db.migrated = true;
      writeDb(db);
      return db.profiles.length;
    },

    /** 清空本地全部知识库（用于彻底删除数据） */
    clearAll: function () {
      global.localStorage.removeItem(STORAGE_KEY);
      global.localStorage.removeItem(LEGACY_KEY);
      readyPromise = null;
    },
  };

  global.KB = KB;
})(window);
