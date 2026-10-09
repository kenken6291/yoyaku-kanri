/**
 * =====================================================================
 *  ReserveHub - 多機能予約管理システム  GASバックエンド (Code.gs)
 *  GitHub Pages(SPA) ⇔ GAS Web API ⇔ スプレッドシート / Drive / Gemini
 * =====================================================================
 *
 *  【スクリプトプロパティ】（プロジェクトの設定 → スクリプト プロパティ）
 *    GEMINI_API_KEY            : Gemini APIキー（必須：AI機能を使う場合）
 *    GEMINI_MODEL              : 使用モデル（setupDatabase で gemini-3.8-flash を自動設定）
 *    GEMINI_IMAGE_MODEL        : チラシ画像生成モデル（setupDatabase で gemini-2.5-flash-image を自動設定）
 *    GEMINI_FALLBACK_MODEL     : 任意。メインのモデルが混雑(503等)のとき自動で切り替える予備モデル
 *    SPREADSHEET_ID            : スタンドアロンGASの場合は必須（コンテナバインドなら省略可）
 *    DRIVE_FOLDER_ID           : チラシ保存フォルダID（省略時 setupDatabase で自動作成）
 *    ADMIN_EMAIL               : 初期管理者のメール（setupDatabase で admin を自動発行）
 *    APP_URL                   : フロントのURL（メール本文のリンクに使用）
 *    ※ GAS URL はフロント側の config.js（APP_CONFIG.GAS_URL）で指定
 *    ALLOW_PUBLIC_REGISTRATION : 'false' で一般の新規登録を停止（省略時 true）
 *    PASSWORD_PEPPER           : setupDatabase で自動生成（※後から変更すると全員ログイン不可）
 *
 *  【フロントからの呼び出し形式】（CORSプリフライト回避のため text/plain で送信）
 *    fetch(GAS_URL, { method:'POST',
 *      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
 *      body: JSON.stringify({ action:'login', token:'', payload:{...} }) })
 *    → { ok:true, data:{...} } または { ok:false, error:{ code, message } }
 *
 *  【初回セットアップ】
 *    1. スクリプトプロパティを設定
 *    2. setupAll() を実行（DB初期化＋トリガー登録＋初期管理者発行）
 *    3. ウェブアプリとしてデプロイ（実行ユーザー：自分 / アクセス：全員）
 * =====================================================================
 */

// ---------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------
const CONFIG = Object.freeze({
  APP_NAME: 'ReserveHub',
  MAX_ACTIVE_ITEMS: 10,            // 会員1人が登録者として持てるアクティブ予約項目数（定期グループは1項目として計上）
  MAX_CO_ORGANIZERS: 10,           // 1イベントの共同主催者の上限
  MAX_MEMBERS: 300,                // 1人のメンバー名簿の上限
  MAX_MONTHS_AHEAD: 2,             // 本日から何ヶ月先まで枠を作成可能か
  TOKEN_TTL_HOURS: 24 * 7,         // セッション有効期限
  LOGIN_MAX_FAIL: 5,               // ログイン失敗許容回数
  LOGIN_LOCK_MINUTES: 15,          // 失敗超過時のロック時間
  FORGOT_INTERVAL_SEC: 300,        // 仮PW再発行の最短間隔
  MAX_GUESTS_PER_RESERVATION: 20,  // 1予約あたりの最大人数
  FLYER_MAX_BYTES: 5 * 1024 * 1024,
  FLYER_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  PLENTY_RATIO: 0.5,               // 残席率がこれを超えると〇
  RECURRING_MAX_DATES: 62,
  CONCIERGE_MAX_EVENTS: 80,
  AI_RATE_LIMIT: 20,               // 10分あたりのAI呼び出し上限（ユーザー単位）
  HASH_ITERATIONS: 300,
  DEFAULT_GEMINI_MODEL: 'gemini-3.8-flash',
  DEFAULT_GEMINI_IMAGE_MODEL: 'gemini-2.5-flash-image',
  AI_IMAGE_RATE_LIMIT: 10,         // 10分あたりの画像生成上限（ユーザー単位）
  DEFAULT_FOLDER_NAME: 'ReserveHub_Flyers',
  DEFAULT_CATEGORIES: ['語学・国際交流', 'スポーツ・健康', 'IT・ビジネス', 'ダンス・音楽', '料理・食', '趣味・クラフト', 'アウトドア', '地域・ボランティア', 'その他'],
});

const SHEET = Object.freeze({ USERS: 'users', EVENTS: 'events', RESERVATIONS: 'reservations', MEMBERS: 'members' });

const SCHEMA = {
  users: ['user_id', 'email', 'password_hash', 'name', 'phone', 'role', 'is_temp_password', 'created_at',
    'token', 'token_expires_at', 'status', 'updated_at', 'last_login_at'],
  events: ['event_id', 'organizer_id', 'title', 'description', 'category', 'event_date', 'start_time', 'end_time',
    'location', 'fee', 'capacity', 'deadline_hours_before', 'is_approval_required', 'flyer_drive_id',
    'recurring_group_id', 'status', 'created_at', 'updated_at', 'co_organizer_ids'],
  reservations: ['reservation_id', 'event_id', 'user_id', 'guest_count', 'applicant_name', 'applicant_phone',
    'applicant_email', 'status', 'payment_status', 'applied_at', 'note', 'updated_at'],
  // 主催者ごとの関係会員（メンバー名簿）
  members: ['link_id', 'organizer_id', 'user_id', 'label_name', 'note', 'created_at', 'updated_at'],
};

// 自動変換（日付化・先頭0消失）を防ぐため書式を「書式なしテキスト」にする列
const TEXT_COLUMNS = {
  users: ['user_id', 'email', 'password_hash', 'name', 'phone', 'role', 'created_at', 'token', 'token_expires_at',
    'status', 'updated_at', 'last_login_at'],
  events: ['event_id', 'organizer_id', 'title', 'description', 'category', 'event_date', 'start_time', 'end_time',
    'location', 'flyer_drive_id', 'recurring_group_id', 'status', 'created_at', 'updated_at', 'co_organizer_ids'],
  reservations: ['reservation_id', 'event_id', 'user_id', 'applicant_name', 'applicant_phone', 'applicant_email',
    'status', 'payment_status', 'applied_at', 'note', 'updated_at'],
  members: ['link_id', 'organizer_id', 'user_id', 'label_name', 'note', 'created_at', 'updated_at'],
};

const ROLES = ['admin', 'organizer', 'user'];
const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];
const RESV_STATUS_LABEL = { pending: '承認待ち', confirmed: '確定', cancelled: '取消', rejected: '却下' };
const PAY_STATUS_LABEL = { unpaid: '未精算', paid: '精算済' };

class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------
// 会員は全員イベントの主催も参加もできる（organizer は旧データ互換）
const ORG = ['user', 'organizer', 'admin'];
const MEMBER = ORG;
const ADMIN = ['admin'];

const ROUTES = {
  // 共通・認証
  ping: { auth: 'none', fn: () => ({ app: CONFIG.APP_NAME, time: nowStr_() }) },
  register: { auth: 'none', fn: (u, p) => apiRegister_(p) },
  login: { auth: 'none', fn: (u, p) => apiLogin_(p) },
  forgotPassword: { auth: 'none', fn: (u, p) => apiForgotPassword_(p) },
  me: { auth: 'required', allowTemp: true, fn: (u) => ({ user: publicUser_(u), must_change_password: toBool_(u.is_temp_password) }) },
  logout: { auth: 'required', allowTemp: true, fn: apiLogout_ },
  changePassword: { auth: 'required', allowTemp: true, fn: apiChangePassword_ },
  updateProfile: { auth: 'required', fn: apiUpdateProfile_ },

  // イベント閲覧（ログイン任意）
  listEvents: { auth: 'optional', fn: apiListEvents_ },
  getEvent: { auth: 'optional', fn: apiGetEvent_ },
  listCategories: { auth: 'none', fn: apiListCategories_ },

  // 参加者
  createReservation: { auth: 'required', fn: apiCreateReservation_ },
  myReservations: { auth: 'required', fn: apiMyReservations_ },
  cancelReservation: { auth: 'required', fn: apiCancelReservation_ },
  concierge: { auth: 'required', fn: apiConcierge_ },

  // 主催者
  organizerDashboard: { roles: ORG, fn: apiOrganizerDashboard_ },
  createEvent: { roles: ORG, fn: apiCreateEvent_ },
  updateEvent: { roles: ORG, fn: apiUpdateEvent_ },
  cancelEvent: { roles: ORG, fn: apiCancelEvent_ },
  deleteEvent: { roles: ORG, fn: apiDeleteEvent_ },
  previewRecurring: { roles: ORG, fn: apiPreviewRecurring_ },
  createRecurring: { roles: ORG, fn: apiCreateRecurring_ },
  listParticipants: { roles: ORG, fn: apiListParticipants_ },
  exportParticipantsCsv: { roles: ORG, fn: apiExportParticipantsCsv_ },
  setReservationStatus: { roles: ORG, fn: apiSetReservationStatus_ },
  setPaymentStatus: { roles: ORG, fn: apiSetPaymentStatus_ },
  generateFlyerText: { roles: ORG, fn: apiGenerateFlyerText_ },
  generateFlyerImage: { roles: ORG, fn: apiGenerateFlyerImage_ },
  uploadFlyer: { roles: ORG, fn: apiUploadFlyer_ },

  // メンバー名簿（主催者にかかわる会員）
  listMembers: { roles: MEMBER, fn: apiListMembers_ },
  addMember: { roles: MEMBER, fn: apiAddMember_ },
  updateMember: { roles: MEMBER, fn: apiUpdateMember_ },
  removeMember: { roles: MEMBER, fn: apiRemoveMember_ },
  listCoOrganizerCandidates: { roles: MEMBER, fn: apiListCoOrganizerCandidates_ },

  // 管理者
  adminListUsers: { roles: ADMIN, fn: apiAdminListUsers_ },
  adminCreateUser: { roles: ADMIN, fn: apiAdminCreateUser_ },
  adminUpdateUser: { roles: ADMIN, fn: apiAdminUpdateUser_ },
  adminResetPassword: { roles: ADMIN, fn: apiAdminResetPassword_ },
};

const GET_ACTIONS = ['ping', 'listEvents', 'getEvent', 'listCategories'];

function doPost(e) {
  return handle_(() => {
    let body = {};
    const raw = e && e.postData && e.postData.contents;
    if (raw) {
      try { body = JSON.parse(raw); } catch (_) { throw new AppError('BAD_REQUEST', 'リクエスト形式が不正です（JSONではありません）'); }
    }
    return dispatch_(String(body.action || ''), body.token || '', body.payload || {});
  });
}

function doGet(e) {
  return handle_(() => {
    const p = (e && e.parameter) || {};
    const action = p.action || 'ping';
    if (GET_ACTIONS.indexOf(action) === -1) throw new AppError('BAD_REQUEST', 'この操作はGETでは利用できません');
    let payload = p;
    if (p.payload) {
      try { payload = JSON.parse(p.payload); } catch (_) { payload = {}; }
    }
    return dispatch_(action, p.token || '', payload);
  });
}

function handle_(fn) {
  let out;
  try {
    DB.reset();
    out = { ok: true, data: fn() };
  } catch (err) {
    const isApp = err instanceof AppError;
    if (!isApp) console.error(err && err.stack ? err.stack : err);
    out = {
      ok: false,
      error: {
        code: isApp ? err.code : 'SERVER_ERROR',
        message: isApp ? err.message : 'サーバーエラーが発生しました: ' + (err && err.message ? err.message : String(err)),
      },
    };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function dispatch_(action, token, payload) {
  const route = ROUTES[action];
  if (!route) throw new AppError('NOT_FOUND', '不明なactionです: ' + action);
  let user = null;
  if (route.auth === 'required' || route.roles) {
    user = authenticate_(token, !!route.allowTemp);
  } else if (route.auth === 'optional' && token) {
    try { user = authenticate_(token, true); } catch (_) { user = null; }
  }
  if (route.roles && route.roles.indexOf(user.role) === -1) {
    throw new AppError('FORBIDDEN', 'この操作を行う権限がありません');
  }
  return route.fn(user, payload || {});
}

// ---------------------------------------------------------------------
// セットアップ
// ---------------------------------------------------------------------
/** DB初期化＋トリガー登録をまとめて実行 */
function setupAll() {
  setupDatabase();
  setupTriggers();
}

/** スプレッドシートの初期スキーマ自動生成（何度実行しても安全・不足列は追加） */
function setupDatabase() {
  const ss = getSS_();
  const props = PropertiesService.getScriptProperties();

  Object.keys(SCHEMA).forEach((name) => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SCHEMA[name];

    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      const existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
      headers.forEach((h) => {
        if (existing.indexOf(h) === -1) {
          sh.getRange(1, sh.getLastColumn() + 1).setValue(h);
          existing.push(h);
        }
      });
    }

    const cur = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, cur.length).setFontWeight('bold').setBackground('#4338ca').setFontColor('#ffffff');
    const maxRows = sh.getMaxRows();
    if (maxRows > 1) {
      (TEXT_COLUMNS[name] || []).forEach((h) => {
        const c = cur.indexOf(h) + 1;
        if (c > 0) sh.getRange(2, c, maxRows - 1, 1).setNumberFormat('@');
      });
    }
  });

  // 既定の空シートを削除
  ['シート1', 'Sheet1'].forEach((n) => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  if (!props.getProperty('PASSWORD_PEPPER')) {
    props.setProperty('PASSWORD_PEPPER', randomHex_(32));
    Logger.log('PASSWORD_PEPPER を生成しました（変更しないでください）');
  }

  if (!props.getProperty('GEMINI_IMAGE_MODEL')) {
    props.setProperty('GEMINI_IMAGE_MODEL', CONFIG.DEFAULT_GEMINI_IMAGE_MODEL);
    Logger.log('GEMINI_IMAGE_MODEL を ' + CONFIG.DEFAULT_GEMINI_IMAGE_MODEL + ' に設定しました');
  }
  if (!props.getProperty('GEMINI_MODEL')) {
    props.setProperty('GEMINI_MODEL', CONFIG.DEFAULT_GEMINI_MODEL);
    Logger.log('GEMINI_MODEL を ' + CONFIG.DEFAULT_GEMINI_MODEL + ' に設定しました');
  }

  const folder = getFlyerFolder_();
  Logger.log('チラシ保存フォルダ: ' + folder.getName() + ' (' + folder.getId() + ')');

  // 初期管理者の発行
  DB.reset();
  const hasAdmin = DB.all(SHEET.USERS).some((u) => u.role === 'admin');
  const adminEmail = str_(prop_('ADMIN_EMAIL', ''), 254).toLowerCase();
  if (!hasAdmin && adminEmail) {
    const tempPw = genTempPassword_();
    DB.insert(SHEET.USERS, newUserRow_(adminEmail, 'システム管理者', '', 'admin', tempPw));
    const sent = sendTempPasswordMail_(adminEmail, 'システム管理者', tempPw, 'admin_issue');
    Logger.log('初期管理者を発行しました: ' + adminEmail + (sent ? '（メール送信済）' : ' 仮パスワード: ' + tempPw));
  } else if (!hasAdmin) {
    Logger.log('※ ADMIN_EMAIL が未設定のため管理者は未発行です。設定後に再実行してください。');
  }
  Logger.log('setupDatabase 完了');
}

