'use strict';
/**
 * ReserveHub フロントエンド (app.js)
 * GitHub Pages 用 SPA。通信先は config.js の APP_CONFIG.GAS_URL。
 */

// =====================================================================
// 定数・状態
// =====================================================================
const APP_VERSION = '2026.10.09-7';
const CFG = window.APP_CONFIG || {};
console.info('ReserveHub app.js ' + APP_VERSION);
const TOKEN_KEY = CFG.TOKEN_STORAGE_KEY || 'reservehub_token';
const USER_KEY = CFG.USER_STORAGE_KEY || 'reservehub_user';
const MAX_ITEMS = 10;
const MAX_GUESTS = 20;
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const ROLE_LABEL = { admin: 'システム管理者', organizer: '会員', user: '会員' };
const RESV_STYLE = {
  pending: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  confirmed: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200',
  rejected: 'bg-rose-50 text-rose-600 ring-1 ring-rose-200',
};
const GRADIENTS = [
  'from-indigo-500 to-sky-400', 'from-emerald-500 to-teal-400', 'from-rose-500 to-orange-400',
  'from-violet-500 to-fuchsia-400', 'from-amber-500 to-yellow-400', 'from-cyan-600 to-blue-500',
  'from-slate-600 to-slate-400', 'from-pink-500 to-rose-400',
];
const DEFAULT_CATEGORIES = ['語学・国際交流', 'スポーツ・健康', 'IT・ビジネス', 'ダンス・音楽', '料理・食', '趣味・クラフト', 'アウトドア', '地域・ボランティア', 'その他'];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* noop */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* noop */ } },
};
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

const state = {
  token: store.get(TOKEN_KEY) || '',
  user: safeJson(store.get(USER_KEY)),
  route: 'events',
  events: [],
  eventsLoaded: false,
  categories: DEFAULT_CATEGORIES.slice(),
  filters: { keyword: '', category: '', onlyOpen: false },
  display: store.get('rh_display') || 'card',
  calCursor: new Date(),
  dash: null,
  dashScope: 'mine',
  dashFilter: { keyword: '', status: 'all' },
  myIncludePast: false,
  chat: [],
  chatBusy: false,
  forceModalOpen: false,
};

// =====================================================================
// ユーティリティ
// =====================================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => Number(n || 0).toLocaleString('ja-JP');
const ic = (name, cls = 'w-4 h-4') => `<i data-lucide="${name}" class="${cls}"></i>`;
function icons() { if (window.lucide) window.lucide.createIcons(); }

