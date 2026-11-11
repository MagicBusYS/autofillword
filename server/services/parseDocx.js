/**
 * Word (.docx) 解析与写回 - jszip 解包 + @xmldom/xmldom 操作 word/document.xml
 *
 * 设计要点：
 * - 扁平遍历所有 <w:p>（含表格内、文本框内），以及所有 <w:tc>（表格单元格）
 * - 表格单元格内的段落归并为"单元格块"，不重复出块
 * - 写回时按 run 精确替换占位符，保留未受影响 run 的格式（如复选框、加粗标签）
 * - 空单元格写入时新建 run
 *
 * 块模型：
 *   { id, type:'paragraph'|'cell', text, isEmpty, context: { prevText, inTable } }
 */
const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const fs = require('fs');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

function parseXml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) {
    throw new Error('docx 内 document.xml 解析失败');
  }
  return doc;
}

/** 节点是否位于某个表格单元格内 */
function insideTableCell(node) {
  let p = node.parentNode;
  while (p && p.nodeName !== '#document') {
    if (p.nodeName === 'w:tc') return true;
    p = p.parentNode;
  }
  return false;
}

/** 收集段落的直接 run 文本（含超链接内 run），带偏移量 */
function paragraphRuns(p) {
  const runs = [];
  const walk = (node) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeName === 'w:r' || child.nodeName === 'w:hyperlink' || child.nodeName === 'w:smartTag' || child.nodeName === 'w:sdt' || child.nodeName === 'w:sdtContent') {
        if (child.nodeName === 'w:r') {
          let text = '';
          const ts = child.getElementsByTagName('w:t');
          for (let j = 0; j < ts.length; j++) text += ts[j].textContent || '';
          runs.push({ node: child, text });
        } else {
          walk(child);
        }
      }
    }
  };
  walk(p);
  return runs;
}

function paragraphText(p) {
  return paragraphRuns(p).map((r) => r.text).join('');
}

function cellParagraphs(tc) {
  // 单元格的段落 = 其直接/嵌套 w:p（排除嵌套表格内的段落）
  const result = [];
  const walk = (node) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child.nodeName === 'w:p') result.push(child);
      else if (child.nodeName === 'w:tbl') continue; // 嵌套表格内的段落不算本格
      else walk(child);
    }
  };
  walk(tc);
  return result;
}

function cellText(tc) {
  return cellParagraphs(tc).map((p) => paragraphText(p)).join('\n');
}

/** 设置 xml:space 保留空格 */
function setTText(tEl, text) {
  while (tEl.firstChild) tEl.removeChild(tEl.firstChild);
  tEl.appendChild(tEl.ownerDocument.createTextNode(text));
  if (/^\s|\s$/.test(text)) tEl.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  else tEl.removeAttributeNS(XML_NS, 'space');
}

function createRun(doc, text, rPr) {
  const r = doc.createElementNS(W_NS, 'w:r');
  // 继承模板字体：没有 rPr 的新文本会用文档默认字体，导致与表格其他内容不一致
  if (rPr) r.appendChild(rPr.cloneNode(true));
  const t = doc.createElementNS(W_NS, 'w:t');
  setTText(t, text);
  r.appendChild(t);
  return r;
}

/** 取直接子元素 */
function directChild(node, nodeName) {
  if (!node) return null;
  for (let i = 0; i < node.childNodes.length; i++) {
    if (node.childNodes[i].nodeName === nodeName) return node.childNodes[i];
  }
  return null;
}

/** 段落标记的字符格式（<w:pPr><w:rPr>），空段落常靠它记录字体 */
function paragraphRPr(p) {
  return directChild(directChild(p, 'w:pPr'), 'w:rPr');
}

