/* Shared across index / race / history / horses pages. */
(function (w) {
  'use strict';
  var PASS_HASH = 'e3b678bc0e15c331f500700725a4dcbf8d2f4fe8874a6e19f2ba830f1f9ee965';
  var KEY = 'formbook_unlocked_v1';

  async function sha256(str) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [].map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function isUnlocked() { return sessionStorage.getItem(KEY) === '1'; }
  function lockNow() { sessionStorage.removeItem(KEY); location.href = 'index.html'; }

  // Pages other than index redirect here if the session isn't unlocked.
  function requireUnlock() {
    if (!isUnlocked()) { location.replace('index.html'); return false; }
    return true;
  }

  // Wire the #gate form on index.html. Calls onUnlock() once unlocked.
  function initGate(onUnlock) {
    var gate = document.getElementById('gate');
    function open() { if (gate) gate.style.display = 'none'; onUnlock(); }
    if (isUnlocked()) { open(); return; }
    var form = document.getElementById('gateForm');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var v = document.getElementById('pw').value;
      if (await sha256(v) === PASS_HASH) { sessionStorage.setItem(KEY, '1'); open(); }
      else { document.getElementById('err').textContent = 'Incorrect passphrase.'; document.getElementById('pw').select(); }
    });
  }

  // Persistent top nav bar. `active` in {races,history,database}.
  function renderNav(active) {
    var el = document.getElementById('nav');
    if (!el) return;
    function link(href, key, txt) { return '<a href="' + href + '"' + (active === key ? ' class="active"' : '') + '>' + txt + '</a>'; }
    el.outerHTML =
      '<div class="navbar"><div class="inner">' +
        '<a class="brand" href="index.html"><span class="crest">🐎</span>Formbook</a>' +
        '<nav class="navlinks">' +
          link('index.html', 'races', 'Races') +
          link('multi.html', 'multi', 'Multi') +
          link('horses.html', 'database', 'Database') +
          link('history.html', 'history', 'History') +
          '<button class="lock-btn" onclick="Formbook.lockNow()">Lock</button>' +
        '</nav>' +
      '</div></div>';
  }

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
  var pct = function (x) { return Math.round((x || 0) * 100); };
  async function fetchJSON(url) { var r = await fetch(url); if (!r.ok) throw new Error(url + ' → ' + r.status); return r.json(); }
  function getParam(k) { return new URLSearchParams(location.search).get(k); }
  function fmtDate(d) { try { return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { return d; } }

  w.Formbook = { sha256, isUnlocked, lockNow, requireUnlock, initGate, renderNav, esc, pct, fetchJSON, getParam, fmtDate };
})(window);
