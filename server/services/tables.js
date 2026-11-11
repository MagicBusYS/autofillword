/**
 * 表格（子明细表）识别与整表填充
 *
 * 典型中文表单里的明细表长这样：
 *   行N:   [学习经历]  起止年月 | 毕业院校及专业 | 学历 | 学位 | 学习方式
 *   行N+1:            2012.09-2016.06 | 成都东软学院软件工程专业 | 本科 | 学士 | 全日制
 * 即：首格是"段名"，其后是列头；数据行的首格为空，后续格是值。
 *
 * 本模块负责：
 *   buildTableRows(blocks)      把单元格块按表/行归并
 *   detectSections(table)       识别出 [段名 + 列头 + 数据行] 的明细表
 *   extractTables(blocks)       学习用：抽取所有明细表（值直接取自单元格，不经过模型，零幻觉）
 *   planTableFill(blocks, tbs)  填充用：按列名匹配知识库里的明细表，生成逐格填充计划
 */
const detector = require('./detector');

/** 表格标识 */
function tableKeyOf(b) {
  const ctx = b.context || {};
  if (ctx.tblId != null) return 'd' + ctx.tblId;
  if (b.sheetIndex != null) return 'x' + b.sheetIndex;
  return null;
}

/** 行标识 */
function rowKeyOf(b) {
  const ctx = b.context || {};
  if (ctx.tblId != null && ctx.rowTrId != null) return `d${ctx.tblId}-${ctx.rowTrId}`;
  if (b.sheetIndex != null && b.row != null) return `x${b.sheetIndex}-${b.row}`;
  return null;
}

