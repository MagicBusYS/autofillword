/**
 * 知识库学习 - 从用户上传的已填写文件中抽取 字段:值 对
 *
 * 抽取方式（按优先级）：
 *   A. AI 抽取（推荐）：把文档结构（段落 + 表格行）交给大模型，由模型判断
 *      "哪个是标签、哪个是值"，能正确处理「标签|值|标签|值」这类连续布局。
 *      所有返回值都要通过"原文里逐字存在"校验，防止模型编造。
 *   B. 规则抽取（AI 不可用时的兜底）：
 *      1. 冒号对：同一块文本中 "标签：值"
 *      2. 表格横排/竖排：相邻单元格
 *      3. 表头行 + 数据行
 */
const ai = require('./ai');
const detector = require('./detector');
const parseXlsx = require('./parseXlsx');
const parseDocx = require('./parseDocx');
const tables = require('./tables');

const CHECKBOX_RE = detector.CHECKBOX_RE;

const CATEGORIES = ['个人信息', '联系方式', '教育背景', '工作经历', '公司信息', '项目信息', '其他'];

/** 规则分类（无 AI 时兜底） */
function inferCategory(fieldName) {
  const n = String(fieldName || '');
  if (/电话|手机|邮箱|邮件|地址|邮编|微信|QQ|联系方式/i.test(n)) return '联系方式';
  if (/工作单位|公司|职称|职务|职位|岗位|工作经历|履历|任职|部门|工龄/.test(n)) return '工作经历';
  if (/学历|学位|毕业|院校|学校|教育|在校|就读|^专业$|所学专业|专业名称/.test(n)) return '教育背景';
  if (/统一社会信用代码|注册资金|注册资本|法人|经营范围|公司名称|企业/.test(n)) return '公司信息';
  if (/项目|课题|申报|经费|预算|成果|专利|论文/.test(n)) return '项目信息';
  if (/姓名|性别|出生|身份证|民族|政治面貌|婚姻|籍贯|户籍|年龄|申请人|填报人|填表人|联系人/.test(n)) return '个人信息';
  return '其他';
}

/** 是否像占位符（未填） */
function looksUnfilled(text) {
  if (!text) return true;
  const t = String(text).trim();
  if (!t) return true;
  if (/^[_＿—–.…\s　()（）]+$/.test(t)) return true;
  if (/^(无|暂无|待填|待补充|N\/A|\/|-+)$/i.test(t)) return true;
  return false;
}

/** 是否像标签：短、不含句号长句 */
function looksLikeLabel(text) {
  const t = (text || '').trim();
  if (!t || t.length > 25) return false;
  if (CHECKBOX_RE.test(t)) return false;
  if (/[。！！？?]/.test(t)) return false;
  return true;
}

/** 是否像"值"（而非另一个标签）：不以冒号结尾、不是纯标签提示 */
function looksLikeValue(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/[:：]$/.test(t)) return false;            // "电子邮箱：" 是标签，不是值
  if (/^(请填写|请在此填写|以下由.*填写|备注)[:：]?$/.test(t)) return false;
  if (/[_＿]{2,}/.test(t)) return false;          // 含下划线占位
  return true;
}

/** 清洗标签 */
function cleanLabel(text) {
  return detector.normalizeLabel(text);
}

function pushPair(map, label, value) {
  const l = cleanLabel(label);
  const v = String(value || '').trim();
  if (!l || !v || looksUnfilled(v)) return;
  if (!looksLikeValue(v)) return;
  if (map.has(l)) {
    // 保留更长的值（通常信息更完整）
    const old = map.get(l);
    if (v.length > old.value.length) map.set(l, { label: l, value: v });
  } else {
    map.set(l, { label: l, value: v });
  }
}

/**
 * 从块列表抽取 字段值对
 *
 * 规则（按强弱）：
 *   A. 块内冒号对："标签：值"
 *   B. 横排强：左格以冒号结尾 + 本格值
 *   C. 横排弱：左格像标签 + 本格像值（值不像标签，如含数字/英文/较长）
 *   D. 竖排：上格在表头行（表的第一非空行）或上格以冒号结尾 + 本格值
 * @returns {Array<{label, value}>}
 */
