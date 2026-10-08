import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, updateDoc, deleteDoc, setDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { VERSION, DEPLOYED_AT } from './version.js';
import { icon, googleLogo } from './icons.js';
import { extractSchedule, fileToInlineImage } from './gemini.js';

const DAYS = ['月', '火', '水', '木', '金', '土', '日'];
const CATEGORIES = [
  { id: 'hospital', label: '病院', icon: 'hospital', hasDept: true },
  { id: 'dental', label: '歯科', icon: 'tooth' },
  { id: 'pharmacy', label: '薬局', icon: 'pill' },
  { id: 'other', label: 'その他', icon: 'building' },
];
const ALL_DEPTS = ['内科', '外科', '整形外科', '皮膚科', '眼科', '耳鼻咽喉科', '小児科', '婦人科', '泌尿器科', '心療内科'];
const DEFAULT_SETTINGS = { departments: ['内科'], geminiApiKey: '', geminiModel: 'gemini-flash-latest' };

const $app = document.getElementById('app');
document.getElementById('version').textContent =
  `ver${VERSION} ${DEPLOYED_AT.startsWith('__') ? 'local' : DEPLOYED_AT}`;

const state = { user: null, authReady: false, facilities: [], loaded: false, settings: { ...DEFAULT_SETTINGS } };
let unsubs = [];
let draft = null; // 編集中の施設
let pendingDraft = null; // 詳細画面のAI再読み取り結果を編集画面へ渡す

// ---------- Firebase ----------
const configured = !String(firebaseConfig.apiKey).startsWith('YOUR');
let auth, db;
if (configured) {
  const fbApp = initializeApp(firebaseConfig);
  auth = getAuth(fbApp);
  db = initializeFirestore(fbApp, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  onAuthStateChanged(auth, (user) => {
    state.user = user;
    state.authReady = true;
    unsubs.forEach((u) => u());
    unsubs = [];
    state.facilities = [];
    state.loaded = false;
    state.settings = { ...DEFAULT_SETTINGS };
    if (user) {
      unsubs.push(onSnapshot(collection(db, 'users', user.uid, 'facilities'), (snap) => {
        state.facilities = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
        state.loaded = true;
        if (!isEditing() || !draft) render();
      }, (err) => toast(`読み込みに失敗しました: ${err.message}`)));
      unsubs.push(onSnapshot(doc(db, 'users', user.uid), (snap) => {
        state.settings = { ...DEFAULT_SETTINGS, ...(snap.data() || {}) };
        if (!isEditing()) render();
      }));
    }
    render();
  });
}

const facilitiesRef = () => collection(db, 'users', state.user.uid, 'facilities');
const userRef = () => doc(db, 'users', state.user.uid);

async function login() {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      toast(`ログインに失敗しました: ${e.message}`);
    }
  }
}

// ---------- ユーティリティ ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmtTime = (t) => (t || '').replace(/^0(\d)/, '$1');
const toMin = (t) => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
const todayIdx = () => (new Date().getDay() + 6) % 7; // 月=0
const catOf = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[3];
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const isEditing = () => parseRoute().parts[0] === 'edit' || parseRoute().parts[0] === 'new';

function sortedSessions(f) {
  return [...(f.sessions || [])].sort((a, b) => toMin(a.start) - toMin(b.start));
}

function closedDaysText(f) {
  const sessions = f.sessions || [];
  const closed = DAYS.filter((_, i) => !sessions.some((s) => s.days?.[i])).map((d) => `${d}曜`);
  if (f.closedOnHolidays) closed.push('祝日');
  return closed.join('・');
}

function statusOf(f) {
  const sessions = sortedSessions(f);
  if (!sessions.length) return { cls: 'muted', label: '時間未登録' };
  const now = new Date();
  const d = todayIdx();
  const m = now.getHours() * 60 + now.getMinutes();
  const today = sessions.filter((s) => s.days?.[d]);
  const current = today.find((s) => toMin(s.start) <= m && m < toMin(s.end));
  if (current) return { cls: 'open', label: `診療中 〜${fmtTime(current.end)}` };
  const next = today.find((s) => m < toMin(s.start));
  if (next) {
    return { cls: 'soon', label: today.some((s) => toMin(s.end) <= m) ? `休憩中 ${fmtTime(next.start)}〜` : `本日 ${fmtTime(next.start)}〜` };
  }
  for (let i = 1; i <= 7; i++) {
    const di = (d + i) % 7;
    const s = sessions.find((x) => x.days?.[di]);
    if (s) {
      const when = i === 1 ? '明日' : `${DAYS[di]}曜`;
      return { cls: 'closed', label: `${today.length ? '本日終了' : '本日休診'} · ${when} ${fmtTime(s.start)}〜` };
    }
  }
  return { cls: 'closed', label: '休診' };
}