/** 单元格内第一个带 w:t 的 run 的 rPr */
function firstRunRPr(node) {
  if (!node) return null;
  const rs = node.getElementsByTagName('w:r');
  for (let i = 0; i < rs.length; i++) {
    const rPr = directChild(rs[i], 'w:rPr');
    const ts = rs[i].getElementsByTagName('w:t');
    let hasText = false;
    for (let k = 0; k < ts.length; k++) {
      if ((ts[k].textContent || '').trim()) { hasText = true; break; }
    }
    if (rPr && hasText) return rPr;
  }
  return null;
}

/**
 * 为空单元格挑选可继承的字符格式：
 * 本段段落标记 → 同行相邻单元格 → 同列上下单元格 → 全表任意有字单元格
 */
function styleSourceForCell(tc, fallbackRPr) {
  const ps = cellParagraphs(tc);
  for (const p of ps) {
    const rPr = paragraphRPr(p);
    if (rPr) return rPr;
    const r = firstRunRPr(p);
    if (r) return r;
  }
  // 同行左右
  const tr = closestAncestor(tc, 'w:tr');
  if (tr) {
    let sib = tc.previousSibling;
    while (sib) {
      if (sib.nodeName === 'w:tc') {
        const r = firstRunRPr(sib);
        if (r) return r;
      }
      sib = sib.previousSibling;
    }
    sib = tc.nextSibling;
    while (sib) {
      if (sib.nodeName === 'w:tc') {
        const r = firstRunRPr(sib);
        if (r) return r;
      }
      sib = sib.nextSibling;
    }
    // 上下行同列
    const pos = siblingIndex(tc, 'w:tc');
    for (const dir of ['prev', 'next']) {
      let row = dir === 'prev' ? prevSibling(tr, 'w:tr') : nextSibling(tr, 'w:tr');
      let guard = 0;
      while (row && guard < 3) {
        const tcs = [];
        for (let i = 0; i < row.childNodes.length; i++) {
          if (row.childNodes[i].nodeName === 'w:tc') tcs.push(row.childNodes[i]);
        }
        const target = tcs[pos];
        if (target) {
          const r = firstRunRPr(target);
          if (r) return r;
        }
        row = dir === 'prev' ? prevSibling(row, 'w:tr') : nextSibling(row, 'w:tr');
        guard++;
      }
    }
  }
  return fallbackRPr || null;
}

/** 从整篇文档里找第一个带格式的 run（最终兜底） */
function documentRPr(doc) {
  const rs = doc.getElementsByTagName('w:r');
  for (let i = 0; i < rs.length; i++) {
    const rPr = directChild(rs[i], 'w:rPr');
    const ts = rs[i].getElementsByTagName('w:t');
    for (let k = 0; k < ts.length; k++) {
      if ((ts[k].textContent || '').trim() && rPr) return rPr;
    }
  }
  return null;
}

/** 去掉下划线（占位符是下划线格式时，填入的文字不应继续带下划线） */
function stripUnderline(rPr) {
  const u = directChild(rPr, 'w:u');
  if (u) rPr.removeChild(u);
}

/**
 * 复用模板里的空 run 时，如果它没有字符格式，就把继承来的格式补进去，
 * 否则填入的文字会退回文档默认字体（与模板不一致）。
 */
function ensureRunRPr(runNode, rPr) {
  if (!runNode || !rPr) return;
  if (directChild(runNode, 'w:rPr')) return;
  runNode.insertBefore(rPr.cloneNode(true), runNode.firstChild);
}

/** 写入 run 文本：没有 w:t 就新建（避免 run 套 run 的非法结构） */
function setRunText(runNode, text) {
  const ts = runNode.getElementsByTagName('w:t');
  if (ts.length) {
    setTText(ts[0], text);
    for (let i = 1; i < ts.length; i++) setTText(ts[i], '');
  } else {
    const t = runNode.ownerDocument.createElementNS(W_NS, 'w:t');
    setTText(t, text);
    runNode.appendChild(t);
  }
}

/**
 * 段落写回核心：在合并文本中替换 [start, end) 为 value，
 * 仅清空被替换覆盖的 run，其余 run 原样保留（保格式）。
 * placeholderSpan 为 null 时表示"追加到末尾"。
 */