function extractPairs(blocks) {
  const map = new Map();
  const blockById = new Map(blocks.map((b) => [b.id, b]));

  // 表头行（与候选检测共用同一判定：xlsx 看"整行短标签"，docx 看每个表的第一非空行）
  const headerRows = detector.buildHeaderRows(blocks);
  const rowKey = detector.rowKeyOf;
  const inHeaderRow = (b) => {
    const rk = rowKey(b);
    return Boolean(rk && headerRows.has(rk));
  };

  for (const b of blocks) {
    const text = (b.text || '').trim();
    if (!text) continue;
    if (CHECKBOX_RE.test(text)) continue;

    // A. 块内冒号对
    const colonRe = /([^:：\n]{1,20})[:：]([^:：\n]{1,120})/g;
    let m;
    let matched = false;
    while ((m = colonRe.exec(text)) !== null) {
      const rawLabel = m[1].trim();
      let value = m[2].trim();
      // 模板常用「（标签：____）」包裹：标签前有左括号时，去掉值尾部配对的右括号
      const bracketPairs = [['（', '）'], ['(', ')'], ['《', '》'], ['【', '】'], ['「', '」'], ['[', ']']];
      for (const [open, close] of bracketPairs) {
        if (rawLabel.startsWith(open) && value.endsWith(close)) {
          value = value.slice(0, -close.length).trim();
          break;
        }
      }
      if (looksLikeLabel(rawLabel) && !looksUnfilled(value) && !/[_＿]{2,}/.test(value)) {
        pushPair(map, rawLabel, value);
        matched = true;
      }
    }
    if (matched) continue;

    if (b.type !== 'cell') continue;
    const ctx = b.context || {};
    const valueOk = !looksUnfilled(text) && !/[_＿]{2,}/.test(text);

    // B/C. 横排
    let left = null;
    if (ctx.leftTcId) {
      const lb = blockById.get(ctx.leftTcId);
      if (lb && !lb.isEmpty) left = lb;
    } else if (ctx.leftNeighbor && ctx.leftNeighbor.trim()) {
      left = { text: ctx.leftNeighbor };
    }
    if (left && valueOk) {
      const lt = (left.text || '').trim();
      const leftIsColonLabel = /[:：]$/.test(lt) && looksLikeLabel(lt.slice(0, -1));
      if (leftIsColonLabel) {
        // B. 强：冒号标签
        pushPair(map, lt, text);
        continue;
      }
      if (looksLikeLabel(lt) && !looksLikeLabel(text) && !CHECKBOX_RE.test(lt)) {
        // C. 弱：标签 + 明显的值
        pushPair(map, lt, text);
        continue;
      }
    }

    // D. 竖排：上格为表头行单元格，或上格为冒号标签
    let above = null;
    if (ctx.aboveTcId) {
      const ab = blockById.get(ctx.aboveTcId);
      if (ab && !ab.isEmpty) above = ab;
    } else if (ctx.aboveText && ctx.aboveText.trim()) {
      above = { text: ctx.header || ctx.aboveText };
    }
    if (above && valueOk && text.length <= 100) {
      const at = (above.text || '').trim();
      const aboveIsColonLabel = /[:：]$/.test(at) && looksLikeLabel(at.slice(0, -1));
      const aboveBlock = ctx.aboveTcId
        ? blockById.get(ctx.aboveTcId)
        : (ctx.aboveText ? { type: 'cell', sheetIndex: b.sheetIndex, row: b.row - 1, text: ctx.aboveText, context: {} } : null);
      const aboveInHeader = aboveBlock ? inHeaderRow(aboveBlock) : false;
      if ((aboveInHeader || aboveIsColonLabel) && looksLikeLabel(at) && !CHECKBOX_RE.test(at)) {
        pushPair(map, at, text);
      }
    }
  }

  return Array.from(map.values()).slice(0, 200);
}

/**
 * AI 归一化：规范字段名、合并同义字段、分类
 * @param {Array<{label, value}>} pairs
 * @returns {Promise<Array<{fieldName, value, aliases, category}> | null>} AI 不可用时返回 null
 */async function normalizePairs(pairs) {
  if (!pairs.length) return [];
  if (!ai.isAiEnabled()) return null;

  const system = `你是资料整理助手。下面是从用户已填写文档中抽取的 字段-值 对列表。请整理成标准知识库条目：
1. fieldName：规范字段名（如 姓名、性别、出生日期、联系电话、电子邮箱、工作单位、职称、学历、毕业院校、项目名称、公司名称、统一社会信用代码 等），同义字段合并为同一规范名（如 "电话"/"手机"/"联系方式" → 联系电话）。
2. aliases：该字段在原文中的其他叫法（不含规范名本身），没有则空数组。
3. category：从这些选项中选一个：${CATEGORIES.join('、')}。
4. value 原样保留，禁止修改。
5. 与个人身份无关的临时性内容（如某次活动的名称、日期）也保留，由用户决定是否入库。

只输出 JSON 数组：
[{"fieldName":"姓名","value":"张三","aliases":["申请人"],"category":"个人信息"}]`;

  const answer = await ai.chatJson(
    [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(pairs.map((p) => ({ label: p.label, value: p.value }))) },
    ],
    { temperature: 0.1, maxTokens: 4000 }
  );

  if (!Array.isArray(answer)) return null;
  const out = [];
  for (const item of answer) {
    if (!item || !item.fieldName || item.value == null) continue;
    out.push({
      fieldName: String(item.fieldName).trim(),
      value: String(item.value),
      aliases: Array.isArray(item.aliases) ? item.aliases.map(String).filter(Boolean).slice(0, 8) : [],
      category: CATEGORIES.includes(item.category) ? item.category : '其他',
    });
  }
  return out;
}