function mapUrl(f) {
  if (safeUrl(f.mapUrl)) return f.mapUrl;
  if (f.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(f.address)}`;
  return '';
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---------- ルーティング ----------
function parseRoute() {
  const h = location.hash.slice(1) || '/';
  return { parts: h.split('/').filter(Boolean).map(decodeURIComponent) };
}
const go = (path) => { location.hash = path; };
window.addEventListener('hashchange', () => { draft = null; render(); window.scrollTo(0, 0); });

function header({ title, back, actions = '' }) {
  return `<header class="bar">
    ${back ? `<a class="icon-btn" href="${back}" aria-label="戻る">${icon('back')}</a>` : `<span class="brand">${icon('logo')}</span>`}
    <h1 class="bar-title">${esc(title)}</h1>
    <div class="bar-actions">${actions}</div>
  </header>`;
}

function render() {
  if (!configured) { $app.innerHTML = viewSetup(); return; }
  if (!state.authReady) { $app.innerHTML = `<div class="center"><div class="spinner"></div></div>`; return; }
  if (!state.user) { $app.innerHTML = viewLogin(); bindLogin(); return; }

  const { parts } = parseRoute();
  const [p0, p1, p2] = parts;
  if (p0 === 'c' && p1) {
    const cat = catOf(p1);
    if (cat.hasDept && !p2) { $app.innerHTML = viewDepts(cat); return; }
    $app.innerHTML = viewList(cat, p2 || '');
    return;
  }
  if (p0 === 'f' && p1) { $app.innerHTML = viewDetail(p1); bindDetail(p1); return; }
  if (p0 === 'new') { openEditor(null, p1 || 'hospital', p2 || ''); return; }
  if (p0 === 'edit' && p1) { openEditor(p1); return; }
  if (p0 === 'settings') { $app.innerHTML = viewSettings(); bindSettings(); return; }
  $app.innerHTML = viewHome();
}

// ---------- 画面 ----------
function viewSetup() {
  return `<main class="center narrow">
    <div class="hero-icon">${icon('settings')}</div>
    <h2>初期設定が必要です</h2>
    <p class="muted-text">js/firebase-config.js に Firebase の設定値を入力してください。手順は README.md を参照してください。</p>
  </main>`;
}

function viewLogin() {
  return `<main class="login">
    <div class="login-logo">${icon('logo')}</div>
    <h1 class="login-title">かかりつけ</h1>
    <p class="login-sub">いざという時に、すぐ見られる<br>かかりつけ施設の診療時間</p>
    <button class="btn google" id="login">${googleLogo}<span>Google でログイン</span></button>
  </main>`;
}
function bindLogin() { document.getElementById('login').onclick = login; }

function viewHome() {
  const counts = (id) => state.facilities.filter((f) => f.category === id).length;
  return `${header({ title: 'かかりつけ', actions: `<a class="icon-btn" href="#/settings" aria-label="設定">${icon('settings')}</a>` })}
  <main class="page">
    <div class="tiles">
      ${CATEGORIES.map((c) => `<a class="tile" href="#/c/${c.id}">
        <span class="tile-icon">${icon(c.icon)}</span>
        <span class="tile-label">${c.label}</span>
        <span class="tile-count">${state.loaded ? `${counts(c.id)}件` : ''}</span>
      </a>`).join('')}
    </div>
    ${state.facilities.length ? `<h2 class="section-title">登録済み</h2>
      <div class="list">${state.facilities.map(facilityRow).join('')}</div>` : ''}
  </main>`;
}

function facilityRow(f) {
  const st = statusOf(f);
  const cat = catOf(f.category);
  const sub = [cat.label, f.department].filter(Boolean).join(' · ');
  return `<a class="row" href="#/f/${f.id}">
    <span class="row-icon">${icon(cat.icon)}</span>
    <span class="row-body">
      <span class="row-title">${esc(f.name || '名称未設定')}</span>
      <span class="row-sub">${esc(sub)}</span>
    </span>
    <span class="pill ${st.cls}">${esc(st.label)}</span>
    ${icon('chevronRight', 'chev')}
  </a>`;
}

function viewDepts(cat) {
  const depts = state.settings.departments?.length ? state.settings.departments : ['内科'];
  return `${header({ title: cat.label, back: '#/' })}
  <main class="page">
    <div class="list">
      ${depts.map((d) => {
        const n = state.facilities.filter((f) => f.category === cat.id && f.department === d).length;
        return `<a class="row" href="#/c/${cat.id}/${encodeURIComponent(d)}">
          <span class="row-icon">${icon('stethoscope')}</span>
          <span class="row-body"><span class="row-title">${esc(d)}</span></span>
          <span class="row-count">${n}件</span>
          ${icon('chevronRight', 'chev')}
        </a>`;
      }).join('')}
    </div>
    <a class="link-btn" href="#/settings">${icon('settings')}表示する診療科を変更</a>
  </main>`;
}

function viewList(cat, dept) {
  const items = state.facilities.filter((f) => f.category === cat.id && (!cat.hasDept || f.department === dept));
  const title = dept || cat.label;
  const back = cat.hasDept ? `#/c/${cat.id}` : '#/';
  const newHref = `#/new/${cat.id}${dept ? `/${encodeURIComponent(dept)}` : ''}`;
  return `${header({ title, back, actions: `<a class="icon-btn" href="${newHref}" aria-label="追加">${icon('plus')}</a>` })}
  <main class="page">
    ${items.length ? `<div class="list">${items.map(facilityRow).join('')}</div>`
      : state.loaded ? `<div class="empty">
        <div class="empty-icon">${icon(cat.icon)}</div>
        <p>まだ登録されていません</p>
        <a class="btn primary" href="${newHref}">${icon('plus')}登録する</a>
      </div>` : `<div class="center"><div class="spinner"></div></div>`}
  </main>`;
}

