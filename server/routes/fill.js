/**
 * 填充路由 - 上传模板创建任务、轮询、确认写回、下载
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const storageSvc = require('../services/storage');
const fill = require('../services/fill');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // 先放临时目录，任务创建后移动
      const dir = path.join(storageSvc.UPLOAD_DIR, '_incoming');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = storageSvc.decodeFileName(file.originalname);
      cb(null, crypto.randomUUID().slice(0, 8) + '_' + safe);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(storageSvc.decodeFileName(file.originalname)).toLowerCase();
    if (ext === '.docx' || ext === '.xlsx') cb(null, true);
    else cb(new Error('仅支持 .docx / .xlsx 文件（.doc/.xls 请先另存为新格式）'));
  },
});

// 上传模板 → 创建填充任务（后台异步分析）
// 知识库由前端放在 `kb` 字段里随请求发送，服务端只做内存处理、不落盘
router.post('/api/fill', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const originalName = storageSvc.decodeFileName(req.file.originalname);
    const ext = path.extname(originalName).toLowerCase();

    let kbEntries = [];
    if (req.body && req.body.kb) {
      try {
        const parsed = JSON.parse(req.body.kb);
        if (Array.isArray(parsed)) kbEntries = parsed;
      } catch (e) {
        console.warn('[fill] kb 字段解析失败，按空知识库处理');
      }
    }

    const job = fill.createJob({
      fileName: originalName,
      fileType: ext === '.xlsx' ? 'xlsx' : 'docx',
      profileId: null,
    });

    // 建立任务目录并移动文件
    const jobDir = path.join(storageSvc.UPLOAD_DIR, job.id);
    fs.mkdirSync(jobDir, { recursive: true });
    const dest = path.join(jobDir, job.fileName);
    fs.renameSync(req.file.path, dest);

    // 异步分析（知识库只在本次进程内存中使用）
    fill.analyzeJob(job.id, kbEntries).catch((err) => console.error('[fill] 异步分析异常:', err));

    res.json({ ok: true, jobId: job.id });
  } catch (err) {
    console.error('[fill] 创建任务失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 轮询任务状态
router.get('/api/jobs/:id', (req, res) => {
  const job = fill.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({ job });
});

// 确认写回
router.post('/api/jobs/:id/apply', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { values } = req.body || {};
    if (!Array.isArray(values)) return res.status(400).json({ error: 'values 必须是数组' });
    const result = await fill.applyJob(req.params.id, values);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[fill] 写回失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 下载填充结果
router.get('/api/jobs/:id/download', (req, res) => {
  const job = fill.getJob(req.params.id);
  if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: '填充结果不存在，请先确认生成' });
  }
  res.download(job.outputPath, job.fileName, (err) => {
    if (err) {
      console.error('[fill] 下载失败:', err.message);
      return;
    }
    // 下载完成后延迟删除结果文件，避免用户文档在服务器上长期留存
    const outPath = job.outputPath;
    setTimeout(() => storageSvc.safeRemove(outPath), 10 * 60 * 1000).unref();
  });
});

module.exports = router;