/** 締切済みイベントの自動クローズ（1時間おき） */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === 'autoCloseEvents') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autoCloseEvents').timeBased().everyHours(1).create();
  Logger.log('autoCloseEvents トリガーを登録しました');
}

function autoCloseEvents() {
  withLock_(() => {
    const now = Date.now();
    let n = 0;
    DB.all(SHEET.EVENTS).forEach((ev) => {
      if (ev.status !== 'active') return;
      const dl = eventDeadline_(ev);
      if (dl && dl.getTime() <= now) {
        DB.update(SHEET.EVENTS, ev, { status: 'closed', updated_at: nowStr_() });
        n++;
      }
    });
    Logger.log('自動締切: ' + n + '件');
  });
}

// ---------------------------------------------------------------------
// 【手動実行用】メールのトラブル対応
// ---------------------------------------------------------------------
/** メール送信の診断：残り送信数・送信元を表示し、ADMIN_EMAIL にテストメールを送る */
function checkMailSetup() {
  const me = Session.getEffectiveUser().getEmail();
  const to = str_(prop_('ADMIN_EMAIL', ''), 254).toLowerCase() || me;
  Logger.log('送信元（GASの実行ユーザー）: ' + me);
  Logger.log('本日の残り送信可能数: ' + MailApp.getRemainingDailyQuota());
  const ok = sendMail_(to, '【' + CONFIG.APP_NAME + '】テストメール',
    'これはメール送信のテストです。このメールが届いていれば設定は正常です。' + footer_());
  Logger.log(ok
    ? to + ' にテストメールを送信しました。届かない場合は迷惑メールフォルダを確認してください'
    : '送信に失敗しました。上のエラー内容を確認してください');
}

/** ADMIN_EMAIL の管理者に仮パスワードを発行（未登録なら新規作成）し、実行ログにも表示する */
function issueAdminTempPassword() {
  const email = str_(prop_('ADMIN_EMAIL', ''), 254).toLowerCase();
  if (!isEmail_(email)) throw new Error('スクリプトプロパティ ADMIN_EMAIL を正しく設定してください');
  const tempPw = genTempPassword_();
  withLock_(() => {
    const u = DB.find(SHEET.USERS, 'email', email);
    if (u) {
      DB.update(SHEET.USERS, u, {
        password_hash: makePasswordHash_(tempPw), is_temp_password: true, role: 'admin', status: 'active',
        token: '', token_expires_at: '', updated_at: nowStr_(),
      });
    } else {
      DB.insert(SHEET.USERS, newUserRow_(email, 'システム管理者', '', 'admin', tempPw));
    }
  });
  const sent = sendTempPasswordMail_(email, 'システム管理者', tempPw, 'admin_issue');
  Logger.log('管理者: ' + email);
  Logger.log('仮パスワード: ' + tempPw + (sent ? '（メールも送信しました）' : '（メール送信は失敗）'));
}

/** 指定メールの会員に仮パスワードを再発行し、実行ログに表示する（メールが届かない会員の救済用） */
function issueTempPasswordFor(email) {
  email = str_(email || '', 254).toLowerCase();
  if (!isEmail_(email)) throw new Error('issueTempPasswordFor("会員のメールアドレス") の形で、引数を書き換えてから実行してください');
  const tempPw = genTempPassword_();
  withLock_(() => {
    const u = DB.find(SHEET.USERS, 'email', email);
    if (!u) throw new Error('この会員は登録されていません: ' + email);
    DB.update(SHEET.USERS, u, {
      password_hash: makePasswordHash_(tempPw), is_temp_password: true,
      token: '', token_expires_at: '', updated_at: nowStr_(),
    });
  });
  Logger.log(email + ' の仮パスワード: ' + tempPw);
}

// ---------------------------------------------------------------------
// データアクセス層
// ---------------------------------------------------------------------
const DB = {
  _ss: null,
  _cache: {},

  ss() {
    if (!this._ss) this._ss = getSS_();
    return this._ss;
  },
  sheet(name) {
    const sh = this.ss().getSheetByName(name);
    if (!sh) throw new AppError('CONFIG', 'シート「' + name + '」がありません。setupDatabase() を実行してください');
    return sh;
  },
  table(name) {
    if (this._cache[name]) return this._cache[name];
    const sh = this.sheet(name);
    const values = sh.getDataRange().getValues();
    const headers = (values.shift() || []).map(String);
    const rows = [];
    values.forEach((r, i) => {
      if (r[0] === '' || r[0] === null) return;
      const o = { _row: i + 2 };
      headers.forEach((h, j) => { if (h) o[h] = normCell_(h, r[j]); });
      rows.push(o);
    });
    const t = { headers: headers, rows: rows, sheet: sh };
    this._cache[name] = t;
    return t;
  },
  all(name) {
    return this.table(name).rows;
  },
  find(name, key, val) {
    const v = String(val);
    return this.all(name).find((r) => String(r[key]) === v) || null;
  },
  insert(name, obj) {
    return this.insertMany(name, [obj])[0];
  },
  insertMany(name, objs) {
    if (!objs.length) return [];
    const t = this.table(name);
    const sh = t.sheet;
    const start = sh.getLastRow() + 1;
    const rows = objs.map((o) => t.headers.map((h) => (o[h] === undefined || o[h] === null ? '' : o[h])));
    (TEXT_COLUMNS[name] || []).forEach((h) => {
      const c = t.headers.indexOf(h);
      if (c >= 0) sh.getRange(start, c + 1, rows.length, 1).setNumberFormat('@');
    });
    sh.getRange(start, 1, rows.length, t.headers.length).setValues(rows);
    delete this._cache[name];
    return objs;
  },
  update(name, rowObj, patch) {
    const t = this.table(name);
    const merged = Object.assign({}, rowObj, patch);
    const vals = t.headers.map((h) => (merged[h] === undefined || merged[h] === null ? '' : merged[h]));
    t.sheet.getRange(rowObj._row, 1, 1, t.headers.length).setValues([vals]);
    const idx = t.rows.findIndex((r) => r._row === rowObj._row);
    if (idx >= 0) t.rows[idx] = merged;
    return merged;
  },
  /** 行を削除（行番号がずれるため、複数削除は呼び出し側で行番号の大きい順に） */
  deleteRow(name, rowObj) {
    this.sheet(name).deleteRow(rowObj._row);
    delete this._cache[name];
  },
  reset() {
    this._cache = {};
  },
};

function normCell_(h, v) {
  if (v instanceof Date) {
    if (h === 'event_date') return fmt_(v, 'yyyy-MM-dd');
    if (h === 'start_time' || h === 'end_time') return fmt_(v, 'HH:mm');
    return fmt_(v, 'yyyy-MM-dd HH:mm:ss');
  }
  return v;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new AppError('BUSY', '混み合っています。少し待ってから再度お試しください');
  try {
    DB.reset();
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------
// 汎用ユーティリティ
// ---------------------------------------------------------------------
function prop_(k, def) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  return v === null || v === '' ? def : v;
}

function getSS_() {
  const id = prop_('SPREADSHEET_ID', '');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new AppError('CONFIG', 'SPREADSHEET_ID が未設定です');
  return ss;
}

function tz_() { return Session.getScriptTimeZone() || 'Asia/Tokyo'; }
function fmt_(d, f) { return Utilities.formatDate(d, tz_(), f); }
function nowStr_() { return fmt_(new Date(), 'yyyy-MM-dd HH:mm:ss'); }
function todayYmd_() { return fmt_(new Date(), 'yyyy-MM-dd'); }

function parseYmd_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

function parseDateTime_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
}

function addDays_(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function addMonthsYmd_(ymd, n) {
  const d = parseYmd_(ymd);
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() !== day) d.setDate(0);
  return fmt_(d, 'yyyy-MM-dd');
}

