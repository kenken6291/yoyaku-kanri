/**
 * ReserveHub フロントエンド設定（GitHub Pages）
 * GAS をデプロイしたら GAS_URL を「ウェブアプリURL（/exec）」に書き換えてください。
 */
window.APP_CONFIG = Object.freeze({
  APP_NAME: 'ReserveHub',
  GAS_URL: 'https://script.google.com/macros/s/AKfycbyHEXDFabdlHF0T9d4TkamZtJ-kx6w0aAyxgwXn4XnA3ndruwPXAtqrlwJUd8UOiApr/exec',
  REQUEST_TIMEOUT_MS: 60000,      // 通常の通信の待ち時間（60秒）
  AI_TIMEOUT_MS: 180000,          // AI生成・画像アップロードの待ち時間（3分）
  TOKEN_STORAGE_KEY: 'reservehub_token',
  USER_STORAGE_KEY: 'reservehub_user',
});