function ymdLocal(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseYmd(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
function addMonths(d, n) { const x = new Date(d); const day = x.getDate(); x.setMonth(x.getMonth() + n); if (x.getDate() !== day) x.setDate(0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const todayStr = () => ymdLocal(new Date());
const maxStr = () => ymdLocal(addMonths(new Date(), 2));
const slashDate = (s) => String(s || '').replace(/-/g, '/');
function dateLabel(ev) { return `${slashDate(ev.event_date)} (${ev.weekday || WD[parseYmd(ev.event_date)?.getDay() ?? 0]}) ${ev.start_time}`; }
function hashIdx(s, n) { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % n; }
function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const isOnline = (loc) => /オンライン|online|zoom|meet|teams/i.test(loc || '');

// =====================================================================
// API
// =====================================================================
let loadingCount = 0;
function loading(on) {
  loadingCount = Math.max(0, loadingCount + (on ? 1 : -1));
  $('#loading-bar').style.opacity = loadingCount > 0 ? '1' : '0';
}

// AI処理など時間のかかる操作は待ち時間を長くする
const LONG_ACTIONS = ['generateFlyerText', 'generateFlyerImage', 'concierge', 'createRecurring', 'uploadFlyer'];

async function api(action, payload = {}, opt = {}) {
  if (!CFG.GAS_URL) throw new Error('config.js の GAS_URL が設定されていません');
  const ctrl = new AbortController();
  const timeoutMs = opt.timeout || (LONG_ACTIONS.includes(action) ? (CFG.AI_TIMEOUT_MS || 180000) : (CFG.REQUEST_TIMEOUT_MS || 60000));
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  loading(true);
  try {
    const res = await fetch(CFG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: state.token || '', payload }),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('通信エラーが発生しました（HTTP ' + res.status + '）');
    const json = await res.json();
    if (!json.ok) {
      const e = new Error((json.error && json.error.message) || 'エラーが発生しました');
      e.code = json.error && json.error.code;
      throw e;
    }
    return json.data;
  } catch (e0) {
    // AbortError(DOMException) の message は書き換え不可のため、新しい Error に包み直す
    let e = e0;
    if (e0 && e0.name === 'AbortError') {
      e = new Error(LONG_ACTIONS.includes(action)
        ? 'AIの処理に時間がかかりすぎたため中断しました。混雑している可能性があります。少し時間をおいて再度お試しください'
        : '通信がタイムアウトしました。時間をおいて再度お試しください');
      e.code = 'TIMEOUT';
    } else if (e0 instanceof TypeError && !e0.code) {
      e = new Error('サーバーに接続できません。通信環境をご確認ください');
      e.code = 'NETWORK';
    } else if (!(e0 instanceof Error)) {
      e = new Error(String(e0));
    }
    if (!opt.noAuthHandle) {
      if (['AUTH_INVALID', 'AUTH_EXPIRED', 'ACCOUNT_SUSPENDED'].includes(e.code)) {
        clearSession();
        renderHeader();
        if (state.route !== 'events') go('events');
        openAuthModal('login');
      } else if (e.code === 'PASSWORD_CHANGE_REQUIRED') {
        openPasswordModal(true);
      }
    }
    throw e;
  } finally {
    clearTimeout(timer);
    loading(false);
  }
}

async function run(fn) {
  try { return await fn(); } catch (e) { toast(e.message || 'エラーが発生しました', 'error'); return undefined; }
}

// =====================================================================
// セッション・権限
// =====================================================================
function setSession(token, user) {
  if (token) { state.token = token; store.set(TOKEN_KEY, token); }
  state.user = user;
  store.set(USER_KEY, JSON.stringify(user));
}
function clearSession() {
  state.token = ''; state.user = null; state.dash = null; state.chat = [];
  store.del(TOKEN_KEY); store.del(USER_KEY);
}
const role = () => (state.user ? state.user.role : '');
// 会員は全員、イベントの主催も参加もできる
const isOrg = () => !!state.user;
const isAdmin = () => role() === 'admin';

// =====================================================================
// トースト・モーダル
// =====================================================================
function toast(msg, type = 'info') {
  const color = { info: 'bg-slate-800', success: 'bg-emerald-600', error: 'bg-rose-600' }[type] || 'bg-slate-800';
  const icon = { info: 'info', success: 'circle-check', error: 'circle-alert' }[type] || 'info';
  const el = document.createElement('div');
  el.className = `pointer-events-auto ${color} text-white text-sm rounded-xl shadow-lg px-4 py-3 flex items-start gap-2`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${ic(icon, 'w-4 h-4 mt-0.5 shrink-0')}<span class="leading-relaxed">${esc(msg)}</span>`;
  $('#toast-root').appendChild(el);
  icons();
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, type === 'error' ? 5000 : 3000);
}

function openModal({ title, body, footer = '', size = 'max-w-lg', closable = true }) {
  const wrap = document.createElement('div');
  wrap.className = 'fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4';
  wrap.innerHTML = `
    <div class="absolute inset-0 bg-slate-900/50" data-overlay></div>
    <div class="modal-panel relative bg-white w-full ${size} rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col" role="dialog" aria-modal="true">
      <div class="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100">
        <h2 class="font-bold text-slate-900 text-base">${title}</h2>
        ${closable ? `<button type="button" class="btn-icon border-0" data-close aria-label="閉じる">${ic('x')}</button>` : ''}
      </div>
      <div class="modal-body overflow-y-auto px-5 py-4 flex-1">${body}</div>
      ${footer ? `<div class="modal-footer px-5 py-3 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex flex-wrap gap-2 justify-end">${footer}</div>` : ''}
    </div>`;
  wrap._closable = closable;
  $('#modal-root').appendChild(wrap);
  if (closable) {
    wrap.querySelector('[data-overlay]').addEventListener('click', () => closeModal(wrap));
    wrap.querySelector('[data-close]').addEventListener('click', () => closeModal(wrap));
  }
  document.body.style.overflow = 'hidden';
  icons();
  const first = wrap.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
  if (first && window.matchMedia('(min-width: 640px)').matches) setTimeout(() => first.focus(), 50);
  return wrap;
}

function closeModal(wrap) {
  if (!wrap || !wrap.isConnected) return;
  wrap.remove();
  if (typeof wrap._onClose === 'function') wrap._onClose();
  if (!$('#modal-root').children.length) document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const list = $$('#modal-root > div');
  const top = list[list.length - 1];
  if (top && top._closable) closeModal(top);
  else if (!top && !$('#chat-panel').classList.contains('hidden')) toggleChat(false);
});

function confirmDialog({ title = '確認', message = '', okLabel = 'OK', danger = false, input = null }) {
  return new Promise((resolve) => {
    let done = false;
    const w = openModal({
      title: esc(title),
      size: 'max-w-md',
      body: `<p class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">${esc(message)}</p>
        ${input ? `<label class="label mt-4" for="cd-input">${esc(input.label)}</label>
          <textarea id="cd-input" rows="2" class="input" placeholder="${esc(input.placeholder || '')}"></textarea>` : ''}`,
      footer: `<button type="button" class="btn-secondary" data-cd="no">やめる</button>
        <button type="button" class="${danger ? 'btn-danger' : 'btn-primary'}" data-cd="ok">${esc(okLabel)}</button>`,
    });
    w._onClose = () => { if (!done) resolve(null); };
    w.querySelector('[data-cd=no]').onclick = () => closeModal(w);
    w.querySelector('[data-cd=ok]').onclick = () => {
      done = true;
      const v = input ? w.querySelector('#cd-input').value.trim() : '';
      closeModal(w);
      resolve({ value: v });
    };
  });
}

function pwField(id, name, label, opts = {}) {
  return `<div>
    <label class="label" for="${id}">${esc(label)}</label>
    <div class="relative">
      <input id="${id}" name="${name}" type="password" class="input pr-10" autocomplete="${opts.autocomplete || 'current-password'}" ${opts.required === false ? '' : 'required'} minlength="${opts.minlength || 1}" placeholder="${esc(opts.placeholder || '')}">
      <button type="button" data-act="eye" data-target="${id}" class="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 rounded-md" aria-label="パスワードを表示">${ic('eye')}</button>
    </div>
  </div>`;
}

function setBusy(btn, busy, text) {
  if (!btn) return;
  if (busy) { btn.dataset.orig = btn.innerHTML; btn.disabled = true; btn.innerHTML = `${ic('loader-circle', 'w-4 h-4 animate-spin')}${esc(text || '処理中…')}`; icons(); }
  else { btn.disabled = false; if (btn.dataset.orig) btn.innerHTML = btn.dataset.orig; icons(); }
}

// =====================================================================
// ルーティング
// =====================================================================
const VIEWS = { events: renderEventsView, my: renderMyView, organizer: renderOrganizerView, members: renderMembersView };

function currentRoute() { return (location.hash.replace(/^#\/?/, '') || 'events').split('?')[0]; }
function go(r) { if (currentRoute() === r) route(); else location.hash = '#/' + r; }

function route() {
  let r = currentRoute();
  if (!VIEWS[r]) r = 'events';
  if (r === 'my' && !state.user) { r = 'events'; setTimeout(() => openAuthModal('login'), 0); }
  if (r === 'admin') r = 'members';
  if ((r === 'organizer' || r === 'members') && !state.user) { r = 'events'; setTimeout(() => openAuthModal('login'), 0); }
  state.route = r;
  renderHeader();
  VIEWS[r]();
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

// =====================================================================
// ヘッダー
// =====================================================================
function renderHeader() {
  const u = state.user;
  const r = state.route;
  const navLink = (to, label, icon) => `<a href="#/${to}" class="seg-btn ${r === to ? 'is-active' : ''}">${ic(icon, 'w-3.5 h-3.5')}${label}</a>`;
  const roleBadge = isAdmin() ? '管理者' : '';
  let nav = '';
  if (u) {
    nav = `<nav class="seg" aria-label="画面切り替え">
      ${navLink('events', 'イベント', 'calendar-days')}
      ${navLink('my', 'マイ予約', 'ticket')}
      ${navLink('organizer', '主催者画面', 'layout-dashboard')}
      ${navLink('members', '会員管理', 'users')}
    </nav>`;
  }
  const right = u ? `
    <details class="relative">
      <summary class="list-none cursor-pointer flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-100">
        <span class="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 font-bold text-sm inline-flex items-center justify-center">${esc((u.name || '?').slice(0, 1))}</span>
        <span class="hidden sm:block text-left leading-tight">
          <span class="block text-sm font-bold text-slate-800 max-w-[9rem] truncate">${esc(u.name)}</span>
          <span class="block text-[11px] text-slate-500">${esc(ROLE_LABEL[u.role] || '')}</span>
        </span>
        ${ic('chevron-down', 'w-4 h-4 text-slate-400')}
      </summary>
      <div class="absolute right-0 mt-2 w-48 card shadow-lg p-1 z-40">
        <button data-act="change-pw" class="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-slate-100 flex items-center gap-2">${ic('key-round')}パスワード変更</button>
        <button data-act="logout" class="w-full text-left text-sm px-3 py-2 rounded-lg hover:bg-slate-100 text-rose-600 flex items-center gap-2">${ic('log-out')}ログアウト</button>
        <p class="px-3 pt-1 pb-1.5 text-[10px] text-slate-400 border-t border-slate-100 mt-1">ver ${APP_VERSION}</p>
      </div>
    </details>` : `
    <div class="flex items-center gap-2">
      <button data-act="login" class="btn-ghost btn-sm">ログイン</button>
      <button data-act="register" class="btn-primary btn-sm">新規登録</button>
    </div>`;

  $('#app-header').innerHTML = `
    <div class="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
      <a href="#/${isAdmin() ? 'organizer' : 'events'}" class="flex items-center gap-2.5 shrink-0">
        <span class="w-9 h-9 rounded-xl bg-indigo-600 text-white inline-flex items-center justify-center">${ic('calendar-check', 'w-5 h-5')}</span>
        <span class="leading-tight">
          <span class="flex items-center gap-1.5"><span class="font-black text-slate-900 tracking-tight">${esc(CFG.APP_NAME || 'ReserveHub')}</span>
            ${roleBadge ? `<span class="pill bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200">${roleBadge}</span>` : ''}</span>
          <span class="hidden sm:block text-[11px] text-slate-500">イベント予約・受付管理</span>
        </span>
      </a>
      <div class="hidden md:block flex-1 text-center">${nav}</div>
      <div class="ml-auto md:ml-0">${right}</div>
    </div>
    ${nav ? `<div class="md:hidden px-4 pb-2 overflow-x-auto">${nav}</div>` : ''}`;
  icons();
}

// =====================================================================
// 共通コンポーネント
// =====================================================================
function availTone(a) {
  if (!a.is_open) return { text: 'text-rose-600', bg: 'bg-rose-50', ring: 'ring-rose-200', bar: 'bg-rose-500' };
  if (a.mark === '△') return { text: 'text-amber-600', bg: 'bg-amber-50', ring: 'ring-amber-200', bar: 'bg-amber-500' };
  return { text: 'text-emerald-600', bg: 'bg-emerald-50', ring: 'ring-emerald-200', bar: 'bg-emerald-500' };
}

function markBadge(a, size = 'w-7 h-7 text-sm') {
  const t = availTone(a);
  return `<span class="inline-flex items-center justify-center ${size} rounded-full ${t.bg} ${t.text} ring-1 ${t.ring} font-black shrink-0" aria-label="${esc(a.label)}">${a.mark}</span>`;
}

function availBox(a) {
  const t = availTone(a);
  let headline;
  if (a.state === 'open' && a.mark === '〇') headline = `空き枠: 余裕あり（残 ${a.remaining}席）`;
  else if (a.state === 'open') headline = `空き枠: 残り ${a.remaining}席`;
  else if (a.state === 'full') headline = '満席（受付終了）';
  else if (a.state === 'cancelled') headline = '中止になりました';
  else headline = '受付終了';
  const used = a.capacity > 0 ? Math.min(100, Math.round((a.capacity - a.remaining) / a.capacity * 100)) : 100;
  return `<div class="flex items-center gap-3 rounded-xl ${t.bg} ring-1 ${t.ring} px-3 py-2.5">
    ${markBadge(a)}
    <div class="min-w-0 flex-1">
      <p class="text-sm font-bold ${t.text}">${headline}</p>
      <p class="text-[11px] text-slate-500">定員 ${a.capacity}名 / 現在 ${a.confirmed}名確定${a.pending ? `・承認待ち ${a.pending}名` : ''}</p>
    </div>
    <div class="w-16 sm:w-20 h-1.5 rounded-full bg-white/80 overflow-hidden" aria-hidden="true"><div class="h-full ${t.bar}" style="width:${used}%"></div></div>
  </div>`;
}

function deadlineText(ev) {
  const a = ev.availability;
  const h = Number(ev.deadline_hours_before || 0);
  if (a.state === 'full') return '定員到達により締切';
  if (h === 0) return '締切: 開始時刻まで';
  const d = a.deadline_at ? a.deadline_at.slice(5).replace('-', '/') : '';
  return `締切: 開催${h >= 24 && h % 24 === 0 ? (h / 24) + '日' : h + '時間'}前（${d}）`;
}

function metaGrid(ev) {
  return `<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-slate-600">
    <p class="flex items-center gap-1.5">${ic('calendar', 'w-3.5 h-3.5 text-indigo-500 shrink-0')}<span class="font-bold text-slate-800">${esc(dateLabel(ev))}</span></p>
    <p class="flex items-center gap-1.5 min-w-0">${ic(isOnline(ev.location) ? 'video' : 'map-pin', 'w-3.5 h-3.5 text-rose-500 shrink-0')}<span class="truncate">${esc(ev.location)}</span></p>
    <p class="flex items-center gap-1.5">${ic('clock', 'w-3.5 h-3.5 text-amber-500 shrink-0')}<span>${esc(deadlineText(ev))}</span></p>
    <p class="flex items-center gap-1.5">${ic('wallet', 'w-3.5 h-3.5 text-emerald-500 shrink-0')}<span>${ev.fee > 0 ? `現地 ${yen(ev.fee)}円 / 1名` : '無料'}</span></p>
  </div>`;
}

function flyerHeader(ev, { organizer = false, height = 'h-44' } = {}) {
  const a = ev.availability;
  const grad = GRADIENTS[hashIdx(ev.category || ev.title, GRADIENTS.length)];
  const badges = [
    ev.is_approval_required
      ? `<span class="pill bg-amber-400 text-white">${ic('user-check', 'w-3 h-3')}主催者承認制</span>`
      : `<span class="pill bg-indigo-500 text-white">${ic('zap', 'w-3 h-3')}即時自動受付</span>`,
    ev.recurring_group_id ? `<span class="pill bg-emerald-500 text-white">${ic('repeat', 'w-3 h-3')}定期開催</span>` : '',
  ].join('');
  let right = '';
  if (organizer && a.pending > 0) right = `<span class="pill bg-rose-500 text-white">${ic('bell', 'w-3 h-3')}承認待ち ${a.pending}名</span>`;
  else if (!a.is_open) right = `<span class="pill bg-white/90 text-slate-700">${esc(a.state === 'full' ? '満席' : a.label)}</span>`;
  return `<div class="relative ${height} bg-gradient-to-br ${grad} overflow-hidden">
    ${ev.flyer_url ? `<img src="${esc(ev.flyer_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" class="absolute inset-0 w-full h-full object-cover" onerror="this.remove()">` : `<div class="absolute inset-0 flex items-center justify-center text-white/25">${ic('calendar-heart', 'w-20 h-20')}</div>`}
    <div class="absolute inset-0 bg-gradient-to-t from-slate-900/80 via-slate-900/10 to-transparent"></div>
    <div class="absolute top-2.5 left-2.5 flex flex-wrap gap-1">${badges}</div>
    <div class="absolute top-2.5 right-2.5">${right}</div>
    <div class="absolute bottom-0 left-0 right-0 p-3 text-white">
      ${ev.category ? `<p class="text-[11px] font-bold text-white/85">${esc(ev.category)}</p>` : ''}
      <h3 class="font-black text-base leading-snug line-clamp-2">${esc(ev.title)}</h3>
    </div>
  </div>`;
}

function emptyState(icon, title, desc, action = '') {
  return `<div class="card py-14 px-6 text-center">
    <div class="mx-auto w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-3">${ic(icon, 'w-6 h-6')}</div>
    <p class="font-bold text-slate-700">${esc(title)}</p>
    <p class="text-sm text-slate-500 mt-1">${esc(desc)}</p>
    ${action ? `<div class="mt-4">${action}</div>` : ''}
  </div>`;
}

function skeletonCards(n = 6) {
  return `<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${Array.from({ length: n }).map(() => `
    <div class="card overflow-hidden animate-pulse"><div class="h-44 bg-slate-200"></div>
    <div class="p-4 space-y-2"><div class="h-3 bg-slate-200 rounded w-2/3"></div><div class="h-3 bg-slate-200 rounded w-1/2"></div><div class="h-10 bg-slate-100 rounded-xl"></div></div></div>`).join('')}</div>`;
}

function findEvent(id) {
  return state.events.find((e) => e.event_id === id) || (state.dash && state.dash.events.find((e) => e.event_id === id)) || null;
}

function upsertEvent(ev) {
  if (!ev) return;
  const i = state.events.findIndex((e) => e.event_id === ev.event_id);
  if (i >= 0) state.events[i] = ev;
  if (state.dash) {
    const j = state.dash.events.findIndex((e) => e.event_id === ev.event_id);
    if (j >= 0) state.dash.events[j] = Object.assign({}, state.dash.events[j], ev);
  }
}

// =====================================================================
// 参加者：イベント一覧
// =====================================================================
async function loadEvents(force = false) {
  if (state.eventsLoaded && !force) return;
  const d = await api('listEvents', {});
  state.events = d.events || [];
  state.eventsLoaded = true;
  const set = new Set(DEFAULT_CATEGORIES);
  state.events.forEach((e) => e.category && set.add(e.category));
  state.categories = Array.from(set);
}

function renderEventsView() {
  const f = state.filters;
  const disp = state.display;
  const segBtn = (mode, icon, label) => `<button data-act="display" data-mode="${mode}" class="seg-btn ${disp === mode ? 'is-active' : ''}" aria-pressed="${disp === mode}">${ic(icon, 'w-3.5 h-3.5')}<span class="hidden sm:inline">${label}</span></button>`;
  $('#app-main').innerHTML = `
    <section class="mb-5">
      <h1 class="text-xl sm:text-2xl font-black text-slate-900">イベントを探す</h1>
      <p class="text-sm text-slate-500 mt-1">本日から2ヶ月先までの開催予定です。空き状況は 〇 余裕あり ／ △ 残りわずか ／ ✕ 満席・受付終了 で表示しています。</p>
    </section>
    <section class="card p-3 mb-5 flex flex-col lg:flex-row gap-2 lg:items-center">
      <div class="relative flex-1">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${ic('search')}</span>
        <input id="ev-keyword" type="search" class="input pl-9" placeholder="イベント名・場所・カテゴリで検索" value="${esc(f.keyword)}" aria-label="キーワード検索">
      </div>
      <div class="flex flex-wrap gap-2 items-center">
        <select id="ev-category" class="input w-auto" aria-label="カテゴリ">
          <option value="">すべてのカテゴリ</option>
          ${state.categories.map((c) => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <label class="inline-flex items-center gap-1.5 text-sm text-slate-600 px-1 cursor-pointer">
          <input id="ev-open" type="checkbox" class="rounded border-slate-300 text-indigo-600" ${f.onlyOpen ? 'checked' : ''}>予約できるものだけ
        </label>
        <div class="seg ml-auto" role="group" aria-label="表示切り替え">
          ${segBtn('card', 'layout-grid', 'カード')}${segBtn('list', 'list', 'リスト')}${segBtn('month', 'calendar-days', '月')}${segBtn('week', 'calendar-range', '週')}
        </div>
      </div>
    </section>
    <div id="events-body">${state.eventsLoaded ? '' : skeletonCards()}</div>`;
  icons();

  const rerender = debounce(() => renderEventsBody(), 200);
  $('#ev-keyword').addEventListener('input', (e) => { f.keyword = e.target.value; rerender(); });
  $('#ev-category').addEventListener('change', (e) => { f.category = e.target.value; renderEventsBody(); });
  $('#ev-open').addEventListener('change', (e) => { f.onlyOpen = e.target.checked; renderEventsBody(); });

  if (state.eventsLoaded) renderEventsBody();
  else {
    loadEvents().then(() => { if (state.route === 'events') renderEventsView(); })
      .catch((e) => { $('#events-body').innerHTML = emptyState('wifi-off', 'イベントを読み込めませんでした', e.message, '<button data-act="reload-events" class="btn-primary">再読み込み</button>'); icons(); });
  }
}

function filteredEvents() {
  const f = state.filters;
  const kw = f.keyword.trim().toLowerCase();
  return state.events.filter((e) => (!f.category || e.category === f.category)
    && (!f.onlyOpen || e.availability.is_open)
    && (!kw || [e.title, e.location, e.category, e.description].join(' ').toLowerCase().includes(kw)));
}

function renderEventsBody() {
  const body = $('#events-body');
  if (!body) return;
  const list = filteredEvents();
  const d = state.display;
  if (d === 'month') body.innerHTML = renderMonth(list);
  else if (d === 'week') body.innerHTML = renderWeek(list);
  else if (!list.length) body.innerHTML = emptyState('calendar-x', '条件に合うイベントはありません', 'キーワードやカテゴリを変えてお試しください。');
  else if (d === 'list') body.innerHTML = renderList(list);
  else body.innerHTML = `<p class="text-xs text-slate-500 mb-2">${list.length}件</p><div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${list.map(participantCard).join('')}</div>`;
  icons();
}

function participantCard(ev) {
  const a = ev.availability;
  return `<article class="card overflow-hidden flex flex-col">
    <button type="button" data-act="detail" data-id="${esc(ev.event_id)}" class="text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" aria-label="${esc(ev.title)} の詳細">${flyerHeader(ev)}</button>
    <div class="p-4 flex flex-col gap-3 flex-1">
      ${metaGrid(ev)}
      ${availBox(a)}
      <div class="mt-auto flex gap-2 pt-1">
        <button data-act="detail" data-id="${esc(ev.event_id)}" class="btn-secondary flex-1">詳細</button>
        ${a.is_open
    ? `<button data-act="reserve" data-id="${esc(ev.event_id)}" class="btn-primary flex-1">${ic('ticket')}予約する</button>`
    : `<button class="btn-secondary flex-1" disabled>${esc(a.label)}</button>`}
      </div>
    </div>
  </article>`;
}

function renderList(list) {
  return `<div class="card divide-y divide-slate-100 overflow-hidden">${list.map((ev) => {
    const a = ev.availability;
    return `<div class="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
      ${markBadge(a, 'w-9 h-9 text-base')}
      <button data-act="detail" data-id="${esc(ev.event_id)}" class="min-w-0 flex-1 text-left">
        <p class="text-xs text-slate-500">${esc(dateLabel(ev))}〜${esc(ev.end_time)}　${esc(ev.category || '')}</p>
        <p class="font-bold text-slate-900 truncate">${esc(ev.title)}</p>
        <p class="text-xs text-slate-500 truncate">${esc(ev.location)}　${ev.fee > 0 ? yen(ev.fee) + '円' : '無料'}　${a.is_open ? '残' + a.remaining + '席' : esc(a.label)}</p>
      </button>
      ${a.is_open ? `<button data-act="reserve" data-id="${esc(ev.event_id)}" class="btn-primary btn-sm shrink-0">予約</button>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function calNav(label, prevDisabled, nextDisabled) {
  return `<div class="flex items-center justify-between mb-3">
    <button data-act="cal-prev" class="btn-icon" ${prevDisabled ? 'disabled' : ''} aria-label="前へ">${ic('chevron-left')}</button>
    <p class="font-black text-slate-900">${label}</p>
    <button data-act="cal-next" class="btn-icon" ${nextDisabled ? 'disabled' : ''} aria-label="次へ">${ic('chevron-right')}</button>
  </div>`;
}

function chip(ev) {
  const t = availTone(ev.availability);
  return `<button data-act="detail" data-id="${esc(ev.event_id)}" class="w-full text-left rounded-md ${t.bg} ring-1 ${t.ring} px-1.5 py-1 text-[11px] leading-tight hover:brightness-95">
    <span class="font-black ${t.text}">${ev.availability.mark}</span> <span class="text-slate-500">${esc(ev.start_time)}</span>
    <span class="block font-bold text-slate-800 truncate">${esc(ev.title)}</span></button>`;
}

function groupByDate(list) {
  const m = {};
  list.forEach((e) => { (m[e.event_date] = m[e.event_date] || []).push(e); });
  return m;
}

function renderMonth(list) {
  const c = state.calCursor;
  const y = c.getFullYear(); const mo = c.getMonth();
  const first = new Date(y, mo, 1);
  const days = new Date(y, mo + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + days) / 7);
  const start = addDays(first, -first.getDay());
  const today = todayStr(); const max = maxStr();
  const now = new Date(); const maxD = parseYmd(max);
  const prevDis = y < now.getFullYear() || (y === now.getFullYear() && mo <= now.getMonth());
  const nextDis = y > maxD.getFullYear() || (y === maxD.getFullYear() && mo >= maxD.getMonth());
  const by = groupByDate(list);
  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i); const ds = ymdLocal(d);
    const inMonth = d.getMonth() === mo;
    const evs = by[ds] || [];
    const out = ds < today || ds > max;
    cells += `<div class="min-h-[84px] sm:min-h-[108px] p-1 border-t border-l border-slate-100 ${inMonth ? 'bg-white' : 'bg-slate-50'} ${out ? 'opacity-50' : ''}">
      <p class="text-[11px] font-bold mb-1 ${ds === today ? 'inline-flex w-5 h-5 items-center justify-center rounded-full bg-indigo-600 text-white' : d.getDay() === 0 ? 'text-rose-500' : d.getDay() === 6 ? 'text-sky-600' : 'text-slate-500'}">${d.getDate()}</p>
      <div class="space-y-1">${evs.slice(0, 3).map(chip).join('')}${evs.length > 3 ? `<button data-act="day" data-date="${ds}" class="text-[11px] text-indigo-600 font-bold">+${evs.length - 3}件</button>` : ''}</div>
    </div>`;
  }
  return `<div class="card p-3 sm:p-4">
    ${calNav(`${y}年${mo + 1}月`, prevDis, nextDis)}
    <div class="grid grid-cols-7 text-center text-[11px] font-bold text-slate-500 mb-1">${WD.map((w, i) => `<div class="${i === 0 ? 'text-rose-500' : i === 6 ? 'text-sky-600' : ''}">${w}</div>`).join('')}</div>
    <div class="grid grid-cols-7 border-r border-b border-slate-100 rounded-lg overflow-hidden">${cells}</div>
  </div>`;
}

function renderWeek(list) {
  const c = state.calCursor;
  const start = addDays(new Date(c.getFullYear(), c.getMonth(), c.getDate()), -c.getDay());
  const end = addDays(start, 6);
  const today = todayStr();
  const by = groupByDate(list);
  const prevDis = ymdLocal(start) <= today;
  const nextDis = ymdLocal(end) >= maxStr();
  let cols = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i); const ds = ymdLocal(d);
    const evs = by[ds] || [];
    cols += `<div class="rounded-xl border ${ds === today ? 'border-indigo-300 bg-indigo-50/40' : 'border-slate-200 bg-white'} p-2">
      <p class="text-xs font-bold mb-2 ${d.getDay() === 0 ? 'text-rose-500' : d.getDay() === 6 ? 'text-sky-600' : 'text-slate-600'}">${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）</p>
      <div class="space-y-1.5">${evs.length ? evs.map(chip).join('') : '<p class="text-[11px] text-slate-300">予定なし</p>'}</div>
    </div>`;
  }
  return `<div class="card p-3 sm:p-4">
    ${calNav(`${start.getMonth() + 1}/${start.getDate()} 〜 ${end.getMonth() + 1}/${end.getDate()}`, prevDis, nextDis)}
    <div class="grid grid-cols-1 sm:grid-cols-7 gap-2">${cols}</div>
  </div>`;
}

function openDayList(ds) {
  const list = filteredEvents().filter((e) => e.event_date === ds);
  const d = parseYmd(ds);
  openModal({
    title: `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）のイベント`,
    body: `<div class="space-y-2">${list.map(chip).join('')}</div>`,
  });
}

// ---------------------------------------------------------------------
// イベント詳細・チラシ
// ---------------------------------------------------------------------
async function openEventDetail(id) {
  let ev = findEvent(id);
  let mine = null;
  if (!ev || state.user) {
    const d = await run(() => api('getEvent', { event_id: id }));
    if (!d) return;
    ev = d.event; mine = d.my_reservation; upsertEvent(ev);
  }
  const a = ev.availability;
  let action;
  if (mine) action = `<span class="pill ${RESV_STYLE[mine.status]} text-sm px-3 py-1.5">${ic('check')}予約済み（${esc(mine.status_label)}・${mine.guest_count}名）</span><a href="#/my" class="btn-secondary" data-close-all>マイ予約へ</a>`;
  else if (a.is_open) action = `<button data-act="reserve" data-id="${esc(ev.event_id)}" class="btn-primary">${ic('ticket')}このイベントを予約する</button>`;
  else action = `<button class="btn-secondary" disabled>${esc(a.label)}</button>`;

  const w = openModal({
    title: 'イベント詳細',
    size: 'max-w-2xl',
    body: `<div class="-mx-5 -mt-4 mb-4">${flyerHeader(ev, { height: 'h-56 sm:h-64' })}</div>
      ${ev.flyer_url ? `<button data-act="flyer" data-id="${esc(ev.event_id)}" class="text-xs text-indigo-600 font-bold inline-flex items-center gap-1 mb-3">${ic('image', 'w-3.5 h-3.5')}チラシを大きく見る</button>` : ''}
      <div class="space-y-4">
        ${metaGrid(ev)}
        ${availBox(a)}
        <div class="text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
          <span>${ic('clock', 'w-3.5 h-3.5 inline')} ${esc(ev.start_time)}〜${esc(ev.end_time)}</span>
          ${ev.organizer_name ? `<span>${ic('user', 'w-3.5 h-3.5 inline')} 主催：${esc(ev.organizer_name)}</span>` : ''}
          <span>${ev.is_approval_required ? '申込後、主催者の承認で確定します' : '申込と同時に予約が確定します'}</span>
        </div>
        ${ev.description ? `<div class="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap border-t border-slate-100 pt-4">${esc(ev.description)}</div>` : ''}
        ${ev.fee > 0 ? `<p class="text-xs text-slate-500 bg-slate-50 rounded-lg p-3">参加費は当日現地、または主催者が指定する方法で直接お支払いください（このサイトでの決済はありません）。</p>` : ''}
      </div>`,
    footer: action,
  });
  w.querySelectorAll('[data-close-all]').forEach((b) => b.addEventListener('click', () => closeModal(w)));
  w.querySelectorAll('[data-act=reserve]').forEach((b) => b.addEventListener('click', () => closeModal(w), { capture: true }));
}

function openFlyer(id) {
  const ev = findEvent(id);
  if (!ev) return;
  openModal({
    title: `チラシ：${esc(ev.title)}`,
    size: 'max-w-3xl',
    body: ev.flyer_url
      ? `<img src="${esc(ev.flyer_url)}" alt="${esc(ev.title)} のチラシ" referrerpolicy="no-referrer" class="w-full h-auto rounded-xl border border-slate-200">
         <p class="text-xs text-slate-400 mt-2">画像が表示されない場合は、Driveの共有設定（リンクを知っている全員が閲覧可）をご確認ください。</p>`
      : emptyState('image-off', 'チラシは未登録です', isOrg() ? 'イベントの編集画面から画像をアップロードできます。' : '主催者がチラシを登録するとここに表示されます。'),
  });
}

// ---------------------------------------------------------------------
// 予約
// ---------------------------------------------------------------------
function openReserveModal(id) {
  if (!state.user) { toast('予約するにはログインしてください'); openAuthModal('login'); return; }
  const ev = findEvent(id);
  if (!ev) return;
  const a = ev.availability;
  if (!a.is_open) { toast(a.label + 'のため予約できません', 'error'); return; }
  const maxG = Math.min(MAX_GUESTS, a.remaining);
  const u = state.user;
  const w = openModal({
    title: '予約の申し込み',
    body: `<div class="rounded-xl bg-slate-50 p-3 mb-4">
        <p class="font-bold text-slate-900">${esc(ev.title)}</p>
        <p class="text-xs text-slate-500 mt-0.5">${esc(dateLabel(ev))}〜${esc(ev.end_time)}　${esc(ev.location)}</p>
        <p class="text-xs mt-1 ${availTone(a).text} font-bold">${a.mark} 残り ${a.remaining}席</p>
      </div>
      <form id="rsv-form" class="space-y-3" novalidate>
        <div>
          <span class="label">参加人数（代表者を含む）</span>
          <div class="flex items-center gap-2">
            <button type="button" class="btn-icon" data-step="-1" aria-label="減らす">${ic('minus')}</button>
            <input name="guest_count" type="number" min="1" max="${maxG}" value="1" class="input w-20 text-center font-bold" aria-label="参加人数">
            <button type="button" class="btn-icon" data-step="1" aria-label="増やす">${ic('plus')}</button>
            <span class="text-xs text-slate-500">最大 ${maxG}名</span>
          </div>
        </div>
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="label" for="rsv-name">代表者名</label><input id="rsv-name" name="applicant_name" class="input" required maxlength="50" value="${esc(u.name)}" autocomplete="name"></div>
          <div><label class="label" for="rsv-phone">電話番号</label><input id="rsv-phone" name="applicant_phone" type="tel" class="input" required value="${esc(u.phone)}" placeholder="090-1234-5678" autocomplete="tel"></div>
        </div>
        <div><label class="label" for="rsv-email">メールアドレス</label><input id="rsv-email" name="applicant_email" type="email" class="input" required value="${esc(u.email)}" autocomplete="email"></div>
        <div><label class="label" for="rsv-note">備考（任意）</label><textarea id="rsv-note" name="note" rows="2" maxlength="500" class="input" placeholder="同伴者のお名前、初参加、など"></textarea></div>
        <div class="rounded-xl border border-slate-200 p-3 text-sm flex justify-between">
          <span class="text-slate-600">参加費の目安（当日精算）</span>
          <span class="font-black text-slate-900" id="rsv-total">${ev.fee > 0 ? yen(ev.fee) + '円' : '無料'}</span>
        </div>
        ${ev.is_approval_required ? `<p class="text-xs text-amber-700 bg-amber-50 rounded-lg p-2.5">${ic('info', 'w-3.5 h-3.5 inline')} このイベントは主催者承認制です。承認されると予約確定のメールが届きます。</p>` : ''}
      </form>`,
    footer: `<button class="btn-secondary" data-cancel>やめる</button><button class="btn-primary" id="rsv-submit">${ic('check')}${ev.is_approval_required ? '申し込む' : '予約を確定する'}</button>`,
  });
  const form = w.querySelector('#rsv-form');
  const count = form.guest_count;
  const updateTotal = () => { w.querySelector('#rsv-total').textContent = ev.fee > 0 ? `${yen(ev.fee * (Number(count.value) || 1))}円（${count.value}名分）` : '無料'; };
  w.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    count.value = Math.max(1, Math.min(maxG, (Number(count.value) || 1) + Number(b.dataset.step))); updateTotal();
  }));
  count.addEventListener('input', updateTotal);
  w.querySelector('[data-cancel]').onclick = () => closeModal(w);
  w.querySelector('#rsv-submit').onclick = async (e) => {
    const g = Number(count.value);
    if (!(g >= 1 && g <= maxG)) { toast(`参加人数は1〜${maxG}名で入力してください`, 'error'); return; }
    if (!form.reportValidity()) return;
    const btn = e.currentTarget;
    setBusy(btn, true, '送信中…');
    const d = await run(() => api('createReservation', Object.assign(Object.fromEntries(new FormData(form)), { event_id: ev.event_id, guest_count: g })));
    setBusy(btn, false);
    if (!d) return;
    upsertEvent(d.event);
    closeModal(w);
    toast(d.reservation.status === 'pending' ? '申し込みました。主催者の承認をお待ちください' : '予約が確定しました。確認メールを送信しました', 'success');
    if (state.route === 'events') renderEventsBody();
    if (state.route === 'organizer') refreshOrganizer();
  };
}

// =====================================================================
// マイ予約
// =====================================================================
async function renderMyView() {
  $('#app-main').innerHTML = `
    <section class="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div><h1 class="text-xl sm:text-2xl font-black text-slate-900">マイ予約</h1>
      <p class="text-sm text-slate-500 mt-1">キャンセルは各イベントの受付締切まで行えます。</p></div>
      <label class="inline-flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer">
        <input id="my-past" type="checkbox" class="rounded border-slate-300 text-indigo-600" ${state.myIncludePast ? 'checked' : ''}>終了したイベントも表示
      </label>
    </section>
    <div id="my-body">${skeletonCards(2)}</div>`;
  icons();
  $('#my-past').addEventListener('change', (e) => { state.myIncludePast = e.target.checked; renderMyView(); });
  let d;
  try { d = await api('myReservations', { include_past: state.myIncludePast }); } catch (e) {
    $('#my-body').innerHTML = emptyState('wifi-off', '予約を読み込めませんでした', e.message); icons(); return;
  }
  if (state.route !== 'my') return;
  const list = d.reservations || [];
  if (!list.length) {
    $('#my-body').innerHTML = emptyState('ticket', 'まだ予約はありません', '気になるイベントを探して予約してみましょう。', '<a href="#/events" class="btn-primary">イベントを探す</a>');
    icons(); return;
  }
  $('#my-body').innerHTML = `<div class="space-y-3">${list.map((r) => {
    const ev = r.event;
    return `<article class="card p-4 flex flex-col sm:flex-row gap-3 sm:items-center ${r.is_past || r.status === 'cancelled' || r.status === 'rejected' ? 'opacity-70' : ''}">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5 mb-1">
          <span class="pill ${RESV_STYLE[r.status] || ''}">${esc(r.status_label)}</span>
          ${ev && ev.fee > 0 && r.status === 'confirmed' ? `<span class="pill ${r.payment_status === 'paid' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}">${esc(r.payment_label)}</span>` : ''}
          ${ev && ev.status === 'cancelled' ? '<span class="pill bg-rose-50 text-rose-600">イベント中止</span>' : ''}
        </div>
        ${ev ? `<button data-act="detail" data-id="${esc(ev.event_id)}" class="text-left font-bold text-slate-900 hover:text-indigo-700">${esc(ev.title)}</button>
        <p class="text-xs text-slate-500 mt-0.5">${esc(dateLabel(ev))}〜${esc(ev.end_time)}　${esc(ev.location)}</p>` : '<p class="text-sm text-slate-500">イベント情報がありません</p>'}
        <p class="text-xs text-slate-500 mt-1">参加人数 ${r.guest_count}名${ev && ev.fee > 0 ? `　参加費 ${yen(ev.fee * r.guest_count)}円（当日精算）` : ''}　予約番号 ${esc(r.reservation_id)}</p>
      </div>
      <div class="shrink-0">${r.can_cancel ? `<button data-act="cancel-resv" data-id="${esc(r.reservation_id)}" class="btn-secondary btn-sm text-rose-600">${ic('x')}キャンセル</button>` : ''}</div>
    </article>`;
  }).join('')}</div>`;
  icons();
}

async function cancelReservation(id) {
  const ok = await confirmDialog({ title: '予約のキャンセル', message: 'この予約をキャンセルします。よろしいですか？', okLabel: 'キャンセルする', danger: true });
  if (!ok) return;
  const d = await run(() => api('cancelReservation', { reservation_id: id }));
  if (!d) return;
  toast('予約をキャンセルしました', 'success');
  state.eventsLoaded = false;
  renderMyView();
}

// =====================================================================
// 認証モーダル
// =====================================================================
function openAuthModal(tab = 'login') {
  $$('#modal-root > div').forEach((w) => { if (w._auth) closeModal(w); });
  const tabs = { login: 'ログイン', register: '新規登録', forgot: 'パスワード再発行' };
  const w = openModal({ title: 'アカウント', size: 'max-w-md', body: '<div id="auth-body"></div>' });
  w._auth = true;
  const render = (t) => {
    const body = w.querySelector('#auth-body');
    const tabBar = `<div class="seg w-full mb-4">${Object.keys(tabs).map((k) => `<button type="button" data-tab="${k}" class="seg-btn flex-1 justify-center ${k === t ? 'is-active' : ''}">${tabs[k]}</button>`).join('')}</div>`;
    let form = '';
    if (t === 'login') {
      form = `<form id="auth-form" class="space-y-3">
        <div><label class="label" for="au-email">メールアドレス</label><input id="au-email" name="email" type="email" class="input" required autocomplete="email"></div>
        ${pwField('au-pw', 'password', 'パスワード')}
        <button class="btn-primary w-full py-2.5" type="submit">${ic('log-in')}ログイン</button>
        <p class="text-xs text-center text-slate-500">パスワードを忘れた方は <button type="button" data-tab="forgot" class="text-indigo-600 font-bold">再発行</button></p>
      </form>`;
    } else if (t === 'register') {
      form = `<form id="auth-form" class="space-y-3">
        <div><label class="label" for="au-name">お名前</label><input id="au-name" name="name" class="input" required maxlength="50" autocomplete="name"></div>
        <div><label class="label" for="au-email">メールアドレス</label><input id="au-email" name="email" type="email" class="input" required autocomplete="email"></div>
        <div><label class="label" for="au-phone">電話番号（任意）</label><input id="au-phone" name="phone" type="tel" class="input" autocomplete="tel" placeholder="090-1234-5678"></div>
        <p class="text-xs text-slate-500">登録すると、仮パスワードがメールで届きます。初回ログイン時にご自身のパスワードへ変更してください。</p>
        <button class="btn-primary w-full py-2.5" type="submit">${ic('mail')}仮パスワードを受け取る</button>
      </form>`;
    } else {
      form = `<form id="auth-form" class="space-y-3">
        <div><label class="label" for="au-email">登録メールアドレス</label><input id="au-email" name="email" type="email" class="input" required autocomplete="email"></div>
        <p class="text-xs text-slate-500">新しい仮パスワードをメールでお送りします。ログイン後にパスワードを変更してください。</p>
        <button class="btn-primary w-full py-2.5" type="submit">${ic('send')}仮パスワードを再発行</button>
      </form>`;
    }
    body.innerHTML = tabBar + form;
    icons();
    body.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => render(b.dataset.tab)));
    const f = body.querySelector('#auth-form');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      const data = Object.fromEntries(new FormData(f));
      setBusy(btn, true);
      try {
        if (t === 'login') {
          const d = await api('login', data, { noAuthHandle: true });
          setSession(d.token, d.user);
          closeModal(w);
          if (d.must_change_password) { openPasswordModal(true); renderHeader(); return; }
          toast(`${d.user.name}さん、ようこそ`, 'success');
          state.eventsLoaded = false;
          go(isAdmin() ? 'organizer' : 'events');
        } else if (t === 'register') {
          const d = await api('register', data, { noAuthHandle: true });
          toast(d.message, 'success');
          render('login');
          w.querySelector('#au-email').value = data.email;
        } else {
          const d = await api('forgotPassword', data, { noAuthHandle: true });
          toast(d.message, 'success');
          render('login');
          w.querySelector('#au-email').value = data.email;
        }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        if (btn.isConnected) setBusy(btn, false);
      }
    });
  };
  render(tab);
}