function scheduleBoard(f) {
  const sessions = sortedSessions(f);
  const td = todayIdx();
  const st = statusOf(f);
  const closed = closedDaysText(f);
  return `<section class="board">
    <div class="board-head">
      <h2 class="board-name">${esc(f.name || '名称未設定')}</h2>
      <span class="pill ${st.cls}">${icon('clock')}${esc(st.label)}</span>
    </div>
    ${sessions.length ? `<div class="table-wrap"><table class="hours">
      <thead><tr><th class="time-col">診療時間</th>${DAYS.map((d, i) => `<th class="${i === td ? 'today' : ''}${i === 5 ? ' sat' : ''}${i === 6 ? ' sun' : ''}">${d}</th>`).join('')}</tr></thead>
      <tbody>${sessions.map((s) => `<tr>
        <th class="time-col">${fmtTime(s.start)}<span class="tilde">〜</span>${fmtTime(s.end)}</th>
        ${DAYS.map((_, i) => `<td class="${i === td ? 'today' : ''}">${s.days?.[i] ? '<span class="dot" aria-label="診療"></span>' : '<span class="dash" aria-label="休診"></span>'}</td>`).join('')}
      </tr>`).join('')}</tbody>
    </table></div>` : `<p class="muted-text pad">診療時間が登録されていません</p>`}
    ${closed ? `<p class="closed-days"><span>休診日</span>${esc(closed)}</p>` : ''}
    ${f.notes ? `<p class="notes">${esc(f.notes)}</p>` : ''}
    <div class="board-foot">
      ${f.reservation ? '<span class="badge">予約優先</span>' : '<span></span>'}
      ${f.phone ? `<a class="board-tel" href="tel:${esc(f.phone.replace(/[^\d+]/g, ''))}">${icon('phone')}${esc(f.phone)}</a>` : ''}
    </div>
  </section>`;
}