/** 行顺序：取 rowKey 末尾数字 */
function rowOrder(rowKey) {
  const m = String(rowKey).match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** 单元格列号：docx 用累计 colIndex，xlsx 用列序号 */
function colOf(b) {
  const ctx = b.context || {};
  if (ctx.colIndex != null) return ctx.colIndex;
  if (b.col != null) return b.col - 1;
  return 0;
}

/** 把块列表按 [表][行][格] 归并 */
function buildTableRows(blocks) {
  const tables = new Map();
  // 表前的标题段落（很多模板把"家庭成员情况"写在表格上一行）
  const preceding = new Map();
  let lastPara = '';
  for (const b of blocks) {
    if (b.type === 'paragraph') {
      const t = String(b.text || '').replace(/[\s\u3000]+/g, ' ').trim();
      lastPara = t && t.length <= 30 ? t : '';
      continue;
    }
    if (b.type !== 'cell') continue;
    const tk = tableKeyOf(b);
    const rk = rowKeyOf(b);
    if (!tk || !rk) continue;
    if (!tables.has(tk)) {
      tables.set(tk, new Map());
      // 优先用解析器从 DOM 读到的"表格前一段文字"，其次用块顺序推断
      const ctxPreceding = (b.context && b.context.tblPreceding) || '';
      const prec = ctxPreceding || lastPara;
      if (prec) preceding.set(tk, prec);
      lastPara = '';
    }
    const rows = tables.get(tk);
    if (!rows.has(rk)) rows.set(rk, []);
    rows.get(rk).push(b);
  }

  const out = [];
  for (const [tableKey, rowsMap] of tables) {
    const rows = Array.from(rowsMap.entries())
      .map(([rowKey, cells]) => ({
        rowKey,
        cells: cells.slice().sort((a, b) => colOf(a) - colOf(b)),
      }))
      .sort((a, b) => rowOrder(a.rowKey) - rowOrder(b.rowKey));
    out.push({ tableKey, rows, precedingText: preceding.get(tableKey) || '' });
  }
  return out;
}

function cellText(b) {
  return String((b && b.text) || '').replace(/[\s\u3000]+/g, ' ').trim();
}

/** 一行是否像"段名 + 列头" */
function looksLikeSectionHeader(cells) {
  if (!cells || cells.length < 3) return false;
  const label = cellText(cells[0]);
  if (!label || label.length > 14) return false;
  const headers = cells.slice(1);
  if (headers.length < 2) return false;
  return headers.every((c) => {
    const t = cellText(c);
    return t && t.length <= 22;
  });
}

/** 一行是否像明细数据行：首格为空，后面有值 */
function looksLikeDataRow(cells) {
  if (!cells || cells.length < 3) return false;
  const first = cellText(cells[0]);
  if (first) return false;
  return cells.slice(1).some((c) => cellText(c));
}

/** 一行是否全空 */
function isEmptyRow(cells) {
  return !cells || cells.every((c) => !cellText(c));
}

/** 去掉行尾的空单元格（xlsx 经常带一长串空列） */
function trimRow(cells) {
  const arr = (cells || []).slice();
  while (arr.length && !cellText(arr[arr.length - 1])) arr.pop();
  return arr;
}

/** 该行作为"列头行"的判定：至少 2 个非空格，且全部是短文本（无冒号/句号） */
function isHeaderLike(cells) {
  const row = trimRow(cells);
  if (row.length < 2 || row.length > 14) return false;
  return row.every((c) => {
    const t = cellText(c);
    return t && t.length <= 22 && !/[:：]$/.test(t) && !/[。；;]/.test(t);
  });
}

/** 该行是否是"只有一格的段标题" */
function isTitleRow(cells) {
  const row = trimRow(cells);
  if (row.length !== 1) return false;
  const t = cellText(row[0]);
  return Boolean(t) && t.length <= 20;
}

/** 段名特征（用于"段名格 + 列头"同一行的布局） */
const SECTION_NAME_RE = /经历|信息|情况|成员|记录|明细|履历|背景|清单|一览/;

/**
 * 分析一张表中的所有明细表段，兼容两种常见版式：
 *   A. 段名与列头同一行：  [学习经历] 起止年月 | 毕业院校及专业 | 学历
 *   B. 段名单独一行：      家庭成员情况
 *                          关系 | 姓名 | 出生年月 | 政治面貌
 * 数据行 = 列头之后、格数与列头一致、且不是新标题/新列头的连续行。
 *
 * @param {{rows: Array}} table
 * @param {{requireData?: boolean}} [opts] requireData=true 时必须有真实数据行（学习用）
 */
function detectSections(table, opts = {}) {
  const requireData = opts.requireData !== false;
  const rows = table.rows;
  const sections = [];

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].cells;
    if (!isHeaderLike(cells)) continue;

    const headerRow = trimRow(cells);
    const headerTexts = headerRow.map(cellText);

    // 确定段名、列，以及数据行相对整行的列偏移
    let label = '';
    let offset = 0;
    const prev = i > 0 ? rows[i - 1].cells : null;
    if (prev && isTitleRow(prev)) {
      // 版式 B1：表格内上一行是单独标题，列头占满整行
      label = cleanName(cellText(trimRow(prev)[0]));
      offset = 0;
    } else if (i === 0 && table.precedingText && SECTION_NAME_RE.test(table.precedingText)) {
      // 版式 B2：表格外的上一段文字是标题
      label = cleanName(table.precedingText);
      offset = 0;
    } else if (SECTION_NAME_RE.test(headerTexts[0]) && headerTexts.length >= 3) {
      // 版式 A：首格是段名，其后是列头
      label = cleanName(headerTexts[0]);
      offset = 1;
    } else {
      continue; // 普通数据行，不是明细表列头
    }

    const columns = headerRow.slice(offset).map(cellText);
    if (columns.length < 2) continue;
    const colCount = columns.length;
    const width = headerTexts.length;

    // 收集数据行：宽度与列头一致，遇到新标题行/新列头即结束
    const dataRows = [];
    for (let j = i + 1; j < rows.length; j++) {
      const raw = rows[j].cells;
      const trimmed = trimRow(raw);
      if (isTitleRow(raw)) break;
      if (trimmed.length === 0) {
        // 空白占位行：取对应列区间，全部为空
        dataRows.push({ row: rows[j], cells: raw.slice(offset, offset + colCount), empty: true });
        continue;
      }
      if (trimmed.length !== width) break;
      if (j !== i + 1 && isHeaderLike(raw)) break; // 下一段的列头
      const values = raw.slice(offset, offset + colCount);
      dataRows.push({ row: rows[j], cells: values, empty: values.every((c) => !cellText(c)) });
    }
    if (requireData && !dataRows.some((d) => !d.empty)) continue;
    if (!dataRows.length) continue;

    sections.push({ label, columns, headerRow: rows[i], dataRows });
  }
  return sections;
}

