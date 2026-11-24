/* Bean Diary - フロントエンド本体(Vanilla JS、ビルドステップなし)
   データはすべて端末内IndexedDB(DB名 beandiary)。サーバーは /api/identify・/api/recommend の中継のみ。 */

/* ══════════════════════════════════════════════
 * APIベースURL(ネイティブアプリ/Capacitor対応)
 * ネイティブアプリはCapacitorのwebDir設定で静的アセットをアプリバンドル内に
 * ローカル同梱している(server.urlを指定していないため)。そのためWebViewの
 * originは実サーバー(coffee.willoa.net)ではなくcapacitor://localhost相当の
 * ローカルオリジンになり、fetch('/api/...')のような相対パスは実サーバーでは
 * なくこのローカルオリジンに対して発行されてしまい、必ず失敗する
 * (sg-bus-navi/public/js/app.jsの_isCapacitorApp/API_BASEと同じ、2026-09-16
 * 実機で発見済みの既知バグパターン)。ネイティブアプリ内では本番オリジンを
 * 明示的に絶対URLとして先頭に付与する。
 * ══════════════════════════════════════════════ */
const _isCapacitorApp = Boolean(
  window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
);
const API_BASE = _isCapacitorApp ? 'https://coffee.willoa.net' : '';

/* ══════════════════════ タッチ対応ガード ══════════════════════
 * iOS WKWebView上でのタップ不具合(姉妹アプリで過去に発生)に備えたフック。
 * 現時点ではtouchend委譲は未実装のため常にfalse(=clickを常に許可)を返すだけの
 * プレースホルダー。Capacitor実機確認(ステップ6以降)で問題が再現した場合に、
 * ここへtouchend委譲ロジックを追加する。onclick側の呼び出し形は変更不要。 */
function _touchGuard() { return false; }

/* ══════════════════════ IndexedDB ══════════════════════ */
const DB_NAME = 'beandiary';
const DB_VERSION = 1;
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('beans')) {
        db.createObjectStore('beans', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('beanId', 'beanId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, obj) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(obj);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbClear(storeName) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function uuid() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/* ══════════════════════ アプリ状態 ══════════════════════ */
let beansCache = [];
let entriesCache = [];
let roastFilter = 'all';
let _lastMainTab = 'beans';
let _editingBeanId = null;
let _pendingPhotoDataUrl = null;
let _identifyApplied = false;
let _photoPickTarget = null;
let _daysQuickPhotos = [];
let _daysSelectedBeanId = null;

const ROAST_VALUES = ['浅煎り', '中浅煎り', '中煎り', '中深煎り', '深煎り'];
const PROCESS_VALUES = ['ウォッシュド', 'ナチュラル', 'ハニー', 'その他'];
const TASTE_KEYS = ['酸味', '苦味', '甘味', 'コク', '香り'];

// 5項目の味の評価をレーダーチャート(五角形)のSVGとして描画する。
// 1件も評価が入っていない場合は空文字を返す(呼び出し側で「情報なし」扱いにする)。
function tasteRadarSvg(taste, size) {
  const hasAny = TASTE_KEYS.some((k) => taste && taste[k] > 0);
  if (!hasAny) return '';
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * 0.32;
  const labelR = maxR + size * 0.14;
  const pt = (i, r) => {
    const angle = -Math.PI / 2 + i * (2 * Math.PI / 5);
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  };
  const grid = [1, 2, 3, 4, 5].map((g) => {
    const points = TASTE_KEYS.map((_, i) => pt(i, (maxR * g) / 5).join(',')).join(' ');
    return `<polygon points="${points}" fill="none" stroke="var(--sand)" stroke-width="1"/>`;
  }).join('');
  const axes = TASTE_KEYS.map((_, i) => {
    const [x, y] = pt(i, maxR);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--sand)" stroke-width="1"/>`;
  }).join('');
  const dataPoints = TASTE_KEYS.map((k, i) => pt(i, (maxR * (taste[k] || 0)) / 5));
  const dataPoly = `<polygon points="${dataPoints.map((p) => p.join(',')).join(' ')}" fill="rgba(164,82,31,0.3)" stroke="var(--caramel)" stroke-width="2"/>`;
  const dots = dataPoints.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="var(--caramel)"/>`).join('');
  const labels = TASTE_KEYS.map((k, i) => {
    const [x, y] = pt(i, labelR);
    return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="${Math.max(10, size * 0.08)}" fill="var(--text-muted)" font-weight="700">${k}</text>`;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${grid}${axes}${dataPoly}${dots}${labels}</svg>`;
}
const GRADIENTS = [
  ['#C98B5A', '#6B3B1F'], ['#8A5A3C', '#3B2418'], ['#D9A66E', '#9A5B2E'],
  ['#B9784A', '#5E331B'], ['#D9A66E', '#8A5230'],
];

function gradientFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

function beanThumbStyle(bean) {
  if (bean.photo) return `background-image:url(${bean.photo})`;
  const [a, b] = gradientFor(bean.id || 'x');
  return `background-image:linear-gradient(145deg,${a},${b})`;
}

function beanIconSvg(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><ellipse cx="24" cy="24" rx="12" ry="18" transform="rotate(35 24 24)" fill="#F6F0E8" fill-opacity="0.92"/><path d="M19 11c9 6-7 14 2 25" transform="rotate(35 24 24)" stroke="#8A5230" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>`;
}

/* ══════════════════════ 設定(localStorage) ══════════════════════ */
const SETTINGS_KEY = 'beandiary_settings';
const DEFAULT_SETTINGS = {
  autoFillEnabled: true,
  autoFillTaste: true,
  theme: 'auto',
  startupScreen: 'beans',
  lastUsedBeanId: null,
  preferenceAnalysis: null,
};
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) { /* 読み込み失敗時は既定値のまま */ }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applyTheme() {
  const html = document.documentElement;
  let effective = settings.theme;
  if (effective === 'auto') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  html.setAttribute('data-theme', effective);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (settings.theme === 'auto') applyTheme();
});

function toggleSetting(key) {
  settings[key] = !settings[key];
  saveSettings();
  renderSettingsScreen();
}
function cycleThemeSetting() {
  const order = ['auto', 'light', 'dark'];
  settings.theme = order[(order.indexOf(settings.theme) + 1) % order.length];
  saveSettings();
  applyTheme();
  renderSettingsScreen();
}
function cycleStartupScreen() {
  settings.startupScreen = settings.startupScreen === 'beans' ? 'days' : 'beans';
  saveSettings();
  renderSettingsScreen();
}

function renderSettingsScreen() {
  document.getElementById('toggle-autofill').classList.toggle('on', settings.autoFillEnabled);
  document.getElementById('toggle-autofill-taste').classList.toggle('on', settings.autoFillTaste);
  const themeLabel = { auto: '自動(端末に合わせる)', light: 'ライト', dark: 'ダーク' }[settings.theme];
  document.getElementById('settings-theme-value').textContent = themeLabel;
  document.getElementById('settings-startup-value').textContent = settings.startupScreen === 'beans' ? '豆' : '日々';
}

/* ══════════════════════ 画面遷移 ══════════════════════ */
const ALL_SCREENS = ['beans', 'days', 'wiki', 'preference', 'add', 'settings'];

// メインFABはどの主要タブ(豆/日々/豆知識)からでも共通。タップすると「豆を追加」
// 「ひとことを追加」を選べる小さなメニューがFABの真上に開く。
let _fabMenuOpen = false;
function toggleFabMenu() {
  if (_fabMenuOpen) closeFabMenu(); else openFabMenu();
}
function openFabMenu() {
  _fabMenuOpen = true;
  document.getElementById('fab-menu').classList.add('open');
  document.getElementById('main-fab').classList.add('menu-open');
  document.getElementById('fab-menu-backdrop').style.display = 'block';
}
function closeFabMenu() {
  _fabMenuOpen = false;
  document.getElementById('fab-menu').classList.remove('open');
  document.getElementById('main-fab').classList.remove('menu-open');
  document.getElementById('fab-menu-backdrop').style.display = 'none';
}
function fabAddBean() {
  closeFabMenu();
  openAddForm();
}
function fabAddEntry() {
  closeFabMenu();
  openQuickEntrySheetFromFab();
}