function openPasswordModal(force) {
  if (force) {
    if (state.forceModalOpen) return;
    state.forceModalOpen = true;
  }
  const w = openModal({
    title: force ? 'パスワードを変更してください' : 'パスワード変更',
    size: 'max-w-md',
    closable: !force,
    body: `${force ? `<p class="text-sm text-slate-600 bg-amber-50 rounded-lg p-3 mb-4">${ic('lock', 'w-4 h-4 inline')} 仮パスワードでログインしています。ご自身のパスワードに変更するまで、他の操作はできません。</p>` : ''}
      <form id="pw-form" class="space-y-3">
        ${pwField('pw-cur', 'current_password', force ? '仮パスワード（メールに記載）' : '現在のパスワード')}
        ${pwField('pw-new', 'new_password', '新しいパスワード', { autocomplete: 'new-password', minlength: 8 })}
        ${pwField('pw-new2', 'new_password2', '新しいパスワード（確認）', { autocomplete: 'new-password', minlength: 8 })}
        <p class="text-xs text-slate-500">8文字以上で、英字と数字を両方含めてください。</p>
        <button type="submit" class="btn-primary w-full py-2.5">${ic('key-round')}パスワードを変更する</button>
        ${force ? '<button type="button" data-pw-logout class="btn-ghost w-full text-slate-500">ログアウト</button>' : ''}
      </form>`,
  });
  const f = w.querySelector('#pw-form');
  const lo = w.querySelector('[data-pw-logout]');
  if (lo) lo.addEventListener('click', () => { state.forceModalOpen = false; closeModal(w); doLogout(); });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    if (d.new_password !== d.new_password2) { toast('確認用のパスワードが一致しません', 'error'); return; }
    if (d.new_password.length < 8 || !/[A-Za-z]/.test(d.new_password) || !/\d/.test(d.new_password)) {
      toast('パスワードは8文字以上で英字と数字を両方含めてください', 'error'); return;
    }
    const btn = f.querySelector('button[type=submit]');
    setBusy(btn, true);
    try {
      const r = await api('changePassword', { current_password: d.current_password, new_password: d.new_password }, { noAuthHandle: true });
      setSession(r.token, r.user);
      state.forceModalOpen = false;
      closeModal(w);
      toast('パスワードを変更しました', 'success');
      go(isAdmin() ? 'organizer' : currentRoute());
    } catch (err) {
      toast(err.message, 'error');
      setBusy(btn, false);
    }
  });
}

async function doLogout() {
  try { await api('logout', {}, { noAuthHandle: true }); } catch (_) { /* セッション切れでも続行 */ }
  clearSession();
  state.eventsLoaded = false;
  toggleChat(false);
  toast('ログアウトしました');
  go('events');
}

// =====================================================================
// 主催者ダッシュボード
// =====================================================================
async function refreshOrganizer() {
  state.eventsLoaded = false;
  if (state.route !== 'organizer') return;
  try {
    state.dash = await api('organizerDashboard', { scope: state.dashScope });
    renderOrganizerBody();
  } catch (e) { toast(e.message, 'error'); }
}

