/**
 * 前端访问埋点：记录页面访问（匿名）
 * - 访客 ID 存在浏览器 localStorage，不含个人信息
 * - 只发送页面路径、来源域名、语言/时区/屏幕尺寸
 */
(function () {
  'use strict';

  var VID_KEY = 'autofill.vid';

  function getVid() {
    try {
      var v = localStorage.getItem(VID_KEY);
      if (v && v.length >= 8) return v;
      var id;
      if (window.crypto && window.crypto.randomUUID) {
        id = window.crypto.randomUUID();
      } else {
        id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = (Math.random() * 16) | 0;
          var v2 = c === 'x' ? r : (r & 0x3) | 0x8;
          return v2.toString(16);
        });
      }
      localStorage.setItem(VID_KEY, id);
      return id;
    } catch (e) {
      return '';
    }
  }

  /** 供其他脚本使用（填充、下载时带上，便于关联统计） */
  window.getVisitorId = getVid;

  function send() {
    try {
      var payload = {
        vid: getVid(),
        page: location.pathname,
        referrer: document.referrer || '',
        lang: navigator.language || '',
        tz: (function () {
          try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
        })(),
        screen: window.screen ? window.screen.width + '×' + window.screen.height : '',
      };
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        // sendBeacon 不会阻塞页面，关页面也能发出
        navigator.sendBeacon('/api/metrics/pageview', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/metrics/pageview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {});
      }
    } catch (e) { /* 统计失败不影响使用 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', send);
  } else {
    send();
  }
})();
