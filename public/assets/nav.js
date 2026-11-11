/**
 * 导航栏可见性：设置页仅本机可用，远程访问（IP / 域名）时隐藏入口。
 * 说明：这只是界面层面的隐藏，真正的拦截在服务端（非本机访问 /settings.html 与 /api/settings 返回 403）。
 */
(function () {
  'use strict';

  var host = (window.location.hostname || '').toLowerCase();
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (isLocal) return;

  function hide() {
    var links = document.querySelectorAll('a[href="/settings.html"], a[href$="settings.html"]');
    Array.prototype.forEach.call(links, function (a) {
      if (a.parentNode) a.parentNode.removeChild(a);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hide);
  } else {
    hide();
  }
})();
