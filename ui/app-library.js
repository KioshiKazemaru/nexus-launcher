// Nexus window, part 3 of 6: Library, game pages, downloads, storage, install window, settings, details.
// The parts are classic scripts loaded in order by index.html and share one
// global scope (see eslint.config.cjs); app-boot.js starts the window.
// ---- downloads (Steam and Epic Games), like the downloads page of Steam ----
const PROGRESS_LABELS = {
  downloading: 'Загрузка',
  installing: 'Установка',
  updating: 'Обновление',
  paused: 'Пауза',
  uninstalling: 'Удаление',
  moving: 'Перенос',
  verifying: 'Проверка файлов',
  error: 'Ошибка',
  queued: 'В очереди',
  scheduled: 'Ждёт разрешённых часов',
};
function bytesText(n) {
  if (!Number.isFinite(n)) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: i >= 2 ? 1 : 0 })} ${units[i]}`;
}
function etaText(sec) {
  if (!Number.isFinite(sec)) return '';
  if (sec < 60) return `${Math.max(1, sec)} сек.`;
  if (sec < 3600) return `${Math.round(sec / 60)} мин.`;
  return `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин.`;
}
// "Загрузка · 45% · 12,3 МБ/с · осталось 2 мин."
function progressText(p) {
  return [
    PROGRESS_LABELS[p.state] || 'Загрузка',
    Number.isFinite(p.percent) ? p.percent + '%' : '',
    p.speed > 0 ? bytesText(p.speed) + '/с' : '',
    Number.isFinite(p.eta) && p.state !== 'paused' ? 'осталось ' + etaText(p.eta) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
function progressLine(g) {
  const p = state.progress?.[g.id] || g.progress;
  if (!p) return '';
  const store = names[p.provider] || 'клиенте';
  return `<div class="install-progress ${esc(p.state || '')}" title="${esc(PROGRESS_LABELS[p.state] || 'Загрузка')} в ${esc(store)}"><span>${esc(progressText(p))}</span>${Number.isFinite(p.percent) ? `<i style="width:${p.percent}%"></i>` : '<i class="indeterminate"></i>'}</div>`;
}
function downloadsPage() {
  const list = Object.entries(state.progress || {});
  const rows = list
    .map(([id, p]) => {
      const found = game(id) || game(p.dlc ? id.split('#')[0] : '') || { id, name: p.title || 'Игра' };
      // A DLC row: the main game's picture with the DLC's own title.
      const g = p.dlc ? { ...found, name: p.title || found.name } : found;
      // Epic: download size (compressed), plus the size on disk after installation.
      const size = Number.isFinite(p.total)
        ? `${bytesText(p.done)} из ${bytesText(p.total)}${p.installSize ? ` · на диске ${bytesText(p.installSize)}` : ''}`
        : Number.isFinite(p.done)
          ? `Записано ${bytesText(p.done)}`
          : '';
      return `<article class="download-row ${esc(p.state || '')}"><button class="download-art" data-detail="${esc(id)}">${artTag(g)}</button><div class="download-main"><div class="download-title"><strong>${esc(g.name)}</strong><span class="pill ${p.provider === 'steam' ? 'blue' : ''}">${names[p.provider] || ''}</span></div><div class="download-state"><span>${esc(PROGRESS_LABELS[p.state] || 'Загрузка')}${Number.isFinite(p.eta) && p.state !== 'paused' ? ' · осталось ' + etaText(p.eta) : ''}</span><span>${esc(size)}</span></div><div class="download-bar">${Number.isFinite(p.percent) ? `<i style="width:${p.percent}%"></i>` : '<i class="indeterminate"></i>'}</div></div><div class="download-stats"><div><small>СКОРОСТЬ</small><strong>${p.speed > 0 ? bytesText(p.speed) + '/с' : '—'}</strong></div><div><small>ГОТОВО</small><strong>${Number.isFinite(p.percent) ? p.percent + '%' : '—'}</strong></div></div><div class="download-actions">${
        p.nexus
          ? `${
              p.state === 'scheduled'
                ? `<button class="secondary" data-download-action="now" data-download-id="${esc(id)}">▶ Загрузить сейчас</button>`
                : p.state === 'queued'
                  ? `${p.queue > 1 ? `<button class="secondary" data-download-action="first" data-download-id="${esc(id)}" title="Скачать следующей">▲ Первой</button>` : ''}<button class="secondary" data-download-action="pause" data-download-id="${esc(id)}">❚❚ Пауза</button>`
                  : p.state === 'paused' || p.state === 'error'
                    ? `<button class="secondary" data-download-action="resume" data-download-id="${esc(id)}">▶ Продолжить</button>`
                    : `<button class="secondary" data-download-action="pause" data-download-id="${esc(id)}">❚❚ Пауза</button>`
            }<button class="secondary" data-download-action="cancel" data-download-id="${esc(id)}">Отменить</button>`
          : p.uninstallFailed
            ? `<button class="secondary" data-uninstall="${esc(p.provider)}" data-game-id="${esc(id)}">Удалить снова</button>`
            : p.state === 'uninstalling'
              ? ''
              : `<button class="secondary" data-client-downloads="${esc(p.provider)}" title="Пауза, отмена и очередь — в клиенте ${esc(names[p.provider] || '')}">Открыть в ${esc(p.provider === 'epic' ? 'Epic' : 'Steam')}</button>`
      }</div>${p.error ? `<p class="download-error">${esc(p.error)}</p>` : ''}</article>`;
    })
    .join('');
  return `${notice()}<div class="section-head"><h1>Загрузки</h1><span>${list.length ? `${list.length} ${plural(list.length, 'активная', 'активные', 'активных')}` : ''}</span></div><p class="subheading">Игры Epic Nexus скачивает сам — их можно поставить на паузу и продолжить даже после перезапуска. Загрузки Steam выполняет Steam в фоне; их пауза и отмена — в клиенте.</p>${speedGraph()}${
    rows
      ? `<div class="download-list">${rows}</div>`
      : '<div class="empty"><h2>Нет активных загрузок</h2><p>Когда Steam или Epic Games начнут устанавливать или обновлять игру, она появится здесь.</p></div>'
  }`;
}
// ---- "Хранилище": drives and the games on them ----------------------------------------
let storageState = { loading: false, data: null, error: '' };
async function loadStorage() {
  if (!api?.storageInfo || demo || storageState.loading) return;
  storageState = { ...storageState, loading: true };
  try {
    storageState = { loading: false, data: await call('storageInfo'), error: '' };
  } catch (e) {
    storageState = { ...storageState, loading: false, error: e.message };
  }
  if (page === 'storage' || propsDlg) render();
}
function storageRow(x) {
  const busy = x.busy || !!state.progress?.[x.id];
  return `<div class="storage-row"><button class="storage-name" data-detail="${esc(x.id)}"><strong>${esc(x.name)}</strong><small>${esc(x.dir)}</small></button><span class="pill ${x.provider === 'steam' ? 'blue' : ''}">${names[x.provider] || ''}</span><span class="storage-size">${x.size ? bytesText(x.size) : '—'}</span><span class="storage-actions"><button class="secondary" data-open-folder="${esc(x.dir)}" title="Открыть папку">📁</button>${x.provider === 'epic' && !busy ? `<button class="secondary" data-move-game="${esc(x.id)}">Переместить</button>` : ''}${x.provider !== 'custom' && !busy ? `<button class="secondary" data-uninstall="${esc(x.provider)}" data-game-id="${esc(x.id)}">Удалить</button>` : ''}</span></div>`;
}
function storagePage() {
  if (!storageState.data && !storageState.loading && !storageState.error) loadStorage();
  const drives = storageState.data?.drives || [];
  const pct = (n, total) => (total ? Math.max(0, Math.min(100, (n / total) * 100)).toFixed(2) : 0);
  const body = !storageState.data
    ? `<div class="empty"><h2>${storageState.error ? esc(storageState.error) : 'Считаем место на дисках…'}</h2></div>`
    : drives.length
      ? drives
          .map(
            d =>
              `<section class="drive"><div class="drive-head"><h2>Диск ${esc(d.root)}</h2><span>Свободно <strong>${bytesText(d.free)}</strong> из ${bytesText(d.total)}</span></div><div class="drive-bar" title="Игры: ${bytesText(d.gamesSize)} · другое: ${bytesText(d.other)} · свободно: ${bytesText(d.free)}"><i class="games" style="width:${pct(d.gamesSize, d.total)}%"></i><i class="other" style="width:${pct(d.other, d.total)}%"></i></div><div class="drive-legend"><span><i class="games"></i>Игры ${bytesText(d.gamesSize)}</span><span><i class="other"></i>Другое ${bytesText(d.other)}</span><span><i class="free"></i>Свободно ${bytesText(d.free)}</span></div>${
                d.games.length
                  ? `<div class="storage-list">${d.games.map(storageRow).join('')}</div>`
                  : '<p class="hint">Игр на этом диске нет.</p>'
              }</section>`
          )
          .join('')
      : '<div class="empty"><h2>Установленных игр нет</h2></div>';
  return `${notice()}<div class="section-head"><h1>Хранилище</h1><button class="secondary" id="storage-refresh" ${storageState.loading ? 'disabled' : ''}>↻ Обновить</button></div><p class="subheading">Сколько места занимают игры на каждом диске. Размеры — из данных Steam и Epic.</p>${body}`;
}
// Install / uninstall / verify through the official client.
function clientButtons(o) {
  if (!o || o.provider === 'custom' || demo) return '';
  // Removal stopped half way: the rest of the files go with one more press.
  const left = state.progress?.[librarySelection];
  if (!o.installed && left?.uninstallFailed)
    return `<button class="secondary" id="library-uninstall" data-uninstall="${esc(left.provider || o.provider)}" title="${esc(left.error || '')}">Удалить снова</button>`;
  if (!o.installed) return '';
  const sync =
    o.provider === 'epic' && o.executable && state.settings.epicCloudSaves !== false
      ? '<button class="secondary" id="epic-sync" title="Сравнить с облаком Epic и взять более новое сохранение">☁ Сохранения</button>'
      : '';
  return (
    sync +
    (o.provider === 'epic' && state.updates?.[librarySelection]
      ? `<button class="secondary" data-download-action="update" title="Новая версия: ${esc(state.updates[librarySelection])}">⟳ Обновить</button>`
      : '') +
    (o.provider === 'epic' && state.settings.nexusDownloads !== false
      ? '<button class="secondary" data-download-action="repair" title="Проверить файлы и докачать повреждённые">Проверить</button><button class="secondary" id="library-move" title="Перенести игру в другую папку или на другой диск">Переместить</button>'
      : `<button class="secondary" data-client-action="verify" title="Проверить файлы в ${names[o.provider]}">Проверить</button>`) +
    `<button class="secondary" id="library-uninstall" data-uninstall="${esc(o.provider)}" title="Удалить файлы игры с компьютера">${state.progress?.[librarySelection]?.state === 'uninstalling' ? 'Удаляется…' : 'Удалить'}</button>`
  );
}
// For a manually added game started through a launcher: which process is the game.
function trackProcessBox(g) {
  const o = g.offers.find(x => x.provider === 'custom');
  if (!o || demo) return '';
  return `<h2>ВРЕМЯ В ИГРЕ</h2><form id="track-process-form" class="inline-form"><input id="track-process" maxlength="104" placeholder="${state.platform === 'win32' ? 'game.exe' : state.platform === 'darwin' ? 'Game' : 'game.x86_64'}" value="${esc(o.trackProcess || '')}"><button class="secondary" type="submit">Сохранить</button></form><p class="hint">Если запускаемый файл — это лаунчер, укажите имя процесса самой игры (${state.platform === 'win32' ? 'из диспетчера задач' : state.platform === 'darwin' ? 'из «Мониторинга системы»' : 'из системного монитора'}). Пусто — время считается до закрытия запущенного файла.</p>`;
}
function collectionsBox(g) {
  const list = state.settings.collections || [];
  return `<h2>КОЛЛЕКЦИИ</h2><div class="collections-box">${list
    .map(
      c =>
        `<label class="check"><input type="checkbox" data-collection-toggle="${esc(c.id)}" ${c.games.includes(g.id) ? 'checked' : ''} ${demo ? 'disabled' : ''}> ${esc(c.name)}</label>`
    )
    .join(
      ''
    )}${demo ? '' : '<form id="new-collection-form" class="inline-form"><input id="new-collection" maxlength="80" placeholder="Новая коллекция"><button class="secondary" type="submit">Создать</button></form>'}</div>`;
}
const achievementState = new Map();
function achievementsBox(g) {
  const a = achievementState.get(g.id);
  if (!a)
    return `<h2>ДОСТИЖЕНИЯ</h2><div class="library-activity-box"><p class="hint">${g.offers.some(o => o.provider === 'steam') ? 'Загружаем…' : 'Epic Games не даёт сторонним программам доступ к достижениям.'}</p></div>`;
  if (a.error)
    return `<h2>ДОСТИЖЕНИЯ</h2><div class="library-activity-box"><p class="watch-error">${esc(a.error)}</p></div>`;
  if (!a.available)
    return `<h2>ДОСТИЖЕНИЯ</h2><div class="library-activity-box"><p class="hint">${esc(a.reason)}</p></div>`;
  const list = [...a.list].sort(
    (x, y) => Number(y.unlocked) - Number(x.unlocked) || (y.unlockedAt || 0) - (x.unlockedAt || 0)
  );
  return `<h2>ДОСТИЖЕНИЯ · ${a.unlocked}/${a.total}</h2><div class="achievements"><div class="achievement-bar"><i style="width:${a.percent}%"></i></div><ul>${list
    .slice(0, 60)
    .map(
      x =>
        `<li class="${x.unlocked ? 'done' : ''}">${safeImage(x.icon) ? `<img src="${esc(safeImage(x.icon))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="achievement-icon"></span>'}<span><strong>${esc(x.name)}</strong><small>${esc(x.description)}${x.unlocked && x.unlockedAt ? ' · ' + new Date(x.unlockedAt * 1000).toLocaleDateString('ru-RU') : ''}</small></span></li>`
    )
    .join(
      ''
    )}</ul>${list.length > 60 ? `<p class="hint">Показаны 60 из ${list.length}</p>` : ''}<p class="hint">Аккаунт: ${esc(a.account)}</p></div>`;
}
async function requestAchievements(id) {
  if (!api?.achievements || demo || achievementState.has(id)) return;
  achievementState.set(id, null);
  try {
    achievementState.set(id, await call('achievements', id));
  } catch (e) {
    achievementState.set(id, { error: e.message });
  }
  if (librarySelection === id) render();
}
// "Играющие друзья" on a Steam game's page, like the Steam client's game page.
const gameFriendsState = new Map(); // steam app id → { at, data } | { at, error } | { at, loading }
function steamAppOf(g) {
  return String(g.offers?.find(o => o.provider === 'steam')?.appId || g.steam || '');
}
async function requestGameFriends(appId) {
  const had = gameFriendsState.get(appId);
  if (!api?.gameFriends || demo || had?.loading || (had && Date.now() - had.at < 120000)) return;
  gameFriendsState.set(appId, { ...had, at: Date.now(), loading: true });
  let next;
  try {
    next = { at: Date.now(), data: await call('gameFriends', appId) };
  } catch (e) {
    next = { at: Date.now(), error: e.message };
  }
  gameFriendsState.set(appId, next);
  const shown = page === 'library' && activeGames().find(x => x.id === librarySelection);
  if (shown && steamAppOf(shown) === appId) render();
}
function friendAvatar(x, big) {
  const src = safeImage(x.avatar);
  const img = src
    ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<span>?</span>';
  return `<button class="gf-avatar ${big ? 'big' : ''} ${esc(x.status || '')}" data-friend="${esc(x.id)}" title="${esc(x.name || 'Друг Steam')}">${img}</button>`;
}
function gameFriendsBox(g) {
  const appId = steamAppOf(g);
  if (!appId || demo || !api?.gameFriends) return '';
  if (!(state.accountList || []).some(a => a.provider === 'steam' && a.status === 'connected')) return '';
  setTimeout(() => requestGameFriends(appId));
  const st = gameFriendsState.get(appId);
  const head = '<h2>ИГРАЮЩИЕ ДРУЗЬЯ</h2>';
  if (!st?.data && !st?.error)
    return head + '<div class="library-activity-box game-friends"><p class="hint">Загружаем…</p></div>';
  if (!st.data)
    return (
      head +
      `<div class="library-activity-box game-friends"><p class="watch-error">${esc(st.error)}</p></div>`
    );
  // Missing lists (an older main process, an odd answer) count as empty.
  const d = Object.fromEntries(
    ['inGame', 'recent', 'ever', 'owns', 'wishlist'].map(k => [
      k,
      Array.isArray(st.data?.[k]) ? st.data[k] : [],
    ])
  );
  const h2w = m =>
    (m / 60).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ч. за последние 2 недели';
  const row = (x, sub) =>
    `<div class="gf-row">${friendAvatar(x, true)}<button class="gf-name ${esc(x.status || '')}" data-friend="${esc(x.id)}"><strong>${esc(x.name || 'Друг Steam')}</strong><small>${esc(sub)}</small></button></div>`;
  const part = (title, list, body) =>
    list.length ? `<section><h3>${title}: ${list.length}</h3>${body}</section>` : '';
  const grid = list =>
    `<div class="gf-grid">${list
      .slice(0, 60)
      .map(x => friendAvatar(x))
      .join('')}${list.length > 60 ? `<span class="gf-more">+${list.length - 60}</span>` : ''}</div>`;
  const html = [
    part(
      'Друзей, играющих прямо сейчас',
      d.inGame,
      `<div class="gf-rows">${d.inGame.map(x => row(x, x.game ? 'В игре · ' + x.game : 'В игре')).join('')}</div>`
    ),
    part(
      'Друзей, игравших недавно',
      d.recent,
      `<div class="gf-rows two">${d.recent.map(x => row(x, h2w(x.minutes2w))).join('')}</div>`
    ),
    part('Друзей, игравших раньше', d.ever, grid(d.ever)),
    part('Друзей, у которых есть игра', d.owns, grid(d.owns)),
    part(`Друзей, добавивших ${esc(g.name)} в список желаемого`, d.wishlist, grid(d.wishlist)),
  ].join('');
  return (
    head +
    `<div class="library-activity-box game-friends">${html || '<p class="hint">Никто из друзей пока не играл в эту игру.</p>'}</div>`
  );
}
function libraryGamePage() {
  const g = game(librarySelection),
    owned = activeGames().find(x => x.id === librarySelection);
  if (!g || !owned) return library();
  const preferred = selectedLibraryOffer(owned);
  const played = lastPlayedAt(owned);
  return `<div class="library-game-page" data-price-game="${esc(g.id)}">${libraryGameHero(g)}${libraryGameActions(g, owned, preferred, played)}<div class="library-game-links"><button data-library-back>← Все игры</button><button id="library-store">Страница в магазине</button><button data-page="tracking">Отслеживание скидок</button></div><div class="library-game-columns">${libraryGameAbout(g, owned, preferred)}${libraryGameActivity(g, owned, played)}</div></div>`;
}
// The Steam library hero (the store art when it is missing) with the title on it.
function libraryGameHero(g) {
  const cover = artwork(g);
  const hero =
    safeImage(g.hero) ||
    (g.steam && !demo
      ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.steam}/library_hero.jpg`
      : cover);
  const img = hero
    ? `<img src="${esc(hero)}" data-fallback="${esc(cover)}" alt="" referrerpolicy="no-referrer">`
    : '';
  return `<div class="library-game-hero">${img}<div class="library-game-hero-shade"></div><h1>${esc(g.name)}</h1></div>`;
}
function libraryGameStatus(g, preferred) {
  if (isRunning(g.id))
    return (
      'В игре с ' +
      new Date(state.running[g.id].since).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    );
  if (preferred?.installed)
    return preferred.provider === 'epic' && preferred.executable && state.settings.epicDirectLaunch !== false
      ? 'Готова · без Epic Launcher'
      : preferred.provider === 'steam' && state.settings.steamSilent !== false
        ? 'Готова · Steam в фоне'
        : 'Готова к запуску';
  return preferred?.owned ? 'В аккаунте · не установлена' : 'Найдена на компьютере';
}
// The text of the big button: play, install, or go on with the download.
function libraryGameAction(g, preferred) {
  if (preferred?.installed) return '▶ ИГРАТЬ';
  if ((preferred?.provider || 'steam') !== 'epic') return '↓ УСТАНОВИТЬ';
  if (state.progress?.[g.id]?.nexus) return '▶ ПРОДОЛЖИТЬ ЗАГРУЗКУ';
  if (!(preferred?.namespace && preferred?.itemId)) return 'ОТКРЫТЬ В EPIC';
  return state.settings.nexusDownloads !== false ? '↓ УСТАНОВИТЬ' : '↓ УСТАНОВИТЬ В EPIC';
}
// The bar under the hero: play or stop, status, last launch, hours, and the buttons.
function libraryGameActions(g, owned, preferred, played) {
  const main = isRunning(g.id)
    ? `<button class="play-main stop" id="library-stop" title="Закрыть игру; сохранения уйдут в облако">■ ЗАКРЫТЬ</button>`
    : `<button class="play-main" id="library-play" ${demo ? 'disabled' : ''}>${libraryGameAction(g, preferred)}</button>`;
  const fact = (label, value) => `<div><small>${label}</small><strong>${value}</strong></div>`;
  const facts =
    fact('СТАТУС', esc(libraryGameStatus(g, preferred))) +
    fact(
      'ПОСЛЕДНИЙ ЗАПУСК',
      played
        ? new Date(played).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'Пока не запускалась'
    ) +
    fact('ВЫ ИГРАЛИ', owned.playtime ? hours(owned.playtime) : '—');
  const buttons = `${clientButtons(preferred)}<button class="secondary" id="library-hide" title="${owned.hidden ? 'Показать в библиотеке' : 'Скрыть из библиотеки'}">${owned.hidden ? '👁 Показать' : 'Скрыть'}</button><button class="secondary" id="library-favorite" aria-label="Избранное">${has('favorites', g.id) ? '★' : '☆'}</button><button class="secondary" id="library-wish" aria-label="Желаемое">${has('wishlist', g.id) ? '♥' : '♡'}</button><button class="secondary" data-props-open="${esc(g.id)}" aria-label="Свойства" title="Свойства">⚙</button>`;
  return `<div class="library-game-actions">${main}<div class="library-game-launch">${facts}</div>${progressLine(owned)}<div class="library-game-right">${buttons}</div></div>`;
}
// Left column: description, tags, collections, launch settings, platforms, news.
function libraryGameAbout(g, owned, preferred) {
  const p = preferred?.provider || 'steam';
  const desc =
    g.desc ||
    g.storeOffers?.find(o => o.description)?.description ||
    'Описание пока не получено от магазина.';
  const tags = (g.tags || []).map(t => `<span>${esc(t)}</span>`).join('');
  const platform = o =>
    `<button data-library-provider="${esc(o.provider)}" class="${p === o.provider ? 'active' : ''}"><strong>${names[o.provider]}</strong><span>${o.installed ? 'Установлена' : o.owned ? 'Имеется в аккаунте' : 'На диске'}${o.accountIds?.length > 1 ? ' · на ' + o.accountIds.length + ' аккаунтах' : ''}</span></button>`;
  const source = librarySourceLabel(owned);
  const sourceLine = source ? `<p class="library-source source-${source.kind}">${esc(source.text)}</p>` : '';
  return `<section>${sourceLine}<h2>ОБ ИГРЕ</h2><p>${esc(desc)}</p><div class="preview-tags">${tags}</div>${collectionsBox(owned)}${trackProcessBox(owned)}${launchOptionsBox(owned)}<h2>ПЛАТФОРМЫ</h2><div class="library-game-providers">${(owned.offers || []).map(platform).join('')}</div>${newsBox(owned)}</section>`;
}
// Right column: friends, launches and hours, achievements, DLC, workshop, screenshots.
function libraryGameActivity(g, owned, played) {
  const last = state.settings.recent?.find(r => r.id === g.id)?.time;
  const playtimeRows = (owned.offers || [])
    .filter(o => Number(o.playtime) > 0)
    .map(o => `<p>${names[o.provider]}: ${hours(o.playtime)}</p>`)
    .join('');
  const launches = `<div class="library-activity-box"><strong>${played ? 'Последний запуск' : 'Данных о запусках пока нет'}</strong><p>${played ? new Date(played).toLocaleString('ru-RU') : 'Дата появится после запуска через Nexus или из данных платформы.'}${last && last !== played ? '<br>Через Nexus: ' + new Date(last).toLocaleString('ru-RU') : ''}</p>${playtimeRows ? '<strong>Время в игре</strong>' + playtimeRows : ''}</div>`;
  const shots = (g.storeOffers?.find(o => o.screenshots?.length)?.screenshots || [])
    .map(
      src =>
        `<img src="${esc(safeImage(src))}" alt="Скриншот ${esc(g.name)}" referrerpolicy="no-referrer" loading="lazy">`
    )
    .join('');
  return `<aside class="library-game-activity">${gameFriendsBox(owned)}<h2>АКТИВНОСТЬ</h2>${launches}${mergedNote(owned)}${achievementsBox(owned)}${dlcSummary(owned)}${dlcBox(owned)}${workshopBox(owned)}<h2>СКРИНШОТЫ</h2><div class="library-gallery">${shots || `<div class="library-activity-box">${artTag(g)}</div>`}</div></aside>`;
}
// A game made of several store entries: how they were joined, and the split button.
function mergedNote(owned) {
  const offers = owned.offers || [];
  if (offers.filter(o => o.provider !== 'custom').length <= 1) return '';
  const by =
    { title: ' · по названию', external: ' · по базе игр', manual: ' · вручную' }[owned.mergedBy] || '';
  const split = demo ? '' : `<button class="ghost" data-split="${esc(owned.id)}">Разделить</button>`;
  return `<div class="merged-note">Объединено: ${offers.map(o => names[o.provider]).join(' + ')}${by} ${split}</div>`;
}
// ---- the left panel, laid out like the Steam client's library ----------------------
// Sections: Избранное, the user's collections, then "Без категории", each folding.
let treeQuery = '';
const TREE_KEY = 'nexus.treeCollapsed';
const treeCollapsed = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(TREE_KEY) || '[]');
    } catch {
      return [];
    }
  })()
);
function toggleTreeGroup(id) {
  if (treeCollapsed.has(id)) treeCollapsed.delete(id);
  else treeCollapsed.add(id);
  try {
    localStorage.setItem(TREE_KEY, JSON.stringify([...treeCollapsed]));
  } catch {}
  renderLibraryTree();
}
const SORT_NAMES = { name: 'по названию', recent: 'недавно запущенные', playtime: 'больше всего времени' };
// Steam app id → how many friends play it now (the green mark next to a game).
function friendsPlaying() {
  const out = new Map();
  const seen = new Set();
  for (const group of friendsState.data?.steam || [])
    for (const f of group.friends || [])
      if (f.status === 'ingame' && f.gameId && !seen.has(f.id)) {
        seen.add(f.id);
        out.set(String(f.gameId), (out.get(String(f.gameId)) || 0) + 1);
      }
  return out;
}
function treeRow(g, playing) {
  const installed = g.offers?.some(o => o.installed);
  const friends = g.steam ? playing.get(String(g.steam)) || 0 : 0;
  const cls = [
    'tree-game',
    librarySelection === g.id ? 'active' : '',
    installed || g.progress ? '' : 'not-installed',
    isRunning(g.id) ? 'running' : '',
  ].join(' ');
  const source = librarySourceLabel(g);
  return `<button class="${cls}" data-detail="${esc(g.id)}" title="${esc(g.name)}${source ? ' · ' + esc(source.text) : ''}${friends ? ` · играют друзья: ${friends}` : ''}"><span class="tree-friends">${
    friends
      ? '<svg viewBox="0 0 10 12" aria-label="Играют друзья"><circle cx="5" cy="3" r="2.6"/><path d="M0 12c0-3.6 2.2-5.6 5-5.6s5 2 5 5.6z"/></svg>'
      : ''
  }</span><span class="tree-icon">${artTag(g)}</span><span class="tree-name">${esc(g.name)}</span>${
    isRunning(g.id)
      ? '<small>Запущено</small>'
      : g.progress
        ? '<small>Загрузка</small>'
        : source?.kind === 'family'
          ? '<small class="tree-family" role="img" aria-label="Семейная библиотека">👪</small>'
          : ''
  }</button>`;
}
// Pages whose layout hides the library panel (see style.css).
const TREE_HIDDEN = ['store', 'game', 'wishlist', 'accounts', 'tracking', 'review', 'community'];
let treeHtml = null;
function renderLibraryTree() {
  const el = $('#library-tree');
  if (!el) return;
  // The panel's own controls follow the library's state.
  const source = $('#side-source');
  if (source && source.value !== filter) source.value = filter;
  const ready = $('#side-ready');
  if (ready) {
    const installedOnly = libraryMode() !== 'owned';
    ready.classList.toggle('active', installedOnly);
    ready.dataset.libraryView = installedOnly ? 'owned' : 'installed';
    ready.title = installedOnly
      ? 'Показаны установленные · показать все игры'
      : 'Показать только установленные';
  }
  const sort = $('#side-sort');
  if (sort) sort.title = 'Порядок: ' + SORT_NAMES[librarySort];
  // The panel is hidden on these pages: it is built when it is shown again.
  if (TREE_HIDDEN.includes(page)) return;
  const q = treeQuery.trim().toLowerCase();
  const shown = filteredLibrary().filter(g => !q || g.name.toLowerCase().includes(q));
  // Totals like Steam's "(30/386)": every game of the account, installed or not.
  const everything = activeGames().filter(
    g => !g.hidden && g.offers?.some(o => offerMatchesFilter(o) && inAccountLibrary(o))
  );
  const favorites = new Set(state.settings.favorites || []);
  const collections = state.settings.collections || [];
  const sorted = new Set();
  const groups = [
    { id: 'favorites', name: 'Избранное', has: g => favorites.has(g.id) },
    ...collections.map(c => ({
      id: 'c:' + c.id,
      name: c.name,
      has: g => c.games.includes(g.id),
      open: c.id,
    })),
  ];
  for (const x of groups) for (const g of everything) if (x.has(g)) sorted.add(g.id);
  groups.push({ id: 'none', name: 'Без категории', has: g => !sorted.has(g.id), always: true });
  const playing = friendsPlaying();
  let rows = 0;
  const html = groups
    .map(x => {
      const list = shown.filter(x.has);
      const total = everything.filter(x.has).length;
      if (!list.length && !x.always && !total) return '';
      const open = !treeCollapsed.has(x.id);
      const count = total > list.length ? `${list.length}/${total}` : `${list.length}`;
      const body = open
        ? list
            .slice(0, Math.max(0, 2000 - rows))
            .map(g => (rows++, treeRow(g, playing)))
            .join('')
        : '';
      const grid =
        x.open !== undefined
          ? `<button class="side-icon tree-open" data-collection="${esc(x.open)}" title="Открыть коллекцию сеткой" aria-label="Открыть коллекцию сеткой">▦</button>`
          : '';
      return `<div class="tree-head"><button class="tree-group" data-tree-group="${esc(x.id)}" aria-expanded="${open}"><b>${open ? '—' : '+'}</b> ${esc(x.name)} <span>(${count})</span></button>${grid}</div>${body}`;
    })
    .join('');
  const next =
    (shown.length ? html : html + '<p class="tree-empty">Нет игр в выбранном списке</p>') +
    (rows >= 2000 ? '<p class="tree-empty">Показаны первые 2000 — используйте поиск</p>' : '');
  // Unchanged rows are not rebuilt (keeps hover and scrolling, saves layout).
  if (next === treeHtml && el.childElementCount) return;
  treeHtml = next;
  el.innerHTML = next;
}
document.addEventListener('click', event => {
  const el = event.target.closest('#library-tree [data-tree-group], #side-sort');
  if (!el) return;
  if (el.id === 'side-sort') {
    const order = Object.keys(SORT_NAMES);
    librarySort = order[(order.indexOf(librarySort) + 1) % order.length];
    render();
    toast('Порядок: ' + SORT_NAMES[librarySort]);
    return;
  }
  toggleTreeGroup(el.dataset.treeGroup);
});
document.addEventListener('change', event => {
  if (event.target.id !== 'side-source') return;
  filter = event.target.value;
  libraryLimit = LIBRARY_PAGE;
  render();
});
document.addEventListener('input', event => {
  if (event.target.id !== 'side-search') return;
  treeQuery = event.target.value;
  renderLibraryTree();
});
const accountStatusText = a =>
  a?.status === 'connected'
    ? a.name
    : a?.status === 'checking'
      ? 'Проверяем вход…'
      : a?.status === 'unavailable'
        ? 'Не удалось проверить вход'
        : 'Не выполнен вход';
