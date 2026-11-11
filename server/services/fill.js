/**
 * 填充编排 - 分析流水线与写回
 *
 * 分析流程：
 *   1. 按格式解析文档 → 块列表
 *   2. 规则预筛候选填充位
 *   3. AI 精判（可用时）：确认是否需要填、规范字段名、并从知识库条目中选值（禁止编造）
 *   4. 知识库三级检索填充：精确 > 包含 > 模糊（优先级高于 AI，避免幻觉）
 *   5. 日期类字段自动填充当天
 *   6. 输出字段列表供用户确认
 *
 * 应用流程：按用户确认的值写回文件 → 输出到 outputs/
 */
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const ai = require('./ai');
const knowledge = require('./knowledge');
const detector = require('./detector');
const parseXlsx = require('./parseXlsx');
const parseDocx = require('./parseDocx');
const tables = require('./tables');

const JOBS_FILE = 'jobs.json';
const AI_BATCH_SIZE = 25;

// ---------- 任务存储 ----------

function listJobs() {
  return storage.readJson(JOBS_FILE, {});
}

function saveJobs(jobs) {
  storage.writeJson(JOBS_FILE, jobs);
}

function getJob(jobId) {
  return listJobs()[jobId] || null;
}

function updateJob(jobId, patch) {
  const jobs = listJobs();
  if (!jobs[jobId]) return null;
  jobs[jobId] = { ...jobs[jobId], ...patch };
  saveJobs(jobs);
  return jobs[jobId];
}

function createJob({ fileName, fileType, profileId }) {
  const id = crypto.randomUUID();
  const jobs = listJobs();
  jobs[id] = {
    id,
    status: 'analyzing', // analyzing | ready | applied | error
    fileName,
    fileType,
    profileId,
    createdAt: new Date().toISOString(),
    error: null,
    aiUsed: false,
    aiMessage: '',
    fields: [],
    outputPath: null,
  };
  saveJobs(jobs);
  return jobs[id];
}

// ---------- 工具 ----------

function todayString(override) {
  // 优先用浏览器传来的日期（避免服务器时区与访问者不一致）
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(String(override))) return String(override);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isDateField(label) {
  const s = String(label || '');
  // 有专属含义的日期/时间，绝不自动填今天
  if (/出生|入党|入职|离职|毕业|入学|结婚|签订|合同|截止|起始|终止|期限|有效期|发放|到货|交付|办理|缴费|考试|成立|注册/.test(s)) return false;
  // 只有"表单类日期"才自动填当天：填表日期、申报日期、报名时间…
  if (/填表|填报|申报|申请|提交|报送|制表|打印|签署|报名/.test(s) && /日期|时间/.test(s)) return true;
  return /^(日期|时间)$/.test(s.trim());
}

function isLongTextField(label) {
  return /简介|摘要|描述|说明|内容|理由|背景|目标|方案|介绍/.test(label);
}

/** 解析任意支持格式 */
async function parseAny(filePath, fileType) {
  if (fileType === 'xlsx') return parseXlsx.parse(filePath);
  if (fileType === 'docx') return parseDocx.parse(filePath);
  throw new Error(`不支持的文件类型: ${fileType}`);
}

/** 为候选生成写回方式描述 */
function placementOf(cand) {
  if (cand.kind === 'underline' || cand.kind === 'blank-parens') {
    return { mode: 'inline', placeholder: cand.placeholder };
  }
  if (cand.kind === 'after-colon') {
    return { mode: 'inline', placeholder: '' };
  }
  return { mode: 'cell', placeholder: null }; // label-cell / header-col：整格写
}

// ---------- AI 分析（分批） ----------

/**
 * AI 精判 + 知识库选值（一次调用同时完成），返回 Map<candidateId, {fieldName, needFill, value, confidence}>
 * AI 不可用/失败返回空 Map
 */