/**
 * 学习用：抽取文档中的全部明细表
 * 值直接来自单元格文本，保证与原文一致。
 * @returns {Array<{fieldName, type, columns, rows, category, source}>}
 */
function extractTables(blocks) {
  const result = [];
  const seen = new Set();
  for (const table of buildTableRows(blocks)) {
    for (const sec of detectSections(table)) {
      const key = detector.normalizeKey(sec.label);
      if (seen.has(key)) continue;
      seen.add(key);
      // 学习：去掉尾部空白行，只保留真实数据
      const dataRows = sec.dataRows.slice();
      while (dataRows.length && dataRows[dataRows.length - 1].empty) dataRows.pop();
      const rows = dataRows.map((dr) => dr.cells.map(cellText));
      result.push({
        fieldName: cleanName(sec.label),
        type: 'table',
        columns: sec.columns.map(cleanName),
        rows,
        category: inferTableCategory(sec.label),
        source: 'table',
        value: rows.map((r) => r.join(' | ')).join('\n'),
      });
    }
  }
  return result;
}

/** 明细表分类 */
function inferTableCategory(label) {
  const n = String(label || '');
  if (/学习|教育|学历/.test(n)) return '教育背景';
  if (/工作|实习|任职|履历|经历/.test(n)) return '工作经历';
  if (/家庭|成员|亲属/.test(n)) return '个人信息';
  if (/项目|课题|业绩|成果/.test(n)) return '项目信息';
  return '其他';
}

/** 清洗段名/列名：去换行空格、去括号补充说明（"学习方式（按说明…）" → "学习方式"） */
function cleanName(s) {
  return String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(][^）)]*[）)]\s*$/, '')
    .trim();
}

/** 列名归一化比较 */
function norm(s) {
  return String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[\/／、,，。.:：;；]/g, '')
    .toLowerCase();
}

/** 两个列名是否匹配（保留给旧调用） */
function columnMatch(a, b) {
  return columnScore(a, b) >= 0.7;
}

// 列名同义词：不同模板对同一列的叫法差异很大
const COL_SYNONYMS = [
  ['职务', '岗位', '职位'],
  ['单位', '公司'],
  ['学校', '院校'],
  ['日期', '年月', '时间'],
  ['证明人', '联系人', '推荐人'],
  ['电话', '手机', '联系方式', '号码'],
  ['姓名', '名字'],
  ['关系', '称谓'],
  ['学历', '文化程度'],
];

// 同领域关键词：只要都以它开头，认为是同类列
const COL_PREFIXES = ['起止', '出生', '毕业', '工作', '联系', '学历', '学位', '学习', '证明', '身份', '证件', '电子'];

/** 按 及/和/与/、/ 切词 */
function splitTokens(s) {
  return String(s || '').split(/[及和与、\/／]/).filter((x) => x.length >= 2);
}

function synonymPair(a, b) {
  return COL_SYNONYMS.some((g) => g.indexOf(a) !== -1 && g.indexOf(b) !== -1);
}

/**
 * 列名相似度（0~1）
 * 精确 1 / 包含 0.9 / 词元相同 0.8 / 同前缀 0.75 / 同义词 0.7
 */
function columnScore(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length >= 2 && nb.length >= 2 && (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1)) return 0.9;
  for (const k of COL_PREFIXES) {
    if (na.indexOf(k) === 0 && nb.indexOf(k) === 0) return 0.75;
  }
  const ta = splitTokens(na);
  const tb = splitTokens(nb);
  for (const x of ta) for (const y of tb) if (x === y) return 0.8;
  for (const x of ta) for (const y of tb) {
    if (x.length >= 2 && y.length >= 2 && (x.indexOf(y) !== -1 || y.indexOf(x) !== -1)) return 0.75;
  }
  for (const x of ta) for (const y of tb) if (synonymPair(x, y)) return 0.7;
  if (synonymPair(na, nb)) return 0.7;
  return 0;
}

