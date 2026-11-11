/**
 * 知识库路由（仅保留只读接口 + 抽取接口）
 *
 * 架构说明：知识库内容保存在访问者浏览器（localStorage），服务端不落盘。
 * - GET  /api/profiles            仅用于把旧版本服务端知识库一次性迁移到浏览器
 * - GET  /api/profiles/:id/entries 同上
 * - POST /api/kb/learn            只做"文件 → 字段"抽取，返回结果后立即删除原件
 * 所有写入接口已停用，防止知识数据被上传到服务器。
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const storageSvc = require('../services/storage');
const knowledge = require('../services/knowledge');
const learn = require('../services/learn');

const router = express.Router();

// 上传临时目录（学习用，处理完即删）
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(storageSvc.UPLOAD_DIR, '_learn');
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

// ---------- 只读：用于旧数据迁移 ----------

router.get('/api/profiles', (req, res) => {
  res.json({ profiles: knowledge.listProfiles() });
});

router.get('/api/profiles/:id/entries', (req, res) => {
  const p = knowledge.getProfile(req.params.id);
  if (!p) return res.status(404).json({ error: '档案不存在' });
  res.json({ entries: knowledge.listEntries(req.params.id) });
});

// ---------- 写入接口已停用 ----------

const DISABLED_MSG = '知识库已改为保存在浏览器本地，服务器不再接收知识数据。请在「知识库」页面操作。';

router.post('/api/profiles', (req, res) => res.status(410).json({ error: DISABLED_MSG }));
router.put('/api/profiles/:id', (req, res) => res.status(410).json({ error: DISABLED_MSG }));
router.delete('/api/profiles/:id', (req, res) => res.status(410).json({ error: DISABLED_MSG }));
router.post('/api/profiles/:id/entries', (req, res) => res.status(410).json({ error: DISABLED_MSG }));
router.put('/api/profiles/:id/entries/:entryId', (req, res) => res.status(410).json({ error: DISABLED_MSG }));
router.delete('/api/profiles/:id/entries/:entryId', (req, res) => res.status(410).json({ error: DISABLED_MSG }));

// ---------- 学习：抽取字段（结果交给浏览器保存） ----------

router.post('/api/kb/learn', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const originalName = storageSvc.decodeFileName(req.file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    const fileType = ext === '.xlsx' ? 'xlsx' : 'docx';

    const result = await learn.learnFromFile(req.file.path, fileType);
    res.json({
      ok: true,
      fileName: originalName,
      pairs: result.pairs,
      tables: result.tables || [],
      normalized: result.normalized,
      aiUsed: result.aiUsed,
      method: result.method,
    });
  } catch (err) {
    console.error('[kb/learn] 失败:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // 学习只做抽取，原件用完即删
    if (req.file && req.file.path) storageSvc.safeRemove(req.file.path);
  }
});

module.exports = router;
