// ==UserScript==
// @name         Cookie 摆渡车
// @namespace    https://0lt.top/cookie-ferry
// @version      1.3.0
// @description  跨浏览器搬运登录态：A 生成 6 位验证码，B 输入即登录；也支持文件与粘贴
// @author       -
// @match        *://*/*
// @grant        GM_cookie
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      0lt.top
// @run-at       document-idle
// @noframes
// @downloadURL  https://0lt.top/scripts/cookie-ferry.user.js
// @updateURL    https://0lt.top/scripts/cookie-ferry.user.js
// @homepageURL  https://github.com/lszyk26/cookie-ferry
// ==/UserScript==

(function () {
  'use strict';
  if (window.__cookieFerry) return;
  window.__cookieFerry = true;

  var HAS_GM_COOKIE = (typeof GM_cookie !== 'undefined') && GM_cookie && typeof GM_cookie.list === 'function';
  var HAS_MENU = (typeof GM_registerMenuCommand === 'function');
  var VERSION = '1.3.0';
  var API = 'https://0lt.top/api/ferry/';
  var MAX_ITEM = 131072; // 单个键超过 128KB 视为缓存，不搬运

  /* ---------------- cookie 层 ---------------- */

  function callGM(fn, details) {
    return new Promise(function (resolve, reject) {
      try {
        fn(details, function (a, b) {
          var err = b || (a instanceof Error ? a : (typeof a === 'string' ? a : null));
          var val = Array.isArray(a) ? a : (Array.isArray(b) ? b : a);
          if (err) reject(new Error(String(err)));
          else resolve(val);
        });
      } catch (e) { reject(e); }
    });
  }
  function listCookies(d) { return callGM(GM_cookie.list, d); }
  function setCookie(d) { return callGM(GM_cookie.set, d); }

  async function collectCookies() {
    if (!HAS_GM_COOKIE) {
      return document.cookie.split(/;\s*/).filter(Boolean).map(function (pair) {
        var i = pair.indexOf('=');
        return {
          name: pair.slice(0, i), value: pair.slice(i + 1), domain: location.hostname,
          path: '/', secure: location.protocol === 'https:', httpOnly: false,
          sameSite: 'unspecified', session: true, hostOnly: true
        };
      });
    }
    var seen = new Map();
    var queries = [{ url: location.href }, { domain: location.hostname }];
    for (var q of queries) {
      try {
        var arr = await listCookies(q);
        (arr || []).forEach(function (c) {
          if (!c || !c.name) return;
          var k = c.name + '|' + (c.domain || '') + '|' + (c.path || '');
          if (!seen.has(k)) seen.set(k, c);
        });
      } catch (e) { /* 忽略单次失败 */ }
    }
    return Array.from(seen.values());
  }

  function buildSetDetails(c) {
    if (!c || !c.name) return { error: '缺少 name' };
    var host = location.hostname;
    var d = String(c.domain || host).replace(/^\./, '').toLowerCase();
    if (d !== host && !host.endsWith('.' + d)) return { error: '域名不匹配：' + d };

    var path = (typeof c.path === 'string' && c.path.charAt(0) === '/') ? c.path : '/';
    var secure = !!c.secure || location.protocol === 'https:';
    var det = {
      url: (secure ? 'https:' : 'http:') + '//' + host + path,
      name: c.name,
      value: c.value == null ? '' : String(c.value),
      path: path, secure: secure, httpOnly: !!c.httpOnly
    };
    if (!c.hostOnly) det.domain = d;

    var ss = c.sameSite;
    if (ss && ss !== 'unspecified') {
      if (ss === 'no_restriction' || ss === 'none') {
        det.sameSite = 'no_restriction'; det.secure = true; det.url = 'https://' + host + path;
      } else { det.sameSite = ss; }
    }
    if (!c.session && c.expirationDate) det.expirationDate = c.expirationDate;

    if (/^__Host-/i.test(det.name)) {
      det.secure = true; det.path = '/'; det.url = 'https://' + host + '/'; delete det.domain;
    }
    if (/^__Secure-/i.test(det.name)) {
      det.secure = true; det.url = 'https://' + host + det.path;
    }
    if (det.value.length > 4096) return { error: '值超过 4096 字节' };
    return { details: det };
  }

  /* ---------------- storage 层 ---------------- */

  function collectStorageAll() {
    var rows = [], skipped = 0;
    [['l', localStorage], ['s', sessionStorage]].forEach(function (pair) {
      var tag = pair[0], st = pair[1];
      try {
        for (var i = 0; i < st.length; i++) {
          var k = st.key(i);
          if (k == null) continue;
          var v = st.getItem(k);
          if (v == null) continue;
          if (v.length > MAX_ITEM) { skipped++; continue; }
          rows.push({ k: k, v: v, t: tag });
        }
      } catch (e) { /* 隐私模式可能抛错 */ }
    });
    return { items: rows, skipped: skipped };
  }

  /* ---------------- 中转 ---------------- */

  function apiPost(path, body) {
    var url = API + path;
    var payload = JSON.stringify(body);
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'POST', url: url, data: payload, timeout: 20000,
            headers: { 'Content-Type': 'application/json' },
            onload: function (res) {
              var j = null;
              try { j = JSON.parse(res.responseText); } catch (e) { }
              if (res.status >= 200 && res.status < 300 && j) resolve(j);
              else reject(new Error((j && j.error) || ('HTTP ' + res.status)));
            },
            onerror: function () { reject(new Error('网络错误')); },
            ontimeout: function () { reject(new Error('请求超时')); }
          });
          return;
        } catch (e) { /* 退回 fetch */ }
      }
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
          return j;
        });
      }).then(resolve, function (e) { reject(new Error(e.message || '网络错误')); });
    });
  }

  /* ---------------- 序列化 ---------------- */

  function b64decode(str) {
    var bin = atob(str), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function parseInput(raw) {
    var s = String(raw || '').trim();
    if (!s) throw new Error('内容为空');
    var obj;
    if (s.charAt(0) === '{') obj = JSON.parse(s);
    else {
      try { obj = JSON.parse(b64decode(s.replace(/\s+/g, ''))); }
      catch (e) { throw new Error('既不是 JSON，也不是有效短码'); }
    }
    if (!obj || (!Array.isArray(obj.cookies) && !Array.isArray(obj.items))) throw new Error('格式不认识');
    return obj;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  /* ---------------- 样式 ---------------- */

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.wrap{font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",system-ui,sans-serif;color:#f6f6f6;-webkit-font-smoothing:antialiased}',

    '.launch{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:46px;height:46px;border-radius:15px;',
    'border:1px solid rgba(255,255,255,.14);background:rgba(23,23,23,.62);display:grid;place-items:center;cursor:pointer;padding:0;',
    '-webkit-backdrop-filter:blur(24px) saturate(185%);backdrop-filter:blur(24px) saturate(185%);box-shadow:0 10px 28px rgba(0,0,0,.4);',
    'transition:transform .28s cubic-bezier(.32,.72,0,1),background .2s ease}',
    '.launch:hover{background:rgba(38,38,38,.8)}',
    '.launch:active{transform:scale(.93)}',
    '.launch:focus-visible{outline:2px solid #ff8a3d;outline-offset:2px}',
    '.launch svg{width:22px;height:22px;fill:none;stroke:#f2f2f2;stroke-width:1.6;stroke-linecap:round}',

    '.panel{position:fixed;right:18px;bottom:76px;z-index:2147483647;width:min(420px,calc(100vw - 28px));',
    'max-height:calc(100vh - 104px);max-height:calc(100dvh - 104px);display:none;flex-direction:column;',
    'border:1px solid rgba(255,255,255,.12);border-radius:18px;background:rgba(23,23,23,.8);',
    '-webkit-backdrop-filter:blur(30px) saturate(190%);backdrop-filter:blur(30px) saturate(190%);',
    'box-shadow:0 20px 56px rgba(0,0,0,.55);overflow:hidden}',
    '.panel.on{display:flex;animation:cfpop .28s cubic-bezier(.32,.72,0,1)}',
    '@keyframes cfpop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}',

    '.head{display:flex;align-items:center;gap:8px;padding:12px 12px 10px}',
    '.title{font-size:13.5px;font-weight:600}',
    '.ver{font-size:10.5px;color:#7e7e7e;font-weight:400}',
    '.host{margin-left:auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#b9b9b9;',
    'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);border-radius:999px;padding:2px 8px}',
    '.iconbtn{width:28px;height:28px;flex:none;display:grid;place-items:center;border:none;background:transparent;border-radius:8px;cursor:pointer;padding:0}',
    '.iconbtn:hover{background:rgba(255,255,255,.08)}',
    '.iconbtn svg{width:15px;height:15px;stroke:#b9b9b9;stroke-width:1.8;fill:none;stroke-linecap:round}',

    '.tabs{position:relative;display:flex;margin:0 12px 10px;padding:3px;background:rgba(255,255,255,.05);',
    'border:1px solid rgba(255,255,255,.07);border-radius:11px}',
    '.ind{position:absolute;top:3px;left:3px;height:calc(100% - 6px);width:calc(50% - 3px);border-radius:9px;',
    'background:rgba(255,255,255,.1);transition:transform .46s cubic-bezier(.32,.72,0,1)}',
    '.tabs[data-i="1"] .ind{transform:translateX(100%)}',
    '.tab{flex:1;position:relative;z-index:1;border:none;background:transparent;color:#b9b9b9;font:12.5px/1 inherit;',
    'font-family:inherit;padding:7px 0;border-radius:9px;cursor:pointer;transition:color .2s}',
    '.tab.is-on{color:#f6f6f6;font-weight:600}',

    '.body{padding:0 12px 12px;overflow:auto;overscroll-behavior:contain}',
    '.seg{display:flex;gap:6px;margin:0 0 10px}',
    '.seg button{flex:1;min-height:30px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);',
    'color:#b9b9b9;font:12px/1 inherit;font-family:inherit;cursor:pointer;transition:background .18s,color .18s,border-color .18s}',
    '.seg button.is-on{background:rgba(255,138,61,.16);border-color:rgba(255,138,61,.55);color:#ffb37a;font-weight:600}',

    '.stats{font-size:11.5px;color:#9a9a9a;margin:0 0 8px}',
    '.ta{width:100%;min-height:78px;max-height:200px;resize:vertical;border:1px solid rgba(255,255,255,.1);border-radius:11px;',
    'background:rgba(0,0,0,.34);color:#e8e8e8;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
    'padding:9px 10px;outline:none;word-break:break-all;transition:border-color .2s,box-shadow .2s}',
    '.ta:focus{border-color:rgba(255,138,61,.85);box-shadow:0 0 0 3px rgba(255,138,61,.16)}',

    '.coderow{display:flex;gap:8px;align-items:center}',
    '.code-in{flex:1;min-width:0;height:44px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.36);',
    'color:#f6f6f6;font:17px/1 ui-monospace,Menlo,monospace;letter-spacing:.3em;text-indent:.3em;text-align:center;padding:0 8px;outline:none;',
    'transition:border-color .2s,box-shadow .2s}',
    '.code-in::placeholder{letter-spacing:.05em;text-indent:0;color:#6e6e6e;font-size:12.5px;letter-spacing:0}',
    '.code-in:focus{border-color:rgba(255,138,61,.85);box-shadow:0 0 0 3px rgba(255,138,61,.16)}',
    '.coderow .btn{flex:none;min-width:104px}',

    '.codebox{margin-top:10px;border:1px solid rgba(255,138,61,.3);background:rgba(255,138,61,.07);border-radius:12px;',
    'padding:12px 12px 10px;text-align:center;display:none}',
    '.codebox.on{display:block;animation:cfpop .28s cubic-bezier(.32,.72,0,1)}',
    '.codeval{font:29px/1.1 ui-monospace,Menlo,monospace;letter-spacing:.32em;text-indent:.32em;color:#ffb37a;font-weight:600}',
    '.codetip{font-size:11px;color:#b9b9b9;margin-top:7px}',

    '.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
    '.btn{flex:1 1 auto;min-height:34px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);',
    'background:rgba(255,255,255,.055);color:#eee;font:12.5px/1 inherit;font-family:inherit;cursor:pointer;',
    'transition:background .18s,border-color .18s,transform .18s cubic-bezier(.34,1.4,.5,1)}',
    '.btn:hover{background:rgba(255,255,255,.1)}',
    '.btn:active{transform:scale(.97)}',
    '.btn:disabled{opacity:.42;cursor:not-allowed}',
    '.btn:focus-visible{outline:2px solid #ff8a3d;outline-offset:2px}',
    '.btn-pri{background:#ff8a3d;border-color:#ff8a3d;color:#1a1105;font-weight:600}',
    '.btn-pri:hover{background:#ff9a56;border-color:#ff9a56}',
    '.btn-pri:disabled{background:#7a4a24;border-color:#7a4a24;color:#cbb6a4}',

    '.hint{margin:9px 0 0;font-size:11px;line-height:1.6;color:#7e7e7e}',
    '.sep{margin:14px 0 8px;padding-top:11px;border-top:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:8px;',
    'font-size:11px;color:#6e6e6e}',
    '.fileline{margin:8px 0 0;font-size:11px;color:#8a8a8a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.list{margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:186px;overflow:auto}',
    '.row{display:flex;align-items:flex-start;gap:8px;padding:7px 9px;border:1px solid rgba(255,255,255,.08);',
    'border-radius:9px;background:rgba(255,255,255,.03)}',
    '.row-main{min-width:0;flex:1}',
    '.row-title{font:12px/1.4 ui-monospace,Menlo,monospace;color:#eee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.row-sub{font-size:10.5px;color:#8a8a8a;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.row-side{flex:none}',
    '.badge{font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid transparent;white-space:nowrap}',
    '.b-ok{color:#7fd6a0;background:rgba(60,200,120,.14);border-color:rgba(60,200,120,.3)}',
    '.b-warn{color:#ffc07a;background:rgba(255,160,60,.14);border-color:rgba(255,160,60,.3)}',
    '.b-bad{color:#ff9a9a;background:rgba(255,90,90,.13);border-color:rgba(255,90,90,.3)}',

    '.foot{padding:8px 12px 10px;border-top:1px solid rgba(255,255,255,.07);font-size:11px;color:#8a8a8a}',
    '.log{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.toast{position:fixed;right:18px;bottom:88px;z-index:2147483647;padding:8px 14px;border-radius:10px;',
    'background:rgba(20,20,20,.94);border:1px solid rgba(255,255,255,.14);font-size:12px;color:#f2f2f2;',
    'opacity:0;transform:translateY(6px);transition:opacity .22s,transform .22s;pointer-events:none}',
    '.toast.on{opacity:1;transform:none}',

    '@media (pointer:coarse){',
    '.launch,.panel{-webkit-backdrop-filter:none;backdrop-filter:none;background:rgba(16,16,16,.96)}',
    '.btn{min-height:42px}.tab{padding:10px 0}.iconbtn{width:36px;height:36px}.seg button{min-height:38px}}',
    '@media (prefers-reduced-motion: reduce){.panel.on{animation:none}.codebox.on{animation:none}.ind{transition:none}.btn,.launch{transition:none}}'
  ].join('\n');

  var HTML = [
    '<button class="launch" aria-label="打开 Cookie 摆渡车" title="Cookie 摆渡车">',
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="9.2" cy="10" r="1" fill="#ff8a3d" stroke="none"/>',
    '<circle cx="14.2" cy="13.6" r="1" fill="#ff8a3d" stroke="none"/><circle cx="10.4" cy="15" r=".8" fill="#ff8a3d" stroke="none"/></svg>',
    '</button>',

    '<section class="panel" role="dialog" aria-label="Cookie 摆渡车">',
    '<div class="head"><span class="title">Cookie 摆渡车</span><span class="ver">v' + VERSION + '</span>',
    '<span class="host"></span>',
    '<button class="iconbtn close" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>',

    '<div class="tabs" data-i="0"><span class="ind"></span>',
    '<button class="tab is-on" data-tab="0">导出</button>',
    '<button class="tab" data-tab="1">导入</button></div>',

    '<div class="body">',
    '<div class="seg"><button data-mode="cookie" class="is-on">Cookie</button>',
    '<button data-mode="storage">本地存储</button></div>',

    '<div class="pane pane-0">',
    '<div class="stats">尚未读取</div>',
    '<div class="actions"><button class="btn btn-pri do-read">读取当前站点</button></div>',
    '<div class="actions"><button class="btn btn-pri do-gen">生成验证码</button></div>',
    '<div class="codebox"><div class="codeval"></div><div class="codetip"></div></div>',
    '<div class="actions">',
    '<button class="btn do-download">下载文件</button>',
    '<button class="btn copy-json">复制 JSON</button>',
    '</div>',
    '<p class="hint"></p>',
    '</div>',

    '<div class="pane pane-1" hidden>',
    '<div class="coderow">',
    '<input class="code-in" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="输入 6 位验证码">',
    '<button class="btn btn-pri do-fetch">获取并写入</button>',
    '</div>',
    '<p class="fileline"></p>',
    '<div class="list"></div>',
    '<div class="actions"><button class="btn do-reload" hidden>刷新页面</button></div>',
    '<p class="sep">或者用文件 / 粘贴</p>',
    '<textarea class="ta ta-in" spellcheck="false" placeholder="粘贴另一个浏览器导出的 JSON"></textarea>',
    '<div class="actions">',
    '<button class="btn do-pick">选择文件</button>',
    '<button class="btn do-analyze">解析粘贴</button>',
    '<button class="btn do-write" disabled>写入</button>',
    '</div>',
    '</div>',
    '</div>',

    '<div class="foot"><span class="log">就绪</span></div>',
    '</section>',

    '<div class="toast" role="status"></div>'
  ].join('');

  /* ---------------- 挂载 ---------------- */

  var host = document.createElement('div');
  host.id = 'cookie-ferry-host';
  document.documentElement.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  var styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  root.appendChild(styleEl);
  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = HTML;
  root.appendChild(wrap);

  var $ = function (sel) { return wrap.querySelector(sel); };
  var launch = $('.launch'), panel = $('.panel'), tabs = $('.tabs');
  var hostChip = $('.host'), logEl = $('.log'), toastEl = $('.toast');
  var statsEl = $('.stats'), taIn = $('.ta-in');
  var listEl = $('.list'), writeBtn = $('.do-write'), reloadBtn = $('.do-reload');
  var hintEl = $('.hint'), segEl = $('.seg'), fileLine = $('.fileline');
  var codeBox = $('.codebox'), codeVal = $('.codeval'), codeTip = $('.codetip');
  var codeIn = $('.code-in'), fetchBtn = $('.do-fetch');

  var fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,.txt,application/json,text/plain';
  fileInput.style.display = 'none';
  wrap.appendChild(fileInput);

  var mode = 'cookie';
  var items = [];
  var toastTimer = 0;
  var codeTimer = 0;
  var busy = false;

  var HINT = {
    cookie: '读取后点「生成验证码」，到另一个浏览器输入这 6 位数字即可，验证码 5 分钟有效、取用一次即焚。',
    storage: '会覆盖目标浏览器同名键，超过 128KB 的缓存自动跳过。验证码同样 5 分钟、一次即焚。'
  };

  function log(msg) { logEl.textContent = msg; logEl.title = msg; }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2200);
  }
  function fallbackCopy(text, msg) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(msg); } catch (e) { toast('复制失败，请手动全选'); }
    ta.remove();
  }
  function copy(text, msg) {
    if (!text) { toast('没有内容可复制'); return; }
    try {
      if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); toast(msg); return; }
    } catch (e) { /* 降级 */ }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); }, function () { fallbackCopy(text, msg); });
    } else fallbackCopy(text, msg);
  }

  function download(text) {
    if (!text) { toast('先读取'); return; }
    var name = 'cookie-ferry-' + location.hostname + '-' + stamp() + '.json';
    try {
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 5000);
      log('已下载 ' + name);
      toast('开始下载');
    } catch (e) { log('下载失败：' + e.message + '，请改用验证码'); }
  }

  function startCountdown(exp) {
    clearInterval(codeTimer);
    var tick = function () {
      var left = Math.max(0, Math.round(exp - Date.now() / 1000));
      codeTip.textContent = left > 0
        ? ('剩 ' + Math.floor(left / 60) + ':' + pad2(left % 60) + '，验证码取用一次即焚')
        : '已过期，请重新点「生成验证码」';
      if (left <= 0) clearInterval(codeTimer);
    };
    tick();
    codeTimer = setInterval(tick, 1000);
  }

  function setMode(m) {
    mode = m;
    Array.prototype.forEach.call(segEl.querySelectorAll('button'), function (b) {
      b.classList.toggle('is-on', b.dataset.mode === m);
    });
    hintEl.textContent = HINT[m];
    statsEl.textContent = '尚未读取';
    codeBox.classList.remove('on');
    clearInterval(codeTimer);
    items = []; listEl.textContent = ''; updateWriteBtn(); reloadBtn.hidden = true;
    doRead();
  }

  function openPanel(force) {
    var on = panel.classList.contains('on');
    if (force || !on) {
      panel.classList.add('on');
      hostChip.textContent = location.host;
      hostChip.title = location.host;
      if (!statsEl.dataset.loaded) doRead();
    } else panel.classList.remove('on');
  }
  function closePanel() { panel.classList.remove('on'); }

  /* ---------------- 导出 ---------------- */

  var payloadText = '';

  async function doRead() {
    hintEl.textContent = HINT[mode];
    codeBox.classList.remove('on');
    clearInterval(codeTimer);
    if (mode === 'storage') return doReadStorage();
    log('读取 cookie…');
    try {
      var arr = await collectCookies();
      var data = arr.map(function (c) {
        return {
          name: c.name, value: c.value == null ? '' : String(c.value),
          domain: c.domain || location.hostname, path: c.path || '/',
          secure: !!c.secure, httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'unspecified', session: !!c.session,
          expirationDate: c.session ? undefined : c.expirationDate, hostOnly: !!c.hostOnly
        };
      });
      var ho = data.filter(function (c) { return c.httpOnly; }).length;
      var se = data.filter(function (c) { return c.session; }).length;
      statsEl.dataset.loaded = '1';
      statsEl.textContent = data.length
        ? '共 ' + data.length + ' 条 · HttpOnly ' + ho + ' 条 · 会话 ' + se + ' 条'
        : '当前站点没有可读 cookie';
      payloadText = data.length
        ? JSON.stringify({ app: 'cookie-ferry', v: 1, ts: Date.now(), host: location.host, store: 'cookie', cookies: data })
        : '';
      if (!data.length) log('没有 cookie，切到「本地存储」模式');
      else if (ho === 0 && se === 0) log('读到 ' + data.length + ' 条，但没有 HttpOnly 会话 cookie，登录态可能不在 cookie 里');
      else log('读取完成，共 ' + data.length + ' 条，可以生成验证码');
    } catch (e) { log('读取失败：' + e.message); }
  }

  function doReadStorage() {
    log('读取本地存储…');
    var res = collectStorageAll();
    var data = res.items;
    var l = data.filter(function (x) { return x.t !== 's'; }).length;
    var s = data.length - l;
    statsEl.dataset.loaded = '1';
    if (!data.length) {
      statsEl.textContent = '当前站点没有可导出的本地存储';
      payloadText = '';
      log('读取完成：无数据');
      return;
    }
    statsEl.textContent = 'localStorage ' + l + ' 项 · sessionStorage ' + s + ' 项'
      + (res.skipped ? ' · 跳过超大 ' + res.skipped + ' 项' : '');
    payloadText = JSON.stringify({
      app: 'cookie-ferry', v: 1, ts: Date.now(), host: location.host, store: 'storage', items: data
    });
    log('读取完成，共 ' + data.length + ' 项，可以生成验证码');
  }

  async function doGen() {
    if (!payloadText) { log('先点「读取当前站点」'); toast('先读取'); return; }
    if (busy) return;
    busy = true;
    log('上传中…');
    try {
      var pkg = JSON.parse(payloadText);
      var r = await apiPost('put', { data: pkg });
      if (!r.code) throw new Error('服务端未返回验证码');
      codeVal.textContent = r.code;
      codeBox.classList.add('on');
      startCountdown(r.exp);
      log('验证码 ' + r.code + ' 已生成，去另一个浏览器输入');
      toast('验证码已生成');
    } catch (e) {
      log('生成失败：' + e.message);
      toast('生成失败');
    }
    busy = false;
  }

  /* ---------------- 导入 ---------------- */

  function renderItems() {
    listEl.textContent = '';
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'row';
      var main = document.createElement('div');
      main.className = 'row-main';
      var t = document.createElement('div');
      t.className = 'row-title';
      t.textContent = it.label;
      var sub = document.createElement('div');
      sub.className = 'row-sub';
      sub.textContent = it.sub + (it.error ? ' — ' + it.error : '');
      main.appendChild(t); main.appendChild(sub);
      var side = document.createElement('div');
      side.className = 'row-side';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (it.status === 'ok' ? 'b-ok' : it.status === 'bad' ? 'b-bad' : it.error ? 'b-bad' : 'b-warn');
      badge.textContent = it.status === 'ok' ? '已写入' : it.status === 'bad' ? '失败' : it.error ? '不可写' : '待写入';
      side.appendChild(badge);
      row.appendChild(main); row.appendChild(side);
      if (it.error) row.title = it.error;
      listEl.appendChild(row);
    });
  }

  function updateWriteBtn() {
    var ready = items.filter(function (i) { return i.run && !i.status; }).length;
    writeBtn.disabled = ready === 0;
    writeBtn.textContent = ready ? '写入 (' + ready + ')' : '写入';
  }

  function buildItems(pkg) {
    if (pkg.store === 'storage' || Array.isArray(pkg.items)) {
      return (pkg.items || []).map(function (it) {
        var tag = it.t === 's' ? 's' : 'l';
        var st = tag === 's' ? sessionStorage : localStorage;
        var val = it.v == null ? '' : String(it.v);
        return {
          label: it.k,
          kind: 'storage',
          sub: (tag === 's' ? 'sessionStorage' : 'localStorage') + ' · ' + val.length + ' 字符',
          run: function () { st.setItem(it.k, val); }
        };
      });
    }
    return (pkg.cookies || []).map(function (c) {
      var built = buildSetDetails(c);
      var flags = [c.domain || '', c.path || '/'];
      if (c.httpOnly) flags.push('HttpOnly');
      if (c.secure) flags.push('Secure');
      if (c.sameSite && c.sameSite !== 'unspecified') flags.push(c.sameSite);
      if (c.session) flags.push('会话');
      return {
        label: c.name,
        kind: 'cookie',
        sub: flags.join(' · '),
        error: built.error || null,
        run: built.details ? function () { return setCookie(built.details); } : null,
        _name: c.name
      };
    });
  }

  function analyzeText(text, from) {
    var pkg;
    try { pkg = parseInput(text); } catch (e) { log('解析失败：' + e.message); return false; }
    items = buildItems(pkg);
    renderItems();
    updateWriteBtn();
    reloadBtn.hidden = true;
    var ok = items.filter(function (i) { return i.run; }).length;
    log((from ? '[' + from + '] ' : '') + '收到 ' + items.length + ' 条，可写入 ' + ok + ' 条'
      + (pkg.store === 'storage' ? '（本地存储）' : '（cookie）'));
    return ok > 0;
  }

  async function doWrite() {
    var pending = items.filter(function (i) { return i.run && !i.status; });
    if (!pending.length) return;
    if (pending[0].kind !== 'storage' && !HAS_GM_COOKIE) {
      log('当前管理器不支持 GM_cookie，无法写入 cookie');
      return;
    }
    writeBtn.disabled = true;
    var ok = 0, fail = 0;
    for (var it of pending) {
      try { await it.run(); it.status = 'ok'; ok++; }
      catch (e) { it.status = 'bad'; it.error = e.message; fail++; }
    }
    renderItems();
    updateWriteBtn();
    reloadBtn.hidden = ok === 0;

    try {
      if (pending[0].kind === 'storage') {
        var now = new Set(collectStorageAll().items.map(function (x) { return x.k; }));
        var hit = pending.filter(function (p) { return now.has(p.label); }).length;
        log('写入完成：成功 ' + ok + '，失败 ' + fail + '；回读匹配 ' + hit + '/' + pending.length);
      } else {
        var after = await collectCookies();
        var names = new Set(after.map(function (c) { return c.name; }));
        var h = pending.filter(function (p) { return names.has(p._name); }).length;
        log('写入完成：成功 ' + ok + '，失败 ' + fail + '；回读匹配 ' + h + '/' + pending.length);
      }
    } catch (e) {
      log('写入完成：成功 ' + ok + '，失败 ' + fail);
    }
    if (ok > 0) toast('已写入 ' + ok + ' 条，刷新页面生效');
  }

  async function doFetchCode() {
    var code = (codeIn.value || '').replace(/\D/g, '').slice(0, 6);
    codeIn.value = code;
    if (code.length !== 6) { toast('需要 6 位数字'); codeIn.focus(); return; }
    if (busy) return;
    busy = true;
    fetchBtn.disabled = true;
    log('按验证码取回数据…');
    try {
      var data = await apiPost('get', { code: code });
      if (!data.data) throw new Error('没取到数据');
      fileLine.textContent = '已用验证码 ' + code + ' 取回';
      taIn.value = '';
      var ok = analyzeText(JSON.stringify(data.data), '验证码');
      if (ok) {
        await doWrite();
        codeIn.value = '';
      }
    } catch (e) {
      log('取回失败：' + e.message);
      toast(e.message);
    }
    fetchBtn.disabled = false;
    busy = false;
  }

  /* ---------------- 绑定 ---------------- */

  launch.addEventListener('click', function () { openPanel(); });
  $('.close').addEventListener('click', closePanel);
  $('.do-read').addEventListener('click', doRead);
  $('.do-gen').addEventListener('click', doGen);
  $('.do-download').addEventListener('click', function () { download(payloadText); });
  $('.copy-json').addEventListener('click', function () { copy(payloadText, 'JSON 已复制'); });

  Array.prototype.forEach.call(segEl.querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.mode === mode) return;
      setMode(b.dataset.mode);
    });
  });

  codeIn.addEventListener('input', function () {
    var v = (codeIn.value || '').replace(/\D/g, '').slice(0, 6);
    if (codeIn.value !== v) codeIn.value = v;
    if (v.length === 6) doFetchCode();        // 满 6 位自动取回
  });
  codeIn.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); doFetchCode(); }
  });
  fetchBtn.addEventListener('click', doFetchCode);

  $('.do-pick').addEventListener('click', function () { fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', async function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    log('读取文件…');
    try {
      var text = await f.text();
      taIn.value = '';
      fileLine.textContent = '已载入：' + f.name + '（' + Math.max(1, Math.round(f.size / 1024)) + ' KB）';
      analyzeText(text, f.name);
    } catch (e) { log('读取失败：' + e.message); }
    fileInput.value = '';
  });

  $('.do-analyze').addEventListener('click', function () {
    var raw = taIn.value.trim();
    if (!raw) { log('先粘贴内容，或点「选择文件」'); return; }
    fileLine.textContent = '';
    analyzeText(raw, '粘贴');
  });
  writeBtn.addEventListener('click', doWrite);
  reloadBtn.addEventListener('click', function () { location.reload(); });

  Array.prototype.forEach.call(wrap.querySelectorAll('.tab'), function (btn) {
    btn.addEventListener('click', function () {
      var i = btn.dataset.tab;
      tabs.dataset.i = i;
      Array.prototype.forEach.call(wrap.querySelectorAll('.tab'), function (b) {
        b.classList.toggle('is-on', b === btn);
      });
      $('.pane-0').hidden = i !== '0';
      $('.pane-1').hidden = i !== '1';
      if (i === '1') setTimeout(function () { codeIn.focus(); }, 60);
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('on')) closePanel();
  }, true);

  hintEl.textContent = HINT.cookie;
  if (!HAS_GM_COOKIE) log('注意：无 GM_cookie，只能处理非 HttpOnly cookie');
  if (HAS_MENU) GM_registerMenuCommand('打开 Cookie 摆渡车', function () { openPanel(true); });
})();