function showScreen(name) {
  closeFabMenu();
  ALL_SCREENS.forEach((s) => {
    document.getElementById('screen-' + s).classList.toggle('visible', s === name);
  });
  document.getElementById('bottom-nav').style.display = name === 'settings' ? 'none' : 'flex';
  const showFab = name === 'beans' || name === 'days' || name === 'wiki';
  document.getElementById('quick-entry-fab-layer').style.display = showFab ? 'block' : 'none';
  adjustScreenPadding(name);
}

// ヘッダーはposition:fixedで画面上部に固定しているため通常フローから外れる。
// その分だけ.screenのpadding-topを実測値で補う(ヘッダーの高さは画面ごと・
// 端末のノッチ有無で変わるため固定値では合わない)。
function adjustScreenPadding(name) {
  const screenEl = document.getElementById('screen-' + name);
  const headerEl = screenEl.querySelector('.screen-header');
  if (!headerEl) return;
  screenEl.style.paddingTop = headerEl.offsetHeight + 'px';
}

function updateNavActiveState(highlight) {
  document.getElementById('nav-beans').classList.toggle('active', highlight === 'beans');
  document.getElementById('nav-days').classList.toggle('active', highlight === 'days');
  document.getElementById('nav-wiki').classList.toggle('active', highlight === 'wiki');
  document.getElementById('nav-preference').classList.toggle('active', highlight === 'preference');
}

function switchNav(screen) {
  if (screen === 'beans' || screen === 'days' || screen === 'wiki' || screen === 'preference') {
    _lastMainTab = screen;
    showScreen(screen);
    window.scrollTo(0, 0);
    updateNavActiveState(screen);
    if (screen === 'beans') renderBeansList();
    if (screen === 'days') renderDaysList();
    if (screen === 'wiki') renderWikiAccordion();
    if (screen === 'preference') renderPreferenceScreen();
  } else {
    showScreen(screen);
  }
}

/* ══════════════════════ 豆知識(ウィキ、1ページ・2段アコーディオン) ══════════════════════ */
let _expandedWikiCategoryIds = new Set();
let _expandedWikiIds = new Set();

const WIKI_CATEGORY_ICONS = {
  origin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  variety: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14c0-5 4-10 11-10 1 7-3 11-8 11-2 0-3-.3-3-1z"/><path d="M6 14c3-1 6-3 8-6"/></svg>',
  process: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5s6 6.2 6 11a6 6 0 0 1-12 0c0-4.8 6-11 6-11z"/></svg>',
  roast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 17c1.4 0 2-1.5 1.3-2.7-.5-.9-.2-1.8.4-2.3 1 1 1.3 2.5 1.3 2.5 1.5-1.5 2-4-.5-6 .3 1.5-.5 2-1 1.5-.4-2-2-3-2-3 .2 1.5-.8 3.2-1.6 4.2-.8 1-1.4 2-1.4 3.3z"/></svg>',
  taste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16v11H10l-4 4v-4H4z"/></svg>',
  brew: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h14v5a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M7 2v2M10 2v2M13 2v2"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1.2 11a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 8z"/><path d="M8 8V5.5a4 4 0 0 1 8 0V8"/></svg>',
  equipment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16l-6.5 8.5V19l-3 1.5v-8z"/></svg>',
  brand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  glossary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5v-17z"/><path d="M4 17h16"/></svg>',
};