async function aiAnalyzeBatch(cands, kbEntries, fileName) {
  const result = new Map();
  if (!cands.length) return result;
  if (!ai.isAiEnabled() || !kbEntries.length) return result;

  const kbCompact = kbEntries.slice(0, 150).map((e) => ({
    fieldName: e.fieldName,
    value: e.value,
    aliases: e.aliases || [],
  }));

  const KIND_HINT = {
    'underline': '下划线占位处，需要填',
    'blank-parens': '空括号处，需要填',
    'after-colon': '冒号后的空白处，需要填',
    'label-cell': '表格中标签右侧/下方的空格，需要填',
    'header-col': '表格列头下方的空格，需要填',
  };

  const system = `你是中文文档自动填写助手。用户上传了一个待填写文档，系统已从中预筛出候选填充位置。你的任务：
1. 判断每个候选位置是否真的需要填写（needFill）：kind 为 underline / blank-parens / after-colon / label-cell / header-col 的都是空白待填格，通常为 true；只有明显是标题、说明文字、固定措辞的才为 false。
2. 给出规范字段名 fieldName（如：姓名、性别、联系电话、电子邮箱、工作单位、项目名称、项目简介、填表日期）。
3. 从 knowledge 列表中为该字段选值 value：只能【逐字复制】knowledge 中的 value，禁止修改、拼接或编造任何内容；找不到合适值时 value 为 null。
4. 简短字段（姓名/电话等）正常填；长文本字段（简介/说明类）如果 knowledge 里没有对应长文本，value 为 null。
5. confidence 为 0~1 之间的数表示把握。

只输出 JSON 数组，不要任何其他文字：
[{"id":"c1","fieldName":"姓名","needFill":true,"value":"张三","confidence":0.95}]`;

  for (let i = 0; i < cands.length; i += AI_BATCH_SIZE) {
    const batch = cands.slice(i, i + AI_BATCH_SIZE);
    const payload = batch.map((c) => ({
      id: c.id,
      kind: c.kind,
      position: KIND_HINT[c.kind] || '',
      label: c.label,
      text: (c.previewText || c.originalText || '').slice(0, 60),
      ...(c.sheetName ? { sheet: c.sheetName, address: c.address } : {}),
    }));
    const answer = await ai.chatJson(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `文档名：${fileName}\nknowledge：${JSON.stringify(kbCompact)}\n候选位置：${JSON.stringify(payload)}`,
        },
      ],
      { temperature: 0.1, maxTokens: 4000 }
    );
    if (!Array.isArray(answer)) continue;
    for (const item of answer) {
      if (item && item.id && batch.some((c) => c.id === item.id)) {
        result.set(item.id, {
          fieldName: String(item.fieldName || '').trim(),
          needFill: item.needFill !== false,
          value: item.value == null ? null : String(item.value),
          confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
        });
      }
    }
  }
  return result;
}

// ---------- 主分析流程 ----------