function viewDetail(id) {
  const f = state.facilities.find((x) => x.id === id);
  if (!f) {
    return `${header({ title: '', back: '#/' })}<main class="page">${state.loaded ? '<p class="muted-text pad">見つかりません</p>' : '<div class="center"><div class="spinner"></div></div>'}</main>`;
  }
  const cat = catOf(f.category);
  const back = cat.hasDept ? `#/c/${cat.id}/${encodeURIComponent(f.department || '')}` : `#/c/${cat.id}`;
  const site = safeUrl(f.url);
  const map = mapUrl(f);
  return `${header({ title: [cat.label, f.department].filter(Boolean).join(' · '), back, actions: `<a class="icon-btn" href="#/edit/${f.id}" aria-label="編集">${icon('edit')}</a>` })}
  <main class="page">
    ${scheduleBoard(f)}
    <div class="actions">
      ${f.phone ? `<a class="action" href="tel:${esc(f.phone.replace(/[^\d+]/g, ''))}">${icon('phone')}<span>電話</span></a>` : ''}
      ${map ? `<a class="action" href="${esc(map)}" target="_blank" rel="noopener">${icon('mapPin')}<span>地図</span></a>` : ''}
      ${site ? `<a class="action" href="${esc(site)}" target="_blank" rel="noopener">${icon('globe')}<span>公式サイト</span></a>` : ''}
    </div>
    ${f.address ? `<div class="info-row">${icon('mapPin')}<span>${esc(f.address)}</span></div>` : ''}
    ${site ? `<a class="notice" href="${esc(site)}" target="_blank" rel="noopener">
      ${icon('calendarOff')}<span>臨時休診や年末年始の予定は公式サイトでご確認ください</span>${icon('external', 'chev')}
    </a>` : ''}
    ${site ? `<button class="link-btn" id="refresh-ai">${icon('sparkle')}サイトから診療時間を再読み取り</button>` : ''}
  </main>`;
}

function bindDetail(id) {
  const btn = document.getElementById('refresh-ai');
  if (!btn) return;
  btn.onclick = async () => {
    const f = state.facilities.find((x) => x.id === id);
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner sm"></span>読み取り中…`;
    try {
      const data = await runExtract({ url: f.url });
      if (!data.sessions.length) throw new Error(NO_SESSIONS_MSG);
      pendingDraft = structuredClone({ ...f, sessions: data.sessions, reservation: data.reservation || f.reservation, closedOnHolidays: data.closedOnHolidays, notes: data.notes || f.notes });
      go(`#/edit/${id}`);
      toast('読み取りました。内容を確認して保存してください');
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      btn.innerHTML = `${icon('sparkle')}サイトから診療時間を再読み取り`;
    }
  };
}

// ---------- 編集 ----------
function openEditor(id, category, department) {
  if (pendingDraft) { draft = pendingDraft; pendingDraft = null; }
  if (!draft) {
    if (id) {
      const f = state.facilities.find((x) => x.id === id);
      if (!f) { $app.innerHTML = `${header({ title: '編集', back: '#/' })}<main class="page"><div class="center"><div class="spinner"></div></div></main>`; return; }
      draft = structuredClone({ ...f, sessions: f.sessions || [] });
    } else {
      draft = {
        category, department: catOf(category).hasDept ? (department || state.settings.departments?.[0] || '内科') : '',
        name: '', url: '', phone: '', address: '', mapUrl: '', notes: '',
        reservation: false, closedOnHolidays: true,
        sessions: [
          { start: '09:00', end: '12:00', days: [true, true, true, true, true, false, false] },
          { start: '14:00', end: '18:00', days: [true, true, true, true, true, false, false] },
        ],
      };
    }
  }
  $app.innerHTML = viewEditor(id);
  bindEditor(id);
}

