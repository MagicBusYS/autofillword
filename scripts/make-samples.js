/**
 * 生成测试样例文件（可重复运行）
 * 用法: node scripts/make-samples.js
 *
 * 产出 samples/ 下：
 *   项目申报书模板.docx        空白 Word 模板（下划线/括号/表格）
 *   项目申报书_已填写.docx      已填写 Word（用于知识库学习）
 *   项目申报表模板.xlsx        空白 Excel 模板（标签格 + 表头列）
 *   项目申报表_已填写.xlsx      已填写 Excel（用于知识库学习）
 *   应聘人员登记表模板.xlsx     另一种格式的 Excel 模板（跨模板复用测试）
 */
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'samples');

// ============ Word ============

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function run(text, opts = {}) {
  const rPr = opts.bold ? '<w:rPr><w:b/></w:rPr>' : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}
function p(content) {
  return `<w:p>${content}</w:p>`;
}
function tc(content) {
  // 纯文本自动包 run；已是标记的不再包
  const inner = typeof content === 'string' && !content.startsWith('<w:') ? run(content) : content;
  return `<w:tc>${p(inner)}</w:tc>`;
}
function tr(cells) {
  return `<w:tr>${cells.map(tc).join('')}</w:tr>`;
}

function buildDocXml(filled) {
  const v = filled
    ? {
        project: '基于AI的文档自动填充系统',
        applicant: '张三',
        phone: '13800138000',
        email: 'zhangsan@example.com',
        name: '张三',
        unit: '某科技有限公司',
        title: '高级工程师',
        edu: '硕士研究生',
        school: '某某大学',
        intro: '本项目研发一套智能文档填充系统，支持 Word 与 Excel 格式，自动识别待填位置并从知识库匹配内容。',
        date: '2026-11-01',
      }
    : {
        project: '____________',
        applicant: '（            ）',
        phone: '',
        email: '____________',
        name: '',
        unit: '',
        title: '',
        edu: '',
        school: '',
        intro: '________________________________',
        date: '',
      };

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${p(run('科技创新项目申报书', { bold: true }))}
${p(run('一、基本信息', { bold: true }))}
${p(run('项目名称：' + v.project))}
${p(run('申请人：' + v.applicant))}
${p(run('联系电话：' + v.phone))}
${p(run('电子邮箱：' + v.email))}
${p(run('二、项目信息', { bold: true }))}
<w:tbl>
  ${tr([run('姓名', { bold: true }), run('性别', { bold: true }), run('工作单位', { bold: true }), run('职称', { bold: true })])}
  ${tr([v.name, '□男 □女', v.unit, v.title])}
  ${tr(['学历：', v.edu, '毕业院校：', v.school])}
</w:tbl>
${p(run('三、项目简介'))}
${p(run('（请在此填写项目简介：' + v.intro + '）'))}
${p(run('填表日期：' + v.date))}
</w:body>
</w:document>`;
}

async function makeDocx(outPath, filled) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CT);
  zip.folder('_rels').file('.rels', RELS);
  zip.folder('word').file('document.xml', buildDocXml(filled));
  fs.writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer' }));
}

// ============ Excel ============

/** 项目申报表：标签格在左、值格在右；另有一行"表头 + 数据行" */
async function makeXlsxProject(outPath, filled) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('申报表');
  ws.columns = [{ width: 16 }, { width: 22 }, { width: 16 }, { width: 22 }];

  ws.getCell('A1').value = '科技创新项目申报书';
  ws.mergeCells('A1:D1');
  ws.getCell('A1').font = { bold: true, size: 16 };
  ws.getCell('A1').alignment = { horizontal: 'center' };

  const v = filled
    ? {
        project: '智能客服系统研发',
        applicant: '张三',
        phone: '13800138000',
        email: 'zhangsan@example.com',
        name: '张三',
        unit: '某科技有限公司',
        title: '高级工程师',
        edu: '硕士研究生',
        intro: '研发一套面向中小企业的智能客服系统，支持多轮对话与知识库检索。',
        date: '2026-11-01',
      }
    : {
        project: '', applicant: '', phone: '', email: '', name: '', unit: '', title: '', edu: '', intro: '', date: '',
      };

  ws.getCell('A2').value = '项目名称：'; ws.getCell('B2').value = v.project;
  ws.mergeCells('B2:D2');
  ws.getCell('A3').value = '申请人：';   ws.getCell('B3').value = v.applicant;
  ws.getCell('C3').value = '联系电话：'; ws.getCell('D3').value = v.phone;
  ws.getCell('A4').value = '电子邮箱：'; ws.getCell('B4').value = v.email;
  ws.mergeCells('B4:D4');

  const headers = ['姓名', '工作单位', '职称', '学历'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(6, i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FF' } };
  });
  const values = [v.name, v.unit, v.title, v.edu];
  values.forEach((val, i) => { ws.getCell(7, i + 1).value = val; });

  ws.getCell('A9').value = '项目简介：'; ws.getCell('B9').value = v.intro;
  ws.mergeCells('B9:D9');
  ws.getCell('A10').value = '填表日期：'; ws.getCell('B10').value = v.date;
  ws.mergeCells('B10:D10');

  await wb.xlsx.writeFile(outPath);
}

/** 应聘登记表：标签与值并列，格式不同但字段相似 */
async function makeXlsxResume(outPath) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('应聘登记');
  ws.columns = [{ width: 18 }, { width: 24 }, { width: 18 }, { width: 24 }];

  ws.getCell('A1').value = '应聘人员登记表';
  ws.mergeCells('A1:D1');
  ws.getCell('A1').font = { bold: true, size: 15 };
  ws.getCell('A1').alignment = { horizontal: 'center' };

  const layout = [
    ['填报人：', '性别：'],
    ['手机号码：', '出生日期：'],
    ['电子邮箱：', '毕业院校：'],
    ['应聘岗位：', '最高学历：'],
  ];
  layout.forEach((pair, i) => {
    ws.getCell(i + 3, 1).value = pair[0];
    ws.getCell(i + 3, 3).value = pair[1];
  });
  ws.getCell('A8').value = '个人简介：';
  await wb.xlsx.writeFile(outPath);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  await makeDocx(path.join(OUT_DIR, '项目申报书模板.docx'), false);
  await makeDocx(path.join(OUT_DIR, '项目申报书_已填写.docx'), true);
  await makeXlsxProject(path.join(OUT_DIR, '项目申报表模板.xlsx'), false);
  await makeXlsxProject(path.join(OUT_DIR, '项目申报表_已填写.xlsx'), true);
  await makeXlsxResume(path.join(OUT_DIR, '应聘人员登记表模板.xlsx'));

  console.log('已生成样例文件：');
  for (const f of fs.readdirSync(OUT_DIR)) console.log('  samples/' + f);
}

main().catch((e) => { console.error(e); process.exit(1); });