// ---------------- AI 抽取 ----------------

/**
 * 把文档块整理成大模型可读的"结构摘要"：
 *   段落: xxx
 *   表1 行2: 姓名 | 袁爽 | 性别 | 男
 * 表格按行输出保留"同一行里的相邻关系"，这是模型判断 标签/值 的关键。
 */
function buildDigest(blocks, limits = {}) {
  const maxChars = limits.maxChars || 14000;
  const maxPara = limits.maxPara || 50;
  const maxRows = limits.maxRows || 220;
  const lines = [];

  const paraLines = [];
  for (const b of blocks) {
    if (b.type !== 'paragraph') continue;
    const t = String(b.text || '').replace(/[\s\u3000]+/g, ' ').trim();
    if (!t) continue;
    paraLines.push('段落: ' + t.slice(0, 300));
    if (paraLines.length >= maxPara) break;
  }

  const rows = [];
  const rowMap = new Map();
  for (const b of blocks) {
    if (b.type !== 'cell') continue;
    const ctx = b.context || {};
    const tbl = ctx.tblId != null ? ctx.tblId : 0;
    const row = ctx.rowTrId != null ? ctx.rowTrId : (b.row != null ? b.row : 0);
    const key = `T${tbl}R${row}`;
    if (!rowMap.has(key)) {
      rowMap.set(key, { tbl, row, cells: [] });
      rows.push(rowMap.get(key));
    }
    rowMap.get(key).cells.push(String(b.text || '').replace(/[\s\u3000]+/g, ' ').trim());
  }

  const rowLines = [];
  for (const r of rows) {
    if (!r.cells.some((c) => c)) continue; // 全空行无信息
    rowLines.push(`表${r.tbl + 1} 行${r.row + 1}: ` + r.cells.join(' | '));
    if (rowLines.length >= maxRows) break;
  }

  let total = 0;
  for (const line of paraLines.concat(rowLines)) {
    if (total + line.length > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

/** 归一化用于"值是否出现在原文"的校验 */
function normalizeForCheck(s) {
  return String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（）()：:，,。.、；;“”"'‘’]/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase();
}

/**
 * AI 抽取 字段:值 对
 * 特点：由模型理解表格布局判断标签/值；返回值必须逐字出现在原文中，否则丢弃。
 * @param {string} digest 结构摘要
 * @param {string} plainText 全文（用于反幻觉校验）
 * @returns {Promise<Array<{fieldName, value, aliases, category, source}> | null>}
 */
async function aiExtractPairs(digest, plainText) {
  if (!digest) return [];
  const system = `你是表单信息抽取助手。用户上传了一份【已填写】的中文表格/文档，需要把里面的信息整理成知识库条目。

输入格式说明：
- "段落: ..." 是文档中的正文段落
- "表1 行2: 姓名 | 袁爽 | 性别 | 男" 是表格的一行，用 | 分隔同一行的各个单元格

抽取规则：
1. 只抽取"表格里已经写好的具体信息"，例如：姓名=袁爽、性别=男、身份证号码=511321...
2. 表格常见布局是【标签 | 值 | 标签 | 值】交替出现，必须自行判断哪个单元格是标签、紧跟其后的是它的值。判断依据是语义：标签是固定称谓（姓名/性别/出生日期/联系电话…），值是人名、日期、号码、单位名等。
3. 严格跳过：标题、填表说明、条款正文、空白单元格、表头（如"起止年月 | 毕业院校及专业 | 学历 | 学位"这一整行）、"无/暂无"这类空值。
4. 重复记录表（学习经历、工作经历、家庭成员）不要逐格罗列，只提炼最有价值的一条：
   - 学习经历 → 最高学历、毕业院校、所学专业、学位（取最高学历那行）
   - 工作经历 → 工作单位、现任职务（取最近一份）
   - 家庭成员 → 一般不需要，除非有明确的"紧急联系人"
5. value 必须是原文中的**连续原文片段**，逐字复制，不得改写、翻译、补全、格式化（日期保持原样如 1994年04月10日）。
6. fieldName 用规范中文名称（姓名、性别、出生日期、身份证号码、联系电话、电子邮箱、学历、毕业院校、专业、学位、工作单位、现任职务、应聘岗位、籍贯、民族、政治面貌、婚育状况、健康状况、户籍所在地 等）；aliases 填原文里的其他叫法。
7. category 从这些里选一个：${CATEGORIES.join('、')}。
8. 最多 40 条，宁缺毋滥。

只输出 JSON 数组，不要任何解释：
[{"fieldName":"姓名","value":"袁爽","aliases":[],"category":"个人信息"}]`;

  const answer = await ai.chatJson(
    [
      { role: 'system', content: system },
      { role: 'user', content: digest },
    ],
    { temperature: 0, maxTokens: 4000, timeoutMs: 120000 }
  );

  if (!Array.isArray(answer)) return null;

  const haystack = normalizeForCheck(plainText);
  const out = [];
  const seen = new Set();
  for (const item of answer) {
    if (!item || !item.fieldName || item.value == null) continue;
    const fieldName = String(item.fieldName).trim().slice(0, 30);
    const value = String(item.value).trim().slice(0, 500);
    if (!fieldName || !value) continue;
    if (looksUnfilled(value)) continue;
    // 反幻觉：值必须能在原文中找到（忽略空白与标点差异）
    const needle = normalizeForCheck(value);
    if (!needle || haystack.indexOf(needle) === -1) {
      console.warn(`[learn] 丢弃 AI 抽取（原文中找不到该值）: ${fieldName} => ${value.slice(0, 40)}`);
      continue;
    }
    const key = detector.normalizeKey(fieldName);
    if (seen.has(key)) continue;
    seen.add(key);
    // AI 给出的分类不可靠时（缺省/其他），用规则再判一次
    const aiCategory = CATEGORIES.includes(item.category) && item.category !== '其他' ? item.category : null;
    out.push({
      fieldName,
      value,
      aliases: Array.isArray(item.aliases) ? item.aliases.map(String).filter(Boolean).slice(0, 8) : [],
      category: aiCategory || inferCategory(fieldName),
      source: 'ai',
    });
  }
  return out;
}

/** 文档纯文本（用于值校验） */
function blocksToText(blocks) {
  return blocks
    .map((b) => String(b.text || ''))
    .filter((t) => t.trim())
    .join('\n');
}

/**
 * 学习入口：解析文件并抽取字段值对
 * AI 可用时由模型抽取标量字段（识别更准），明细表（学习/工作/家庭经历等）由结构识别抽取。
 * @returns {Promise<{pairs: Array, tables: Array, normalized: Array|null, aiUsed: boolean, method: 'ai'|'rule'}>}
 */
async function learnFromFile(filePath, fileType) {
  let blocks;
  if (fileType === 'xlsx') {
    const r = await parseXlsx.parse(filePath);
    blocks = r.blocks;
  } else if (fileType === 'docx') {
    const r = await parseDocx.parse(filePath);
    blocks = r.blocks;
  } else {
    throw new Error(`不支持的文件类型: ${fileType}`);
  }

  // 明细表：结构识别，值直接取自单元格（不受 AI 影响，也不会有幻觉）
  let tableEntries = [];
  try {
    tableEntries = tables.extractTables(blocks);
  } catch (err) {
    console.error('[learn] 明细表识别失败:', err.message);
  }

  // A. AI 抽取标量字段
  if (ai.isAiEnabled()) {
    try {
      const digest = buildDigest(blocks);
      const plainText = blocksToText(blocks);
      const aiPairs = await aiExtractPairs(digest, plainText);
      if (aiPairs && aiPairs.length) {
        return {
          pairs: aiPairs,
          tables: tableEntries,
          normalized: aiPairs,
          aiUsed: true,
          method: 'ai',
        };
      }
      console.warn('[learn] AI 未返回有效条目，改用规则抽取');
    } catch (err) {
      console.error('[learn] AI 抽取失败，改用规则抽取:', err.message);
    }
  }

  // B. 规则抽取 + （AI 可用时）字段名归一化
  const pairs = extractPairs(blocks);
  let normalized = null;
  try {
    normalized = await normalizePairs(pairs);
  } catch (err) {
    console.error('[learn] AI 归一化失败:', err.message);
    normalized = null;
  }

  return {
    pairs: pairs.map((p) => ({ ...p, category: inferCategory(p.label) })),
    tables: tableEntries,
    normalized,
    aiUsed: normalized != null,
    method: 'rule',
  };
}

module.exports = { learnFromFile, extractPairs, aiExtractPairs, buildDigest, inferCategory, CATEGORIES };