async function renderOrganizerView() {
  $('#app-main').innerHTML = `
    <div id="org-stats" class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">${Array.from({ length: 4 }).map(() => '<div class="card h-28 animate-pulse"></div>').join('')}</div>
    <section class="card p-3 mb-5 flex flex-col lg:flex-row gap-2 lg:items-center">
      <div class="flex flex-1 gap-2">
        <div class="relative flex-1">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${ic('search')}</span>
          <input id="org-keyword" type="search" class="input pl-9" placeholder="イベント名・カテゴリで検索" value="${esc(state.dashFilter.keyword)}" aria-label="イベント検索">
        </div>
        <select id="org-status" class="input w-auto" aria-label="ステータス">
          ${[['all', '全ステータス'], ['open', '受付中'], ['few', '残りわずか'], ['full', '満席'], ['closed', '受付終了'], ['pending', '承認待ちあり']]
    .map(([v, l]) => `<option value="${v}" ${state.dashFilter.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div class="flex flex-wrap gap-2">
        <button data-act="ai-flyer" class="btn-ai">${ic('sparkles')}AIチラシ・告知文生成</button>
        <button data-act="recurring" class="btn-dark">${ic('repeat')}定期開催 一括生成</button>
        <button data-act="new-event" class="btn-primary">${ic('plus')}新規登録</button>
      </div>
    </section>
    <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
      <h2 class="font-black text-slate-900 flex items-center gap-2">${ic('calendar-days', 'w-5 h-5 text-indigo-600')}管理中のイベント枠（2ヶ月以内）</h2>
      <div class="flex items-center gap-3">
        ${isAdmin() ? `<div class="seg"><button data-act="dash-scope" data-scope="mine" class="seg-btn ${state.dashScope === 'mine' ? 'is-active' : ''}">自分の枠</button><button data-act="dash-scope" data-scope="all" class="seg-btn ${state.dashScope === 'all' ? 'is-active' : ''}">全主催者</button></div>` : ''}
        <p id="org-count" class="text-xs text-slate-500"></p>
      </div>
    </div>
    <div id="org-body">${skeletonCards(4)}</div>`;
  icons();
  const rerender = debounce(() => renderOrganizerBody(), 200);
  $('#org-keyword').addEventListener('input', (e) => { state.dashFilter.keyword = e.target.value; rerender(); });
  $('#org-status').addEventListener('change', (e) => { state.dashFilter.status = e.target.value; renderOrganizerBody(); });
  try {
    state.dash = await api('organizerDashboard', { scope: state.dashScope });
    if (state.route === 'organizer') renderOrganizerBody();
  } catch (e) {
    $('#org-body').innerHTML = emptyState('wifi-off', 'ダッシュボードを読み込めませんでした', e.message);
    icons();
  }
}

function statCard(inner, extra = '') {
  return `<div class="card p-4 flex flex-col justify-between gap-2 ${extra}">${inner}</div>`;
}

function renderOrganizerStats() {
  const d = state.dash; const s = d.stats; const q = d.quota;
  const used = q.used === null ? null : q.used;
  const pct = q.max ? Math.min(100, Math.round((used || 0) / q.max * 100)) : 0;
  const trend = s.change_vs_yesterday_pct;
  $('#org-stats').innerHTML = [
    statCard(`<div class="flex items-start justify-between"><p class="text-xs font-bold text-slate-500">予約枠 利用状況</p><span class="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 inline-flex items-center justify-center">${ic('layers')}</span></div>
      ${q.max ? `<p><span class="text-3xl font-black text-slate-900">${used}</span><span class="text-sm text-slate-500"> / ${q.max} 枠使用中</span></p>
      <div><div class="h-1.5 rounded-full bg-slate-100 overflow-hidden"><div class="h-full ${pct >= 100 ? 'bg-rose-500' : 'bg-indigo-500'}" style="width:${pct}%"></div></div>
      <p class="flex justify-between text-[11px] text-slate-500 mt-1"><span>残り ${Math.max(0, q.max - used)} 枠登録可能</span><span>上限: ${q.max}枠</span></p></div>`
    : `<p class="text-xl font-black text-slate-900">${used === null ? '全主催者' : used + ' 枠'}</p><p class="text-[11px] text-slate-500">管理者は枠数無制限</p>`}`),
    statCard(`<div class="flex items-start justify-between"><p class="text-xs font-bold text-slate-500">今日の予約申込</p><span class="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 inline-flex items-center justify-center">${ic('users')}</span></div>
      <p><span class="text-3xl font-black text-slate-900">${s.today_guests}</span><span class="text-sm text-slate-500"> 名（${s.today_count}組）</span></p>
      <p class="text-[11px] ${trend === null ? 'text-slate-400' : trend >= 0 ? 'text-emerald-600' : 'text-rose-600'} flex items-center gap-1">${trend === null ? '前日の申込はありません' : `${ic(trend >= 0 ? 'trending-up' : 'trending-down', 'w-3.5 h-3.5')}前日比 ${trend >= 0 ? '+' : ''}${trend}%`}</p>`),
    statCard(`<div class="flex items-start justify-between"><p class="text-xs font-bold text-amber-700">承認待ち</p><span class="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 inline-flex items-center justify-center">${ic('user-check')}</span></div>
      <p><span class="text-3xl font-black text-amber-600">${s.pending_count}</span><span class="text-sm text-slate-500"> 件</span></p>
      <p class="flex justify-between text-[11px]"><span class="text-slate-500">承認制イベントの申込</span>${s.pending_count ? '<button data-act="dash-pending" class="text-indigo-600 font-bold">確認する</button>' : ''}</p>`, s.pending_count ? 'ring-2 ring-amber-200 border-amber-200' : ''),
    statCard(`<div class="flex items-start justify-between"><p class="text-xs font-bold text-slate-500">現地・個別精算状況</p><span class="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 inline-flex items-center justify-center">${ic('hand-coins')}</span></div>
      <div class="flex flex-wrap gap-1.5"><span class="pill bg-rose-50 text-rose-600 ring-1 ring-rose-200">未精算: ${s.unpaid_count}件</span><span class="pill bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">精算済: ${s.paid_count}件</span></div>
      <p class="text-[11px] text-slate-400">確定予約の入金確認状況（有料イベント）</p>`),
  ].join('');
}

function dashFiltered() {
  const f = state.dashFilter;
  const kw = f.keyword.trim().toLowerCase();
  return state.dash.events.filter((e) => {
    const a = e.availability;
    if (kw && ![e.title, e.category, e.location].join(' ').toLowerCase().includes(kw)) return false;
    switch (f.status) {
      case 'open': return a.is_open;
      case 'few': return a.is_open && a.mark === '△';
      case 'full': return a.state === 'full';
      case 'closed': return a.state === 'closed' || a.state === 'cancelled';
      case 'pending': return e.pending_count > 0;
      default: return true;
    }
  });
}

function renderOrganizerBody() {
  if (!state.dash || !$('#org-body')) return;
  renderOrganizerStats();
  const list = dashFiltered();
  $('#org-count').textContent = `表示中: ${list.length}件`;
  if (!state.dash.events.length) {
    $('#org-body').innerHTML = emptyState('calendar-plus', 'まだイベント枠がありません', '「新規登録」または「定期開催 一括生成」から最初の枠を作りましょう。', '<button data-act="new-event" class="btn-primary">新規登録</button>');
  } else if (!list.length) {
    $('#org-body').innerHTML = emptyState('filter-x', '条件に合うイベント枠はありません', '検索キーワードやステータスを変えてください。');
  } else {
    $('#org-body').innerHTML = `<div class="grid sm:grid-cols-2 gap-4">${list.map(organizerCard).join('')}</div>`;
  }
  icons();
}

function organizerNames(ev) {
  return [ev.organizer_name].concat(ev.co_organizer_names || []).filter(Boolean);
}

function organizerCard(ev) {
  const names = organizerNames(ev);
  const roleBadge = {
    owner: '<span class="pill bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200">登録者</span>',
    co: '<span class="pill bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">共同主催（管理）</span>',
    viewer: '<span class="pill bg-sky-50 text-sky-700 ring-1 ring-sky-200">共同主催者（確認）</span>',
  }[ev.my_role] || '<span class="pill bg-slate-100 text-slate-600">管理者として表示</span>';
  return `<article class="card overflow-hidden flex flex-col">
    ${flyerHeader(ev, { organizer: true })}
    <div class="p-4 flex flex-col gap-3 flex-1">
      <div class="flex items-center gap-2 text-[11px] text-slate-500 min-w-0">${roleBadge}<span class="truncate">主催：${esc(names.join('・'))}</span></div>
      ${metaGrid(ev)}
      ${availBox(ev.availability)}
      ${ev.fee > 0 && (ev.unpaid_count || ev.paid_count) ? `<p class="text-[11px] text-slate-500">精算：未 ${ev.unpaid_count}件 / 済 ${ev.paid_count}件</p>` : ''}
      <div class="mt-auto flex items-center justify-between gap-2 pt-3 border-t border-slate-100">
        <button data-act="flyer" data-id="${esc(ev.event_id)}" class="text-xs text-slate-500 hover:text-indigo-600 inline-flex items-center gap-1">${ic('image', 'w-3.5 h-3.5')}チラシ確認</button>
        <div class="flex items-center gap-2">
          ${ev.status === 'cancelled' ? '<span class="pill bg-rose-50 text-rose-600">中止</span>'
    : ev.can_manage === false ? '' : `<button data-act="edit-event" data-id="${esc(ev.event_id)}" class="btn-icon" aria-label="編集">${ic('pencil', 'w-3.5 h-3.5')}</button>`}
          <button data-act="participants" data-id="${esc(ev.event_id)}" class="btn-primary btn-sm">${ic('list-checks', 'w-3.5 h-3.5')}${ev.can_manage === false ? '参加者名簿を見る' : '参加者名簿・受付'}</button>
        </div>
      </div>
    </div>
  </article>`;
}

// ---------------------------------------------------------------------
// イベント登録・編集フォーム
// ---------------------------------------------------------------------
function eventFieldsHtml(v = {}, { withDate = true, withStatus = false } = {}) {
  const deadlineOpts = [[0, '開始時刻まで'], [1, '1時間前'], [3, '3時間前'], [6, '6時間前'], [12, '12時間前'], [24, '前日（24時間前）'], [48, '2日前'], [72, '3日前'], [168, '1週間前']];
  const dl = Number(v.deadline_hours_before ?? 24);
  if (!deadlineOpts.some(([h]) => h === dl)) deadlineOpts.push([dl, dl + '時間前']);
  const approval = !!v.is_approval_required;
  return `
    <div><label class="label" for="ef-title">イベント名</label><input id="ef-title" name="title" class="input" required maxlength="100" value="${esc(v.title)}" placeholder="例：週末初心者向け英会話カフェ"></div>
    <div class="grid sm:grid-cols-2 gap-3">
      <div><label class="label" for="ef-cat">カテゴリ</label><input id="ef-cat" name="category" class="input" list="ef-cats" maxlength="50" value="${esc(v.category)}" placeholder="選択または入力">
        <datalist id="ef-cats">${state.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div><label class="label" for="ef-loc">開催場所</label><input id="ef-loc" name="location" class="input" required maxlength="200" value="${esc(v.location)}" placeholder="例：渋谷コワーキングA室 / オンライン（Google Meet）"></div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-${withDate ? 3 : 2} gap-3">
      ${withDate ? `<div class="col-span-2 sm:col-span-1"><label class="label" for="ef-date">開催日</label><input id="ef-date" name="event_date" type="date" class="input" required min="${todayStr()}" max="${maxStr()}" value="${esc(v.event_date)}"></div>` : ''}
      <div><label class="label" for="ef-start">開始</label><input id="ef-start" name="start_time" type="time" class="input" required value="${esc(v.start_time || '14:00')}"></div>
      <div><label class="label" for="ef-end">終了</label><input id="ef-end" name="end_time" type="time" class="input" required value="${esc(v.end_time || '16:00')}"></div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <div><label class="label" for="ef-cap">定員（名）</label><input id="ef-cap" name="capacity" type="number" min="1" max="10000" class="input" required value="${esc(v.capacity ?? 10)}"></div>
      <div><label class="label" for="ef-fee">参加費（円/1名・当日精算）</label><input id="ef-fee" name="fee" type="number" min="0" step="100" class="input" value="${esc(v.fee ?? 0)}"></div>
      <div class="col-span-2 sm:col-span-1"><label class="label" for="ef-dl">予約締切</label><select id="ef-dl" name="deadline_hours_before" class="input">
        ${deadlineOpts.map(([h, l]) => `<option value="${h}" ${h === dl ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <fieldset>
      <legend class="label">受付方法</legend>
      <div class="grid sm:grid-cols-2 gap-2">
        <label class="flex gap-2 items-start rounded-xl border border-slate-200 p-3 cursor-pointer has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/50">
          <input type="radio" name="is_approval_required" value="false" class="mt-1 text-indigo-600" ${approval ? '' : 'checked'}>
          <span><span class="block text-sm font-bold">即時自動受付</span><span class="block text-xs text-slate-500">申し込みと同時に予約確定</span></span></label>
        <label class="flex gap-2 items-start rounded-xl border border-slate-200 p-3 cursor-pointer has-[:checked]:border-amber-500 has-[:checked]:bg-amber-50/50">
          <input type="radio" name="is_approval_required" value="true" class="mt-1 text-amber-600" ${approval ? 'checked' : ''}>
          <span><span class="block text-sm font-bold">主催者承認制</span><span class="block text-xs text-slate-500">承認するまで「承認待ち」</span></span></label>
      </div>
    </fieldset>
    ${withStatus ? `<div><label class="label" for="ef-status">受付状態</label><select id="ef-status" name="status" class="input">
      <option value="active" ${v.status !== 'closed' ? 'selected' : ''}>受付中</option><option value="closed" ${v.status === 'closed' ? 'selected' : ''}>受付を停止する</option></select></div>` : ''}
    <div><label class="label" for="ef-desc">案内文</label><textarea id="ef-desc" name="description" rows="6" maxlength="5000" class="input" placeholder="内容・対象・持ち物・当日の流れなど">${esc(v.description)}</textarea></div>`;
}

function flyerUploaderHtml(v = {}, { groupOption = false } = {}) {
  return `<div class="rounded-xl border border-dashed border-slate-300 p-3" data-flyer-box>
    <p class="label">チラシ画像（任意・5MBまで）</p>
    <div class="flex items-center gap-3">
      <div class="w-24 h-24 rounded-lg bg-slate-100 overflow-hidden flex items-center justify-center text-slate-400 shrink-0" data-flyer-preview>
        ${v.flyer_url ? `<img src="${esc(v.flyer_url)}" alt="" referrerpolicy="no-referrer" class="w-full h-full object-cover">` : ic('image', 'w-8 h-8')}
      </div>
      <div class="space-y-1.5 min-w-0">
        <div class="flex flex-wrap gap-1.5">
          <label class="btn-secondary btn-sm cursor-pointer">${ic('upload', 'w-3.5 h-3.5')}画像を選ぶ<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" class="sr-only" data-flyer-input></label>
          <button type="button" class="btn-ai btn-sm" data-flyer-ai>${ic('sparkles', 'w-3.5 h-3.5')}AIで生成</button>
        </div>
        ${v.flyer_drive_id ? '<button type="button" class="btn-ghost btn-sm text-rose-600" data-flyer-clear>画像を外す</button>' : ''}
        ${groupOption ? '<label class="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" data-flyer-group class="rounded border-slate-300 text-indigo-600">同じ定期グループ全体に適用</label>' : ''}
        <p class="text-[11px] text-slate-500" data-flyer-status>${v.flyer_drive_id ? '登録済み' : '未登録'}</p>
      </div>
    </div>
    <input type="hidden" name="flyer_drive_id" value="${esc(v.flyer_drive_id)}">
  </div>`;
}

function readFileAsDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('画像の読み込みに失敗しました')); r.readAsDataURL(file); });
}
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を開けませんでした')); i.src = src; });
}
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) throw new Error('JPEG / PNG / WebP / GIF の画像を選んでください');
  const dataUrl = await readFileAsDataUrl(file);
  if (file.type === 'image/gif') {
    if (file.size > 5 * 1024 * 1024) throw new Error('GIF画像は5MB以下にしてください');
    return { dataUrl, mime: file.type };
  }
  return toJpeg(dataUrl);
}

/** 画像を最大1600pxのJPEGに変換（アップロード容量を抑える） */
async function toJpeg(dataUrl) {
  const img = await loadImage(dataUrl);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/jpeg', 0.86), mime: 'image/jpeg' };
}

function bindFlyerUploader(root, { eventId = '' } = {}) {
  const box = root.querySelector('[data-flyer-box]');
  if (!box) return;
  const input = box.querySelector('[data-flyer-input]');
  const hidden = box.querySelector('input[name=flyer_drive_id]');
  const prev = box.querySelector('[data-flyer-preview]');
  const status = box.querySelector('[data-flyer-status]');
  const clear = box.querySelector('[data-flyer-clear]');
  const aiBtn = box.querySelector('[data-flyer-ai]');
  if (clear) clear.addEventListener('click', () => { hidden.value = ''; prev.innerHTML = ic('image', 'w-8 h-8'); status.textContent = '保存すると画像が外れます'; clear.remove(); icons(); });

  const uploadDataUrl = async (dataUrl, mime) => {
    prev.innerHTML = `<img src="${dataUrl}" alt="" class="w-full h-full object-cover">`;
    status.textContent = 'アップロード中…';
    const groupCb = box.querySelector('[data-flyer-group]');
    const payload = { base64: dataUrl, mime_type: mime };
    if (eventId) { payload.event_id = eventId; payload.apply_to_group = !!(groupCb && groupCb.checked); }
    const r = await api('uploadFlyer', payload);
    hidden.value = r.file_id;
    status.textContent = r.shared ? 'アップロード完了' : 'アップロード完了（共有設定に失敗：Driveで公開設定を確認してください）';
    if (eventId) state.eventsLoaded = false;
  };

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      status.textContent = '画像を準備中…';
      const { dataUrl, mime } = await prepareImage(file);
      await uploadDataUrl(dataUrl, mime);
    } catch (e) {
      status.textContent = 'アップロードに失敗しました';
      toast(e.message, 'error');
    } finally {
      input.value = '';
    }
  });

  if (aiBtn) {
    aiBtn.addEventListener('click', () => {
      const form = box.closest('form');
      const g = (n) => (form && form.elements[n] ? String(form.elements[n].value || '').trim() : '');
      openAiImageModal({
        title: g('title'), category: g('category'), description: g('description'), location: g('location'),
        event_date: g('event_date'), start_time: g('start_time'),
      },
        async (dataUrl) => {
          try {
            status.textContent = '画像を準備中…';
            const j = await toJpeg(dataUrl);
            await uploadDataUrl(j.dataUrl, j.mime);
            toast('AI生成画像をチラシに設定しました', 'success');
          } catch (e) {
            status.textContent = 'アップロードに失敗しました';
            toast(e.message, 'error');
            throw e;
          }
        });
    });
  }
}

/** 画像の上に日本語の文字を正確なフォントで重ねる（AI画像の文字化け対策） */
function wrapChars(ctx, text, maxW, maxLines) {
  const lines = [];
  let line = '';
  for (const ch of Array.from(text)) {
    if (line && ctx.measureText(line + ch).width > maxW) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines - 1) { /* 最終行は残りすべて */ }
    } else line += ch;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    head.push(lines.slice(maxLines - 1).join(''));
    return head;
  }
  return lines;
}

async function composeFlyer(src, { title = '', sub = '', position = 'top' } = {}) {
  const img = await loadImage(src);
  const max = 1600;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  const W = c.width = Math.round(img.width * scale);
  const H = c.height = Math.round(img.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0, W, H);
  title = String(title || '').trim();
  sub = String(sub || '').trim();
  if (position === 'none' || (!title && !sub)) return c.toDataURL('image/jpeg', 0.88);

  const FONT = '"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, sans-serif';
  try {
    await Promise.all([
      document.fonts.load(`900 48px "Noto Sans JP"`, title || 'あ'),
      document.fonts.load(`700 24px "Noto Sans JP"`, sub || 'あ'),
    ]);
  } catch (_) { /* フォント読込失敗時は代替フォント */ }

  const base = Math.min(W, H);
  const pad = Math.round(W * 0.06);
  const maxW = W - pad * 2;

  // タイトル：1行に収まるまで縮小し、それでも長ければ折り返し（最大3行）
  let size = Math.round(base * 0.12);
  const minSize = Math.round(base * 0.07);
  ctx.font = `900 ${size}px ${FONT}`;
  while (title && size > minSize && ctx.measureText(title).width > maxW) { size -= 2; ctx.font = `900 ${size}px ${FONT}`; }
  const tLines = title ? wrapChars(ctx, title, maxW, 3) : [];
  const tLH = size * 1.22;

  const subSize = Math.max(Math.round(base * 0.04), Math.round(size * 0.4));
  ctx.font = `700 ${subSize}px ${FONT}`;
  const sLines = sub ? wrapChars(ctx, sub, maxW, 2) : [];
  const sLH = subSize * 1.45;
  const gap = tLines.length && sLines.length ? size * 0.35 : 0;
  const blockH = tLines.length * tLH + gap + sLines.length * sLH;

  // 読みやすさのための半透明グラデーション帯
  const bandH = blockH + pad * 2.4;
  const top = position === 'bottom' ? H - bandH : 0;
  const grad = position === 'bottom'
    ? ctx.createLinearGradient(0, H - bandH, 0, H)
    : ctx.createLinearGradient(0, 0, 0, bandH);
  if (position === 'bottom') { grad.addColorStop(0, 'rgba(15,23,42,0)'); grad.addColorStop(0.35, 'rgba(15,23,42,0.55)'); grad.addColorStop(1, 'rgba(15,23,42,0.75)'); }
  else { grad.addColorStop(0, 'rgba(15,23,42,0.75)'); grad.addColorStop(0.65, 'rgba(15,23,42,0.55)'); grad.addColorStop(1, 'rgba(15,23,42,0)'); }
  ctx.fillStyle = grad;
  ctx.fillRect(0, top, W, bandH);

  let y = position === 'bottom' ? H - pad - blockH : pad;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(15,23,42,0.6)';

  ctx.font = `900 ${size}px ${FONT}`;
  ctx.lineWidth = Math.max(2, size * 0.08);
  tLines.forEach((ln) => { ctx.strokeText(ln, W / 2, y); ctx.fillText(ln, W / 2, y); y += tLH; });
  y += gap;
  ctx.font = `700 ${subSize}px ${FONT}`;
  ctx.lineWidth = Math.max(2, subSize * 0.12);
  sLines.forEach((ln) => { ctx.strokeText(ln, W / 2, y); ctx.fillText(ln, W / 2, y); y += sLH; });

  return c.toDataURL('image/jpeg', 0.88);
}

function defaultSubText(ctx) {
  const parts = [];
  const d = parseYmd(ctx.event_date);
  if (d) parts.push(`${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）${ctx.start_time ? ctx.start_time + '〜' : ''}`);
  if (ctx.location) parts.push(ctx.location);
  return parts.join('　');
}