/**
 * 把知识库明细表的列映射到目标表列（贪心取全表最优配对，避免先到先得）
 * @returns {Array<number>} 目标列下标 → 知识库列下标（-1 表示未匹配）
 */
function mapColumns(sectionColumns, storedColumns) {
  const result = sectionColumns.map(() => -1);
  const pairs = [];
  for (let i = 0; i < sectionColumns.length; i++) {
    for (let j = 0; j < storedColumns.length; j++) {
      const score = columnScore(sectionColumns[i], storedColumns[j]);
      if (score >= 0.7) pairs.push({ i, j, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const usedI = new Set();
  const usedJ = new Set();
  for (const p of pairs) {
    if (usedI.has(p.i) || usedJ.has(p.j)) continue;
    result[p.i] = p.j;
    usedI.add(p.i);
    usedJ.add(p.j);
  }
  return result;
}

/**
 * 填充用：按列名匹配知识库明细表，生成逐格填充计划
 * @param {Array} blocks
 * @param {Array} storedTables 知识库中 type==='table' 的条目
 * @returns {{fields: Array, usedBlockIds: Set<string>}}
 */
function planTableFill(blocks, storedTables) {
  const fields = [];
  const usedBlockIds = new Set();
  if (!storedTables || !storedTables.length) return { fields, usedBlockIds };

  for (const table of buildTableRows(blocks)) {
    for (const sec of detectSections(table, { requireData: false })) {
      // 选出列匹配度最高的知识库明细表
      let best = null;
      for (const st of storedTables) {
        const cols = Array.isArray(st.columns) ? st.columns : [];
        if (cols.length < 2) continue;
        const map = mapColumns(sec.columns, cols);
        const matched = map.filter((i) => i >= 0).length;
        const ratio = matched / sec.columns.length;
        if (matched >= 2 && ratio >= 0.5 && (!best || ratio > best.ratio)) {
          best = { store: st, map, ratio, matched };
        }
      }
      if (!best) continue;

      const store = best.store;
      const storedRows = Array.isArray(store.rows) ? store.rows : [];
      const secLabel = cleanName(sec.label);
      // 只填"全空"的数据行，已有内容的不覆盖
      const emptyRows = sec.dataRows.filter((dr) => dr.cells.every((c) => !cellText(c)));

      for (let r = 0; r < emptyRows.length && r < storedRows.length; r++) {
        const targetCells = emptyRows[r].cells;
        // 结构一致性：数据行格数需与列头一致，否则说明存在跨列合并，位置不可靠
        if (targetCells.length !== sec.columns.length) continue;
        const storedRow = storedRows[r] || [];
        for (let c = 0; c < targetCells.length; c++) {
          const storedIdx = best.map[c];
          if (storedIdx < 0) continue;
          const cell = targetCells[c];
          if (!cell) continue;
          // 整表占用：该格由明细表负责，即使知识库值为空/无，也不再交给通用字段匹配
          usedBlockIds.add(cell.id);
          const value = storedRow[storedIdx];
          if (value == null || String(value).trim() === '' || /^无$/.test(String(value).trim())) continue;
          fields.push({
            id: `t-${cell.id}-${r}-${c}`,
            blockId: cell.id,
            fieldName: `${secLabel}·${cleanName(store.columns[storedIdx] || sec.columns[c])}`,
            label: `${secLabel}·${cleanName(sec.columns[c])}`,
            kind: 'table-cell',
            placeholder: '',
            location: cell.sheetName
              ? `${cell.sheetName}!${cell.address}`
              : `${secLabel} 第${r + 1}行·${cleanName(sec.columns[c])}`,
            preview: `${secLabel} 第${r + 1}行`,
            needFill: true,
            value: String(value),
            source: 'kb-table',
            confidence: best.ratio,
            sourceDetail: store.fieldName,
          });
          usedBlockIds.add(cell.id);
        }
      }
    }
  }

  return { fields, usedBlockIds };
}

module.exports = {
  buildTableRows,
  detectSections,
  extractTables,
  planTableFill,
  inferTableCategory,
  looksLikeSectionHeader,
  mapColumns,
  columnScore,
};
