// Nexus window, part 4 of 6: like the Steam client — download graph, launch
// options, news, Workshop, friends' activity, profile, status and overlay settings.
// The parts are classic scripts loaded in order by index.html and share one
// global scope (see eslint.config.cjs); app-boot.js starts the window.

// ---- download graph (network and disk), like Steam's downloads page ----------------
const SPEED_WINDOW = 5 * 60 * 1000;
const speedHistory = []; // { t, net, disk }
function recordSpeed() {
  const list = Object.values(state.progress || {});
  const now = Date.now();
  const active = list.filter(p => p.speed > 0 || p.diskSpeed > 0);
  if (!active.length && !speedHistory.length) return;
  const net = active.reduce((n, p) => n + (p.speed || 0), 0);
  const disk = active.reduce((n, p) => n + (p.diskSpeed ?? p.speed ?? 0), 0);
  const last = speedHistory[speedHistory.length - 1];
  if (last && now - last.t < 900) {
    last.net = net;
    last.disk = disk;
  } else speedHistory.push({ t: now, net, disk });
  while (speedHistory.length && now - speedHistory[0].t > SPEED_WINDOW) speedHistory.shift();
}
function speedGraph() {
  if (speedHistory.length < 2 || !Object.keys(state.progress || {}).length) return '';
  const w = 800,
    h = 120,
    now = Date.now();
  const max = Math.max(1, ...speedHistory.map(s => Math.max(s.net, s.disk)));
  const x = t => (w * (1 - (now - t) / SPEED_WINDOW)).toFixed(1);
  const y = v => (h - 4 - (h - 12) * (v / max)).toFixed(1);
  const line = key => speedHistory.map(s => `${x(s.t)},${y(s[key])}`).join(' ');
  const area = `${x(speedHistory[0].t)},${h} ${line('net')} ${x(speedHistory[speedHistory.length - 1].t)},${h}`;
  const peak = Math.max(...speedHistory.map(s => s.net));
  const cur = speedHistory[speedHistory.length - 1];
  return `<section class="speed-graph" aria-label="График скорости загрузки"><div class="speed-legend"><span><i class="net"></i>Сеть <b>${bytesText(cur.net)}/с</b></span><span><i class="disk"></i>Диск <b>${bytesText(cur.disk)}/с</b></span><span>Пик <b>${bytesText(peak)}/с</b></span><span class="speed-span">последние 5 мин.</span></div><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Скорость сети и записи на диск"><polygon class="net-area" points="${area}"/><polyline class="net" points="${line('net')}"/><polyline class="disk" points="${line('disk')}"/></svg></section>`;
}