function renderWikiAccordion() {
  const container = document.getElementById('wiki-grid');
  container.innerHTML = WIKI_CATEGORIES.map((cat) => {
    const open = _expandedWikiCategoryIds.has(cat.id);
    return `
      <div class="wiki-cat-card">
        <button class="wiki-cat-head" onclick="toggleWikiCategoryExpand('${cat.id}')">
          <span class="icon">${WIKI_CATEGORY_ICONS[cat.id] || ''}</span>
          <span class="label">${cat.label}</span>
          <span class="count">${cat.items.length}件</span>
          <svg class="chevron${open ? ' open' : ''}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        ${open ? `<div class="wiki-item-list">${wikiItemRowsHtml(cat.items)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function wikiItemRowsHtml(items) {
  return items.map((item) => {
    const open = _expandedWikiIds.has(item.id);
    return `
      <div class="wiki-item-row">
        <div class="wiki-item-top" onclick="toggleWikiItemExpand('${item.id}')">
          <span class="wiki-item-title">${item.title}</span>
          <svg class="chevron${open ? ' open' : ''}" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        ${open ? `<div class="wiki-item-body">${item.body}</div>` : ''}
      </div>
    `;
  }).join('');
}

function toggleWikiCategoryExpand(categoryId) {
  if (_expandedWikiCategoryIds.has(categoryId)) _expandedWikiCategoryIds.delete(categoryId);
  else _expandedWikiCategoryIds.add(categoryId);
  renderWikiAccordion();
}

function toggleWikiItemExpand(itemId) {
  if (_expandedWikiIds.has(itemId)) _expandedWikiIds.delete(itemId);
  else _expandedWikiIds.add(itemId);
  renderWikiAccordion();
}

/* ══════════════════════ 好み(記録サマリー + AI傾向分析) ══════════════════════
 * 記録サマリーはAI不要・端末内IndexedDBの集計のみ(即時表示)。
 * AI傾向分析は★評価付きの記録が5件以上の場合のみ有効化し、ユーザーが明示的に
 * 「分析する」ボタンを押したときだけ /api/recommend を呼ぶ(自動実行しない、設計書1参照)。
 * 分析結果は settings.preferenceAnalysis に保存し、次回タブを開いたときに再表示する。 */
const PREFERENCE_MIN_RATED_ENTRIES = 5;
let _preferenceAnalyzing = false;

// 記録した豆の種類数・日々の記録総数・★評価付き件数・記録開始からの日数を集計する。
function computePreferenceSummary() {
  const ratedCount = entriesCache.filter((e) => e.rating > 0).length;
  const createdDates = [
    ...beansCache.map((b) => b.createdAt),
    ...entriesCache.map((e) => e.createdAt),
  ].filter(Boolean).map((d) => new Date(d).getTime()).filter((t) => !isNaN(t));
  let days = 0;
  if (createdDates.length > 0) {
    const earliest = Math.min(...createdDates);
    days = Math.max(0, Math.floor((Date.now() - earliest) / (24 * 60 * 60 * 1000)));
  }
  return {
    beanCount: beansCache.length,
    entryCount: entriesCache.length,
    ratedCount,
    days,
  };
}

// ★評価付きのentriesのみを取り、紐づくbeanのorigin/roast/processと結合した軽量配列を返す。
// text/photo/name/shopは送らない(プライバシー方針、設計書1参照)。
function ratedEntriesForRecommend() {
  return entriesCache
    .filter((e) => e.rating > 0)
    .map((e) => {
      const bean = beansCache.find((b) => b.id === e.beanId);
      return {
        origin: (bean && bean.origin) || '',
        roast: (bean && bean.roast) || '',
        process: (bean && bean.process) || '',
        brew: e.brew || '',
        rating: e.rating,
      };
    });
}

function preferenceSummaryHtml() {
  const s = computePreferenceSummary();
  return `
    <div class="preference-summary-section">
      <div class="preference-section-title">記録サマリー</div>
      <div class="preference-summary-grid">
        <div class="preference-summary-card">
          <div class="value">${s.beanCount}</div>
          <div class="label">種類の豆</div>
        </div>
        <div class="preference-summary-card">
          <div class="value">${s.entryCount}</div>
          <div class="label">日々の記録</div>
        </div>
        <div class="preference-summary-card">
          <div class="value">${s.ratedCount}</div>
          <div class="label">★評価付きの記録</div>
        </div>
        <div class="preference-summary-card">
          <div class="value">${s.days}</div>
          <div class="label">日、記録を継続中</div>
        </div>
      </div>
    </div>
  `;
}

function preferenceRecommendationCardHtml(rec) {
  return `
    <div class="preference-reco-card">
      <div class="preference-reco-title">${escapeHtml(rec.title || '')}</div>
      <div class="preference-reco-tags">
        ${rec.origin ? `<span class="chip">${escapeHtml(rec.origin)}</span>` : ''}
        ${rec.roast ? `<span class="chip">${escapeHtml(rec.roast)}</span>` : ''}
        ${rec.process ? `<span class="chip">${escapeHtml(rec.process)}</span>` : ''}
      </div>
      <div class="preference-reco-reason">${escapeHtml(rec.reason || '')}</div>
    </div>
  `;
}

function renderPreferenceScreen() {
  const container = document.getElementById('preference-content');
  const rated = ratedEntriesForRecommend();
  const ratedCount = rated.length;
  const analysis = settings.preferenceAnalysis;

  let analysisSectionHtml = '';
  if (ratedCount < PREFERENCE_MIN_RATED_ENTRIES) {
    const remaining = PREFERENCE_MIN_RATED_ENTRIES - ratedCount;
    analysisSectionHtml = `
      <div class="preference-section-title">AI傾向分析・おすすめ</div>
      <div class="empty-state">
        <div class="empty-title">もう少し記録をためましょう</div>
        <div class="empty-desc">あと${remaining}件、★付きの記録をためると<br>AIによる傾向分析が使えます</div>
      </div>
    `;
  } else {
    const hasNew = analysis && ratedCount > analysis.basedOnCount;
    const analyzeLabel = !analysis ? '分析する' : (hasNew ? '更新する' : '再分析する');
    const analyzingHtml = _preferenceAnalyzing
      ? `<div class="preference-analysis-loading">分析しています…(10〜30秒程度)</div>`
      : '';
    analysisSectionHtml = `
      <div class="preference-section-title">AI傾向分析・おすすめ</div>
      <div class="preference-privacy-note">分析のため、記録の傾向(産地・焙煎度など)を外部のAIサービスに送信します。</div>
      ${analysis ? `
        ${hasNew ? `<div class="preference-update-badge">${ratedCount - analysis.basedOnCount}件の新しい記録があります</div>` : ''}
        <div class="preference-analysis-card">
          <div class="preference-analysis-summary">${escapeHtml(analysis.summary || '')}</div>
        </div>
        <div class="preference-reco-list">
          ${(analysis.recommendations || []).map(preferenceRecommendationCardHtml).join('')}
        </div>
      ` : ''}
      ${analyzingHtml}
      <button class="preference-analyze-btn${hasNew ? ' highlight' : ''}" ${_preferenceAnalyzing ? 'disabled' : ''} onclick="if(!_touchGuard()) runPreferenceAnalysis()">${analyzeLabel}</button>
    `;
  }

  container.innerHTML = preferenceSummaryHtml() + `<div class="preference-analysis-section">${analysisSectionHtml}</div>`;
}

async function runPreferenceAnalysis() {
  if (_preferenceAnalyzing) return;
  const rated = ratedEntriesForRecommend();
  if (rated.length < PREFERENCE_MIN_RATED_ENTRIES) return;

  _preferenceAnalyzing = true;
  renderPreferenceScreen();

  try {
    const res = await fetch(API_BASE + '/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: rated }),
    });
    if (!res.ok) throw new Error('recommend failed');
    const data = await res.json();
    settings.preferenceAnalysis = {
      summary: data.summary || '',
      recommendations: data.recommendations || [],
      analyzedAt: new Date().toISOString(),
      basedOnCount: rated.length,
    };
    saveSettings();
  } catch (_) {
    showToast('分析に失敗しました。しばらくしてからお試しください');
  } finally {
    _preferenceAnalyzing = false;
    renderPreferenceScreen();
  }
}

function openSettings() {
  showScreen('settings');
  renderSettingsScreen();
  document.getElementById('settings-version').textContent = '読み込み中…';
  fetch(API_BASE + '/api/version').then((r) => r.json()).then((d) => {
    document.getElementById('settings-version').textContent = d.version || '-';
  }).catch(() => {
    document.getElementById('settings-version').textContent = '-';
  });
}

/* ══════════════════════ トースト・確認ダイアログ ══════════════════════ */
function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('visible'), 2200);
}

function showConfirm(message, { danger = false, okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    const okBtn = document.getElementById('confirm-ok-btn');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    document.getElementById('confirm-message').textContent = message;
    okBtn.textContent = okLabel;
    okBtn.classList.toggle('danger', danger);
    overlay.classList.add('visible');

    function cleanup(result) {
      overlay.classList.remove('visible');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

/* ══════════════════════ 画像縮小(Canvas、長辺900px・JPEG0.8) ══════════════════════ */
function resizeImageElement(img) {
  const maxEdge = 900;
  let { width, height } = img;
  if (width > maxEdge || height > maxEdge) {
    if (width >= height) {
      height = Math.round((height * maxEdge) / width);
      width = maxEdge;
    } else {
      width = Math.round((width * maxEdge) / height);
      height = maxEdge;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

function resizeDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('image load failed'));
    img.onload = () => resolve(resizeImageElement(img));
    img.src = dataUrl;
  });
}

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resizeDataUrl(reader.result).then(resolve, reject);
    reader.readAsDataURL(file);
  });
}

function applyPickedPhoto(target, dataUrl) {
  if (target === 'add') {
    _pendingPhotoDataUrl = dataUrl;
    _identifyApplied = false;
    const preview = document.getElementById('add-photo-preview');
    preview.style.backgroundImage = `url(${dataUrl})`;
    preview.querySelector('svg').style.display = 'none';
    preview.querySelector('.cam-fab').style.display = 'grid';
    if (settings.autoFillEnabled) {
      document.getElementById('identify-trigger').style.display = 'block';
    }
  } else if (target === 'days') {
    if (_daysQuickPhotos.length >= MAX_QUICK_ENTRY_PHOTOS) { showToast(`写真は${MAX_QUICK_ENTRY_PHOTOS}枚まで添付できます`); return; }
    _daysQuickPhotos.push(dataUrl);
    renderQuickEntryPhotos();
    showToast('写真を添付しました');
  }
}

const MAX_QUICK_ENTRY_PHOTOS = 3;

function renderQuickEntryPhotos() {
  const wrap = document.getElementById('quick-entry-photos');
  const addSlot = _daysQuickPhotos.length < MAX_QUICK_ENTRY_PHOTOS ? `
    <button class="photo-add-slot" aria-label="写真を追加" onclick="if(!_touchGuard()) pickPhoto('days')">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
    </button>` : '';
  wrap.innerHTML = _daysQuickPhotos.map((url, i) => `
    <div class="photo-thumb-multi" style="background-image:url(${url})">
      <button class="photo-thumb-remove" aria-label="写真を削除" onclick="removeQuickEntryPhoto(${i}, event)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>
      </button>
    </div>
  `).join('') + addSlot;
}

function removeQuickEntryPhoto(index, event) {
  event.stopPropagation();
  _daysQuickPhotos.splice(index, 1);
  renderQuickEntryPhotos();
}