function writeParagraphValue(p, placeholderSpan, value, fallbackRPr) {
  const runs = paragraphRuns(p);
  const doc = p.ownerDocument;

  if (runs.length === 0) {
    // 空段落：用段落标记格式或邻格格式，避免落到文档默认字体
    const rPr = paragraphRPr(p) || fallbackRPr || null;
    p.appendChild(createRun(doc, value || '', rPr));
    return;
  }

  // 拼接合并文本与每个 run 的区间
  let merged = '';
  const spans = runs.map((r) => {
    const start = merged.length;
    merged += r.text;
    return { start, end: merged.length };
  });

  let start;
  let end;
  if (placeholderSpan) {
    start = placeholderSpan.start;
    end = placeholderSpan.end;
  } else {
    // 追加到合并文本末尾
    start = merged.length;
    end = merged.length;
  }

  const newText =
    merged.slice(0, start) + (value || '') + merged.slice(end);

  // 找到受影响的 run：与 [start,end) 有交集的第一个和最后一个
  let firstAffected = -1;
  let lastAffected = -1;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].end > start && spans[i].start < end) {
      if (firstAffected === -1) firstAffected = i;
      lastAffected = i;
    }
  }

  if (firstAffected === -1) {
    // 追加场景：落在最后一个 run 之后
    const lastRun = runs[runs.length - 1];
    ensureRunRPr(lastRun.node, fallbackRPr);
    const ts = lastRun.node.getElementsByTagName('w:t');
    if (ts.length) setTText(ts[ts.length - 1], lastRun.text + (value || ''));
    else {
      const t = doc.createElementNS(W_NS, 'w:t');
      setTText(t, value || '');
      lastRun.node.appendChild(t);
    }
    return;
  }

  // 重建受影响区间：
  // 第一个受影响 run：保留 [runStart, start) 前缀 + value + （若同一 run 覆盖到 end 之后）保留 [end, runEnd) 后缀
  const first = runs[firstAffected];
  const prefix = merged.slice(spans[firstAffected].start, start);
  const suffix = merged.slice(end, spans[lastAffected].end);
  ensureRunRPr(first.node, fallbackRPr);
  const firstT = first.node.getElementsByTagName('w:t');
  if (firstT.length) {
    setTText(firstT[0], prefix + (value || '') + suffix);
    // 同一 run 内多余的 w:t 清空
    for (let j = 1; j < firstT.length; j++) setTText(firstT[j], '');
  } else {
    const t = doc.createElementNS(W_NS, 'w:t');
    setTText(t, prefix + (value || '') + suffix);
    first.node.appendChild(t);
  }
  // 占位符是下划线格式时，填进去的文字不要继续带下划线
  if (placeholderSpan && /[_＿]/.test(merged.slice(start, end))) {
    const rPr = directChild(first.node, 'w:rPr');
    if (rPr) stripUnderline(rPr);
  }

  // 中间及后续受影响 run 全部清空文本
  for (let i = firstAffected + 1; i <= lastAffected; i++) {
    const ts = runs[i].node.getElementsByTagName('w:t');
    for (let k = 0; k < ts.length; k++) setTText(ts[k], '');
  }
}

/** 在合并文本中定位占位符的偏移区间，找不到返回 null */
function findSpan(merged, placeholder) {
  if (!placeholder) return null;
  const idx = merged.indexOf(placeholder);
  if (idx === -1) return null;
  return { start: idx, end: idx + placeholder.length };
}

/** 定位块 id 对应的 DOM 节点（与 parse 时同一遍历顺序） */
function locateNodes(doc) {
  const paragraphs = Array.from(doc.getElementsByTagName('w:p'));
  const cells = Array.from(doc.getElementsByTagName('w:tc'));
  return { paragraphs, cells };
}

