(function () {
  const UID_KEY = 'surveyWebUid';

  async function fetchJson(url, opts) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function postJson(url, body) {
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  function apiAdmin(path, method, data, query) {
    return postJson('/api/admin/proxy', {
      method: method || 'GET',
      path: path,
      data: data || {},
      query: query || {},
    });
  }

  function getWebUid() {
    let id = localStorage.getItem(UID_KEY);
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : ('web-' + Date.now() + '-' + Math.random().toString(16).slice(2));
      localStorage.setItem(UID_KEY, id);
    }
    return id;
  }

  function apiPublic(path, method, data, query) {
    return postJson('/api/public/proxy', {
      method: method || 'GET',
      path: path,
      data: data || {},
      query: query || {},
      openid: getWebUid(),
    });
  }

  function me() { return fetchJson('/api/webauth/me'); }
  async function meOptional() {
    try {
      const r = await me();
      return r.user;
    } catch (e) {
      if (e.status === 401) return null;
      throw e;
    }
  }
  function login(username, password) { return postJson('/api/webauth/login', { username, password }); }
  function register(username, password, displayName) { return postJson('/api/webauth/register', { username, password, displayName }); }
  function logout() { return postJson('/api/webauth/logout', {}); }
  function bindCreate() { return postJson('/api/account/bind/create', { webUid: getWebUid() }); }
  function bindStatus(token) { return fetchJson('/api/account/bind/status?token=' + encodeURIComponent(token)); }

  async function requireUser() {
    try {
      const r = await me();
      return r.user;
    } catch (e) {
      if (e.status !== 401) toast(e.message || '登入狀態檢查失敗', true);
      location.href = loginUrl();
      return null;
    }
  }

  function loginUrl(next) {
    const target = next || (location.pathname + location.search + location.hash);
    const pathOnly = String(target || '').split('?')[0].split('#')[0];
    if (!target || /^\/?(index\.html)?$/.test(pathOnly)) return 'index.html';
    return 'index.html?next=' + encodeURIComponent(target);
  }

  function fmtTime(iso, withYear) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (isNaN(t)) return '';
    const d = new Date(t + 8 * 3600 * 1000);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    if (withYear) return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
    return p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  function downloadBase64(base64, filename, mime) {
    const byteChars = atob(base64);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function initTopbar() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const sync = () => bar.classList.toggle('is-scrolled', window.scrollY > 4);
    sync();
    window.addEventListener('scroll', sync, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTopbar);
  else initTopbar();

  window.Survey = {
    apiAdmin, apiPublic, getWebUid, requireUser, me, meOptional, loginUrl, login, register, logout,
    bindCreate, bindStatus, fmtTime, esc, toast, downloadBase64, downloadText,
  };
})();
