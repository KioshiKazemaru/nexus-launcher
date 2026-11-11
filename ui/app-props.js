// «Свойства…» of a library game (right-click menu, the ⚙ button on the game page):
// a window like Steam's game properties — Общие, Установленные файлы, Дополнения.
// The boxes are the ones of the game page; their handlers act on librarySelection,
// which the window sets to its game.
/* global state, demo, api, esc, $, names, activeGames, has, bytesText, storageState, loadStorage,
   launchOptionsBox, trackProcessBox, collectionsBox, selectedLibraryOffer, gameMenuSelect, gameMenuDir,
   GAME_MENU_ACTIONS, run, call, render, dlcBox */
let propsDlg = null; // { id, tab }

const PROPS_TABS = { general: 'Общие', files: 'Установленные файлы', dlc: 'Дополнения' };

function propsGeneral(g) {
  return `<label class="check"><input type="checkbox" data-props-toggle="favorite" ${has('favorites', g.id) ? 'checked' : ''}> В избранном</label><label class="check"><input type="checkbox" data-props-toggle="hide" ${g.hidden ? 'checked' : ''}> Скрыть игру в библиотеке</label>${launchOptionsBox(g)}${trackProcessBox(g)}${collectionsBox(g)}`;
}
function propsFiles(g) {
  const sizes = new Map(
    (storageState.data?.drives || []).flatMap(d => d.games || []).map(x => [`${x.id}|${x.provider}`, x.size])
  );
  const offers = (g.offers || []).filter(o => o.installed);
  if (!offers.length)
    return `<p class="hint">Игра не установлена на этом компьютере.</p><button class="primary" data-props-act="play" ${demo ? 'disabled' : ''}>↓ Установить</button>`;
  return offers
    .map(o => {
      const dir = gameMenuDir(o);
      const size = sizes.get(`${g.id}|${o.provider}`);
      const busy = !!state.progress?.[g.id];
      return `<section class="props-install"><h3>${esc(names[o.provider] || o.provider)}</h3><p class="props-path">${dir ? esc(dir) : 'Папка неизвестна'}</p><p class="hint">Размер на диске: ${size ? bytesText(size) : storageState.loading ? 'считаем…' : '—'}</p><div class="props-buttons">${dir ? `<button class="secondary" data-open-folder="${esc(dir)}">Обзор…</button>` : ''}${o.provider !== 'custom' && !busy ? `<button class="secondary" data-props-act="verify" data-provider="${esc(o.provider)}">Проверить целостность файлов</button>` : ''}${state.platform !== 'darwin' && !demo ? `<button class="secondary" data-props-act="shortcut">${state.settings.shortcuts?.[g.id] ? 'Удалить ярлык с рабочего стола' : 'Ярлык на рабочий стол'}</button>` : ''}${o.provider === 'epic' && !busy ? `<button class="secondary" data-move-game="${esc(g.id)}">Переместить…</button>` : ''}${o.provider !== 'custom' && !busy ? `<button class="secondary danger" data-uninstall="${esc(o.provider)}" data-game-id="${esc(g.id)}">Удалить с устройства</button>` : ''}</div></section>`;
    })
    .join('');
}
function renderPropsDialog() {
  let dlg = $('#props-dialog');
  if (!propsDlg) {
    if (dlg?.open) dlg.close();
    return;
  }
  const g = activeGames().find(x => x.id === propsDlg.id);
  if (!g) {
    propsDlg = null;
    if (dlg?.open) dlg.close();
    return;
  }
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'props-dialog';
    dlg.className = 'install-dialog props-dialog';
    dlg.addEventListener('close', () => (propsDlg = null));
    document.body.append(dlg);
  }
  // Typing in a field of the window: a redraw would take the text away.
  if (
    dlg.open &&
    dlg.contains(document.activeElement) &&
    document.activeElement.matches('input[type=text], input:not([type])')
  )
    return;
  if (propsDlg.tab === 'files' && !storageState.data && !storageState.loading) loadStorage();
  const tab = propsDlg.tab;
  const body = tab === 'files' ? propsFiles(g) : tab === 'dlc' ? gameDlcSection(g) : propsGeneral(g);
  dlg.innerHTML = `<button class="close" data-props-close aria-label="Закрыть">×</button><h2>${esc(g.name)}</h2><div class="props-layout"><nav class="props-tabs" role="tablist">${Object.entries(
    PROPS_TABS
  )
    .map(
      ([k, v]) =>
        `<button role="tab" data-props-tab="${k}" aria-selected="${k === tab}" class="${k === tab ? 'active' : ''}">${v}</button>`
    )
    .join('')}</nav><div class="props-body" role="tabpanel">${body}</div></div>`;
  if (!dlg.open) dlg.showModal();
}
function openProps(id, tab = 'general') {
  if (!activeGames().some(x => x.id === id)) return;
  gameMenuSelect(id);
  propsDlg = { id, tab };
  renderPropsDialog();
}

