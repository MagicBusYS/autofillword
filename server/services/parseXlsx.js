/**
 * Excel (.xlsx) 解析与写回 - 基于 exceljs，保留样式仅写值
 *
 * 解析输出统一块模型 blocks：
 *   { id, type:'cell', sheetIndex, sheetName, row, col, address,
 *     text, isEmpty, context: { header, rowLabel, leftNeighbor } }
 *
 * 写回：按块 id 定位单元格，支持整格写入与占位符内联替换（如 "姓名：____"）。
 */
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const fs = require('fs');

// 扫描上限，防止超大表格拖垮分析
const MAX_ROWS = 300;
const MAX_COLS = 60;

/**
 * 剥离 dataValidations
 *
 * exceljs 读取时会把 `<dataValidation sqref="A2:A1048576">` 里的每个地址展开成单元格，
 * 整列范围（100 多万行）会让读取直接卡死。我们只读单元格的值，
 * 数据验证对解析没有意义，因此读取前移除、写回后再原样还原。
 *
 * @returns {{buffer: Buffer, saved: Object<string,string>}}
 */
async function stripDataValidations(buf) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    return { buffer: buf, saved: {} }; // 不是 zip（交给 exceljs 报错）
  }
  const saved = {};
  let changed = false;
  const names = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n));
  for (const n of names) {
    const f = zip.file(n);
    if (!f) continue;
    const xml = await f.async('string');
    const m = xml.match(/<dataValidations[\s\S]*?<\/dataValidations>/i);
    if (!m) continue;
    saved[n] = m[0];
    zip.file(n, xml.replace(m[0], ''));
    changed = true;
  }
  if (!changed) return { buffer: buf, saved: {} };
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer: out, saved };
}

/** 写回后把之前剥离的 dataValidations 还原到对应工作表 */
async function restoreDataValidations(outPath, saved) {
  const names = Object.keys(saved || {});
  if (!names.length) return;
  try {
    const zip = await JSZip.loadAsync(fs.readFileSync(outPath));
    let changed = false;
    for (const n of names) {
      const f = zip.file(n);
      if (!f) continue;
      const xml = await f.async('string');
      if (xml.indexOf('<dataValidations') !== -1) continue;
      const block = saved[n];
      // 按 schema 顺序尽量靠后插入：extLst 之前，否则 worksheet 结束前
      const next = xml.indexOf('<extLst') !== -1
        ? xml.replace('<extLst', block + '<extLst')
        : xml.replace('</worksheet>', block + '</worksheet>');
      zip.file(n, next);
      changed = true;
    }
    if (!changed) return;
    const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(outPath, out);
  } catch (e) {
    console.warn('[xlsx] 还原数据验证失败:', e.message);
  }
}