async function analyzeJob(jobId, kbEntriesInput, opts = {}) {
  const job = getJob(jobId);
  if (!job) throw new Error('任务不存在');
  try {
    const srcPath = path.join(storage.UPLOAD_DIR, jobId, job.fileName);
    const { blocks } = await parseAny(srcPath, job.fileType);

    // 1. 知识库条目：优先用请求里带来的（浏览器本地知识库），不落盘
    const kbEntries = Array.isArray(kbEntriesInput)
      ? kbEntriesInput
      : (job.profileId ? knowledge.listEntries(job.profileId) : []);
    const kbTables = kbEntries.filter((e) => e.type === 'table');

    // 2. 明细表整表填充（学习/工作/家庭经历等）：按列名匹配，逐格写入
    const tablePlan = tables.planTableFill(blocks, kbTables);

    // 3. 规则预筛（排除已被明细表占用的格子）
    let candidates = detector.detectCandidates(blocks)
      .filter((c) => !tablePlan.usedBlockIds.has(c.blockId));

    // 4. AI 精判（可用时）
    let aiResult = new Map();
    if (ai.isAiEnabled() && candidates.length) {
      aiResult = await aiAnalyzeBatch(candidates, kbEntries, job.fileName);
    }

    // 4. 逐候选确定填充值：知识库三级检索优先，其次 AI，再次日期自动
    const fields = [];
    const usedKbEntryIds = new Set(); // 同一条目不重复填到多个字段（长文本除外）
    for (const cand of candidates) {
      const a = aiResult.get(cand.id) || {};
      const fieldName = a.fieldName || cand.label;
      let value = null;
      let source = 'none';
      let confidence = 0;
      let sourceDetail = '';

      // 4.1 知识库检索
      const m = knowledge.matchLabel(fieldName, kbEntries) || knowledge.matchLabel(cand.label, kbEntries);
      if (m && m.entry && String(m.entry.value || '').trim()) {
        // 长文本字段允许复用；短字段避免同一条目重复填多格
        const isLong = isLongTextField(fieldName) || isLongTextField(m.entry.fieldName);
        if (isLong || !usedKbEntryIds.has(m.entry.id)) {
          value = String(m.entry.value);
          source = m.method; // kb-exact | kb-contains | kb-fuzzy
          confidence = m.score;
          sourceDetail = m.entry.fieldName;
          if (!isLong) usedKbEntryIds.add(m.entry.id);
        }
      }

      // 4.2 AI 建议值（仅当知识库未命中）
      if (value == null && a.value && a.needFill) {
        value = a.value;
        source = 'ai';
        confidence = a.confidence || 0.6;
      }

      // 4.3 日期自动
      if (value == null && a.needFill !== false && (isDateField(fieldName) || isDateField(cand.label))) {
        value = todayString(opts.today);
        source = 'auto-date';
        confidence = 0.9;
      }

      // 知识库精确/同义命中是强信号：即便 AI 判为不必填，也保留（用户仍可取消勾选）
      let needFill = a.needFill !== false;
      if (!needFill && value != null && (source === 'kb-exact' || source === 'kb-synonym')) {
        needFill = true;
      }

      fields.push({
        id: cand.id,
        blockId: cand.blockId,
        fieldName,
        label: cand.label,
        kind: cand.kind,
        placeholder: cand.placeholder || '',
        location: cand.sheetName
          ? `${cand.sheetName}!${cand.address}`
          : (cand.previewText || cand.originalText).slice(0, 30),
        preview: (cand.previewText || cand.originalText || '').slice(0, 50),
        needFill,
        value,
        source,
        confidence: Math.round(confidence * 100) / 100,
        sourceDetail,
      });
    }

    const aiUsed = aiResult.size > 0;
    // 明细表填充结果排在最前（它们按表格顺序生成，便于阅读）
    const allFields = tablePlan.fields.concat(fields);
    const tableRowCount = tablePlan.fields.length;
    const aiNote = aiUsed
      ? `AI 已分析 ${candidates.length} 个候选位置`
      : ai.isAiEnabled()
        ? 'AI 未返回有效结果，仅使用知识库规则匹配'
        : '未配置 AI（可在设置页配置），仅使用知识库规则匹配';
    updateJob(jobId, {
      status: 'ready',
      fields: allFields,
      aiUsed,
      aiMessage: tableRowCount
        ? `${aiNote}；另从知识库匹配到明细表 ${tableRowCount} 个单元格`
        : aiNote,
    });
  } catch (err) {
    console.error(`[fill] 任务 ${jobId} 分析失败:`, err);
    updateJob(jobId, { status: 'error', error: err.message });
  }
}

// ---------- 写回 ----------

/**
 * 按用户确认的值写回文件
 * @param {string} jobId
 * @param {Array<{id:string, value:string, needFill:boolean}>} values
 * @returns {{ outputPath, fileName }}
 */
async function applyJob(jobId, values) {
  const job = getJob(jobId);
  if (!job) throw new Error('任务不存在');
  if (job.status !== 'ready') throw new Error('任务状态不可写回');

  const srcPath = path.join(storage.UPLOAD_DIR, jobId, job.fileName);
  const outDir = path.join(storage.OUTPUT_DIR, jobId);
  if (!require('fs').existsSync(outDir)) require('fs').mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, job.fileName);

  // 由任务中保存的候选信息还原写回方式（按 blockId 索引）
  const placements = new Map();
  for (const f of job.fields) {
    placements.set(f.blockId, placementOf({ kind: f.kind, placeholder: f.placeholder || '' }));
  }
  // 候选 id → 块 id
  const blockIdOf = new Map(job.fields.map((f) => [f.id, f.blockId]));

  const toApply = (values || [])
    .filter((v) => v.needFill && v.value != null && String(v.value).trim() !== '')
    .map((v) => ({ id: blockIdOf.get(v.id), value: String(v.value) }))
    .filter((v) => v.id);

  if (job.fileType === 'xlsx') {
    await parseXlsx.applyValues(srcPath, outPath, toApply, placements);
  } else {
    await parseDocx.applyValues(srcPath, outPath, toApply, placements);
  }

  // 写回完成后删除上传原件（服务器不留用户文档）
  storage.safeRemove(path.dirname(srcPath));

  updateJob(jobId, { status: 'applied', outputPath: outPath, appliedCount: toApply.length });
  return { outputPath: outPath, fileName: job.fileName, appliedCount: toApply.length };
}

module.exports = {
  createJob,
  getJob,
  updateJob,
  analyzeJob,
  applyJob,
  placementOf,
  todayString,
  isDateField,
};