/** AIチラシ画像生成モーダル */
function openAiImageModal(ctx, onUse) {
  const styles = [['illust', 'イラスト'], ['photo', '写真風'], ['watercolor', '水彩画風'], ['pop', 'ポップ'], ['simple', 'シンプル']];
  const aspects = [['3:4', '縦長（チラシ向け）'], ['1:1', '正方形（SNS向け）'], ['4:3', '横長'], ['9:16', 'スマホ縦長'], ['16:9', 'ワイド']];
  const hasCtx = ctx.title || ctx.description;
  const w = openModal({
    title: `${ic('sparkles', 'w-4 h-4 inline text-violet-600')} AIでチラシ画像を生成`,
    size: 'max-w-3xl',
    body: `<div class="grid sm:grid-cols-2 gap-5">
      <form id="aim-form" class="space-y-3">
        <div class="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
          ${hasCtx ? `<p class="font-bold text-slate-800 mb-0.5">${esc(ctx.title || '（イベント名未入力）')}</p><p class="line-clamp-2">${esc(ctx.description || ctx.category || '')}</p>`
    : `${ic('info', 'w-3.5 h-3.5 inline')} 登録フォームのイベント名・案内文が空です。下の「イメージの指示」に描いてほしい内容を書いてください。`}
        </div>
        <div><span class="label">画風</span><div class="flex flex-wrap gap-1.5">
          ${styles.map(([v, l], i) => `<label class="cursor-pointer"><input type="radio" name="style" value="${v}" class="peer sr-only" ${i === 0 ? 'checked' : ''}><span class="inline-flex px-3 h-8 items-center rounded-lg border border-slate-300 text-xs font-bold text-slate-700 peer-checked:bg-violet-600 peer-checked:text-white peer-checked:border-violet-600 peer-focus-visible:ring-2 peer-focus-visible:ring-violet-400">${l}</span></label>`).join('')}
        </div></div>
        <div><label class="label" for="aim-aspect">サイズ</label><select id="aim-aspect" name="aspect" class="input">
          ${aspects.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div><label class="label" for="aim-extra">イメージの指示（任意）</label>
          <textarea id="aim-extra" name="extra" rows="2" maxlength="300" class="input" placeholder="例：卓球台とラケット、明るい体育館、笑顔の雰囲気"></textarea></div>
        <fieldset class="rounded-xl border border-slate-200 p-3 space-y-2">
          <legend class="label px-1">画像に入れる文字</legend>
          <div><label class="label" for="aim-pos">文字の位置</label><select id="aim-pos" name="text_position" class="input">
            <option value="top">上に入れる</option><option value="bottom">下に入れる</option><option value="none">文字を入れない</option></select></div>
          <div data-aim-textfields class="space-y-2">
            <div><label class="label" for="aim-title">タイトル</label><input id="aim-title" name="title_text" class="input" maxlength="40" value="${esc(ctx.title)}"></div>
            <div><label class="label" for="aim-sub">サブ文字（日時・場所など）</label><input id="aim-sub" name="sub_text" class="input" maxlength="60" value="${esc(defaultSubText(ctx))}"></div>
          </div>
          <p class="text-[11px] text-slate-500">文字はAIに描かせず、サイトのフォントで正確に重ねるので文字化けしません。生成後に書き換えても作り直しは不要です。</p>
        </fieldset>
        <button type="submit" class="btn-ai w-full py-2.5">${ic('sparkles')}画像を生成する</button>
      </form>
      <div id="aim-result" class="rounded-2xl bg-slate-50 border border-slate-200 p-4 text-sm text-slate-500 flex flex-col items-center justify-center gap-2 min-h-[260px] text-center">
        ${ic('image', 'w-8 h-8 text-slate-300')}<p>画風とサイズを選んで「画像を生成する」を押してください。<br>生成には20〜40秒ほどかかります。</p>
      </div>
    </div>`,
  });
  const form = w.querySelector('#aim-form');
  const box = w.querySelector('#aim-result');
  let raw = null;
  let composed = null;

  const textOpts = () => ({
    title: form.title_text.value, sub: form.sub_text.value, position: form.text_position.value,
  });
  const syncTextFields = () => { w.querySelector('[data-aim-textfields]').classList.toggle('hidden', form.text_position.value === 'none'); };
  syncTextFields();

  const renderResult = async () => {
    if (!raw) return;
    composed = await composeFlyer(raw, textOpts());
    const imgEl = box.querySelector('[data-aim-img]');
    if (imgEl) { imgEl.src = composed; return; }
    box.className = 'space-y-3';
    box.innerHTML = `<img data-aim-img src="${composed}" alt="AIが生成したチラシ画像" class="w-full h-auto rounded-xl border border-slate-200">
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn-primary flex-1" data-aim-use>${ic('check')}この画像を使う</button>
        <button type="button" class="btn-secondary" data-aim-retry>${ic('refresh-cw')}絵を作り直す</button>
      </div>
      <p class="text-[11px] text-slate-400">AI生成画像です。内容を確認してからお使いください。</p>`;
    icons();
    box.querySelector('[data-aim-retry]').onclick = generate;
    box.querySelector('[data-aim-use]').onclick = async (e) => {
      const b = e.currentTarget;
      setBusy(b, true, '保存中…');
      try { await onUse(composed); closeModal(w); } catch (_) { setBusy(b, false); }
    };
  };

  const recompose = debounce(() => { renderResult().catch((e) => toast(e.message, 'error')); }, 250);
  form.text_position.addEventListener('change', () => { syncTextFields(); recompose(); });
  form.title_text.addEventListener('input', recompose);
  form.sub_text.addEventListener('input', recompose);

  async function generate() {
    const fd = new FormData(form);
    const payload = Object.assign({}, ctx, {
      style: fd.get('style'), aspect: fd.get('aspect'), extra: String(fd.get('extra') || '').trim(),
      text_position: fd.get('text_position'),
    });
    if (!payload.title && !payload.description && !payload.extra) { toast('イメージの指示を入力してください', 'error'); return; }
    const btn = form.querySelector('button[type=submit]');
    setBusy(btn, true, '生成中…');
    raw = null;
    box.className = 'rounded-2xl bg-slate-50 border border-slate-200 p-4 text-sm text-slate-500 flex flex-col items-center justify-center gap-3 min-h-[260px] text-center';
    box.innerHTML = '<div class="typing"><span></span><span></span><span></span></div><p class="text-xs">AIが画像を描いています…</p>';
    try {
      const d = await api('generateFlyerImage', payload);
      raw = d.base64;
      box.innerHTML = '';
      await renderResult();
    } catch (err) {
      box.className = 'rounded-2xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700 flex flex-col items-center justify-center gap-2 min-h-[260px] text-center';
      box.innerHTML = `${ic('circle-alert', 'w-6 h-6')}<p class="font-bold">生成できませんでした</p><p class="text-xs leading-relaxed break-all">${esc(err.message)}</p>`;
      icons();
    } finally {
      setBusy(btn, false);
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); generate(); });
}

function collectEventFields(form) {
  const d = Object.fromEntries(new FormData(form));
  ['capacity', 'fee', 'deadline_hours_before'].forEach((k) => { if (d[k] !== undefined) d[k] = Number(d[k]); });
  d.is_approval_required = d.is_approval_required === 'true';
  return d;
}

function validateEventClient(d, withDate = true) {
  if (!d.title) return 'イベント名を入力してください';
  if (!d.location) return '開催場所を入力してください';
  if (withDate && !d.event_date) return '開催日を選んでください';
  if (!d.start_time || !d.end_time) return '開始・終了時刻を入力してください';
  if (d.end_time <= d.start_time) return '終了時刻は開始時刻より後にしてください';
  if (!(d.capacity >= 1)) return '定員は1名以上にしてください';
  if (d.fee < 0) return '参加費が正しくありません';
  return '';
}

// ---------------------------------------------------------------------
// 共同主催者の選択
// ---------------------------------------------------------------------
function coPickerHtml() {
  return `<div class="rounded-xl border border-slate-200 p-3" data-co-box>
    <p class="label flex items-center gap-1">${ic('users', 'w-3.5 h-3.5')}共同主催者（任意）</p>
    <div data-co-list class="text-xs text-slate-500">読み込み中…</div>
  </div>`;
}

/** 共同主催者ピッカーを有効化。box._get() で選択IDの配列（変更不可なら undefined）を返す */
async function bindCoPicker(root, { selected = [], editable = true, ownerId = '', names = [] } = {}) {
  const box = root.querySelector('[data-co-box]');
  if (!box) return;
  const list = box.querySelector('[data-co-list]');
  box._get = () => (editable ? $$('input[data-co]:checked', box).map((c) => c.value) : undefined);
  if (!editable) {
    list.innerHTML = `${names.length ? `<div class="flex flex-wrap gap-1.5 mb-1">${names.map((n) => `<span class="pill bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">${ic('user', 'w-3 h-3')}${esc(n)}</span>`).join('')}</div>` : '<p>なし</p>'}
      <p class="text-[11px] text-slate-400">共同主催者の変更は、イベントの登録者またはシステム管理者のみ行えます。</p>`;
    icons();
    return;
  }
  let cands = [];
  try {
    cands = (await api('listCoOrganizerCandidates', { organizer_id: ownerId })).candidates || [];
  } catch (e) { list.textContent = e.message; return; }
  if (!box.isConnected) return;
  if (!cands.length) {
    list.innerHTML = `<p>共同主催者がいません。<button type="button" data-act="go-members" class="text-indigo-600 font-bold underline">会員管理</button> でメンバーを追加し「共同主催者」にチェックすると、ここで選べます。</p>`;
    return;
  }
  list.innerHTML = `<div class="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">${cands.map((c) => `<label class="cursor-pointer" title="${esc(c.email)}">
      <input type="checkbox" data-co value="${esc(c.user_id)}" class="peer sr-only" ${selected.includes(c.user_id) ? 'checked' : ''}>
      <span class="inline-flex items-center gap-1 px-2.5 h-8 rounded-full border border-slate-300 text-xs font-bold text-slate-700 peer-checked:bg-emerald-600 peer-checked:text-white peer-checked:border-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-400">${ic('user', 'w-3 h-3')}${esc(c.name)}</span></label>`).join('')}</div>
    <p class="text-[11px] text-slate-500 mt-1.5">共同主催者は、あなたの主催イベントをすべて確認できます。ここで選んだ人は、このイベントの管理（編集・承認・精算）もできます。中止・削除と共同主催者の変更は登録者のみです。</p>`;
  icons();
}

function openEventForm(ev = null, prefill = {}) {
  const editing = !!ev;
  const owner = !editing || ev.is_owner !== false;
  const v = Object.assign({}, ev || {}, prefill);
  if (!editing && !v.event_date) v.event_date = '';
  const w = openModal({
    title: editing ? 'イベント枠の編集' : 'イベント枠の新規登録',
    size: 'max-w-2xl',
    body: `<form id="ev-form" class="space-y-3" novalidate>
      ${editing && !owner ? `<p class="text-xs text-emerald-700 bg-emerald-50 rounded-lg p-2.5">${ic('users', 'w-3.5 h-3.5 inline')} 共同主催者として編集しています（登録者：${esc(ev.organizer_name)}）。</p>` : ''}
      ${eventFieldsHtml(v, { withDate: true, withStatus: editing })}
      ${flyerUploaderHtml(v, { groupOption: editing && !!ev.recurring_group_id })}
      ${coPickerHtml()}
      ${!editing && state.dash && state.dash.quota.max ? `<p class="text-xs text-slate-500">${ic('layers', 'w-3.5 h-3.5 inline')} 現在 ${state.dash.quota.used} / ${state.dash.quota.max} 枠使用中。登録すると1枠使用します。</p>` : ''}
      ${editing && ev.recurring_group_id ? '<p class="text-xs text-slate-500">この枠は定期開催グループの1回分です。内容の変更はこの日だけに反映され、共同主催者の変更は今後の全回に反映されます。</p>' : ''}
    </form>`,
    footer: `${editing && owner ? `<div class="mr-auto flex gap-1">
        <button class="btn-ghost text-rose-600" data-ev-cancel>${ic('ban')}中止</button>
        <button class="btn-ghost text-slate-500" data-ev-delete>${ic('trash-2')}削除</button></div>` : ''}
      <button class="btn-secondary" data-close-btn>閉じる</button>
      <button class="btn-primary" data-ev-save>${ic('check')}${editing ? '変更を保存' : '登録する'}</button>`,
  });
  const form = w.querySelector('#ev-form');
  bindFlyerUploader(w, { eventId: editing ? ev.event_id : '' });
  bindCoPicker(w, {
    selected: (ev && ev.co_organizer_ids) || [],
    editable: owner,
    ownerId: editing ? ev.organizer_id : (state.user && state.user.user_id),
    names: (ev && ev.co_organizer_names) || [],
  });
  w.querySelector('[data-close-btn]').onclick = () => closeModal(w);
  w.querySelector('[data-ev-save]').onclick = async (e) => {
    const d = collectEventFields(form);
    const msg = validateEventClient(d);
    if (msg) { toast(msg, 'error'); return; }
    if (d.event_date < todayStr() || d.event_date > maxStr()) { toast(`開催日は ${todayStr()} 〜 ${maxStr()} の範囲で選んでください`, 'error'); return; }
    const coBox = w.querySelector('[data-co-box]');
    const co = coBox && coBox._get ? coBox._get() : undefined;
    if (co !== undefined) d.co_organizer_ids = co;
    const btn = e.currentTarget;
    setBusy(btn, true, '保存中…');
    const r = await run(() => (editing ? api('updateEvent', { event_id: ev.event_id, event: d }) : api('createEvent', { event: d })));
    setBusy(btn, false);
    if (!r) return;
    closeModal(w);
    toast(editing ? `変更を保存しました${r.notified ? `（参加者${r.notified}件に通知）` : ''}` : 'イベント枠を登録しました', 'success');
    refreshOrganizer();
  };
  const cancelBtn = w.querySelector('[data-ev-cancel]');
  if (cancelBtn) cancelBtn.onclick = () => cancelEventFlow(ev, w);
  const delBtn = w.querySelector('[data-ev-delete]');
  if (delBtn) delBtn.onclick = () => deleteEventFlow(ev, w);
}

async function cancelEventFlow(ev, parentModal) {
  const groupMsg = ev.recurring_group_id ? '\n\n※定期開催の他の日も中止する場合は、続けて表示される確認で選べます。' : '';
  const r = await confirmDialog({
    title: 'イベントの中止',
    message: `「${ev.title}」（${dateLabel(ev)}）を中止します。申込済みの方には中止メールが送られます。${groupMsg}`,
    okLabel: 'この日を中止する', danger: true, input: { label: '中止の理由（参加者へのメールに記載・任意）', placeholder: '例：講師の体調不良のため' },
  });
  if (!r) return;
  let scope = 'single';
  if (ev.recurring_group_id) {
    const g = await confirmDialog({ title: '定期開催グループ', message: '同じ定期開催の、今後のすべての回も中止しますか？\n「この日だけ」にする場合は「やめる」を押してください。', okLabel: '今後の全回を中止', danger: true });
    if (g) scope = 'group';
  }
  const d = await run(() => api('cancelEvent', { event_id: ev.event_id, scope, reason: r.value }));
  if (!d) return;
  if (parentModal) closeModal(parentModal);
  toast(`${d.cancelled_events}件のイベントを中止しました（予約${d.cancelled_reservations}件に通知）`, 'success');
  refreshOrganizer();
}

async function deleteEventFlow(ev, parentModal) {
  const ok = await confirmDialog({
    title: 'イベントの削除',
    message: `「${ev.title}」（${dateLabel(ev)}）を削除します。元に戻せません。\n申込中・確定の予約がある場合は削除できないので、先に「中止」を行ってください。`,
    okLabel: 'この日を削除する', danger: true,
  });
  if (!ok) return;
  let scope = 'single';
  if (ev.recurring_group_id) {
    const g = await confirmDialog({ title: '定期開催グループ', message: '同じ定期開催の、今後のすべての回も削除しますか？\n「この日だけ」にする場合は「やめる」を押してください。', okLabel: '今後の全回を削除', danger: true });
    if (g) scope = 'group';
  }
  const d = await run(() => api('deleteEvent', { event_id: ev.event_id, scope }));
  if (!d) return;
  if (parentModal) closeModal(parentModal);
  toast(`${d.deleted_events}件のイベントを削除しました`, 'success');
  refreshOrganizer();
}

// ---------------------------------------------------------------------
// 定期開催 一括生成ウィザード
// ---------------------------------------------------------------------
function openRecurringWizard() {
  const seen = new Set();
  const bases = (state.dash ? state.dash.events : []).filter((e) => {
    const k = e.recurring_group_id || e.event_id;
    if (e.status === 'cancelled' || seen.has(k)) return false;
    seen.add(k); return true;
  });
  const q = state.dash && state.dash.quota;
  const w = openModal({
    title: '定期開催 一括生成',
    size: 'max-w-3xl',
    body: `<form id="rc-form" class="space-y-5" novalidate>
      <section class="space-y-3">
        <h3 class="font-bold text-slate-900 flex items-center gap-2"><span class="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs inline-flex items-center justify-center">1</span>開催内容</h3>
        <div><label class="label" for="rc-base">既存のイベントから内容をコピー（任意）</label>
          <select id="rc-base" class="input"><option value="">新しく入力する</option>
          ${bases.map((e) => `<option value="${esc(e.event_id)}">${esc(e.title)}（${esc(slashDate(e.event_date))}〜）</option>`).join('')}</select></div>
        <div id="rc-fields" class="space-y-3">${eventFieldsHtml({}, { withDate: false })}${flyerUploaderHtml({})}</div>
        <div id="rc-co">${coPickerHtml()}</div>
      </section>
      <section class="space-y-3">
        <h3 class="font-bold text-slate-900 flex items-center gap-2"><span class="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs inline-flex items-center justify-center">2</span>繰り返しのルール</h3>
        <div class="seg" role="radiogroup" aria-label="繰り返しパターン">
          <label class="seg-btn cursor-pointer has-[:checked]:bg-white has-[:checked]:text-indigo-700 has-[:checked]:shadow-sm"><input type="radio" name="rc_type" value="weekly" class="sr-only" checked>毎週</label>
          <label class="seg-btn cursor-pointer has-[:checked]:bg-white has-[:checked]:text-indigo-700 has-[:checked]:shadow-sm"><input type="radio" name="rc_type" value="biweekly" class="sr-only">隔週</label>
          <label class="seg-btn cursor-pointer has-[:checked]:bg-white has-[:checked]:text-indigo-700 has-[:checked]:shadow-sm"><input type="radio" name="rc_type" value="monthly_nth" class="sr-only">毎月 第○曜日</label>
        </div>
        <div><span class="label">曜日</span><div class="flex flex-wrap gap-1.5">
          ${WD.map((d, i) => `<label class="cursor-pointer"><input type="checkbox" name="rc_wd" value="${i}" class="peer sr-only"><span class="inline-flex w-10 h-10 items-center justify-center rounded-lg border border-slate-300 text-sm font-bold peer-checked:bg-indigo-600 peer-checked:text-white peer-checked:border-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-400 ${i === 0 ? 'text-rose-500' : i === 6 ? 'text-sky-600' : 'text-slate-700'}">${d}</span></label>`).join('')}
        </div></div>
        <div id="rc-nths" class="hidden"><span class="label">第何週</span><div class="flex flex-wrap gap-1.5">
          ${[[1, '第1'], [2, '第2'], [3, '第3'], [4, '第4'], [5, '第5'], [-1, '最終']].map(([n, l]) => `<label class="cursor-pointer"><input type="checkbox" name="rc_nth" value="${n}" class="peer sr-only"><span class="inline-flex px-3 h-9 items-center rounded-lg border border-slate-300 text-sm font-bold text-slate-700 peer-checked:bg-indigo-600 peer-checked:text-white peer-checked:border-indigo-600">${l}</span></label>`).join('')}
        </div></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="label" for="rc-from">開始日</label><input id="rc-from" name="rc_from" type="date" class="input" min="${todayStr()}" max="${maxStr()}" value="${todayStr()}"></div>
          <div><label class="label" for="rc-to">終了日（最大 ${slashDate(maxStr())}）</label><input id="rc-to" name="rc_to" type="date" class="input" min="${todayStr()}" max="${maxStr()}" value="${maxStr()}"></div>
        </div>
      </section>
      <section class="space-y-3">
        <h3 class="font-bold text-slate-900 flex items-center gap-2"><span class="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs inline-flex items-center justify-center">3</span>日程の確認</h3>
        <button type="button" class="btn-secondary" data-rc-preview>${ic('calendar-search')}開催日をプレビュー</button>
        <div id="rc-preview" class="text-sm text-slate-500">ルールを決めたらプレビューで日程を確認してください。不要な日はチェックを外せます。</div>
      </section>
    </form>`,
    footer: `${q && q.max ? `<span class="text-xs text-slate-500 mr-auto self-center">${ic('layers', 'w-3.5 h-3.5 inline')} 定期グループは1枠として数えます（現在 ${q.used}/${q.max}）</span>` : ''}
      <button class="btn-secondary" data-close-btn>閉じる</button>
      <button class="btn-dark" data-rc-create disabled>${ic('repeat')}一括登録する</button>`,
  });
  const form = w.querySelector('#rc-form');
  const createBtn = w.querySelector('[data-rc-create]');
  let preview = null;
  bindFlyerUploader(w.querySelector('#rc-fields'));
  bindCoPicker(w.querySelector('#rc-co'), { ownerId: state.user && state.user.user_id });
  w.querySelector('[data-close-btn]').onclick = () => closeModal(w);

  const invalidate = () => { preview = null; createBtn.disabled = true; };
  const syncType = () => {
    const t = form.rc_type.value;
    w.querySelector('#rc-nths').classList.toggle('hidden', t !== 'monthly_nth');
  };
  form.addEventListener('change', (e) => {
    if (e.target.name === 'rc_type') syncType();
    if (!e.target.closest('#rc-preview') && !e.target.closest('[data-co-box]')) invalidate();
  });

  w.querySelector('#rc-base').addEventListener('change', (e) => {
    const base = bases.find((b) => b.event_id === e.target.value);
    const box = w.querySelector('#rc-fields');
    box.innerHTML = eventFieldsHtml(base || {}, { withDate: false }) + flyerUploaderHtml(base || {});
    bindFlyerUploader(box);
    icons();
    invalidate();
  });

  const buildPattern = () => {
    const type = form.rc_type.value;
    const weekdays = $$('input[name=rc_wd]:checked', form).map((c) => Number(c.value));
    const nths = $$('input[name=rc_nth]:checked', form).map((c) => Number(c.value));
    return { type, weekdays, nths, start_date: form.rc_from.value, end_date: form.rc_to.value };
  };

  w.querySelector('[data-rc-preview]').onclick = async (e) => {
    const ev = collectEventFields(form);
    const msg = validateEventClient(ev, false);
    if (msg) { toast(msg, 'error'); return; }
    const pattern = buildPattern();
    if (!pattern.weekdays.length) { toast('曜日を選んでください', 'error'); return; }
    if (pattern.type === 'monthly_nth' && !pattern.nths.length) { toast('第何週かを選んでください', 'error'); return; }
    const btn = e.currentTarget;
    setBusy(btn, true, '計算中…');
    const d = await run(() => api('previewRecurring', { event: ev, pattern }));
    setBusy(btn, false);
    if (!d) return;
    preview = { ev, pattern, dates: d.dates };
    const box = w.querySelector('#rc-preview');
    if (!d.dates.length) { box.innerHTML = '<p class="text-rose-600">条件に該当する開催日がありません。</p>'; return; }
    const over = d.quota.max && d.quota.after > d.quota.max;
    box.innerHTML = `<p class="mb-2 text-slate-700"><b>${d.count}回</b>の開催を作成します（${esc(d.base.start_time)}〜${esc(d.base.end_time)}）。</p>
      ${over ? `<p class="mb-2 text-rose-600 text-xs">${ic('circle-alert', 'w-3.5 h-3.5 inline')} 枠の上限（${d.quota.max}枠）を超えるため登録できません。終了・中止した枠があれば空きます。</p>` : ''}
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 max-h-64 overflow-y-auto">
        ${d.dates.map((x) => `<label class="flex items-center gap-1.5 rounded-lg border ${x.conflict_title ? 'border-amber-300 bg-amber-50' : 'border-slate-200'} px-2 py-1.5 text-xs cursor-pointer">
          <input type="checkbox" class="rounded border-slate-300 text-indigo-600" data-rc-date="${x.date}" checked>
          <span><b>${slashDate(x.date).slice(5)}</b>（${x.weekday}）${x.conflict_title ? `<span class="block text-[10px] text-amber-700 truncate">同時刻に既存枠あり</span>` : ''}</span></label>`).join('')}
      </div>`;
    createBtn.disabled = !!over;
    icons();
  };

  createBtn.onclick = async (e) => {
    if (!preview) return;
    const checked = $$('[data-rc-date]', w);
    const skip = checked.filter((c) => !c.checked).map((c) => c.dataset.rcDate);
    const count = checked.length - skip.length;
    if (!count) { toast('作成する日を1つ以上選んでください', 'error'); return; }
    const ok = await confirmDialog({ title: '一括登録', message: `「${preview.ev.title}」を ${count}回分 登録します。よろしいですか？`, okLabel: '登録する' });
    if (!ok) return;
    const btn = e.currentTarget;
    setBusy(btn, true, '登録中…');
    const coBox = w.querySelector('[data-co-box]');
    const co = coBox && coBox._get ? coBox._get() : [];
    const d = await run(() => api('createRecurring', { event: Object.assign({}, preview.ev, { co_organizer_ids: co || [] }), pattern: Object.assign({}, preview.pattern, { skip_dates: skip }) }));
    setBusy(btn, false);
    if (!d) return;
    closeModal(w);
    toast(`${d.count}回分の定期開催を登録しました`, 'success');
    refreshOrganizer();
  };
}

