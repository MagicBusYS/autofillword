/* 填充工作台前端逻辑 */
(function () {
  'use strict';

  var state = { jobId: null, job: null, timer: null };

  var els = {
    stepUpload: document.getElementById('step-upload'),
    stepAnalyzing: document.getElementById('step-analyzing'),
    stepConfirm: document.getElementById('step-confirm'),
    stepDone: document.getElementById('step-done'),
    profileSelect: document.getElementById('profile-select'),
    uploadZone: document.getElementById('upload-zone'),
    fileInput: document.getElementById('file-input'),
    fieldsTbody: document.getElementById('fields-tbody'),
    aiMessage: document.getElementById('ai-message'),
    statText: document.getElementById('stat-text'),
    onlyFillable: document.getElementById('only-fillable'),
    btnApply: document.getElementById('btn-apply'),
    btnRestart: document.getElementById('btn-restart'),
    btnAgain: document.getElementById('btn-again'),
    btnDownload: document.getElementById('btn-download'),
    doneText: document.getElementById('done-text'),
  };

  var SOURCE_LABEL = {
    'kb-exact': ['知识库·精确', 'src-kb-exact'],
    'kb-synonym': ['知识库·同义', 'src-kb-exact'],
    'kb-contains': ['知识库·匹配', 'src-kb-contains'],
    'kb-fuzzy': ['知识库·模糊', 'src-kb-fuzzy'],
    'kb-table': ['知识库·明细表', 'src-kb-exact'],
    'ai': ['AI 填充', 'src-ai'],
    'auto-date': ['自动·日期', 'src-auto-date'],
    'none': ['待填写', 'src-none'],
  };

  function show(step) {
    [els.stepUpload, els.stepAnalyzing, els.stepConfirm, els.stepDone].forEach(function (el) { el.style.display = 'none'; });
    step.style.display = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- 档案下拉（读取浏览器本地知识库） ----------

  function loadProfiles() {
    KB.init().then(function () {
      var profiles = KB.listProfiles();
      var defaultId = KB.getDefaultProfileId();
      els.profileSelect.innerHTML = profiles.map(function (p) {
        var tag = p.isDefault ? '［默认］' : '';
        return '<option value="' + p.id + '">' + tag + esc(p.name) + '（' + p.entryCount + ' 条）</option>';
      }).join('') + '<option value="">不使用知识库</option>';
      if (defaultId) els.profileSelect.value = defaultId;
    }).catch(function () {
      els.profileSelect.innerHTML = '<option value="">不使用知识库</option>';
    });
  }

  /** 当前选中档案的知识条目（随请求发送，服务端不保存） */
  function currentKbEntries() {
    var id = els.profileSelect.value;
    if (!id) return [];
    try {
      return KB.listEntries(id);
    } catch (e) {
      return [];
    }
  }

  /** 本地日期 YYYY-MM-DD（用于"填表日期"自动填充） */
  function localDateString() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // ---------- 上传 ----------

  function uploadFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext !== 'docx' && ext !== 'xlsx') {
      alert('仅支持 .docx / .xlsx 文件');
      return;
    }
    var fd = new FormData();
    fd.append('file', file);
    fd.append('kb', JSON.stringify(currentKbEntries()));
    // 带上访问者本地日期，避免服务器时区不同导致"填表日期"差一天
    fd.append('today', localDateString());
    show(els.stepAnalyzing);

    fetch('/api/fill', { method: 'POST', body: fd })
      .then(function (r) { return r.json().then(function (d) { return d; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || '上传失败');
        return d;
      }); })
      .then(function (data) {
        state.jobId = data.jobId;
        pollJob();
      })
      .catch(function (err) {
        alert(err.message);
        show(els.stepUpload);
      });
  }

  els.uploadZone.addEventListener('click', function () { els.fileInput.click(); });
  els.fileInput.addEventListener('change', function () {
    if (this.files && this.files[0]) uploadFile(this.files[0]);
    this.value = '';
  });
  ['dragover', 'dragleave', 'drop'].forEach(function (ev) {
    els.uploadZone.addEventListener(ev, function (e) {
      e.preventDefault();
      els.uploadZone.classList.toggle('dragover', ev === 'dragover');
      if (ev === 'drop' && e.dataTransfer.files && e.dataTransfer.files[0]) {
        uploadFile(e.dataTransfer.files[0]);
      }
    });
  });

  // ---------- 轮询 ----------

  function pollJob() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      fetch('/api/jobs/' + state.jobId).then(function (r) { return r.json(); }).then(function (data) {
        var job = data.job;
        if (!job) { stopPoll(); alert('任务不存在'); show(els.stepUpload); return; }
        state.job = job;
        if (job.status === 'ready') { stopPoll(); renderConfirm(job); }
        else if (job.status === 'error') { stopPoll(); alert('分析失败：' + (job.error || '未知错误')); show(els.stepUpload); }
      }).catch(function () {});
    }, 1500);
  }

  function stopPoll() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  // ---------- 确认表格 ----------

  function renderConfirm(job) {
    var fields = job.fields || [];
    var fillable = fields.filter(function (f) { return f.needFill; });

    var aiMsg = job.aiMessage || '';
    els.aiMessage.innerHTML = aiMsg
      ? '<div class="alert ' + (job.aiUsed ? 'info' : 'warning') + '"><span>' + (job.aiUsed ? '🤖' : 'ℹ️') + '</span><span>' + esc(aiMsg) + '</span></div>'
      : '';

    els.statText.textContent = '共识别 ' + fields.length + ' 个位置，其中 ' + fillable.length + ' 个待填充';

    renderRows();
    show(els.stepConfirm);
  }

  function renderRows() {
    var fields = (state.job && state.job.fields) || [];
    var onlyFill = els.onlyFillable.checked;
    var html = '';
    fields.forEach(function (f, i) {
      if (onlyFill && !f.needFill) return;
      var src = SOURCE_LABEL[f.source] || ['待填写', 'src-none'];
      var rowStyle = f.needFill ? '' : 'opacity:.55;';
      var checked = f.needFill && f.value != null && String(f.value).trim() !== '';
      html += '<tr style="' + rowStyle + '" data-idx="' + i + '">' +
        '<td><input type="checkbox" class="f-check" ' + (checked ? 'checked' : '') + ' ' + (f.needFill ? '' : 'disabled') + '></td>' +
        '<td><b>' + esc(f.fieldName) + '</b>' + (f.label && f.label !== f.fieldName ? '<div class="muted">原文: ' + esc(f.label) + '</div>' : '') + '</td>' +
        '<td class="muted" title="' + esc(f.preview || '') + '">' + esc(shortLoc(f)) + '</td>' +
        '<td><input type="text" class="f-value" value="' + esc(f.value == null ? '' : f.value) + '" placeholder="请输入填充值"></td>' +
        '<td><span class="badge ' + src[1] + '">' + src[0] + '</span>' + (f.sourceDetail ? '<div class="muted ellipsis" title="匹配知识库字段">' + esc(f.sourceDetail) + '</div>' : '') + '</td>' +
        '<td class="muted">' + (f.confidence ? Math.round(f.confidence * 100) + '%' : '-') + '</td>' +
        '</tr>';
    });
    els.fieldsTbody.innerHTML = html || '<tr><td colspan="6"><div class="empty"><div class="icon">🎉</div>未发现需要填充的位置</div></td></tr>';
  }

  function shortLoc(f) {
    // xlsx 定位形如 "申报表!B2"，只展示单元格地址，完整位置放 title
    if (f.location && f.location.indexOf('!') !== -1) return f.location.split('!').pop();
    if (f.kind === 'table-cell') return f.location; // 明细表：直接显示"学习经历 第1行·学历"
    var kindMap = { underline: '下划线', 'blank-parens': '括号', 'after-colon': '冒号后', 'label-cell': '表格格', 'header-col': '表头下' };
    return kindMap[f.kind] || f.kind;
  }

  els.onlyFillable.addEventListener('change', renderRows);

  // ---------- 生成文件 ----------

  els.btnApply.addEventListener('click', function () {
    var values = [];
    Array.prototype.forEach.call(els.fieldsTbody.querySelectorAll('tr'), function (tr) {
      var idx = parseInt(tr.getAttribute('data-idx'), 10);
      if (isNaN(idx)) return;
      var check = tr.querySelector('.f-check');
      var input = tr.querySelector('.f-value');
      values.push({
        id: state.job.fields[idx].id,
        needFill: check ? check.checked : false,
        value: input ? input.value : '',
      });
    });

    els.btnApply.disabled = true;
    els.btnApply.querySelector('.spinner').style.display = '';
    fetch('/api/jobs/' + state.jobId + '/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: values, vid: (window.getVisitorId ? window.getVisitorId() : "") }),
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error); return d; }); })
      .then(function (data) {
        els.doneText.textContent = '已填充 ' + data.appliedCount + ' 个字段，文件已生成。';
        els.btnDownload.href = '/api/jobs/' + state.jobId + '/download' + (window.getVisitorId ? '?vid=' + encodeURIComponent(window.getVisitorId()) : '');
        show(els.stepDone);
      })
      .catch(function (err) { alert('生成失败：' + err.message); })
      .finally(function () {
        els.btnApply.disabled = false;
        els.btnApply.querySelector('.spinner').style.display = 'none';
      });
  });

  els.btnRestart.addEventListener('click', function () { location.reload(); });
  els.btnAgain.addEventListener('click', function () { location.reload(); });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  loadProfiles();
})();
