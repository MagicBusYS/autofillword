/**
 * 导航栏权限处理
 *  - 远程访问且未登录：隐藏「监控台」「设置」入口
 *  - 已登录（本机或远程会话）：保留入口；远程时额外显示「退出登录」
 * 说明：真正的权限拦截在服务端，这里只是界面表现。
 */
(function () {
  'use strict';

  var host = (window.location.hostname || '').toLowerCase();
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';

  function localLinks() {
    return document.querySelectorAll('a.local-only, a[href="/settings.html"], a[href="/admin.html"]');
  }

  function hideLocalLinks() {
    Array.prototype.forEach.call(localLinks(), function (a) {
      a.style.display = 'none';
    });
  }

  function showLocalLinks() {
    Array.prototype.forEach.call(localLinks(), function (a) {
      a.style.display = '';
    });
  }

  function addLogout() {
    var nav = document.querySelector('.topbar nav');
    if (!nav || nav.querySelector('#admin-logout')) return;
    var a = document.createElement('a');
    a.href = '#';
    a.id = 'admin-logout';
    a.textContent = '退出登录';
    a.style.color = '#b91c1c';
    a.addEventListener('click', function (e) {
      e.preventDefault();
      fetch('/api/admin/logout', { method: 'POST' })
        .then(function () { location.href = '/'; })
        .catch(function () { location.href = '/'; });
    });
    nav.appendChild(a);
  }

  function run() {
    // 先按主机名快速处理（避免链接闪现）
    if (!isLocal) hideLocalLinks();

    fetch('/api/admin/status')
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s || !s.authorized) {
          hideLocalLinks();
          return;
        }
        // 已登录（本机或远程会话）：显示入口
        showLocalLinks();
        if (!isLocal) addLogout();
      })
      .catch(function () {
        if (!isLocal) hideLocalLinks();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