// ---------------------------------------------------------------------
// AIチラシ・告知文生成
// ---------------------------------------------------------------------
function openAiFlyer() {
  const w = openModal({
    title: `${ic('sparkles', 'w-4 h-4 inline text-violet-600')} AIチラシ・告知文生成`,
    size: 'max-w-3xl',
    body: `<div class="grid lg:grid-cols-2 gap-5">
      <form id="ai-form" class="space-y-3">
        <p class="text-xs text-slate-500">箇条書きやメモ程度でOKです。入力した内容をもとに、キャッチコピー・案内文・チラシのレイアウト案を作ります。</p>
        <div><label class="label" for="ai-title">イベント名</label><input id="ai-title" name="title" class="input" maxlength="100" placeholder="例：はじめてのラテンサルサ体験"></div>
        <div><label class="label" for="ai-purpose">開催目的・内容</label><textarea id="ai-purpose" name="purpose" rows="3" class="input" placeholder="例：初心者が基本ステップを楽しく覚える"></textarea></div>
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="label" for="ai-target">ターゲット層</label><input id="ai-target" name="target" class="input" placeholder="例：運動不足の30〜60代"></div>
          <div><label class="label" for="ai-bring">持ち物</label><input id="ai-bring" name="belongings" class="input" placeholder="例：動きやすい服、飲み物"></div>
          <div><label class="label" for="ai-dt">日時</label><input id="ai-dt" name="datetime" class="input" placeholder="例：10/29(木) 19:30〜"></div>
          <div><label class="label" for="ai-loc">場所</label><input id="ai-loc" name="location" class="input" placeholder="例：横浜ダンススタジオ"></div>
          <div><label class="label" for="ai-fee">参加費</label><input id="ai-fee" name="fee" class="input" placeholder="例：2,000円（当日現地）"></div>
          <div><label class="label" for="ai-cap">定員</label><input id="ai-cap" name="capacity" class="input" placeholder="例：12名"></div>
        </div>
        <div><label class="label" for="ai-tone">雰囲気</label><select id="ai-tone" name="tone" class="input">
          ${['親しみやすく前向き', '落ち着いて丁寧', '元気でワクワク', 'ビジネス向けで信頼感', 'シニアにやさしく分かりやすく'].map((t) => `<option>${t}</option>`).join('')}</select></div>
        <div><label class="label" for="ai-notes">補足メモ</label><textarea id="ai-notes" name="notes" rows="2" class="input" placeholder="例：ペア不要、1人参加歓迎"></textarea></div>
        <button type="submit" class="btn-ai w-full py-2.5">${ic('sparkles')}AIで作成する</button>
      </form>
      <div id="ai-result" class="rounded-2xl bg-slate-50 border border-slate-200 p-4 text-sm text-slate-500 flex items-center justify-center min-h-[240px] text-center">左の内容を入力して「AIで作成する」を押すと、ここに結果が表示されます。</div>
    </div>`,
  });
  const form = w.querySelector('#ai-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const payload = Object.fromEntries(new FormData(form));
    if (!payload.title && !payload.purpose && !payload.notes) { toast('イベント名・目的・メモのいずれかを入力してください', 'error'); return; }
    setBusy(btn, true, 'AIが作成中…');
    const box = w.querySelector('#ai-result');
    box.innerHTML = '<div class="typing" aria-label="作成中"><span></span><span></span><span></span></div>';
    let d;
    try {
      d = await api('generateFlyerText', payload);
    } catch (err) {
      setBusy(btn, false);
      box.className = 'rounded-2xl bg-rose-50 border border-rose-200 p-4 text-sm text-rose-700 flex flex-col items-center justify-center gap-2 min-h-[240px] text-center';
      box.innerHTML = `${ic('circle-alert', 'w-6 h-6')}<p class="font-bold">作成できませんでした</p><p class="text-xs leading-relaxed break-all">${esc(err.message)}</p>`;
      icons();
      return;
    }
    setBusy(btn, false);
    const r = d.result || {};
    const layout = r.layout || {};
    const layoutLabels = { headline_area: '見出し', visual: 'ビジュアル', color_palette: '配色', typography: '書体', info_block: '情報ブロック', call_to_action: '行動喚起' };
    const grad = GRADIENTS[hashIdx(r.category || r.title, GRADIENTS.length)];
    box.className = 'space-y-4 text-left';
    box.innerHTML = `
      <div class="rounded-2xl bg-gradient-to-br ${grad} text-white p-5 aspect-[3/4] max-h-80 flex flex-col justify-between shadow-inner">
        <div><p class="text-[11px] font-bold text-white/80">${esc(r.category || '')}</p>
          <p class="text-2xl font-black leading-tight mt-2">${esc(r.catchcopy || '')}</p>
          <p class="text-sm mt-2 text-white/90">${esc(r.sub_catchcopy || '')}</p></div>
        <div><p class="font-black text-lg leading-snug">${esc(r.title || '')}</p>
          <p class="text-xs text-white/85 mt-1">${esc([payload.datetime, payload.location, payload.fee].filter(Boolean).join('　'))}</p></div>
      </div>
      <div class="space-y-3">
        ${aiBlock('SNS用の短い告知', r.short_announcement)}
        ${aiBlock('案内文', r.description)}
        ${r.hashtags && r.hashtags.length ? aiBlock('ハッシュタグ', r.hashtags.join(' ')) : ''}
        <details class="rounded-xl bg-white border border-slate-200 p-3"><summary class="text-xs font-bold text-slate-700 cursor-pointer">チラシのレイアウト案</summary>
          <dl class="mt-2 space-y-1.5 text-xs">${Object.keys(layoutLabels).filter((k) => layout[k]).map((k) => `<div><dt class="font-bold text-slate-600">${layoutLabels[k]}</dt><dd class="text-slate-700">${esc(layout[k])}</dd></div>`).join('')}</dl></details>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn-primary flex-1" data-ai-apply>${ic('file-input')}この内容でイベントを登録</button>
        <button type="button" class="btn-secondary" data-ai-recurring>${ic('repeat')}定期開催で使う</button>
      </div>`;
    icons();
    box.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast('コピーしました', 'success'); } catch (_) { toast('コピーできませんでした', 'error'); }
    }));
    const fill = Object.assign({}, d.form_fill, {
      location: payload.location || '',
    });
    box.querySelector('[data-ai-apply]').onclick = () => { closeModal(w); openEventForm(null, fill); };
    box.querySelector('[data-ai-recurring]').onclick = () => {
      closeModal(w);
      openRecurringWizard();
      const rw = $$('#modal-root > div').pop();
      const fields = rw && rw.querySelector('#rc-fields');
      if (fields) {
        fields.innerHTML = eventFieldsHtml(fill, { withDate: false }) + flyerUploaderHtml({});
        bindFlyerUploader(fields); icons();
      }
    };
  });
}

function aiBlock(label, text) {
  if (!text) return '';
  return `<div class="rounded-xl bg-white border border-slate-200 p-3">
    <div class="flex items-center justify-between mb-1"><p class="text-xs font-bold text-slate-600">${esc(label)}</p>
      <button type="button" class="text-xs text-indigo-600 font-bold inline-flex items-center gap-1" data-copy="${esc(text)}">${ic('copy', 'w-3.5 h-3.5')}コピー</button></div>
    <p class="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">${esc(text)}</p></div>`;
}

// ---------------------------------------------------------------------
// 参加者名簿・受付
// ---------------------------------------------------------------------
async function openParticipants(eventId) {
  const w = openModal({
    title: '参加者名簿・受付',
    size: 'max-w-4xl',
    body: '<div class="py-12 text-center"><div class="typing"><span></span><span></span><span></span></div></div>',
  });
  w._eventId = eventId;
  w._showCancelled = false;
  w._onClose = () => { if (w._dirty) refreshOrganizer(); };
  w.addEventListener('click', (e) => onParticipantAction(e, w));
  await loadParticipants(w);
}

async function loadParticipants(w) {
  try {
    w._data = await api('listParticipants', { event_id: w._eventId, include_cancelled: true });
    renderParticipants(w);
  } catch (e) {
    w.querySelector('.modal-body').innerHTML = emptyState('circle-alert', '名簿を読み込めませんでした', e.message);
    icons();
  }
}

function renderParticipants(w) {
  const { event: ev, participants, totals } = w._data;
  const canManage = w._data.can_manage !== false;
  const list = w._showCancelled ? participants : participants.filter((p) => p.status === 'pending' || p.status === 'confirmed');
  const paid = ev.fee > 0;
  const row = (p) => {
    if (!canManage) {
      return `<tr class="border-t border-slate-100 align-top ${p.status === 'cancelled' || p.status === 'rejected' ? 'opacity-50' : ''}">
        <td class="py-2.5 pr-3"><p class="font-bold text-slate-900">${esc(p.applicant_name)}${p.registered_by ? ' <span class="pill bg-violet-50 text-violet-700">主催者登録</span>' : ''}</p><p class="text-[11px] text-slate-400">${esc(p.applied_at.slice(5, 16))} 申込</p>${p.note ? `<p class="text-[11px] text-slate-500 mt-0.5 max-w-[16rem] break-words">${esc(p.note)}</p>` : ''}</td>
        <td class="py-2.5 pr-3 text-center font-black">${p.guest_count}<span class="text-[11px] font-normal text-slate-400">名</span></td>
        <td class="py-2.5 pr-3 text-xs"><a href="tel:${esc(p.applicant_phone)}" class="block text-slate-700">${esc(p.applicant_phone)}</a><a href="mailto:${esc(p.applicant_email)}" class="block text-slate-500 break-all">${esc(p.applicant_email)}</a></td>
        <td class="py-2.5 pr-3"><span class="pill ${RESV_STYLE[p.status] || ''}">${esc(p.status_label)}</span></td>
        <td class="py-2.5 pr-3">${paid && p.status === 'confirmed' ? `<span class="pill ${p.payment_status === 'paid' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}">${esc(p.payment_label)}</span>` : '<span class="text-xs text-slate-300">—</span>'}</td>
        <td></td></tr>`;
    }
    const actions = p.status === 'pending'
      ? `<button data-pact="approve" data-id="${esc(p.reservation_id)}" class="btn-primary btn-sm">${ic('check', 'w-3.5 h-3.5')}承認</button>
         <button data-pact="reject" data-id="${esc(p.reservation_id)}" class="btn-secondary btn-sm text-rose-600">却下</button>`
      : p.status === 'confirmed' ? `<button data-pact="cancel" data-id="${esc(p.reservation_id)}" class="btn-ghost btn-sm text-slate-500">取消</button>` : '';
    const pay = paid && p.status === 'confirmed'
      ? `<button data-pact="pay" data-id="${esc(p.reservation_id)}" data-next="${p.payment_status === 'paid' ? 'unpaid' : 'paid'}" role="switch" aria-checked="${p.payment_status === 'paid'}"
          class="inline-flex items-center gap-1.5 rounded-full pl-1 pr-2.5 py-1 text-xs font-bold ${p.payment_status === 'paid' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}">
          <span class="w-4 h-4 rounded-full inline-flex items-center justify-center ${p.payment_status === 'paid' ? 'bg-emerald-500 text-white' : 'bg-white border border-slate-300'}">${p.payment_status === 'paid' ? ic('check', 'w-3 h-3') : ''}</span>${esc(p.payment_label)}</button>`
      : '<span class="text-xs text-slate-300">—</span>';
    return `<tr class="border-t border-slate-100 align-top ${p.status === 'cancelled' || p.status === 'rejected' ? 'opacity-50' : ''}">
      <td class="py-2.5 pr-3"><p class="font-bold text-slate-900">${esc(p.applicant_name)}${p.registered_by ? ' <span class="pill bg-violet-50 text-violet-700">主催者登録</span>' : ''}</p><p class="text-[11px] text-slate-400">${esc(p.applied_at.slice(5, 16))} 申込</p>${p.note ? `<p class="text-[11px] text-slate-500 mt-0.5 max-w-[16rem] break-words">${esc(p.note)}</p>` : ''}</td>
      <td class="py-2.5 pr-3 text-center font-black">${p.guest_count}<span class="text-[11px] font-normal text-slate-400">名</span></td>
      <td class="py-2.5 pr-3 text-xs"><a href="tel:${esc(p.applicant_phone)}" class="block text-slate-700 hover:text-indigo-600">${esc(p.applicant_phone)}</a><a href="mailto:${esc(p.applicant_email)}" class="block text-slate-500 hover:text-indigo-600 break-all">${esc(p.applicant_email)}</a></td>
      <td class="py-2.5 pr-3"><span class="pill ${RESV_STYLE[p.status] || ''}">${esc(p.status_label)}</span></td>
      <td class="py-2.5 pr-3">${pay}</td>
      <td class="py-2.5 text-right whitespace-nowrap"><div class="inline-flex gap-1">${actions}</div></td>
    </tr>`;
  };
  w.querySelector('.modal-body').innerHTML = `
    <div class="flex flex-col sm:flex-row sm:items-start gap-3 mb-4">
      <div class="min-w-0 flex-1">
        <p class="font-black text-slate-900">${esc(ev.title)}</p>
        <p class="text-xs text-slate-500">${esc(dateLabel(ev))}〜${esc(ev.end_time)}　${esc(ev.location)}</p>
        ${canManage ? '' : `<p class="text-[11px] text-sky-700 mt-1">${ic('eye', 'w-3 h-3 inline')} 共同主催者として確認中です（承認・精算などの操作はこのイベントの主催者が行います）</p>`}
      </div>
      <div class="flex gap-2 shrink-0">
        ${canManage && ev.status !== 'cancelled' ? `<button data-pact="add" class="btn-primary btn-sm">${ic('user-plus', 'w-3.5 h-3.5')}参加者を追加</button>` : ''}
        <button data-pact="csv" class="btn-secondary btn-sm">${ic('download', 'w-3.5 h-3.5')}CSV出力</button>
        <button data-pact="print" class="btn-secondary btn-sm">${ic('printer', 'w-3.5 h-3.5')}印刷</button>
      </div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
      ${miniStat('確定人数', `${totals.confirmed_guests} / ${ev.capacity}名`)}
      ${miniStat('承認待ち', `${totals.pending_guests}名`, totals.pending_guests ? 'text-amber-600' : '')}
      ${paid ? miniStat('精算状況', `済 ${totals.paid_count} / 未 ${totals.unpaid_count}件`) : miniStat('参加費', '無料')}
      ${paid ? miniStat('受取済 / 見込み', `${yen(totals.paid_fee_total)} / ${yen(totals.expected_fee_total)}円`) : miniStat('空き', `${ev.availability.mark} 残${ev.availability.remaining}席`)}
    </div>
    <label class="inline-flex items-center gap-1.5 text-xs text-slate-600 mb-2 cursor-pointer"><input type="checkbox" data-pact="toggle-cancelled" class="rounded border-slate-300 text-indigo-600" ${w._showCancelled ? 'checked' : ''}>取消・却下も表示</label>
    ${list.length ? `<div class="overflow-x-auto -mx-5 px-5"><table class="w-full min-w-[680px] text-sm">
      <thead><tr class="text-left text-[11px] text-slate-500"><th class="pb-2 font-bold">代表者</th><th class="pb-2 font-bold text-center">人数</th><th class="pb-2 font-bold">連絡先</th><th class="pb-2 font-bold">状態</th><th class="pb-2 font-bold">精算</th><th class="pb-2"></th></tr></thead>
      <tbody>${list.map(row).join('')}</tbody></table></div>`
    : emptyState('users', 'まだ申込はありません', canManage ? '電話や当日受付の参加者は「参加者を追加」から登録できます。' : '予約が入るとここに表示されます。')}`;
  icons();
}