function viewEditor(id) {
  const d = draft;
  const cat = catOf(d.category);
  const depts = [...new Set([...(state.settings.departments || []), d.department].filter(Boolean))];
  return `${header({ title: id ? '編集' : '新規登録', back: id ? `#/f/${id}` : (cat.hasDept ? `#/c/${cat.id}/${encodeURIComponent(d.department)}` : `#/c/${cat.id}`) })}
  <main class="page form">
    <section class="card ai">
      <div class="ai-head">${icon('sparkle')}<span>AI で自動入力</span></div>
      <label class="field">
        <span>公式サイトのURL</span>
        <input type="url" id="f-url" inputmode="url" placeholder="https://..." value="${esc(d.url)}">
      </label>
      <button class="btn primary block" id="ai-url">${icon('sparkle')}URLから読み取る</button>
      <div class="ai-alt">
        <label class="btn ghost">${icon('image')}画像から<input type="file" accept="image/*" id="ai-image" hidden></label>
        <button class="btn ghost" id="ai-text-toggle">${icon('text')}文章から</button>
      </div>
      <div id="ai-text-box" hidden>
        <textarea id="ai-text" rows="5" placeholder="サイトの診療時間の部分をコピーして貼り付け"></textarea>
        <button class="btn primary block" id="ai-text-run">${icon('sparkle')}文章から読み取る</button>
      </div>
    </section>

    <section class="card">
      <label class="field"><span>施設名</span><input id="f-name" value="${esc(d.name)}" placeholder="サカエ医院"></label>
      <div class="field-row">
        <label class="field"><span>種類</span>
          <select id="f-category">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === d.category ? 'selected' : ''}>${c.label}</option>`).join('')}</select>
        </label>
        ${cat.hasDept ? `<label class="field"><span>診療科</span>
          <select id="f-department">${depts.map((x) => `<option ${x === d.department ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
        </label>` : ''}
      </div>
      <label class="field"><span>電話番号</span><input id="f-phone" type="tel" value="${esc(d.phone)}" placeholder="0000-00-0000"></label>
    </section>

    <section class="card">
      <div class="card-title">${icon('clock')}診療時間</div>
      <div id="sessions">${sessionsEditor()}</div>
      <button class="link-btn" id="add-session">${icon('plus')}時間帯を追加</button>
      <label class="check"><input type="checkbox" id="f-holiday" ${d.closedOnHolidays ? 'checked' : ''}><span>祝日は休診</span></label>
      <label class="check"><input type="checkbox" id="f-reservation" ${d.reservation ? 'checked' : ''}><span>予約優先・予約制</span></label>
      <label class="field"><span>備考</span><textarea id="f-notes" rows="2" placeholder="例: 木曜午後休診、受付は終了30分前まで">${esc(d.notes)}</textarea></label>
    </section>

    <section class="card">
      <div class="card-title">${icon('mapPin')}場所</div>
      <label class="field"><span>住所</span><input id="f-address" value="${esc(d.address)}" placeholder="住所を入力"></label>
      <label class="field"><span>地図のURL（任意）</span><input id="f-map" type="url" value="${esc(d.mapUrl)}" placeholder="Google マップの共有リンク"></label>
      <button class="link-btn" id="use-location">${icon('locate')}現在地を地図の場所として登録</button>
    </section>

    <button class="btn primary block lg" id="save">${icon('check')}保存</button>
    ${id ? `<button class="btn danger block" id="delete">${icon('trash')}削除</button>` : ''}
  </main>`;
}

function sessionsEditor() {
  if (!draft.sessions.length) return '<p class="muted-text">時間帯がありません</p>';
  return draft.sessions.map((s, i) => `<div class="session" data-i="${i}">
    <div class="session-time">
      <input type="time" data-k="start" value="${esc(s.start)}" aria-label="開始">
      <span>〜</span>
      <input type="time" data-k="end" value="${esc(s.end)}" aria-label="終了">
      <button class="icon-btn sm" data-remove aria-label="削除">${icon('close')}</button>
    </div>
    <div class="day-toggles">${DAYS.map((d, j) => `<button type="button" class="day ${s.days[j] ? 'on' : ''}" data-day="${j}">${d}</button>`).join('')}</div>
  </div>`).join('');
}

function bindEditor(id) {
  const $ = (s) => document.getElementById(s);
  const bindVal = (el, key, prop = 'value') => { if (el) el.addEventListener('input', () => { draft[key] = el[prop]; }); };
  bindVal($('f-url'), 'url');
  bindVal($('f-name'), 'name');
  bindVal($('f-phone'), 'phone');
  bindVal($('f-address'), 'address');
  bindVal($('f-map'), 'mapUrl');
  bindVal($('f-notes'), 'notes');
  $('f-holiday').onchange = (e) => { draft.closedOnHolidays = e.target.checked; };
  $('f-reservation').onchange = (e) => { draft.reservation = e.target.checked; };
  $('f-category').onchange = (e) => {
    draft.category = e.target.value;
    draft.department = catOf(draft.category).hasDept ? (draft.department || state.settings.departments?.[0] || '内科') : '';
    rerender();
  };
  if ($('f-department')) $('f-department').onchange = (e) => { draft.department = e.target.value; };

  const sess = $('sessions');
  sess.addEventListener('input', (e) => {
    const row = e.target.closest('.session');
    if (row && e.target.dataset.k) draft.sessions[row.dataset.i][e.target.dataset.k] = e.target.value;
  });
  sess.addEventListener('click', (e) => {
    const row = e.target.closest('.session');
    if (!row) return;
    const s = draft.sessions[row.dataset.i];
    const dayBtn = e.target.closest('[data-day]');
    if (dayBtn) {
      s.days[dayBtn.dataset.day] = !s.days[dayBtn.dataset.day];
      dayBtn.classList.toggle('on');
    } else if (e.target.closest('[data-remove]')) {
      draft.sessions.splice(row.dataset.i, 1);
      sess.innerHTML = sessionsEditor();
    }
  });
  $('add-session').onclick = () => {
    draft.sessions.push({ start: '09:00', end: '12:00', days: [true, true, true, true, true, false, false] });
    sess.innerHTML = sessionsEditor();
  };

  $('use-location').onclick = () => {
    if (!navigator.geolocation) { toast('位置情報が使えません'); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude, longitude } = pos.coords;
      draft.mapUrl = `https://www.google.com/maps/search/?api=1&query=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
      $('f-map').value = draft.mapUrl;
      toast('現在地を登録しました');
    }, () => toast('現在地を取得できませんでした'), { enableHighAccuracy: true, timeout: 10000 });
  };

  // AI 読み取り
  const aiRun = async (btn, input) => {
    const label = btn.innerHTML;
    document.querySelectorAll('.ai button, .ai label.btn').forEach((b) => b.classList.add('busy'));
    btn.innerHTML = '<span class="spinner sm"></span>読み取り中…';
    try {
      const data = await runExtract(input);
      if (data.sessions.length) draft.sessions = data.sessions;
      draft.reservation = data.reservation || draft.reservation;
      draft.closedOnHolidays = data.closedOnHolidays;
      for (const k of ['name', 'phone', 'address', 'notes']) if (!draft[k] && data[k]) draft[k] = data[k];
      if (catOf(draft.category).hasDept && data.department && !draft.department) draft.department = data.department;
      rerender();
      toast(data.sessions.length ? '読み取りました。内容を確認して保存してください' : NO_SESSIONS_MSG);
      document.getElementById('sessions')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      toast(e.message);
      btn.innerHTML = label;
      document.querySelectorAll('.busy').forEach((b) => b.classList.remove('busy'));
    }
  };
  $('ai-url').onclick = (e) => {
    const url = $('f-url').value.trim();
    if (!safeUrl(url)) { toast('http から始まるURLを入力してください'); return; }
    aiRun(e.currentTarget, { url });
  };
  $('ai-image').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    aiRun(e.target.closest('label'), { image: await fileToInlineImage(file) });
  };
  $('ai-text-toggle').onclick = () => { $('ai-text-box').hidden = !$('ai-text-box').hidden; };
  $('ai-text-run').onclick = (e) => {
    const text = $('ai-text').value.trim();
    if (!text) { toast('文章を貼り付けてください'); return; }
    aiRun(e.currentTarget, { text });
  };

  $('save').onclick = async (e) => {
    if (!draft.name.trim()) { toast('施設名を入力してください'); $('f-name').focus(); return; }
    const bad = draft.sessions.find((s) => !s.start || !s.end || toMin(s.start) >= toMin(s.end));
    if (bad) { toast('診療時間の開始・終了を確認してください'); return; }
    e.currentTarget.disabled = true;
    const data = {
      category: draft.category, department: draft.department || '',
      name: draft.name.trim(), url: draft.url.trim(), phone: draft.phone.trim(),
      address: draft.address.trim(), mapUrl: draft.mapUrl.trim(), notes: draft.notes.trim(),
      reservation: !!draft.reservation, closedOnHolidays: !!draft.closedOnHolidays,
      sessions: draft.sessions.map((s) => ({ start: s.start, end: s.end, days: s.days.map(Boolean) })),
      updatedAt: serverTimestamp(),
    };
    try {
      // オフライン時も即座に画面遷移できるよう、書き込み完了を待たない
      let newId = id;
      if (id) updateDoc(doc(facilitiesRef(), id), data).catch((err) => toast(`保存に失敗しました: ${err.message}`));
      else {
        const ref = doc(facilitiesRef());
        newId = ref.id;
        setDoc(ref, { ...data, createdAt: serverTimestamp() }).catch((err) => toast(`保存に失敗しました: ${err.message}`));
      }
      draft = null;
      toast('保存しました');
      go(`#/f/${newId}`);
    } catch (err) {
      toast(`保存に失敗しました: ${err.message}`);
      e.currentTarget.disabled = false;
    }
  };
  if ($('delete')) {
    $('delete').onclick = () => {
      if (!confirm(`「${draft.name}」を削除しますか？`)) return;
      const cat = catOf(draft.category);
      const back = cat.hasDept ? `#/c/${cat.id}/${encodeURIComponent(draft.department)}` : `#/c/${cat.id}`;
      deleteDoc(doc(facilitiesRef(), id)).catch((err) => toast(`削除に失敗しました: ${err.message}`));
      draft = null;
      toast('削除しました');
      go(back);
    };
  }

  function rerender() {
    const y = window.scrollY;
    $app.innerHTML = viewEditor(id);
    bindEditor(id);
    window.scrollTo(0, y);
  }
}

