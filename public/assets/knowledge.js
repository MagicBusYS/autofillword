/* 知识库管理前端逻辑（数据保存在浏览器本地，不上传服务器） */
(function () {
  'use strict';

  var CATEGORIES = ['个人信息', '联系方式', '教育背景', '工作经历', '公司信息', '项目信息', '其他'];

  var state = {
    profiles: [],
    currentId: null,
    entries: [],
    learnItems: [],
    learnTables: [],
    learning: false,
    editingEntryId: null,
    editingProfileId: null,
  };

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function openModal(id) { $(id).classList.add('open'); }
  function closeModal(id) { $(id).classList.remove('open'); }

  document.addEventListener('click', function (e) {
    var closeId = e.target.getAttribute && e.target.getAttribute('data-close');
    if (closeId) closeModal(closeId);
    if (e.target.classList && e.target.classList.contains('modal-mask')) {
      e.target.classList.remove('open');
    }
  });

  // ---------- 档案列表 ----------

  function loadProfiles(selectId) {
    state.profiles = KB.listProfiles();
    renderProfileList();
    if (selectId) selectProfile(selectId);
    else if (state.currentId && state.profiles.some(function (p) { return p.id === state.currentId; })) {
      selectProfile(state.currentId);
    } else if (state.profiles.length) {
      // 优先展示默认知识库
      selectProfile(KB.getDefaultProfileId());
    }
  }

  function renderProfileList() {
    var list = $('profile-list');
    if (!state.profiles.length) {
      list.innerHTML = '<div class="muted">暂无档案</div>';
      $('detail-card').style.display = 'none';
      $('empty-hint').style.display = '';
      return;
    }
    $('empty-hint').style.display = 'none';
    list.innerHTML = state.profiles.map(function (p) {
      var active = p.id === state.currentId;
      return '<div class="profile-item" data-id="' + p.id + '" style="padding:10px 12px; border-radius:8px; cursor:pointer; margin-bottom:6px; ' +
        (active ? 'background:#eff6ff; border:1px solid #bfdbfe;' : 'border:1px solid transparent;') + '">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">' +
        '<b style="' + (active ? 'color:var(--primary)' : '') + '">' + esc(p.name) + '</b>' +
        '<span class="badge gray">' + p.entryCount + ' 条</span>' +
        '</div>' +
        (p.description ? '<div class="muted" style="margin-top:2px;">' + esc(p.description) + '</div>' : '') +
        (p.isDefault ? '<div class="badge blue" style="margin-top:4px;">默认</div>' : '') +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.profile-item'), function (el) {
      el.addEventListener('click', function () { selectProfile(el.getAttribute('data-id')); });
    });
  }

  function selectProfile(id) {
    state.currentId = id;
    var p = state.profiles.find(function (x) { return x.id === id; });
    if (!p) return;
    renderProfileList();
    $('detail-card').style.display = '';
    $('detail-title').textContent = p.name;
    loadEntries(id);
  }

  // ---------- 条目 ----------

  function loadEntries(profileId) {
    state.entries = KB.listEntries(profileId);
    renderEntries();
  }

  function renderEntries() {
    var tbody = $('entry-tbody');
    var entries = state.entries;
    $('detail-count').textContent = '共 ' + entries.length + ' 条知识';

    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty" style="padding:26px;">' +
        '<div class="icon">📥</div>还没有内容，点击右上角「上传已填写文件学习」自动录入</div></td></tr>';
      return;
    }

    // 按分类分组排序展示
    var sorted = entries.slice().sort(function (a, b) {
      var ia = CATEGORIES.indexOf(a.category), ib = CATEGORIES.indexOf(b.category);
      if (ia === -1) ia = 99;
      if (ib === -1) ib = 99;
      return ia - ib;
    });

    tbody.innerHTML = sorted.map(function (e) {
      var isTable = e.type === 'table';
      var valueHtml;
      if (isTable) {
        var cols = (e.columns || []).join(' / ');
        valueHtml = '<div class="muted" style="font-size:12px; margin-bottom:2px;">列：' + esc(cols) + '</div>' +
          (e.rows || []).map(function (r) { return esc(r.join(' | ')); }).join('<br>');
      } else {
        valueHtml = esc(e.value.length > 120 ? e.value.slice(0, 120) + '…' : e.value);
      }
      return '<tr data-id="' + e.id + '">' +
        '<td><b>' + esc(e.fieldName) + '</b>' +
        (isTable ? '<div class="badge blue" style="margin-top:2px;">明细表 ' + (e.rows || []).length + ' 行</div>' : '') +
        (e.aliases && e.aliases.length ? '<div class="muted">别名: ' + esc(e.aliases.join('、')) + '</div>' : '') +
        '</td>' +
        '<td style="word-break:break-all;">' + valueHtml + '</td>' +
        '<td><span class="badge gray">' + esc(e.category || '其他') + '</span></td>' +
        '<td>' +
        (isTable ? '' : '<button class="btn sm secondary btn-edit">编辑</button> ') +
        '<button class="btn sm danger btn-del">删</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function (tr) {
      var id = tr.getAttribute('data-id');
      var entry = state.entries.find(function (e) { return e.id === id; });
      var editBtn = tr.querySelector('.btn-edit');
      if (editBtn) editBtn.addEventListener('click', function () { openEntryModal(entry); });
      tr.querySelector('.btn-del').addEventListener('click', function () {
        if (!confirm('确定删除「' + entry.fieldName + '」吗？')) return;
        KB.deleteEntry(state.currentId, id);
        loadEntries(state.currentId);
        loadProfiles(state.currentId);
      });
    });
  }

  // ---------- 档案 新建/编辑 ----------

  $('btn-new-profile').addEventListener('click', function () {
    state.editingProfileId = null;
    $('profile-modal-title').textContent = '新建档案';
    $('profile-name').value = '';
    $('profile-desc').value = '';
    openModal('profile-modal');
  });

  $('btn-save-profile').addEventListener('click', function () {
    var name = $('profile-name').value.trim();
    if (!name) { alert('请填写档案名称'); return; }
    try {
      var p = KB.createProfile(name, $('profile-desc').value.trim());
      closeModal('profile-modal');
      loadProfiles(p.id);
    } catch (err) {
      alert(err.message);
    }
  });

  $('btn-delete-profile').addEventListener('click', function () {
    var p = state.profiles.find(function (x) { return x.id === state.currentId; });
    if (!p) return;
    if (!confirm('确定删除档案「' + p.name + '」及其全部 ' + state.entries.length + ' 条知识吗？此操作不可撤销。')) return;
    KB.deleteProfile(p.id);
    state.currentId = null;
    state.entries = [];
    loadProfiles(null);
  });

  // ---------- 备份 / 恢复 ----------

  $('btn-export').addEventListener('click', function () {
    var text = KB.exportAll();
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    a.href = url;
    a.download = '知识库备份_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  });

  $('btn-import').addEventListener('click', function () {
    $('import-file-input').click();
  });

  $('import-file-input').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var mode = confirm('导入方式：\n确定 = 追加到现有知识库\n取消 = 覆盖（清空后导入）') ? 'append' : 'replace';
        var count = KB.importAll(String(reader.result || ''), mode);
        alert('导入完成，当前共 ' + count + ' 个档案');
        state.currentId = null;
        loadProfiles(KB.getDefaultProfileId());
      } catch (err) {
        alert('导入失败：' + err.message);
      }
    };
    reader.readAsText(file, 'utf-8');
  });

  // ---------- 手动添加/编辑条目 ----------

  function fillCategorySelect(selected) {
    $('entry-category').innerHTML = CATEGORIES.map(function (c) {
      return '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + c + '</option>';
    }).join('');
  }

  function openEntryModal(entry) {
    state.editingEntryId = entry ? entry.id : null;
    $('entry-modal-title').textContent = entry ? '编辑字段' : '添加字段';
    $('entry-name').value = entry ? entry.fieldName : '';
    $('entry-value').value = entry ? entry.value : '';
    $('entry-aliases').value = entry && entry.aliases ? entry.aliases.join(', ') : '';
    fillCategorySelect(entry ? entry.category : '个人信息');
    openModal('entry-modal');
  }

  $('btn-add-entry').addEventListener('click', function () {
    if (!state.currentId) { alert('请先选择或新建档案'); return; }
    openEntryModal(null);
  });

  $('btn-save-entry').addEventListener('click', function () {
    var name = $('entry-name').value.trim();
    var value = $('entry-value').value.trim();
    if (!name) { alert('请填写字段名'); return; }
    var aliases = $('entry-aliases').value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var payload = { fieldName: name, value: value, category: $('entry-category').value, aliases: aliases };
    try {
      if (state.editingEntryId) {
        KB.updateEntry(state.currentId, state.editingEntryId, payload);
      } else {
        KB.upsertEntries(state.currentId, [Object.assign({}, payload, { source: 'manual' })]);
      }
      closeModal('entry-modal');
      loadEntries(state.currentId);
      loadProfiles(state.currentId);
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------- 学习：上传已填写文件 ----------
  // 文件仅用于"抽取字段"，抽取结果保存在浏览器本地，服务器不保留知识数据

  $('btn-learn').addEventListener('click', function () {
    if (!state.currentId) { alert('请先选择档案'); return; }
    $('learn-file-input').click();
  });

  $('learn-file-input').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (state.learning) return;
    state.learning = true;

    var btn = $('btn-learn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner dark"></span> 正在识别…';

    var fd = new FormData();
    fd.append('file', file);
    if (window.getVisitorId) fd.append('vid', window.getVisitorId());

    fetch('/api/kb/learn', { method: 'POST', body: fd })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error); return d; }); })
      .then(function (data) {
        state.learnItems = (data.normalized || data.pairs || []).map(function (p) {
          return {
            fieldName: p.fieldName || p.label,
            value: p.value,
            aliases: p.aliases || [],
            category: p.category || '其他',
          };
        });
        state.learnTables = (data.tables || []).map(function (t) {
          return {
            fieldName: t.fieldName,
            type: 'table',
            columns: t.columns || [],
            rows: t.rows || [],
            category: t.category || '其他',
            value: t.value || '',
          };
        });
        $('learn-file').textContent = data.fileName;
        var count = state.learnItems.length;
        var tableCount = state.learnTables.length;
        var summary = '共 <b>' + count + '</b> 条信息';
        if (tableCount) summary += '、<b>' + tableCount + '</b> 张明细表';
        $('learn-msg').innerHTML = data.method === 'ai'
          ? '<div class="alert info"><span>🤖</span><span>AI 已识别并整理出 ' + summary + '（已校验：所有内容均来自原文）。请核对后入库。</span></div>'
          : data.aiUsed
            ? '<div class="alert info"><span>🤖</span><span>AI 已规范化字段名，' + summary + '，请确认。</span></div>'
            : '<div class="alert warning"><span>ℹ️</span><span>未配置 AI，使用规则抽取（' + summary + '，可能有误）。建议在「设置」页配置 AI 以获得准确结果。</span></div>';
        renderLearnRows();
        renderLearnTables();
        openModal('learn-modal');
      })
      .catch(function (err) { alert('识别失败：' + err.message); })
      .finally(function () {
        state.learning = false;
        btn.disabled = false;
        btn.innerHTML = '📥 上传已填写文件学习';
      });
  });

  function renderLearnRows() {
    var tbody = $('learn-tbody');
    if (!state.learnItems.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty">未从该文件中识别到有效字段。请确认文件已填写完整，或手动添加字段。</div></td></tr>';
      return;
    }
    tbody.innerHTML = state.learnItems.map(function (it, i) {
      return '<tr data-idx="' + i + '">' +
        '<td><input type="checkbox" class="learn-check" checked></td>' +
        '<td>' + esc(it.fieldName) +
        (it.aliases && it.aliases.length ? '<div class="muted">别名: ' + esc(it.aliases.join('、')) + '</div>' : '') +
        '</td>' +
        '<td style="word-break:break-all;">' + esc(it.value.length > 100 ? it.value.slice(0, 100) + '…' : it.value) + '</td>' +
        '<td><span class="badge gray">' + esc(it.category) + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function renderLearnTables() {
    var wrap = $('learn-tables-wrap');
    var tbody = $('learn-tables-tbody');
    var preview = $('learn-table-preview');
    if (!state.learnTables.length) {
      wrap.style.display = 'none';
      tbody.innerHTML = '';
      preview.innerHTML = '';
      return;
    }
    wrap.style.display = '';
    tbody.innerHTML = state.learnTables.map(function (t, i) {
      return '<tr data-idx="' + i + '">' +
        '<td><input type="checkbox" class="learn-table-check" checked></td>' +
        '<td><b>' + esc(t.fieldName) + '</b></td>' +
        '<td class="muted">' + esc(t.columns.join(' / ')) + '</td>' +
        '<td>' + t.rows.length + '</td>' +
        '</tr>';
    }).join('');
    preview.innerHTML = state.learnTables.map(function (t) {
      return '<div style="margin-bottom:6px;"><b>' + esc(t.fieldName) + '</b><br>' +
        t.rows.map(function (r) { return esc(r.join(' | ')); }).join('<br>') + '</div>';
    }).join('');
  }

  $('learn-table-check-all').addEventListener('change', function () {
    var checked = this.checked;
    Array.prototype.forEach.call(document.querySelectorAll('.learn-table-check'), function (c) { c.checked = checked; });
  });

  $('learn-check-all').addEventListener('change', function () {
    var checked = this.checked;
    Array.prototype.forEach.call(document.querySelectorAll('.learn-check'), function (c) { c.checked = checked; });
  });

  $('btn-save-learn').addEventListener('click', function () {
    var picked = [];
    Array.prototype.forEach.call($('learn-tbody').querySelectorAll('tr'), function (tr) {
      var idx = parseInt(tr.getAttribute('data-idx'), 10);
      if (isNaN(idx)) return;
      var check = tr.querySelector('.learn-check');
      if (!check || !check.checked) return;
      picked.push(state.learnItems[idx]);
    });
    Array.prototype.forEach.call($('learn-tables-tbody').querySelectorAll('tr'), function (tr) {
      var idx = parseInt(tr.getAttribute('data-idx'), 10);
      if (isNaN(idx)) return;
      var check = tr.querySelector('.learn-table-check');
      if (!check || !check.checked) return;
      var t = state.learnTables[idx];
      picked.push({
        fieldName: t.fieldName,
        type: 'table',
        columns: t.columns,
        rows: t.rows,
        value: t.value || t.rows.map(function (r) { return r.join(' | '); }).join('\n'),
        category: t.category,
      });
    });
    if (!picked.length) { alert('请至少勾选一条'); return; }

    try {
      var res = KB.upsertEntries(state.currentId, picked.map(function (p) {
        var item = {
          fieldName: p.fieldName, value: p.value, aliases: p.aliases,
          category: p.category, source: 'learn', sourceFile: $('learn-file').textContent,
        };
        if (p.type === 'table') {
          item.type = 'table';
          item.columns = p.columns;
          item.rows = p.rows;
        }
        return item;
      }));
      closeModal('learn-modal');
      alert('已保存到本地知识库：新增 ' + res.added + ' 条，更新 ' + res.updated + ' 条');
      loadEntries(state.currentId);
      loadProfiles(state.currentId);
    } catch (err) {
      alert('保存失败：' + err.message);
    }
  });

  // ---------- 启动 ----------

  function boot() {
    fillCategorySelect('个人信息');
    var params = new URLSearchParams(location.search);
    KB.init().then(function (info) {
      if (info.migrated) {
        console.info('[kb] 已把服务器上的旧知识库迁移到本浏览器');
      }
      loadProfiles(params.get('profile') || null);
    });
  }

  boot();
})();
