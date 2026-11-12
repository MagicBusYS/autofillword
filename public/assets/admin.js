/* 监控台前端逻辑 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function shortTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  var EVENT_LABEL = { view: '访问', fill: '填充', download: '下载', learn: '学习' };
  var EVENT_CLASS = { view: 'view', fill: 'fill', download: 'download', learn: 'learn' };

  var current = null;

  function load(days) {
    fetch('/api/metrics/summary?days=' + days)
      .then(function (r) {
        if (r.status === 403) throw new Error('该页面仅限本机访问');
        return r.json();
      })
      .then(function (data) {
        current = data;
        render(data);
      })
      .catch(function (err) {
        alert('读取统计失败：' + err.message);
      });
  }

  function render(d) {
    $('started-at').textContent = fmtTime(d.startedAt);
    $('t-views').textContent = d.totals.pageViews || 0;
    $('t-visitors').textContent = d.totals.visitors || 0;
    $('t-fills').textContent = d.totals.fills || 0;
    $('t-downloads').textContent = d.totals.downloads || 0;
    $('today-views').textContent = d.today.views;
    $('today-visitors').textContent = d.today.visitors;
    $('today-fills').textContent = d.today.fills;
    $('today-downloads').textContent = d.today.downloads;

    renderChart(d.series);
    renderPages(d.pages);
    renderRegions(d.regions || []);
    renderEvents(d.recent);
    renderVisitors(d.visitors);
  }

  function renderRegions(regions) {
    var tbody = $('regions-tbody');
    if (!regions.length) {
      tbody.innerHTML = '<tr><td colspan="3"><div class="empty">暂无地区数据</div></td></tr>';
      return;
    }
    var total = regions.reduce(function (a, r) { return a + r.views; }, 0) || 1;
    tbody.innerHTML = regions.map(function (r) {
      var pct = Math.round((r.views / total) * 100);
      return '<tr><td>' + esc(r.region) + '</td><td>' + r.views + '</td><td class="muted">' + pct + '%</td></tr>';
    }).join('');
  }

  function renderChart(series) {
    var svg = $('chart');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var W = 1000;   // viewBox 宽度，随容器拉伸
    var H = 220;
    var padL = 36, padR = 8, padT = 12, padB = 26;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;

    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');

    var max = 1;
    for (var i = 0; i < series.length; i++) {
      max = Math.max(max, series[i].views, series[i].visitors, series[i].fills, series[i].downloads);
    }
    // 取整刻度
    var step = Math.max(1, Math.ceil(max / 4));
    max = step * 4;

    function yOf(v) { return padT + innerH - (v / max) * innerH; }

    // 网格线 + y 轴刻度
    for (var g = 0; g <= 4; g++) {
      var val = step * g;
      var y = yOf(val);
      var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', padL);
      line.setAttribute('x2', W - padR);
      line.setAttribute('y1', y);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', '#e2e8f0');
      line.setAttribute('stroke-width', '1');
      svg.appendChild(line);

      var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', padL - 6);
      t.setAttribute('y', y + 4);
      t.setAttribute('text-anchor', 'end');
      t.setAttribute('font-size', '10');
      t.setAttribute('fill', '#94a3b8');
      t.textContent = String(val);
      svg.appendChild(t);
    }

    var n = series.length || 1;
    var slot = innerW / n;
    var barW = Math.max(2, Math.min(10, slot / 5));

    var seriesDefs = [
      { key: 'views', color: '#2563eb', offset: -1.5 },
      { key: 'visitors', color: '#16a34a', offset: -0.5 },
      { key: 'fills', color: '#7c3aed', offset: 0.5 },
      { key: 'downloads', color: '#d97706', offset: 1.5 },
    ];

    series.forEach(function (d, idx) {
      var cx = padL + slot * idx + slot / 2;
      seriesDefs.forEach(function (sd) {
        var v = d[sd.key] || 0;
        var h = v > 0 ? Math.max(2, (v / max) * innerH) : 0;
        if (h <= 0) return;
        var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', cx + sd.offset * barW - barW / 2);
        rect.setAttribute('y', padT + innerH - h);
        rect.setAttribute('width', barW);
        rect.setAttribute('height', h);
        rect.setAttribute('fill', sd.color);
        rect.setAttribute('rx', Math.min(2, barW / 2));
        var title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = d.date + ' · 访问 ' + d.views + ' / 访客 ' + d.visitors +
          ' / 填充 ' + d.fills + ' / 下载 ' + d.downloads;
        rect.appendChild(title);
        svg.appendChild(rect);
      });

      // x 轴日期（间隔显示，避免拥挤）
      var every = Math.ceil(n / 12);
      if (idx % every === 0 || idx === n - 1) {
        var tx = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        tx.setAttribute('x', cx);
        tx.setAttribute('y', H - 8);
        tx.setAttribute('text-anchor', 'middle');
        tx.setAttribute('font-size', '10');
        tx.setAttribute('fill', '#94a3b8');
        tx.textContent = String(d.date).slice(5);
        svg.appendChild(tx);
      }
    });
  }

  function renderPages(pages) {
    var tbody = $('pages-tbody');
    if (!pages.length) {
      tbody.innerHTML = '<tr><td colspan="3"><div class="empty">暂无访问数据</div></td></tr>';
      return;
    }
    var total = pages.reduce(function (a, p) { return a + p.views; }, 0) || 1;
    tbody.innerHTML = pages.map(function (p) {
      var pct = Math.round((p.views / total) * 100);
      return '<tr><td class="mono">' + esc(p.page) + '</td><td>' + p.views + '</td><td class="muted">' + pct + '%</td></tr>';
    }).join('');
  }

  function renderEvents(list) {
    var tbody = $('events-tbody');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="3"><div class="empty">暂无事件</div></td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function (e) {
      var label = EVENT_LABEL[e.type] || e.type;
      var cls = EVENT_CLASS[e.type] || 'view';
      // 只展示页面路径；填充/下载不记录文件名，避免泄露业务信息
      var detail = e.page ? e.page : '—';
      return '<tr>' +
        '<td class="muted">' + shortTime(e.t) + '</td>' +
        '<td><span class="pill ' + cls + '">' + label + '</span></td>' +
        '<td class="muted">' + esc(e.region || '—') + '</td>' +
        '<td class="mono">' + esc(detail) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderVisitors(list) {
    var tbody = $('visitors-tbody');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="14"><div class="empty">暂无访客数据</div></td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function (v) {
      return '<tr>' +
        '<td class="mono">' + esc(v.id) + '</td>' +
        '<td style="white-space:nowrap;" title="' + esc(v.isp || '') + '">' + esc(v.region || '-') + '</td>' +
        '<td>' + esc(v.device) + '</td>' +
        '<td>' + esc(v.browser) + '</td>' +
        '<td>' + esc(v.os) + '</td>' +
        '<td class="mono">' + esc(v.ip) + '</td>' +
        '<td>' + esc(v.lang) + '</td>' +
        '<td class="muted">' + esc(v.tz) + '</td>' +
        '<td class="muted">' + esc(v.screen) + '</td>' +
        '<td class="muted" title="' + esc(v.referrer) + '">' + esc(String(v.referrer).slice(0, 20)) + '</td>' +
        '<td>' + v.views + '</td>' +
        '<td>' + v.fills + '</td>' +
        '<td>' + v.downloads + '</td>' +
        '<td class="muted">' + fmtTime(v.lastSeen) + '</td>' +
        '</tr>';
    }).join('');
  }

  $('range').addEventListener('change', function () {
    load(this.value);
  });

  $('btn-refresh').addEventListener('click', function () {
    load($('range').value);
  });

  $('btn-reset').addEventListener('click', function () {
    if (!confirm('确定清空所有访问统计吗？此操作不可恢复。')) return;
    fetch('/api/metrics/reset', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function () { load($('range').value); })
      .catch(function (err) { alert('清空失败：' + err.message); });
  });

  load(14);
  // 每 60 秒自动刷新
  setInterval(function () { load($('range').value); }, 60000);
})();