// ひとことの入力欄(今日の一言シート・編集シート共用)は内容に合わせて自然に伸びる
function autoGrowTextarea(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

/* ══════════════════════ 音声入力(Web Speech API) ══════════════════════
 * SafariはこのAPIに未対応(iOSのWKWebView/Capacitorアプリも同様)。その場合は
 * 対応していない旨をトーストで伝えるだけにとどめ、他の機能には影響させない。
 * ネイティブアプリで確実に使えるようにするには、別途ネイティブの音声認識
 * プラグイン(例: @capacitor-community/speech-recognition)の導入が必要。 */
let _voiceRecognition = null;
let _voiceListening = false;

function toggleVoiceInput() {
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    showToast('この端末・ブラウザは音声入力に対応していません');
    return;
  }
  if (_voiceListening) {
    _voiceRecognition && _voiceRecognition.stop();
    return;
  }
  const btn = document.getElementById('quick-entry-voice-btn');
  const recognition = new SpeechRecognitionCtor();
  recognition.lang = 'ja-JP';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    _voiceListening = true;
    btn.classList.add('recording');
  };
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript.trim();
    if (!transcript) return;
    const input = document.getElementById('quick-entry-text');
    input.value = input.value ? `${input.value} ${transcript}` : transcript;
  };
  recognition.onerror = () => {
    showToast('音声入力を認識できませんでした');
  };
  recognition.onend = () => {
    _voiceListening = false;
    btn.classList.remove('recording');
    _voiceRecognition = null;
  };
  _voiceRecognition = recognition;
  recognition.start();
}

// ネイティブアプリ(Capacitor)では@capacitor/camera(ios-app/package.jsonで導入済み)を使う。
// バンドラーを使わない構成のため、ESモジュールimportではなくグローバルのCapacitor.Pluginsから
// 取得する(姉妹アプリ共通の規約)。CameraSource.Promptは「カメラで撮る/フォトライブラリから選ぶ」の
// 2択のみを表示し(Web版のinput要素で出る「ファイルを選択」に相当する項目は出ない)。
// Web版(Capacitor非搭載)では従来通りinput要素のクリックにフォールバックする。
async function pickPhoto(target) {
  _photoPickTarget = target;
  const Camera = window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.Camera;
  if (!Camera) {
    // ネイティブアプリなのにCameraプラグインが取得できない異常系を切り分けるための
    // 診断トースト(「タップしても起動しない」report, 2026-11-24)。Web版では常にこの
    // 分岐を通る(正常)ため_isCapacitorAppの時だけ表示する。
    if (_isCapacitorApp) showToast('カメラ機能を初期化できませんでした');
    document.getElementById('photo-input').click();
    return;
  }
  try {
    const photo = await Camera.getPhoto({
      source: 'PROMPT',
      resultType: 'dataUrl',
      quality: 90,
      correctOrientation: true,
    });
    const resized = await resizeDataUrl(photo.dataUrl);
    applyPickedPhoto(target, resized);
  } catch (err) {
    // ユーザーがキャンセルした場合もここに来るため、キャンセル以外のみ表示する。
    // 「タップしても起動しない」report (2026-11-24) の原因切り分け用。
    if (err && err.message && !/cancel/i.test(err.message)) {
      showToast('カメラを起動できませんでした: ' + err.message);
    }
  }
}

document.getElementById('photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let dataUrl;
  try {
    dataUrl = await resizeImageFile(file);
  } catch (_) {
    showToast('写真の読み込みに失敗しました');
    return;
  }
  applyPickedPhoto(_photoPickTarget, dataUrl);
});

/* ══════════════════════ 豆一覧 ══════════════════════ */
function renderRoastFilterChips() {
  const row = document.getElementById('roast-filter-row');
  const options = [['all', 'すべて'], ...ROAST_VALUES.map((r) => [r, r])];
  row.innerHTML = options.map(([value, label]) =>
    `<button class="chip${roastFilter === value ? ' active' : ''}" data-roast="${value}">${label}</button>`
  ).join('');
  row.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      roastFilter = btn.dataset.roast;
      renderRoastFilterChips();
      renderBeansList();
    });
  });
}

function starsHtml(rating, size = 15) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const filled = i <= Math.round(rating || 0);
    html += `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? '#A4521F' : 'none'}" stroke="#A4521F" stroke-width="1.8" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2 6.3 20.3l1.2-6.4L2.8 9.5l6.4-.8z"/></svg>`;
  }
  return html;
}

// 豆の★は手入力せず、ひとことごとの★評価(任意)の単純平均から出す
function computeBeanRating(beanId) {
  const rated = entriesCache.filter((e) => e.beanId === beanId && e.rating > 0);
  if (!rated.length) return 0;
  return rated.reduce((sum, e) => sum + e.rating, 0) / rated.length;
}

let _expandedBeanIds = new Set();

function toggleBeanCardExpand(beanId, event) {
  event.stopPropagation();
  if (_expandedBeanIds.has(beanId)) {
    _expandedBeanIds.delete(beanId);
    _expandedTimelineIds.delete(beanId);
  } else {
    _expandedBeanIds.add(beanId);
  }
  renderBeansList();
}

async function toggleBeanInUse(beanId, event) {
  event.stopPropagation();
  const bean = beansCache.find((b) => b.id === beanId);
  if (!bean) return;
  bean.inUse = bean.inUse === false;
  await dbPut('beans', bean);
  renderBeansList();
}