function maxEventYmd_() { return addMonthsYmd_(todayYmd_(), CONFIG.MAX_MONTHS_AHEAD); }
function weekdayJa_(ymd) { const d = parseYmd_(ymd); return d ? WEEKDAYS_JA[d.getDay()] : ''; }
function isTime_(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || '')); }
function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }
function isPhone_(s) { return /^[0-9+\-() ]{8,20}$/.test(String(s || '')); }
function toBool_(v) { return v === true || v === 1 || String(v).toLowerCase() === 'true' || v === '1'; }
function toInt_(v, def) { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : def; }
function yen_(n) { return String(toInt_(n, 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function str_(v, max) {
  let s = v === null || v === undefined ? '' : String(v).trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function genId_(prefix) {
  return prefix + '_' + fmt_(new Date(), 'yyMMdd') + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
}

function eventStart_(ev) {
  const d = parseYmd_(ev.event_date);
  if (!d) return null;
  const t = String(ev.start_time || '00:00').split(':').map(Number);
  d.setHours(t[0] || 0, t[1] || 0, 0, 0);
  return d;
}

function eventDeadline_(ev) {
  const s = eventStart_(ev);
  return s ? new Date(s.getTime() - toInt_(ev.deadline_hours_before, 0) * 3600000) : null;
}

function rateLimit_(key, limit, seconds) {
  const cache = CacheService.getScriptCache();
  const n = toInt_(cache.get(key), 0);
  if (n >= limit) throw new AppError('RATE_LIMIT', '短時間に多くのリクエストがありました。しばらくしてからお試しください');
  cache.put(key, String(n + 1), seconds);
}

// ---------------------------------------------------------------------
// パスワード・トークン
// ---------------------------------------------------------------------
function bytesToHex_(bytes) {
  return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function sha256Hex_(s) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

function randomBytes_() {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + Date.now() + ':' + Math.random(),
    Utilities.Charset.UTF_8);
}

function randomHex_(len) {
  let s = '';
  while (s.length < len) s += bytesToHex_(randomBytes_());
  return s.slice(0, len);
}

function genTempPassword_(len) {
  len = len || 10;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const limit = chars.length * Math.floor(256 / chars.length);
  let s = '';
  while (s.length < len) {
    const bytes = randomBytes_();
    for (let i = 0; i < bytes.length && s.length < len; i++) {
      const v = bytes[i] & 0xff;
      if (v < limit) s += chars[v % chars.length];
    }
  }
  if (!/\d/.test(s) || !/[A-Za-z]/.test(s)) return genTempPassword_(len);
  return s;
}

function hashPassword_(pw, salt) {
  const pepper = prop_('PASSWORD_PEPPER', '');
  let h = sha256Hex_(salt + ':' + pw + ':' + pepper);
  for (let i = 1; i < CONFIG.HASH_ITERATIONS; i++) h = sha256Hex_(h + ':' + salt);
  return h;
}

function makePasswordHash_(pw) {
  const salt = randomHex_(16);
  return salt + '$' + hashPassword_(pw, salt);
}

function verifyPassword_(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 2) return false;
  const a = hashPassword_(String(pw || ''), parts[0]);
  const b = parts[1];
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function assertPasswordPolicy_(pw) {
  pw = String(pw || '');
  if (pw.length < 8 || pw.length > 64) throw new AppError('VALIDATION', 'パスワードは8〜64文字で入力してください');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new AppError('VALIDATION', 'パスワードは英字と数字を両方含めてください');
}

function issueToken_() {
  return {
    token: randomHex_(48),
    expires: fmt_(new Date(Date.now() + CONFIG.TOKEN_TTL_HOURS * 3600000), 'yyyy-MM-dd HH:mm:ss'),
  };
}

// ---------------------------------------------------------------------
// 認証・会員
// ---------------------------------------------------------------------
function authenticate_(token, allowTemp) {
  token = str_(token, 200);
  if (!token) throw new AppError('AUTH_REQUIRED', 'ログインが必要です');
  const u = DB.find(SHEET.USERS, 'token', token);
  if (!u) throw new AppError('AUTH_INVALID', 'セッションが無効です。再度ログインしてください');
  if (u.status === 'suspended') throw new AppError('ACCOUNT_SUSPENDED', 'このアカウントは利用停止中です');
  const exp = parseDateTime_(u.token_expires_at);
  if (!exp || exp.getTime() < Date.now()) throw new AppError('AUTH_EXPIRED', 'セッションの有効期限が切れました。再度ログインしてください');
  if (!allowTemp && toBool_(u.is_temp_password)) {
    throw new AppError('PASSWORD_CHANGE_REQUIRED', '仮パスワードでログイン中です。パスワードを変更してください');
  }
  return u;
}

function publicUser_(u) {
  return {
    user_id: u.user_id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    role: u.role,
    is_temp_password: toBool_(u.is_temp_password),
  };
}

function newUserRow_(email, name, phone, role, tempPw) {
  const now = nowStr_();
  return {
    user_id: genId_('U'),
    email: email,
    password_hash: makePasswordHash_(tempPw),
    name: name,
    phone: phone,
    role: role,
    is_temp_password: true,
    created_at: now,
    token: '',
    token_expires_at: '',
    status: 'active',
    updated_at: now,
    last_login_at: '',
  };
}

function apiRegister_(p) {
  if (String(prop_('ALLOW_PUBLIC_REGISTRATION', 'true')).toLowerCase() === 'false') {
    throw new AppError('FORBIDDEN', '現在、新規登録は受け付けていません');
  }
  const email = str_(p.email, 254).toLowerCase();
  const name = str_(p.name, 50);
  const phone = str_(p.phone, 20);
  if (!isEmail_(email)) throw new AppError('VALIDATION', 'メールアドレスの形式が正しくありません');
  if (!name) throw new AppError('VALIDATION', 'お名前を入力してください');
  if (phone && !isPhone_(phone)) throw new AppError('VALIDATION', '電話番号の形式が正しくありません');

  return withLock_(() => {
    if (DB.find(SHEET.USERS, 'email', email)) throw new AppError('DUPLICATE', 'このメールアドレスは既に登録されています');
    const tempPw = genTempPassword_();
    if (!sendTempPasswordMail_(email, name, tempPw, 'register')) {
      throw new AppError('MAIL_FAILED', 'メール送信に失敗しました。アドレスを確認して再度お試しください');
    }
    DB.insert(SHEET.USERS, newUserRow_(email, name, phone, 'user', tempPw));
    return { message: '仮パスワードを ' + email + ' に送信しました。ログイン後にパスワードを変更してください。' };
  });
}

function apiLogin_(p) {
  const email = str_(p.email, 254).toLowerCase();
  const password = String(p.password || '');
  if (!email || !password) throw new AppError('VALIDATION', 'メールアドレスとパスワードを入力してください');

  const cache = CacheService.getScriptCache();
  const failKey = 'lf:' + sha256Hex_(email).slice(0, 32);
  const fails = toInt_(cache.get(failKey), 0);
  if (fails >= CONFIG.LOGIN_MAX_FAIL) {
    throw new AppError('LOCKED', 'ログイン失敗が続いたため' + CONFIG.LOGIN_LOCK_MINUTES + '分間ロックしています');
  }

  const u = DB.find(SHEET.USERS, 'email', email);
  if (!u || !verifyPassword_(password, u.password_hash)) {
    cache.put(failKey, String(fails + 1), CONFIG.LOGIN_LOCK_MINUTES * 60);
    const left = CONFIG.LOGIN_MAX_FAIL - fails - 1;
    throw new AppError('AUTH_FAILED', 'メールアドレスまたはパスワードが違います' + (left > 0 ? '（残り' + left + '回）' : ''));
  }
  if (u.status === 'suspended') throw new AppError('ACCOUNT_SUSPENDED', 'このアカウントは利用停止中です');
  cache.remove(failKey);

  const t = issueToken_();
  const updated = withLock_(() => {
    const cur = DB.find(SHEET.USERS, 'user_id', u.user_id);
    return DB.update(SHEET.USERS, cur, { token: t.token, token_expires_at: t.expires, last_login_at: nowStr_() });
  });
  return {
    token: t.token,
    expires_at: t.expires,
    user: publicUser_(updated),
    must_change_password: toBool_(updated.is_temp_password),
  };
}

function apiForgotPassword_(p) {
  const email = str_(p.email, 254).toLowerCase();
  const generic = { message: '登録済みのメールアドレスであれば、仮パスワードを送信しました。' };
  if (!isEmail_(email)) throw new AppError('VALIDATION', 'メールアドレスの形式が正しくありません');

  const cache = CacheService.getScriptCache();
  const key = 'fp:' + sha256Hex_(email).slice(0, 32);
  if (cache.get(key)) return generic;
  cache.put(key, '1', CONFIG.FORGOT_INTERVAL_SEC);

  withLock_(() => {
    const u = DB.find(SHEET.USERS, 'email', email);
    if (!u || u.status === 'suspended') return;
    const tempPw = genTempPassword_();
    if (sendTempPasswordMail_(u.email, u.name, tempPw, 'reset')) {
      DB.update(SHEET.USERS, u, {
        password_hash: makePasswordHash_(tempPw), is_temp_password: true,
        token: '', token_expires_at: '', updated_at: nowStr_(),
      });
    }
  });
  return generic;
}

function apiChangePassword_(u, p) {
  const current = String(p.current_password || '');
  const next = String(p.new_password || '');
  if (!verifyPassword_(current, u.password_hash)) throw new AppError('AUTH_FAILED', '現在のパスワードが違います');
  assertPasswordPolicy_(next);
  if (current === next) throw new AppError('VALIDATION', '現在と異なるパスワードを設定してください');
  const t = issueToken_();
  const updated = withLock_(() => {
    const cur = DB.find(SHEET.USERS, 'user_id', u.user_id);
    return DB.update(SHEET.USERS, cur, {
      password_hash: makePasswordHash_(next), is_temp_password: false,
      token: t.token, token_expires_at: t.expires, updated_at: nowStr_(),
    });
  });
  return { token: t.token, expires_at: t.expires, user: publicUser_(updated), message: 'パスワードを変更しました' };
}

function apiLogout_(u) {
  withLock_(() => {
    const cur = DB.find(SHEET.USERS, 'user_id', u.user_id);
    if (cur) DB.update(SHEET.USERS, cur, { token: '', token_expires_at: '' });
  });
  return { message: 'ログアウトしました' };
}

function apiUpdateProfile_(u, p) {
  const patch = { updated_at: nowStr_() };
  if (p.name !== undefined) {
    const n = str_(p.name, 50);
    if (!n) throw new AppError('VALIDATION', 'お名前を入力してください');
    patch.name = n;
  }
  if (p.phone !== undefined) {
    const ph = str_(p.phone, 20);
    if (ph && !isPhone_(ph)) throw new AppError('VALIDATION', '電話番号の形式が正しくありません');
    patch.phone = ph;
  }
  const updated = withLock_(() => DB.update(SHEET.USERS, DB.find(SHEET.USERS, 'user_id', u.user_id), patch));
  return { user: publicUser_(updated) };
}

// ---------------------------------------------------------------------
// メンバー名簿（主催者にかかわる会員）
//  表示・修正・削除できるのは、名簿の持ち主（登録者）とシステム管理者のみ
// ---------------------------------------------------------------------
function memberView_(m, users, names) {
  const t = users[String(m.user_id)] || {};
  return {
    link_id: m.link_id,
    organizer_id: m.organizer_id,
    organizer_name: names[String(m.organizer_id)] || '',
    user_id: m.user_id,
    name: t.name || '（退会済み）',
    label_name: m.label_name || '',
    email: t.email || '',
    phone: t.phone || '',
    status: t.status || 'deleted',
    is_temp_password: toBool_(t.is_temp_password),
    note: m.note || '',
    created_at: m.created_at,
  };
}

function loadOwnedLink_(u, linkId) {
  const m = DB.find(SHEET.MEMBERS, 'link_id', str_(linkId, 64));
  if (!m) throw new AppError('NOT_FOUND', 'メンバーが見つかりません');
  if (u.role !== 'admin' && String(m.organizer_id) !== String(u.user_id)) {
    throw new AppError('FORBIDDEN', '他の会員のメンバー名簿は操作できません');
  }
  return m;
}

function apiListMembers_(u, p) {
  const users = {};
  DB.all(SHEET.USERS).forEach((x) => { users[String(x.user_id)] = x; });
  const names = userNameMap_();
  const scopeAll = u.role === 'admin' && p.scope === 'all';
  const ownerId = u.role === 'admin' && p.organizer_id ? String(p.organizer_id) : String(u.user_id);
  const list = DB.all(SHEET.MEMBERS)
    .filter((m) => scopeAll || String(m.organizer_id) === ownerId)
    .map((m) => memberView_(m, users, names))
    .sort((a, b) => String(a.label_name || a.name).localeCompare(String(b.label_name || b.name), 'ja'));
  return { members: list, scope: scopeAll ? 'all' : 'mine' };
}

/** メンバー追加：登録済みの会員ならつなぐだけ、未登録なら会員アカウントを発行して仮パスワードを送る */
function apiAddMember_(u, p) {
  const email = str_(p.email, 254).toLowerCase();
  const name = str_(p.name, 50);
  const phone = str_(p.phone, 20);
  const label = str_(p.label_name, 50);
  const note = str_(p.note, 300);
  if (!isEmail_(email)) throw new AppError('VALIDATION', 'メールアドレスの形式が正しくありません');
  if (phone && !isPhone_(phone)) throw new AppError('VALIDATION', '電話番号の形式が正しくありません');
  const ownerId = u.role === 'admin' && p.organizer_id ? str_(p.organizer_id, 64) : u.user_id;

  let tempPw = '';
  let created = false;
  const res = withLock_(() => {
    if (ownerId !== u.user_id && !DB.find(SHEET.USERS, 'user_id', ownerId)) throw new AppError('VALIDATION', '名簿の持ち主が見つかりません');
    const mine = DB.all(SHEET.MEMBERS).filter((m) => String(m.organizer_id) === String(ownerId));
    if (mine.length >= CONFIG.MAX_MEMBERS) throw new AppError('QUOTA_EXCEEDED', 'メンバー名簿は' + CONFIG.MAX_MEMBERS + '名までです');
    let target = DB.find(SHEET.USERS, 'email', email);
    if (target && String(target.user_id) === String(ownerId)) throw new AppError('VALIDATION', 'ご自身は追加できません');
    if (target && mine.some((m) => String(m.user_id) === String(target.user_id))) {
      throw new AppError('DUPLICATE', 'この会員はすでにメンバー名簿に入っています');
    }
    if (!target) {
      if (!name) throw new AppError('VALIDATION', '未登録のメールアドレスです。お名前を入力すると会員として登録して追加します');
      tempPw = genTempPassword_();
      target = newUserRow_(email, name, phone, 'user', tempPw);
      DB.insert(SHEET.USERS, target);
      created = true;
    }
    const now = nowStr_();
    const link = { link_id: genId_('M'), organizer_id: ownerId, user_id: target.user_id, label_name: label, note: note, created_at: now, updated_at: now };
    DB.insert(SHEET.MEMBERS, link);
    return { link: link, target: target };
  });

  let mailSent = null;
  if (created) mailSent = sendTempPasswordMail_(email, name, tempPw, 'admin_issue');
  const users = {}; users[String(res.target.user_id)] = res.target;
  const out = {
    member: memberView_(res.link, users, userNameMap_()),
    created_account: created,
    message: created ? '会員アカウントを発行してメンバーに追加しました' : '登録済みの会員をメンバーに追加しました',
  };
  if (created) { out.mail_sent = mailSent; if (!mailSent) out.temp_password = tempPw; }
  return out;
}

function apiUpdateMember_(u, p) {
  return withLock_(() => {
    const m = loadOwnedLink_(u, p.link_id);
    const patch = { updated_at: nowStr_() };
    if (p.label_name !== undefined) patch.label_name = str_(p.label_name, 50);
    if (p.note !== undefined) patch.note = str_(p.note, 300);
    const merged = DB.update(SHEET.MEMBERS, m, patch);
    const users = {}; DB.all(SHEET.USERS).forEach((x) => { users[String(x.user_id)] = x; });
    return { member: memberView_(merged, users, userNameMap_()) };
  });
}

/** 名簿から外す（会員アカウント自体は削除しない）。外した会員は、この持ち主の今後のイベントの共同主催からも外れる */
function apiRemoveMember_(u, p) {
  return withLock_(() => {
    const m = loadOwnedLink_(u, p.link_id);
    const ownerId = String(m.organizer_id);
    const uid = String(m.user_id);
    const nowMs = Date.now();
    let detached = 0;
    DB.all(SHEET.EVENTS).forEach((ev) => {
      if (String(ev.organizer_id) !== ownerId || !(eventStart_(ev) && eventStart_(ev).getTime() > nowMs)) return;
      const ids = coIds_(ev);
      if (ids.indexOf(uid) === -1) return;
      DB.update(SHEET.EVENTS, ev, { co_organizer_ids: ids.filter((x) => x !== uid).join(','), updated_at: nowStr_() });
      detached++;
    });
    DB.deleteRow(SHEET.MEMBERS, m);
    return { removed: true, detached_events: detached };
  });
}

/** 共同主催者の候補：会員は自分のメンバー名簿、管理者は全会員 */
function apiListCoOrganizerCandidates_(u, p) {
  if (u.role === 'admin') {
    const ownerId = str_(p.organizer_id, 64);
    return {
      candidates: DB.all(SHEET.USERS).filter((x) => x.status !== 'suspended' && String(x.user_id) !== ownerId)
        .map((x) => ({ user_id: x.user_id, name: x.name, email: x.email }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja')),
    };
  }
  const users = {}; DB.all(SHEET.USERS).forEach((x) => { users[String(x.user_id)] = x; });
  return {
    candidates: DB.all(SHEET.MEMBERS).filter((m) => String(m.organizer_id) === String(u.user_id))
      .map((m) => users[String(m.user_id)]).filter((x) => x && x.status !== 'suspended')
      .map((x) => ({ user_id: x.user_id, name: x.name, email: x.email }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja')),
  };
}

// ---------------------------------------------------------------------
// 管理者
// ---------------------------------------------------------------------
function apiAdminListUsers_(u, p) {
  const kw = str_(p.keyword, 100).toLowerCase();
  let list = DB.all(SHEET.USERS).map((x) => Object.assign(publicUser_(x), {
    status: x.status || 'active', created_at: x.created_at, last_login_at: x.last_login_at,
  }));
  if (kw) list = list.filter((x) => (x.name + ' ' + x.email).toLowerCase().indexOf(kw) >= 0);
  if (p.role && ROLES.indexOf(p.role) >= 0) list = list.filter((x) => x.role === p.role);
  list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { users: list };
}

function apiAdminCreateUser_(u, p) {
  const email = str_(p.email, 254).toLowerCase();
  const name = str_(p.name, 50);
  const phone = str_(p.phone, 20);
  const role = ROLES.indexOf(p.role) >= 0 ? p.role : 'user';
  if (!isEmail_(email)) throw new AppError('VALIDATION', 'メールアドレスの形式が正しくありません');
  if (!name) throw new AppError('VALIDATION', 'お名前を入力してください');
  if (phone && !isPhone_(phone)) throw new AppError('VALIDATION', '電話番号の形式が正しくありません');

  const tempPw = genTempPassword_();
  const row = withLock_(() => {
    if (DB.find(SHEET.USERS, 'email', email)) throw new AppError('DUPLICATE', 'このメールアドレスは既に登録されています');
    return DB.insert(SHEET.USERS, newUserRow_(email, name, phone, role, tempPw));
  });
  const sent = sendTempPasswordMail_(email, name, tempPw, 'admin_issue');
  const res = { user: publicUser_(row), mail_sent: sent };
  if (!sent) res.temp_password = tempPw; // 送信失敗時のみ管理者へ返却
  return res;
}

function apiAdminUpdateUser_(u, p) {
  const targetId = str_(p.user_id, 64);
  return withLock_(() => {
    const t = DB.find(SHEET.USERS, 'user_id', targetId);
    if (!t) throw new AppError('NOT_FOUND', 'ユーザーが見つかりません');
    const patch = { updated_at: nowStr_() };
    if (p.role !== undefined) {
      if (ROLES.indexOf(p.role) === -1) throw new AppError('VALIDATION', 'roleが不正です');
      if (t.user_id === u.user_id && p.role !== 'admin') throw new AppError('VALIDATION', '自分自身の管理者権限は外せません');
      patch.role = p.role;
    }
    if (p.status !== undefined) {
      if (['active', 'suspended'].indexOf(p.status) === -1) throw new AppError('VALIDATION', 'statusが不正です');
      if (t.user_id === u.user_id && p.status === 'suspended') throw new AppError('VALIDATION', '自分自身は停止できません');
      patch.status = p.status;
      if (p.status === 'suspended') { patch.token = ''; patch.token_expires_at = ''; }
    }
    if (p.name !== undefined) patch.name = str_(p.name, 50) || t.name;
    if (p.phone !== undefined) patch.phone = str_(p.phone, 20);
    const m = DB.update(SHEET.USERS, t, patch);
    return { user: Object.assign(publicUser_(m), { status: m.status }) };
  });
}

function apiAdminResetPassword_(u, p) {
  const tempPw = genTempPassword_();
  const t = withLock_(() => {
    const x = DB.find(SHEET.USERS, 'user_id', str_(p.user_id, 64));
    if (!x) throw new AppError('NOT_FOUND', 'ユーザーが見つかりません');
    return DB.update(SHEET.USERS, x, {
      password_hash: makePasswordHash_(tempPw), is_temp_password: true,
      token: '', token_expires_at: '', updated_at: nowStr_(),
    });
  });
  const sent = sendTempPasswordMail_(t.email, t.name, tempPw, 'reset');
  const res = { mail_sent: sent, message: sent ? '仮パスワードを再発行しメール送信しました' : 'メール送信に失敗しました。仮パスワードを直接お伝えください' };
  if (!sent) res.temp_password = tempPw;
  return res;
}

// ---------------------------------------------------------------------
// 空き状況計算
// ---------------------------------------------------------------------
function reservationIndex_() {
  const idx = {};
  DB.all(SHEET.RESERVATIONS).forEach((r) => {
    const k = String(r.event_id);
    const s = idx[k] || (idx[k] = { confirmed: 0, pending: 0 });
    const g = toInt_(r.guest_count, 0);
    if (r.status === 'confirmed') s.confirmed += g;
    else if (r.status === 'pending') s.pending += g;
  });
  return idx;
}

/** 承認待ちも席を仮押さえとして残席から差し引く（オーバーブッキング防止） */
function computeAvailability_(ev, idx) {
  const s = idx[String(ev.event_id)] || { confirmed: 0, pending: 0 };
  const cap = Math.max(0, toInt_(ev.capacity, 0));
  const remaining = Math.max(0, cap - s.confirmed - s.pending);
  const dl = eventDeadline_(ev);
  let state = 'open';
  if (ev.status === 'cancelled') state = 'cancelled';
  else if (ev.status === 'closed') state = 'closed';
  else if (!dl || Date.now() >= dl.getTime()) state = 'closed';
  else if (remaining <= 0) state = 'full';
  const isOpen = state === 'open';
  const ratio = cap > 0 ? remaining / cap : 0;
  const mark = !isOpen ? '✕' : (ratio > CONFIG.PLENTY_RATIO ? '〇' : '△');
  const label = { open: mark === '〇' ? '空きあり' : '残りわずか', full: '満席', closed: '受付終了', cancelled: '中止' }[state];
  return {
    capacity: cap, confirmed: s.confirmed, pending: s.pending, remaining: remaining,
    ratio: Math.round(ratio * 1000) / 1000, state: state, mark: mark, label: label, is_open: isOpen,
    deadline_at: dl ? fmt_(dl, 'yyyy-MM-dd HH:mm') : '',
  };
}

function userNameMap_() {
  const m = {};
  DB.all(SHEET.USERS).forEach((u) => { m[String(u.user_id)] = u.name; });
  return m;
}

function flyerUrl_(idOrUrl) {
  const v = str_(idOrUrl, 300);
  if (!v) return '';
  if (/^https?:\/\//.test(v)) return v;
  return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(v) + '&sz=w1600';
}

function publicEvent_(ev, idx, names) {
  return {
    event_id: ev.event_id,
    organizer_id: ev.organizer_id,
    organizer_name: names ? (names[String(ev.organizer_id)] || '') : '',
    co_organizer_ids: coIds_(ev),
    co_organizer_names: names ? coIds_(ev).map((id) => names[id]).filter(Boolean) : [],
    title: ev.title,
    description: ev.description,
    category: ev.category,
    event_date: ev.event_date,
    weekday: weekdayJa_(ev.event_date),
    start_time: ev.start_time,
    end_time: ev.end_time,
    location: ev.location,
    fee: toInt_(ev.fee, 0),
    capacity: toInt_(ev.capacity, 0),
    deadline_hours_before: toInt_(ev.deadline_hours_before, 0),
    is_approval_required: toBool_(ev.is_approval_required),
    flyer_drive_id: ev.flyer_drive_id,
    flyer_url: flyerUrl_(ev.flyer_drive_id),
    recurring_group_id: ev.recurring_group_id,
    status: ev.status,
    availability: computeAvailability_(ev, idx),
  };
}

function publicReservation_(r) {
  return {
    reservation_id: r.reservation_id,
    event_id: r.event_id,
    user_id: r.user_id,
    guest_count: toInt_(r.guest_count, 0),
    applicant_name: r.applicant_name,
    applicant_phone: r.applicant_phone,
    applicant_email: r.applicant_email,
    status: r.status,
    status_label: RESV_STATUS_LABEL[r.status] || r.status,
    payment_status: r.payment_status,
    payment_label: PAY_STATUS_LABEL[r.payment_status] || r.payment_status,
    applied_at: r.applied_at,
    note: r.note,
    updated_at: r.updated_at,
  };
}

function sortEvents_(a, b) {
  return (a.event_date + a.start_time).localeCompare(b.event_date + b.start_time);
}

// ---------------------------------------------------------------------
// イベント閲覧
// ---------------------------------------------------------------------
function apiListEvents_(u, p) {
  const today = todayYmd_();
  const from = parseYmd_(p.from) ? p.from : today;
  const to = parseYmd_(p.to) ? p.to : maxEventYmd_();
  const kw = str_(p.keyword, 100).toLowerCase();
  const cat = str_(p.category, 50);
  const idx = reservationIndex_();
  const names = userNameMap_();

  let list = DB.all(SHEET.EVENTS)
    .filter((ev) => ev.status !== 'cancelled' && ev.event_date >= from && ev.event_date <= to)
    .filter((ev) => !cat || ev.category === cat)
    .filter((ev) => !p.organizer_id || String(ev.organizer_id) === String(p.organizer_id))
    .filter((ev) => !kw || [ev.title, ev.description, ev.location, ev.category].join(' ').toLowerCase().indexOf(kw) >= 0)
    .sort(sortEvents_)
    .map((ev) => publicEvent_(ev, idx, names));

  if (toBool_(p.only_open)) list = list.filter((e) => e.availability.is_open);
  return { events: list, range: { from: from, to: to }, today: today };
}

function apiGetEvent_(u, p) {
  const ev = DB.find(SHEET.EVENTS, 'event_id', str_(p.event_id, 64));
  if (!ev) throw new AppError('NOT_FOUND', 'イベントが見つかりません');
  const res = { event: publicEvent_(ev, reservationIndex_(), userNameMap_()), my_reservation: null };
  if (u) {
    const mine = DB.all(SHEET.RESERVATIONS).find((r) => r.event_id === ev.event_id && r.user_id === u.user_id &&
      (r.status === 'pending' || r.status === 'confirmed'));
    if (mine) res.my_reservation = publicReservation_(mine);
  }
  return res;
}

function apiListCategories_() {
  const set = {};
  CONFIG.DEFAULT_CATEGORIES.forEach((c) => { set[c] = true; });
  DB.all(SHEET.EVENTS).forEach((ev) => { if (ev.category) set[ev.category] = true; });
  return { categories: Object.keys(set) };
}

// ---------------------------------------------------------------------
// イベント管理（主催者）
// ---------------------------------------------------------------------
function buildEventFields_(p, base) {
  base = base || {};
  const pick = (k) => (p[k] !== undefined ? p[k] : base[k]);
  const f = {
    title: str_(pick('title'), 100),
    description: str_(pick('description'), 5000),
    category: str_(pick('category'), 50),
    event_date: str_(pick('event_date'), 10),
    start_time: str_(pick('start_time'), 5),
    end_time: str_(pick('end_time'), 5),
    location: str_(pick('location'), 200),
    fee: toInt_(pick('fee'), 0),
    capacity: toInt_(pick('capacity'), 0),
    deadline_hours_before: toInt_(pick('deadline_hours_before'), 0),
    is_approval_required: toBool_(pick('is_approval_required')),
    flyer_drive_id: str_(pick('flyer_drive_id'), 300),
  };
  if (!f.title) throw new AppError('VALIDATION', 'タイトルを入力してください');
  if (!isTime_(f.start_time)) throw new AppError('VALIDATION', '開始時刻を HH:mm 形式で入力してください');
  if (!isTime_(f.end_time)) throw new AppError('VALIDATION', '終了時刻を HH:mm 形式で入力してください');
  if (f.end_time <= f.start_time) throw new AppError('VALIDATION', '終了時刻は開始時刻より後にしてください');
  if (!f.location) throw new AppError('VALIDATION', '開催場所を入力してください');
  if (f.capacity < 1 || f.capacity > 10000) throw new AppError('VALIDATION', '定員は1〜10000名で指定してください');
  if (f.fee < 0 || f.fee > 10000000) throw new AppError('VALIDATION', '参加費が不正です');
  if (f.deadline_hours_before < 0 || f.deadline_hours_before > 720) {
    throw new AppError('VALIDATION', '締切は開催の0〜720時間前で指定してください');
  }
  return f;
}

function assertDateInRange_(ymd, startTime) {
  if (!parseYmd_(ymd)) throw new AppError('VALIDATION', '開催日を YYYY-MM-DD 形式で指定してください');
  const today = todayYmd_();
  const max = maxEventYmd_();
  if (ymd < today || ymd > max) {
    throw new AppError('VALIDATION', '開催日は本日（' + today + '）から ' + max + ' までの範囲で指定してください');
  }
  const start = eventStart_({ event_date: ymd, start_time: startTime });
  if (start.getTime() <= Date.now()) throw new AppError('VALIDATION', '開始日時が既に過ぎています');
}

/** アクティブ予約項目数（未来の非中止イベント。定期グループは1項目として計上） */
function countActiveItems_(organizerId) {
  const now = Date.now();
  const keys = {};
  DB.all(SHEET.EVENTS).forEach((ev) => {
    if (String(ev.organizer_id) !== String(organizerId) || ev.status === 'cancelled') return;
    const s = eventStart_(ev);
    if (!s || s.getTime() < now) return;
    keys[ev.recurring_group_id || ev.event_id] = true;
  });
  return Object.keys(keys).length;
}

function assertQuota_(user, organizerId) {
  if (user.role === 'admin') return; // 管理者は無制限
  const used = countActiveItems_(organizerId);
  if (used + 1 > CONFIG.MAX_ACTIVE_ITEMS) {
    throw new AppError('QUOTA_EXCEEDED', '受付中の予約項目が上限（' + CONFIG.MAX_ACTIVE_ITEMS + '枠）に達しています。終了・中止された枠があれば空きます');
  }
}

function resolveOrganizerId_(user, p) {
  if (user.role === 'admin' && p.organizer_id) {
    const o = DB.find(SHEET.USERS, 'user_id', p.organizer_id);
    if (!o || o.status === 'suspended') throw new AppError('VALIDATION', '指定された主催者が存在しません');
    return o.user_id;
  }
  return user.user_id;
}

// ---- イベントの権限 ----
//  登録者（organizer_id）＋共同主催者（co_organizer_ids）＝そのイベントの主催者
//  ・閲覧／編集／参加者名簿・承認・精算 … 主催者全員とシステム管理者
//  ・中止／削除／共同主催者の変更       … 登録者とシステム管理者
function coIds_(ev) {
  return String(ev.co_organizer_ids || '').split(',').map((x) => x.trim()).filter(Boolean);
}
function managerIds_(ev) {
  return [String(ev.organizer_id)].concat(coIds_(ev));
}
function isManager_(user, ev) {
  return managerIds_(ev).indexOf(String(user.user_id)) >= 0;
}
function canManage_(user, ev) {
  return user.role === 'admin' || isManager_(user, ev);
}
function isOwner_(user, ev) {
  return user.role === 'admin' || String(ev.organizer_id) === String(user.user_id);
}

function loadOwnedEvent_(user, eventId, ownerOnly) {
  const ev = DB.find(SHEET.EVENTS, 'event_id', str_(eventId, 64));
  if (!ev) throw new AppError('NOT_FOUND', 'イベントが見つかりません');
  if (!canManage_(user, ev)) throw new AppError('FORBIDDEN', 'このイベントの主催者ではないため操作できません');
  if (ownerOnly && !isOwner_(user, ev)) {
    throw new AppError('FORBIDDEN', 'この操作はイベントの登録者またはシステム管理者のみ行えます');
  }
  return ev;
}

/** 共同主催者IDの検証。会員はメンバー名簿の会員から選ぶ（管理者は全会員から可） */
function resolveCoOrganizers_(user, ownerId, input) {
  let ids = Array.isArray(input) ? input : String(input || '').split(',');
  ids = ids.map((x) => str_(x, 64)).filter(Boolean).filter((x) => x !== String(ownerId));
  ids = ids.filter((x, i) => ids.indexOf(x) === i);
  if (ids.length > CONFIG.MAX_CO_ORGANIZERS) {
    throw new AppError('VALIDATION', '共同主催者は' + CONFIG.MAX_CO_ORGANIZERS + '名までです');
  }
  const linked = {};
  if (user.role !== 'admin') {
    DB.all(SHEET.MEMBERS).forEach((m) => { if (String(m.organizer_id) === String(ownerId)) linked[String(m.user_id)] = true; });
  }
  ids.forEach((id) => {
    const t = DB.find(SHEET.USERS, 'user_id', id);
    if (!t || t.status === 'suspended') throw new AppError('VALIDATION', '共同主催者に指定できない会員が含まれています');
    if (user.role !== 'admin' && !linked[id]) {
      throw new AppError('VALIDATION', '共同主催者は、登録者のメンバー名簿にいる会員から選んでください（' + t.name + '）');
    }
  });
  return ids.join(',');
}

function managerUsers_(ev) {
  return managerIds_(ev).map((id) => DB.find(SHEET.USERS, 'user_id', id)).filter((x) => x && x.status !== 'suspended');
}

function apiCreateEvent_(u, p) {
  const f = buildEventFields_(p.event || p);
  assertDateInRange_(f.event_date, f.start_time);
  return withLock_(() => {
    const orgId = resolveOrganizerId_(u, p);
    assertQuota_(u, orgId);
    const now = nowStr_();
    const row = Object.assign({
      event_id: genId_('E'), organizer_id: orgId, recurring_group_id: '', status: 'active',
      created_at: now, updated_at: now,
      co_organizer_ids: resolveCoOrganizers_(u, orgId, (p.event || p).co_organizer_ids),
    }, f);
    DB.insert(SHEET.EVENTS, row);
    return { event: publicEvent_(row, reservationIndex_(), userNameMap_()) };
  });
}

function apiUpdateEvent_(u, p) {
  const input = p.event || p;
  const result = withLock_(() => {
    const ev = loadOwnedEvent_(u, p.event_id || input.event_id);
    if (ev.status === 'cancelled') throw new AppError('VALIDATION', '中止済みのイベントは編集できません');
    const f = buildEventFields_(input, ev);
    const scheduleChanged = f.event_date !== ev.event_date || f.start_time !== ev.start_time ||
      f.end_time !== ev.end_time || f.location !== ev.location;
    if (f.event_date !== ev.event_date || f.start_time !== ev.start_time) assertDateInRange_(f.event_date, f.start_time);

    const avail = computeAvailability_(ev, reservationIndex_());
    if (f.capacity < avail.confirmed + avail.pending) {
      throw new AppError('VALIDATION', '定員は現在の申込人数（' + (avail.confirmed + avail.pending) + '名）以上にしてください');
    }
    const patch = Object.assign({ updated_at: nowStr_() }, f);
    if (input.status === 'active' || input.status === 'closed') patch.status = input.status;
    if (input.co_organizer_ids !== undefined) {
      const next = resolveCoOrganizers_(u, ev.organizer_id, input.co_organizer_ids);
      if (next !== coIds_(ev).join(',')) {
        if (!isOwner_(u, ev)) throw new AppError('FORBIDDEN', '共同主催者の変更は、イベントの登録者またはシステム管理者のみ行えます');
        patch.co_organizer_ids = next;
        // 定期開催は同じグループの今後の回にも反映
        if (ev.recurring_group_id && input.apply_co_to_group !== false) {
          const nowMs = Date.now();
          DB.all(SHEET.EVENTS).forEach((x) => {
            if (x.recurring_group_id === ev.recurring_group_id && x.event_id !== ev.event_id && x.status !== 'cancelled' &&
              eventStart_(x) && eventStart_(x).getTime() > nowMs) DB.update(SHEET.EVENTS, x, { co_organizer_ids: next, updated_at: nowStr_() });
          });
        }
      }
    }
    const m = DB.update(SHEET.EVENTS, ev, patch);
    const targets = scheduleChanged ? DB.all(SHEET.RESERVATIONS).filter((r) => r.event_id === ev.event_id &&
      (r.status === 'pending' || r.status === 'confirmed')) : [];
    return { ev: m, targets: targets };
  });

  if (result.targets.length && input.notify_participants !== false) {
    result.targets.forEach((r) => sendMail_(r.applicant_email, '【' + CONFIG.APP_NAME + '】開催内容変更のお知らせ',
      r.applicant_name + ' 様\n\nご予約中のイベントの開催日時・場所が変更されました。\n\n' + eventInfoText_(result.ev) +
      '\n\nご都合が合わない場合はマイ予約からキャンセルしてください。' + footer_()));
  }
  return { event: publicEvent_(result.ev, reservationIndex_(), userNameMap_()), notified: result.targets.length };
}

function apiCancelEvent_(u, p) {
  const scope = p.scope === 'group' ? 'group' : 'single';
  const reason = str_(p.reason, 300);
  const out = withLock_(() => {
    const ev = loadOwnedEvent_(u, p.event_id, true);
    let targets = [ev];
    if (scope === 'group' && ev.recurring_group_id) {
      const now = Date.now();
      targets = DB.all(SHEET.EVENTS).filter((x) => x.recurring_group_id === ev.recurring_group_id &&
        x.status !== 'cancelled' && eventStart_(x) && eventStart_(x).getTime() > now);
    }
    const ids = {};
    const now = nowStr_();
    targets.forEach((x) => {
      ids[x.event_id] = x;
      DB.update(SHEET.EVENTS, x, { status: 'cancelled', updated_at: now });
    });
    const affected = [];
    DB.all(SHEET.RESERVATIONS).forEach((r) => {
      if (!ids[r.event_id] || (r.status !== 'pending' && r.status !== 'confirmed')) return;
      DB.update(SHEET.RESERVATIONS, r, {
        status: 'cancelled', updated_at: now,
        note: str_((r.note ? r.note + ' / ' : '') + '[主催者によるイベント中止]', 500),
      });
      affected.push({ r: r, ev: ids[r.event_id] });
    });
    return { count: targets.length, affected: affected };
  });

  out.affected.forEach((a) => sendMail_(a.r.applicant_email, '【' + CONFIG.APP_NAME + '】イベント中止のお知らせ',
    a.r.applicant_name + ' 様\n\n誠に申し訳ございませんが、下記イベントは中止となりました。\n' +
    (reason ? '理由：' + reason + '\n' : '') + '\n' + eventInfoText_(a.ev) +
    '\n\nお支払い済みの参加費がある場合は、主催者より個別にご連絡いたします。' + footer_()));
  return { cancelled_events: out.count, cancelled_reservations: out.affected.length };
}

/** イベント削除（登録者・管理者のみ）。申込中・確定の予約がある回は削除できない（中止を使う） */
function apiDeleteEvent_(u, p) {
  const scope = p.scope === 'group' ? 'group' : 'single';
  return withLock_(() => {
    const ev = loadOwnedEvent_(u, p.event_id, true);
    let targets = [ev];
    if (scope === 'group' && ev.recurring_group_id) {
      const nowMs = Date.now();
      targets = DB.all(SHEET.EVENTS).filter((x) => x.recurring_group_id === ev.recurring_group_id &&
        (x.event_id === ev.event_id || (eventStart_(x) && eventStart_(x).getTime() > nowMs)));
    }
    const ids = {};
    targets.forEach((x) => { ids[x.event_id] = true; });
    const busy = DB.all(SHEET.RESERVATIONS).filter((r) => ids[r.event_id] && (r.status === 'pending' || r.status === 'confirmed'));
    if (busy.length) {
      throw new AppError('HAS_RESERVATIONS', '申込中・確定の予約が' + busy.length + '件あるため削除できません。先に「イベントを中止」で参加者へ通知してください');
    }
    targets.slice().sort((a, b) => b._row - a._row).forEach((x) => DB.deleteRow(SHEET.EVENTS, x));
    return { deleted_events: targets.length };
  });
}

// ---------------------------------------------------------------------
// 定期開催一括生成
// ---------------------------------------------------------------------
/**
 * pattern = {
 *   type: 'weekly' | 'biweekly' | 'monthly_nth',
 *   weekdays: [0-6],          // 0=日 … 6=土（複数可）
 *   nths: [1-5 | -1],         // monthly_nth のみ（-1=最終週）
 *   start_date, end_date,     // 省略時 本日〜2ヶ月先
 *   skip_dates: ['YYYY-MM-DD'] // プレビューで除外した日
 * }
 */
function computeRecurringDates_(pattern, startTime) {
  pattern = pattern || {};
  const today = todayYmd_();
  const max = maxEventYmd_();
  const from = parseYmd_(pattern.start_date) && pattern.start_date > today ? pattern.start_date : today;
  const to = parseYmd_(pattern.end_date) && pattern.end_date < max ? pattern.end_date : max;
  if (from > to) throw new AppError('VALIDATION', '期間の指定が不正です');

  const wdSrc = Array.isArray(pattern.weekdays) ? pattern.weekdays : [pattern.weekday];
  const weekdays = wdSrc.map(Number).filter((n) => n >= 0 && n <= 6);
  if (!weekdays.length) throw new AppError('VALIDATION', '曜日を1つ以上選択してください');

  const skip = {};
  (pattern.skip_dates || []).forEach((d) => { skip[String(d)] = true; });

  const fromD = parseYmd_(from);
  const toD = parseYmd_(to);
  const weekStart = addDays_(fromD, -fromD.getDay());
  let nths = [];
  if (pattern.type === 'monthly_nth') {
    nths = (Array.isArray(pattern.nths) ? pattern.nths : [pattern.nth]).map(Number)
      .filter((n) => (n >= 1 && n <= 5) || n === -1);
    if (!nths.length) throw new AppError('VALIDATION', '第何週かを指定してください');
  } else if (pattern.type !== 'weekly' && pattern.type !== 'biweekly') {
    throw new AppError('VALIDATION', '繰り返しパターンが不正です');
  }

  const res = [];
  for (let d = new Date(fromD.getTime()); d <= toD; d = addDays_(d, 1)) {
    if (weekdays.indexOf(d.getDay()) === -1) continue;
    if (pattern.type === 'biweekly') {
      const w = Math.floor(Math.round((d.getTime() - weekStart.getTime()) / 86400000) / 7);
      if (w % 2 !== 0) continue;
    }
    if (pattern.type === 'monthly_nth') {
      const nth = Math.floor((d.getDate() - 1) / 7) + 1;
      const isLast = addDays_(d, 7).getMonth() !== d.getMonth();
      if (nths.indexOf(nth) === -1 && !(isLast && nths.indexOf(-1) >= 0)) continue;
    }
    const ymd = fmt_(d, 'yyyy-MM-dd');
    if (skip[ymd]) continue;
    if (eventStart_({ event_date: ymd, start_time: startTime }).getTime() <= Date.now()) continue;
    res.push({ date: ymd, weekday: WEEKDAYS_JA[d.getDay()] });
    if (res.length >= CONFIG.RECURRING_MAX_DATES) break;
  }
  return res;
}

function recurringBase_(u, p) {
  let base = {};
  if (p.base_event_id) base = loadOwnedEvent_(u, p.base_event_id);
  return buildEventFields_(p.event || {}, base);
}

function apiPreviewRecurring_(u, p) {
  const f = recurringBase_(u, p);
  const dates = computeRecurringDates_(p.pattern, f.start_time);
  const orgId = resolveOrganizerId_(u, p);
  const existing = {};
  DB.all(SHEET.EVENTS).forEach((ev) => {
    if (String(ev.organizer_id) === String(orgId) && ev.status !== 'cancelled') existing[ev.event_date + ' ' + ev.start_time] = ev.title;
  });
  const items = dates.map((d) => ({
    date: d.date, weekday: d.weekday, start_time: f.start_time, end_time: f.end_time,
    conflict_title: existing[d.date + ' ' + f.start_time] || '',
  }));
  const used = countActiveItems_(orgId);
  return {
    base: f,
    dates: items,
    count: items.length,
    quota: { used: used, after: used + 1, max: u.role === 'admin' ? null : CONFIG.MAX_ACTIVE_ITEMS },
    range: { from: todayYmd_(), to: maxEventYmd_() },
  };
}

function apiCreateRecurring_(u, p) {
  const f = recurringBase_(u, p);
  const dates = computeRecurringDates_(p.pattern, f.start_time);
  if (!dates.length) throw new AppError('VALIDATION', '条件に該当する開催日がありません');
  return withLock_(() => {
    const orgId = resolveOrganizerId_(u, p);
    assertQuota_(u, orgId);
    const coIds = resolveCoOrganizers_(u, orgId, (p.event || {}).co_organizer_ids);
    const groupId = genId_('G');
    const now = nowStr_();
    const rows = dates.map((d) => Object.assign({}, f, {
      event_id: genId_('E'), organizer_id: orgId, event_date: d.date, recurring_group_id: groupId,
      status: 'active', created_at: now, updated_at: now, co_organizer_ids: coIds,
    }));
    DB.insertMany(SHEET.EVENTS, rows);
    const idx = reservationIndex_();
    const names = userNameMap_();
    return { recurring_group_id: groupId, count: rows.length, events: rows.map((r) => publicEvent_(r, idx, names)) };
  });
}

// ---------------------------------------------------------------------
// 主催者ダッシュボード
// ---------------------------------------------------------------------
function apiOrganizerDashboard_(u, p) {
  const isAdmin = u.role === 'admin';
  const scopeAll = isAdmin && p.scope === 'all';
  const today = todayYmd_();
  const yesterday = fmt_(addDays_(parseYmd_(today), -1), 'yyyy-MM-dd');
  const max = maxEventYmd_();
  const idx = reservationIndex_();
  const names = userNameMap_();
  const mine = (ev) => scopeAll || isManager_(u, ev);

  const allMine = DB.all(SHEET.EVENTS).filter(mine);
  const mineIds = {};
  allMine.forEach((ev) => { mineIds[ev.event_id] = true; });

  const upcoming = allMine.filter((ev) => ev.event_date >= today && ev.event_date <= max &&
    (toBool_(p.include_cancelled) || ev.status !== 'cancelled')).sort(sortEvents_);
  const upIds = {};
  upcoming.forEach((ev) => { upIds[ev.event_id] = true; });

  const resv = DB.all(SHEET.RESERVATIONS).filter((r) => mineIds[r.event_id]);
  const perEvent = {};
  const stats = { today_count: 0, today_guests: 0, yesterday_guests: 0, pending_count: 0, unpaid_count: 0, paid_count: 0 };

  resv.forEach((r) => {
    const g = toInt_(r.guest_count, 0);
    const day = String(r.applied_at).slice(0, 10);
    const active = r.status === 'pending' || r.status === 'confirmed';
    if (active && day === today) { stats.today_count++; stats.today_guests += g; }
    if (active && day === yesterday) stats.yesterday_guests += g;
    if (!upIds[r.event_id]) return;
    const pe = perEvent[r.event_id] || (perEvent[r.event_id] = { pending_count: 0, unpaid_count: 0, paid_count: 0 });
    if (r.status === 'pending') { stats.pending_count++; pe.pending_count++; }
    if (r.status === 'confirmed') {
      if (r.payment_status === 'paid') { stats.paid_count++; pe.paid_count++; } else { stats.unpaid_count++; pe.unpaid_count++; }
    }
  });
  stats.change_vs_yesterday_pct = stats.yesterday_guests > 0
    ? Math.round((stats.today_guests - stats.yesterday_guests) / stats.yesterday_guests * 100) : null;

  return {
    quota: {
      used: scopeAll ? null : countActiveItems_(u.user_id),
      max: isAdmin ? null : CONFIG.MAX_ACTIVE_ITEMS,
    },
    stats: stats,
    events: upcoming.map((ev) => Object.assign(publicEvent_(ev, idx, names),
      perEvent[ev.event_id] || { pending_count: 0, unpaid_count: 0, paid_count: 0 },
      { is_owner: isOwner_(u, ev), my_role: String(ev.organizer_id) === String(u.user_id) ? 'owner' : (isManager_(u, ev) ? 'co' : 'admin') })),
    range: { from: today, to: max },
  };
}

// ---------------------------------------------------------------------
// 予約（参加者）
// ---------------------------------------------------------------------
function apiCreateReservation_(u, p) {
  const eventId = str_(p.event_id, 64);
  const guests = toInt_(p.guest_count, 1);
  const name = str_(p.applicant_name || u.name, 50);
  const phone = str_(p.applicant_phone || u.phone, 20);
  const email = str_(p.applicant_email || u.email, 254).toLowerCase();
  const note = str_(p.note, 500);
  if (guests < 1 || guests > CONFIG.MAX_GUESTS_PER_RESERVATION) {
    throw new AppError('VALIDATION', '参加人数は1〜' + CONFIG.MAX_GUESTS_PER_RESERVATION + '名で指定してください');
  }
  if (!name) throw new AppError('VALIDATION', '代表者名を入力してください');
  if (!isPhone_(phone)) throw new AppError('VALIDATION', '電話番号を正しく入力してください');
  if (!isEmail_(email)) throw new AppError('VALIDATION', 'メールアドレスを正しく入力してください');

  const res = withLock_(() => {
    const ev = DB.find(SHEET.EVENTS, 'event_id', eventId);
    if (!ev) throw new AppError('NOT_FOUND', 'イベントが見つかりません');
    const avail = computeAvailability_(ev, reservationIndex_());
    if (!avail.is_open) throw new AppError('NOT_AVAILABLE', avail.label + 'のため予約できません');
    if (guests > avail.remaining) throw new AppError('CAPACITY', '残席が不足しています（残り' + avail.remaining + '名）');
    const dup = DB.all(SHEET.RESERVATIONS).some((r) => r.event_id === eventId && r.user_id === u.user_id &&
      (r.status === 'pending' || r.status === 'confirmed'));
    if (dup) throw new AppError('DUPLICATE', 'このイベントは既に予約済みです（人数変更は一度キャンセルして再予約してください）');

    const now = nowStr_();
    const r = {
      reservation_id: genId_('R'), event_id: eventId, user_id: u.user_id, guest_count: guests,
      applicant_name: name, applicant_phone: phone, applicant_email: email,
      status: toBool_(ev.is_approval_required) ? 'pending' : 'confirmed',
      payment_status: toInt_(ev.fee, 0) > 0 ? 'unpaid' : 'paid', // 無料イベントは精算不要
      applied_at: now, note: note, updated_at: now,
    };
    DB.insert(SHEET.RESERVATIONS, r);
    return { r: r, ev: ev };
  });

  const r = res.r;
  const ev = res.ev;
  const pending = r.status === 'pending';
  sendMail_(r.applicant_email, '【' + CONFIG.APP_NAME + '】' + (pending ? '予約申込を受け付けました（承認待ち）' : '予約が確定しました'),
    r.applicant_name + ' 様\n\n' + (pending
      ? '以下のイベントへの申込を受け付けました。主催者の承認後に確定となり、改めてご連絡いたします。'
      : '以下のイベントのご予約が確定しました。') +
    '\n\n' + eventInfoText_(ev) + '\n■ 参加人数：' + r.guest_count + '名\n■ 予約番号：' + r.reservation_id +
    '\n\nキャンセルは受付締切（' + computeAvailability_(ev, {}).deadline_at + '）までマイ予約から行えます。' + footer_());

  managerUsers_(ev).forEach((org) => {
    sendMail_(org.email, '【' + CONFIG.APP_NAME + '】新しい予約' + (pending ? '（承認待ち）' : '') + '：' + ev.title,
      org.name + ' 様\n\n新しい予約が入りました。\n\n' + eventInfoText_(ev) + '\n■ 代表者：' + r.applicant_name +
      '（' + r.guest_count + '名）\n■ 連絡先：' + r.applicant_phone + ' / ' + r.applicant_email +
      (r.note ? '\n■ 備考：' + r.note : '') + (pending ? '\n\nダッシュボードから承認/却下を行ってください。' : '') + footer_());
  });

  DB.reset();
  return {
    reservation: publicReservation_(r),
    event: publicEvent_(DB.find(SHEET.EVENTS, 'event_id', ev.event_id), reservationIndex_(), userNameMap_()),
  };
}

function apiMyReservations_(u, p) {
  const idx = reservationIndex_();
  const names = userNameMap_();
  const evMap = {};
  DB.all(SHEET.EVENTS).forEach((ev) => { evMap[ev.event_id] = ev; });
  const today = todayYmd_();
  const now = Date.now();

  let items = DB.all(SHEET.RESERVATIONS).filter((r) => r.user_id === u.user_id).map((r) => {
    const ev = evMap[r.event_id];
    const dl = ev ? eventDeadline_(ev) : null;
    return Object.assign(publicReservation_(r), {
      event: ev ? publicEvent_(ev, idx, names) : null,
      is_past: ev ? ev.event_date < today : true,
      can_cancel: !!(ev && (r.status === 'pending' || r.status === 'confirmed') && dl && now < dl.getTime()),
    });
  });
  if (!toBool_(p.include_past)) items = items.filter((x) => !x.is_past);
  items.sort((a, b) => {
    const ka = a.event ? a.event.event_date + a.event.start_time : '';
    const kb = b.event ? b.event.event_date + b.event.start_time : '';
    return ka.localeCompare(kb);
  });
  return { reservations: items };
}

function apiCancelReservation_(u, p) {
  const res = withLock_(() => {
    const r = DB.find(SHEET.RESERVATIONS, 'reservation_id', str_(p.reservation_id, 64));
    if (!r) throw new AppError('NOT_FOUND', '予約が見つかりません');
    if (r.user_id !== u.user_id) throw new AppError('FORBIDDEN', 'ご自身の予約のみキャンセルできます');
    if (r.status !== 'pending' && r.status !== 'confirmed') throw new AppError('VALIDATION', 'この予約はキャンセルできない状態です');
    const ev = DB.find(SHEET.EVENTS, 'event_id', r.event_id);
    const dl = ev ? eventDeadline_(ev) : null;
    if (!dl || Date.now() >= dl.getTime()) {
      throw new AppError('DEADLINE_PASSED', 'キャンセル期限を過ぎています。主催者へ直接ご連絡ください');
    }
    const m = DB.update(SHEET.RESERVATIONS, r, { status: 'cancelled', updated_at: nowStr_() });
    return { r: m, ev: ev };
  });
  managerUsers_(res.ev).forEach((org) => {
    sendMail_(org.email, '【' + CONFIG.APP_NAME + '】予約キャンセル：' + res.ev.title,
      org.name + ' 様\n\n以下の予約がキャンセルされました。\n\n' + eventInfoText_(res.ev) + '\n■ 代表者：' +
      res.r.applicant_name + '（' + res.r.guest_count + '名）' + footer_());
  });
  return { reservation: publicReservation_(res.r) };
}

// ---------------------------------------------------------------------
// 参加者名簿・承認・精算（主催者）
// ---------------------------------------------------------------------
function participantsOf_(ev, includeCancelled) {
  return DB.all(SHEET.RESERVATIONS)
    .filter((r) => r.event_id === ev.event_id && (includeCancelled || r.status === 'pending' || r.status === 'confirmed'))
    .sort((a, b) => String(a.applied_at).localeCompare(String(b.applied_at)));
}

function apiListParticipants_(u, p) {
  const ev = loadOwnedEvent_(u, p.event_id);
  const list = participantsOf_(ev, toBool_(p.include_cancelled));
  const totals = { confirmed_guests: 0, pending_guests: 0, unpaid_count: 0, paid_count: 0, expected_fee_total: 0, paid_fee_total: 0 };
  const fee = toInt_(ev.fee, 0);
  list.forEach((r) => {
    const g = toInt_(r.guest_count, 0);
    if (r.status === 'confirmed') {
      totals.confirmed_guests += g;
      totals.expected_fee_total += fee * g;
      if (r.payment_status === 'paid') { totals.paid_count++; totals.paid_fee_total += fee * g; } else totals.unpaid_count++;
    }
    if (r.status === 'pending') totals.pending_guests += g;
  });
  return {
    event: publicEvent_(ev, reservationIndex_(), userNameMap_()),
    participants: list.map(publicReservation_),
    totals: totals,
  };
}

function csvSafe_(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function toCsv_(rows) {
  return rows.map((r) => r.map((v) => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

function apiExportParticipantsCsv_(u, p) {
  const ev = loadOwnedEvent_(u, p.event_id);
  const fee = toInt_(ev.fee, 0);
  const rows = [['予約番号', '申込日時', '代表者名', '電話番号', 'メール', '参加人数', '予約状態', '精算状態', '参加費合計', '備考']];
  participantsOf_(ev, toBool_(p.include_cancelled)).forEach((r) => {
    rows.push([
      r.reservation_id, r.applied_at, csvSafe_(r.applicant_name), csvSafe_(r.applicant_phone), csvSafe_(r.applicant_email),
      toInt_(r.guest_count, 0), RESV_STATUS_LABEL[r.status] || r.status, PAY_STATUS_LABEL[r.payment_status] || r.payment_status,
      fee * toInt_(r.guest_count, 0), csvSafe_(r.note),
    ]);
  });
  const safeTitle = String(ev.title).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return {
    filename: 'participants_' + ev.event_date + '_' + safeTitle + '.csv',
    mime_type: 'text/csv;charset=utf-8',
    csv: '\uFEFF' + toCsv_(rows),
  };
}

function apiSetReservationStatus_(u, p) {
  const action = String(p.action || p.op || '');
  if (['approve', 'reject', 'cancel'].indexOf(action) === -1) throw new AppError('VALIDATION', '操作が不正です');
  const reason = str_(p.reason, 300);

  const res = withLock_(() => {
    const r = DB.find(SHEET.RESERVATIONS, 'reservation_id', str_(p.reservation_id, 64));
    if (!r) throw new AppError('NOT_FOUND', '予約が見つかりません');
    const ev = loadOwnedEvent_(u, r.event_id);
    let next;
    if (action === 'approve') {
      if (r.status !== 'pending') throw new AppError('VALIDATION', '承認待ちの予約のみ承認できます');
      const avail = computeAvailability_(ev, reservationIndex_());
      if (avail.confirmed + toInt_(r.guest_count, 0) > avail.capacity) {
        throw new AppError('CAPACITY', '定員を超えるため承認できません（確定済み ' + avail.confirmed + '/' + avail.capacity + '名）');
      }
      next = 'confirmed';
    } else if (action === 'reject') {
      if (r.status !== 'pending') throw new AppError('VALIDATION', '承認待ちの予約のみ却下できます');
      next = 'rejected';
    } else {
      if (r.status !== 'pending' && r.status !== 'confirmed') throw new AppError('VALIDATION', 'この予約は取消できない状態です');
      next = 'cancelled';
    }
    const patch = { status: next, updated_at: nowStr_() };
    if (reason) patch.note = str_((r.note ? r.note + ' / ' : '') + '[主催者] ' + reason, 500);
    return { r: DB.update(SHEET.RESERVATIONS, r, patch), ev: ev };
  });

  const msg = {
    confirmed: 'ご予約が承認され、確定しました。当日お待ちしております。',
    rejected: '誠に申し訳ございませんが、今回のお申込みはお受けできませんでした。',
    cancelled: '主催者によりご予約が取り消されました。',
  }[res.r.status];
  sendMail_(res.r.applicant_email, '【' + CONFIG.APP_NAME + '】予約状況のお知らせ（' + RESV_STATUS_LABEL[res.r.status] + '）',
    res.r.applicant_name + ' 様\n\n' + msg + (reason ? '\n主催者より：' + reason : '') + '\n\n' + eventInfoText_(res.ev) +
    '\n■ 参加人数：' + res.r.guest_count + '名\n■ 予約番号：' + res.r.reservation_id + footer_());
  return { reservation: publicReservation_(res.r) };
}

function apiSetPaymentStatus_(u, p) {
  const ps = String(p.payment_status || '');
  if (['unpaid', 'paid'].indexOf(ps) === -1) throw new AppError('VALIDATION', '精算ステータスが不正です');
  return withLock_(() => {
    const r = DB.find(SHEET.RESERVATIONS, 'reservation_id', str_(p.reservation_id, 64));
    if (!r) throw new AppError('NOT_FOUND', '予約が見つかりません');
    loadOwnedEvent_(u, r.event_id);
    return { reservation: publicReservation_(DB.update(SHEET.RESERVATIONS, r, { payment_status: ps, updated_at: nowStr_() })) };
  });
}

// ---------------------------------------------------------------------
// Gemini API
// ---------------------------------------------------------------------
const GEMINI_RETRY_CODES = [429, 500, 502, 503, 504];
const GEMINI_MAX_ATTEMPTS = 3;

function callGemini_(opt) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw new AppError('CONFIG', 'GEMINI_API_KEY が設定されていません（スクリプトプロパティを確認してください）');
  const primary = str_(prop_('GEMINI_MODEL', CONFIG.DEFAULT_GEMINI_MODEL), 100);
  const fallback = str_(prop_('GEMINI_FALLBACK_MODEL', ''), 100);
  const models = fallback && fallback !== primary ? [primary, fallback] : [primary];

  let lastErr = null;
  for (let i = 0; i < models.length; i++) {
    try {
      try {
        return callGeminiModel_(models[i], key, opt);
      } catch (pe) {
        // JSONが崩れていた場合は温度を下げて1回だけ再試行
        if (!(pe instanceof AppError) || pe.code !== 'AI_PARSE') throw pe;
        console.warn('Gemini JSON崩れ → 再試行');
        return callGeminiModel_(models[i], key, Object.assign({}, opt, { temperature: 0.3 }));
      }
    } catch (e) {
      lastErr = e;
      // 混雑・一時障害・モデル未提供のときだけ予備モデルへ切り替え
      if (!(e instanceof AppError) || ['AI_BUSY', 'AI_MODEL_NOT_FOUND'].indexOf(e.code) === -1) throw e;
      if (i < models.length - 1) console.warn('Gemini: ' + models[i] + ' が利用できないため ' + models[i + 1] + ' に切り替えます（' + e.message + '）');
    }
  }
  throw lastErr;
}

function callGeminiModel_(model, key, opt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const buildBody = (useSchema) => {
    const body = {
      contents: opt.contents,
      generationConfig: { temperature: opt.temperature === undefined ? 0.7 : opt.temperature, maxOutputTokens: 16384 },
    };
    if (opt.system) body.systemInstruction = { parts: [{ text: opt.system }] };
    if (opt.json) {
      body.generationConfig.responseMimeType = 'application/json';
      if (useSchema && opt.schema) body.generationConfig.responseSchema = opt.schema;
    }
    return body;
  };

  let useSchema = !!(opt.json && opt.schema);
  let res = null;
  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(buildBody(useSchema)), muteHttpExceptions: true,
    });
    const c = res.getResponseCode();
    if (c === 400 && useSchema) {
      // スキーマ指定を受け付けないモデル向けにスキーマなしで再試行
      console.warn('Gemini 400（スキーマ付き）→スキーマなしで再試行: ' + res.getContentText().slice(0, 300));
      useSchema = false;
      attempt--;
      continue;
    }
    if (GEMINI_RETRY_CODES.indexOf(c) === -1 || attempt === GEMINI_MAX_ATTEMPTS) break;
    const wait = 1500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500); // 約1.5秒→3秒
    console.warn('Gemini ' + c + '（' + model + '）: ' + wait + 'ms 待って再試行 ' + (attempt + 1) + '/' + GEMINI_MAX_ATTEMPTS);
    Utilities.sleep(wait);
  }

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) {
    console.error('Gemini error ' + code + ' (model=' + model + '): ' + text.slice(0, 1000));
    let apiMsg = '';
    try { apiMsg = (JSON.parse(text).error || {}).message || ''; } catch (_) { apiMsg = ''; }
    if (code === 503 || code === 500 || code === 502 || code === 504) {
      throw new AppError('AI_BUSY', 'AIサーバーが混雑しています（' + code + '）。1〜2分おいてからもう一度お試しください');
    }
    if (code === 429) throw new AppError('AI_BUSY', 'AIの利用上限に達したか混み合っています。少し時間をおいてお試しください');
    if (code === 404) throw new AppError('AI_MODEL_NOT_FOUND', 'モデル「' + model + '」が見つかりません。スクリプトプロパティ GEMINI_MODEL を確認してください');
    if (code === 400 && /api key/i.test(apiMsg)) throw new AppError('AI_ERROR', 'Gemini APIキーが無効です。GEMINI_API_KEY を確認してください');
    if (code === 403) throw new AppError('AI_ERROR', 'Gemini APIの利用が許可されていません（APIキーの権限・有効化を確認してください）');
    throw new AppError('AI_ERROR', 'AI呼び出しに失敗しました（' + code + '）' + (apiMsg ? '：' + apiMsg.slice(0, 200) : ''));
  }

  const data = JSON.parse(text);
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new AppError('AI_ERROR', '入力内容がAIの安全フィルタにより処理できませんでした。表現を変えてお試しください');
  }
  const cand = data.candidates && data.candidates[0];
  const out = cand && cand.content && cand.content.parts
    ? cand.content.parts.filter((x) => !x.thought).map((x) => x.text || '').join('') : '';
  const reason = cand && cand.finishReason ? cand.finishReason : '';
  if (!out) {
    if (reason === 'MAX_TOKENS') throw new AppError('AI_ERROR', 'AIの応答が長すぎて途中で止まりました。入力を短くしてもう一度お試しください');
    if (reason === 'SAFETY') throw new AppError('AI_ERROR', 'AIの安全フィルタにより回答できませんでした。表現を変えてお試しください');
    throw new AppError('AI_ERROR', 'AIから有効な応答が得られませんでした' + (reason ? '（' + reason + '）' : ''));
  }
  if (!opt.json) return out;
  const parsed = parseJsonLoose_(out);
  if (parsed) return parsed;
  console.error('Gemini JSON解析失敗 (model=' + model + ', finish=' + reason + '): ' + out.slice(0, 2000));
  throw new AppError('AI_PARSE', reason === 'MAX_TOKENS'
    ? 'AIの応答が長すぎて途中で止まりました。入力を短くしてもう一度お試しください'
    : 'AI応答の形式が崩れていました。もう一度お試しください');
}

/**
 * AIのJSON応答を寛容に解析する。失敗時は null。
 * よくある崩れ：コードフェンス付き／文字列中の生の改行・タブ／末尾カンマ／途中で切れた出力
 */
function parseJsonLoose_(raw) {
  const t = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  const candidates = [t];
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
  if (first >= 0) candidates.push(t.slice(first)); // 途中で切れた出力用
  for (let i = 0; i < candidates.length; i++) {
    try { return JSON.parse(candidates[i]); } catch (_) { /* next */ }
    try { return JSON.parse(repairJson_(candidates[i])); } catch (_) { /* next */ }
  }
  return null;
}

function repairJson_(src) {
  let out = '';
  let inStr = false;
  let escaped = false;
  const stack = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch.charCodeAt(0) < 0x20) continue;
      out += ch;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
    out += ch;
  }
  // 途中で切れていたら閉じる
  if (escaped) out = out.slice(0, -1);
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** 【手動実行用】Gemini接続テスト：モデル名・キー・応答を実行ログに表示 */
function checkGemini() {
  Logger.log('GEMINI_MODEL: ' + prop_('GEMINI_MODEL', '(未設定 → ' + CONFIG.DEFAULT_GEMINI_MODEL + ')'));
  Logger.log('GEMINI_API_KEY: ' + (prop_('GEMINI_API_KEY', '') ? '設定あり' : '未設定'));
  try {
    const r = callGemini_({
      json: true,
      schema: { type: 'OBJECT', properties: { message: { type: 'STRING' } }, required: ['message'] },
      contents: [{ role: 'user', parts: [{ text: '「接続テスト成功」と message に入れたJSONを返してください' }] }],
    });
    Logger.log('成功: ' + JSON.stringify(r));
  } catch (e) {
    Logger.log('失敗: ' + e.message);
  }
}

/** 主催者向け：チラシ・告知文生成 */
function apiGenerateFlyerText_(u, p) {
  rateLimit_('ai:' + u.user_id, CONFIG.AI_RATE_LIMIT, 600);
  const input = {
    イベント名: str_(p.title, 100),
    開催目的: str_(p.purpose, 500),
    ターゲット層: str_(p.target, 300),
    持ち物: str_(p.belongings, 300),
    日時: str_(p.datetime, 100),
    場所: str_(p.location, 200),
    参加費: str_(p.fee, 50),
    定員: str_(p.capacity, 20),
    雰囲気トーン: str_(p.tone, 100) || '親しみやすく前向き',
    補足メモ: str_(p.notes, 1500),
  };
  if (!input.イベント名 && !input.開催目的 && !input.補足メモ) {
    throw new AppError('VALIDATION', 'イベント名・目的・メモのいずれかを入力してください');
  }
  const lines = Object.keys(input).filter((k) => input[k]).map((k) => '- ' + k + '：' + input[k]).join('\n');
  const schema = {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      catchcopy: { type: 'STRING' },
      sub_catchcopy: { type: 'STRING' },
      description: { type: 'STRING' },
      short_announcement: { type: 'STRING' },
      category: { type: 'STRING' },
      hashtags: { type: 'ARRAY', items: { type: 'STRING' } },
      layout: {
        type: 'OBJECT',
        properties: {
          headline_area: { type: 'STRING' }, visual: { type: 'STRING' }, color_palette: { type: 'STRING' },
          typography: { type: 'STRING' }, info_block: { type: 'STRING' }, call_to_action: { type: 'STRING' },
        },
      },
    },
    required: ['title', 'catchcopy', 'description', 'short_announcement', 'layout'],
  };
  const system = [
    'あなたは地域イベントの広報を得意とするプロのコピーライター兼チラシデザイナーです。',
    '入力された情報だけをもとに、日本語で魅力的な告知素材を作成してください。入力にない日時・料金・場所などの事実は創作しないこと。',
    'title: 30字以内のイベント名（入力があれば尊重して整える）',
    'catchcopy: 20字前後の印象的なキャッチコピー / sub_catchcopy: 40字以内の補足コピー',
    'description: 400〜700字の詳細案内文（こんな方におすすめ・内容・当日の流れ・持ち物・参加費の支払いは当日現地等の当事者間精算である旨を含め、改行で読みやすく）',
    'short_announcement: SNS投稿用の120字以内の告知文',
    'category: 次から最も近いもの1つ：' + CONFIG.DEFAULT_CATEGORIES.join('、'),
    'hashtags: 3〜6個（#付き）',
    'layout: A4縦チラシのレイアウト指示（見出し配置・写真/イラストの方向性・配色・書体・情報ブロックの並び・行動喚起）',
  ].join('\n');
  const result = callGemini_({
    system: system, json: true, schema: schema, temperature: 0.8,
    contents: [{ role: 'user', parts: [{ text: '以下の情報で告知素材を作ってください。\n' + lines }] }],
  });
  return {
    result: result,
    form_fill: {
      title: str_(result.title, 100),
      description: str_((result.catchcopy ? '【' + result.catchcopy + '】\n' : '') + (result.description || ''), 5000),
      category: str_(result.category, 50),
    },
  };
}

/** 主催者向け：AIチラシ画像生成（プレビュー用。保存は uploadFlyer で行う） */
const FLYER_IMAGE_STYLES = {
  illust: '温かみのあるフラットなイラスト',
  photo: '自然光で撮影したような写真風（人物は後ろ姿や手元など顔が特定できない構図）',
  watercolor: 'やわらかい水彩画風',
  pop: 'カラフルでポップなグラフィックデザイン',
  simple: '余白を広く取ったシンプルでモダンなデザイン',
};
const FLYER_IMAGE_ASPECTS = ['3:4', '1:1', '4:3', '9:16', '16:9'];

function apiGenerateFlyerImage_(u, p) {
  const title = str_(p.title, 100);
  const category = str_(p.category, 50);
  const description = str_(p.description, 600);
  const location = str_(p.location, 100);
  const extra = str_(p.extra, 300);
  if (!title && !description && !extra) {
    throw new AppError('VALIDATION', 'イベント名・案内文・イメージの指示のいずれかを入力してください');
  }
  rateLimit_('aiimg:' + u.user_id, CONFIG.AI_IMAGE_RATE_LIMIT, 600);
  const style = FLYER_IMAGE_STYLES[p.style] || FLYER_IMAGE_STYLES.illust;
  const aspect = FLYER_IMAGE_ASPECTS.indexOf(p.aspect) >= 0 ? p.aspect : '3:4';
  // 日本語の文字は画像モデルで崩れやすいため、AIには文字なしで描かせ、文字はブラウザ側で正確なフォントで重ねる
  const textPos = p.text_position === 'bottom' ? 'bottom' : (p.text_position === 'none' ? 'none' : 'top');
  const spaceHint = {
    top: '画像の上部約3割は、後から文字を重ねるための空や壁などの落ち着いた余白にしてください（主要な被写体は中央〜下部に配置）。',
    bottom: '画像の下部約3割は、後から文字を重ねるための床や地面などの落ち着いた余白にしてください（主要な被写体は上部〜中央に配置）。',
    none: '',
  }[textPos];

  const prompt = [
    '地域のイベント告知チラシに使うメインビジュアル画像を1枚作成してください。',
    'イベント名：' + (title || '（未定）'),
    category ? 'カテゴリ：' + category : '',
    location ? '開催場所：' + location : '',
    description ? 'イベントの内容：' + description.replace(/\s+/g, ' ') : '',
    extra ? '追加のイメージ指示：' + extra : '',
    '画風：' + style,
    '雰囲気：明るく親しみやすく、幅広い年代が参加したくなる印象。',
    '縦横比：' + aspect,
    '重要：文字・数字・看板の文字・ロゴ・透かしは一切描かないでください。',
    spaceHint,
    '実在の人物・有名人・既存のキャラクターや商標は描かないでください。',
  ].filter(Boolean).join('\n');

  const img = geminiImage_(prompt, aspect);
  return { base64: 'data:' + img.mime + ';base64,' + img.data, mime_type: img.mime };
}

function geminiImage_(prompt, aspect) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw new AppError('CONFIG', 'GEMINI_API_KEY が設定されていません（スクリプトプロパティを確認してください）');
  const model = str_(prop_('GEMINI_IMAGE_MODEL', CONFIG.DEFAULT_GEMINI_IMAGE_MODEL), 100);
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  let useImageConfig = true;
  let res = null;
  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt++) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    };
    if (useImageConfig) body.generationConfig.imageConfig = { aspectRatio: aspect };
    res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true,
    });
    const c = res.getResponseCode();
    if (c === 400 && useImageConfig) {
      // 縦横比指定に未対応のモデル向けに指定なしで再試行
      console.warn('Gemini画像 400（imageConfig付き）→指定なしで再試行: ' + res.getContentText().slice(0, 300));
      useImageConfig = false;
      attempt--;
      continue;
    }
    if (GEMINI_RETRY_CODES.indexOf(c) === -1 || attempt === GEMINI_MAX_ATTEMPTS) break;
    Utilities.sleep(1500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500));
  }

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) {
    console.error('Gemini image error ' + code + ' (model=' + model + '): ' + text.slice(0, 1000));
    let apiMsg = '';
    try { apiMsg = (JSON.parse(text).error || {}).message || ''; } catch (_) { apiMsg = ''; }
    if ([500, 502, 503, 504].indexOf(code) >= 0) throw new AppError('AI_BUSY', 'AI画像サーバーが混雑しています（' + code + '）。1〜2分おいてからもう一度お試しください');
    if (code === 429) throw new AppError('AI_BUSY', 'AI画像生成の利用上限に達しました。時間をおいてお試しください（無料枠では画像生成が使えない場合があります）');
    if (code === 404) throw new AppError('AI_ERROR', '画像モデル「' + model + '」が見つかりません。スクリプトプロパティ GEMINI_IMAGE_MODEL を確認してください');
    if (code === 403) throw new AppError('AI_ERROR', 'Gemini APIの画像生成が許可されていません（APIキーの権限・課金設定を確認してください）');
    throw new AppError('AI_ERROR', 'AI画像生成に失敗しました（' + code + '）' + (apiMsg ? '：' + apiMsg.slice(0, 200) : ''));
  }

  const data = JSON.parse(text);
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    throw new AppError('AI_ERROR', '入力内容がAIの安全フィルタにより処理できませんでした。表現を変えてお試しください');
  }
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  for (let i = 0; i < parts.length; i++) {
    const inline = parts[i].inlineData || parts[i].inline_data;
    if (inline && inline.data) return { mime: inline.mimeType || inline.mime_type || 'image/png', data: inline.data };
  }
  const reason = cand && cand.finishReason ? cand.finishReason : '';
  throw new AppError('AI_ERROR', 'AIが画像を返しませんでした' + (reason ? '（' + reason + '）' : '') + '。指示を変えてもう一度お試しください');
}