/** 统计节点前同类兄弟元素数量（按 nodeName 计数，跳过文本节点） */
function siblingIndex(node, nodeName) {
  let idx = 0;
  let p = node.previousSibling;
  while (p) {
    if (p.nodeName === nodeName) idx++;
    p = p.previousSibling;
  }
  return idx;
}

/** 找到节点前一个指定nodeName的兄弟元素 */
function prevSibling(node, nodeName) {
  let p = node.previousSibling;
  while (p) {
    if (p.nodeName === nodeName) return p;
    p = p.previousSibling;
  }
  return null;
}

/** 找最近的祖先元素 */
function closestAncestor(node, nodeName) {
  let p = node.parentNode;
  while (p && p.nodeName !== '#document') {
    if (p.nodeName === nodeName) return p;
    p = p.parentNode;
  }
  return null;
}

/**
 * 表格前一段文字（很多模板把"家庭成员情况"写在表格上一行，而不是表内）
 */
function precedingParagraphText(node) {
  let p = node.previousSibling;
  while (p) {
    if (p.nodeName === 'w:p') {
      const t = paragraphText(p).replace(/[\s\u3000]+/g, ' ').trim();
      if (t) return t.length <= 30 ? t : '';
    } else if (p.nodeName === 'w:tbl') {
      return '';
    }
    p = p.previousSibling;
  }
  return '';
}

/**
 * 计算每个表格单元格的 左邻/上邻/下邻/所属行 flat 索引，用于结构感知的候选检测与学习抽取
 */
function cellNeighbors(cells) {
  const idxOf = new Map(cells.map((c, j) => [c, j]));
  const result = new Map(); // flatIndex -> { leftTcId, aboveTcId, belowTcId, rowTrId, tblId }
  // w:tr / w:tbl 的扁平索引（用于行/表标识）
  const seenTr = new Set();
  const trList = [];
  const seenTbl = new Set();
  const tblList = [];
  for (const tc of cells) {
    const tr = closestAncestor(tc, 'w:tr');
    if (tr && !seenTr.has(tr)) { seenTr.add(tr); trList.push(tr); }
    const tbl = closestAncestor(tc, 'w:tbl');
    if (tbl && !seenTbl.has(tbl)) { seenTbl.add(tbl); tblList.push(tbl); }
  }
  const trIdx = new Map(trList.map((tr, i) => [tr, i]));
  const tblIdx = new Map(tblList.map((t, i) => [t, i]));
  // 每个表格的"前置标题文字"
  const tblPreceding = new Map(tblList.map((t, i) => [i, precedingParagraphText(t)]));

  for (let j = 0; j < cells.length; j++) {
    const tc = cells[j];
    const info = {};
    const tr = closestAncestor(tc, 'w:tr');
    const tbl = closestAncestor(tc, 'w:tbl');
    if (tr && trIdx.has(tr)) info.rowTrId = trIdx.get(tr);
    if (tbl && tblIdx.has(tbl)) {
      info.tblId = tblIdx.get(tbl);
      info.tblPreceding = tblPreceding.get(info.tblId) || '';
    }
    // 左邻：同一 w:tr 中前一个 w:tc
    const leftTc = prevSibling(tc, 'w:tc');
    if (leftTc && idxOf.has(leftTc)) info.leftTcId = `tc${idxOf.get(leftTc)}`;
    // 右邻：同一 w:tr 中下一个 w:tc
    const rightTc = nextSibling(tc, 'w:tc');
    if (rightTc && idxOf.has(rightTc)) info.rightTcId = `tc${idxOf.get(rightTc)}`;
    // 列号：按同行内 gridSpan 累加得到（处理合并列）
    let colIndex = 0;
    {
      let p = tc.previousSibling;
      const prev = [];
      while (p) {
        if (p.nodeName === 'w:tc') prev.unshift(p);
        p = p.previousSibling;
      }
      for (const q of prev) {
        const spans = q.getElementsByTagName('w:gridSpan');
        let s = 1;
        if (spans.length) {
          const v = parseInt(spans[0].getAttribute('w:val') || '1', 10);
          if (!isNaN(v)) s = v;
        }
        colIndex += s;
      }
    }
    info.colIndex = colIndex;
    // 是否跨列（gridSpan>1）：跨列单元格本身就是值区，值应写在本格内
    const spans = tc.getElementsByTagName('w:gridSpan');
    if (spans.length) {
      const v = parseInt(spans[0].getAttribute('w:val') || '1', 10);
      info.gridSpan = isNaN(v) ? 1 : v;
    }
    if (tr) {
      const pos = siblingIndex(tc, 'w:tc');
      // 上邻：上一个 w:tr 的同位置 w:tc
      const prevTr = prevSibling(tr, 'w:tr');
      if (prevTr) {
        const prevTcs = [];
        for (let i = 0; i < prevTr.childNodes.length; i++) {
          if (prevTr.childNodes[i].nodeName === 'w:tc') prevTcs.push(prevTr.childNodes[i]);
        }
        const above = prevTcs[pos];
        if (above && idxOf.has(above)) info.aboveTcId = `tc${idxOf.get(above)}`;
      }
      // 下邻：下一个 w:tr 的同位置 w:tc
      const nextTr = nextSibling(tr, 'w:tr');
      if (nextTr) {
        const nextTcs = [];
        for (let i = 0; i < nextTr.childNodes.length; i++) {
          if (nextTr.childNodes[i].nodeName === 'w:tc') nextTcs.push(nextTr.childNodes[i]);
        }
        const below = nextTcs[pos];
        if (below && idxOf.has(below)) info.belowTcId = `tc${idxOf.get(below)}`;
      }
    }
    result.set(j, info);
  }
  return result;
}