function beanCardHtml(bean) {
  const meta = [bean.origin, bean.roast, bean.process].filter(Boolean).join(' ・ ');
  const expanded = _expandedBeanIds.has(bean.id);
  const tasteRadar = tasteRadarSvg(bean.taste, 170);
  const factRows = [];
  if (bean.origin) factRows.push(['産地', bean.origin]);
  if (bean.roast) factRows.push(['焙煎度', bean.roast]);
  if (bean.process) factRows.push(['精製方法', bean.process]);
  if (bean.purchaseDate) factRows.push(['購入日', bean.purchaseDate.slice(5).replace('-', '/')]);
  if (bean.brew) factRows.push(['淹れ方', bean.brew]);
  const latestEntry = entriesCache
    .filter((e) => e.beanId === bean.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const avgRating = computeBeanRating(bean.id);

  return `
    <div class="bean-card" role="button" data-bean-id="${bean.id}" onclick="handleBeanCardTap('${bean.id}', event)">
      <div class="bean-card-row">
        <div class="bean-thumb" style="${beanThumbStyle(bean)}">${bean.photo ? '' : beanIconSvg(36)}</div>
        <div class="bean-card-body">
          <div class="bean-card-top-row">
            <div class="bean-card-name">${escapeHtml(bean.name)}</div>
            <button class="bean-card-toggle" aria-label="詳細を開閉" onclick="toggleBeanCardExpand('${bean.id}', event)">
              <svg class="chevron${expanded ? ' open' : ''}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7A6455" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
            </button>
          </div>
          <div class="bean-card-meta">${escapeHtml(meta)}</div>
          <div class="bean-card-shop">${escapeHtml(bean.shop || '')}</div>
          <div class="star-row">${starsHtml(avgRating)}${avgRating > 0 ? `<span class="rating-value">${avgRating.toFixed(1)}</span>` : ''}</div>
          ${(!expanded && latestEntry) ? `<div class="bean-card-latest-entry">${escapeHtml(latestEntry.text ? `"${latestEntry.text}"` : '(写真)')}</div>` : ''}
        </div>
      </div>
      ${expanded ? `
      <div class="bean-card-expand" onclick="event.stopPropagation()">
        <div class="bean-card-expand-toggle">
          <span class="label">今日のひとことで選べる</span>
          <button class="toggle-switch${bean.inUse !== false ? ' on' : ''}" onclick="toggleBeanInUse('${bean.id}', event)"><span class="knob"></span></button>
        </div>
        ${(tasteRadar || factRows.length) ? `
        <div class="taste-radar-row">
          ${factRows.length ? `<div class="taste-fact-list">${factRows.map(([k, v]) => `<div class="fact-row"><span class="fact-k">${k}</span><span class="fact-v">${escapeHtml(v)}</span></div>`).join('')}</div>` : ''}
          ${tasteRadar ? `<div class="taste-radar-wrap">${tasteRadar}</div>` : ''}
        </div>` : ''}
        ${bean.flavorNotes ? `<div class="bean-card-expand-notes">${escapeHtml(bean.flavorNotes)}</div>` : ''}
        ${(!tasteRadar && !factRows.length && !bean.flavorNotes) ? '<div class="bean-card-expand-row" style="color:var(--text-muted)">詳細情報はまだありません</div>' : ''}
        ${beanTimelineHtml(bean.id)}
      </div>` : ''}
    </div>`;
}

// 既存データ(orderフィールド無し)の一括移行。1件でも無ければ、従来の並び(新しい順)を
// そのままorder値として確定させる(移行後は見た目が変わらないようにするため)。
async function ensureBeanOrder() {
  if (beansCache.length && beansCache.every((b) => typeof b.order === 'number')) return;
  const sorted = beansCache.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await Promise.all(sorted.map((bean, i) => {
    bean.order = i;
    return dbPut('beans', bean);
  }));
}

function renderBeansList() {
  let list = beansCache.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (roastFilter !== 'all') list = list.filter((b) => b.roast === roastFilter);
  document.getElementById('beans-count').textContent = `${beansCache.length} 種類の豆`;
  document.getElementById('beans-empty').style.display = beansCache.length === 0 ? 'block' : 'none';

  const container = document.getElementById('beans-list');
  container.innerHTML = list.map(beanCardHtml).join('');
  wireBeanReorder(container);
  wireLongPress(container.querySelectorAll('.timeline-row'), (el) => openEntryActions(el.dataset.entryId));
}

/* 豆カードの長押しは、押し続けて550ms経過した時点で既存どおり操作シート(編集/削除)を
   開く(wireLongPressと同じタイミング)。これはtouchend後に開くと、同じタッチから
   合成されるclickイベントがその瞬間に表示されたオーバーレイの背景(バックドロップ)に
   命中して即座に閉じてしまう不具合があったため(実機確認前にこのテストで発見)。
   そのシートが開いた状態のまま指を動かした場合のみシートを閉じて並び替えに切り替える。
   絞り込みチップ使用中(roastFilter!=='all')は表示順と保存順が一致しないため
   並び替えを無効化し、長押しは操作シートのみ有効にする。 */
function wireBeanReorder(container) {
  const getCards = () => Array.from(container.querySelectorAll('.bean-card'));

  getCards().forEach((el) => {
    let timer = null;
    let sheetOpen = false;
    let dragging = false;
    let startX = 0, startY = 0;

    const clearTimer = () => { clearTimeout(timer); timer = null; };

    const onDocMove = (e) => {
      if (!sheetOpen && !dragging) return;
      const t = e.touches ? e.touches[0] : e;
      if (roastFilter !== 'all') return;
      if (!dragging) {
        if (Math.abs(t.clientY - startY) < 10) return;
        dragging = true;
        sheetOpen = false;
        closeBeanActions();
        el.classList.remove('drag-ready');
        el.classList.add('dragging');
      }
      if (e.cancelable) e.preventDefault();
      for (const sib of getCards()) {
        if (sib === el) continue;
        const rect = sib.getBoundingClientRect();
        if (t.clientY > rect.top && t.clientY < rect.bottom) {
          if (t.clientY < rect.top + rect.height / 2) sib.parentNode.insertBefore(el, sib);
          else sib.parentNode.insertBefore(el, sib.nextSibling);
          break;
        }
      }
    };

    const onDocEnd = () => {
      clearTimer();
      document.removeEventListener('touchmove', onDocMove);
      document.removeEventListener('touchend', onDocEnd);
      document.removeEventListener('touchcancel', onDocEnd);
      document.removeEventListener('mousemove', onDocMove);
      document.removeEventListener('mouseup', onDocEnd);
      if (dragging) {
        dragging = false;
        el.classList.remove('dragging');
        el.dataset.longpressFired = '1';
        commitBeanOrder(container);
      }
      sheetOpen = false;
    };

    const begin = (x, y) => {
      startX = x; startY = y;
      timer = setTimeout(() => {
        sheetOpen = true;
        el.classList.add('drag-ready');
        el.dataset.longpressFired = '1';
        openBeanActions(el.dataset.beanId);
      }, 550);
    };

    el.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      const t = e.touches[0];
      begin(t.clientX, t.clientY);
      document.addEventListener('touchmove', onDocMove, { passive: false });
      document.addEventListener('touchend', onDocEnd);
      document.addEventListener('touchcancel', onDocEnd);
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (sheetOpen || dragging) return;
      const t = e.touches[0];
      if (Math.abs(t.clientY - startY) > 10 || Math.abs(t.clientX - startX) > 10) clearTimer();
    }, { passive: true });

    // デスクトップ確認用(マウス)。実機はタッチのみ使用。
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      begin(e.clientX, e.clientY);
      document.addEventListener('mousemove', onDocMove);
      document.addEventListener('mouseup', onDocEnd);
    });
  });
}

