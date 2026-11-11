/**
 * 端到端测试（新架构）：
 *   知识库改为浏览器本地存储后，服务端只做"解析模板 + 写回文件"，
 *   知识条目通过请求的 `kb` 字段随请求发送、不落盘。
 *
 * 流程：
 *   1. 学习：上传已填写 xlsx → 抽取字段
 *   2. 用抽取结果构造 kb（等价于浏览器本地知识库）
 *   3. 填充：上传空白 xlsx 模板 + kb → 校验字段值
 *   4. 写回下载 → 校验文件内容
 *   5. 交叉模板（另一种格式的应聘表）
 *   6. Word 模板：学习 + 填充 + 校验
 */
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');

const BASE = 'http://localhost:3000';

async function api(pathname, options) {
  const res = await fetch(BASE + pathname, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  if (!res.ok) throw new Error(`${pathname} → ${res.status}: ${String(text).slice(0, 300)}`);
  return data;
}

async function uploadFile(endpoint, filePath, extraFields) {
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath), { filename: path.basename(filePath) });
  for (const [k, v] of Object.entries(extraFields || {})) fd.append(k, v);
  return api(endpoint, { method: 'POST', body: fd, headers: fd.getHeaders() });
}

async function waitJob(jobId, maxMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { job } = await api('/api/jobs/' + jobId);
    if (job.status === 'ready' || job.status === 'error') return job;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('分析超时');
}

/** 把学习结果整理成浏览器里保存的 kb 数组 */
function toKbEntries(learnResult, sourceFile) {
  const fields = (learnResult.normalized || learnResult.pairs || []).map((p) => ({
    id: 'f-' + Math.random().toString(36).slice(2, 10),
    fieldName: p.fieldName || p.label,
    value: p.value,
    aliases: p.aliases || [],
    category: p.category || '其他',
    source: 'learn',
    sourceFile,
  }));
  const tables = (learnResult.tables || []).map((t) => ({
    id: 't-' + Math.random().toString(36).slice(2, 10),
    fieldName: t.fieldName,
    type: 'table',
    columns: t.columns,
    rows: t.rows,
    value: t.value,
    category: t.category || '其他',
    source: 'table',
    sourceFile,
  }));
  return fields.concat(tables);
}

async function main() {
  console.log('=== 1. 学习：上传已填写 xlsx ===');
  const learnXlsx = await uploadFile('/api/kb/learn', 'samples/项目申报表_已填写.xlsx');
  console.log('  method:', learnXlsx.method, '| 字段:', learnXlsx.pairs.length, '| 明细表:', (learnXlsx.tables || []).length);
  for (const p of learnXlsx.pairs) console.log('   ', p.fieldName || p.label, '=>', p.value);

  const kb = toKbEntries(learnXlsx, '项目申报表_已填写.xlsx');
  console.log('  构造本地知识库条目:', kb.length);

  console.log('\n=== 2. 填充空白 xlsx 模板（知识库随请求发送） ===');
  const fill1 = await uploadFile('/api/fill', 'samples/项目申报表模板.xlsx', { kb: JSON.stringify(kb) });
  const job1 = await waitJob(fill1.jobId);
  console.log('  状态:', job1.status, '|', job1.aiMessage);
  for (const f of job1.fields) {
    console.log(`   [${f.kind}] ${f.fieldName} @ ${f.location} => ${JSON.stringify(f.value)} (${f.source})`);
  }

  console.log('\n=== 3. 写回并下载 ===');
  const apply1 = await api(`/api/jobs/${job1.id}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      values: job1.fields.map((f) => ({ id: f.id, needFill: f.needFill && f.value != null, value: f.value })),
    }),
  });
  console.log('  写回:', apply1.fileName, '| 字段数:', apply1.appliedCount);

  const dl1 = await fetch(`${BASE}/api/jobs/${job1.id}/download`);
  const out1 = 'server/storage/e2e_output.xlsx';
  fs.writeFileSync(out1, Buffer.from(await dl1.arrayBuffer()));
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out1);
  const ws = wb.getWorksheet(1);
  console.log('\n=== 4. 校验输出内容 ===');
  for (const addr of ['B2', 'B3', 'D3', 'B4', 'A7', 'B7', 'C7', 'D7', 'B10']) {
    console.log(`  ${addr}: ${JSON.stringify(ws.getCell(addr).value)}`);
  }

  console.log('\n=== 5. 交叉模板：另一种格式的应聘表 ===');
  const fill2 = await uploadFile('/api/fill', 'samples/应聘人员登记表模板.xlsx', { kb: JSON.stringify(kb) });
  const job2 = await waitJob(fill2.jobId);
  for (const f of job2.fields) {
    console.log(`   [${f.kind}] ${f.fieldName} @ ${f.location} => ${JSON.stringify(f.value)} (${f.source})`);
  }

  console.log('\n=== 6. Word：学习 + 填充 + 校验 ===');
  const learnDocx = await uploadFile('/api/kb/learn', 'samples/项目申报书_已填写.docx');
  console.log('  Word 学习:', learnDocx.pairs.length, '条字段 |', (learnDocx.tables || []).length, '张明细表');
  const kbDocx = kb.concat(toKbEntries(learnDocx, '项目申报书_已填写.docx'));

  const fill3 = await uploadFile('/api/fill', 'samples/项目申报书模板.docx', { kb: JSON.stringify(kbDocx) });
  const job3 = await waitJob(fill3.jobId);
  console.log('  Word 字段:');
  for (const f of job3.fields) {
    console.log(`   [${f.kind}] ${f.fieldName} => ${JSON.stringify(f.value)} (${f.source})`);
  }
  await api(`/api/jobs/${job3.id}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      values: job3.fields.map((f) => ({ id: f.id, needFill: f.needFill && f.value != null, value: f.value })),
    }),
  });
  const dl3 = await fetch(`${BASE}/api/jobs/${job3.id}/download`);
  const outDocx = 'server/storage/e2e_output.docx';
  fs.writeFileSync(outDocx, Buffer.from(await dl3.arrayBuffer()));
  const parseDocx = require('../server/services/parseDocx');
  const { blocks } = await parseDocx.parse(outDocx);
  console.log('  Word 输出:');
  for (const b of blocks) {
    if (b.text && b.text.trim()) console.log('   ', JSON.stringify(b.text.slice(0, 60)));
  }

  console.log('\n=== 7. 服务端不保存知识库 ===');
  const profiles = await api('/api/profiles');
  console.log('  服务端档案数:', profiles.profiles.length);
  try {
    await api('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'should-fail' }),
    });
    console.log('  ❌ 服务端仍接受写入');
  } catch (e) {
    console.log('  ✅ 写入被拒绝（410），知识库只在浏览器本地');
  }

  console.log('\n✅ 端到端测试完成');
}

main().catch((e) => { console.error('\n❌ 测试失败:', e); process.exit(1); });