function nextSibling(node, nodeName) {
  let p = node.nextSibling;
  while (p) {
    if (p.nodeName === nodeName) return p;
    p = p.nextSibling;
  }
  return null;
}

/**
 * 解析 docx 文件为块列表
 * @param {string} filePath
 */
async function parse(filePath) {
  const buf = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  const xmlFile = zip.file('word/document.xml');
  if (!xmlFile) throw new Error('不是有效的 .docx 文件（缺少 word/document.xml）');
  const xml = await xmlFile.async('string');
  const doc = parseXml(xml);

  const { paragraphs, cells } = locateNodes(doc);
  const neighbors = cellNeighbors(cells);

  const blocks = [];
  // 非表格段落
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (insideTableCell(p)) continue; // 表格内段落由单元格块覆盖
    const text = paragraphText(p);
    blocks.push({
      id: `p${i}`,
      type: 'paragraph',
      text,
      isEmpty: text.trim() === '',
      context: { prevText: blocks.length ? blocks[blocks.length - 1].text.slice(0, 50) : '', inTable: false },
    });
  }
  // 表格单元格
  for (let j = 0; j < cells.length; j++) {
    const tc = cells[j];
    const text = cellText(tc);
    const nb = neighbors.get(j) || {};
    blocks.push({
      id: `tc${j}`,
      type: 'cell',
      text,
      isEmpty: text.trim() === '',
      context: {
        prevText: '',
        inTable: true,
        leftTcId: nb.leftTcId || null,
        rightTcId: nb.rightTcId || null,
        gridSpan: nb.gridSpan || 1,
        colIndex: nb.colIndex || 0,
        aboveTcId: nb.aboveTcId || null,
        belowTcId: nb.belowTcId || null,
        rowTrId: nb.rowTrId != null ? nb.rowTrId : null,
        tblId: nb.tblId != null ? nb.tblId : null,
        tblPreceding: nb.tblPreceding || '',
      },
    });
  }

  return { blocks, docRef: { xml } };
}

/**
 * 写回填充值
 * @param {string} srcPath 原文件
 * @param {string} outPath 输出文件
 * @param {Array<{id:string, value:string}>} values
 * @param {Map<string, {placeholder: string|null, placeholderSpan?: {start,end}, mode:'inline'|'cell'}>} placements
 *   - inline: 在块文本中替换 placeholder（或在冒号后追加，placeholder 为 ''）
 *   - cell:   整格写入（清空原内容，写入新值）
 */