/** 【手動実行用】画像生成の接続テスト */
function checkGeminiImage() {
  Logger.log('GEMINI_IMAGE_MODEL: ' + prop_('GEMINI_IMAGE_MODEL', '(未設定 → ' + CONFIG.DEFAULT_GEMINI_IMAGE_MODEL + ')'));
  try {
    const img = geminiImage_('青空と芝生の公園を描いた、文字のないシンプルなイラスト', '1:1');
    Logger.log('成功: ' + img.mime + ' / 約' + Math.round(img.data.length * 0.75 / 1024) + 'KB');
  } catch (e) {
    Logger.log('失敗: ' + e.message);
  }
}

/** 参加者向け：空き状況コンシェルジュ */
function apiConcierge_(u, p) {
  const message = str_(p.message, 500);
  if (!message) throw new AppError('VALIDATION', 'メッセージを入力してください');
  rateLimit_('ai:' + u.user_id, CONFIG.AI_RATE_LIMIT, 600);

  const today = todayYmd_();
  const max = maxEventYmd_();
  const idx = reservationIndex_();
  const names = userNameMap_();
  const evs = DB.all(SHEET.EVENTS)
    .filter((ev) => ev.status !== 'cancelled' && ev.event_date >= today && ev.event_date <= max)
    .sort(sortEvents_)
    .map((ev) => publicEvent_(ev, idx, names));
  const open = evs.filter((e) => e.availability.is_open);
  const closed = evs.filter((e) => !e.availability.is_open);
  const ctx = open.concat(closed).slice(0, CONFIG.CONCIERGE_MAX_EVENTS);
  const byId = {};
  ctx.forEach((e) => { byId[e.event_id] = e; });

  const list = ctx.map((e) => [
    e.event_id,
    e.event_date + '(' + e.weekday + ') ' + e.start_time + '-' + e.end_time,
    e.title,
    '分類:' + (e.category || '-'),
    '場所:' + e.location,
    '参加費:' + (e.fee > 0 ? yen_(e.fee) + '円/人' : '無料'),
    e.availability.mark + e.availability.label + ' 残' + e.availability.remaining + '/' + e.capacity + '名',
    e.is_approval_required ? '承認制' : '即時確定',
    '締切:' + e.availability.deadline_at,
    '概要:' + String(e.description || '').replace(/\s+/g, ' ').slice(0, 80),
  ].join(' | ')).join('\n');

  const system = [
    'あなたはイベント予約サイト「' + CONFIG.APP_NAME + '」の親切なコンシェルジュです。',
    '本日は ' + today + '（' + weekdayJa_(today) + '曜日）です。「今週末」「来週」などはこの日付を基準に解釈してください。',
    '必ず下記【イベント一覧】に存在するイベントだけを案内し、存在しないイベントや情報を創作してはいけません。',
    '空き状況は 〇=空きあり、△=残りわずか、✕=満席/受付終了 です。✕のイベントは予約できない旨を伝え、可能なら代わりの〇/△を提案してください。',
    '人数の指定がある場合は残席がその人数以上あるものを優先してください。',
    'おすすめは最大5件。各件に 日付・時刻・タイトル・空き記号・参加費 を簡潔に添えてください。該当なしの場合は条件を緩めた提案をしてください。',
    '回答は日本語で、やさしく簡潔に。',
    '出力は JSON：{"reply": 回答文, "event_ids": 案内したイベントIDの配列}',
    '',
    '【イベント一覧】（ID | 日時 | タイトル | 分類 | 場所 | 参加費 | 空き | 受付方式 | 締切 | 概要）',
    list || '（現在公開中のイベントはありません）',
  ].join('\n');

  const history = Array.isArray(p.history) ? p.history.slice(-10) : [];
  const contents = history
    .filter((h) => h && (h.role === 'user' || h.role === 'model' || h.role === 'assistant') && h.text)
    .map((h) => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: str_(h.text, 1000) }] }));
  contents.push({ role: 'user', parts: [{ text: message }] });

  const result = callGemini_({
    system: system, json: true, temperature: 0.4, contents: contents,
    schema: {
      type: 'OBJECT',
      properties: { reply: { type: 'STRING' }, event_ids: { type: 'ARRAY', items: { type: 'STRING' } } },
      required: ['reply'],
    },
  });
  const ids = (Array.isArray(result.event_ids) ? result.event_ids : []).filter((id) => byId[id]);
  return { reply: str_(result.reply, 3000), events: ids.slice(0, 5).map((id) => byId[id]) };
}