function commitBeanOrder(container) {
  const ids = Array.from(container.querySelectorAll('.bean-card')).map((el) => el.dataset.beanId);
  const changed = [];
  ids.forEach((id, i) => {
    const bean = beansCache.find((b) => b.id === id);
    if (bean && bean.order !== i) { bean.order = i; changed.push(bean); }
  });
  Promise.all(changed.map((bean) => dbPut('beans', bean)));
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function handleBeanCardTap(beanId, event) {
  const el = event.currentTarget;
  if (el.dataset.longpressFired) { delete el.dataset.longpressFired; return; }
  toggleBeanCardExpand(beanId, event);
}

let _actionBeanId = null;

function openBeanActions(beanId) {
  _actionBeanId = beanId;
  document.getElementById('bean-actions-overlay').classList.add('visible');
}
function closeBeanActions() {
  document.getElementById('bean-actions-overlay').classList.remove('visible');
}
function editBeanFromSheet() {
  const beanId = _actionBeanId;
  closeBeanActions();
  openAddForm(beanId);
}

function formatTime(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function formatDayLabel(d) {
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, now)) return '今日';
  if (isSameDay(d, yesterday)) return '昨日';
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${weekday})`;
}

// 旧データはentry.photo(単数)のみ持つ場合があるため、表示側で両対応する
function entryPhotos(entry) {
  if (entry.photos && entry.photos.length) return entry.photos;
  if (entry.photo) return [entry.photo];
  return [];
}

const TIMELINE_PAGE_SIZE = 3;
let _expandedTimelineIds = new Set();

function beanTimelineHtml(beanId) {
  const entries = entriesCache.filter((e) => e.beanId === beanId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const showAll = _expandedTimelineIds.has(beanId);
  const visibleEntries = showAll ? entries : entries.slice(0, TIMELINE_PAGE_SIZE);
  const rows = visibleEntries.map((entry, i) => {
    const d = new Date(entry.createdAt);
    const timeLabel = `${formatDayLabel(d)} ${formatTime(d)}`;
    const photos = entryPhotos(entry);
    return `
      <div class="timeline-row" data-entry-id="${entry.id}">
        <div class="timeline-dot${i === 0 ? ' latest' : ''}"></div>
        <div class="timeline-body">
          <div class="timeline-text">
            <div class="timeline-time">${timeLabel}</div>
            ${entry.rating ? `<div class="timeline-rating">${starsHtml(entry.rating, 12)}</div>` : ''}
            <div class="timeline-entry-text">${escapeHtml(entry.text || '')}</div>
            ${entry.brew ? `<div class="timeline-brew">${escapeHtml(entry.brew)}</div>` : ''}
            ${photos.length ? `<div class="timeline-photos">${photos.map((p) => `<div class="timeline-thumb" style="background-image:url(${p})"></div>`).join('')}</div>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
  const remaining = entries.length - visibleEntries.length;
  const moreBtn = remaining > 0
    ? `<button class="timeline-more-btn" onclick="toggleTimelineExpand('${beanId}', event)">すべて見る(残り${remaining}件)</button>`
    : '';
  return `
    <div class="bean-card-expand-divider"></div>
    <div class="detail-entries-heading">
      <h2>この豆の日々</h2>
      <span class="header-sub">${entries.length} 件</span>
    </div>
    <div class="timeline">
      ${rows || '<div class="bean-card-expand-row" style="color:var(--text-muted)">まだ記録がありません</div>'}
    </div>
    ${moreBtn}`;
}

function toggleTimelineExpand(beanId, event) {
  event.stopPropagation();
  _expandedTimelineIds.add(beanId);
  renderBeansList();
}

/* ══════════════════════ 日々タブ ══════════════════════ */
// 「使用中」の豆のみ(日々の入力欄・豆選択シートで選べる対象)。新しい順。
function activeBeans() {
  return beansCache.filter((b) => b.inUse !== false).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function updateQuickEntryBeanLabel() {
  const bean = beansCache.find((b) => b.id === _daysSelectedBeanId);
  document.getElementById('quick-entry-bean-label').textContent = bean ? bean.name : '豆を選ぶ';
  const thumb = document.getElementById('quick-entry-bean-thumb');
  thumb.style.cssText = bean ? beanThumbStyle(bean) : '';
  thumb.innerHTML = bean && bean.photo ? '' : beanIconSvg(24);
}

let _entryPhotoIndex = {};
function advanceEntryPhoto(entryId, total, event) {
  event.stopPropagation();
  const card = event.currentTarget.closest('.entry-card');
  if (card && card.dataset.longpressFired) { delete card.dataset.longpressFired; return; }
  _entryPhotoIndex[entryId] = ((_entryPhotoIndex[entryId] || 0) + 1) % total;
  renderDaysList();
}

function renderDaysList() {
  const entries = entriesCache.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  document.getElementById('days-empty').style.display = entries.length === 0 ? 'block' : 'none';

  const active = activeBeans();
  if (_daysSelectedBeanId && !active.some((b) => b.id === _daysSelectedBeanId)) _daysSelectedBeanId = null;
  if (!_daysSelectedBeanId && settings.lastUsedBeanId && active.some((b) => b.id === settings.lastUsedBeanId)) {
    _daysSelectedBeanId = settings.lastUsedBeanId;
  }
  if (!_daysSelectedBeanId && active.length) _daysSelectedBeanId = active[0].id;
  updateQuickEntryBeanLabel();

  const groups = [];
  let currentLabel = null;
  entries.forEach((entry) => {
    const d = new Date(entry.createdAt);
    const label = formatDayLabel(d);
    if (label !== currentLabel) {
      groups.push({ label, items: [] });
      currentLabel = label;
    }
    groups[groups.length - 1].items.push(entry);
  });

  document.getElementById('days-list').innerHTML = groups.map((g) => `
    <div class="day-group">
      <div class="day-group-label">${g.label}</div>
      ${g.items.map((entry) => {
        const bean = beansCache.find((b) => b.id === entry.beanId);
        const d = new Date(entry.createdAt);
        const photos = entryPhotos(entry);
        const activeIdx = photos.length ? (_entryPhotoIndex[entry.id] || 0) % photos.length : 0;
        return `
          <button class="entry-card" data-entry-id="${entry.id}">
            <div class="entry-card-body">
              <div class="entry-card-meta">${beanIconSvg(12)}${escapeHtml(bean ? bean.name : '削除済みの豆')} ・ ${formatTime(d)}</div>
              ${entry.rating ? `<div class="entry-card-rating">${starsHtml(entry.rating, 12)}</div>` : ''}
              <div class="entry-card-text">${escapeHtml(entry.text || '')}</div>
              ${entry.brew ? `<div class="entry-card-brew">${escapeHtml(entry.brew)}</div>` : ''}
            </div>
            ${photos.length ? `
              <div class="entry-photo-carousel">
                <div class="entry-photo-frame" style="background-image:url(${photos[activeIdx]})" onclick="advanceEntryPhoto('${entry.id}', ${photos.length}, event)"></div>
                ${photos.length > 1 ? `<div class="entry-photo-dots">${photos.map((_, i) => `<span class="entry-photo-dot${i === activeIdx ? ' active' : ''}"></span>`).join('')}</div>` : ''}
              </div>` : ''}
          </button>`;
      }).join('')}
    </div>
  `).join('');
  wireLongPress(document.querySelectorAll('#days-list .entry-card'), (el) => openEntryActions(el.dataset.entryId));
}

function openBeanPicker() {
  const overlay = document.getElementById('bean-picker-overlay');
  const list = document.getElementById('bean-picker-list');
  const active = activeBeans();
  list.innerHTML = active.map((bean) => `
    <button class="bean-card" style="padding:10px" onclick="selectDaysBean('${bean.id}')">
      <div class="bean-card-row">
        <div class="bean-thumb" style="width:48px;height:48px;${beanThumbStyle(bean)}">${bean.photo ? '' : beanIconSvg(22)}</div>
        <div class="bean-card-body"><div class="bean-card-name" style="font-size:14px">${escapeHtml(bean.name)}</div></div>
      </div>
    </button>
  `).join('') || '<div style="color:var(--text-muted);font-size:14px;text-align:center;padding:12px">使用中の豆がありません。豆の編集画面で「今日のひとことで選べるようにする」をONにしてください。</div>';
  overlay.classList.add('visible');
}
function closeBeanPicker() {
  document.getElementById('bean-picker-overlay').classList.remove('visible');
}
function selectDaysBean(beanId) {
  _daysSelectedBeanId = beanId;
  updateQuickEntryBeanLabel();
  closeBeanPicker();
}

/* ══════════════════════ 「今日の一言」入力シート(FAB、日々タブのみ) ══════════════════════ */
let _quickEntryRating = 0;
function renderQuickEntryRating() {
  renderStarInput('quick-entry-rating', _quickEntryRating, (v) => { _quickEntryRating = v; renderQuickEntryRating(); });
}

function openQuickEntrySheetFromFab() {
  const textInput = document.getElementById('quick-entry-text');
  textInput.value = '';
  textInput.style.height = 'auto';
  document.getElementById('quick-entry-brew').value = '';
  _daysQuickPhotos = [];
  _quickEntryRating = 0;
  renderQuickEntryRating();
  renderQuickEntryPhotos();
  updateQuickEntryBeanLabel();
  document.getElementById('quick-entry-overlay').classList.add('visible');
  document.getElementById('quick-entry-fab-layer').style.display = 'none';
}
function closeQuickEntrySheet() {
  document.getElementById('quick-entry-overlay').classList.remove('visible');
  const onMainTab = ['beans', 'days', 'wiki'].some((s) => document.getElementById('screen-' + s).classList.contains('visible'));
  document.getElementById('quick-entry-fab-layer').style.display = onMainTab ? 'block' : 'none';
}

/* ══════════════════════ ひとこと(Entry)の追加・編集・削除 ══════════════════════ */
async function submitQuickEntry() {
  const beanId = _daysSelectedBeanId;
  const textInput = document.getElementById('quick-entry-text');
  const text = textInput.value.trim();
  const photos = _daysQuickPhotos;
  const brew = document.getElementById('quick-entry-brew').value.trim();

  if (!beanId) { showToast('先に豆を登録・選択してください'); return; }
  if (!text && !photos.length) { showToast('ひとこと、または写真を入れてください'); return; }

  const entry = { id: uuid(), beanId, text, photos: [...photos], rating: _quickEntryRating || 0, brew, createdAt: new Date().toISOString() };
  await dbPut('entries', entry);
  entriesCache.push(entry);

  textInput.value = '';
  textInput.style.height = 'auto';
  document.getElementById('quick-entry-brew').value = '';
  _daysQuickPhotos = [];
  _quickEntryRating = 0;
  renderQuickEntryPhotos();
  settings.lastUsedBeanId = beanId;
  saveSettings();

  closeQuickEntrySheet();
  renderDaysList();
  renderBeansList();
  showToast('記録しました');
}

let _actionEntryId = null;

function openEntryActions(entryId) {
  _actionEntryId = entryId;
  document.getElementById('entry-actions-overlay').classList.add('visible');
}
function closeEntryActions() {
  document.getElementById('entry-actions-overlay').classList.remove('visible');
}

function startEditEntry() {
  const entryId = _actionEntryId;
  closeEntryActions();
  const entry = entriesCache.find((e) => e.id === entryId);
  if (!entry) return;

  const overlay = document.getElementById('entry-edit-overlay');
  const input = document.getElementById('entry-edit-text');
  const brewInput = document.getElementById('entry-edit-brew');
  const saveBtn = document.getElementById('entry-edit-save-btn');
  const cancelBtn = document.getElementById('entry-edit-cancel-btn');
  input.value = entry.text || '';
  autoGrowTextarea(input);
  brewInput.value = entry.brew || '';
  let editRating = entry.rating || 0;
  function renderEditRating() {
    renderStarInput('entry-edit-rating', editRating, (v) => { editRating = v; renderEditRating(); });
  }
  renderEditRating();
  overlay.classList.add('visible');

  function cleanup() {
    overlay.classList.remove('visible');
    saveBtn.removeEventListener('click', onSave);
    cancelBtn.removeEventListener('click', onCancel);
  }
  async function onSave() {
    const newText = input.value.trim();
    if (!newText && !entryPhotos(entry).length) {
      showToast('ひとこと、または写真が必要です');
      return;
    }
    entry.text = newText;
    entry.rating = editRating || 0;
    entry.brew = brewInput.value.trim();
    await dbPut('entries', entry);
    cleanup();
    renderBeansList();
    renderDaysList();
    showToast('更新しました');
  }
  function onCancel() { cleanup(); }
  saveBtn.addEventListener('click', onSave);
  cancelBtn.addEventListener('click', onCancel);
}

function confirmDeleteEntryFromSheet() {
  const entryId = _actionEntryId;
  closeEntryActions();
  showConfirm('このひとことを削除しますか?', { danger: true, okLabel: '削除' }).then((ok) => {
    if (ok) deleteEntry(entryId);
  });
}

async function deleteEntry(entryId) {
  await dbDelete('entries', entryId);
  entriesCache = entriesCache.filter((e) => e.id !== entryId);
  renderBeansList();
  renderDaysList();
  showToast('削除しました');
}

function wireLongPress(nodeList, callback, ms = 550) {
  nodeList.forEach((el) => {
    let timer = null;
    const start = (e) => { e.stopPropagation(); timer = setTimeout(() => { el.dataset.longpressFired = '1'; callback(el); }, ms); };
    const cancel = () => clearTimeout(timer);
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchmove', cancel);
    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', cancel);
    el.addEventListener('mouseleave', cancel);
  });
}

/* ══════════════════════ 豆の追加・編集フォーム ══════════════════════ */
function renderPillRow(containerId, options, selected, onSelect) {
  const row = document.getElementById(containerId);
  row.innerHTML = options.map((opt) =>
    `<button type="button" class="pill${opt === selected ? ' active' : ''}" data-value="${opt}">${opt.length > 3 ? opt.slice(0, 1) : opt}</button>`
  ).join('');
  row.querySelectorAll('.pill').forEach((btn) => {
    btn.addEventListener('click', () => onSelect(btn.dataset.value === selected ? null : btn.dataset.value));
  });
}

let _addRoast = null;
let _addProcess = null;
let _addTaste = { 酸味: 0, 苦味: 0, 甘味: 0, コク: 0, 香り: 0 };
let _addFlavorNotes = '';
let _addSourceUrl = '';
let _addInUse = true; // 新規作成時はtrue、編集時は既存値を保持(UIはbeanCardHtmlのトグルに統合済み)

function renderAddRoastRow() {
  renderPillRow('add-roast-row', ROAST_VALUES, _addRoast, (v) => { _addRoast = v; renderAddRoastRow(); });
}
function renderAddProcessRow() {
  renderPillRow('add-process-row', PROCESS_VALUES, _addProcess, (v) => { _addProcess = v; renderAddProcessRow(); });
}
function renderAddTasteSliders() {
  const wrap = document.getElementById('add-taste-sliders');
  wrap.innerHTML = TASTE_KEYS.map((k) => `
    <div class="taste-slider-row">
      <span class="name">${k}</span>
      <input type="range" min="0" max="5" step="1" value="${_addTaste[k]}" data-key="${k}">
    </div>
  `).join('');
  wrap.querySelectorAll('input[type="range"]').forEach((input) => {
    input.addEventListener('input', () => { _addTaste[input.dataset.key] = Number(input.value); });
  });
}

// ★入力(今日の一言・ひとこと編集で共用)。総合評価は豆側では手入力せず、
// ひとことごとの★の平均から算出する(computeBeanRating参照)。
function renderStarInput(containerId, value, onChange) {
  const wrap = document.getElementById(containerId);
  wrap.innerHTML = [1, 2, 3, 4, 5].map((i) => `
    <button type="button" class="${i <= value ? 'on' : ''}" data-i="${i}">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2 6.3 20.3l1.2-6.4L2.8 9.5l6.4-.8z"/></svg>
    </button>
  `).join('');
  wrap.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => { onChange(Number(btn.dataset.i) === value ? 0 : Number(btn.dataset.i)); });
  });
}

function openAddForm(beanId) {
  _editingBeanId = beanId || null;
  _pendingPhotoDataUrl = null;
  _identifyApplied = false;
  _addRoast = null; _addProcess = null;
  _addTaste = { 酸味: 0, 苦味: 0, 甘味: 0, コク: 0, 香り: 0 };
  _addFlavorNotes = ''; _addSourceUrl = '';
  _addInUse = true;

  const bean = beanId ? beansCache.find((b) => b.id === beanId) : null;
  document.getElementById('add-title').textContent = bean ? '豆を編集' : '豆を追加';
  document.getElementById('add-name').value = bean ? bean.name : '';
  document.getElementById('add-shop').value = bean ? bean.shop || '' : '';
  document.getElementById('add-origin').value = bean ? bean.origin || '' : '';
  document.getElementById('add-purchase-date').value = bean ? bean.purchaseDate || '' : '';
  document.getElementById('add-brew').value = bean ? bean.brew || '' : '';
  if (bean) {
    _addRoast = bean.roast || null;
    _addProcess = bean.process || null;
    _addTaste = { ...( _addTaste), ...(bean.taste || {}) };
    _addFlavorNotes = bean.flavorNotes || '';
    _addSourceUrl = bean.sourceUrl || '';
    _pendingPhotoDataUrl = bean.photo || null;
    _addInUse = bean.inUse !== false;
  }

  const preview = document.getElementById('add-photo-preview');
  preview.querySelector('svg').style.display = _pendingPhotoDataUrl ? 'none' : 'block';
  preview.querySelector('.cam-fab').style.display = _pendingPhotoDataUrl ? 'grid' : 'none';
  preview.style.backgroundImage = _pendingPhotoDataUrl ? `url(${_pendingPhotoDataUrl})` : '';

  document.getElementById('identify-banner').style.display = 'none';
  document.getElementById('identify-trigger').style.display = (_pendingPhotoDataUrl && settings.autoFillEnabled && !bean) ? 'block' : 'none';
  renderAiMetaBox();

  renderAddRoastRow();
  renderAddProcessRow();
  renderAddTasteSliders();

  showScreen('add');
  updateNavActiveState('add');
}

function renderAiMetaBox() {
  const box = document.getElementById('add-ai-meta');
  if (!_addFlavorNotes && !_addSourceUrl) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = [
    _addFlavorNotes ? escapeHtml(_addFlavorNotes) : '',
    _addSourceUrl ? `<a href="${escapeHtml(_addSourceUrl)}" target="_blank" rel="noopener">参照元を見る</a>` : '',
  ].filter(Boolean).join('<br>');
}

function closeAddForm() {
  switchNav('beans');
}

async function runIdentify() {
  if (!_pendingPhotoDataUrl) return;
  const banner = document.getElementById('identify-banner');
  document.getElementById('identify-trigger').style.display = 'none';
  banner.style.display = 'flex';
  banner.className = 'identify-banner loading';
  banner.innerHTML = `<div class="title-row">特定しています…</div><div class="desc">写真から豆の情報を読み取っています(20〜60秒程度)</div>`;

  try {
    const res = await fetch(API_BASE + '/api/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: _pendingPhotoDataUrl }),
    });
    if (!res.ok) throw new Error('identify failed');
    const data = await res.json();
    applyIdentifyResult(data);
  } catch (_) {
    banner.className = 'identify-banner error';
    banner.innerHTML = `<div class="title-row">特定できませんでした</div><div class="desc">手入力で続けてください</div>`;
  }
}

function applyIdentifyResult(data) {
  _identifyApplied = true;
  if (!document.getElementById('add-name').value && data.name) document.getElementById('add-name').value = data.name;
  if (!document.getElementById('add-shop').value && data.shop) document.getElementById('add-shop').value = data.shop;
  if (!document.getElementById('add-origin').value && data.origin) document.getElementById('add-origin').value = data.origin;
  if (!_addRoast && data.roast && ROAST_VALUES.includes(data.roast)) { _addRoast = data.roast; renderAddRoastRow(); }
  if (!_addProcess && data.process && PROCESS_VALUES.includes(data.process)) { _addProcess = data.process; renderAddProcessRow(); }
  if (settings.autoFillTaste && data.taste) {
    TASTE_KEYS.forEach((k) => {
      if (!_addTaste[k] && data.taste[k]) _addTaste[k] = data.taste[k];
    });
    renderAddTasteSliders();
  }
  if (data.flavor_notes) _addFlavorNotes = data.flavor_notes;
  if (data.source_url) _addSourceUrl = data.source_url;
  renderAiMetaBox();

  const confLabel = { high: '高', medium: '中', low: '低' }[data.confidence] || '不明';
  const banner = document.getElementById('identify-banner');
  banner.className = 'identify-banner';
  banner.innerHTML = `
    <div class="title-row">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>
      自動入力しました
    </div>
    <div class="desc">内容を確認して保存してください。空欄の項目のみ埋めています。</div>
    <div class="confidence">確度: ${confLabel}</div>`;
}

async function saveBean() {
  const name = document.getElementById('add-name').value.trim();
  if (!name) { showToast('豆の名前を入力してください'); return; }

  const existing = _editingBeanId ? beansCache.find((b) => b.id === _editingBeanId) : null;
  const bean = {
    id: _editingBeanId || uuid(),
    photo: _pendingPhotoDataUrl || null,
    name,
    shop: document.getElementById('add-shop').value.trim(),
    origin: document.getElementById('add-origin').value.trim(),
    roast: _addRoast,
    process: _addProcess,
    purchaseDate: document.getElementById('add-purchase-date').value || null,
    taste: { ..._addTaste },
    brew: document.getElementById('add-brew').value.trim(),
    flavorNotes: _addFlavorNotes,
    sourceUrl: _addSourceUrl,
    inUse: _addInUse,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    // 新規作成時は既存の最小orderより小さい値にして一覧の先頭に出す(従来の「新しい順」の
    // デフォルト挙動を踏襲)。編集時は既存のorderをそのまま引き継ぐ。
    order: existing ? existing.order : Math.min(0, ...beansCache.map((b) => b.order ?? 0)) - 1,
  };

  await dbPut('beans', bean);
  const idx = beansCache.findIndex((b) => b.id === bean.id);
  if (idx >= 0) beansCache[idx] = bean; else beansCache.push(bean);

  showToast('保存しました');
  _expandedBeanIds.add(bean.id);
  switchNav('beans');
}

async function confirmDeleteBeanFromSheet() {
  const beanId = _actionBeanId;
  closeBeanActions();
  await confirmDeleteBean(beanId);
}

// 豆を削除しても、紐づく「ひとこと」の記録は残す(ユーザー方針)。
// 記録側は豆が見つからない場合「削除済みの豆」と表示する(renderDaysList/beanTimelineHtml参照)。
async function confirmDeleteBean(beanId) {
  const ok = await showConfirm('この豆を削除しますか?紐づく日々の記録は削除されません。', { danger: true, okLabel: '削除' });
  if (!ok) return;
  await dbDelete('beans', beanId);
  beansCache = beansCache.filter((b) => b.id !== beanId);
  renderBeansList();
  renderDaysList();
  showToast('削除しました');
}

/* ══════════════════════ バックアップ ══════════════════════ */
function exportBackup() {
  const payload = { exportedAt: new Date().toISOString(), beans: beansCache, entries: entriesCache };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bean-diary-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('書き出しました');
}

async function importBackup(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const ok = await showConfirm('バックアップを復元しますか?現在のデータは上書きされます。', { danger: true, okLabel: '復元' });
  if (!ok) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await dbClear('beans');
    await dbClear('entries');
    for (const bean of data.beans || []) await dbPut('beans', bean);
    for (const entry of data.entries || []) await dbPut('entries', entry);
    beansCache = data.beans || [];
    entriesCache = data.entries || [];
    switchNav('beans');
    showToast('復元しました');
  } catch (_) {
    showToast('復元に失敗しました(ファイル形式を確認してください)');
  }
}

async function confirmDeleteAll() {
  const ok = await showConfirm('すべてのデータを削除しますか?この操作は取り消せません。', { danger: true, okLabel: 'すべて削除' });
  if (!ok) return;
  await dbClear('beans');
  await dbClear('entries');
  beansCache = [];
  entriesCache = [];
  switchNav('beans');
  showToast('削除しました');
}

/* ══════════════════════ Service Worker登録・更新検知 ══════════════════════
 * ホーム画面に追加したPWA(standaloneモード)はリロードボタンが無く、特に
 * 変更が反映されにくい。新しいSWが見つかったら初回のcontrollerchangeで
 * 1回だけ自動リロードし、タブ/アプリ復帰時にも更新確認する(姉妹アプリと同じ方式)。 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update();
    });
  }).catch(() => { /* SW登録に失敗してもアプリ自体は動く */ });
}

/* ══════════════════════ 初期化 ══════════════════════ */
async function init() {
  loadSettings();
  applyTheme();
  registerServiceWorker();
  _db = await openDB();
  [beansCache, entriesCache] = await Promise.all([dbGetAll('beans'), dbGetAll('entries')]);
  await ensureBeanOrder();
  renderRoastFilterChips();
  switchNav(settings.startupScreen === 'days' ? 'days' : 'beans');
  window.addEventListener('resize', () => {
    const current = ALL_SCREENS.find((s) => document.getElementById('screen-' + s).classList.contains('visible'));
    if (current) adjustScreenPadding(current);
  });
}

init();