/** 主催者・管理者による参加者登録（電話・当日受付・自分の参加など） */
function openAddParticipant(parent) {
  const { event: ev } = parent._data;
  const a = ev.availability;
  const free = Math.max(0, a.capacity - a.confirmed - a.pending);
  const u = state.user;
  const w = openModal({
    title: '参加者を追加',
    size: 'max-w-lg',
    body: `<div class="rounded-xl bg-slate-50 p-3 mb-4 text-xs text-slate-600">
        <p class="font-bold text-slate-900 text-sm">${esc(ev.title)}</p>
        <p>${esc(dateLabel(ev))}〜${esc(ev.end_time)}　残り ${free}席 / 定員 ${a.capacity}名</p>
      </div>
      <form id="ap-form" class="space-y-3" novalidate>
        <button type="button" data-ap-self class="btn-secondary btn-sm">${ic('user')}自分の名前を入れる</button>
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="label" for="ap-name">代表者名</label><input id="ap-name" name="applicant_name" class="input" required maxlength="50"></div>
          <div><label class="label" for="ap-count">参加人数（代表者を含む）</label><input id="ap-count" name="guest_count" type="number" min="1" max="${MAX_GUESTS}" value="1" class="input"></div>
          <div><label class="label" for="ap-phone">電話番号（任意）</label><input id="ap-phone" name="applicant_phone" type="tel" class="input" placeholder="090-1234-5678"></div>
          <div><label class="label" for="ap-email">メール（任意）</label><input id="ap-email" name="applicant_email" type="email" class="input"></div>
        </div>
        <p class="text-[11px] text-slate-500 -mt-1">メールが会員のものと一致すると、その人の「マイ予約」にも表示されます。</p>
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="label" for="ap-status">予約の状態</label><select id="ap-status" name="status" class="input"><option value="confirmed">確定</option><option value="pending">承認待ち</option></select></div>
          ${ev.fee > 0 ? `<div><label class="label" for="ap-pay">精算</label><select id="ap-pay" name="payment_status" class="input"><option value="unpaid">未精算</option><option value="paid">精算済（受け取り済み）</option></select></div>` : ''}
        </div>
        <div><label class="label" for="ap-note">備考（任意）</label><textarea id="ap-note" name="note" rows="2" maxlength="500" class="input" placeholder="例：電話受付、当日参加"></textarea></div>
        <label class="flex items-center gap-2 text-sm text-slate-700 cursor-pointer"><input type="checkbox" name="notify" class="rounded border-slate-300 text-indigo-600">登録したことを本人にメールで知らせる（メール入力時）</label>
        <label class="flex items-center gap-2 text-sm text-slate-700 cursor-pointer"><input type="checkbox" name="allow_over" class="rounded border-slate-300 text-rose-600">定員を超えても登録する</label>
      </form>`,
    footer: `<button class="btn-secondary" data-ap-close>閉じる</button><button class="btn-primary" data-ap-save>${ic('check')}登録する</button>`,
  });
  const f = w.querySelector('#ap-form');
  w.querySelector('[data-ap-self]').onclick = () => {
    f.applicant_name.value = u.name || ''; f.applicant_phone.value = u.phone || ''; f.applicant_email.value = u.email || '';
  };
  w.querySelector('[data-ap-close]').onclick = () => closeModal(w);
  w.querySelector('[data-ap-save]').onclick = async (e) => {
    const d = Object.fromEntries(new FormData(f));
    d.event_id = ev.event_id;
    d.guest_count = Number(d.guest_count);
    d.notify = !!f.notify.checked;
    d.allow_over = !!f.allow_over.checked;
    if (!d.applicant_name.trim()) { toast('代表者名を入力してください', 'error'); return; }
    if (!(d.guest_count >= 1 && d.guest_count <= MAX_GUESTS)) { toast(`参加人数は1〜${MAX_GUESTS}名で入力してください`, 'error'); return; }
    const btn = e.currentTarget;
    setBusy(btn, true, '登録中…');
    const r = await run(() => api('addReservationByOrganizer', d));
    setBusy(btn, false);
    if (!r) return;
    closeModal(w);
    toast(`${r.reservation.applicant_name} さん（${r.reservation.guest_count}名）を登録しました${r.linked_member ? '（会員のマイ予約にも表示）' : ''}${r.mail_sent ? '・メール送信済み' : ''}`, 'success');
    parent._dirty = true;
    state.eventsLoaded = false;
    await loadParticipants(parent);
  };
}

function miniStat(label, value, cls = '') {
  return `<div class="rounded-xl bg-slate-50 px-3 py-2"><p class="text-[11px] text-slate-500">${esc(label)}</p><p class="font-black text-slate-900 text-sm ${cls}">${esc(value)}</p></div>`;
}

async function onParticipantAction(e, w) {
  const b = e.target.closest('[data-pact]');
  if (!b) return;
  const act = b.dataset.pact;
  const id = b.dataset.id;
  if (act === 'toggle-cancelled') { w._showCancelled = b.checked; renderParticipants(w); return; }
  if (act === 'csv') { exportCsv(w._eventId); return; }
  if (act === 'add') { openAddParticipant(w); return; }
  if (act === 'print') { printRoster(w._data); return; }
  if (act === 'pay') {
    const d = await run(() => api('setPaymentStatus', { reservation_id: id, payment_status: b.dataset.next }, { }));
    if (!d) return;
    const p = w._data.participants.find((x) => x.reservation_id === id);
    Object.assign(p, d.reservation);
    recalcTotals(w._data);
    w._dirty = true;
    renderParticipants(w);
    return;
  }
  if (['approve', 'reject', 'cancel'].includes(act)) {
    const p = w._data.participants.find((x) => x.reservation_id === id);
    const msgs = {
      approve: { t: '予約の承認', m: `${p.applicant_name} さん（${p.guest_count}名）の予約を承認し、確定します。`, ok: '承認する', danger: false, input: null },
      reject: { t: '予約の却下', m: `${p.applicant_name} さん（${p.guest_count}名）の申込を却下します。`, ok: '却下する', danger: true, input: { label: '申込者へのメッセージ（任意）', placeholder: '例：定員に達したため' } },
      cancel: { t: '予約の取消', m: `${p.applicant_name} さん（${p.guest_count}名）の確定済み予約を取り消します。`, ok: '取り消す', danger: true, input: { label: '申込者へのメッセージ（任意）', placeholder: '' } },
    }[act];
    const r = await confirmDialog({ title: msgs.t, message: msgs.m + '\n申込者にはメールで通知されます。', okLabel: msgs.ok, danger: msgs.danger, input: msgs.input });
    if (!r) return;
    const d = await run(() => api('setReservationStatus', { reservation_id: id, action: act, reason: r.value }));
    if (!d) return;
    toast(`${d.reservation.status_label}にしました`, 'success');
    w._dirty = true;
    await loadParticipants(w);
  }
}

function recalcTotals(data) {
  const fee = data.event.fee;
  const t = { confirmed_guests: 0, pending_guests: 0, unpaid_count: 0, paid_count: 0, expected_fee_total: 0, paid_fee_total: 0 };
  data.participants.forEach((r) => {
    if (r.status === 'confirmed') {
      t.confirmed_guests += r.guest_count; t.expected_fee_total += fee * r.guest_count;
      if (r.payment_status === 'paid') { t.paid_count++; t.paid_fee_total += fee * r.guest_count; } else t.unpaid_count++;
    }
    if (r.status === 'pending') t.pending_guests += r.guest_count;
  });
  data.totals = t;
}

async function exportCsv(eventId) {
  const d = await run(() => api('exportParticipantsCsv', { event_id: eventId }));
  if (!d) return;
  const blob = new Blob([d.csv], { type: d.mime_type || 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = d.filename || 'participants.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('CSVをダウンロードしました', 'success');
}

function printRoster(data) {
  const { event: ev, participants, totals } = data;
  const list = participants.filter((p) => p.status === 'confirmed' || p.status === 'pending');
  const win = window.open('', '_blank');
  if (!win) { toast('ポップアップがブロックされました。許可してから再度お試しください', 'error'); return; }
  const paid = ev.fee > 0;
  win.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>参加者名簿 - ${esc(ev.title)}</title>
    <style>body{font-family:"Noto Sans JP","Hiragino Kaku Gothic ProN",Meiryo,sans-serif;color:#1e293b;margin:24px;font-size:12px}
    h1{font-size:18px;margin:0 0 4px}p{margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f1f5f9;font-size:11px}
    td.c{text-align:center}.box{display:inline-block;width:14px;height:14px;border:1px solid #64748b}
    @page{size:A4;margin:12mm}</style></head><body>
    <h1>参加者名簿：${esc(ev.title)}</h1>
    <p>${esc(dateLabel(ev))}〜${esc(ev.end_time)}　${esc(ev.location)}</p>
    <p>確定 ${totals.confirmed_guests}名 / 定員 ${ev.capacity}名　承認待ち ${totals.pending_guests}名${paid ? `　参加費 ${yen(ev.fee)}円/名` : ''}　出力日時 ${new Date().toLocaleString('ja-JP')}</p>
    <table><thead><tr><th style="width:28px">No</th><th>代表者名</th><th style="width:40px">人数</th><th>電話番号</th><th>状態</th>${paid ? '<th>精算</th><th style="width:70px">金額</th>' : ''}<th style="width:40px">出欠</th><th>備考</th></tr></thead><tbody>
    ${list.map((p, i) => `<tr><td class="c">${i + 1}</td><td>${esc(p.applicant_name)}</td><td class="c">${p.guest_count}</td><td>${esc(p.applicant_phone)}</td><td>${esc(p.status_label)}</td>
      ${paid ? `<td>${p.status === 'confirmed' ? esc(p.payment_label) : '-'}</td><td style="text-align:right">${yen(ev.fee * p.guest_count)}円</td>` : ''}<td class="c"><span class="box"></span></td><td>${esc(p.note)}</td></tr>`).join('')}
    </tbody></table><script>window.onload=function(){window.print();}<\/script></body></html>`);
  win.document.close();
}

// =====================================================================
// 管理者：会員管理
// =====================================================================
async function renderMembersView() {
  if (!state.memTab || (state.memTab === 'users' && !isAdmin())) state.memTab = 'members';
  const tab = state.memTab;
  $('#app-main').innerHTML = `
    <section class="mb-4">
      <h1 class="text-xl sm:text-2xl font-black text-slate-900">会員管理</h1>
      <p class="text-sm text-slate-500 mt-1">一緒にイベントを主催する人や、主催するイベントにかかわる会員をメンバー名簿にまとめます。名簿は、作成した本人とシステム管理者だけが見られます。</p>
    </section>
    ${isAdmin() ? `<div class="seg mb-4">
      <button data-act="mem-tab" data-tab="members" class="seg-btn ${tab === 'members' ? 'is-active' : ''}">${ic('contact', 'w-3.5 h-3.5')}メンバー名簿</button>
      <button data-act="mem-tab" data-tab="users" class="seg-btn ${tab === 'users' ? 'is-active' : ''}">${ic('shield', 'w-3.5 h-3.5')}全会員（管理者）</button>
    </div>` : ''}
    <div id="mem-body"></div>`;
  icons();
  if (tab === 'users') renderAdminUsersTab($('#mem-body'));
  else renderMemberListTab($('#mem-body'));
}

async function renderMemberListTab(root) {
  const scopeAll = isAdmin() && state.memScope === 'all';
  root.innerHTML = `
    <section class="card p-3 mb-4 flex flex-col sm:flex-row gap-2 sm:items-center">
      <div class="relative flex-1"><span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${ic('search')}</span>
        <input id="mb-kw" type="search" class="input pl-9" placeholder="名前・呼び名・メールで検索" aria-label="メンバー検索"></div>
      ${isAdmin() ? `<div class="seg"><button data-act="mem-scope" data-scope="mine" class="seg-btn ${!scopeAll ? 'is-active' : ''}">自分の名簿</button><button data-act="mem-scope" data-scope="all" class="seg-btn ${scopeAll ? 'is-active' : ''}">全員の名簿</button></div>` : ''}
      <button data-act="mem-add" class="btn-primary">${ic('user-plus')}メンバーを追加</button>
    </section>
    <div id="mb-coof"></div>
    <h2 class="font-black text-slate-900 mb-2 flex items-center gap-2">${ic('contact', 'w-5 h-5 text-indigo-600')}${scopeAll ? '全員のメンバー名簿' : 'あなたのメンバー名簿'}</h2>
    <div id="mb-list">${skeletonCards(1)}</div>`;
  icons();
  let members = [];
  const drawCoOf = (list) => {
    const box = $('#mb-coof');
    if (!box) return;
    if (!list || !list.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<section class="mb-5">
      <h2 class="font-black text-slate-900 mb-1 flex items-center gap-2">${ic('handshake', 'w-5 h-5 text-emerald-600')}あなたが共同主催者になっている主催者</h2>
      <p class="text-xs text-slate-500 mb-2">これらの主催者のイベントは、主催者画面で確認できます。</p>
      <div class="grid sm:grid-cols-2 gap-2">${list.map((o) => `
        <div class="card p-3 flex items-center gap-3 border-emerald-200">
          <span class="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 font-black inline-flex items-center justify-center shrink-0">${esc((o.name || '?').slice(0, 1))}</span>
          <div class="min-w-0 flex-1">
            <p class="font-bold text-slate-900 truncate">${esc(o.name)} <span class="pill bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 align-middle">主催者</span>${o.status === 'suspended' ? ' <span class="pill bg-rose-50 text-rose-600">利用停止中</span>' : ''}</p>
            <p class="text-xs text-slate-500 break-all">${o.email ? `<a href="mailto:${esc(o.email)}" class="hover:text-indigo-600">${esc(o.email)}</a>` : ''}${o.phone ? `　<a href="tel:${esc(o.phone)}" class="hover:text-indigo-600">${esc(o.phone)}</a>` : ''}</p>
            ${o.since ? `<p class="text-[11px] text-slate-400">${esc(slashDate(o.since))} から共同主催者</p>` : ''}
          </div>
          <a href="#/organizer" class="btn-secondary btn-sm shrink-0">${ic('layout-dashboard', 'w-3.5 h-3.5')}イベントを見る</a>
        </div>`).join('')}</div>
    </section>`;
    icons();
  };
  const draw = () => {
    const kw = $('#mb-kw').value.trim().toLowerCase();
    const list = members.filter((m) => !kw || [m.name, m.label_name, m.email, m.organizer_name].join(' ').toLowerCase().includes(kw));
    $('#mb-list').innerHTML = list.length ? `<div class="card divide-y divide-slate-100">${list.map((m) => `
      <div class="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-2 ${m.status !== 'active' ? 'opacity-60' : ''}">
        <div class="min-w-0 flex-1">
          <p class="font-bold text-slate-900">${esc(m.label_name || m.name)}${m.label_name && m.label_name !== m.name ? ` <span class="text-xs font-normal text-slate-500">（${esc(m.name)}）</span>` : ''}
            ${m.is_co_organizer ? ' <span class="pill bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">共同主催者</span>' : ''}
            ${m.is_temp_password ? ' <span class="pill bg-amber-50 text-amber-700">未ログイン</span>' : ''}
            ${m.status === 'suspended' ? ' <span class="pill bg-rose-50 text-rose-600">利用停止中</span>' : ''}</p>
          <p class="text-xs text-slate-500 break-all">${esc(m.email)}${m.phone ? '　' + esc(m.phone) : ''}</p>
          ${m.note ? `<p class="text-xs text-slate-600 mt-0.5">${ic('sticky-note', 'w-3 h-3 inline')} ${esc(m.note)}</p>` : ''}
          ${scopeAll ? `<p class="text-[11px] text-indigo-600 mt-0.5">名簿の持ち主：${esc(m.organizer_name)}</p>` : ''}
        </div>
        <div class="flex gap-1.5 shrink-0">
          <button data-mb-edit="${esc(m.link_id)}" class="btn-secondary btn-sm">${ic('pencil', 'w-3.5 h-3.5')}修正</button>
          <button data-mb-del="${esc(m.link_id)}" class="btn-ghost btn-sm text-rose-600">${ic('user-minus', 'w-3.5 h-3.5')}名簿から外す</button>
        </div>
      </div>`).join('')}</div>`
      : emptyState('contact', members.length ? '該当するメンバーはいません' : 'メンバーはまだいません', members.length ? '検索条件を変えてください。' : '一緒に主催する人を追加して「共同主催者」にチェックすると、あなたのイベントを確認できるようになります。', members.length ? '' : '<button data-act="mem-add" class="btn-primary">メンバーを追加</button>');
    icons();
  };
  const load = async () => {
    try {
      const d = await api('listMembers', { scope: scopeAll ? 'all' : 'mine' });
      members = d.members || [];
      drawCoOf(d.co_organizer_of);
      draw();
    } catch (e) { $('#mb-list').innerHTML = emptyState('circle-alert', '読み込めませんでした', e.message); icons(); }
  };
  window._membersReload = load;
  $('#mb-kw').addEventListener('input', debounce(draw, 200));
  $('#mb-list').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-mb-edit]');
    const del = e.target.closest('[data-mb-del]');
    if (ed) openMemberEdit(members.find((m) => m.link_id === ed.dataset.mbEdit));
    if (del) {
      const m = members.find((x) => x.link_id === del.dataset.mbDel);
      if (!await confirmDialog({ title: 'メンバー名簿から外す', message: `${m.label_name || m.name} さんを名簿から外します。\n会員アカウントは削除されません。今後のイベントの共同主催者に入っている場合は、そこからも外れます。`, okLabel: '外す', danger: true })) return;
      const d = await run(() => api('removeMember', { link_id: m.link_id }));
      if (!d) return;
      toast(`名簿から外しました${d.detached_events ? `（共同主催から外したイベント：${d.detached_events}件）` : ''}`, 'success');
      load();
    }
  });
  await load();
}