// ---- game page: launch options, news, Workshop ------------------------------------------
function launchOptionsBox(g) {
  if (demo || !g.offers?.length) return '';
  const value = state.settings.launchOptions?.[g.id] || '';
  const steam = g.offers.some(o => o.provider === 'steam');
  return `<h2>ПАРАМЕТРЫ ЗАПУСКА</h2><form id="launch-options-form" class="inline-form" data-game="${esc(g.id)}"><input id="launch-options" maxlength="500" placeholder="например: -novid -fullscreen" value="${esc(value)}" aria-label="Параметры запуска"><button class="secondary" type="submit">Сохранить</button></form><p class="hint">Передаются игре при запуске из Nexus${steam ? '; Steam может спросить подтверждение при первом запуске с ними' : ''}. Пусто — без параметров.</p>`;
}
const newsState = new Map(); // game id → { loading } | { available, items } | { error }
async function requestNews(id) {
  if (!api?.gameNews || demo || newsState.has(id)) return;
  newsState.set(id, { loading: true });
  try {
    newsState.set(id, await call('gameNews', id));
  } catch (e) {
    newsState.set(id, { error: e.message });
  }
  if (librarySelection === id) render();
}
function newsDate(t) {
  return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function newsItem(x, withGame = false) {
  const img = safeImage(x.image);
  return `<article class="news-item ${x.patch ? 'patch' : ''}">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<div><small>${x.patch ? '<b class="news-tag">ОБНОВЛЕНИЕ</b> ' : ''}${withGame && x.game ? `<button class="link" data-detail="${esc(x.gameId)}">${esc(x.game)}</button> · ` : ''}${esc(newsDate(x.date))}${x.source ? ' · ' + esc(x.source) : ''}</small><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p>${x.url ? `<button class="link" data-open-link="${esc(x.url)}">Читать полностью ↗</button>` : ''}</div></article>`;
}
function newsBox(g) {
  if (demo) return '';
  requestNews(g.id);
  const n = newsState.get(g.id);
  if (!n || n.loading)
    return '<h2>НОВОСТИ</h2><div class="library-activity-box"><p class="hint">Загружаем…</p></div>';
  if (n.error)
    return `<h2>НОВОСТИ</h2><div class="library-activity-box"><p class="watch-error">${esc(n.error)}</p></div>`;
  if (!n.available || !Array.isArray(n.items)) return '';
  return `<h2>НОВОСТИ И ОБНОВЛЕНИЯ</h2><div class="news-list">${
    n.items.length
      ? n.items
          .slice(0, 6)
          .map(x => newsItem(x))
          .join('')
      : '<p class="hint">Новостей пока нет.</p>'
  }</div>`;
}
const workshopState = new Map();
async function requestWorkshop(id) {
  if (!api?.workshop || demo || workshopState.has(id)) return;
  workshopState.set(id, { loading: true });
  try {
    workshopState.set(id, await call('workshop', id));
  } catch (e) {
    workshopState.set(id, { error: e.message });
  }
  if (librarySelection === id) render();
}
function workshopBox(g) {
  if (demo || !g.offers?.some(o => o.provider === 'steam')) return '';
  requestWorkshop(g.id);
  const w = workshopState.get(g.id);
  if (!w || w.loading) return '';
  if (w.error)
    return `<h2>МАСТЕРСКАЯ</h2><div class="library-activity-box"><p class="watch-error">${esc(w.error)}</p></div>`;
  if (!w.available || !Array.isArray(w.items))
    return `<h2>МАСТЕРСКАЯ</h2><div class="library-activity-box"><p class="hint">${esc(w.reason)}</p></div>`;
  const head = `<div class="workshop-head"><span>${w.total ? `${w.total} ${plural(w.total, 'предмет', 'предмета', 'предметов')} · ${bytesText(w.size)}` : 'Подписок нет'}${w.needsUpdate ? ' · Steam обновит при запуске' : ''}</span><span><button class="secondary" data-workshop-app="${esc(w.appId)}">Мастерская ↗</button>${w.total ? `<button class="secondary" data-workshop-folder="${esc(w.folder)}" title="Открыть папку">📁</button>` : ''}</span></div>`;
  return `<h2>МАСТЕРСКАЯ</h2><div class="library-activity-box workshop">${head}${w.items
    .slice(0, 12)
    .map(
      x =>
        `<button class="workshop-item" data-workshop-item="${esc(x.id)}" title="Открыть страницу предмета">${safeImage(x.preview) ? `<img src="${esc(safeImage(x.preview))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="workshop-noimg">◫</span>'}<span><strong>${esc(x.title || 'Предмет ' + x.id)}</strong><small>${bytesText(x.size)}${x.updated ? ' · ' + new Date(x.updated).toLocaleDateString('ru-RU') : ''}</small></span></button>`
    )
    .join(
      ''
    )}${w.items.length > 12 ? `<p class="hint">Показаны 12 из ${w.total}. Остальные — на странице Мастерской.</p>` : ''}</div>`;
}

// ---- pages: friends' activity, news, profile -------------------------------------------
let activityState = { loading: false, list: null, error: '' };
async function loadActivity() {
  if (!api?.activity || demo || activityState.loading) return;
  activityState = { ...activityState, loading: true };
  try {
    const list = await call('activity');
    activityState = { loading: false, list: Array.isArray(list) ? list : [], error: '' };
  } catch (e) {
    activityState = { loading: false, list: activityState.list || [], error: e.message };
  }
  if (page === 'activity') render();
}
const ACTIVITY_VERBS = { online: 'теперь в сети', game: 'начал(а) играть в', stop: 'закончил(а) играть в' };
function activityDay(t) {
  const d = new Date(t),
    today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  return days === 0
    ? 'Сегодня'
    : days === 1
      ? 'Вчера'
      : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
function activityPage() {
  if (!activityState.list && !activityState.loading) loadActivity();
  const list = (activityState.list || []).filter(
    x => !query || (x.name + ' ' + (x.game || '')).toLowerCase().includes(query.toLowerCase())
  );
  let day = '';
  const rows = list
    .map(x => {
      const d = activityDay(x.at);
      const head = d !== day ? `<h2 class="activity-day">${esc((day = d))}</h2>` : '';
      const lib = x.appId
        ? activeGames().find(g =>
            g.offers?.some(o => o.provider === 'steam' && String(o.appId) === String(x.appId))
          )
        : null;
      const avatar = safeImage(x.avatar);
      return `${head}<div class="activity-item ${esc(x.type)}"><span class="profile-avatar">${avatar ? `<img src="${esc(avatar)}" alt="" referrerpolicy="no-referrer">` : esc((x.name || '?').slice(0, 1))}</span><div><p><strong>${esc(x.name)}</strong> ${esc(ACTIVITY_VERBS[x.type] || '')}${x.type !== 'online' ? ` <b>${lib ? `<button class="link" data-detail="${esc(lib.id)}">${esc(x.game || lib.name)}</button>` : esc(x.game || 'игру')}</b>` : ''}</p><small>${new Date(x.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · ${x.provider === 'steam' ? 'Steam' : 'Epic Games'}</small></div>${x.provider === 'steam' ? `<button class="secondary" data-activity-chat="${esc(x.conv)}">Написать</button>` : ''}</div>`;
    })
    .join('');
  return `${notice()}<div class="section-head"><h1>Активность друзей</h1><button class="secondary" id="activity-refresh">↻ Обновить</button></div><p class="subheading">Кто из друзей Steam и Epic Games заходил в сеть и во что играл. Nexus записывает это, пока он запущен (в том числе в трее); записи хранятся неделю.</p>${activityState.error ? `<p class="watch-error">${esc(activityState.error)}</p>` : ''}${
    rows ||
    `<div class="empty"><h2>${activityState.loading ? 'Загружаем…' : 'Пока ничего не произошло'}</h2><p>Статус «Не подключаться» в настройках отключает отслеживание.</p></div>`
  }`;
}
let newsFeedState = { loading: false, list: null, error: '', at: 0 };
async function loadNewsFeed(force = false) {
  if (!api?.newsFeed || demo || newsFeedState.loading) return;
  if (!force && newsFeedState.list && Date.now() - newsFeedState.at < 30 * 60 * 1000) return;
  newsFeedState = { ...newsFeedState, loading: true };
  try {
    const list = await call('newsFeed');
    newsFeedState = { loading: false, list: Array.isArray(list) ? list : [], error: '', at: Date.now() };
  } catch (e) {
    newsFeedState = { loading: false, list: newsFeedState.list || [], error: e.message, at: Date.now() };
  }
  if (page === 'news' || page === 'library') render();
}
function newsPage() {
  loadNewsFeed();
  const list = (newsFeedState.list || []).filter(
    x => !query || (x.title + ' ' + x.game).toLowerCase().includes(query.toLowerCase())
  );
  return `${notice()}<div class="section-head"><h1>Новости ваших игр</h1><button class="secondary" id="news-refresh">↻ Обновить</button></div><p class="subheading">Обновления и новости недавно запущенных и установленных игр за последние два месяца (из Steam).</p>${newsFeedState.error ? `<p class="watch-error">${esc(newsFeedState.error)}</p>` : ''}${
    list.length
      ? `<div class="news-list wide">${list.map(x => newsItem(x, true)).join('')}</div>`
      : `<div class="empty"><h2>${newsFeedState.loading || !newsFeedState.list ? 'Загружаем новости…' : 'Новостей нет'}</h2></div>`
  }`;
}
// "Что нового" on the library page: the newest posts as a shelf.
function newsShelf() {
  if (demo || !api?.newsFeed) return '';
  loadNewsFeed();
  const list = (newsFeedState.list || []).slice(0, 4);
  if (!list.length) return '';
  return `<div class="shelf-title"><h2>Что нового</h2><button class="link" data-page="news">Все новости →</button></div><div class="news-shelf">${list
    .map(
      x =>
        `<button class="news-card" data-open-link="${esc(x.url)}">${safeImage(x.image) ? `<img src="${esc(safeImage(x.image))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="news-card-game">${esc(x.game)}</span>`}<small>${x.patch ? '<b class="news-tag">ОБНОВЛЕНИЕ</b> ' : ''}${esc(x.game)} · ${esc(new Date(x.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }))}</small><strong>${esc(x.title)}</strong></button>`
    )
    .join('')}</div>`;
}
let profileState = { loading: false, data: null, error: '' };
async function loadProfile() {
  if (!api?.profile || demo || profileState.loading) return;
  profileState = { ...profileState, loading: true };
  try {
    const data = await call('profile');
    profileState = data?.stats
      ? { loading: false, data, error: '' }
      : { loading: false, data: null, error: 'Профиль недоступен' };
  } catch (e) {
    profileState = { loading: false, data: profileState.data, error: e.message };
  }
  if (page === 'profile') render();
}
function profilePage() {
  if (!profileState.data && !profileState.loading && !profileState.error) loadProfile();
  const d = profileState.data;
  if (!d)
    return `${notice()}<div class="empty"><h2>${esc(profileState.error || 'Загружаем профиль…')}</h2></div>`;
  const s = d.stats;
  const h = m => (m / 60).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  const accounts = d.accounts.length
    ? d.accounts
        .map(
          a =>
            `<div class="profile-card ${a.provider}"><span class="profile-big-avatar">${safeImage(a.avatar) ? `<img src="${esc(safeImage(a.avatar))}" alt="" referrerpolicy="no-referrer">` : a.provider === 'steam' ? 'S' : 'E'}</span><div><small>${a.provider === 'steam' ? 'Steam' : 'Epic Games'}</small><h2>${esc(a.name)}</h2>${
              a.provider === 'steam' && a.level !== undefined
                ? `<p><span class="steam-level">${a.level}</span> уровень · ${a.badges} ${plural(a.badges, 'значок', 'значка', 'значков')} · ${a.xp.toLocaleString('ru-RU')} XP${a.xpNeeded ? ` · до следующего уровня ${a.xpNeeded.toLocaleString('ru-RU')} XP` : ''}</p>`
                : '<p class="hint">' +
                  (a.provider === 'steam' ? 'Уровень Steam недоступен' : 'Уровней у Epic Games нет') +
                  '</p>'
            }${a.provider === 'steam' && a.id ? `<button class="link" data-open-link="https://steamcommunity.com/profiles/${esc(a.id)}/">Профиль в Steam ↗</button>` : ''}</div></div>`
        )
        .join('')
    : '<p class="hint">Подключите Steam или Epic Games в «Аккаунтах».</p>';
  const top = s.top.length
    ? s.top
        .map((g, i) => {
          const w = Math.max(2, Math.round((g.minutes / s.top[0].minutes) * 100));
          return `<button class="top-game" data-detail="${esc(g.id)}"><span class="top-rank">${i + 1}</span><span class="top-name">${esc(g.name)}</span><span class="top-bar"><i style="width:${w}%"></i></span><b>${h(g.minutes)} ч</b></button>`;
        })
        .join('')
    : '<p class="hint">Время в играх появится после синхронизации аккаунтов.</p>';
  const by = s.byProvider;
  const tile = (value, label) =>
    `<div class="stat-tile"><strong>${value}</strong><small>${label}</small></div>`;
  return `${notice()}<div class="section-head"><h1>Профиль</h1><button class="secondary" id="profile-refresh">↻ Обновить</button></div><div class="profile-accounts">${accounts}</div><div class="stat-tiles">${tile(s.games.toLocaleString('ru-RU'), 'игр в библиотеке')}${tile(s.installed, 'установлено')}${tile(h(s.minutes), 'часов в играх')}${tile(s.played, 'запускались')}${tile(s.neverPlayed, 'ни разу не запускались')}${tile(s.playedThisMonth, 'за последние 30 дней')}</div><div class="profile-columns"><section><h2>БОЛЬШЕ ВСЕГО ВРЕМЕНИ</h2><div class="top-games">${top}</div></section><section><h2>ПО ПЛАТФОРМАМ</h2><div class="platform-split">${[
    ['steam', 'Steam'],
    ['epic', 'Epic Games'],
    ['custom', 'Добавленные вручную'],
  ]
    .filter(([p]) => by[p].games)
    .map(
      ([p, n]) =>
        `<div><b>${n}</b><span>${by[p].games} ${plural(by[p].games, 'игра', 'игры', 'игр')} · ${h(by[p].minutes)} ч</span></div>`
    )
    .join('')}</div><h2>ПОСЛЕДНИЕ ДОСТИЖЕНИЯ</h2>${
    d.achievements.length
      ? `<div class="achievements"><ul>${d.achievements
          .map(
            x =>
              `<li class="done">${safeImage(x.icon) ? `<img src="${esc(safeImage(x.icon))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="achievement-icon"></span>'}<span><strong>${esc(x.name)}</strong><small>${esc(x.game)} · ${new Date(x.at).toLocaleDateString('ru-RU')}</small></span></li>`
          )
          .join('')}</ul></div>`
      : '<p class="hint">Достижения появятся здесь после того, как вы откроете страницы игр Steam (Nexus загружает их по запросу).</p>'
  }</section></div>`;
}

// ---- settings: status, notifications, tray, overlay ---------------------------------------
const OVERLAY_KEYS = ['Shift+Tab', 'Shift+F1', 'Ctrl+Shift+O', 'Alt+F12'];
function socialCard() {
  const s = state.settings;
  const off = demo ? 'disabled' : '';
  const check = (name, label, def = true) =>
    `<label class="check"><input type="checkbox" data-presence-setting="${name}" ${(def ? s[name] !== false : s[name] === true) ? 'checked' : ''} ${off}> ${label}</label>`;
  const status = s.myStatus || 'online';
  return `<section class="settings-card social-card"><h3>Статус и уведомления</h3><p>Как в клиенте Steam: статус для друзей, их статусы в реальном времени и уведомления. Статус передаётся через чат Steam и Epic Games.</p><label class="field">Мой статус <select id="my-status-select" ${off}>${[
    ['online', 'В сети'],
    ['away', 'Нет на месте'],
    ['invisible', 'Невидимка'],
    ['off', 'Не подключаться (без статусов друзей и уведомлений)'],
  ]
    .map(([v, n]) => `<option value="${v}" ${status === v ? 'selected' : ''}>${n}</option>`)
    .join(
      ''
    )}</select></label>${check('showPlaying', 'Показывать друзьям, во что я играю (игры Epic и добавленные вручную — как «… · Nexus»)')}${check('notifyFriendGame', 'Уведомлять, когда друг начинает играть')}${check('notifyFriendOnline', 'Уведомлять, когда друг заходит в сеть', false)}${check('notifyAchievements', 'Уведомлять о новых достижениях во время игры')}</section><section class="settings-card"><h3>Трей и запуск</h3>${check('closeToTray', 'Закрывать в трей: кнопка × оставляет Nexus работать в фоне (загрузки, чат, статус)')}${check('startHidden', 'При запуске вместе с Windows сразу сворачивать в трей', false)}<p class="hint">Выйти из Nexus — в меню значка в трее.</p></section><section class="settings-card overlay-card"><h3>Оверлей в игре</h3><p>Поверх игры: друзья и чат, достижения, время сессии, счётчик FPS. Работает в играх в окне и в «полноэкранном окне»; поверх эксклюзивного полноэкранного режима окна Windows не показываются.</p>${check('overlay', 'Включить оверлей')}<label class="field">Сочетание клавиш <select id="overlay-hotkey" ${off}>${OVERLAY_KEYS.map(k => `<option ${(s.overlayHotkey || 'Shift+Tab') === k ? 'selected' : ''}>${k}</option>`).join('')}</select><small>Работает, только пока запущена игра.</small></label><p class="hint">Счётчик FPS включается в самом оверлее. Для него нужен PresentMon: он уже есть в AMD Software и в Intel PresentMon.</p></section>`;
}

// ---- events of this part -------------------------------------------------------------
document.addEventListener('click', event =>
  run(async () => {
    const el = event.target.closest('button');
    if (!el || el.disabled) return;
    if (el.dataset.openLink) await call('openLink', el.dataset.openLink);
    else if (el.dataset.workshopItem) await call('openWorkshop', { id: el.dataset.workshopItem });
    else if (el.dataset.workshopApp) await call('openWorkshop', { appId: el.dataset.workshopApp });
    else if (el.dataset.workshopFolder) await call('openWorkshop', { folder: el.dataset.workshopFolder });
    else if (el.dataset.activityChat) await call('openChat', el.dataset.activityChat);
    else if (el.id === 'activity-refresh') {
      activityState = { loading: false, list: null, error: '' };
      render();
    } else if (el.id === 'news-refresh') loadNewsFeed(true);
    else if (el.id === 'profile-refresh') {
      profileState = { loading: false, data: null, error: '' };
      render();
    }
  })
);
document.addEventListener(
  'submit',
  event => {
    if (event.target.id !== 'launch-options-form') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    run(async () => {
      const id = event.target.dataset.game;
      state = await call('setLaunchOptions', { id, options: $('#launch-options').value });
      render();
      toast(state.settings.launchOptions?.[id] ? 'Параметры запуска сохранены' : 'Параметры запуска убраны');
    });
  },
  true
);
document.addEventListener('change', event =>
  run(async () => {
    const el = event.target;
    if (el.dataset?.presenceSetting) {
      state = await call('presenceSetting', { name: el.dataset.presenceSetting, value: el.checked });
      render();
    } else if (el.id === 'overlay-hotkey') {
      state = await call('presenceSetting', { name: 'overlayHotkey', value: el.value });
      render();
    } else if (el.id === 'my-status-select') {
      await call('setStatus', el.value);
      state = await call('stateUpdate');
      render();
    }
  })
);
// The friends' activity and my status change without the main window asking.
api?.onSocialEvent?.(ev => {
  if (ev.type === 'activity' && activityState.list) {
    activityState.list = [ev.entry, ...activityState.list];
    if (page === 'activity') render();
  }
  if (ev.type === 'my-status' && state.settings.myStatus !== ev.status) {
    state.settings.myStatus = ev.status;
    if (page === 'accounts') render();
  }
});
