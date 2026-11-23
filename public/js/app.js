/* Bean Diary - フロントエンド本体(Vanilla JS、ビルドステップなし)
   データはすべて端末内IndexedDB(DB名 beandiary)。サーバーは /api/identify の中継のみ。 */

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
let _daysQuickPhoto = null;
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
const ALL_SCREENS = ['beans', 'days', 'wiki', 'wiki-category', 'add', 'settings'];

const FAB_ICON_ADD = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const FAB_ICON_PENCIL = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';

// メインFABは画面によってアイコン・動作が変わる(豆一覧=豆を追加、日々/豆の詳細=今日の一言)。
// 旧デザインはボトムナビ中央に固定の＋ボタンがあったが、豆一覧側のFABに統合した。
function updateMainFab(screen) {
  const btn = document.getElementById('main-fab');
  if (screen === 'beans') {
    btn.setAttribute('aria-label', '豆を追加');
    btn.innerHTML = FAB_ICON_ADD;
    btn.onclick = () => { if (!_touchGuard()) openAddForm(); };
  } else {
    btn.setAttribute('aria-label', '今日の一言を追加');
    btn.innerHTML = FAB_ICON_PENCIL;
    btn.onclick = () => { if (!_touchGuard()) openQuickEntrySheetFromFab(); };
  }
}

function showScreen(name) {
  ALL_SCREENS.forEach((s) => {
    document.getElementById('screen-' + s).classList.toggle('visible', s === name);
  });
  document.getElementById('bottom-nav').style.display = name === 'settings' ? 'none' : 'flex';
  const showFab = name === 'beans' || name === 'days';
  document.getElementById('quick-entry-fab-layer').style.display = showFab ? 'block' : 'none';
  if (showFab) updateMainFab(name);
}

function updateNavActiveState(highlight) {
  document.getElementById('nav-beans').classList.toggle('active', highlight === 'beans');
  document.getElementById('nav-days').classList.toggle('active', highlight === 'days');
  document.getElementById('nav-wiki').classList.toggle('active', highlight === 'wiki');
}

function switchNav(screen) {
  if (screen === 'beans' || screen === 'days' || screen === 'wiki') {
    _lastMainTab = screen;
    showScreen(screen);
    updateNavActiveState(screen);
    if (screen === 'beans') renderBeansList();
    if (screen === 'days') renderDaysList();
    if (screen === 'wiki') renderWikiGrid();
  } else {
    showScreen(screen);
  }
}

/* ══════════════════════ 豆知識(ウィキ) ══════════════════════ */
let _wikiCategoryId = null;
let _expandedWikiIds = new Set();

const WIKI_CATEGORY_ICONS = {
  roast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 17c1.4 0 2-1.5 1.3-2.7-.5-.9-.2-1.8.4-2.3 1 1 1.3 2.5 1.3 2.5 1.5-1.5 2-4-.5-6 .3 1.5-.5 2-1 1.5-.4-2-2-3-2-3 .2 1.5-.8 3.2-1.6 4.2-.8 1-1.4 2-1.4 3.3z"/></svg>',
  process: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5s6 6.2 6 11a6 6 0 0 1-12 0c0-4.8 6-11 6-11z"/></svg>',
  origin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  brew: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h14v5a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M7 2v2M10 2v2M13 2v2"/></svg>',
  glossary: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5v-17z"/><path d="M4 17h16"/></svg>',
  equipment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16l-6.5 8.5V19l-3 1.5v-8z"/></svg>',
};

function renderWikiGrid() {
  const grid = document.getElementById('wiki-grid');
  grid.innerHTML = WIKI_CATEGORIES.map((cat) => `
    <button class="wiki-tile" onclick="if(!_touchGuard()) openWikiCategory('${cat.id}')">
      <div class="icon">${WIKI_CATEGORY_ICONS[cat.id] || ''}</div>
      <div class="label">${cat.label}</div>
      <div class="count">${cat.items.length}件</div>
    </button>
  `).join('');
}

function openWikiCategory(categoryId) {
  _wikiCategoryId = categoryId;
  _expandedWikiIds.clear();
  const cat = WIKI_CATEGORIES.find((c) => c.id === categoryId);
  document.getElementById('wiki-category-title').textContent = cat ? cat.label : '';
  showScreen('wiki-category');
  renderWikiCategoryList();
}

function renderWikiCategoryList() {
  const cat = WIKI_CATEGORIES.find((c) => c.id === _wikiCategoryId);
  const list = document.getElementById('wiki-category-list');
  if (!cat) { list.innerHTML = ''; return; }
  list.innerHTML = cat.items.map((item) => {
    const open = _expandedWikiIds.has(item.id);
    return `
      <button class="wiki-card" onclick="toggleWikiItemExpand('${item.id}')">
        <div class="wiki-card-top">
          <div class="wiki-card-title">${item.title}</div>
          <svg class="chevron${open ? ' open' : ''}" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        ${open ? `<div class="wiki-card-body">${item.body}</div>` : ''}
      </button>
    `;
  }).join('');
}

