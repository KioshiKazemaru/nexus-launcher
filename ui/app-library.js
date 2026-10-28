// Nexus window, part 3 of 5: Library, game pages, downloads, storage, install window, settings, details.
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
          : `<button class="secondary" data-client-downloads="${esc(p.provider)}" title="Пауза, отмена и очередь — в клиенте ${esc(names[p.provider] || '')}">Открыть в ${esc(p.provider === 'epic' ? 'Epic' : 'Steam')}</button>`
      }</div>${p.error ? `<p class="download-error">${esc(p.error)}</p>` : ''}</article>`;
    })
    .join('');
  return `${notice()}<div class="section-head"><h1>Загрузки</h1><span>${list.length ? `${list.length} ${plural(list.length, 'активная', 'активные', 'активных')}` : ''}</span></div><p class="subheading">Игры Epic Nexus скачивает сам — их можно поставить на паузу и продолжить даже после перезапуска. Загрузки Steam выполняет Steam в фоне; их пауза и отмена — в клиенте.</p>${
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
  if (page === 'storage') render();
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
    `<button class="secondary" id="library-uninstall" data-uninstall="${esc(o.provider)}" title="Удалить файлы игры с компьютера" ${state.progress?.[librarySelection]?.state === 'uninstalling' ? 'disabled' : ''}>Удалить</button>`
  );
}
// For a manually added game started through a launcher: which process is the game.
function trackProcessBox(g) {
  const o = g.offers.find(x => x.provider === 'custom');
  if (!o || demo) return '';
  return `<h2>ВРЕМЯ В ИГРЕ</h2><form id="track-process-form" class="inline-form"><input id="track-process" maxlength="104" placeholder="game.exe" value="${esc(o.trackProcess || '')}"><button class="secondary" type="submit">Сохранить</button></form><p class="hint">Если .exe — это лаунчер, укажите имя процесса самой игры (из диспетчера задач). Пусто — время считается до закрытия запущенного файла.</p>`;
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
function libraryGamePage() {
  const g = game(librarySelection),
    owned = activeGames().find(x => x.id === librarySelection);
  if (!g || !owned) return library();
  const offers = owned.offers || [],
    preferred = selectedLibraryOffer(owned);
  const p = preferred?.provider || 'steam',
    last = state.settings.recent?.find(r => r.id === g.id)?.time,
    played = lastPlayedAt(owned),
    playtimeRows = offers
      .filter(o => Number(o.playtime) > 0)
      .map(o => `<p>${names[o.provider]}: ${hours(o.playtime)}</p>`)
      .join('');
  const merged =
    offers.filter(o => o.provider !== 'custom').length > 1
      ? `<div class="merged-note">Объединено: ${offers.map(o => names[o.provider]).join(' + ')}${owned.mergedBy === 'title' ? ' · по названию' : owned.mergedBy === 'external' ? ' · по базе игр' : owned.mergedBy === 'manual' ? ' · вручную' : ''} ${demo ? '' : `<button class="ghost" data-split="${esc(owned.id)}">Разделить</button>`}</div>`
      : '';
  const status = isRunning(g.id)
    ? 'В игре с ' +
      new Date(state.running[g.id].since).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : preferred?.installed
      ? preferred.provider === 'epic' && preferred.executable && state.settings.epicDirectLaunch !== false
        ? 'Готова · без Epic Launcher'
        : preferred.provider === 'steam' && state.settings.steamSilent !== false
          ? 'Готова · Steam в фоне'
          : 'Готова к запуску'
      : preferred?.owned
        ? 'В аккаунте · не установлена'
        : 'Найдена на компьютере';
  const action = preferred?.installed
    ? '▶ ИГРАТЬ'
    : p === 'epic'
      ? state.progress?.[g.id]?.nexus
        ? '▶ ПРОДОЛЖИТЬ ЗАГРУЗКУ'
        : preferred?.namespace && preferred?.itemId
          ? state.settings.nexusDownloads !== false
            ? '↓ УСТАНОВИТЬ'
            : '↓ УСТАНОВИТЬ В EPIC'
          : 'ОТКРЫТЬ В EPIC'
      : '↓ УСТАНОВИТЬ';
  const hero = artwork(g),
    steamHero = g.steam
      ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.steam}/library_hero.jpg`
      : '';
  return `<div class="library-game-page" data-price-game="${esc(g.id)}"><div class="library-game-hero">${hero ? `<img src="${esc(steamHero || hero)}" data-fallback="${esc(hero)}" alt="Баннер ${esc(g.name)}" referrerpolicy="no-referrer">` : ''}<div class="library-game-hero-shade"></div><h1>${esc(g.name)}</h1></div><div class="library-game-actions">${isRunning(g.id) ? `<button class="play-main stop" id="library-stop" title="Закрыть игру; сохранения уйдут в облако">■ ЗАКРЫТЬ</button>` : `<button class="play-main" id="library-play" ${demo ? 'disabled' : ''}>${action}</button>`}<div class="library-game-launch"><div><small>СТАТУС</small><strong>${esc(status)}</strong></div><div><small>ПОСЛЕДНИЙ ЗАПУСК</small><strong>${played ? new Date(played).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Пока не запускалась'}</strong></div><div><small>ВЫ ИГРАЛИ</small><strong>${owned.playtime ? hours(owned.playtime) : '—'}</strong></div></div>${progressLine(owned)}<div class="library-game-right">${clientButtons(preferred)}<button class="secondary" id="library-hide" title="${owned.hidden ? 'Показать в библиотеке' : 'Скрыть из библиотеки'}">${owned.hidden ? '👁 Показать' : 'Скрыть'}</button><button class="secondary" id="library-favorite" aria-label="Избранное">${has('favorites', g.id) ? '★' : '☆'}</button><button class="secondary" id="library-wish" aria-label="Желаемое">${has('wishlist', g.id) ? '♥' : '♡'}</button></div></div><div class="library-game-links"><button data-library-back>← Все игры</button><button id="library-store">Страница в магазине</button><button data-page="tracking">Отслеживание скидок</button></div><div class="library-game-columns"><section><h2>ОБ ИГРЕ</h2><p>${esc(g.desc || g.storeOffers?.find(o => o.description)?.description || 'Описание пока не получено от магазина.')}</p><div class="preview-tags">${(g.tags || []).map(t => `<span>${esc(t)}</span>`).join('')}</div>${collectionsBox(owned)}${trackProcessBox(owned)}<h2>ПЛАТФОРМЫ</h2><div class="library-game-providers">${offers.map(o => `<button data-library-provider="${esc(o.provider)}" class="${p === o.provider ? 'active' : ''}"><strong>${names[o.provider]}</strong><span>${o.installed ? 'Установлена' : o.owned ? 'Имеется в аккаунте' : 'На диске'}${o.accountIds?.length > 1 ? ' · на ' + o.accountIds.length + ' аккаунтах' : ''}</span>${o.provider === 'custom' ? '' : `<span class="library-game-provider-price">${salePrice(g.storeOffers?.find(s => s.provider === o.provider))}</span>`}</button>`).join('')}</div></section><aside class="library-game-activity"><h2>АКТИВНОСТЬ</h2><div class="library-activity-box"><strong>${played ? 'Последний запуск' : 'Данных о запусках пока нет'}</strong><p>${played ? new Date(played).toLocaleString('ru-RU') : 'Дата появится после запуска через Nexus или из данных платформы.'}${last && last !== played ? '<br>Через Nexus: ' + new Date(last).toLocaleString('ru-RU') : ''}</p>${playtimeRows ? '<strong>Время в игре</strong>' + playtimeRows : ''}</div>${merged}${achievementsBox(owned)}${dlcBox(owned)}<h2>СКРИНШОТЫ</h2><div class="library-gallery">${(g.storeOffers?.find(o => o.screenshots?.length)?.screenshots || []).map(src => `<img src="${esc(safeImage(src))}" alt="Скриншот ${esc(g.name)}" referrerpolicy="no-referrer" loading="lazy">`).join('') || `<div class="library-activity-box">${artTag(g)}</div>`}</div></aside></div></div>`;
}
function renderCollections() {
  const el = $('#collection-list');
  if (!el) return;
  const list = state.settings.collections || [];
  el.innerHTML = list.length
    ? `<div class="collection-title">Коллекции</div>${list
        .map(
          c =>
            `<button class="collection-link ${collectionFilter === c.id ? 'active' : ''}" data-collection="${esc(c.id)}">${esc(c.name)} <span>${c.games.length}</span></button>`
        )
        .join('')}`
    : '';
}
function renderLibraryTree() {
  renderCollections();
  const el = $('#library-tree');
  if (!el) return;
  const all = filteredLibrary();
  el.innerHTML =
    all
      .slice(0, 400)
      .map(
        g =>
          `<button class="tree-game ${librarySelection === g.id ? 'active' : ''}" data-detail="${esc(g.id)}">${artTag(g)}<span>${esc(g.name)}</span><small>${[...new Set(g.offers.map(o => (o.provider === 'epic' ? 'E' : o.provider === 'steam' ? 'S' : '•')))].join('')}</small></button>`
      )
      .join('') +
      (all.length > 400 ? `<p class="tree-empty">и ещё ${all.length - 400} — используйте поиск</p>` : '') ||
    '<p class="tree-empty">Нет игр в выбранном списке</p>';
}
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
    }${o.thirdParty ? '<p class="notice warning">Эта игра работает через лаунчер издателя (EA, Ubisoft и т. п.): для игры понадобится он.</p>' : ''}${enough ? '' : '<p class="watch-error">На этом диске может не хватить места.</p>'}<div class="install-buttons"><button class="primary" data-install-start ${x.busy ? 'disabled' : ''}>↓ Установить</button><button class="secondary" data-install-client>Через Epic Games Launcher</button><button class="secondary" data-install-cancel>Отмена</button></div><p class="hint install-import">Игра уже есть на диске (после переустановки Windows или с другого ПК)? <button class="link" data-install-import>Указать её папку…</button></p>`;
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
  const check = (name, label, hint) =>
    `<label class="check"><input type="checkbox" data-launch-setting="${name}" ${s[name] !== false ? 'checked' : ''} ${demo ? 'disabled' : ''}> ${label}</label>${hint ? `<p class="hint">${hint}</p>` : ''}`;
  return `<section class="settings-card launch-card"><h3>Запуск игр</h3><p>Nexus запускает и устанавливает игры сам, не открывая окна сторонних лаунчеров.</p>${check(
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
  return `<section class="settings-card downloads-card"><h3>Загрузки</h3><p>Для игр, которые скачивает Nexus (Epic Games). Загрузками Steam управляет сам Steam.</p><label class="field">Ограничение скорости, МБ/с <input type="number" id="download-limit" min="0" max="10000" step="0.5" value="${mb}" ${off}><small>0 — без ограничений</small></label><label class="check"><input type="checkbox" id="schedule-enabled" ${sch.enabled ? 'checked' : ''} ${off}> Скачивать только в эти часы</label><div class="time-range"><input type="time" id="schedule-from" value="${esc(sch.from)}" ${off}> — <input type="time" id="schedule-to" value="${esc(sch.to)}" ${off}></div><p class="hint">Вне этих часов загрузки ждут; кнопка «Загрузить сейчас» запускает игру без ожидания.</p><label class="check"><input type="checkbox" id="epic-auto-update" ${s.epicAutoUpdate !== false ? 'checked' : ''} ${off}> Обновлять игры Epic автоматически</label><label class="check"><input type="checkbox" id="download-notify" ${s.downloadNotify !== false ? 'checked' : ''} ${off}> Уведомлять, когда игра скачалась или обновилась</label><button class="secondary" id="check-game-updates" ${off}>Проверить обновления игр</button></section>`;
}
function updatesCard() {
  const u = state.updater || {};
  const text =
    {
      checking: 'Проверяем обновления…',
      downloading: `Загружаем версию ${esc(u.version || '')}${u.percent ? ' · ' + u.percent + '%' : ''}`,
      ready: `Версия ${esc(u.version || '')} загружена`,
      current: 'Установлена последняя версия',
      error: 'Ошибка обновления: ' + esc(u.error || ''),
      unsupported: 'Автообновление работает в установленной версии (установщик Nexus Setup).',
    }[u.status] || 'Проверка выполняется при запуске и каждые 6 часов.';
  return `<section class="settings-card"><div class="settings-row"><div><h3>Обновления · Nexus ${esc(state.version || '')}</h3><p>${text}</p></div><div class="account-actions">${u.status === 'ready' ? '<button class="primary" id="install-update">Перезапустить и обновить</button>' : '<button class="secondary" id="check-update">Проверить</button>'}</div></div><label class="check"><input type="checkbox" id="auto-update" ${state.settings.autoUpdate !== false ? 'checked' : ''}> Загружать обновления автоматически</label></section>`;
}
function accounts() {
  const integrations = state.integrations || {};
  const steamConnected = (state.accountList || []).some(
    a => a.provider === 'steam' && a.status === 'connected'
  );
  const epicConnected = (state.accountList || []).some(
    a => a.provider === 'epic' && a.status === 'connected'
  );
  return `${notice()}<div class="section-head"><h1>Твои аккаунты</h1><button class="secondary" id="refresh-accounts">↻ Проверить вход</button></div><p class="subheading">Несколько аккаунтов Steam и Epic Games в одной библиотеке.</p>${state.storageWarning ? `<div class="notice warning">${esc(state.storageWarning)}</div>` : ''}<div class="account-grid">
<section class="account-card"><div class="account-head"><span class="account-symbol">S</span><div><h2>Steam</h2><p>${esc(accountStatusText(state.accounts.steam))}</p></div></div>${accountRows('steam')}<p>Вход на официальной странице Steam (Steam Guard работает как обычно). Игры аккаунта, время в игре и даты запуска загружаются автоматически.</p><label class="check"><input type="checkbox" data-remember="steam" ${state.settings.remember.steam ? 'checked' : ''}> Запомнить вход и восстанавливать автоматически</label><div class="account-actions">${steamConnected ? '<button class="secondary" data-login-add="steam">＋ Добавить аккаунт Steam</button>' : '<button class="primary" data-login="steam">Войти в Steam</button>'}<button class="ghost" data-browser="steam">Открыть в браузере ↗</button></div></section>
<section class="account-card"><div class="account-head"><span class="account-symbol">E</span><div><h2>Epic Games</h2><p>${esc(accountStatusText(state.accounts.epic))}</p></div></div>${accountRows('epic')}<p>Вход через официальную страницу Epic. После входа Nexus получает токен библиотеки (как Legendary и Heroic); пароль не сохраняется.</p><label class="check"><input type="checkbox" data-remember="epic" ${state.settings.remember.epic ? 'checked' : ''}> Запомнить вход (токен обновления шифруется Windows)</label><div class="account-actions">${epicConnected ? '<button class="secondary" data-login-add="epic">＋ Добавить аккаунт Epic</button>' : '<button class="primary" data-login="epic">Войти в Epic Games</button>'}<button class="ghost" data-browser="epic">Войти через браузер ↗</button></div><form id="epic-code-form" class="form-row compact"><label class="field">КОД ИЗ БРАУЗЕРА<input id="epic-code" autocomplete="off" placeholder="authorizationCode или весь JSON со страницы"></label><button class="secondary" type="submit">Подключить</button></form><div class="hint">Если вход Google/Apple не открывается во встроенном окне: нажмите «Войти через браузер», войдите, скопируйте значение <code>authorizationCode</code> со страницы и вставьте сюда. Код действует несколько минут.</div></section></div>
<section class="settings-card"><h3>Списки желаемого и раздачи</h3><p>Перенести списки желаемого подключённых аккаунтов Steam и Epic в «Желаемое» Nexus. Повторный импорт добавляет только новые игры.</p><div class="account-actions"><button class="secondary" id="import-wishlists" ${steamConnected || epicConnected ? '' : 'disabled'}>Импортировать желаемое</button></div><label class="check"><input type="checkbox" id="notify-giveaways" ${state.settings.notifyGiveaways !== false ? 'checked' : ''}> Уведомлять о новых бесплатных играх Epic</label></section>
<section class="settings-card"><h3>Коллекции Steam</h3><p>Перенести коллекции, скрытые и избранные игры из клиента Steam (для подключённых аккаунтов). Динамические коллекции Steam — это правила фильтрации, они не переносятся.</p><div class="account-actions"><button class="secondary" id="import-collections" ${steamConnected ? '' : 'disabled'}>Импортировать коллекции Steam</button></div></section>
<section class="settings-card"><h3>Резервная копия и диагностика</h3><p>Копия содержит списки, коллекции, склейки, отслеживания цен и сохранённые библиотеки. Входы, токены и ключи в неё не попадают. Диагностика — отчёт для поиска проблем; токены и ключи в нём скрыты.</p><div class="account-actions"><button class="secondary" id="export-backup">Сохранить копию</button><button class="secondary" id="import-backup">Восстановить из копии</button><button class="secondary" id="save-diagnostics">Сохранить диагностику</button><button class="ghost" id="open-logs">Открыть папку журналов</button></div></section>
<section class="settings-card"><h3>Внешние сервисы · необязательно</h3><p>Бесплатные личные ключи включают дополнительные функции. Ключи шифруются Windows и не попадают в интерфейс.</p>${integrations.encryption === false ? '<div class="notice warning">Защищённое хранилище недоступно, ключи сохранить нельзя.</div>' : ''}
${keyField('itad', 'ISTHEREANYDEAL API KEY · цены в других магазинах, исторический минимум, склейка игр', 'isthereanydeal.com → Apps → API key', integrations.itad?.enabled, integrations.itad?.error)}
${keyField('igdbId', 'IGDB · TWITCH CLIENT ID · описания, жанры, обложки, склейка игр', 'dev.twitch.tv → Applications', integrations.igdb?.enabled, integrations.igdb?.error)}
${keyField('igdbSecret', 'IGDB · TWITCH CLIENT SECRET', 'секрет того же приложения Twitch', integrations.igdb?.enabled, '')}
${keyField('sgdb', 'STEAMGRIDDB API KEY · вертикальные обложки для Epic и сторонних игр', 'steamgriddb.com → Preferences → API', integrations.sgdb?.enabled, integrations.sgdb?.error)}</section>
<section class="settings-card"><h3>Облачная библиотека Steam · импорт по Web API key</h3><p>Запасной вариант, если автоматическая синхронизация недоступна. Работает только для подключённого аккаунта.</p><form id="steam-form" class="form-row"><label class="field">STEAMID64<input id="steam-id" inputmode="numeric" maxlength="17" autocomplete="off" placeholder="7656119…" value="${esc(state.accounts.steam?.steamId || '')}"></label><label class="field">ЛИЧНЫЙ WEB API KEY<input id="api-key" type="password" autocomplete="off" placeholder="${integrations.steamWebApi?.enabled ? 'Сохранён' : '32 символа'}"></label><button class="primary" type="submit">Импортировать</button></form></section>
<section class="settings-card"><div class="settings-row"><div><h3>Библиотеки на диске</h3><p>${esc(state.settings.steamRoot || 'Steam определяется автоматически, Epic — по манифестам и LauncherInstalled.dat.')}</p></div><button class="secondary" id="steam-root">Указать папку Steam</button></div><label class="check"><input type="checkbox" id="auto-start" ${state.settings.autoStart ? 'checked' : ''}> Запускать Nexus при входе в Windows</label></section>
${launchCard()}${downloadsCard()}${updatesCard()}
<section class="settings-card"><h3>Nexus</h3><p>Независимый лаунчер для Windows 10/11 x64, не связан с Valve и Epic Games. Покупку подтверждаешь на официальном сайте.</p><button class="secondary" id="demo">Посмотреть демонстрационную библиотеку</button></section>`;
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
  if (detailId && ids.has(detailId) && $('#details').open) renderDetail();
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
  document.body.classList.toggle('native-window', state.native === true && state.platform === 'win32');
  renderProfiles();
  renderLibraryTree();
  $('#lib-count').textContent = libraryGames().length;
  $('#wish-count').textContent = state.settings.wishlist.length;
  document
    .querySelectorAll('[data-page]')
    .forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('#breadcrumb').innerHTML =
    page === 'library' && librarySelection
      ? 'БИБЛИОТЕКА <span>/ ' + esc(game(librarySelection)?.name || 'ИГРА') + '</span>'
      : {
          store: 'МАГАЗИН <span>/ ОБЗОР</span>',
          library: 'БИБЛИОТЕКА <span>/ ВСЕ ИГРЫ</span>',
          wishlist: 'КОЛЛЕКЦИЯ <span>/ ЖЕЛАЕМОЕ</span>',
          favorites: 'КОЛЛЕКЦИЯ <span>/ ИЗБРАННОЕ</span>',
          recent: 'БИБЛИОТЕКА <span>/ НЕДАВНИЕ</span>',
          downloads: 'БИБЛИОТЕКА <span>/ ЗАГРУЗКИ</span>',
          storage: 'БИБЛИОТЕКА <span>/ ХРАНИЛИЩЕ</span>',
          tracking: 'МАГАЗИН <span>/ СКИДКИ</span>',
          accounts: 'NEXUS <span>/ НАСТРОЙКИ</span>',
        }[page];
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
      : page === 'downloads'
        ? downloadsPage()
        : page === 'storage'
          ? storagePage()
          : page === 'accounts'
            ? accounts() + epicImportPanel()
            : page === 'tracking'
              ? tracking()
              : librarySelection && page === 'library'
                ? libraryGamePage()
                : library();
  $('#footer-status').textContent =
    state.warnings[0] || 'Steam в приоритете · покупка в официальном магазине';
  renderDownloads();
  requestVisiblePrices();
  if (page === 'store' && !query.trim()) {
    requestHome();
    requestDlc();
    requestRecommendations();
  }
}
function showDetail(id) {
  hideHover();
  hideLibraryHover();
  if (['library', 'favorites', 'recent'].includes(page) && activeGames().some(g => g.id === id)) {
    page = 'library';
    librarySelection = id;
    libraryProvider = null;
    render();
    requestAchievements(id);
    $('#main').scrollTop = 0;
    return;
  }
  detailId = id;
  const g = game(id);
  if (!g) return;
  const available = g.offers || g.storeOffers || [{ provider: 'steam' }, { provider: 'epic' }];
  selectedProvider =
    available.find(o => o.provider === state.settings.preferred[id])?.provider ||
    available.find(o => o.provider === 'steam')?.provider ||
    available[0]?.provider ||
    'steam';
  renderDetail();
  $('#details').showModal();
  refreshDetailPrice();
  requestDeals(id);
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
  if (detailId === id && $('#details').open) renderDetail();
}
function renderDetail() {
  const g = game(detailId);
  if (!g) return;
  const owned = activeGames().find(x => x.id === g.id);
  const o = owned?.offers.find(x => x.provider === selectedProvider);
  const providers = [
    ...new Set([
      ...(g.storeOffers || []).map(x => x.provider),
      ...(owned?.offers || []).map(x => x.provider),
    ]),
  ];
  if (!providers.length) providers.push('steam', 'epic');
  $('#detail-content').innerHTML =
    `<div class="detail-art">${artTag(g)}<h1>${esc(g.name)}</h1></div><div class="detail-body"><div class="detail-price-header"><div><small>Цена · ${names[selectedProvider]} · ${esc(state.settings.storeCountry || 'US')}</small><div class="detail-price-value">${selectedProvider === 'custom' ? 'Добавлена вручную' : salePrice(g.storeOffers?.find(x => x.provider === selectedProvider))}</div></div><button class="secondary" id="refresh-detail-price">↻ Обновить цену</button></div>${bestBadge(g)}<p>${esc(g.desc || 'Игра из твоей коллекции. Выбери платформу для запуска.')}</p>${demo ? '<div class="notice warning">Демонстрационная карточка. Внешние действия отключены.</div>' : ''}${ownershipBadge(g)}${providers
      .map(p => {
        const offer = owned?.offers.find(x => x.provider === p),
          sale = g.storeOffers?.find(x => x.provider === p),
          has = ownsOffer(sale || offer);
        return `<label class="offer ${p === selectedProvider ? 'chosen' : ''}"><input type="radio" name="provider" value="${p}" ${p === selectedProvider ? 'checked' : ''}><span class="offer-label"><strong>${names[p]} ${p === 'steam' ? '<span class="pill blue">В приоритете</span>' : ''}</strong><small>${has || offer?.owned ? '✓ Уже есть на аккаунте' + (offer && !offer.installed ? ' · не установлена' : '') : offer ? (offer.installed ? 'Установлена · право на игру не подтверждено' : 'Найдена на диске') : 'Регион ' + esc(state.settings.storeCountry || 'US')}</small><span class="offer-price">${p === 'custom' ? '' : salePrice(sale)}</span></span></label>`;
      })
      .join('')}
 ${dealsBlock(g.id)}
 <div class="detail-buttons"><button class="secondary" id="watch-price" ${demo || selectedProvider === 'custom' ? 'disabled' : ''}>♧ Следить за ценой · ${names[selectedProvider]}</button><button class="ghost" id="open-tracking">Мои отслеживания →</button></div>
 ${o ? `<div class="detail-buttons">${isRunning(g.id) ? '<button class="primary stop" id="detail-stop" title="Закрыть игру; сохранения уйдут в облако">■ Закрыть</button>' : `<button class="primary" id="play" ${demo ? 'disabled' : ''}>${o.installed ? '▶ Играть' : selectedProvider === 'epic' && (state.settings.nexusDownloads === false || !o.namespace) ? 'Открыть в Epic' : '↓ Установить'}</button>`}<button class="secondary" id="favorite">${has('favorites', g.id) ? '★ В избранном' : '☆ В избранное'}</button><button class="secondary" id="detail-wish">${has('wishlist', g.id) ? '♥ В желаемом' : '♡ В желаемое'}</button></div>` : `<div class="detail-buttons"><button class="primary" id="buy-selected" ${demo || ownsOffer(g.storeOffers?.find(x => x.provider === selectedProvider)) || !g.storeOffers?.find(x => x.provider === selectedProvider)?.url ? 'disabled' : ''}>${ownsOffer(g.storeOffers?.find(x => x.provider === selectedProvider)) ? 'Уже в библиотеке' : 'Купить в ' + names[selectedProvider] + ' ↗'}</button><button class="secondary" id="detail-wish">${has('wishlist', g.id) ? '♥ В желаемом' : '♡ В желаемое'}</button></div>${accountSelect(selectedProvider, 'buy-account')}<div class="hint">Оплата и выбор издания происходят в магазине. Перед покупкой проверь аккаунт, регион и состав издания.</div>`}</div>`;
}
// Back / forward like the Steam client: every page and opened game is a step.
const viewHistory = [];
let viewIndex = -1,
  restoringView = false;
function rememberView() {
  const view = { page, game: page === 'library' ? librarySelection : null };
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
  librarySelection = view.game && activeGames().some(g => g.id === view.game) ? view.game : null;
  render();
  $('#main').scrollTop = 0;
}
// Bottom bar like the Steam client: "ЗАГРУЗКИ" with the running downloads.
function renderDownloads() {
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
  const account = $('#buy-account')?.value || undefined;
  const r = await call('buy', { id: detailId, provider: p, account });
  if (r?.opened)
    toast(
      `Открыт официальный магазин${r.account ? ' · аккаунт ' + r.account : ''}. Проверь издание перед оплатой.`
    );
}