function colLetter(num) {
  let s = '';
  while (num > 0) {
    const m = (num - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

/** 展开 'A1:B3' 为所有从地址(master 在前) */
function expandRange(range) {
  const parts = range.split(':');
  if (parts.length !== 2) return [range];
  const decode = (ref) => {
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    if (!m) return null;
    let col = 0;
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    return { col, row: parseInt(m[2], 10), letter: m[1] };
  };
  const a = decode(parts[0]);
  const b = decode(parts[1]);
  if (!a || !b) return [range];
  // 防护：整列/整表级合并（如 A1:A1048576）不展开，避免生成上亿个地址卡死进程
  const rowSpan = Math.abs(b.row - a.row) + 1;
  const colSpan = Math.abs(b.col - a.col) + 1;
  if (rowSpan * colSpan > 20000) return [parts[0]];
  const list = [];
  for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
    for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) {
      list.push(colLetter(c) + r);
    }
  }
  return list;
}

/** 构建合并单元格 master→范围 映射 */
function buildMergeRanges(ws) {
  const ranges = new Map();
  const merges = (ws.model && ws.model.merges) || [];
  for (const range of merges) {
    const parts = range.split(':');
    if (parts.length !== 2) continue;
    const decode = (ref) => {
      const m = ref.match(/^([A-Z]+)(\d+)$/);
      if (!m) return null;
      let col = 0;
      for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      return { col, row: parseInt(m[2], 10) };
    };
    const a = decode(parts[0]);
    const b = decode(parts[1]);
    if (!a || !b) continue;
    ranges.set(parts[0], {
      minCol: Math.min(a.col, b.col), maxCol: Math.max(a.col, b.col),
      minRow: Math.min(a.row, b.row), maxRow: Math.max(a.row, b.row),
    });
  }
  return ranges;
}

/** 构建合并单元格 slave→master 映射 */
function buildMergedMap(ws) {
  const map = new Map();
  const merges = (ws.model && ws.model.merges) || [];
  for (const range of merges) {
    const master = range.split(':')[0];
    for (const addr of expandRange(range)) {
      if (addr !== master) map.set(addr, master);
    }
  }
  return map;
}

/** 读取单元格文本（兼容富文本/公式结果） */
function cellText(cell) {
  if (!cell) return '';
  try {
    const t = cell.text;
    return typeof t === 'string' ? t : t == null ? '' : String(t);
  } catch (e) {
    return '';
  }
}

/**
 * 解析 xlsx 文件为块列表
 * @param {string} filePath
 * @returns {Promise<{blocks: Array, sheetNames: string[]}>}
 */
async function parse(filePath) {
  const wb = new ExcelJS.Workbook();
  // 先剥离整列 dataValidations，避免 exceljs 展开上百万单元格导致卡死
  const raw = fs.readFileSync(filePath);
  const sanitized = await stripDataValidations(raw);
  await wb.xlsx.load(sanitized.buffer);

  const blocks = [];
  const sheetNames = [];

  wb.eachSheet((ws, sheetIndex) => {
    if (sheetIndex > 30) return; // 工作表数量保护
    sheetNames.push(ws.name);
    const mergedMap = buildMergedMap(ws);
    const mergeRanges = buildMergeRanges(ws);
    const maxRows = Math.min(ws.rowCount || 0, MAX_ROWS);
    const maxCols = Math.min(ws.columnCount || 0, MAX_COLS);

    // 先收集原始文本，便于计算上下文
    const grid = [];
    for (let r = 1; r <= maxRows; r++) {
      const rowArr = [];
      for (let c = 1; c <= maxCols; c++) {
        const cell = ws.getRow(r).getCell(c);
        rowArr.push(cellText(cell).trim());
      }
      grid.push(rowArr);
    }

    const cellTextAt = (r, c) => (r >= 1 && c >= 1 && r <= maxRows && c <= maxCols ? grid[r - 1][c - 1] : '');

    for (let r = 1; r <= maxRows; r++) {
      for (let c = 1; c <= maxCols; c++) {
        const cell = ws.getRow(r).getCell(c);
        const address = cell.address;
        if (mergedMap.has(address)) continue; // 跳过合并从格

        const text = grid[r - 1][c - 1];
        // 上下文：同列表头（向上最近非空短文本）、行首标签、左侧邻居
        let header = '';
        for (let rr = r - 1; rr >= Math.max(1, r - 5); rr--) {
          const t = cellTextAt(rr, c);
          if (t && t.length <= 20) { header = t; break; }
        }
        let rowLabel = '';
        for (let cc = 1; cc <= Math.min(2, c - 1); cc++) {
          const t = cellTextAt(r, cc);
          if (t && t.length <= 15) { rowLabel = t; break; }
        }
        const leftNeighbor = cellTextAt(r, c - 1);
        const aboveText = cellTextAt(r - 1, c);
        const belowText = cellTextAt(r + 1, c);

        // 右邻（考虑合并：标签格跨列时，值格在合并范围结束后）
        const ownRange = mergeRanges.get(address);
        let nextCol = c + 1;
        if (ownRange && ownRange.maxCol > c) nextCol = ownRange.maxCol + 1;
        let rightBlockId = null;
        let rightText = '';
        let rightIsSlave = false;
        if (nextCol <= maxCols) {
          const rightAddr = colLetter(nextCol) + r;
          const rightMaster = mergedMap.get(rightAddr);
          if (rightMaster && rightMaster !== rightAddr) {
            rightIsSlave = true; // 右侧格被其他标签合并占用，不能作为值格
          } else {
            rightBlockId = `s${sheetIndex}!${rightAddr}`;
            rightText = cellTextAt(r, nextCol);
          }
        }
        // 下方格（竖排表单：标签在上、值在下）
        let belowBlockId = null;
        if (r + 1 <= maxRows) {
          const belowAddr = address.replace(/\d+$/, String(r + 1));
          const belowMaster = mergedMap.get(belowAddr);
          if (!(belowMaster && belowMaster !== belowAddr)) {
            belowBlockId = `s${sheetIndex}!${belowAddr}`;
          }
        }

        blocks.push({
          id: `s${sheetIndex}!${address}`,
          type: 'cell',
          sheetIndex,
          sheetName: ws.name,
          row: r,
          col: c,
          address,
          text,
          isEmpty: text.trim() === '',
          context: {
            header, rowLabel, leftNeighbor, aboveText, belowText,
            rightBlockId, rightText, rightIsSlave, belowBlockId,
          },
        });
      }
    }
  });

  return { blocks, sheetNames };
}

/** 单元格是否已显式设置字体 */
function hasFont(cell) {
  const f = cell && cell.font;
  return Boolean(f && (f.name || f.size || f.family || f.bold || f.italic || f.color));
}

/**
 * 目标格没有字体时，继承相邻格（左 → 上 → 右 → 下）的字体，
 * 避免填入的内容变成 Excel 默认字体，与模板其他文字不一致。
 */
function inheritFont(ws, cell) {
  if (hasFont(cell)) return;
  const candidates = [
    ws.getCell(cell.row, Math.max(1, cell.col - 1)),
    cell.row > 1 ? ws.getCell(cell.row - 1, cell.col) : null,
    ws.getCell(cell.row, cell.col + 1),
    ws.getCell(cell.row + 1, cell.col),
  ];
  for (const c of candidates) {
    if (c && hasFont(c)) {
      cell.font = JSON.parse(JSON.stringify(c.font));
      return;
    }
  }
}

/**
 * 写回填充值
 * @param {string} srcPath  原文件路径
 * @param {string} outPath  输出路径
 * @param {Array<{id:string, value:string}>} values 块id → 值
 * @param {Map<string, {placeholder: string|null, mode:'inline'|'cell'}>} placements 块id → 写入方式
 */
async function applyValues(srcPath, outPath, values, placements) {
  const wb = new ExcelJS.Workbook();
  // 同样先剥离 dataValidations（否则读取就卡死），写回后再还原
  const sanitized = await stripDataValidations(fs.readFileSync(srcPath));
  await wb.xlsx.load(sanitized.buffer);

  for (const { id, value } of values) {
    const placement = placements.get(id);
    if (!placement) continue;
    const m = id.match(/^s(\d+)!([A-Z]+\d+)$/);
    if (!m) continue;
    const ws = wb.worksheets[parseInt(m[1], 10) - 1];
    if (!ws) continue;

    const addr = m[2];
    const mergedMap = buildMergedMap(ws);
    const master = mergedMap.get(addr) || addr;
    const cell = ws.getCell(master);
    inheritFont(ws, cell);

    if (placement.mode === 'inline' && placement.placeholder) {
      const current = cellText(cell);
      let replaced = false;
      let next = current.replace(placement.placeholder, () => {
        replaced = true;
        return value == null ? '' : String(value);
      });
      if (!replaced) {
        // 占位符未命中（单元格内容可能与分析时不同），退化为追加
        next = current + (value == null ? '' : String(value));
      }
      cell.value = next;
    } else {
      cell.value = value == null ? '' : String(value);
    }
  }

  await wb.xlsx.writeFile(outPath);

  // 还原模板原有的数据验证（下拉框等）
  await restoreDataValidations(outPath, sanitized.saved);
}

module.exports = { parse, applyValues, colLetter, stripDataValidations };