document.addEventListener('click', event => {
  const open = event.target.closest('[data-props-open]');
  if (open) return openProps(open.dataset.propsOpen, open.dataset.propsTabOpen || 'general');
  const dlg = event.target.closest('#props-dialog');
  if (!dlg || !propsDlg) return;
  const el = event.target.closest('button');
  if (event.target === dlg) return dlg.close(); // a click on the backdrop
  if (!el) return;
  if (el.dataset.propsClose !== undefined) return dlg.close();
  if (el.dataset.propsTab) {
    propsDlg.tab = el.dataset.propsTab;
    return renderPropsDialog();
  }
  if (el.dataset.propsAct) {
    const id = propsDlg.id;
    if (el.dataset.propsAct === 'play') dlg.close();
    run(() => GAME_MENU_ACTIONS[el.dataset.propsAct]?.(id, el));
  }
});
document.addEventListener('change', event => {
  const el = event.target.closest('#props-dialog [data-props-toggle]');
  if (!el || !propsDlg) return;
  const id = propsDlg.id;
  run(() => GAME_MENU_ACTIONS[el.dataset.propsToggle](id));
});

// ---- DLC of a Steam game: the library page, «Свойства» → «Дополнения», the store page ----
const steamDlcState = new Map(); // app id → null (loading) | { items, total, known } | { error }
function dlcAppOf(g) {
  const id = String(
    g?.offers?.find(o => o.provider === 'steam')?.appId ||
      g?.steam ||
      g?.storeOffers?.find(o => o.provider === 'steam')?.appId ||
      ''
  );
  return /^\d{1,10}$/.test(id) ? id : '';
}
async function requestSteamDlc(appId) {
  if (!api?.gameDlc || demo || !appId || steamDlcState.has(appId)) return;
  steamDlcState.set(appId, null);
  try {
    steamDlcState.set(appId, await call('gameDlc', { appId }));
  } catch (e) {
    steamDlcState.set(appId, { error: e.message });
  }
  render();
}
function dlcPrice(d) {
  if (d.owned) return '<span class="dlc-owned">✓ Есть</span>';
  if (d.comingSoon) return '<span class="hint">Скоро</span>';
  if (d.free) return '<span>Бесплатно</span>';
  if (!d.price) return '';
  return `${d.discount ? `<b class="dlc-discount">−${d.discount}%</b> <s>${esc(d.originalPrice)}</s> ` : ''}<span>${esc(d.price)}</span>`;
}
function dlcRows(list) {
  return list
    .map(
      d =>
        `<div class="dlc-row ${d.owned ? 'owned' : ''}"><span class="dlc-name">${esc(d.name)}</span><span class="dlc-price">${dlcPrice(d)}</span><button class="link" data-open-link="https://store.steampowered.com/app/${esc(d.appId)}/" title="Страница в Steam">↗</button></div>`
    )
    .join('');
}
// → { appId, data } or the html to show while loading or after an error ('' = nothing).
function steamDlcData(g) {
  const appId = dlcAppOf(g);
  if (!appId || demo || !api?.gameDlc) return { html: '' };
  requestSteamDlc(appId);
  const data = steamDlcState.get(appId);
  if (!data) return { html: '<p class="hint">Загружаем дополнения…</p>' };
  if (data.error) return { html: `<p class="hint">${esc(data.error)}</p>` };
  return { appId, data };
}
function dlcCountLine(data) {
  const owned = data.items.filter(d => d.owned).length;
  return data.known ? `есть ${owned} из ${data.total}` : `${data.total}`;
}
// Library page, right column: a few DLC and the way to all of them.
function dlcSummary(g) {
  const r = steamDlcData(g);
  if (!r.data) return r.html ? `<h2>ДОПОЛНЕНИЯ</h2><div class="library-activity-box">${r.html}</div>` : '';
  if (!r.data.total) return '';
  const list = [...r.data.items].sort((a, b) => b.owned - a.owned).slice(0, 5);
  return `<h2>ДОПОЛНЕНИЯ · ${dlcCountLine(r.data)}</h2><div class="library-activity-box dlc-list">${dlcRows(list)}<button class="link" data-props-open="${esc(g.id)}" data-props-tab-open="dlc">Все дополнения (${r.data.total}) →</button></div>`;
}
// «Свойства» → «Дополнения»: every DLC of the game, and the Epic ones of an installed Epic game.
function gameDlcSection(g) {
  const r = steamDlcData(g);
  const epic = typeof dlcBox === 'function' ? dlcBox(g) : '';
  const steam = r.data
    ? r.data.total
      ? `<p class="hint">Steam · ${dlcCountLine(r.data)}${r.data.known ? '' : ' (войдите в Steam, чтобы видеть купленные)'}</p><div class="dlc-list props-dlc">${dlcRows(r.data.items)}</div>`
      : '<p class="hint">У этой игры нет дополнений в Steam.</p>'
    : r.html;
  return steam || epic
    ? steam + epic
    : '<p class="hint">Дополнения показываются у игр Steam и у установленных игр Epic Games.</p>';
}
// The store page of a game: «Дополнительный контент для этой игры», like Steam.
function storeDlcSection(g) {
  const r = steamDlcData(g);
  if (!r.data || !r.data.total) return '';
  const more = r.data.total > 10;
  return `<section class="sg-section"><h2>Дополнительный контент для этой игры</h2><div class="dlc-list sg-dlc">${dlcRows(r.data.items.slice(0, 10))}</div>${more ? `<button class="link" data-open-link="https://store.steampowered.com/dlc/${esc(r.appId)}/">Все дополнения в Steam (${r.data.total}) ↗</button>` : ''}</section>`;
}
