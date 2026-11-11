// Nexus window: СООБЩЕСТВО → Обсуждения, Мастерская, Торговая площадка — Steam
// Community on the page itself, in a <webview> the main process guards
// (src/main/community-view.cjs: Steam https pages only, the Steam account's session).
// The webview lives outside #content, so redrawing a page never reloads it.
/* global page, demo, api, call, esc, $ */
const COMMUNITY_PAGES = {
  discussions: { name: 'Обсуждения', url: 'https://steamcommunity.com/discussions/' },
  workshop: { name: 'Мастерская', url: 'https://steamcommunity.com/workshop/' },
  market: { name: 'Торговая площадка', url: 'https://steamcommunity.com/market/' },
};
let communitySection = 'workshop',
  communityView = null,
  communityLoaded = '';

function communityCrumb() {
  return `СООБЩЕСТВО <span>/ ${esc(COMMUNITY_PAGES[communitySection].name.toUpperCase())}</span>`;
}
function communityButtons() {
  const v = communityView;
  const ready = !!v?.__ready;
  $('#community-back').disabled = !ready || !v.canGoBack();
  $('#community-forward').disabled = !ready || !v.canGoForward();
  $('#community-reload').disabled = !ready;
  for (const b of document.querySelectorAll('[data-community-section]')) {
    const on = b.dataset.communitySection === communitySection;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
}
function createCommunityView(url) {
  const v = document.createElement('webview');
  v.className = 'community-view';
  v.setAttribute('src', url);
  v.addEventListener('dom-ready', () => {
    v.__ready = true;
    communityButtons();
  });
  const moved = () => {
    $('#community-status').textContent = '';
    // «←», «→» and links inside Steam: the tab and the title follow the page shown.
    let path = '';
    try {
      path = new URL(v.getURL()).pathname;
    } catch {}
    const section = Object.keys(COMMUNITY_PAGES).find(k => path.startsWith(new URL(COMMUNITY_PAGES[k].url).pathname));
    if (section && section !== communitySection) {
      communitySection = communityLoaded = section;
      if (page === 'community') $('#breadcrumb').innerHTML = communityCrumb();
    }
    communityButtons();
  };
  v.addEventListener('did-navigate', moved);
  v.addEventListener('did-navigate-in-page', moved);
  v.addEventListener('did-start-loading', () => ($('#community-status').textContent = 'Загрузка…'));
  v.addEventListener('did-stop-loading', moved);
  v.addEventListener('did-fail-load', e => {
    if (e.isMainFrame && e.errorCode !== -3)
      $('#community-status').textContent = 'Страница Steam не загрузилась. Проверьте соединение и нажмите ↻.';
  });
  $('#community').append(v);
  return v;
}
// Called by render(): the page shows the webview, other pages hide it (it keeps its place).
function renderCommunity() {
  const host = $('#community');
  if (!host) return;
  const on = page === 'community';
  host.hidden = !on;
  if (!on) return;
  if (demo || !api) {
    $('#community-status').textContent = 'В демонстрационном режиме сообщество Steam не открывается.';
    communityButtons();
    return;
  }
  const url = COMMUNITY_PAGES[communitySection].url;
  if (!communityView) communityView = createCommunityView(url);
  else if (communityLoaded !== communitySection && communityView.__ready)
    // A new section interrupts the page still loading (ERR_ABORTED): not an error.
    communityView.loadURL(url).catch(() => {});
  else if (communityLoaded !== communitySection) communityView.setAttribute('src', url);
  communityLoaded = communitySection;
  communityButtons();
}
// From the menu СООБЩЕСТВО (app-events.js) and the tabs on the page.
async function openCommunity(section) {
  if (!Object.hasOwn(COMMUNITY_PAGES, section)) return;
  communitySection = section;
  if (page === 'community') {
    renderCommunity();
    $('#breadcrumb').innerHTML = communityCrumb();
  } else await setPage('community');
}

document.addEventListener('click', event => {
  const tab = event.target.closest('[data-community-section]');
  if (tab) return openCommunity(tab.dataset.communitySection);
  const id = event.target.closest('button')?.id;
  const v = communityView;
  if (!v?.__ready) return;
  if (id === 'community-back' && v.canGoBack()) v.goBack();
  else if (id === 'community-forward' && v.canGoForward()) v.goForward();
  else if (id === 'community-reload') v.reload();
  else if (id === 'community-browser') call('openLink', v.getURL()).catch(() => {});
});