const NO_SESSIONS_MSG = 'このページに診療時間が見つかりませんでした。診療案内のページのURLや画像でお試しください';

async function runExtract(input) {
  const apiKey = state.settings.geminiApiKey;
  const model = state.settings.geminiModel || DEFAULT_SETTINGS.geminiModel;
  try {
    return await extractSchedule({ apiKey, model, ...input });
  } catch (e) {
    // 保存済みのモデルが提供終了した場合は既定のモデルで再試行
    if (e.code !== 'model_unavailable' || model === DEFAULT_SETTINGS.geminiModel) throw e;
    const data = await extractSchedule({ apiKey, model: DEFAULT_SETTINGS.geminiModel, ...input });
    setDoc(userRef(), { geminiModel: DEFAULT_SETTINGS.geminiModel }, { merge: true }).catch(() => {});
    return data;
  }
}

// ---------- 設定 ----------
function viewSettings() {
  const s = state.settings;
  return `${header({ title: '設定', back: '#/' })}
  <main class="page form">
    <section class="card">
      <div class="card-title">${icon('stethoscope')}表示する診療科</div>
      <div class="chips">${ALL_DEPTS.map((d) => `<button type="button" class="chip ${s.departments.includes(d) ? 'on' : ''}" data-dept="${esc(d)}">${esc(d)}</button>`).join('')}</div>
    </section>

    <section class="card">
      <div class="card-title">${icon('key')}Gemini API</div>
      <p class="muted-text">URLや画像からの自動読み取りに使います。キーは Google AI Studio で無料で発行できます。</p>
      <label class="field"><span>API キー</span><input id="s-key" type="password" autocomplete="off" value="${esc(s.geminiApiKey)}" placeholder="AIza..."></label>
      <label class="field"><span>モデル</span><input id="s-model" value="${esc(s.geminiModel)}" placeholder="gemini-flash-latest"></label>
      <button class="btn primary block" id="s-save">${icon('check')}保存</button>
    </section>

    <section class="card">
      <div class="account">
        ${state.user.photoURL ? `<img src="${esc(state.user.photoURL)}" alt="" referrerpolicy="no-referrer">` : ''}
        <div><div class="row-title">${esc(state.user.displayName || '')}</div><div class="row-sub">${esc(state.user.email || '')}</div></div>
      </div>
      <button class="btn ghost block" id="logout">${icon('logout')}ログアウト</button>
    </section>
  </main>`;
}

function bindSettings() {
  document.querySelectorAll('[data-dept]').forEach((b) => {
    b.onclick = () => {
      const d = b.dataset.dept;
      const cur = new Set(state.settings.departments);
      if (cur.has(d)) { if (cur.size === 1) { toast('1つ以上選んでください'); return; } cur.delete(d); } else cur.add(d);
      const departments = ALL_DEPTS.filter((x) => cur.has(x));
      state.settings.departments = departments;
      b.classList.toggle('on');
      setDoc(userRef(), { departments }, { merge: true }).catch((err) => toast(err.message));
    };
  });
  document.getElementById('s-save').onclick = () => {
    const geminiApiKey = document.getElementById('s-key').value.trim();
    const geminiModel = document.getElementById('s-model').value.trim() || DEFAULT_SETTINGS.geminiModel;
    setDoc(userRef(), { geminiApiKey, geminiModel }, { merge: true })
      .then(() => toast('保存しました')).catch((err) => toast(err.message));
  };
  document.getElementById('logout').onclick = () => signOut(auth);
}

// 時刻表示（診療中など）を1分ごとに更新
setInterval(() => { if (state.user && !isEditing() && parseRoute().parts[0] !== 'settings') render(); }, 60000);

render();