function accountRows(provider) {
  const list = (state.accountList || []).filter(
    a => a.provider === provider && (a.status !== 'signedOut' || a.key === 'steam:0')
  );
  if (!list.length) return '<p class="hint">Аккаунт не подключён.</p>';
  return `<ul class="account-list">${list
    .map(
      a =>
        `<li class="${a.status === 'connected' ? 'connected' : ''}"><span class="profile-avatar">${safeImage(a.avatar) ? `<img src="${esc(safeImage(a.avatar))}" alt="" referrerpolicy="no-referrer">` : provider === 'steam' ? 'S' : 'E'}</span><span><strong>${esc(accountStatusText(a))}</strong><small data-account-message="${esc(a.key)}">${esc(a.message || (a.status === 'connected' ? 'Вход подтверждён' : ''))}</small></span>${a.status !== 'signedOut' || provider === 'epic' || a.key !== 'steam:0' ? `<button class="ghost" data-forget="${esc(a.key)}">${a.status === 'connected' || a.status === 'unavailable' ? 'Выйти и забыть' : 'Убрать'}</button>` : ''}</li>`
    )
    .join('')}</ul>`;
}
function keyField(name, label, placeholder, enabled, error) {
  return `<label class="field key-field">${label}<span class="key-row"><input type="password" autocomplete="off" data-key-input="${name}" placeholder="${enabled ? 'Сохранён · введите новый, чтобы заменить' : esc(placeholder)}"><button class="secondary" type="button" data-save-key="${name}">Сохранить</button>${enabled ? `<button class="ghost" type="button" data-clear-key="${name}">Удалить</button>` : ''}</span>${error ? `<small class="watch-error">${esc(error)}</small>` : ''}</label>`;
}
// How a game was started (reply of "play").
function playToast(result) {
  return (
    {
      direct: 'Игра запущена без Epic Games Launcher. Сохранения синхронизируются с облаком Epic.',
      'steam-silent': 'Steam запущен в фоне, игра стартует без окна Steam.',
      started: 'Загрузка началась — прогресс на странице «Загрузки».',
      'steam-download': 'Steam скачивает игру в фоне, без своего окна. Прогресс — на странице «Загрузки».',
      'client-install': 'Устанавливаем лаунчер. После входа в аккаунт игра откроется в нём.',
      steam: 'Запуск передан Steam.',
      canceled: 'Запуск отменён.',
    }[result?.how] || 'Запрос передан клиенту. Запуск и лицензию проверяет платформа.'
  );
}
// ---- the install window (Epic games downloaded by Nexus) -------------------------
let installDlg = null; // { id, loading, error, opts, root, free, tags: Set, dlcs: Set, busy }
// An Epic game of the account, not installed, downloaded by Nexus: the window opens.
function wantsInstallWindow(g, provider) {
  const o = g?.offers?.find(x => x.provider === provider);
  return (
    !demo &&
    provider === 'epic' &&
    o &&
    !o.installed &&
    o.namespace &&
    o.itemId &&
    state.settings.nexusDownloads !== false &&
    !state.progress?.[g.id]?.nexus
  );
}
async function openInstallDialog(id) {
  installDlg = { id, loading: true };
  renderInstallDialog();
  try {
    const o = await call('installOptions', id);
    installDlg = {
      id,
      opts: o,
      root: o.root,
      free: o.free,
      tags: new Set(o.components.map(c => c.tag)),
      dlcs: new Set(),
    };
  } catch (e) {
    installDlg = { id, error: e.message };
  }
  renderInstallDialog();
}
function installSize() {
  const o = installDlg.opts;
  if (!o.components.length) return o.installSize;
  return o.baseSize + o.components.filter(c => installDlg.tags.has(c.tag)).reduce((n, c) => n + c.size, 0);
}
function renderInstallDialog() {
  let dlg = $('#install-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'install-dialog';
    dlg.className = 'install-dialog';
    dlg.addEventListener('close', () => (installDlg = null));
    document.body.append(dlg);
  }
  if (!installDlg) {
    if (dlg.open) dlg.close();
    return;
  }
  const g = game(installDlg.id) || { name: 'Игра' };
  const x = installDlg;
  let body;
  if (x.loading) body = '<p class="hint">Загружаем сведения о файлах игры с серверов Epic…</p>';
  else if (x.error)
    body = `<p class="watch-error">${esc(x.error)}</p><div class="install-buttons"><button class="secondary" data-install-client>Через Epic Games Launcher</button><button class="secondary" data-install-cancel>Закрыть</button></div>`;
  else {
    const o = x.opts;
    const size = installSize();
    const enough = !x.free || x.free > size + 512 * 1024 ** 2;
    body = `<div class="install-sizes"><div><small>СКАЧАТЬ</small><strong>${bytesText(o.components.length ? Math.round((o.downloadSize * size) / Math.max(1, o.installSize)) : o.downloadSize)}</strong></div><div><small>НА ДИСКЕ</small><strong>${bytesText(size)}</strong></div><div><small>СВОБОДНО</small><strong class="${enough ? '' : 'warn'}">${x.free ? bytesText(x.free) : '—'}</strong></div></div><label class="field install-folder"><small>ПАПКА</small><span>${esc(x.root)}\\${esc(o.folderName)}</span><button class="secondary" data-install-root>Изменить…</button></label>${
      o.components.length
        ? `<h3>Компоненты</h3><p class="hint">Основные файлы игры ставятся всегда (${bytesText(o.baseSize)}).</p>${o.components
            .map(
              c =>
                `<label class="check"><input type="checkbox" data-install-tag="${esc(c.tag)}" ${x.tags.has(c.tag) ? 'checked' : ''}> ${esc(c.label)} <small>${bytesText(c.size)}</small></label>`
            )
            .join('')}`
        : ''
    }${
      o.dlcs.length
        ? `<h3>Дополнения из вашей библиотеки</h3>${o.dlcs
            .map(
              d =>
                `<label class="check"><input type="checkbox" data-install-dlc="${esc(d.appId)}" ${x.dlcs.has(d.appId) ? 'checked' : ''} ${d.installed ? 'disabled' : ''}> ${esc(d.title)}${d.installed ? ' <small>установлено</small>' : ''}</label>`
            )
            .join('')}`
        : ''
    }${o.thirdParty ? '<p class="notice warning">Эта игра работает через лаунчер издателя (EA, Ubisoft и т. п.): для игры понадобится он.</p>' : ''}${enough ? '' : '<p class="watch-error">На этом диске может не хватить места.</p>'}<div class="install-buttons"><button class="primary" data-install-start ${x.busy ? 'disabled' : ''}>↓ Установить</button><button class="secondary" data-install-client>Через Epic Games Launcher</button><button class="secondary" data-install-cancel>Отмена</button></div><p class="hint install-import">Игра уже есть на диске (после переустановки системы или с другого ПК)? <button class="link" data-install-import>Указать её папку…</button></p>`;
  }
  dlg.innerHTML = `<button class="close" data-install-cancel aria-label="Закрыть">×</button><h2>Установка «${esc(g.name)}»</h2><p class="hint">Nexus скачает игру с серверов Epic сам — без Epic Games Launcher. Пауза и очередь — на странице «Загрузки».</p>${body}`;
  if (!dlg.open) dlg.showModal();
}
// The DLC of an installed Epic game (game page).
const ownedDlcState = new Map();
async function requestDlcs(id) {
  if (!api?.gameDlcs || demo || ownedDlcState.has(id)) return;
  ownedDlcState.set(id, null);
  try {
    ownedDlcState.set(id, await call('gameDlcs', id));
  } catch (e) {
    ownedDlcState.set(id, { error: e.message });
  }
  if (librarySelection === id) render();
}
function dlcBox(g) {
  const o = g.offers?.find(x => x.provider === 'epic');
  if (!o?.installed || !o.namespace || demo) return '';
  requestDlcs(g.id);
  const list = ownedDlcState.get(g.id);
  if (!list)
    return '<h2>ДОПОЛНЕНИЯ</h2><div class="library-activity-box"><p class="hint">Загружаем…</p></div>';
  if (list.error) return '';
  if (!list.length) return '';
  return `<h2>ДОПОЛНЕНИЯ</h2><div class="library-activity-box dlc-list">${list
    .map(
      d =>
        `<div class="dlc-row"><span>${esc(d.title)}</span>${
          d.installed
            ? '<small>Установлено</small>'
            : d.downloading || state.progress?.[`${g.id}#${d.appId}`]
              ? '<small>В загрузках</small>'
              : `<button class="secondary" data-dlc-install="${esc(d.appId)}">↓ Установить</button>`
        }</div>`
    )
    .join('')}</div>`;
}
// "Запуск игр": Epic without its launcher, cloud saves, Steam hidden in the tray.
function launchCard() {
  const s = state.settings;
  // What this system cannot do (see src/os.cjs) is not offered: macOS and Linux
  // start Epic games through Epic Games Launcher or Heroic / Legendary.
  const f = state.features || { epicDirect: true, epicDownloads: true, steamDownloads: true };
  const available = {
    epicDirectLaunch: f.epicDirect,
    epicCloudSaves: f.epicDirect,
    nexusDownloads: f.epicDownloads,
  };
  const check = (name, label, hint) =>
    available[name] === false
      ? ''
      : `<label class="check"><input type="checkbox" data-launch-setting="${name}" ${s[name] !== false ? 'checked' : ''} ${demo ? 'disabled' : ''}> ${label}</label>${hint ? `<p class="hint">${hint}</p>` : ''}`;
  const other = f.epicDirect
    ? ''
    : `<p class="hint">${state.platform === 'linux' ? 'Epic Games Launcher для Linux не существует: игры Epic устанавливаются и запускаются через Heroic Games Launcher или Legendary, Nexus находит их сам.' : 'На macOS игры Epic устанавливает и запускает Epic Games Launcher.'} Игры Steam устанавливает сам Steam.</p>`;
  return `<section class="settings-card launch-card"><h3>Запуск игр</h3><p>Nexus запускает игры сам, не открывая окна сторонних лаунчеров, где это возможно.</p>${other}${check(
    'epicDirectLaunch',
    'Запускать игры Epic без Epic Games Launcher',
    'Игра входит в ваш аккаунт Epic сама, как в Legendary и Heroic. Игры EA и Ubisoft, а также любые сбои Nexus передаёт Epic Launcher.'
  )}${check(
    'epicCloudSaves',
    'Синхронизировать облачные сохранения Epic',
    'Перед игрой Nexus берёт более новое сохранение из облака, после выхода — загружает изменённое. Формат тот же, что у Epic Launcher. Перед заменой локальное сохранение копируется в «save-backups».'
  )}${check(
    'steamSilent',
    'Запускать Steam скрыто, только значок в трее',
    'Steam нужен играм для защиты, Steam Cloud и достижений, но его окно не появляется.'
  )}${check('steamCloseAfter', 'Закрывать Steam после игры, если его запустил Nexus', '')}${check(
    'nexusDownloads',
    'Устанавливать игры без окон лаунчеров',
    'Игры Epic Nexus скачивает сам с серверов Epic (как Legendary): с паузой, докачкой, обновлениями и проверкой файлов. Игры Steam скачивает Steam в фоне, без своего окна.'
  )}</section>`;
}
// "Загрузки": speed limit, allowed hours, auto-updates, notifications.
function downloadsCard() {
  const s = state.settings;
  const sch = s.downloadSchedule || { enabled: false, from: '01:00', to: '07:00' };
  const off = demo ? 'disabled' : '';
  const mb = s.downloadLimit ? +(s.downloadLimit / 1024).toFixed(1) : 0;
  const check = (id, on, label) =>
    `<label class="check"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${off}> ${label}</label>`;
  const limit = `<label class="field">Ограничение скорости, МБ/с <input type="number" id="download-limit" min="0" max="10000" step="0.5" value="${mb}" ${off}><small>0 — без ограничений</small></label>`;
  const hours = `${check('schedule-enabled', sch.enabled, 'Скачивать только в эти часы')}<div class="time-range"><input type="time" id="schedule-from" value="${esc(sch.from)}" ${off}> — <input type="time" id="schedule-to" value="${esc(sch.to)}" ${off}></div><p class="hint">Вне этих часов загрузки ждут; кнопка «Загрузить сейчас» запускает игру без ожидания.</p>`;
  return `<section class="settings-card downloads-card"><h3>Загрузки</h3><p>Для игр, которые скачивает Nexus (Epic Games). Загрузками Steam управляет сам Steam.</p>${limit}${hours}${check(
    'epic-auto-update',
    s.epicAutoUpdate !== false,
    'Обновлять игры Epic автоматически'
  )}${check(
    'download-notify',
    s.downloadNotify !== false,
    'Уведомлять, когда игра скачалась или обновилась'
  )}<button class="secondary" id="check-game-updates" ${off}>Проверить обновления игр</button></section>`;
}
function updatesCard() {
  const u = state.updater || {};
  const text =
    {
      checking: 'Проверяем обновления…',
      downloading: `Загружаем версию ${esc(u.version || '')}${u.percent ? ' · ' + u.percent + '%' : ''}`,
      ready: `Версия ${esc(u.version || '')} загружена`,
      manual:
        typeof u.progress === 'number'
          ? `Загружаем установщик версии ${esc(u.version || '')}… ${u.progress}%`
          : `Вышла версия ${esc(u.version || '')}. Nexus скачает установщик и запустит его: библиотека, аккаунты и настройки сохранятся.${u.error ? ' ' + esc(u.error) : ''}`,
      current: 'Установлена последняя версия',
      error: 'Ошибка обновления: ' + esc(u.error || ''),
      unsupported:
        state.platform === 'linux'
          ? 'Автообновление работает в версиях AppImage и .deb со страницы релизов.'
          : 'Автообновление работает в установленной версии (установщик Nexus Setup).',
    }[u.status] || 'Проверка выполняется при запуске и каждые 6 часов.';
  const action =
    u.status === 'ready'
      ? '<button class="primary" id="install-update">Перезапустить и обновить</button>'
      : u.status === 'manual'
        ? `<button class="primary" id="open-update" ${typeof u.progress === 'number' ? 'disabled' : ''}>Скачать и установить</button>`
        : '<button class="secondary" id="check-update">Проверить</button>';
  const auto = u.manual ? 'Проверять обновления автоматически' : 'Загружать обновления автоматически';
  return `<section class="settings-card"><div class="settings-row"><div><h3>Обновления · Nexus ${esc(state.version || '')}</h3><p>${text}</p>${
    u.status === 'manual' && Array.isArray(u.notes) && u.notes.length
      ? `<div class="update-notes"><small>Что нового в ${esc(u.version || '')}</small><ul>${u.notes
          .slice(0, 4)
          .map(n => `<li>${esc(n)}</li>`)
          .join('')}</ul></div>`
      : ''
  }</div><div class="account-actions">${action}</div></div><label class="check"><input type="checkbox" id="auto-update" ${state.settings.autoUpdate !== false ? 'checked' : ''}> ${auto}</label></section>`;
}
function accounts() {
  const list = state.accountList || [];
  const steamConnected = list.some(a => a.provider === 'steam' && a.status === 'connected');
  const epicConnected = list.some(a => a.provider === 'epic' && a.status === 'connected');
  return `${notice()}<div class="section-head"><h1>Твои аккаунты</h1><button class="secondary" id="refresh-accounts">↻ Проверить вход</button></div><p class="subheading">Несколько аккаунтов Steam и Epic Games в одной библиотеке.</p>${state.storageWarning ? `<div class="notice warning">${esc(state.storageWarning)}</div>` : ''}<div class="account-grid">
${steamAccountCard(steamConnected)}
${epicAccountCard(epicConnected)}</div>
${importCards(steamConnected, epicConnected)}
${backupCard()}
${integrationsCard()}
${steamApiCard()}
${diskCard()}
${socialCard()}${launchCard()}${downloadsCard()}${updatesCard()}
<section class="settings-card"><h3>Nexus</h3><p>Независимый лаунчер для Windows, macOS и Linux, не связан с Valve и Epic Games. Покупку подтверждаешь на официальном сайте.</p><button class="secondary" id="demo">Посмотреть демонстрационную библиотеку</button></section>`;
}
function accountHead(symbol, title, provider) {
  return `<div class="account-head"><span class="account-symbol">${symbol}</span><div><h2>${title}</h2><p>${esc(accountStatusText(state.accounts[provider]))}</p></div></div>${accountRows(provider)}`;
}
function steamAccountCard(connected) {
  const login = connected
    ? '<button class="secondary" data-login-add="steam">＋ Добавить аккаунт Steam</button>'
    : '<button class="primary" data-login="steam">Войти в Steam</button>';
  return `<section class="account-card">${accountHead('S', 'Steam', 'steam')}<p>Вход на официальной странице Steam (Steam Guard работает как обычно). Игры аккаунта, время в игре и даты запуска загружаются автоматически.</p><label class="check"><input type="checkbox" data-remember="steam" ${state.settings.remember.steam ? 'checked' : ''}> Запомнить вход и восстанавливать автоматически</label><div class="account-actions">${login}<button class="ghost" data-browser="steam">Открыть в браузере ↗</button></div></section>`;
}
function epicAccountCard(connected) {
  const login = connected
    ? '<button class="secondary" data-login-add="epic">＋ Добавить аккаунт Epic</button>'
    : '<button class="primary" data-login="epic">Войти в Epic Games</button>';
  const codeForm = `<form id="epic-code-form" class="form-row compact"><label class="field">КОД ИЗ БРАУЗЕРА<input id="epic-code" autocomplete="off" placeholder="authorizationCode или весь JSON со страницы"></label><button class="secondary" type="submit">Подключить</button></form><div class="hint">Если вход Google/Apple не открывается во встроенном окне: нажмите «Войти через браузер», войдите, скопируйте значение <code>authorizationCode</code> со страницы и вставьте сюда. Код действует несколько минут.</div>`;
  return `<section class="account-card">${accountHead('E', 'Epic Games', 'epic')}<p>Вход через официальную страницу Epic. После входа Nexus получает токен библиотеки (как Legendary и Heroic); пароль не сохраняется.</p><label class="check"><input type="checkbox" data-remember="epic" ${state.settings.remember.epic ? 'checked' : ''}> Запомнить вход (токен обновления шифруется системой)</label><div class="account-actions">${login}<button class="ghost" data-browser="epic">Войти через браузер ↗</button></div>${codeForm}</section>`;
}
// Wishlists and giveaways, then Steam collections.
function importCards(steamConnected, epicConnected) {
  return `<section class="settings-card"><h3>Списки желаемого и раздачи</h3><p>Списки желаемого подключённых аккаунтов Steam и Epic попадают в «Желаемое» Nexus сами: после входа и каждые 3 часа. Игра, убранная из списка в магазине, исчезает и из Nexus.</p><div class="account-actions"><button class="secondary" id="import-wishlists" ${steamConnected || epicConnected ? '' : 'disabled'}>↻ Синхронизировать сейчас</button></div><label class="check"><input type="checkbox" id="notify-giveaways" ${state.settings.notifyGiveaways !== false ? 'checked' : ''}> Уведомлять о новых бесплатных играх Epic</label><label class="check"><input type="checkbox" id="notify-wish-sales" ${state.settings.notifyWishSales !== false ? 'checked' : ''}> Уведомлять о скидках на игры из желаемого</label></section>
<section class="settings-card"><h3>Коллекции Steam</h3><p>Перенести коллекции, скрытые и избранные игры из клиента Steam (для подключённых аккаунтов). Динамические коллекции Steam — это правила фильтрации, они не переносятся.</p><div class="account-actions"><button class="secondary" id="import-collections" ${steamConnected ? '' : 'disabled'}>Импортировать коллекции Steam</button></div></section>`;
}
function backupCard() {
  return `<section class="settings-card"><h3>Резервная копия и диагностика</h3><p>Копия содержит списки, коллекции, склейки, отслеживания цен и сохранённые библиотеки. Входы, токены и ключи в неё не попадают. Диагностика — отчёт для поиска проблем; токены и ключи в нём скрыты.</p><div class="account-actions"><button class="secondary" id="export-backup">Сохранить копию</button><button class="secondary" id="import-backup">Восстановить из копии</button><button class="secondary" id="save-diagnostics">Сохранить диагностику</button><button class="ghost" id="open-logs">Открыть папку журналов</button><button class="ghost" id="clear-cache" title="Картинки магазина и обложки скачаются заново. Входы и настройки останутся.">Очистить кэш</button></div></section>`;
}
// Optional keys of outside services (IsThereAnyDeal, IGDB, SteamGridDB).
function integrationsCard() {
  const i = state.integrations || {};
  return `<section class="settings-card"><h3>Внешние сервисы · необязательно</h3><p>Бесплатные личные ключи включают дополнительные функции. Ключи шифруются системой и не попадают в интерфейс.</p>${i.encryption === false ? '<div class="notice warning">Защищённое хранилище недоступно, ключи сохранить нельзя.</div>' : ''}
${keyField('itad', 'ISTHEREANYDEAL API KEY · цены в других магазинах, исторический минимум, склейка игр', 'isthereanydeal.com → Apps → API key', i.itad?.enabled, i.itad?.error)}
${keyField('igdbId', 'IGDB · TWITCH CLIENT ID · описания, жанры, обложки, склейка игр', 'dev.twitch.tv → Applications', i.igdb?.enabled, i.igdb?.error)}
${keyField('igdbSecret', 'IGDB · TWITCH CLIENT SECRET', 'секрет того же приложения Twitch', i.igdb?.enabled, '')}
${keyField('sgdb', 'STEAMGRIDDB API KEY · вертикальные обложки для Epic и сторонних игр', 'steamgriddb.com → Preferences → API', i.sgdb?.enabled, i.sgdb?.error)}</section>`;
}
function steamApiCard() {
  const saved = state.integrations?.steamWebApi?.enabled;
  return `<section class="settings-card"><h3>Облачная библиотека Steam · импорт по Web API key</h3><p>Запасной вариант, если автоматическая синхронизация недоступна. Работает только для подключённого аккаунта.</p><form id="steam-form" class="form-row"><label class="field">STEAMID64<input id="steam-id" inputmode="numeric" maxlength="17" autocomplete="off" placeholder="7656119…" value="${esc(state.accounts.steam?.steamId || '')}"></label><label class="field">ЛИЧНЫЙ WEB API KEY<input id="api-key" type="password" autocomplete="off" placeholder="${saved ? 'Сохранён' : '32 символа'}"></label><button class="primary" type="submit">Импортировать</button></form></section>`;
}
function diskCard() {
  return `<section class="settings-card"><div class="settings-row"><div><h3>Библиотеки на диске</h3><p>${esc(state.settings.steamRoot || (state.platform === 'linux' ? 'Steam определяется автоматически (также Flatpak и Snap), игры Epic — по спискам Heroic и Legendary.' : 'Steam определяется автоматически, Epic — по манифестам и LauncherInstalled.dat.'))}</p></div><button class="secondary" id="steam-root">Указать папку Steam</button></div><label class="check"><input type="checkbox" id="auto-start" ${state.settings.autoStart ? 'checked' : ''}> Запускать Nexus при входе в систему</label></section>`;
}
const requestedPrices = new Map();
let priceWorkers = 0;
const priceQueue = [];
function requestVisiblePrices() {
  if (!api?.gamePrices || demo) return;
  const country = state.settings.storeCountry || 'US';
  for (const el of document.querySelectorAll('[data-price-game]')) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight + 800) continue;
    // The library shows no prices: only store cards ask for them.
    if (el.classList.contains('library-card') || el.classList.contains('library-game-page')) continue;
    const id = el.dataset.priceGame,
      g = game(id),
      key = id + ':' + country;
    if (!g || !priceOffers(g).length || Date.now() - (requestedPrices.get(key) || 0) < 300000) continue;
    if (
      g.storeOffers?.length &&
      g.storeOffers.every(o => o.country === country && (o.price || o.priceStatus === 'ready'))
    )
      continue;
    requestedPrices.set(key, Date.now());
    priceQueue.push({ id, country });
  }
  pumpPrices();
}
function pumpPrices() {
  while (priceWorkers < 3 && priceQueue.length) {
    const item = priceQueue.shift();
    if (item.country !== (state.settings.storeCountry || 'US')) continue;
    priceWorkers++;
    call('gamePrices', { id: item.id })
      .then(result => {
        if (result.country === (state.settings.storeCountry || 'US')) {
          detailPrices.set(item.id, result);
          refreshCards(new Set([item.id]));
        }
      })
      .catch(() => {})
      .finally(() => {
        priceWorkers--;
        pumpPrices();
      });
  }
}
// Store data (prices section) and download progress are applied to the game
// objects once per received state.
const derived = new WeakSet();
function applyDerived(s) {
  if (!s || derived.has(s)) return;
  derived.add(s);
  const prices = s.prices || {},
    progress = s.progress || {};
  for (const g of s.games || []) {
    const p = prices[g.id];
    if (p) {
      g.storeOffers = p.o;
      if (p.n && /^Steam #/.test(g.name)) g.name = p.n;
    }
    g.progress = progress[g.id] || null;
  }
  for (const g of s.catalog || []) {
    const p = prices[g.id];
    if (!p) continue;
    g.storeOffers = p.o;
    if (p.n) g.name = p.n;
    if (!g.image && p.i) g.image = p.i;
  }
}
// Updates only the cards of the given games (prices, progress, covers)
// instead of re-rendering the page.
function refreshCards(ids) {
  applyDerived(state);
  if (!ids.size) return;
  if (page === 'library' && librarySelection && ids.has(librarySelection)) return render();
  for (const id of ids) {
    const g = game(id);
    if (!g) continue;
    for (const el of document.querySelectorAll(`[data-price-game="${CSS.escape(id)}"]`)) {
      if (el.classList.contains('game-card')) el.outerHTML = card(g);
      else if (el.classList.contains('library-card')) el.outerHTML = libraryCard(g);
      else if (el.classList.contains('store-list-row')) {
        const box = el.querySelector('.list-row-price');
        if (box)
          box.innerHTML = salePrice(priceOffers(g).find(o => o.provider === 'steam') || priceOffers(g)[0]);
      }
    }
  }
  if (detailOpen() && ids.has(detailId)) renderDetail();
}
// The open/closed state of <details> panels survives re-rendering.
function rememberOpenPanels() {
  const panel = document.querySelector('.merge-suggestions');
  if (panel) suggestionsOpen = panel.open;
}
function render() {
  // A full render covers every pending change.
  dataChanged = false;
  changedCards.clear();
  applyDerived(state);
  rememberOpenPanels();
  if (librarySelection && !filteredLibrary().some(g => g.id === librarySelection)) librarySelection = null;
  rememberView();
  renderFriends();
  document.body.dataset.page = page;
  // The window's own buttons lie over the top strip: on the right (Windows, Linux) or the left (macOS).
  document.body.classList.toggle('native-window', state.native === true && state.platform !== 'darwin');
  document.body.classList.toggle('mac-window', state.native === true && state.platform === 'darwin');
  const version = $('#app-version');
  if (version)
    version.textContent = [
      state.version,
      { win32: 'WINDOWS', darwin: 'MACOS', linux: 'LINUX' }[state.platform],
    ]
      .filter(Boolean)
      .join(' · ');
  renderProfiles();
  renderLibraryTree();
  $('#lib-count').textContent = libraryGames().length;
  $('#wish-count').textContent = state.settings.wishlist.length;
  document
    .querySelectorAll('[data-page]')
    .forEach(el => el.classList.toggle('active', el.dataset.page === page));
  // Top menu items with a drop-down light up for every page of their menu.
  document
    .querySelectorAll('[data-nav-pages]')
    .forEach(el => el.classList.toggle('active', el.dataset.navPages.split(' ').includes(page)));
  document.querySelectorAll('.topbar nav .nav').forEach(el => {
    if (el.classList.contains('active')) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  $('#breadcrumb').innerHTML =
    page === 'library' && librarySelection
      ? 'БИБЛИОТЕКА <span>/ ' + esc(game(librarySelection)?.name || 'ИГРА') + '</span>'
      : page === 'game'
        ? 'МАГАЗИН <span>/ ' + esc(game(detailId)?.name || 'ИГРА') + '</span>'
        : {
            store: 'МАГАЗИН <span>/ ОБЗОР</span>',
            library: 'БИБЛИОТЕКА <span>/ ВСЕ ИГРЫ</span>',
            wishlist: 'КОЛЛЕКЦИЯ <span>/ ЖЕЛАЕМОЕ</span>',
            favorites: 'КОЛЛЕКЦИЯ <span>/ ИЗБРАННОЕ</span>',
            recent: 'БИБЛИОТЕКА <span>/ НЕДАВНИЕ</span>',
            downloads: 'БИБЛИОТЕКА <span>/ ЗАГРУЗКИ</span>',
            storage: 'БИБЛИОТЕКА <span>/ ХРАНИЛИЩЕ</span>',
            news: 'БИБЛИОТЕКА <span>/ НОВОСТИ</span>',
            activity: 'СООБЩЕСТВО <span>/ АКТИВНОСТЬ ДРУЗЕЙ</span>',
            profile: 'СООБЩЕСТВО <span>/ ПРОФИЛЬ</span>',
            review: 'ПРОФИЛЬ <span>/ ИТОГИ NEXUS</span>',
            community: communityCrumb(),
            friend: 'СООБЩЕСТВО <span>/ ПРОФИЛЬ ДРУГА</span>',
            tracking: 'МАГАЗИН <span>/ СКИДКИ</span>',
            accounts: 'NEXUS <span>/ НАСТРОЙКИ</span>',
          }[page];
  renderStoreTools();
  $('#search').disabled = page === 'accounts';
  $('#mode-label').textContent = demo
    ? 'Демонстрационная библиотека'
    : api
      ? 'Локальная библиотека'
      : 'Просмотр интерфейса · без подключения';
  $('#mode-label').classList.toggle('demo-badge', demo);
  $('#content').innerHTML =
    page === 'store'
      ? store()
      : page === 'game'
        ? notice() + storeGamePage()
        : page === 'downloads'
          ? downloadsPage()
          : page === 'storage'
            ? storagePage()
            : page === 'news'
              ? newsPage()
              : page === 'activity'
                ? activityPage()
                : page === 'profile'
                  ? profilePage()
                  : page === 'review'
                    ? reviewPage()
                    : page === 'community'
                      ? ''
                      : page === 'friend'
                        ? friendPage()
                        : page === 'accounts'
                          ? accounts() + epicImportPanel()
                          : page === 'tracking'
                            ? dealsPage()
                            : librarySelection && page === 'library'
                              ? libraryGamePage()
                              : library();
  renderCommunity();
  renderPropsDialog();
  $('#footer-status').textContent = state.warnings[0] || '';
  renderDownloads();
  requestVisiblePrices();
  if (page === 'store' && !query.trim()) {
    requestHome();
    requestDlc();
    requestRecommendations();
  }
}
function showDetail(id, fromLibrary = false) {
  hideHover();
  hideLibraryHover();
  // A game of the library opens its library page from the library, its side panel, storage and downloads.
  if (
    (fromLibrary || ['library', 'favorites', 'recent', 'storage', 'downloads'].includes(page)) &&
    activeGames().some(g => g.id === id)
  ) {
    page = 'library';
    librarySelection = id;
    libraryProvider = null;
    render();
    requestAchievements(id);
    $('#main').scrollTop = 0;
    return;
  }
  // Any other game opens its store page, like the Steam store.
  if (!game(id)) return;
  openGamePage(id);
  $('#main').scrollTop = 0;
}
function pickProvider(id) {
  const g = game(id);
  const available = g?.offers || g?.storeOffers || [{ provider: 'steam' }, { provider: 'epic' }];
  return (
    available.find(o => o.provider === state.settings.preferred[id])?.provider ||
    available.find(o => o.provider === 'steam')?.provider ||
    available[0]?.provider ||
    'steam'
  );
}
function openGamePage(id) {
  if (detailId !== id) {
    gameShot = 0;
    gameAboutOpen = false;
    gameReqOs = 'windows';
  }
  detailId = id;
  selectedProvider = pickProvider(id);
  page = 'game';
  librarySelection = null;
  render();
  refreshDetailPrice();
  requestDeals(id);
  ensurePreview(id);
  loadStorePage(id);
}
// The store page of a game is open (it replaced the old pop-up window).
function detailOpen() {
  return page === 'game' && !!detailId && !!$('#store-game');
}
let gameShot = 0; // the item shown large in the media block (trailers first, then screenshots)
let gameAboutOpen = false; // «Читать дальше» under «Об этой игре»
let gameReqOs = 'windows'; // the tab of «Системные требования»
// The full Steam store page of a game (about, requirements, languages…).
const storePageState = new Map(); // game id → { loading, data, error }
async function loadStorePage(id) {
  const old = storePageState.get(id);
  if (!api?.gameStorePage || demo || old?.loading || (old && !old.error)) return;
  storePageState.set(id, { loading: true, data: null, error: '' });
  try {
    storePageState.set(id, { loading: false, data: await call('gameStorePage', { id }), error: '' });
  } catch (e) {
    storePageState.set(id, { loading: false, data: null, error: e.message });
  }
  if (detailId === id && detailOpen()) renderDetail();
}
// Trailers are HLS streams; they are listed only where this Chromium plays them.
let hlsSupport = null;
function playableMovie(m) {
  if (m.mp4 || m.webm) return m.mp4 || m.webm;
  hlsSupport ??= !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
  return hlsSupport ? m.hls : '';
}
// A game's page in the store, laid out like the Steam store page: the title,
// media with the capsule and summary beside them, the purchase blocks and
// «Об этой игре» on the left, details, features and languages on the right.
function storeGamePage() {
  const g = game(detailId);
  if (!g)
    return '<div id="store-game" class="empty"><h2>Игра не найдена</h2><button class="secondary" data-page="store">← В магазин</button></div>';
  const st = storePageState.get(g.id);
  const sp = st?.data || null;
  const appId = sp?.appId || String(g.steam || g.storeOffers?.find(o => o.provider === 'steam')?.appId || '');
  const c = {
    appId,
    steamUrl: /^\d+$/.test(appId) ? `https://store.steampowered.com/app/${appId}/` : '',
    epicUrl: sp?.url || g.storeOffers?.find(o => o.provider === 'epic')?.url || '',
    desc: sp?.short || gameDescription(g),
    release: sgRelease(g, sp),
  };
  const bg = safeImage(sp?.background);
  const crumbs = ['Все игры', sp?.genres?.[0], g.name].filter(Boolean).map(esc).join(' &gt; ');
  const hub = appId
    ? `<button class="sg-hub" data-open-link="https://steamcommunity.com/app/${esc(appId)}">Центр сообщества ↗</button>`
    : c.epicUrl
      ? `<button class="sg-hub" data-open-link="${esc(c.epicUrl)}">Страница в Epic Games Store ↗</button>`
      : '';
  return `<div id="store-game" class="store-game ${bg ? 'has-bg' : ''}" ${bg ? `style="--sg-bg:url('${esc(bg)}')"` : ''}><div class="sg-crumbs">${crumbs}</div><div class="sg-head"><h1>${esc(g.name)}</h1>${hub}</div><div class="sg-top">${sgMedia(g, sp)}${sgSide(g, sp, c)}</div>${sgQueue(g, c)}<div class="sg-columns">${sgLeft(g, sp, st, c)}${sgRight(g, sp, c)}</div></div>`;
}
// The release date: Steam's text, the date from the catalogue, or a store's text.
function sgRelease(g, sp) {
  if (sp?.release?.date) return sp.release.date;
  if (Number(g.released))
    return new Date(Number(g.released)).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  return priceOffers(g).find(o => typeof o.releaseDate === 'string' && o.releaseDate)?.releaseDate || '';
}
function sgFact(label, value) {
  return value ? `<dt>${label}:</dt><dd>${value}</dd>` : '';
}
function sgNames(list) {
  return (list || []).map(esc).join(', ');
}
function sgSection(title, body) {
  return `<section class="sg-section"><h2>${title}</h2>${body}</section>`;
}
function sgBox(body) {
  return `<div class="sg-box">${body}</div>`;
}
// Media: trailers, then screenshots; the chosen one big, the strip under it.
function sgMedia(g, sp) {
  const big = u => u.replace(/\.600x338\.jpg/, '.1920x1080.jpg');
  const shots = sp?.screenshots?.length
    ? sp.screenshots.map(s => ({ thumb: s.thumb || s.full, full: s.full || s.thumb }))
    : gameScreens(g, 12).map(u => ({ thumb: u, full: big(u) }));
  const items = [
    ...(sp?.movies || [])
      .map(m => ({ movie: true, thumb: m.thumb, src: playableMovie(m), name: m.name }))
      .filter(m => m.src),
    ...shots.map(s => ({ movie: false, thumb: safeImage(s.thumb), full: safeImage(s.full) })),
  ].filter(x => x.thumb);
  const cur = items[Math.min(gameShot, items.length - 1)];
  const main = !cur
    ? `<div class="sg-shot sg-shot-art">${artTag(g)}</div>`
    : cur.movie
      ? `<div class="sg-shot"><video src="${esc(cur.src)}" poster="${esc(cur.thumb)}" controls autoplay muted playsinline></video></div>`
      : `<div class="sg-shot"><img src="${esc(cur.full)}" data-fallback="${esc(cur.thumb)}" alt="" referrerpolicy="no-referrer"></div>`;
  const thumb = (x, i) =>
    `<button class="sg-thumb ${x.movie ? 'movie' : ''} ${x === cur ? 'active' : ''}" data-game-shot="${i}" aria-label="${x.movie ? 'Трейлер: ' + esc(x.name) : 'Скриншот ' + (i + 1)}"><img src="${esc(x.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`;
  const strip = items.length > 1 ? `<div class="sg-thumbs">${items.map(thumb).join('')}</div>` : '';
  return `<div class="sg-media">${main}${strip}</div>`;
}
// Beside the media: capsule, summary, reviews, release, developer, tags.
function sgSide(g, sp, c) {
  const capsule = safeImage(sp?.header) || safeImage(g.capsule);
  const tags = [...new Set([...(g.tags || []), ...priceOffers(g).flatMap(o => o.tags || [])])]
    .filter(t => t && t !== 'Моя библиотека')
    .slice(0, 12);
  const art = capsule
    ? `<img src="${esc(capsule)}" data-fallback="${esc(artwork(g))}" alt="" referrerpolicy="no-referrer">`
    : artTag(g);
  const release = esc(c.release) + (sp?.release?.soon ? ' <small>(скоро)</small>' : '');
  const tagList = tags.length
    ? `<p class="sg-tags-title">Популярные метки для этого продукта:</p><div class="sg-tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>`
    : '';
  return `<div class="sg-side"><div class="sg-capsule">${art}</div>${c.desc ? `<p class="sg-desc">${esc(c.desc)}</p>` : ''}<dl class="sg-facts">${sgFact('Обзоры', reviewLine(g))}${sgFact('Дата выхода', release)}</dl><dl class="sg-facts">${sgFact('Разработчик', sgNames(sp?.developers))}${sgFact('Издатель', sgNames(sp?.publishers))}</dl>${tagList}</div>`;
}
// The bar under the media: wishlist, favourites, price watch, the store link.
function sgQueue(g, c) {
  const owned = activeGames().find(x => x.id === g.id);
  const favorite = owned
    ? `<button class="sg-queue-btn" id="favorite">${has('favorites', g.id) ? '★ В избранном' : '☆ В избранное'}</button>`
    : '';
  const store = c.steamUrl
    ? `<button class="sg-queue-btn" data-open-link="${esc(c.steamUrl)}">Открыть в Steam ↗</button>`
    : c.epicUrl
      ? `<button class="sg-queue-btn" data-open-link="${esc(c.epicUrl)}">Открыть в Epic Games ↗</button>`
      : '';
  return `<div class="sg-queue"><button class="sg-queue-btn" id="detail-wish">${has('wishlist', g.id) ? '♥ В желаемом' : '♡ Добавить в желаемое'}</button>${favorite}<button class="sg-queue-btn" id="watch-price" ${demo || selectedProvider === 'custom' ? 'disabled' : ''}>♧ Следить за ценой · ${names[selectedProvider] || ''}</button><button class="sg-queue-btn" id="open-tracking">Мои отслеживания →</button><span class="sg-queue-gap"></span><button class="sg-queue-btn" id="refresh-detail-price" title="Обновить цену">↻</button>${store}</div>`;
}
// Left column: purchase, critics, about, requirements, legal.
function sgLeft(g, sp, st, c) {
  const requirements = sgRequirements(sp);
  return `<div class="sg-left">${demo ? '<div class="notice warning">Демонстрационная карточка. Внешние действия отключены.</div>' : ''}${ownershipBadge(g)}${detailPanel(g, sp)}${
    sp?.critics ? sgSection('Обзоры', `<div class="sg-rich sg-critics">${sp.critics}</div>`) : ''
  }${storeDlcSection(g)}${sgSection('Об этой игре', sgAbout(sp, st, c.desc))}${
    requirements ? sgSection('Системные требования', requirements) : ''
  }${sp?.legal ? `<p class="sg-legal">${esc(sp.legal)}</p>` : ''}</div>`;
}
// «Об этой игре»: Steam's text folded under «Читать дальше», or the short description.
function sgAbout(sp, st, desc) {
  const loading =
    st?.loading && !sp
      ? '<p class="hint">Загружаем страницу Steam…</p>'
      : st?.error
        ? `<p class="hint">${esc(st.error)}</p>`
        : '';
  if (sp?.about)
    return `<div class="sg-about ${gameAboutOpen ? 'open' : ''}"><div class="sg-rich">${sp.about}</div></div>${
      gameAboutOpen ? '' : '<button class="sg-more" data-sg-more>Читать дальше</button>'
    }`;
  return desc ? `<p class="sg-rich">${esc(desc)}</p>${loading}` : loading;
}
// System requirements with a tab per system.
function sgRequirements(sp) {
  const reqs = sp?.requirements || {};
  const osNames = { windows: 'Windows', mac: 'macOS', linux: 'SteamOS + Linux' };
  const os = reqs[gameReqOs] ? gameReqOs : Object.keys(reqs)[0];
  if (!os) return '';
  const tabs =
    Object.keys(reqs).length > 1
      ? `<div class="sg-os">${Object.keys(reqs)
          .map(
            k =>
              `<button class="${k === os ? 'active' : ''}" data-sg-os="${k}">${osNames[k] || esc(k)}</button>`
          )
          .join('')}</div>`
      : '';
  return `${tabs}<div class="sg-req"><div class="sg-rich">${reqs[os].minimum || ''}</div><div class="sg-rich">${reqs[os].recommended || ''}</div></div>`;
}
// Right column: details and links, Metacritic, features, languages, achievements.
function sgRight(g, sp, c) {
  return `<div class="sg-right">${sgDetails(g, sp, c)}${sgMetacritic(sp)}${sgFeatures(sp)}${sgLanguages(sp)}${sgAchievements(sp, c.appId)}</div>`;
}
function sgDetails(g, sp, c) {
  const links = [
    sp?.website && ['Посетить сайт', sp.website],
    c.steamUrl && ['Страница в Steam', c.steamUrl],
    c.epicUrl && ['Страница в Epic Games Store', c.epicUrl],
    c.appId && ['Центр сообщества', `https://steamcommunity.com/app/${c.appId}`],
    c.appId && ['Обсуждения', `https://steamcommunity.com/app/${c.appId}/discussions/`],
    sp?.metacritic?.url && ['Metacritic', sp.metacritic.url],
  ].filter(Boolean);
  const facts =
    sgFact('Название', esc(sp?.name || g.name)) +
    sgFact('Жанр', sgNames(sp?.genres)) +
    sgFact('Разработчик', sgNames(sp?.developers)) +
    sgFact('Издатель', sgNames(sp?.publishers)) +
    sgFact('Дата выхода', esc(c.release));
  const linkList = links.length
    ? `<div class="sg-links">${links.map(([n, u]) => `<button class="sg-link" data-open-link="${esc(u)}">${n} ↗</button>`).join('')}</div>`
    : '';
  return sgBox(`<dl class="sg-details">${facts}</dl>${linkList}`);
}
function sgMetacritic(sp) {
  if (!sp?.metacritic) return '';
  const score = sp.metacritic.score;
  return sgBox(
    `<div class="sg-meta"><b class="${score >= 75 ? 'good' : score >= 50 ? 'mixed' : 'bad'}">${score}</b><span>Metascore</span></div>`
  );
}
function sgFeatures(sp) {
  if (!sp?.features?.length) return '';
  return sgBox(
    `<ul class="sg-features">${sp.features.map(f => `<li data-feature="${f.id}">${esc(f.name)}</li>`).join('')}</ul>`
  );
}
function sgLanguages(sp) {
  if (!sp?.languages?.length) return '';
  const row = l =>
    `<tr><td>${esc(l.name)}</td><td>${l.ui === false ? '' : '✔'}</td><td>${l.audio ? '✔' : ''}</td></tr>`;
  return sgBox(
    `<h3>Языки:</h3><table class="sg-langs"><thead><tr><th></th><th>Интерфейс</th><th>Озвучка</th></tr></thead><tbody>${sp.languages.map(row).join('')}</tbody></table>`
  );
}
function sgAchievements(sp, appId) {
  const a = sp?.achievements;
  if (!a?.total) return '';
  const icons = a.list
    .slice(0, 4)
    .map(
      x =>
        `<img src="${esc(x.icon)}" alt="" title="${esc(x.name)}" loading="lazy" referrerpolicy="no-referrer">`
    )
    .join('');
  const all =
    a.total > 4 && appId
      ? `<button class="sg-ach-all" data-open-link="https://steamcommunity.com/stats/${esc(appId)}/achievements/">Показать все (${a.total})</button>`
      : '';
  return sgBox(
    `<h3>Достижения в Steam <small>${a.total}</small></h3><div class="sg-ach">${icons}${all}</div>`
  );
}
// Prices in other shops and the historical low (IsThereAnyDeal, optional).
const dealsState = new Map();
function dealsBlock(id) {
  if (!state.integrations?.itad?.enabled)
    return demo
      ? ''
      : '<p class="hint deals-hint">Исторический минимум цены в Steam и Epic появится после добавления ключа IsThereAnyDeal в «Аккаунтах».</p>';
  const d = dealsState.get(id + ':' + (state.settings.storeCountry || 'US'));
  if (!d || d.loading)
    return '<div class="deals"><h3>История цен Steam и Epic</h3><p class="hint">Загружаем цены IsThereAnyDeal…</p></div>';
  if (d.error)
    return `<div class="deals"><h3>История цен Steam и Epic</h3><p class="watch-error">${esc(d.error)}</p></div>`;
  if (!d.found)
    return '<div class="deals"><h3>История цен Steam и Epic</h3><p class="hint">IsThereAnyDeal не знает эту игру.</p></div>';
  return `<div class="deals"><h3>История цен Steam и Epic</h3>${d.historyLow ? `<p class="history-low">Исторический минимум: <b>${esc(money(d.historyLow))}</b></p>` : ''}<ul>${d.deals
    .slice(0, 6)
    .map(
      x =>
        `<li><span>${esc(x.shop)}</span><b>${esc(money(x.price))}</b>${x.cut ? `<em>−${x.cut}%</em>` : ''}${x.storeLow ? `<small>минимум ${esc(money(x.storeLow))}</small>` : ''}</li>`
    )
    .join('')}</ul><p class="hint">Данные IsThereAnyDeal; учитываются только Steam и Epic Games.</p></div>`;
}
async function requestDeals(id) {
  if (!api?.gameDeals || demo || !state.integrations?.itad?.enabled) return;
  const key = id + ':' + (state.settings.storeCountry || 'US'),
    old = dealsState.get(key);
  if (old && (old.loading || Date.now() - (old.checkedAt || 0) < 600000)) return;
  dealsState.set(key, { loading: true });
  try {
    dealsState.set(key, { ...(await call('gameDeals', { id })), checkedAt: Date.now() });
  } catch (e) {
    dealsState.set(key, { error: e.message, checkedAt: Date.now() });
  }
  if (detailId === id && detailOpen()) renderDetail();
}
function renderDetail() {
  const el = $('#store-game');
  if (page !== 'game' || !el) return;
  el.outerHTML = storeGamePage();
}
// The purchase blocks of a game's store page, one per store, as on Steam:
// «Купить …» with the price and a green button, or «Играть» for a game you own.
function detailPanel(g, sp = null) {
  const owned = activeGames().find(x => x.id === g.id);
  const providers = [
    ...new Set([
      ...(g.storeOffers || []).map(x => x.provider),
      ...(owned?.offers || []).map(x => x.provider),
    ]),
  ];
  if (!providers.length) providers.push('steam', 'epic');
  const blocks = providers.map(p => purchaseBlock(g, p, owned, sp)).join('');
  return `<div id="detail-content" class="sg-buy">${blocks}${bestBadge(g)}<p class="hint">Оплата и выбор издания происходят в официальном магазине. Перед покупкой проверь аккаунт, регион и состав издания.</p>${dealsBlock(g.id)}</div>`;
}
// One store's block: play or install a game you have, buy one you do not.
function purchaseBlock(g, p, owned, sp) {
  const offer = owned?.offers.find(x => x.provider === p),
    sale = g.storeOffers?.find(x => x.provider === p),
    mine = ownsOffer(sale || offer) || offer?.owned === true;
  const head = `${sgPlatforms(p, sp)}<small class="sg-store">${names[p] || esc(p)}${p === 'steam' ? ' · в приоритете' : ''}${mine ? ' · ✓ уже есть на аккаунте' : ''}</small>`;
  if (offer) {
    const label = offer.installed
      ? '▶ Играть'
      : p === 'epic' && (state.settings.nexusDownloads === false || !offer.namespace)
        ? 'Открыть в Epic'
        : '↓ Установить';
    const action = isRunning(g.id)
      ? '<button class="sg-cart stop" data-sg-act="detail-stop" title="Закрыть игру; сохранения уйдут в облако">■ Закрыть</button>'
      : `<button class="sg-cart" data-sg-act="play" data-sg-provider="${esc(p)}" ${demo ? 'disabled' : ''}>${label}</button>`;
    const where = offer.installed ? 'Установлена' : mine ? 'В библиотеке' : 'Найдена на диске';
    return `<div class="sg-purchase"><h2>${offer.installed ? 'Играть в' : 'Установить'} ${esc(g.name)}</h2>${head}<div class="sg-action"><div class="sg-price">${where}</div>${action}</div></div>`;
  }
  if (p === 'custom') return '';
  const canBuy = !demo && !mine && !!sale?.url;
  const title = sale?.name && sale.name !== g.name ? sale.name : g.name;
  return `<div class="sg-purchase"><h2>Купить ${esc(title)}</h2>${head}<div class="sg-action"><div class="sg-price">${salePrice(sale)}</div><button class="sg-cart" data-buy="${esc(p)}" ${canBuy ? '' : 'disabled'}>${mine ? 'В библиотеке' : 'Купить в ' + (names[p] || p) + ' ↗'}</button></div>${accountSelect(p, 'buy-account-' + p)}</div>`;
}
// The system icons of a purchase block (Steam says which; Epic sells for Windows here).
function sgPlatforms(p, sp) {
  const pl = p === 'steam' && sp?.platforms ? sp.platforms : { windows: true };
  return `<span class="sg-platforms">${pl.windows ? '<i class="win" title="Windows"></i>' : ''}${pl.mac ? '<i class="mac" title="macOS"></i>' : ''}${pl.linux ? '<i class="linux" title="SteamOS + Linux"></i>' : ''}</span>`;
}
// Back / forward like the Steam client: every page and opened game is a step.
const viewHistory = [];
let viewIndex = -1,
  restoringView = false;
function rememberView() {
  const view = { page, game: page === 'library' ? librarySelection : page === 'game' ? detailId : null };
  const current = viewHistory[viewIndex];
  if (!restoringView && !(current && current.page === view.page && current.game === view.game)) {
    viewHistory.splice(viewIndex + 1);
    viewHistory.push(view);
    if (viewHistory.length > 50) viewHistory.shift();
    viewIndex = viewHistory.length - 1;
  }
  restoringView = false;
  $('#nav-back').disabled = viewIndex <= 0;
  $('#nav-forward').disabled = viewIndex >= viewHistory.length - 1;
}
function goHistory(step) {
  const view = viewHistory[viewIndex + step];
  if (!view) return;
  viewIndex += step;
  restoringView = true;
  hideHover();
  hideLibraryHover();
  page = view.page;
  librarySelection =
    view.page === 'library' && view.game && activeGames().some(g => g.id === view.game) ? view.game : null;
  if (view.page === 'game') {
    if (!game(view.game)) page = 'store';
    else return (openGamePage(view.game), ($('#main').scrollTop = 0));
  }
  render();
  $('#main').scrollTop = 0;
}
// Bottom bar like the Steam client: "ЗАГРУЗКИ" with the running downloads.
function renderDownloads() {
  recordSpeed();
  const el = $('#footer-downloads'),
    bar = $('#footer-downloads-bar');
  if (!el) return;
  const list = Object.entries(state.progress || {});
  if (bar) bar.style.width = '0';
  if (!list.length) {
    el.textContent = 'Нет активных загрузок';
    return;
  }
  const [id, p] = list[0];
  const name = game(id)?.name || 'Игра';
  el.textContent = (list.length > 1 ? `${list.length} загрузки · ` : '') + `${name} · ${progressText(p)}`;
  if (bar && Number.isFinite(p.percent)) bar.style.width = p.percent + '%';
  // The downloads page follows the progress without a full render.
  if (page === 'downloads' && $('.download-list') && $('.download-list').children.length === list.length) {
    const html = downloadsPage();
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    $('.download-list').replaceWith(tmp.querySelector('.download-list'));
    const graph = tmp.querySelector('.speed-graph');
    if (graph && $('.speed-graph')) $('.speed-graph').replaceWith(graph);
    else if (graph) $('.download-list').before(graph);
  }
}
async function setPage(p) {
  hideHover();
  hideLibraryHover();
  clearTimeout(searchTimer);
  searchSequence++;
  searchState = { items: [], providers: {}, loading: false, query: '', start: 0 };
  page = p;
  librarySelection = null;
  filter = 'all';
  libraryLimit = LIBRARY_PAGE;
  query = '';
  $('#search').value = '';
  render();
  $('#main').scrollTop = 0;
}
async function buy(p) {
  if (demo) throw Error('В демонстрационном режиме покупка отключена');
  const account = ($('#buy-account-' + p) || $('#buy-account'))?.value || undefined;
  const r = await call('buy', { id: detailId, provider: p, account });
  if (r?.opened)
    toast(
      `Открыт официальный магазин${r.account ? ' · аккаунт ' + r.account : ''}. Проверь издание перед оплатой.`
    );
}
// A top-menu drop-down closes once a page is picked, even with the mouse still over it.
document.addEventListener('click', event => {
  const group = event.target.closest('.nav-group');
  if (!group || !event.target.closest('[data-page],[data-open-link]')) return;
  group.classList.add('closed');
  document.activeElement?.blur?.();
});
document.addEventListener('mouseout', event => {
  const group = event.target.closest?.('.nav-group.closed');
  if (group && !group.contains(event.relatedTarget)) group.classList.remove('closed');
});