async function applyValues(srcPath, outPath, values, placements) {
  const buf = fs.readFileSync(srcPath);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  const doc = parseXml(xml);
  const { paragraphs, cells } = locateNodes(doc);
  const fallbackRPr = documentRPr(doc); // 全文兜底字体

  for (const { id, value } of values) {
    const placement = placements.get(id);
    if (!placement) continue;

    if (id.startsWith('p')) {
      const p = paragraphs[parseInt(id.slice(1), 10)];
      if (!p) continue;
      if (placement.mode === 'cell') {
        // 整段替换：清空所有 run，仅首个 run 写入新值
        const runs = paragraphRuns(p);
        const styleRPr = paragraphRPr(p) || fallbackRPr;
        if (runs.length === 0) {
          p.appendChild(createRun(doc, value || '', styleRPr));
        } else {
          ensureRunRPr(runs[0].node, styleRPr);
          setRunText(runs[0].node, value || '');
          for (let i = 1; i < runs.length; i++) {
            const ts = runs[i].node.getElementsByTagName('w:t');
            for (let k = 0; k < ts.length; k++) setTText(ts[k], '');
          }
        }
      } else {
        const merged = paragraphText(p);
        const span = placement.placeholder ? findSpan(merged, placement.placeholder) : null;
        writeParagraphValue(p, span, value, fallbackRPr);
      }
    } else if (id.startsWith('tc')) {
      const tc = cells[parseInt(id.slice(2), 10)];
      if (!tc) continue;
      const ps = cellParagraphs(tc);
      if (!ps.length) continue;
      // 空格的字体：优先取本格段落标记 → 同行相邻格 → 上下行同列 → 全文
      const cellStyleRPr = styleSourceForCell(tc, fallbackRPr);

      if (placement.mode === 'cell') {
        // 整格替换：第一段写值，其余段清空文本
        const firstP = ps[0];
        const styleRPr = paragraphRPr(firstP) || cellStyleRPr || fallbackRPr;
        const runs = paragraphRuns(firstP);
        if (runs.length === 0) {
          firstP.appendChild(createRun(doc, value || '', styleRPr));
        } else {
          ensureRunRPr(runs[0].node, styleRPr);
          setRunText(runs[0].node, value || '');
          for (let i = 1; i < runs.length; i++) {
            const ts = runs[i].node.getElementsByTagName('w:t');
            for (let k = 0; k < ts.length; k++) setTText(ts[k], '');
          }
        }
        for (let i = 1; i < ps.length; i++) {
          const runs2 = paragraphRuns(ps[i]);
          for (const r of runs2) {
            const ts = r.node.getElementsByTagName('w:t');
            for (let k = 0; k < ts.length; k++) setTText(ts[k], '');
          }
        }
      } else {
        // inline：优先在能命中占位符的段落执行，否则在最后一段追加
        let done = false;
        if (placement.placeholder) {
          for (const p of ps) {
            const merged = paragraphText(p);
            const span = findSpan(merged, placement.placeholder);
            if (span) {
              writeParagraphValue(p, span, value, cellStyleRPr);
              done = true;
              break;
            }
          }
        }
        if (!done) {
          const target = ps[ps.length - 1];
          const merged = paragraphText(target);
          const appendSpan = placement.placeholder ? findSpan(merged, placement.placeholder) : null;
          writeParagraphValue(target, appendSpan, value, cellStyleRPr);
        }
      }
    }
  }

  // 序列化写回（保留原 XML 声明）
  let outXml = new XMLSerializer().serializeToString(doc);
  if (!outXml.startsWith('<?xml')) {
    outXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + outXml;
  }
  zip.file('word/document.xml', outXml);

  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outPath, outBuf);
}

module.exports = { parse, applyValues, parseXml };
