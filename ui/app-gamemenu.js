// Right click on a game of the library (the list on the left, the shelves, favourites…):
// a menu like Steam's — play, favourites, collections, «Управление», store page, properties.
// Each item runs the same action as the button on the game's library page.
/* global state, demo, api, call, esc, $, run, render, toast, toggle, has, activeGames, isRunning,
   selectedLibraryOffer, librarySelection:writable, libraryProvider:writable, showDetail, CLICK_BY_ID,
   hideHover, hideLibraryHover */
let gameMenuId = null;

function gameMenuDir(o) {
  return o?.installDir || o?.installLocation || '';
}
function gameMenuHtml(g) {
  const o = selectedLibraryOffer(g);
  const installed = !!o?.installed;
  const running = isRunning(g.id);
  const item = (act, label, extra = '') =>
    `<button type="button" role="menuitem" data-gm="${act}" ${extra}>${label}</button>`;
  const sub = (label, inner) =>
    `<div class="gm-sub" role="none"><button type="button" role="menuitem" aria-haspopup="menu" class="gm-parent">${label}</button><div class="gm-menu gm-submenu" role="menu">${inner}</div></div>`;
  const collections = state.settings.collections || [];
  const inCollections = collections
    .map(c =>
      item(
        'collection',
        esc(c.name),
        `data-collection="${esc(c.id)}" class="${c.games.includes(g.id) ? 'checked' : ''}" aria-checked="${c.games.includes(g.id)}"`
      )
    )
    .join('');
  const manage = [
    gameMenuDir(o) && installed ? item('folder', 'Обзор локальных файлов') : '',
    installed && o.provider !== 'custom' ? item('verify', 'Проверить целостность файлов') : '',
    '<hr>',
    item('hide', g.hidden ? 'Показать игру' : 'Скрыть игру'),
    installed && o.provider !== 'custom' ? item('uninstall', 'Удалить с устройства') : '',
  ].join('');
  const main = running
    ? item('stop', '■ Закрыть игру', 'class="gm-strong"')
    : item(
        'play',
        installed ? 'Играть' : state.progress?.[g.id]?.nexus ? 'Продолжить загрузку' : 'Установить',
        `class="gm-strong" ${demo ? 'disabled' : ''}`
      );
  return (
    main +
    '<hr>' +
    item('favorite', has('favorites', g.id) ? 'Убрать из избранного' : 'Добавить в избранное') +
    sub(
      'Добавить в',
      (inCollections || '<span class="gm-empty">Коллекций пока нет</span>') +
        (demo ? '' : '<hr>' + item('new-collection', 'Новая коллекция…'))
    ) +
    sub('Управление', manage) +
    '<hr>' +
    item('store', 'Страница в магазине') +
    item('properties', 'Свойства…')
  );
}
function closeGameMenu() {
  const m = $('#game-menu');
  if (m) m.hidden = true;
  gameMenuId = null;
}
function openGameMenu(id, x, y) {
  const g = activeGames().find(v => v.id === id);
  if (!g) return false;
  let m = $('#game-menu');
  if (!m) {
    m = document.createElement('div');
    m.id = 'game-menu';
    m.className = 'gm-menu';
    m.setAttribute('role', 'menu');
    document.body.append(m);
  }
  gameMenuId = id;
  hideHover();
  hideLibraryHover();
  m.setAttribute('aria-label', g.name);
  m.innerHTML = gameMenuHtml(g);
  m.hidden = false;
  // Keep the menu (and its submenus) inside the window.
  const w = m.offsetWidth,
    h = m.offsetHeight;
  const left = Math.min(x, innerWidth - w - 4),
    top = Math.min(y, innerHeight - h - 4);
  m.style.left = Math.max(4, left) + 'px';
  m.style.top = Math.max(4, top) + 'px';
  m.classList.toggle('gm-flip', left + w * 2 > innerWidth);
  m.querySelector('button:not([disabled])')?.focus();
  return true;
}
// The game becomes the library selection: the page's own handlers act on it.
function gameMenuSelect(id) {
  if (librarySelection !== id) libraryProvider = null;
  librarySelection = id;
}
const GAME_MENU_ACTIONS = {
  play: id => {
    gameMenuSelect(id);
    return CLICK_BY_ID['library-play'](document.createElement('button'));
  },
  stop: id => {
    gameMenuSelect(id);
    const el = document.createElement('button');
    el.id = 'library-stop';
    return CLICK_BY_ID['library-stop'](el);
  },
  favorite: id => toggle('favorites', id),
  collection: async (id, el) => {
    state = await call('setInCollection', {
      collection: el.dataset.collection,
      id,
      include: !el.classList.contains('checked'),
    });
    render();
  },
  'new-collection': id => showDetail(id, true),
  folder: async id => {
    const o = selectedLibraryOffer(activeGames().find(v => v.id === id));
    await call('openGameFolder', gameMenuDir(o));
  },
  verify: async id => {
    gameMenuSelect(id);
    const el = document.createElement('button');
    const g = activeGames().find(v => v.id === id);
    // Epic games downloaded by Nexus are checked by Nexus, the rest by their client.
    if (selectedLibraryOffer(g)?.provider === 'epic' && state.settings.nexusDownloads !== false)
      el.dataset.downloadAction = 'repair';
    else el.dataset.clientAction = 'verify';
    // The ordinary click route: the same handlers as the buttons on the game page.
    document.body.append(el);
    el.click();
    el.remove();
  },
  hide: id => {
    gameMenuSelect(id);
    return CLICK_BY_ID['library-hide']();
  },
  uninstall: async id => {
    const o = selectedLibraryOffer(activeGames().find(v => v.id === id));
    const el = document.createElement('button');
    el.dataset.uninstall = o.provider;
    el.dataset.gameId = id;
    document.body.append(el);
    el.click();
    el.remove();
  },
  store: id => {
    gameMenuSelect(id);
    return CLICK_BY_ID['library-store']();
  },
  properties: id => showDetail(id, true),
};

document.addEventListener('contextmenu', event => {
  const el = event.target.closest('[data-detail]');
  if (
    !el ||
    el.closest('#game-menu') ||
    !api ||
    !openGameMenu(el.dataset.detail, event.clientX, event.clientY)
  )
    return;
  event.preventDefault();
});
document.addEventListener(
  'click',
  event => {
    const m = $('#game-menu');
    if (!m || m.hidden) return;
    const item = event.target.closest('#game-menu [data-gm]');
    if (!item) {
      if (!event.target.closest('#game-menu')) closeGameMenu();
      return;
    }
    event.stopPropagation();
    if (item.disabled) return;
    const id = gameMenuId;
    closeGameMenu();
    run(() => GAME_MENU_ACTIONS[item.dataset.gm]?.(id, item));
  },
  true
);
document.addEventListener('keydown', event => {
  const m = $('#game-menu');
  if (!m || m.hidden) return;
  if (event.key === 'Escape') {
    closeGameMenu();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = [...m.querySelectorAll(':scope > button:not([disabled]), :scope > .gm-sub > .gm-parent')];
  const i = items.indexOf(document.activeElement);
  items[(i + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  event.preventDefault();
});
addEventListener('blur', closeGameMenu);
addEventListener('resize', closeGameMenu);
document.addEventListener('scroll', closeGameMenu, true);