// ---------------------------------------------------------------------
// Google Drive（チラシ画像）
// ---------------------------------------------------------------------
function getFlyerFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DRIVE_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { console.warn('DRIVE_FOLDER_ID が無効です。新規作成します'); }
  }
  const folder = DriveApp.createFolder(CONFIG.DEFAULT_FOLDER_NAME);
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function apiUploadFlyer_(u, p) {
  let b64 = String(p.base64 || p.data || '');
  let mime = str_(p.mime_type, 50);
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(b64);
  if (m) { mime = mime || m[1]; b64 = m[2]; }
  if (CONFIG.FLYER_MIME_TYPES.indexOf(mime) === -1) throw new AppError('VALIDATION', '画像形式は JPEG / PNG / WebP / GIF のみ対応です');
  let bytes;
  try { bytes = Utilities.base64Decode(b64.replace(/\s/g, '')); } catch (_) { throw new AppError('VALIDATION', '画像データが不正です'); }
  if (!bytes.length) throw new AppError('VALIDATION', '画像データが空です');
  if (bytes.length > CONFIG.FLYER_MAX_BYTES) throw new AppError('VALIDATION', '画像サイズは5MB以下にしてください');

  // 先に対象イベントの権限を確認
  if (p.event_id) loadOwnedEvent_(u, p.event_id);

  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
  const name = 'flyer_' + u.user_id + '_' + fmt_(new Date(), 'yyyyMMdd_HHmmss') + '.' + ext;
  const file = getFlyerFolder_().createFile(Utilities.newBlob(bytes, mime, name));
  file.setDescription('ReserveHub flyer / uploaded by ' + u.user_id + (p.event_id ? ' / event ' + p.event_id : ''));
  let shared = true;
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    shared = false;
    console.warn('共有設定に失敗（組織ポリシーの可能性）: ' + e);
  }
  const fileId = file.getId();

  let updated = 0;
  if (p.event_id) {
    const oldIds = withLock_(() => {
      const ev = loadOwnedEvent_(u, p.event_id);
      const targets = toBool_(p.apply_to_group) && ev.recurring_group_id
        ? DB.all(SHEET.EVENTS).filter((x) => x.recurring_group_id === ev.recurring_group_id && x.status !== 'cancelled')
        : [ev];
      const olds = {};
      targets.forEach((x) => {
        if (x.flyer_drive_id && !/^https?:/.test(x.flyer_drive_id)) olds[x.flyer_drive_id] = true;
        DB.update(SHEET.EVENTS, x, { flyer_drive_id: fileId, updated_at: nowStr_() });
        updated++;
      });
      return Object.keys(olds);
    });
    // 他イベントから参照されていない旧画像はゴミ箱へ
    const stillUsed = {};
    DB.all(SHEET.EVENTS).forEach((x) => { stillUsed[x.flyer_drive_id] = true; });
    oldIds.forEach((id) => {
      if (id === fileId || stillUsed[id]) return;
      try { DriveApp.getFileById(id).setTrashed(true); } catch (_) { /* 権限なし等は無視 */ }
    });
  }
  return {
    file_id: fileId,
    url: flyerUrl_(fileId),
    view_url: 'https://drive.google.com/file/d/' + fileId + '/view',
    shared: shared,
    updated_events: updated,
  };
}