function toggleWikiItemExpand(itemId) {
  if (_expandedWikiIds.has(itemId)) _expandedWikiIds.delete(itemId);
  else _expandedWikiIds.add(itemId);
  renderWikiCategoryList();
}

function openSettings() {
  showScreen('settings');
  renderSettingsScreen();
  document.getElementById('settings-version').textContent = '読み込み中…';
  fetch('/api/version').then((r) => r.json()).then((d) => {
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
    _daysQuickPhoto = dataUrl;
    renderQuickEntryPhotoPreview();
    showToast('写真を添付しました');
  }
}

function renderQuickEntryPhotoPreview() {
  const preview = document.getElementById('quick-entry-photo-preview');
  preview.style.backgroundImage = _daysQuickPhoto ? `url(${_daysQuickPhoto})` : '';
  preview.querySelector('svg').style.display = _daysQuickPhoto ? 'none' : 'block';
  preview.querySelector('.cam-fab').style.display = _daysQuickPhoto ? 'grid' : 'none';
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
  } catch (_) {
    // ユーザーがキャンセルした場合もここに来る。何もしない。
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
  if (_expandedBeanIds.has(beanId)) _expandedBeanIds.delete(beanId);
  else _expandedBeanIds.add(beanId);
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
  const tasteRadar = tasteRadarSvg(bean.taste, 130);
  const expandRowParts = [];
  if (bean.purchaseDate) expandRowParts.push(`購入 ${bean.purchaseDate.slice(5).replace('-', '/')}`);
  if (bean.brew) expandRowParts.push(bean.brew);
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
          <span class="label">今日の一言で選べる</span>
          <button class="toggle-switch${bean.inUse !== false ? ' on' : ''}" onclick="toggleBeanInUse('${bean.id}', event)"><span class="knob"></span></button>
        </div>
        ${tasteRadar ? `<div class="taste-radar-wrap">${tasteRadar}</div>` : ''}
        ${expandRowParts.length ? `<div class="bean-card-expand-row">${escapeHtml(expandRowParts.join(' ・ '))}</div>` : ''}
        ${bean.flavorNotes ? `<div class="bean-card-expand-notes">${escapeHtml(bean.flavorNotes)}</div>` : ''}
        ${(!tasteRadar && !expandRowParts.length && !bean.flavorNotes) ? '<div class="bean-card-expand-row" style="color:var(--text-muted)">詳細情報はまだありません</div>' : ''}
        ${beanTimelineHtml(bean.id)}
      </div>` : ''}
    </div>`;
}

function renderBeansList() {
  let list = beansCache.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (roastFilter !== 'all') list = list.filter((b) => b.roast === roastFilter);
  document.getElementById('beans-count').textContent = `${beansCache.length} 種類の豆`;
  document.getElementById('beans-empty').style.display = beansCache.length === 0 ? 'block' : 'none';

  const container = document.getElementById('beans-list');
  container.innerHTML = list.map(beanCardHtml).join('');
  wireLongPress(container.querySelectorAll('.bean-card'), (el) => openBeanActions(el.dataset.beanId));
  wireLongPress(container.querySelectorAll('.timeline-row'), (el) => openEntryActions(el.dataset.entryId));
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

function beanTimelineHtml(beanId) {
  const entries = entriesCache.filter((e) => e.beanId === beanId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const rows = entries.map((entry, i) => {
    const d = new Date(entry.createdAt);
    const timeLabel = `${formatDayLabel(d)} ${formatTime(d)}`;
    return `
      <div class="timeline-row" data-entry-id="${entry.id}">
        <div class="timeline-dot${i === 0 ? ' latest' : ''}"></div>
        <div class="timeline-body">
          <div class="timeline-text">
            <div class="timeline-time">${timeLabel}</div>
            ${entry.rating ? `<div class="timeline-rating">${starsHtml(entry.rating, 12)}</div>` : ''}
            <div class="timeline-entry-text">${escapeHtml(entry.text || '')}</div>
            ${entry.brew ? `<div class="timeline-brew">${escapeHtml(entry.brew)}</div>` : ''}
          </div>
          ${entry.photo ? `<div class="timeline-thumb" style="background-image:url(${entry.photo})"></div>` : ''}
        </div>
      </div>`;
  }).join('');
  return `
    <div class="bean-card-expand-divider"></div>
    <div class="detail-entries-heading">
      <h2>この豆の日々</h2>
      <span class="header-sub">${entries.length} 件</span>
    </div>
    <div class="timeline">
      ${rows || '<div class="bean-card-expand-row" style="color:var(--text-muted)">まだ記録がありません</div>'}
    </div>`;
}

/* ══════════════════════ 日々タブ ══════════════════════ */
// 「使用中」の豆のみ(日々の入力欄・豆選択シートで選べる対象)。新しい順。
function activeBeans() {
  return beansCache.filter((b) => b.inUse !== false).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function updateQuickEntryBeanLabel() {
  const bean = beansCache.find((b) => b.id === _daysSelectedBeanId);
  document.getElementById('quick-entry-bean-label').textContent = bean ? bean.name : '豆を選ぶ';
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
        return `
          <button class="entry-card" data-entry-id="${entry.id}">
            <div class="entry-card-body">
              <div class="entry-card-meta">${beanIconSvg(12)}${escapeHtml(bean ? bean.name : '削除済みの豆')} ・ ${formatTime(d)}</div>
              ${entry.rating ? `<div class="entry-card-rating">${starsHtml(entry.rating, 12)}</div>` : ''}
              <div class="entry-card-text">${escapeHtml(entry.text || '')}</div>
              ${entry.brew ? `<div class="entry-card-brew">${escapeHtml(entry.brew)}</div>` : ''}
            </div>
            ${entry.photo ? `<div class="entry-thumb" style="background-image:url(${entry.photo})"></div>` : ''}
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
  `).join('') || '<div style="color:var(--text-muted);font-size:14px;text-align:center;padding:12px">使用中の豆がありません。豆の編集画面で「今日の一言で選べるようにする」をONにしてください。</div>';
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
  document.getElementById('quick-entry-text').value = '';
  document.getElementById('quick-entry-brew').value = '';
  _daysQuickPhoto = null;
  _quickEntryRating = 0;
  renderQuickEntryRating();
  renderQuickEntryPhotoPreview();
  updateQuickEntryBeanLabel();
  document.getElementById('quick-entry-overlay').classList.add('visible');
  document.getElementById('quick-entry-fab-layer').style.display = 'none';
}
function closeQuickEntrySheet() {
  document.getElementById('quick-entry-overlay').classList.remove('visible');
  const onDays = document.getElementById('screen-days').classList.contains('visible');
  const onBeans = document.getElementById('screen-beans').classList.contains('visible');
  document.getElementById('quick-entry-fab-layer').style.display = (onDays || onBeans) ? 'block' : 'none';
}

/* ══════════════════════ ひとこと(Entry)の追加・編集・削除 ══════════════════════ */
async function submitQuickEntry() {
  const beanId = _daysSelectedBeanId;
  const textInput = document.getElementById('quick-entry-text');
  const text = textInput.value.trim();
  const photo = _daysQuickPhoto;
  const brew = document.getElementById('quick-entry-brew').value.trim();

  if (!beanId) { showToast('先に豆を登録・選択してください'); return; }
  if (!text && !photo) { showToast('ひとこと、または写真を入れてください'); return; }

  const entry = { id: uuid(), beanId, text, photo: photo || null, rating: _quickEntryRating || 0, brew, createdAt: new Date().toISOString() };
  await dbPut('entries', entry);
  entriesCache.push(entry);

  textInput.value = '';
  document.getElementById('quick-entry-brew').value = '';
  _daysQuickPhoto = null;
  _quickEntryRating = 0;
  renderQuickEntryPhotoPreview();
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
    if (!newText && !entry.photo) {
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
    const res = await fetch('/api/identify', {
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
  };

  await dbPut('beans', bean);
  const idx = beansCache.findIndex((b) => b.id === bean.id);
  if (idx >= 0) beansCache[idx] = bean; else beansCache.push(bean);

  showToast('保存しました');
  _expandedBeanIds.add(bean.id);
  switchNav('beans');
}

async function confirmDeleteBean(beanId) {
  const count = entriesCache.filter((e) => e.beanId === beanId).length;
  const ok = await showConfirm(`この豆を削除しますか?日々の記録も${count}件削除されます。`, { danger: true, okLabel: '削除' });
  if (!ok) return;
  const toDelete = entriesCache.filter((e) => e.beanId === beanId).map((e) => e.id);
  for (const id of toDelete) await dbDelete('entries', id);
  await dbDelete('beans', beanId);
  entriesCache = entriesCache.filter((e) => e.beanId !== beanId);
  beansCache = beansCache.filter((b) => b.id !== beanId);
  switchNav('beans');
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
  renderRoastFilterChips();
  switchNav(settings.startupScreen === 'days' ? 'days' : 'beans');
}

init();
