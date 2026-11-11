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
// The profile is loaded for a set of connected accounts (accounts): when the set changes
// (a sign-in that finished after the profile was opened, a new account) it loads again.
let profileState = { loading: false, data: null, error: '', accounts: '' };
function connectedAccountKeys() {
  return (state?.accountList || [])
    .filter(a => a.status === 'connected')
    .map(a => a.key)
    .sort()
    .join(',');
}
async function loadProfile(force = false) {
  if (!api?.profile || demo || profileState.loading) return;
  const accounts = connectedAccountKeys();
  profileState = { ...profileState, loading: true, accounts };
  if (page === 'profile') render();
  try {
    const data = await call('profile', { force });
    profileState = data?.stats
      ? { loading: false, data, error: '', accounts }
      : { loading: false, data: null, error: 'Профиль недоступен', accounts };
  } catch (e) {
    profileState = { loading: false, data: profileState.data, error: e.message, accounts };
  }
  if (page === 'profile') render();
}
// After a state update: the profile of other accounts than the shown one is reloaded.
function refreshProfileIfAccountsChanged() {
  if (page !== 'profile' || profileState.loading || (!profileState.data && !profileState.error)) return;
  if (profileState.accounts !== connectedAccountKeys()) loadProfile(true);
}
// ---- building blocks of the Steam-style profile pages (mine, Epic, a friend's) ------
// Hours from minutes: one decimal under ten hours.
function spHours(m) {
  return (m / 60).toLocaleString('ru-RU', { maximumFractionDigits: m < 600 ? 1 : 0 });
}
// The page with its Steam background; the header and the body go inside.
function spShell(cls, bg, inner) {
  const classes = ['sp', cls, bg ? 'has-bg' : ''].filter(Boolean).join(' ');
  const style = bg ? ` style="--sp-bg:url('${esc(bg)}')"` : '';
  return `<div class="${classes}"${style}><div class="sp-inner">${inner}</div></div>`;
}
function spHeader(avatarClass, avatar, identity, side) {
  return `<header class="sp-header"><div class="sp-avatar ${avatarClass}">${avatar}</div><div class="sp-id">${identity}</div><div class="sp-side">${side}</div></header>`;
}
// The two columns; `after` (the comments) follows them under the whole width.
function spBody(main, right, after = '') {
  return `<div class="sp-body"><div class="sp-main">${main}</div><aside class="sp-right">${right}</aside></div>${after}`;
}
function spPanel(title, body, extra = '') {
  return `<section class="sp-panel"><div class="sp-panel-head"><span>${title}</span>${extra}</div>${body}</section>`;
}
// A line of the right column; a button when it opens a list.
function spStat(label, value, attrs = '') {
  if (value === null || value === undefined || value === '') return '';
  const name = attrs ? `<button class="sp-stat-link" ${attrs}>${label}</button>` : `<span>${label}</span>`;
  return `<div class="sp-stat">${name}<b>${value}</b></div>`;
}
function spAvatar(src, name) {
  return src
    ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer">`
    : `<b>${esc((name || '?').slice(0, 1).toUpperCase())}</b>`;
}
function spFrame(src) {
  return safeImage(src)
    ? `<img class="sp-frame" src="${esc(safeImage(src))}" alt="" referrerpolicy="no-referrer">`
    : '';
}
function spRealLine(realName, location) {
  const line = [realName, location].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
  return line ? `<p class="sp-real">${line}</p>` : '';
}
// A Steam game: its page in Nexus when the game is in the library, the Steam store otherwise.
function spOpen(g) {
  return g.gameId
    ? `data-detail="${esc(g.gameId)}"`
    : `data-open-link="https://store.steampowered.com/app/${esc(g.appId)}/"`;
}
// The library art first; the store image (hashed paths of new games) when that is missing.
function spCover(appId, image, caption = '') {
  const fallback = safeImage(image) ? `data-fallback="${esc(safeImage(image))}"` : '';
  const time = caption ? `<span class="sp-game-time">${caption}</span>` : '';
  return `<span class="friend-game-art"><img src="nexus-art://steam/${encodeURIComponent(appId)}/header" ${fallback} alt="" loading="lazy">${time}</span>`;
}
// A Steam game tile of «Недавняя активность».
function spGameTile(x, caption) {
  return `<button class="sp-game" ${spOpen(x)} title="${esc(x.name)}">${spCover(x.appId, x.image, caption)}<span class="sp-game-name">${esc(x.name)}</span></button>`;
}
// «Больше всего времени»: bars against the first game.
function spTopRows(list, attrs, name, hours = spHours) {
  return list
    .map((x, i) => {
      const w = Math.max(2, Math.round((x.minutes / list[0].minutes) * 100));
      return `<button class="top-game" ${attrs(x)}><span class="top-rank">${i + 1}</span><span class="top-name">${esc(name(x))}</span><span class="top-bar"><i style="width:${w}%"></i></span><b>${hours(x.minutes)} ч</b></button>`;
    })
    .join('');
}
function spAchievements(list, empty) {
  if (!list.length) return `<p class="hint">${empty}</p>`;
  const row = x => {
    const icon = safeImage(x.icon)
      ? `<img src="${esc(safeImage(x.icon))}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : '<span class="achievement-icon"></span>';
    return `<li class="done">${icon}<span><strong>${esc(x.name)}</strong><small>${esc(x.game)} · ${new Date(x.at).toLocaleDateString('ru-RU')}</small></span></li>`;
  };
  return `<div class="achievements"><ul>${list.map(row).join('')}</ul></div>`;
}
// My status: in game when Nexus runs one, otherwise the status set for friends.
function spPresence(status, runningId, ingameText) {
  if (runningId) return { status: 'ingame', text: ingameText };
  const text = { online: 'В сети', away: 'Нет на месте', invisible: 'Невидимка', offline: 'Не в сети' };
  return {
    status: status === 'away' ? 'away' : status === 'online' ? 'online' : 'offline',
    text: text[status] || 'В сети',
  };
}
function spStatusBox(presence) {
  return `<div class="sp-status ${esc(presence.status)}"><strong>${esc(presence.text)}</strong></div>`;
}
function spRefreshButton() {
  return `<button class="secondary" id="profile-refresh" title="Обновить" ${profileState.loading ? 'disabled' : ''}>↻</button>`;
}
// "Профиль" laid out like my Steam profile page: the Steam background, frame and
// «О себе» on top, Nexus statistics of every store below.
function myProfilePage(d) {
  const sp = d.steamProfile;
  const steam = d.accounts.find(a => a.provider === 'steam') || {};
  const id = sp.id || steam.id;
  const runningId = Object.keys(state.running || {})[0];
  const runningName = runningId ? game(runningId)?.name || '' : '';
  const presence = spPresence(d.status, runningId, 'В игре' + (runningName ? ': ' + runningName : ''));
  return spShell(
    'my-profile',
    safeImage(sp.background),
    myProfileHeader(sp, steam, id, presence) +
      spBody(myProfileMain(d, sp), myProfileSide(d, sp, steam, id, presence), commentsBox(id))
  );
}
function myProfileHeader(sp, steam, id, presence) {
  const avatar = spAvatar(safeImage(sp.avatar) || safeImage(steam.avatar), sp.name || steam.name);
  const summary = sp.summary
    ? `<p class="sp-summary">${esc(sp.summary)}</p>`
    : '<p class="sp-summary hint">«О себе» пусто — заполните его в Steam.</p>';
  const level = sp.level ?? steam.level;
  const xpLine =
    steam.xp !== undefined
      ? `<p class="sp-xp">${steam.xp.toLocaleString('ru-RU')} XP${steam.xpNeeded ? ` · до следующего уровня ${steam.xpNeeded.toLocaleString('ru-RU')} XP` : ''}</p>`
      : '';
  const levelBox =
    level !== null && level !== undefined
      ? `<div class="sp-level">Уровень <span class="steam-level">${level}</span></div>${xpLine}`
      : '';
  const links = id
    ? `<button class="primary" data-open-link="https://steamcommunity.com/profiles/${esc(id)}/edit/info">Редактировать профиль ↗</button><button class="secondary" data-open-link="https://steamcommunity.com/profiles/${esc(id)}/">Открыть в Steam ↗</button>`
    : '';
  return spHeader(
    esc(presence.status),
    avatar + spFrame(sp.frame),
    `<h1>${esc(sp.name || steam.name || 'Мой профиль')}</h1>${spRealLine(sp.realName, sp.location)}${summary}`,
    `${levelBox}<div class="sp-actions">${links}${spRefreshButton()}</div>`
  );
}
function myProfileMain(d, sp) {
  const s = d.stats;
  // Steam's "Недавняя активность" (two weeks), as on the Steam page.
  const recentList = sp.recent || [];
  const recentMinutes = recentList.reduce((n, x) => n + (x.minutes2w || 0), 0);
  const recent = recentList.length
    ? `<div class="sp-games">${recentList
        .map(x =>
          spGameTile(x, `<b>${spHours(x.minutes2w || 0)} ч</b> за 2 недели<br>${spHours(x.minutes)} ч всего`)
        )
        .join('')}</div>`
    : '<p class="hint">За последние две недели игр в Steam не было.</p>';
  // Most played across every store (Nexus counts Steam, Epic and its own launches).
  const top = s.top.length
    ? `<div class="top-games">${spTopRows(
        s.top,
        g => `data-detail="${esc(g.id)}"`,
        g => game(g.id)?.name || g.name
      )}</div>`
    : '<p class="hint">Время в играх появится после синхронизации аккаунтов.</p>';
  return (
    spPanel(
      'Недавняя активность',
      recent,
      recentMinutes ? `<small>${spHours(recentMinutes)} ч за последние 2 недели</small>` : ''
    ) +
    spPanel('Больше всего времени', top, '<small>Steam, Epic Games и Nexus</small>') +
    spPanel(
      'Последние достижения',
      spAchievements(
        d.achievements,
        'Достижения появятся здесь после того, как вы откроете страницы игр Steam.'
      )
    )
  );
}
// «12 игр · из семьи: 30» (Steam Families games are counted apart from the account's own).
function platformCount(x) {
  const own = `${x.games} ${plural(x.games, 'игра', 'игры', 'игр')}`;
  return x.family ? `${own} · из семьи: ${x.family}` : own;
}
function myProfileSide(d, sp, steam, id, presence) {
  const s = d.stats;
  const by = s.byProvider;
  const platforms = [
    ['steam', 'Steam'],
    ['epic', 'Epic Games'],
    ['custom', 'Добавленные вручную'],
  ]
    .filter(([p]) => by[p]?.games || by[p]?.family)
    .map(
      ([p, n]) =>
        `<div class="sp-stat">${p === 'custom' ? `<span>${n}</span>` : `<button class="sp-stat-link" data-sp-go="owned" data-sp-source="${p}">${n}</button>`}<b>${platformCount(by[p])} · ${spHours(by[p].minutes)} ч</b></div>`
    )
    .join('');
  const epicCards = d.accounts
    .filter(a => a.provider === 'epic')
    .map(
      a =>
        `<div class="sp-account"><span class="sp-account-avatar">${safeImage(a.avatar) ? `<img src="${esc(safeImage(a.avatar))}" alt="" referrerpolicy="no-referrer">` : 'E'}</span><span><small>Epic Games</small><strong>${esc(a.name)}</strong></span></div>`
    )
    .join('');
  const stats = [
    spStat('Игр в библиотеке', s.games.toLocaleString('ru-RU'), 'data-sp-go="owned"'),
    s.family ? spStat('Из семейной библиотеки', s.family.toLocaleString('ru-RU'), 'data-sp-go="family"') : '',
    spStat('Установлено', s.installed, 'data-sp-go="installed"'),
    spStat('Часов в играх', spHours(s.minutes)),
    spStat('Запускались', s.played, 'data-sp-go="played"'),
    spStat('За последние 30 дней', s.playedThisMonth, 'data-page="recent"'),
    spStat('Значки', sp.badges ?? steam.badges, id ? `data-sp-badges="${esc(id)}"` : ''),
    spStat('В Steam с', memberSince(sp.memberSince)),
  ].join('');
  return (
    spStatusBox(presence) +
    `<div class="sp-stats">${stats}</div>` +
    (platforms ? `<div class="sp-stats"><h3>По платформам</h3>${platforms}</div>` : '') +
    (epicCards ? `<div class="sp-stats">${epicCards}</div>` : '')
  );
}
// ---- "Профиль" tabs: Steam and every Epic Games account ----------------------------
let profileTab = (() => {
  try {
    return localStorage.getItem('nexus.profileTab') || 'steam';
  } catch {
    return 'steam';
  }
})();
function setProfileTab(tab) {
  profileTab = tab;
  profileView = null;
  try {
    localStorage.setItem('nexus.profileTab', tab);
  } catch {}
  render();
}
function profileTabsPage(d) {
  const tabs = [
    ...(d.steamProfile ? [{ id: 'steam', label: 'Steam', cls: 'steam' }] : []),
    ...(d.epic || []).map((e, i, all) => ({
      id: 'epic:' + e.id,
      label: all.length > 1 ? 'Epic Games · ' + e.name : 'Epic Games',
      cls: 'epic',
      e,
    })),
  ];
  const current = tabs.find(t => t.id === profileTab) || tabs[0];
  const bar =
    tabs.length > 1
      ? `<div class="profile-tabs" role="tablist">${tabs
          .map(
            t =>
              `<button class="${t.cls} ${t === current ? 'active' : ''}" role="tab" aria-selected="${t === current}" data-profile-tab="${esc(t.id)}">${esc(t.label)}</button>`
          )
          .join('')}</div>`
      : '';
  // The tabs sit at the top of the profile card, over its background.
  const page = current.e ? epicProfilePage(d, current.e) : myProfilePage(d);
  const body = profileView ? withView(page, myProfileView(d)) : page;
  return notice() + body.replace('<div class="sp-inner">', '<div class="sp-inner">' + bar);
}
// An Epic Games account, in the look of the Epic Games Store.
function epicProfilePage(d, e) {
  const runningId = Object.keys(state.running || {}).find(id =>
    game(id)?.offers?.some(o => o.provider === 'epic')
  );
  const presence = spPresence(
    d.status,
    runningId,
    runningId ? 'В игре: ' + (game(runningId)?.name || '') : ''
  );
  const letter = esc((e.name || 'E').trim().slice(0, 1).toUpperCase());
  const country = epicCountry(e.country);
  const header = spHeader(
    'epic-avatar ' + esc(presence.status),
    `<b>${letter}</b>`,
    `<small class="epic-mark">EPIC GAMES</small><h1>${esc(e.name || 'Аккаунт Epic Games')}</h1>${
      country ? `<p class="sp-real">${esc(country)}</p>` : ''
    }`,
    `<div class="sp-actions"><button class="primary" data-open-link="https://store.epicgames.com/u/${esc(e.id)}">Профиль в Epic ↗</button><button class="secondary" data-open-link="https://www.epicgames.com/account/personal">Аккаунт ↗</button>${spRefreshButton()}</div>`
  );
  const stats = [
    spStat('Игр в Epic', e.games.toLocaleString('ru-RU'), 'data-sp-go="owned" data-sp-source="epic"'),
    spStat('Установлено', e.installed, 'data-sp-go="installed" data-sp-source="epic"'),
    spStat('Часов в играх', spHours(e.minutes)),
    spStat('Запускались', e.played, 'data-sp-go="played" data-sp-source="epic"'),
    spStat('Друзей в Epic', e.friends, 'data-sp-friends'),
  ].join('');
  return spShell(
    'epic-profile',
    '',
    header + spBody(epicProfileMain(e), spStatusBox(presence) + `<div class="sp-stats">${stats}</div>`)
  );
}
function epicCountry(code) {
  try {
    return code ? new Intl.DisplayNames(['ru'], { type: 'region' }).of(code) : '';
  } catch {
    return code;
  }
}
function epicProfileMain(e) {
  const cover = (id, caption = '') => {
    const g = game(id);
    return `<span class="friend-game-art">${g ? artTag(g) : ''}${caption ? `<span class="sp-game-time">${caption}</span>` : ''}</span>`;
  };
  const tile = x => {
    const name = esc(game(x.id)?.name || x.name);
    const started = new Date(x.lastPlayed).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const caption = `${x.minutes ? `<b>${spHours(x.minutes)} ч</b> всего<br>` : ''}запуск ${started}`;
    return `<button class="sp-game" data-detail="${esc(x.id)}" title="${name}">${cover(x.id, caption)}<span class="sp-game-name">${name}</span></button>`;
  };
  const recent = e.recent.length
    ? `<div class="sp-games">${e.recent.map(tile).join('')}</div><p class="hint">Epic не сообщает даты запусков другим программам — здесь игры, запущенные через Nexus.</p>`
    : '<p class="hint">Epic не сообщает даты запусков другим программам. Игры, запущенные через Nexus, появятся здесь.</p>';
  const top = e.top.length
    ? `<div class="top-games">${spTopRows(
        e.top,
        g => `data-detail="${esc(g.id)}"`,
        g => game(g.id)?.name || g.name
      )}</div>`
    : '<p class="hint">Время в играх Epic появится после синхронизации аккаунта.</p>';
  return (
    spPanel('Недавно запущенные', recent) +
    spPanel('Больше всего времени', top, e.minutes ? `<small>${spHours(e.minutes)} ч всего</small>` : '')
  );
}
function profilePage() {
  if (
    !profileState.loading &&
    ((!profileState.data && !profileState.error) || profileState.accounts !== connectedAccountKeys())
  )
    setTimeout(() => loadProfile(!!(profileState.data || profileState.error)));
  const d = profileState.data;
  if (!d)
    return `${notice()}<div class="empty"><h2>${esc(profileState.error || 'Загружаем профиль…')}</h2></div>`;
  if (d.steamProfile || d.epic?.length) return profileTabsPage(d);
  if (!d.accounts.length) return profileEmptyPage(d);
  const s = d.stats;
  const h = m => (m / 60).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  const accounts = d.accounts.length
    ? d.accounts.map(profileAccountCard).join('')
    : '<p class="hint">Подключите Steam или Epic Games в «Аккаунтах».</p>';
  const top = s.top.length
    ? spTopRows(
        s.top,
        g => `data-detail="${esc(g.id)}"`,
        g => game(g.id)?.name || g.name,
        h
      )
    : '<p class="hint">Время в играх появится после синхронизации аккаунтов.</p>';
  const tile = (value, label) =>
    `<div class="stat-tile"><strong>${value}</strong><small>${label}</small></div>`;
  const tiles = [
    tile(s.games.toLocaleString('ru-RU'), 'игр в библиотеке'),
    ...(s.family ? [tile(s.family.toLocaleString('ru-RU'), 'из семейной библиотеки')] : []),
    tile(s.installed, 'установлено'),
    tile(h(s.minutes), 'часов в играх'),
    tile(s.played, 'запускались'),
    tile(s.neverPlayed, 'ни разу не запускались'),
    tile(s.playedThisMonth, 'за последние 30 дней'),
  ].join('');
  const by = s.byProvider;
  const platforms = [
    ['steam', 'Steam'],
    ['epic', 'Epic Games'],
    ['custom', 'Добавленные вручную'],
  ]
    .filter(([p]) => by[p].games || by[p].family)
    .map(([p, n]) => `<div><b>${n}</b><span>${platformCount(by[p])} · ${h(by[p].minutes)} ч</span></div>`)
    .join('');
  const achievements = spAchievements(
    d.achievements,
    'Достижения появятся здесь после того, как вы откроете страницы игр Steam (Nexus загружает их по запросу).'
  );
  return `${notice()}<div class="section-head"><h1>Профиль</h1><button class="secondary" id="profile-refresh">↻ Обновить</button></div><div class="profile-accounts">${accounts}</div><div class="stat-tiles">${tiles}</div><div class="profile-columns"><section><h2>БОЛЬШЕ ВСЕГО ВРЕМЕНИ</h2><div class="top-games">${top}</div></section><section><h2>ПО ПЛАТФОРМАМ</h2><div class="platform-split">${platforms}</div><h2>ПОСЛЕДНИЕ ДОСТИЖЕНИЯ</h2>${achievements}</section></div>`;
}
// No account connected: no numbers. Games found on the PC are not the user's
// library until an account confirms them (they may come from Steam Families).
function profileEmptyPage(d) {
  const found = d.stats?.foundOnPc || 0;
  const pc = found
    ? `<p>На компьютере найдено ${found} ${plural(found, 'игра', 'игры', 'игр')}. Они показаны в «Скачанных» с пометкой «Найдено на ПК» и не входят в статистику: без аккаунта Nexus не знает, ваши ли это игры или игры из Семейной библиотеки Steam.</p>`
    : '';
  return `${notice()}<div class="section-head"><h1>Профиль</h1><button class="secondary" id="profile-refresh" ${profileState.loading ? 'disabled' : ''}>↻ Обновить</button></div><div class="empty profile-empty"><h2>Подключите аккаунт Steam или Epic Games</h2><p>Профиль покажет ваши игры, часы и достижения после входа в аккаунт.</p>${pc}<button class="primary" data-page="accounts">Подключить аккаунт</button></div>`;
}
function profileAccountCard(a) {
  const steam = a.provider === 'steam';
  const avatar = safeImage(a.avatar)
    ? `<img src="${esc(safeImage(a.avatar))}" alt="" referrerpolicy="no-referrer">`
    : steam
      ? 'S'
      : 'E';
  const level =
    steam && a.level !== undefined
      ? `<p><span class="steam-level">${a.level}</span> уровень · ${a.badges} ${plural(a.badges, 'значок', 'значка', 'значков')} · ${a.xp.toLocaleString('ru-RU')} XP${a.xpNeeded ? ` · до следующего уровня ${a.xpNeeded.toLocaleString('ru-RU')} XP` : ''}</p>`
      : '<p class="hint">' + (steam ? 'Уровень Steam недоступен' : 'Уровней у Epic Games нет') + '</p>';
  const link =
    steam && a.id
      ? `<button class="link" data-open-link="https://steamcommunity.com/profiles/${esc(a.id)}/">Профиль в Steam ↗</button>`
      : '';
  return `<div class="profile-card ${a.provider}"><span class="profile-big-avatar">${avatar}</span><div><small>${steam ? 'Steam' : 'Epic Games'}</small><h2>${esc(a.name)}</h2>${level}${link}</div></div>`;
}

// A friend's full game list inside the profile («Игры», «Запускались», «Общие игры»).
function friendGamesView(d) {
  const v = friendState.view;
  const list =
    v === 'common' ? d.commonAll || [] : (d.allGames || []).filter(x => v !== 'played' || x.minutes > 0);
  const title = { games: 'Все игры', played: 'Запускались', common: 'Общие игры' }[v] || 'Игры';
  const caption = x =>
    v === 'common'
      ? `<b>${spHours(x.minutes)} ч</b> у друга<br>${spHours(x.mine)} ч у вас`
      : x.minutes
        ? `<b>${spHours(x.minutes)} ч</b> всего`
        : 'не запускалась';
  const shown = list.slice(0, 1000);
  const tile = x =>
    `<button class="sp-game" ${spOpen(x)} data-name="${esc((x.name || '').toLowerCase())}" title="${esc(x.name)}">${spCover(x.appId, '', caption(x))}<span class="sp-game-name">${esc(x.name || 'Игра ' + x.appId)}</span></button>`;
  return `<section class="sp-panel sp-list"><div class="sp-panel-head"><button class="sp-back" data-sp-view="">← Профиль</button><span>${title} · ${list.length.toLocaleString('ru-RU')}</span><input class="sp-filter" type="search" placeholder="Поиск" aria-label="Поиск по играм" autocomplete="off"></div><div class="sp-games">${
    shown.map(tile).join('') || '<p class="hint">Список пуст.</p>'
  }</div>${list.length > shown.length ? `<p class="hint">Показаны первые ${shown.length} — используйте поиск</p>` : ''}</section>`;
}
// A profile sub-page (a game list, badges) takes the whole width under the
// profile header; the columns and comments are hidden while it is open.
function withView(html, view) {
  const at = html.indexOf('<div class="sp-body">');
  if (at < 0) return html;
  return (
    html.slice(0, at) +
    `<div class="sp-body sp-body-full"><div class="sp-main">${view}</div></div></div></div>`
  );
}
// A label in my profile («Игр в библиотеке», «Установлено», «Запускались», «Значки»).
let profileView = null; // { kind: owned|installed|played|badges, source, id }
const profileGamesState = new Map(); // kind:source → { loading, list, error }
async function loadProfileGames(kind, source) {
  const key = kind + ':' + source;
  if (profileGamesState.get(key)?.loading) return;
  profileGamesState.set(key, { loading: true, list: null, error: '' });
  try {
    const list = api?.profileGames ? await call('profileGames', { kind, source }) : [];
    profileGamesState.set(key, { loading: false, list: Array.isArray(list) ? list : [], error: '' });
  } catch (e) {
    profileGamesState.set(key, { loading: false, list: null, error: e.message });
  }
  if (page === 'profile') render();
}
function myProfileView(d) {
  const v = profileView;
  const back = 'data-sp-go=""';
  if (v.kind === 'badges') return badgesView(v.id, back);
  const key = v.kind + ':' + v.source;
  const st = profileGamesState.get(key);
  if (!st) loadProfileGames(v.kind, v.source);
  const where = { steam: ' · Steam', epic: ' · Epic Games' }[v.source] || '';
  const title =
    ({
      owned: 'Игры в библиотеке',
      family: 'Семейная библиотека',
      installed: 'Установлено',
      played: 'Запускались',
    }[v.kind] || 'Игры') + where;
  const head = n =>
    `<div class="sp-panel-head"><button class="sp-back" ${back}>← Профиль</button><span>${title}${n === undefined ? '' : ' · ' + n.toLocaleString('ru-RU')}</span><input class="sp-filter" type="search" placeholder="Поиск" aria-label="Поиск по играм" autocomplete="off"></div>`;
  if (!st?.list)
    return `<section class="sp-panel sp-list">${head()}<p class="hint">${esc(st?.error || 'Загружаем список…')}</p></section>`;
  const list = st.list;
  const shown = list.slice(0, 1500);
  const card = x => {
    const g = game(x.id);
    const art = g
      ? artTag(g)
      : x.steam
        ? `<img src="nexus-art://steam/${encodeURIComponent(x.steam)}/header" ${safeImage(x.image) ? `data-fallback="${esc(safeImage(x.image))}"` : ''} alt="" loading="lazy">`
        : '';
    const caption = [
      x.minutes ? `<b>${spHours(x.minutes)} ч</b> всего` : 'не запускалась',
      x.lastPlayed
        ? 'запуск ' +
          new Date(x.lastPlayed).toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })
        : '',
    ]
      .filter(Boolean)
      .join('<br>');
    return `<button class="sp-game" data-detail="${esc(x.id)}" data-name="${esc((x.name || '').toLowerCase())}" title="${esc(x.name)}"><span class="friend-game-art">${art}<span class="sp-game-time">${caption}</span></span><span class="sp-game-name">${esc(x.name)}</span></button>`;
  };
  return `<section class="sp-panel sp-list">${head(list.length)}<div class="sp-games">${shown.map(card).join('') || '<p class="hint">Список пуст.</p>'}</div>${list.length > shown.length ? `<p class="hint">Показаны первые ${shown.length} — используйте поиск</p>` : ''}</section>`;
}
// Badges of a Steam profile, shown inside Nexus.
const badgesState = new Map(); // steam id → { loading, list, error }
async function loadBadges(id) {
  if (badgesState.get(id)?.loading) return;
  badgesState.set(id, { loading: true, list: null, error: '' });
  try {
    const r = api?.profileBadges ? await call('profileBadges', id) : { badges: [] };
    badgesState.set(id, { loading: false, list: r?.badges || [], error: '' });
  } catch (e) {
    badgesState.set(id, { loading: false, list: null, error: e.message });
  }
  if (page === 'profile' || page === 'friend') render();
}
function badgesView(id, back) {
  const st = badgesState.get(id);
  if (!st) loadBadges(id);
  const head = n =>
    `<div class="sp-panel-head"><button class="sp-back" ${back}>← Профиль</button><span>Значки${n === undefined ? '' : ' · ' + n.toLocaleString('ru-RU')}</span><input class="sp-filter" type="search" placeholder="Поиск" aria-label="Поиск по значкам" autocomplete="off"></div>`;
  if (!st?.list)
    return `<section class="sp-panel sp-list">${head()}<p class="hint">${esc(st?.error || 'Загружаем значки…')}</p></section>`;
  const card = b => {
    const img = safeImage(b.image);
    const game = b.game && b.game !== b.title ? `<small class="sp-badge-game">${esc(b.game)}</small>` : '';
    return `<div class="sp-badge" data-name="${esc((b.title + ' ' + (b.game || '')).toLowerCase())}">${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="sp-badge-empty"></span>'}<span><strong>${esc(b.title)}</strong>${game}${b.level ? `<small>${esc(b.level)}</small>` : ''}${b.unlocked ? `<small>${esc(b.unlocked)}</small>` : ''}</span></div>`;
  };
  return `<section class="sp-panel sp-list">${head(st.list.length)}<div class="sp-badges">${st.list.map(card).join('') || '<p class="hint">Значков нет.</p>'}</div></section>`;
}
document.addEventListener('input', event => {
  if (!event.target.classList?.contains('sp-filter')) return;
  const q = event.target.value.trim().toLowerCase();
  for (const el of document.querySelectorAll('.sp-list [data-name]'))
    el.hidden = !!q && !el.dataset.name.includes(q);
});

// ---- comments under a Steam profile, as on Steam Community --------------------------
const commentsState = new Map(); // steam id → { loading, list, total, error, mine, me, sending, armed }
// Unsent text per profile: the page may be rebuilt while the user writes.
const commentDrafts = new Map();
document.addEventListener('input', event => {
  const form = event.target.closest?.('[data-comment-form]');
  if (form) commentDrafts.set(form.dataset.commentForm, event.target.value);
});
async function loadComments(id, more = false) {
  const st = commentsState.get(id) || { list: [] };
  if (!api?.profileComments || demo || st.loading) return;
  commentsState.set(id, { ...st, loading: true, error: '' });
  try {
    const r = await call('profileComments', { id, start: more ? st.list.length : 0 });
    const list = more
      ? [...st.list, ...r.comments.filter(c => !st.list.some(x => x.id === c.id))]
      : r.comments;
    commentsState.set(id, { ...st, loading: false, list, total: r.total, mine: r.mine, me: r.me, error: '' });
  } catch (e) {
    commentsState.set(id, { ...st, loading: false, error: e.message });
  }
  render();
}
function commentsBox(id) {
  if (!id || !api?.profileComments || demo) return '';
  const st = commentsState.get(id);
  if (!st) setTimeout(() => loadComments(id));
  const list = st?.list || [];
  const date = t =>
    t
      ? new Date(t).toLocaleString('ru-RU', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
  const who = c =>
    c.authorId && c.authorId === st?.me
      ? 'data-page="profile"'
      : c.authorId
        ? `data-friend="${esc(c.authorId)}"`
        : '';
  const rows = list
    .map(
      c =>
        `<div class="sp-comment"><button class="sp-comment-avatar" ${who(c)} title="${esc(c.author)}">${
          safeImage(c.avatar)
            ? `<img src="${esc(safeImage(c.avatar))}" alt="" loading="lazy" referrerpolicy="no-referrer">`
            : '<span>?</span>'
        }${
          safeImage(c.frame)
            ? `<img class="sp-comment-frame" src="${esc(safeImage(c.frame))}" alt="" loading="lazy" referrerpolicy="no-referrer">`
            : ''
        }</button><div class="sp-comment-body"><div class="sp-comment-head"><button class="sp-comment-author" ${who(c)}>${esc(c.author)}</button><small>${esc(date(c.at))}</small>${
          c.canDelete
            ? `<button class="sp-comment-del ${st.armed === c.id ? 'armed' : ''}" data-comment-del="${esc(c.id)}" data-comment-profile="${esc(id)}" title="Удалить комментарий">${st.armed === c.id ? 'Удалить?' : '✕'}</button>`
            : ''
        }</div><p>${esc(c.text)}</p></div></div>`
    )
    .join('');
  const body =
    st?.error && !list.length
      ? `<p class="hint">${esc(st.error)}</p>`
      : !st || (st.loading && !list.length)
        ? '<p class="hint">Загружаем комментарии…</p>'
        : rows || '<p class="hint">Комментариев пока нет.</p>';
  return `<section class="sp-panel sp-comments"><div class="sp-panel-head"><span>Комментарии</span>${st?.total ? `<small>${st.total.toLocaleString('ru-RU')}</small>` : ''}</div><form class="sp-comment-form" data-comment-form="${esc(id)}"><textarea maxlength="1000" rows="2" placeholder="Добавить комментарий" aria-label="Текст комментария" ${st?.sending ? 'disabled' : ''}>${esc(commentDrafts.get(id) || '')}</textarea><button class="primary" type="submit" ${st?.sending ? 'disabled' : ''}>${st?.sending ? 'Отправляем…' : 'Отправить'}</button></form><div class="sp-comment-list">${body}</div>${
    st && list.length < (st.total || 0)
      ? `<button class="sp-more sp-comments-more" data-comments-more="${esc(id)}" ${st.loading ? 'disabled' : ''}>Показать ещё (${st.total - list.length})</button>`
      : ''
  }</section>`;
}
document.addEventListener('submit', event => {
  const form = event.target.closest?.('[data-comment-form]');
  if (!form) return;
  event.preventDefault();
  const id = form.dataset.commentForm;
  const text = form.querySelector('textarea').value.trim();
  if (!text) return;
  run(async () => {
    const st = commentsState.get(id) || { list: [] };
    commentsState.set(id, { ...st, sending: true });
    render();
    try {
      const r = await call('postProfileComment', { id, text });
      commentsState.set(id, {
        ...st,
        sending: false,
        list: r.comments,
        total: r.total,
        mine: r.mine,
        me: r.me,
        error: '',
      });
      commentDrafts.delete(id);
      toast('Комментарий опубликован.');
    } catch (e) {
      commentsState.set(id, { ...st, sending: false });
      render();
      throw e;
    }
    render();
  });
});

// ---- a friend's Steam profile, inside Nexus ------------------------------------------
let friendState = { id: '', loading: false, data: null, error: '' };
async function loadFriend(force = false) {
  const id = friendState.id;
  if (!api?.friendProfile || demo || !id || (friendState.loading && !force)) return;
  friendState = { ...friendState, loading: true, error: '' };
  try {
    const data = await call('friendProfile', id);
    if (friendState.id === id) friendState = { id, loading: false, data, error: '' };
  } catch (e) {
    if (friendState.id === id) friendState = { id, loading: false, data: null, error: e.message };
  }
  if (page === 'friend') render();
}
function showFriend(id) {
  if (friendState.id !== id) friendState = { id, loading: false, data: null, error: '' };
  setPage('friend');
  loadFriend();
}
function friendStatusText(d) {
  if (d.status === 'ingame') return d.game ? 'В игре: ' + d.game : 'В игре';
  if (d.status === 'online') return 'В сети';
  if (d.status === 'away') return 'Нет на месте';
  if (d.lastOnline) {
    const days = Math.floor((Date.now() - d.lastOnline) / 86400000);
    return (
      'Не в сети · был(а) ' +
      (days < 1 ? 'сегодня' : days === 1 ? 'вчера' : new Date(d.lastOnline).toLocaleDateString('ru-RU'))
    );
  }
  return 'Не в сети';
}
// Steam writes the date in English ("May 14, 2012"): in Russian when it parses.
function memberSince(text) {
  if (!text) return '';
  const t = Date.parse(text);
  return esc(
    Number.isFinite(t)
      ? new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
      : text
  );
}
function friendPage() {
  const d = friendState.data;
  if (!d)
    return `${notice()}<div class="empty"><h2>${esc(friendState.error || 'Загружаем профиль…')}</h2>${
      friendState.error ? '<button class="secondary" id="friend-refresh">↻ Повторить</button>' : ''
    }</div>`;
  const status = d.status || 'offline';
  const html =
    notice() +
    spShell(
      '',
      safeImage(d.background),
      friendHeader(d, status) + spBody(friendMain(d), friendSide(d, status), commentsBox(d.id))
    );
  if (friendState.view === 'badges') return withView(html, badgesView(d.id, 'data-sp-view=""'));
  return friendState.view ? withView(html, friendGamesView(d)) : html;
}
function friendHeader(d, status) {
  const level =
    d.level !== null && d.level !== undefined
      ? `<div class="sp-level">Уровень <span class="steam-level">${d.level}</span></div>`
      : '';
  const write = d.conv ? `<button class="primary" data-activity-chat="${esc(d.conv)}">Написать</button>` : '';
  return spHeader(
    esc(status),
    spAvatar(safeImage(d.avatar), d.name) + spFrame(d.frame),
    `<h1>${esc(d.name)}</h1>${spRealLine(d.realName, d.location)}${
      d.summary ? `<p class="sp-summary">${esc(d.summary)}</p>` : ''
    }`,
    `${level}<div class="sp-actions">${write}<button class="secondary" data-open-link="https://steamcommunity.com/profiles/${esc(d.id)}/">Открыть в Steam ↗</button><button class="secondary" id="friend-refresh" title="Обновить">↻</button></div>`
  );
}
function friendMain(d) {
  const hiddenGames = !d.games || d.games.hidden;
  const hiddenNote = '<p class="hint">Игры этого профиля скрыты настройками приватности Steam.</p>';
  const date = t =>
    new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  // "Недавняя активность" like Steam: hours in two weeks, then the games.
  const recentMinutes = d.recent.reduce((n, x) => n + x.minutes2w, 0);
  const recent = d.recent.length
    ? d.recent
        .map(x =>
          spGameTile(
            x,
            `<b>${spHours(x.minutes)} ч</b> всего${x.lastPlayed ? `<br>${esc(date(x.lastPlayed))}` : ''}`
          )
        )
        .join('')
    : hiddenGames
      ? hiddenNote
      : '<p class="hint">За последние две недели игр не было.</p>';
  const top = d.top.length
    ? spTopRows(d.top, spOpen, x => x.name)
    : hiddenGames
      ? hiddenNote
      : '<p class="hint">Время в играх не указано.</p>';
  const common = d.common.length
    ? `<div class="sp-common">${d.common
        .map(
          x =>
            `<button class="friend-game" ${spOpen(x)}>${spCover(x.appId, x.image)}<span><strong>${esc(x.name)}</strong><small>у друга ${spHours(x.minutes)} ч · у вас ${spHours(x.mine)} ч</small></span></button>`
        )
        .join(
          ''
        )}</div>${d.commonCount > d.common.length ? `<p class="hint">и ещё ${d.commonCount - d.common.length}</p>` : ''}`
    : hiddenGames
      ? hiddenNote
      : '<p class="hint">Общих игр в Steam нет.</p>';
  const commonHead =
    d.commonCount > d.common.length
      ? `<button class="sp-more" data-sp-view="common">Все ${d.commonCount} →</button>`
      : d.commonCount
        ? `<small>${d.commonCount}</small>`
        : '';
  return (
    spPanel(
      'Недавняя активность',
      `<div class="sp-games">${recent}</div>`,
      recentMinutes ? `<small>${spHours(recentMinutes)} ч за последние 2 недели</small>` : ''
    ) +
    spPanel('Больше всего времени', `<div class="top-games">${top}</div>`) +
    spPanel('Общие игры', common, commonHead)
  );
}
function friendSide(d, status) {
  const g = d.games;
  const hiddenGames = !g || g.hidden;
  const playing = d.recent.find(x => d.gameId && x.appId === String(d.gameId));
  const statusBox =
    status === 'ingame'
      ? `<div class="sp-status ingame"><small>Сейчас в игре</small><strong>${esc(d.game || 'В игре')}</strong>${
          d.gameId
            ? `<button class="sp-now" ${spOpen({ appId: String(d.gameId), gameId: playing?.gameId || '' })}>${spCover(String(d.gameId), d.gameImage)}</button>`
            : ''
        }</div>`
      : `<div class="sp-status ${esc(status)}"><strong>${esc(friendStatusText(d))}</strong></div>`;
  const stats = [
    spStat('Значки', d.badges, `data-sp-badges="${esc(d.id)}"`),
    hiddenGames ? '' : spStat('Игры', g.count.toLocaleString('ru-RU'), 'data-sp-view="games"'),
    hiddenGames ? '' : spStat('Часов в играх', spHours(g.minutes)),
    hiddenGames ? '' : spStat('Запускались', g.played.toLocaleString('ru-RU'), 'data-sp-view="played"'),
    spStat('Общие игры', hiddenGames ? '' : d.commonCount, 'data-sp-view="common"'),
    spStat('В Steam с', memberSince(d.memberSince)),
  ].join('');
  return `${statusBox}<div class="sp-stats">${stats}</div>`;
}

// ---- settings: status, notifications, tray, overlay ---------------------------------------
const OVERLAY_KEYS = ['Shift+Tab', 'Shift+F1', 'Ctrl+Shift+O', 'Alt+F12'];
function socialCard() {
  return statusCard() + trayCard() + overlayCard();
}
// A check box of the settings that writes a presence setting.
function presenceCheck(name, label, def = true) {
  const s = state.settings;
  const on = def ? s[name] !== false : s[name] === true;
  return `<label class="check"><input type="checkbox" data-presence-setting="${name}" ${on ? 'checked' : ''} ${demo ? 'disabled' : ''}> ${label}</label>`;
}
function statusCard() {
  const status = state.settings.myStatus || 'online';
  const options = [
    ['online', 'В сети'],
    ['away', 'Нет на месте'],
    ['invisible', 'Невидимка'],
    ['off', 'Не подключаться (без статусов друзей и уведомлений)'],
  ]
    .map(([v, n]) => `<option value="${v}" ${status === v ? 'selected' : ''}>${n}</option>`)
    .join('');
  return `<section class="settings-card social-card"><h3>Статус и уведомления</h3><p>Как в клиенте Steam: статус для друзей, их статусы в реальном времени и уведомления. Статус передаётся через чат Steam и Epic Games.</p><label class="field">Мой статус <select id="my-status-select" ${demo ? 'disabled' : ''}>${options}</select></label>${[
    presenceCheck(
      'showPlaying',
      'Показывать друзьям, во что я играю (игры Epic и добавленные вручную — как «… · Nexus»)'
    ),
    presenceCheck('notifyFriendGame', 'Уведомлять, когда друг начинает играть'),
    presenceCheck('notifyFriendOnline', 'Уведомлять, когда друг заходит в сеть', false),
    presenceCheck('notifyAchievements', 'Уведомлять о новых достижениях во время игры'),
  ].join('')}</section>`;
}
function trayCard() {
  return `<section class="settings-card"><h3>Трей и запуск</h3>${presenceCheck(
    'closeToTray',
    'Закрывать в трей: кнопка × оставляет Nexus работать в фоне (загрузки, чат, статус)'
  )}${presenceCheck('startHidden', 'При запуске вместе с системой сразу сворачивать в трей', false)}<p class="hint">Выйти из Nexus — в меню значка в трее.</p></section>`;
}
function overlayCard() {
  const hotkey = state.settings.overlayHotkey || 'Shift+Tab';
  const keys = OVERLAY_KEYS.map(k => `<option ${hotkey === k ? 'selected' : ''}>${k}</option>`).join('');
  return `<section class="settings-card overlay-card"><h3>Оверлей в игре</h3><p>Поверх игры: друзья и чат, достижения, время сессии, счётчик FPS. Работает в играх в окне и в «полноэкранном окне»; поверх эксклюзивного полноэкранного режима другие окна не показываются.</p>${presenceCheck('overlay', 'Включить оверлей')}<label class="field">Сочетание клавиш <select id="overlay-hotkey" ${demo ? 'disabled' : ''}>${keys}</select><small>Работает, только пока запущена игра.</small></label><p class="hint">${state.features?.fps === false ? 'Счётчик FPS работает только в Windows.' : 'Счётчик FPS включается в самом оверлее. Для него нужен PresentMon: он уже есть в AMD Software и в Intel PresentMon.'}</p></section>`;
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
    else if (el.id === 'friend-refresh') {
      friendState = { ...friendState, data: null, error: '' };
      render();
      loadFriend(true);
    } else if (el.dataset.profileTab) setProfileTab(el.dataset.profileTab);
    else if (el.dataset.spView !== undefined) {
      friendState = { ...friendState, view: el.dataset.spView };
      render();
      $('#main').scrollTop = 0;
    } else if (el.dataset.spGo !== undefined) {
      const kind = el.dataset.spGo;
      const source = ['steam', 'epic'].includes(el.dataset.spSource) ? el.dataset.spSource : 'all';
      profileView = kind ? { kind, source } : null;
      if (kind) profileGamesState.delete(kind + ':' + source);
      render();
      $('#main').scrollTop = 0;
    } else if (el.dataset.spBadges) {
      const id = el.dataset.spBadges;
      if (page === 'friend') friendState = { ...friendState, view: 'badges' };
      else profileView = { kind: 'badges', id };
      render();
      $('#main').scrollTop = 0;
    } else if (el.dataset.spFriends !== undefined) await call('openFriendsWindow');
    else if (el.dataset.commentsMore) await loadComments(el.dataset.commentsMore, true);
    else if (el.dataset.commentDel) {
      const id = el.dataset.commentProfile;
      const st = commentsState.get(id);
      if (!st) return;
      // The first press asks "Удалить?" on the button itself; the second deletes.
      if (st.armed !== el.dataset.commentDel) {
        commentsState.set(id, { ...st, armed: el.dataset.commentDel });
        render();
        return;
      }
      const r = await call('deleteProfileComment', { id, commentId: el.dataset.commentDel });
      commentsState.set(id, { ...st, armed: null, list: r.comments, total: r.total, error: '' });
      render();
      toast('Комментарий удалён.');
    } else if (el.id === 'profile-refresh') {
      profileState = { ...profileState, loading: false, error: '' };
      loadProfile(true);
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