// ---------------------------------------------------------------------
// メール
// ---------------------------------------------------------------------
function sendMail_(to, subject, body) {
  if (!isEmail_(to)) return false;
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: body, name: CONFIG.APP_NAME });
    return true;
  } catch (e) {
    console.error('メール送信失敗 ' + to + ': ' + e);
    return false;
  }
}

function footer_() {
  const url = prop_('APP_URL', '');
  return '\n\n――――――――――――\n' + CONFIG.APP_NAME + (url ? '\n' + url : '') + '\n※本メールは送信専用です。';
}

function eventInfoText_(ev) {
  const fee = toInt_(ev.fee, 0);
  return '■ イベント：' + ev.title +
    '\n■ 日時：' + ev.event_date + '(' + weekdayJa_(ev.event_date) + ') ' + ev.start_time + '〜' + ev.end_time +
    '\n■ 場所：' + ev.location +
    '\n■ 参加費：' + (fee > 0 ? yen_(fee) + '円/人（当日現地または主催者指定の方法でお支払いください）' : '無料');
}

function sendTempPasswordMail_(email, name, tempPw, kind) {
  const head = {
    register: 'ご登録ありがとうございます。',
    admin_issue: '管理者によりアカウントが発行されました。',
    reset: '仮パスワードを再発行しました。',
  }[kind] || '';
  return sendMail_(email, '【' + CONFIG.APP_NAME + '】仮パスワードのお知らせ',
    (name || '') + ' 様\n\n' + head + '\n以下の仮パスワードでログインし、パスワードを変更してください。\n\n' +
    '■ ログインID（メールアドレス）：' + email + '\n■ 仮パスワード：' + tempPw +
    '\n\n※初回ログイン時にパスワードの変更が必要です。\n※お心当たりがない場合は本メールを破棄してください。' + footer_());
}
