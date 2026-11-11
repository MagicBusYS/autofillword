/**
 * 候选填充位检测（规则预筛）
 *
 * 从块列表中找出可能需要填写的位置，输出候选：
 *   { id, blockId, kind, label, placeholder, placeholderSpan, originalText, context }
 * kind:
 *   underline      下划线/长破折号占位   "姓名：____"
 *   blank-parens   空括号占位           "申请人：（    ）"
 *   after-colon    冒号结尾待追加        "联系电话："
 *   label-cell     表格左邻标签+空格     [姓名][   ]
 *   header-col     表格列表头下的空格    [姓名]列第一行空格
 *
 * 检测顺序即优先级：inline 类（underline/blank-parens/after-colon）> label-cell > header-col，
 * 每个块只产生一个候选。
 */

const UNDERLINE_RE = /[_＿]{2,}|[-—–]{4,}|…{2,}|\.{6,}/;
const BLANK_PARENS_RE = /（[\s　]*）|\([\s]*\)|《[\s　]*》|【[\s　]*】|「[\s]*」/;
const TRAILING_COLON_RE = /[:：]\s*$/;
const CHECKBOX_RE = /[□☑✓]/;
const MAX_CANDIDATES = 150;

const { normalizeKey } = require('./knowledge');

/** 清洗标签：去掉冒号、全角空格、装饰符、引导词 */
function normalizeLabel(text) {
  return (text || '')
    .replace(/[　\s]+/g, '')
    .replace(/^[-–—*•·※#>〉》】）)}\]]+/, '')
    .replace(/^[（(《【「\[]+/, '')
    .replace(/[:：、，,；;.*·]+$/, '')
    .replace(/^请(?:在此)?填写[:：]?/, '')
    .replace(/^填写[:：]?/, '')
    .trim();
}

/** 从占位符前文本中提取标签 */
function labelBefore(text, idx) {
  return normalizeLabel(text.slice(0, idx));
}

function makeCandidate(block, kind, label, placeholder, span, extra = {}) {
  return {
    blockId: block.id,
    kind,
    label,
    placeholder: placeholder || '',
    placeholderSpan: span || null,
    originalText: block.text,
    previewText: block.text,
    context: block.context || {},
    sheetName: block.sheetName || null,
    address: block.address || null,
    ...extra,
  };
}

/**
 * 解析"标签格"对应的值格（表格布局中标签与值为两个单元格）
 * @returns {null | {cell: object|null, sameCell: boolean}}
 */
function resolveValueCell(block, blockById) {
  const ctx = block.context || {};
  // docx：跨列单元格自身即值区 → 写在本格内
  if (ctx.gridSpan && ctx.gridSpan > 1) return { cell: null, sameCell: true };

  const rightId = ctx.rightTcId || ctx.rightBlockId || null;
  const belowId = ctx.belowTcId || ctx.belowBlockId || null;

  if (rightId) {
    const right = blockById.get(rightId);
    if (right && !right.isEmpty) return null; // 右侧已填，无需填
    if (right) return { cell: right, sameCell: false };
  }
  if (belowId) {
    const below = blockById.get(belowId);
    if (below && !below.isEmpty) return null;
    if (below) return { cell: below, sameCell: false };
  }
  return null;
}

/**
 * 对单个非空块做 inline 类检测
 * @returns 候选或 null
 */
function detectInline(block, blockById) {
  const text = block.text;

  // 含复选框的块是选项类，跳过（避免破坏 □）
  if (CHECKBOX_RE.test(text)) return null;

  // 1. 下划线占位（同块内替换，优先于标签格拆分）
  let m = text.match(UNDERLINE_RE);
  if (m) {
    const idx = m.index;
    const label = labelBefore(text, idx) || pickFallbackLabel(block);
    if (label) return makeCandidate(block, 'underline', label, m[0], { start: idx, end: idx + m[0].length });
  }

  // 2. 空括号占位（值替换整个空括号）
  m = text.match(BLANK_PARENS_RE);
  if (m) {
    const idx = m.index;
    const label = labelBefore(text, idx) || pickFallbackLabel(block);
    if (label) return makeCandidate(block, 'blank-parens', label, m[0], { start: idx, end: idx + m[0].length });
  }

  // 3. 冒号结尾
  if (TRAILING_COLON_RE.test(text) && text.length <= 40) {
    const label = labelBefore(text, text.length) || pickFallbackLabel(block);
    if (!label || label.length > 20) return null;

    // 表格中的标签格：值应写入右邻/下方单元格
    if (block.type === 'cell') {
      const target = resolveValueCell(block, blockById);
      if (!target) return null; // 无可用值格（已填或无处可写）
      if (target.sameCell) {
        return makeCandidate(block, 'after-colon', label, '', null);
      }
      const cell = target.cell;
      return {
        blockId: cell.id,
        kind: 'label-cell',
        label,
        placeholder: '',
        placeholderSpan: null,
        originalText: cell.text,
        previewText: text,
        context: block.context || {},
        sheetName: cell.sheetName || null,
        address: cell.address || null,
      };
    }
    return makeCandidate(block, 'after-colon', label, '', null);
  }
  return null;
}

/** 标签为空时用上下文兜底 */
function pickFallbackLabel(block) {
  const ctx = block.context || {};
  return normalizeLabel(ctx.leftNeighbor) || normalizeLabel(ctx.header) || normalizeLabel(ctx.rowLabel) || '';
}

/** 单元格块的行标识 */
function rowKeyOf(b) {
  if (b.type !== 'cell') return null;
  const ctx = b.context || {};
  if (ctx.tblId != null && ctx.rowTrId != null) return `d${ctx.tblId}-${ctx.rowTrId}`;
  if (b.sheetIndex != null && b.row != null) return `x${b.sheetIndex}-${b.row}`;
  return null;
}

/**
 * 识别"表头行"：
 *  - docx：每个表格的第一非空行
 *  - xlsx：该行有 ≥2 个非空格，且都是短标签（无冒号/句号）
 */
function buildHeaderRows(blocks) {
  const rows = new Map();
  for (const b of blocks) {
    if (b.type !== 'cell') continue;
    const rk = rowKeyOf(b);
    if (!rk) continue;
    if (!rows.has(rk)) rows.set(rk, []);
    if (!b.isEmpty) rows.get(rk).push(b);
  }

  const header = new Set();
  for (const [rk, cells] of rows) {
    if (!rk.startsWith('x')) continue;
    const texts = cells.map((c) => c.text.trim());
    if (texts.length >= 2 && texts.every((t) => t.length <= 12 && !/[:：]/.test(t) && !/[。！？]/.test(t))) {
      header.add(rk);
    }
  }

  const firstRowByTbl = new Map();
  for (const b of blocks) {
    if (b.type !== 'cell' || b.isEmpty) continue;
    const ctx = b.context || {};
    if (ctx.tblId == null || ctx.rowTrId == null) continue;
    const cur = firstRowByTbl.get(ctx.tblId);
    if (cur == null || ctx.rowTrId < cur) firstRowByTbl.set(ctx.tblId, ctx.rowTrId);
  }
  for (const [tblId, rowTrId] of firstRowByTbl) header.add(`d${tblId}-${rowTrId}`);

  return header;
}

/**
 * 表格空单元格检测（label-cell / header-col），同时支持 docx(tc序号) 与 xlsx(行列上下文)
 * @returns {Map<string, object>} blockId → 候选
 */
function detectTableEmpties(blocks, blockById) {
  const found = new Map();
  const cellBlocks = blocks.filter((b) => b.type === 'cell' && b.isEmpty);
  if (!cellBlocks.length) return found;
  const headerRows = buildHeaderRows(blocks);

  for (const b of cellBlocks) {
    const ctx = b.context || {};
    // 左邻：docx 用同表格行左邻块；xlsx 用文本 leftNeighbor
    let label = '';
    let kind = '';
    let left = null;
    if (ctx.leftTcId) {
      const lb = blockById.get(ctx.leftTcId);
      if (lb && !lb.isEmpty) left = lb;
    } else if (ctx.leftNeighbor && ctx.leftNeighbor.trim()) {
      left = { text: ctx.leftNeighbor, isEmpty: false };
    }
    if (left) {
      const l = normalizeLabel(left.text);
      if (l && l.length <= 20 && !CHECKBOX_RE.test(left.text)) {
        label = l;
        kind = 'label-cell';
      }
    }
    // 表头列：上方单元格必须位于"表头行"
    if (!label) {
      let aboveBlock = null;
      let aboveText = '';
      if (ctx.aboveTcId) {
        const ab = blockById.get(ctx.aboveTcId);
        if (ab && !ab.isEmpty) { aboveBlock = ab; aboveText = ab.text; }
      } else if (ctx.aboveText && ctx.aboveText.trim()) {
        // xlsx：构造与上方同行关系的伪块用于表头行判断
        aboveBlock = { type: 'cell', sheetIndex: b.sheetIndex, row: b.row - 1, text: ctx.aboveText, context: {} };
        aboveText = ctx.aboveText;
      }
      if (aboveBlock) {
        const rk = rowKeyOf(aboveBlock);
        if (rk && headerRows.has(rk)) {
          const h = normalizeLabel(aboveText);
          if (h && h.length <= 20 && !CHECKBOX_RE.test(aboveText)) {
            label = h;
            kind = 'header-col';
          }
        }
      }
    }
    if (label && kind) {
      found.set(b.id, makeCandidate(b, kind, label, '', null));
    }
  }
  return found;
}

/**
 * 主入口：从块列表检测候选填充位
 * @param {Array} blocks parse 输出的块列表
 */
function detectCandidates(blocks) {
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const candidates = [];
  const usedBlocks = new Set();

  // 1) 非空块 inline 检测（段落 + 单元格都适用）
  for (const b of blocks) {
    if (b.isEmpty) continue;
    const c = detectInline(b, blockById);
    if (c) {
      candidates.push(c);
      usedBlocks.add(c.blockId);
    }
  }

  // 2) 表格空单元格检测（未被 inline 占用的）
  const empties = detectTableEmpties(blocks, blockById);
  for (const [blockId, c] of empties) {
    if (usedBlocks.has(blockId)) continue;
    candidates.push(c);
    usedBlocks.add(blockId);
  }

  // 3) 去重：按「表 + 列」去重，避免同列多行用同一个值重复填；
  //    不同表格里的同名列（如多张表的"姓名"列）互不影响。
  const slotKeyOf = (cand) => {
    const b = blockById.get(cand.blockId);
    if (!b) return null;
    const ctx = b.context || {};
    const tbl = ctx.tblId != null ? 'd' + ctx.tblId : (b.sheetIndex != null ? 'x' + b.sheetIndex : null);
    if (!tbl) return null;
    const col = ctx.colIndex != null ? ctx.colIndex : (b.col != null ? b.col - 1 : 0);
    return `${tbl}-${col}`;
  };
  const seenSlots = new Set();
  let list = candidates.filter((c) => {
    // 只对"表头列"候选按表+列去重：同一列的多行不应重复填同一个值；
    // label-cell（标签格右侧/下方）每格是独立字段，不需要按列去重
    if (c.kind !== 'header-col') return true;
    const slot = slotKeyOf(c);
    if (!slot) return true;
    if (seenSlots.has(slot)) return false;
    seenSlots.add(slot);
    return true;
  });

  // 数量保护：超过上限时丢弃 header-col 类（最不可靠）
  if (list.length > MAX_CANDIDATES) {
    const kept = list.filter((c) => c.kind !== 'header-col').slice(0, MAX_CANDIDATES);
    list = kept.length ? kept : list.slice(0, MAX_CANDIDATES);
  }

  // 生成候选 id
  return list.map((c, i) => ({ ...c, id: `c${i + 1}` }));
}

module.exports = { detectCandidates, normalizeLabel, CHECKBOX_RE, normalizeKey, buildHeaderRows, rowKeyOf };
