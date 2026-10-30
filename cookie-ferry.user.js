// ==UserScript==
// @name         Cookie 摆渡车
// @namespace    https://0lt.top/cookie-ferry
// @version      1.0.0
// @description  跨浏览器搬运登录态：A 浏览器导出全量 cookie（含 HttpOnly），B 浏览器一键写入。通用，任意站点可用
// @author       -
// @match        *://*/*
// @grant        GM_cookie
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
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

  /* ---------------- 数据层 ---------------- */

  // 兼容各版本回调参数顺序
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

  function listCookies(details) { return callGM(GM_cookie.list, details); }
  function setCookie(details) { return callGM(GM_cookie.set, details); }

  // 读取当前站点 cookie（正常路径拿全量含 HttpOnly）
  async function collectCookies() {
    if (!HAS_GM_COOKIE) {
      return document.cookie.split(/;\s*/).filter(Boolean).map(function (pair) {
        var i = pair.indexOf('=');
        return {
          name: pair.slice(0, i),
          value: pair.slice(i + 1),
          domain: location.hostname,
          path: '/',
          secure: location.protocol === 'https:',
          httpOnly: false,
          sameSite: 'unspecified',
          session: true,
          hostOnly: true
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
      } catch (e) { /* 单次查询失败不影响其它 */ }
    }
    return Array.from(seen.values());
  }

  // 把导出的 cookie 对象转换成 GM_cookie.set 需要的 details
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
      path: path,
      secure: secure,
      httpOnly: !!c.httpOnly
    };
    if (!c.hostOnly) det.domain = d;

    var ss = c.sameSite;
    if (ss && ss !== 'unspecified') {
      if (ss === 'no_restriction' || ss === 'none') {
        det.sameSite = 'no_restriction';
        det.secure = true;
        det.url = 'https://' + host + path;
      } else {
        det.sameSite = ss;
      }
    }
    if (!c.session && c.expirationDate) det.expirationDate = c.expirationDate;

    // 前缀规则（写错浏览器会直接拒收）
    if (/^__Host-/i.test(det.name)) {
      det.secure = true; det.path = '/'; det.url = 'https://' + host + '/'; delete det.domain;
    }
    if (/^__Secure-/i.test(det.name)) {
      det.secure = true; det.url = 'https://' + host + det.path;
    }
    if (det.value.length > 4096) return { error: '值超过 4096 字节' };
    return { details: det };
  }

  function b64encode(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(str) {
    var bin = atob(str), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function parseInput(raw) {
    var s = String(raw || '').trim();
    if (!s) throw new Error('内容为空');
    var obj;
    if (s.charAt(0) === '{') {
      obj = JSON.parse(s);
    } else {
      try { obj = JSON.parse(b64decode(s.replace(/\s+/g, ''))); }
      catch (e) { throw new Error('既不是 JSON，也不是有效短码'); }
    }
    if (!obj || !Array.isArray(obj.cookies)) throw new Error('缺少 cookies 数组');
    return obj;
  }

  /* ---------------- 样式（Shadow DOM 隔离） ---------------- */

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
    '.host{margin-left:auto;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#b9b9b9;',
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
    '.stats{font-size:11.5px;color:#9a9a9a;margin:0 0 8px}',
    '.ta{width:100%;min-height:108px;max-height:220px;resize:vertical;border:1px solid rgba(255,255,255,.1);border-radius:11px;',
    'background:rgba(0,0,0,.34);color:#e8e8e8;font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
    'padding:9px 10px;outline:none;word-break:break-all;transition:border-color .2s,box-shadow .2s}',
    '.ta:focus{border-color:rgba(255,138,61,.85);box-shadow:0 0 0 3px rgba(255,138,61,.16)}',

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
    '.list{margin-top:10px;display:flex;flex-direction:column;gap:6px;max-height:190px;overflow:auto}',
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
    '.btn{min-height:42px}.tab{padding:10px 0}.iconbtn{width:36px;height:36px}}',
    '@media (prefers-reduced-motion: reduce){.panel.on{animation:none}.ind{transition:none}.btn,.launch{transition:none}}'
  ].join('\n');

  var HTML = [
    '<button class="launch" aria-label="打开 Cookie 摆渡车" title="Cookie 摆渡车">',
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="9.2" cy="10" r="1" fill="#ff8a3d" stroke="none"/>',
    '<circle cx="14.2" cy="13.6" r="1" fill="#ff8a3d" stroke="none"/><circle cx="10.4" cy="15" r=".8" fill="#ff8a3d" stroke="none"/></svg>',
    '</button>',

    '<section class="panel" role="dialog" aria-label="Cookie 摆渡车">',
    '<div class="head"><span class="title">Cookie 摆渡车</span><span class="ver">v1.0.0</span>',
    '<span class="host"></span>',
    '<button class="iconbtn close" aria-label="关闭"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>',

    '<div class="tabs" data-i="0"><span class="ind"></span>',
    '<button class="tab is-on" data-tab="0">导出</button>',
    '<button class="tab" data-tab="1">导入</button></div>',

    '<div class="body">',
    '<div class="pane pane-0">',
    '<div class="stats">尚未读取</div>',
    '<textarea class="ta ta-out" readonly spellcheck="false" placeholder="点下方「读取当前站点」"></textarea>',
    '<div class="actions">',
    '<button class="btn btn-pri do-read">读取当前站点</button>',
    '<button class="btn copy-json">复制 JSON</button>',
    '<button class="btn copy-b64">复制短码</button>',
    '</div>',
    '<p class="hint">在<b>已登录的浏览器</b>里点「读取」，把结果复制到另一个浏览器粘贴。</p>',
    '</div>',

    '<div class="pane pane-1" hidden>',
    '<textarea class="ta ta-in" spellcheck="false" placeholder="粘贴另一个浏览器导出的 JSON 或短码"></textarea>',
    '<div class="actions">',
    '<button class="btn do-analyze">解析</button>',
    '<button class="btn btn-pri do-write" disabled>写入</button>',
    '<button class="btn do-clear">清空</button>',
    '</div>',
    '<div class="list"></div>',
    '<div class="actions"><button class="btn do-reload" hidden>刷新页面</button></div>',
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
  var statsEl = $('.stats'), taOut = $('.ta-out'), taIn = $('.ta-in');
  var listEl = $('.list'), writeBtn = $('.do-write'), reloadBtn = $('.do-reload');

  var exportData = [];
  var items = [];
  var toastTimer = 0;

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
    } catch (e) { /* 继续降级 */ }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); }, function () { fallbackCopy(text, msg); });
    } else {
      fallbackCopy(text, msg);
    }
  }

  function openPanel(force) {
    var on = panel.classList.contains('on');
    if (force || !on) {
      panel.classList.add('on');
      hostChip.textContent = location.host;
      hostChip.title = location.host;
      if (!exportData.length && !taOut.value) doRead();
    } else {
      panel.classList.remove('on');
    }
  }
  function closePanel() { panel.classList.remove('on'); }

  /* ---------------- 导出 ---------------- */

  async function doRead() {
    log('读取中…');
    try {
      var arr = await collectCookies();
      exportData = arr.map(function (c) {
        return {
          name: c.name,
          value: c.value == null ? '' : String(c.value),
          domain: c.domain || location.hostname,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          sameSite: c.sameSite || 'unspecified',
          session: !!c.session,
          expirationDate: c.session ? undefined : c.expirationDate,
          hostOnly: !!c.hostOnly
        };
      });
      var ho = exportData.filter(function (c) { return c.httpOnly; }).length;
      var se = exportData.filter(function (c) { return c.session; }).length;
      statsEl.textContent = exportData.length
        ? '共 ' + exportData.length + ' 条 · HttpOnly ' + ho + ' 条 · 会话 ' + se + ' 条'
        : '当前站点没有可读 cookie';
      taOut.value = exportData.length ? JSON.stringify({
        app: 'cookie-ferry', v: 1, ts: Date.now(), host: location.host, cookies: exportData
      }) : '';
      log(exportData.length ? '读取完成，可以复制了' : '读取完成：无 cookie');
    } catch (e) {
      log('读取失败：' + e.message);
    }
  }

  /* ---------------- 导入 ---------------- */

  function renderRows() {
    listEl.textContent = '';
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'row';
      var main = document.createElement('div');
      main.className = 'row-main';
      var t = document.createElement('div');
      t.className = 'row-title';
      t.textContent = it.cookie.name;
      var sub = document.createElement('div');
      sub.className = 'row-sub';
      var flags = [it.cookie.domain || '', it.cookie.path || '/'];
      if (it.cookie.httpOnly) flags.push('HttpOnly');
      if (it.cookie.secure) flags.push('Secure');
      if (it.cookie.sameSite && it.cookie.sameSite !== 'unspecified') flags.push(it.cookie.sameSite);
      if (it.cookie.session) flags.push('会话');
      sub.textContent = flags.join(' · ');
      main.appendChild(t); main.appendChild(sub);
      var side = document.createElement('div');
      side.className = 'row-side';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (it.status === 'ok' ? 'b-ok' : it.status === 'bad' ? 'b-bad' : it.error ? 'b-bad' : 'b-warn');
      badge.textContent = it.status === 'ok' ? '已写入' : it.status === 'bad' ? '失败' : it.error ? '不可写' : '待写入';
      side.appendChild(badge);
      row.appendChild(main); row.appendChild(side);
      if (it.error) { row.title = it.error; sub.textContent += ' — ' + it.error; }
      listEl.appendChild(row);
    });
  }

  function updateWriteBtn() {
    var ready = items.filter(function (i) { return i.details && !i.status; }).length;
    writeBtn.disabled = ready === 0;
    writeBtn.textContent = ready ? '写入 (' + ready + ')' : '写入';
  }

  function doAnalyze() {
    var raw = taIn.value.trim();
    if (!raw) { log('先粘贴内容'); return; }
    var pkg;
    try { pkg = parseInput(raw); } catch (e) { log('解析失败：' + e.message); return; }
    items = pkg.cookies.map(function (c) {
      var built = buildSetDetails(c);
      return { cookie: c, details: built.details || null, error: built.error || null, status: null };
    });
    renderRows();
    updateWriteBtn();
    var ok = items.filter(function (i) { return i.details; }).length;
    var from = pkg.host ? '来自 ' + pkg.host + ' ' : '';
    log(from + '解析到 ' + items.length + ' 条，可写入 ' + ok + ' 条');
    reloadBtn.hidden = true;
    if (ok === 0) toast('没有可写入的条目');
  }

  async function doWrite() {
    if (!HAS_GM_COOKIE) { log('当前油猴管理器不支持 GM_cookie，无法写入 HttpOnly cookie'); return; }
    var pending = items.filter(function (i) { return i.details && !i.status; });
    if (!pending.length) return;
    writeBtn.disabled = true;
    log('写入中…');
    var ok = 0, fail = 0;
    for (var it of pending) {
      try {
        await setCookie(it.details);
        it.status = 'ok'; ok++;
      } catch (e) {
        it.status = 'bad'; it.error = e.message; fail++;
      }
    }
    renderRows();
    updateWriteBtn();
    reloadBtn.hidden = ok === 0;

    // 回读校验：确认目标站确实能看到这些 cookie
    try {
      var after = await collectCookies();
      var names = new Set(after.map(function (c) { return c.name; }));
      var hit = pending.filter(function (p) { return names.has(p.details.name); }).length;
      log('写入完成：成功 ' + ok + '，失败 ' + fail + '；回读匹配 ' + hit + '/' + pending.length);
    } catch (e) {
      log('写入完成：成功 ' + ok + '，失败 ' + fail);
    }
    if (ok > 0) toast('已写入 ' + ok + ' 条，建议刷新页面');
  }

  /* ---------------- 交互绑定 ---------------- */

  launch.addEventListener('click', function () { openPanel(); });
  $('.close').addEventListener('click', closePanel);
  $('.do-read').addEventListener('click', doRead);

  $('.copy-json').addEventListener('click', function () { copy(taOut.value, 'JSON 已复制'); });
  $('.copy-b64').addEventListener('click', function () {
    if (!taOut.value) { toast('先读取'); return; }
    try { copy(b64encode(taOut.value), '短码已复制'); } catch (e) { toast('编码失败'); }
  });

  $('.do-analyze').addEventListener('click', doAnalyze);
  writeBtn.addEventListener('click', doWrite);
  $('.do-clear').addEventListener('click', function () {
    taIn.value = ''; items = []; listEl.textContent = ''; updateWriteBtn();
    reloadBtn.hidden = true; log('已清空');
  });
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
      if (i === '1') taIn.focus();
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('on')) closePanel();
  }, true);

  if (!HAS_GM_COOKIE) {
    log('注意：当前管理器无 GM_cookie，只能读写非 HttpOnly cookie');
  }
  if (HAS_MENU) GM_registerMenuCommand('打开 Cookie 摆渡车', function () { openPanel(true); });
})();