function openMemberAdd() {
  const w = openModal({
    title: 'メンバーを追加',
    size: 'max-w-md',
    body: `<form id="mba-form" class="space-y-3">
      <div><label class="label" for="mba-email">メールアドレス</label><input id="mba-email" name="email" type="email" class="input" required></div>
      <p class="text-xs text-slate-500 -mt-1">登録済みの会員ならそのまま名簿に追加します。未登録の場合は、下のお名前で会員アカウントを発行し、本人に仮パスワードをメールで送ります。</p>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="label" for="mba-name">お名前（未登録の場合）</label><input id="mba-name" name="name" class="input" maxlength="50"></div>
        <div><label class="label" for="mba-phone">電話番号（任意）</label><input id="mba-phone" name="phone" type="tel" class="input"></div>
      </div>
      <div><label class="label" for="mba-label">呼び名（任意・名簿での表示名）</label><input id="mba-label" name="label_name" class="input" maxlength="50" placeholder="例：田中さん（会計）"></div>
      <div><label class="label" for="mba-note">メモ（任意）</label><textarea id="mba-note" name="note" rows="2" class="input" maxlength="300" placeholder="例：日曜の練習会の副リーダー"></textarea></div>
      <label class="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 cursor-pointer">
        <input type="checkbox" name="is_co_organizer" value="true" class="mt-0.5 rounded border-slate-300 text-emerald-600" >
        <span class="text-sm"><span class="font-bold text-slate-800">共同主催者にする</span>
          <span class="block text-xs text-slate-500">あなたが主催するイベントを、この人も主催者画面で確認できるようになります（参加者名簿の確認・CSV・印刷）。イベントごとに選ぶと、そのイベントの編集・承認・精算もできます。</span></span>
      </label>
      <button type="submit" class="btn-primary w-full py-2.5">${ic('user-plus')}追加する</button>
    </form>`,
  });
  const f = w.querySelector('#mba-form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    setBusy(btn, true);
    const fd = Object.fromEntries(new FormData(f));
    fd.is_co_organizer = !!f.is_co_organizer.checked;
    const d = await run(() => api('addMember', fd));
    setBusy(btn, false);
    if (!d) return;
    closeModal(w);
    if (d.temp_password) showTempPassword(d.member.email, d.temp_password);
    else toast(d.message + (d.created_account ? '（仮パスワードをメールで送りました）' : ''), 'success');
    if (window._membersReload) window._membersReload();
  });
}

function openMemberEdit(m) {
  if (!m) return;
  const w = openModal({
    title: 'メンバー情報の修正',
    size: 'max-w-md',
    body: `<form id="mbe-form" class="space-y-3">
      <div class="rounded-xl bg-slate-50 p-3 text-sm"><p class="font-bold">${esc(m.name)}</p><p class="text-xs text-slate-500 break-all">${esc(m.email)}${m.phone ? '　' + esc(m.phone) : ''}</p></div>
      <div><label class="label" for="mbe-label">呼び名</label><input id="mbe-label" name="label_name" class="input" maxlength="50" value="${esc(m.label_name)}"></div>
      <div><label class="label" for="mbe-note">メモ</label><textarea id="mbe-note" name="note" rows="3" class="input" maxlength="300">${esc(m.note)}</textarea></div>
      <label class="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 cursor-pointer">
        <input type="checkbox" name="is_co_organizer" value="true" class="mt-0.5 rounded border-slate-300 text-emerald-600" ${m.is_co_organizer ? 'checked' : ''}>
        <span class="text-sm"><span class="font-bold text-slate-800">共同主催者にする</span>
          <span class="block text-xs text-slate-500">あなたが主催するイベントを、この人も主催者画面で確認できるようになります（参加者名簿の確認・CSV・印刷）。イベントごとに選ぶと、そのイベントの編集・承認・精算もできます。</span></span>
      </label>
      <p class="text-[11px] text-slate-400">お名前・メール・電話番号は本人のアカウント情報のため、ここでは変更できません。</p>
      <button type="submit" class="btn-primary w-full py-2.5">${ic('check')}保存する</button>
    </form>`,
  });
  const f = w.querySelector('#mbe-form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    setBusy(btn, true);
    const fd = Object.fromEntries(new FormData(f));
    fd.is_co_organizer = !!f.is_co_organizer.checked;
    const d = await run(() => api('updateMember', Object.assign({ link_id: m.link_id }, fd)));
    setBusy(btn, false);
    if (!d) return;
    closeModal(w);
    toast('保存しました' + (d.detached_events ? `（共同主催から外したイベント：${d.detached_events}件）` : ''), 'success');
    if (window._membersReload) window._membersReload();
  });
}

async function renderAdminUsersTab(root) {
  root.innerHTML = `
    <section class="card p-3 mb-4 flex flex-col sm:flex-row gap-2">
      <div class="relative flex-1"><span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">${ic('search')}</span>
        <input id="ad-kw" type="search" class="input pl-9" placeholder="名前・メールで検索" aria-label="会員検索"></div>
      <select id="ad-role" class="input sm:w-44" aria-label="権限で絞り込み"><option value="">すべての権限</option><option value="admin">システム管理者</option><option value="user">会員</option></select>
      <button data-act="admin-new-user" class="btn-primary">${ic('user-plus')}アカウント発行</button>
    </section>
    <div id="ad-body">${skeletonCards(1)}</div>`;
  icons();
  let users = [];
  const draw = () => {
    const kw = $('#ad-kw').value.trim().toLowerCase();
    const rl = $('#ad-role').value;
    const list = users.filter((u) => (!rl || (rl === 'user' ? u.role !== 'admin' : u.role === rl)) && (!kw || (u.name + ' ' + u.email).toLowerCase().includes(kw)));
    $('#ad-body').innerHTML = list.length ? `<div class="card overflow-x-auto"><table class="w-full min-w-[720px] text-sm">
      <thead><tr class="text-left text-[11px] text-slate-500 border-b border-slate-100"><th class="p-3">会員</th><th class="p-3">権限</th><th class="p-3">状態</th><th class="p-3">最終ログイン</th><th class="p-3"></th></tr></thead>
      <tbody>${list.map((u) => `<tr class="border-t border-slate-100 ${u.status === 'suspended' ? 'bg-slate-50 opacity-70' : ''}">
        <td class="p-3"><p class="font-bold">${esc(u.name)}${u.is_temp_password ? ' <span class="pill bg-amber-50 text-amber-700">仮PW</span>' : ''}</p><p class="text-xs text-slate-500">${esc(u.email)}</p></td>
        <td class="p-3"><select data-ad-role="${esc(u.user_id)}" class="input py-1 w-36" ${u.user_id === state.user.user_id ? 'disabled' : ''}>
          <option value="user" ${u.role !== 'admin' ? 'selected' : ''}>会員</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>システム管理者</option></select></td>
        <td class="p-3"><span class="pill ${u.status === 'suspended' ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'}">${u.status === 'suspended' ? '利用停止' : '有効'}</span></td>
        <td class="p-3 text-xs text-slate-500">${esc(u.last_login_at || '未ログイン')}</td>
        <td class="p-3 text-right whitespace-nowrap">${u.user_id === state.user.user_id ? '<span class="text-xs text-slate-400">自分</span>' : `
          <button data-ad-reset="${esc(u.user_id)}" class="btn-secondary btn-sm">${ic('key-round', 'w-3.5 h-3.5')}仮PW再発行</button>
          <button data-ad-status="${esc(u.user_id)}" data-next="${u.status === 'suspended' ? 'active' : 'suspended'}" class="btn-ghost btn-sm ${u.status === 'suspended' ? 'text-emerald-600' : 'text-rose-600'}">${u.status === 'suspended' ? '再開' : '停止'}</button>`}</td>
      </tr>`).join('')}</tbody></table></div>` : emptyState('users', '該当する会員はいません', '検索条件を変えてください。');
    icons();
  };
  const load = async () => {
    try { users = (await api('adminListUsers', {})).users; draw(); } catch (e) { $('#ad-body').innerHTML = emptyState('circle-alert', '読み込めませんでした', e.message); icons(); }
  };
  $('#ad-kw').addEventListener('input', debounce(draw, 200));
  $('#ad-role').addEventListener('change', draw);
  $('#ad-body').addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-ad-role]');
    if (!sel) return;
    const d = await run(() => api('adminUpdateUser', { user_id: sel.dataset.adRole, role: sel.value }));
    if (d) { toast('権限を変更しました', 'success'); await load(); } else draw();
  });
  $('#ad-body').addEventListener('click', async (e) => {
    const rs = e.target.closest('[data-ad-reset]');
    const st = e.target.closest('[data-ad-status]');
    if (rs) {
      const u = users.find((x) => x.user_id === rs.dataset.adReset);
      if (!await confirmDialog({ title: '仮パスワード再発行', message: `${u.name}（${u.email}）に新しい仮パスワードをメールで送ります。現在のパスワードは使えなくなります。`, okLabel: '再発行する' })) return;
      const d = await run(() => api('adminResetPassword', { user_id: u.user_id }));
      if (!d) return;
      if (d.temp_password) showTempPassword(u.email, d.temp_password); else toast(d.message, 'success');
      await load();
    }
    if (st) {
      const next = st.dataset.next;
      const u = users.find((x) => x.user_id === st.dataset.adStatus);
      if (!await confirmDialog({ title: next === 'suspended' ? '利用停止' : '利用再開', message: `${u.name} さんのアカウントを${next === 'suspended' ? '停止します。ログイン中でもすぐに利用できなくなります。' : '再開します。'}`, okLabel: next === 'suspended' ? '停止する' : '再開する', danger: next === 'suspended' })) return;
      const d = await run(() => api('adminUpdateUser', { user_id: u.user_id, status: next }));
      if (d) { toast('更新しました', 'success'); await load(); }
    }
  });
  window._adminReload = load;
  await load();
}

function openAdminCreateUser() {
  const w = openModal({
    title: 'アカウント発行',
    size: 'max-w-md',
    body: `<form id="adn-form" class="space-y-3">
      <div><label class="label" for="adn-name">お名前</label><input id="adn-name" name="name" class="input" required maxlength="50"></div>
      <div><label class="label" for="adn-email">メールアドレス</label><input id="adn-email" name="email" type="email" class="input" required></div>
      <div><label class="label" for="adn-phone">電話番号（任意）</label><input id="adn-phone" name="phone" type="tel" class="input"></div>
      <div><label class="label" for="adn-role">権限</label><select id="adn-role" name="role" class="input"><option value="user">会員（主催・参加とも可）</option><option value="admin">システム管理者</option></select></div>
      <p class="text-xs text-slate-500">発行すると、仮パスワードが本人のメールアドレスに届きます。</p>
      <button type="submit" class="btn-primary w-full py-2.5">${ic('user-plus')}発行する</button>
    </form>`,
  });
  const f = w.querySelector('#adn-form');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button[type=submit]');
    setBusy(btn, true);
    const d = await run(() => api('adminCreateUser', Object.fromEntries(new FormData(f))));
    setBusy(btn, false);
    if (!d) return;
    closeModal(w);
    if (d.temp_password) showTempPassword(d.user.email, d.temp_password);
    else toast('アカウントを発行し、仮パスワードをメールで送りました', 'success');
    if (window._adminReload) window._adminReload();
  });
}

function showTempPassword(email, pw) {
  openModal({
    title: 'メール送信に失敗しました',
    size: 'max-w-md',
    body: `<p class="text-sm text-slate-600 mb-3">${esc(email)} への送信ができませんでした。下記の仮パスワードを本人へ直接お伝えください。この画面を閉じると再表示できません。</p>
      <p class="text-center text-2xl font-black tracking-widest bg-slate-100 rounded-xl py-4 select-all">${esc(pw)}</p>`,
  });
}

// =====================================================================
// AIコンシェルジュ
// =====================================================================
const CHAT_SUGGESTIONS = ['今週末、2人で参加できるイベントは？', '初心者向けのワークショップは？', '無料で参加できるものを教えて', '平日の夜に開催されるイベントは？'];

function toggleChat(open) {
  const p = $('#chat-panel');
  const fab = $('#chat-fab');
  if (open && !state.user) { toast('AIコンシェルジュを使うにはログインしてください'); openAuthModal('login'); return; }
  p.classList.toggle('hidden', !open);
  fab.classList.toggle('hidden', !!open);
  if (open) { renderChat(); setTimeout(() => { const i = $('#chat-input'); if (i) i.focus(); }, 50); }
}

function renderChat() {
  const p = $('#chat-panel');
  const msgs = state.chat.map((m) => {
    if (m.role === 'user') return `<div class="flex justify-end"><p class="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 text-white text-sm px-3.5 py-2 whitespace-pre-wrap">${esc(m.text)}</p></div>`;
    return `<div class="flex gap-2"><span class="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 inline-flex items-center justify-center shrink-0">${ic('bot', 'w-4 h-4')}</span>
      <div class="max-w-[85%] space-y-2"><p class="rounded-2xl rounded-tl-md bg-slate-100 text-slate-800 text-sm px-3.5 py-2 whitespace-pre-wrap leading-relaxed">${esc(m.text)}</p>
      ${(m.events || []).map((ev) => `<button data-act="detail" data-id="${esc(ev.event_id)}" class="w-full text-left flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-2 hover:border-indigo-300">
        ${markBadge(ev.availability)}<span class="min-w-0"><span class="block text-xs text-slate-500">${esc(dateLabel(ev))}</span><span class="block text-sm font-bold text-slate-900 truncate">${esc(ev.title)}</span></span></button>`).join('')}
      </div></div>`;
  }).join('');
  p.innerHTML = `
    <div class="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
      <span class="w-8 h-8 rounded-full bg-indigo-600 text-white inline-flex items-center justify-center">${ic('bot', 'w-4 h-4')}</span>
      <div class="flex-1"><p class="font-bold text-sm text-slate-900">AIイベントコンシェルジュ</p><p class="text-[11px] text-slate-500">空き状況やおすすめを、話しかけて探せます</p></div>
      ${state.chat.length ? `<button data-act="chat-clear" class="btn-ghost btn-sm" aria-label="会話をリセット">${ic('rotate-ccw', 'w-3.5 h-3.5')}</button>` : ''}
      <button data-act="chat-close" class="btn-icon border-0" aria-label="閉じる">${ic('x')}</button>
    </div>
    <div id="chat-log" class="flex-1 overflow-y-auto p-4 space-y-3" aria-live="polite">
      ${state.chat.length ? msgs : `<div class="text-center text-sm text-slate-500 pt-6">
        <p class="mb-3">例えば、こんなふうに聞いてみてください。</p>
        <div class="flex flex-col gap-2">${CHAT_SUGGESTIONS.map((s) => `<button data-act="chat-suggest" data-text="${esc(s)}" class="rounded-xl border border-slate-200 px-3 py-2 text-left text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/40">${esc(s)}</button>`).join('')}</div></div>`}
      ${state.chatBusy ? `<div class="flex gap-2"><span class="w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 inline-flex items-center justify-center">${ic('bot', 'w-4 h-4')}</span><div class="rounded-2xl bg-slate-100 px-4 py-3 typing"><span></span><span></span><span></span></div></div>` : ''}
    </div>
    <form id="chat-form" class="p-3 border-t border-slate-100 flex gap-2">
      <input id="chat-input" class="input" maxlength="500" placeholder="例：来週の土曜に空いている体験会は？" autocomplete="off" ${state.chatBusy ? 'disabled' : ''} aria-label="メッセージ">
      <button class="btn-primary px-3" ${state.chatBusy ? 'disabled' : ''} aria-label="送信">${ic('send')}</button>
    </form>`;
  icons();
  const log = $('#chat-log');
  log.scrollTop = log.scrollHeight;
  $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('#chat-input').value); });
}

async function sendChat(text) {
  text = String(text || '').trim();
  if (!text || state.chatBusy) return;
  const history = state.chat.slice(-10).map((m) => ({ role: m.role, text: m.text }));
  state.chat.push({ role: 'user', text });
  state.chatBusy = true;
  renderChat();
  try {
    const d = await api('concierge', { message: text, history });
    state.chat.push({ role: 'model', text: d.reply, events: d.events || [] });
    (d.events || []).forEach(upsertEvent);
  } catch (e) {
    state.chat.push({ role: 'model', text: '回答を作成できませんでした：' + e.message });
  } finally {
    state.chatBusy = false;
    if (!$('#chat-panel').classList.contains('hidden')) renderChat();
  }
}

// =====================================================================
// クリック操作の振り分け
// =====================================================================
const ACTIONS = {
  login: () => openAuthModal('login'),
  register: () => openAuthModal('register'),
  logout: async () => { if (await confirmDialog({ title: 'ログアウト', message: 'ログアウトしますか？', okLabel: 'ログアウト' })) doLogout(); },
  'change-pw': () => openPasswordModal(false),
  eye: (el) => {
    const input = document.getElementById(el.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
    el.innerHTML = ic(show ? 'eye-off' : 'eye');
    icons();
  },
  display: (el) => { state.display = el.dataset.mode; store.set('rh_display', state.display); renderEventsView(); },
  'cal-prev': () => { state.calCursor = state.display === 'month' ? addMonths(new Date(state.calCursor.getFullYear(), state.calCursor.getMonth(), 1), -1) : addDays(state.calCursor, -7); renderEventsBody(); },
  'cal-next': () => { state.calCursor = state.display === 'month' ? addMonths(new Date(state.calCursor.getFullYear(), state.calCursor.getMonth(), 1), 1) : addDays(state.calCursor, 7); renderEventsBody(); },
  day: (el) => openDayList(el.dataset.date),
  detail: (el) => { closeChatOnMobile(); openEventDetail(el.dataset.id); },
  reserve: (el) => openReserveModal(el.dataset.id),
  flyer: (el) => openFlyer(el.dataset.id),
  'reload-events': () => { state.eventsLoaded = false; renderEventsView(); },
  'cancel-resv': (el) => cancelReservation(el.dataset.id),
  'new-event': () => openEventForm(null),
  'edit-event': (el) => { const ev = findEvent(el.dataset.id); if (ev) openEventForm(ev); },
  participants: (el) => openParticipants(el.dataset.id),
  'ai-flyer': () => openAiFlyer(),
  recurring: () => openRecurringWizard(),
  'dash-pending': () => { state.dashFilter.status = 'pending'; const s = $('#org-status'); if (s) s.value = 'pending'; renderOrganizerBody(); },
  'dash-scope': (el) => { state.dashScope = el.dataset.scope; renderOrganizerView(); },
  'admin-new-user': () => openAdminCreateUser(),
  'mem-tab': (el) => { state.memTab = el.dataset.tab; renderMembersView(); },
  'mem-scope': (el) => { state.memScope = el.dataset.scope; renderMembersView(); },
  'mem-add': () => openMemberAdd(),
  'go-members': () => { $$('#modal-root > div').forEach((m) => closeModal(m)); go('members'); },
  'chat-open': () => toggleChat(true),
  'chat-close': () => toggleChat(false),
  'chat-clear': () => { state.chat = []; renderChat(); },
  'chat-suggest': (el) => sendChat(el.dataset.text),
};

function closeChatOnMobile() {
  if (window.matchMedia('(max-width: 639px)').matches && !$('#chat-panel').classList.contains('hidden')) toggleChat(false);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  if (el.closest('details')) el.closest('details').removeAttribute('open');
  // 詳細モーダル内の「予約する」は詳細を閉じてから開く
  if (el.dataset.act === 'reserve') {
    const m = el.closest('#modal-root > div');
    if (m) closeModal(m);
  }
  Promise.resolve(fn(el, e)).catch((err) => toast(err.message || 'エラーが発生しました', 'error'));
});

document.addEventListener('click', (e) => {
  $$('details[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
});

// =====================================================================
// 起動
// =====================================================================
async function init() {
  icons();
  if (!CFG.GAS_URL) toast('config.js の GAS_URL を設定してください', 'error');
  if (state.token) {
    try {
      const d = await api('me', {}, { noAuthHandle: true });
      setSession(null, d.user);
      if (d.must_change_password) openPasswordModal(true);
    } catch (e) {
      if (['AUTH_INVALID', 'AUTH_EXPIRED', 'ACCOUNT_SUSPENDED', 'AUTH_REQUIRED'].includes(e.code)) {
        clearSession();
        toast('ログインの有効期限が切れました。もう一度ログインしてください');
      }
    }
  }
  if (!location.hash && isAdmin()) location.replace('#/organizer');
  route();
}

init();
