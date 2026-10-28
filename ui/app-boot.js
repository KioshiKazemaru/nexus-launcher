// Nexus window, part 5 of 5: Hover previews, state updates from the main process, start-up.
// The parts are classic scripts loaded in order by index.html and share one
// global scope (see eslint.config.cjs); app-boot.js starts the window.
const previewRequests = new Map();
function ensurePreview(id) {
  const g = game(id),
    offers = priceOffers(g || {}),
    key = id + ':' + (state.settings.storeCountry || 'US');
  if (
    !api?.gamePrices ||
    !(g?.steam || offers.some(o => o.provider === 'epic')) ||
    demo ||
    offers.some(o => o.screenshots?.length) ||
    Date.now() - (previewRequests.get(key) || 0) < 300000
  )
    return;
  previewRequests.set(key, Date.now());
  call('gamePrices', { id })
    .then(result => {
      detailPrices.set(id, result);
      if (listPreviewId === id) {
        const panel = $('#store-list-preview');
        if (panel) panel.innerHTML = previewContent(game(id));
      }
      if (hoverGame === id && $('#store-hover').classList.contains('visible'))
        $('#store-hover').innerHTML = previewContent(game(id));
    })
    .catch(() => {});
}
function hideHover() {
  clearTimeout(hoverTimer);
  $('#store-hover').classList.remove('visible');
  hoverGame = null;
}
function libraryPreview(g) {
  const image = artwork(g);
  const minutes = g.playtime;
  return `${image ? `<div class="library-hover-art">${artTag(g)}</div>` : ''}<div class="library-hover-body"><strong>${esc(g.name)}</strong><p>${
    g.offers
      ?.filter(o => o.owned)
      .map(o => names[o.provider])
      .join(' · ') || 'Установлена на ПК'
  }</p>${Number(minutes) > 0 ? `<p>В игре: ${hours(minutes)}</p>` : ''}${lastPlayedAt(g) ? `<p>Последний запуск: ${new Date(lastPlayedAt(g)).toLocaleDateString('ru-RU')}</p>` : ''}</div>`;
}
function hideLibraryHover() {
  const popup = $('#library-hover');
  if (popup) popup.classList.remove('visible');
}
// Carousel: hovering a screenshot shows it in the large image, as in Steam.
let showcaseHover = false,
  lastStoreInput = 0;
document.addEventListener('mouseover', event => {
  showcaseHover = !!event.target.closest?.('#showcase-block');
  const main = $('#showcase-main');
  if (main) {
    const shot = event.target.closest?.('[data-showcase-shot]');
    const next = shot ? shot.dataset.showcaseShot.replace('.600x338.', '.') : main.dataset.default;
    if (main.getAttribute('src') !== next) main.src = next;
  }
});
// Auto-rotation every 8 s; it waits while the pointer is on the carousel and
// for 20 s after the user clicked or typed anything.
for (const type of ['pointerdown', 'keydown'])
  document.addEventListener(type, () => (lastStoreInput = Date.now()));
setInterval(() => {
  if (page !== 'store' || query.trim() || document.hidden || showcaseHover || $('#details')?.open) return;
  if (Date.now() - lastStoreInput < 20000 || !$('#showcase-block')) return;
  const count = featuredItems().length;
  if (count < 2) return;
  featuredIndex = (featuredIndex + 1) % count;
  updateShowcase();
}, 8000);
document.addEventListener('mouseover', event => {
  const libraryEl = event.target.closest('[data-library-preview]');
  if (libraryEl && page !== 'store') {
    const g = game(libraryEl.dataset.libraryPreview),
      popup = $('#library-hover');
    if (!g || !popup) return;
    popup.innerHTML = libraryPreview(g);
    popup.classList.add('visible');
    const rect = libraryEl.getBoundingClientRect();
    popup.style.left = Math.max(12, Math.min(innerWidth - 352, rect.right + 12)) + 'px';
    popup.style.top = Math.max(48, Math.min(innerHeight - popup.offsetHeight - 12, rect.top)) + 'px';
    return;
  }
  if (page !== 'store') return;
  const row = event.target.closest('[data-list-preview]');
  if (row) {
    hideHover();
    const id = row.dataset.listPreview;
    if (listPreviewId !== id) {
      listPreviewId = id;
      document
        .querySelectorAll('.store-list-row')
        .forEach(el => el.classList.toggle('selected', el.dataset.listPreview === id));
      const panel = $('#store-list-preview');
      if (panel) panel.innerHTML = previewContent(game(id));
    }
    ensurePreview(id);
    return;
  }
  const cardEl = event.target.closest('[data-preview]');
  if (!cardEl || cardEl.dataset.preview === hoverGame) return;
  clearTimeout(hoverTimer);
  const id = cardEl.dataset.preview;
  hoverTimer = setTimeout(() => {
    if (!cardEl.isConnected) return;
    hoverGame = id;
    const popup = $('#store-hover');
    popup.innerHTML = previewContent(game(id), { shots: 4 });
    const rect = cardEl.getBoundingClientRect();
    const width = 340;
    popup.style.left = Math.max(10, Math.min(innerWidth - width - 12, rect.right + 10)) + 'px';
    popup.style.top = Math.max(50, Math.min(innerHeight - 410, rect.top)) + 'px';
    popup.classList.add('visible');
    ensurePreview(id);
  }, 250);
});
document.addEventListener('mouseout', event => {
  const cardEl = event.target.closest('[data-preview]');
  if (cardEl && !cardEl.contains(event.relatedTarget)) hideHover();
  const libraryEl = event.target.closest('[data-library-preview]');
  if (libraryEl && !libraryEl.contains(event.relatedTarget)) hideLibraryHover();
});
let priceScrollTimer;
$('#main').addEventListener('scroll', () => {
  clearTimeout(priceScrollTimer);
  priceScrollTimer = setTimeout(requestVisiblePrices, 200);
});
document.addEventListener(
  'wheel',
  event => {
    const rail = event.target.closest?.(
      '.sale-rail,.dlc-rail,.rec-rail,.quick-rail,.recent-shelf,.store-list-tabs,.library-game-links'
    );
    if (!rail || rail.scrollWidth <= rail.clientWidth + 1 || Math.abs(event.deltaY) <= Math.abs(event.deltaX))
      return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? rail.clientWidth : 1);
    const next = Math.max(0, Math.min(rail.scrollWidth - rail.clientWidth, rail.scrollLeft + delta));
    if (Math.abs(next - rail.scrollLeft) < 0.5) return;
    event.preventDefault();
    rail.scrollLeft = next;
  },
  { passive: false }
);
setInterval(() => {
  if (page === 'store' && !query.trim() && api && !demo) requestHome(true);
}, 300000);
document.addEventListener('mouseup', e => {
  if (e.button === 3 || e.button === 4) goHistory(e.button === 3 ? -1 : 1);
});
document.addEventListener('keydown', e => {
  if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    goHistory(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (e.ctrlKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#search').focus();
  }
});
// Returning to the window asks only for what changed: the full state (the
// whole game list, ≈1.4 MB on 2000 games) is sent once, when the window opens.
window.addEventListener('focus', () => {
  if (api && state)
    run(async () => {
      state = await call('stateUpdate');
      scheduleApply();
    });
});
// State arrives often during sync; render at most once per animation frame and
// never while the user is typing in a form on the page.
let statePending = false,
  dataChanged = false,
  lastFreeAt = 0;
// Pushed updates may omit unchanged sections (games, catalog): keep ours.
function mergeState(next) {
  const merged = { ...next };
  for (const k of ['games', 'ownedOffers', 'catalog'])
    if (next[k] === undefined) merged[k] = state?.[k] || [];
  if (next.prices === undefined) merged.prices = { ...(state?.prices || {}), ...(next.pricesDelta || {}) };
  return merged;
}
const changedCards = new Set();
// Ids whose per-game entry differs between two maps (prices or progress).
function diffIds(before = {}, after = {}) {
  const out = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) out.push(id);
  return out;
}
function applyState() {
  statePending = false;
  renderProfiles();
  document
    .querySelectorAll('[data-account-message]')
    .forEach(
      el =>
        (el.textContent =
          (state.accountList || []).find(a => a.key === el.dataset.accountMessage)?.message || '')
    );
  updateOffline();
  // Gamepad mode (ui/bigpicture.js) follows the state too.
  globalThis.bigPicture?.refresh();
  if (detailId && $('#details').open) renderDetail();
  // Only text entry blocks re-rendering; a focused <select> or checkbox keeps
  // focus after a change and must not freeze updates.
  const typing = document.activeElement?.matches?.(
    '#content input:not([type]), #content input[type="text"], #content input[type="search"], #content input[type="password"], #content input[type="number"], #content textarea'
  );
  // While typing, changes stay pending and are applied when the field loses focus.
  if (typing) return;
  const changed = dataChanged;
  dataChanged = false;
  const freeAt = state.free?.checkedAt || 0;
  const freeChanged = freeAt !== lastFreeAt;
  lastFreeAt = freeAt;
  // Status-only updates (sync progress, account checks) do not rebuild the
  // whole page: thousands of cards are re-rendered only when games changed.
  const cards = new Set(changedCards);
  changedCards.clear();
  if (
    !changed &&
    ['library', 'favorites', 'recent', 'wishlist', 'store'].includes(page) &&
    !(page === 'store' && freeChanged)
  ) {
    applyDerived(state);
    $('#lib-count').textContent = libraryGames().length;
    const status = $('#library-status');
    rememberOpenPanels();
    if (status) status.innerHTML = libraryStatus();
    renderDownloads();
    refreshCards(cards);
    return;
  }
  render();
}
// Merges a received state (push or reply) and records what changed for applyState.
function absorbState(next) {
  if (next.games !== undefined || next.catalog !== undefined) dataChanged = true;
  // A game started or ended: "Играть" ↔ "Закрыть" and "В игре" everywhere.
  if (
    next.running !== undefined &&
    JSON.stringify(Object.keys(next.running).sort()) !==
      JSON.stringify(Object.keys(state?.running || {}).sort())
  )
    dataChanged = true;
  // Newer store data from the main process replaces older per-game replies.
  const priced = [
    ...(next.prices !== undefined ? diffIds(state?.prices, next.prices) : []),
    ...Object.keys(next.pricesDelta || {}),
  ];
  for (const id of priced) {
    detailPrices.delete(id);
    changedCards.add(id);
  }
  diffIds(state?.progress, next.progress).forEach(id => changedCards.add(id));
  return mergeState(next);
}
function scheduleApply() {
  if (statePending) return;
  statePending = true;
  requestAnimationFrame(applyState);
}
// Updates postponed while typing are applied when the field loses focus.
document.addEventListener('focusout', event => {
  if (!event.target.closest?.('#content')) return;
  if (dataChanged || changedCards.size) setTimeout(scheduleApply, 0);
});
if (api?.onStateChanged)
  api.onStateChanged(next => {
    state = absorbState(next);
    scheduleApply();
  });
// Offline: banner, and a refresh as soon as the network is back.
function updateOffline() {
  const offline = navigator.onLine === false || state?.online === false;
  $('#offline-banner').hidden = !offline;
  document.body.classList.toggle('offline', offline);
}
window.addEventListener('offline', () => {
  updateOffline();
  // The reply is a state update like any other: merge it.
  if (api)
    call('networkChanged', false)
      .then(next => {
        state = next;
        scheduleApply();
      })
      .catch(() => {});
});
window.addEventListener('online', () =>
  run(async () => {
    updateOffline();
    if (!api) return;
    state = await call('networkChanged', true);
    render();
    if (page === 'store' && !query.trim()) requestHome(true);
  })
);
// Errors in the window go to the log file (no game data, just the message and place).
window.addEventListener('error', e =>
  api?.rendererError?.(`${e.message} @ ${e.filename}:${e.lineno}`).catch(() => {})
);
window.addEventListener('unhandledrejection', e =>
  api?.rendererError?.(String(e.reason?.stack || e.reason)).catch(() => {})
);
document.addEventListener(
  'toggle',
  e => {
    if (e.target.classList?.contains('merge-suggestions')) suggestionsOpen = e.target.open;
  },
  true
);
api?.onShowPage?.(p => setPage(p));
// A click on a "game installed" notification: its page in the library.
api?.onShowGame?.(id => {
  page = 'library';
  showDetail(id);
});
api?.onToast?.(message => toast(message));
// Library grid grows while scrolling instead of rendering thousands of cards at once.
const libraryObserver = new IntersectionObserver(
  entries => {
    if (entries.some(e => e.isIntersecting) && $('#library-more')) {
      libraryLimit += LIBRARY_PAGE;
      render();
    }
  },
  { root: $('#main'), rootMargin: '600px' }
);
new MutationObserver(() => {
  libraryObserver.disconnect();
  const sentinel = $('#library-more-sentinel');
  if (sentinel) libraryObserver.observe(sentinel);
}).observe($('#content'), { childList: true });
(async () => {
  state = api ? await api.state() : structuredClone(window.NexusDemo.empty);
  lastFreeAt = state.free?.checkedAt || 0;
  updateOffline();
  render();
})().catch(e => {
  $('#content').innerHTML =
    `<div class="notice warning">Не удалось загрузить приложение: ${esc(e.message)}</div>`;
});

document.addEventListener(
  'error',
  async event => {
    const el = event.target;
    if (el.tagName !== 'IMG') return;
    const box = el.parentElement;
    const localFallback = el.dataset.fallback;
    if (el.src.startsWith('nexus-art:') && localFallback && !el.dataset.triedFallback) {
      el.dataset.triedFallback = '1';
      el.src = localFallback;
      return;
    }
    if (
      localFallback &&
      !localFallback.startsWith('https:') &&
      safeImage(localFallback) &&
      !el.dataset.localFallback
    ) {
      el.dataset.localFallback = '1';
      el.src = localFallback;
      return;
    }
    const missing = () => {
      el.hidden = true;
      if (
        (box.classList.contains('card-art') ||
          box.classList.contains('detail-art') ||
          box.classList.contains('portrait-open')) &&
        !box.querySelector('.cover-missing')
      )
        box.insertAdjacentHTML('beforeend', '<span class="cover-missing">Обложка недоступна</span>');
      if (
        box.classList.contains('preview-images') &&
        [...box.querySelectorAll('img')].every(img => img.hidden) &&
        !box.querySelector('.preview-missing')
      )
        box.insertAdjacentHTML('beforeend', '<span class="preview-missing">Скриншоты пока недоступны</span>');
    };
    if (api?.getArtwork && !el.dataset.recovering && el.src.startsWith('https:')) {
      el.dataset.recovering = '1';
      for (const url of [
        ...new Set(
          [el.src, el.dataset.fallback, el.dataset.fallback2].filter(u => u && u.startsWith('https:'))
        ),
      ]) {
        try {
          const data = await call('getArtwork', url);
          if (!el.isConnected) return;
          el.hidden = false;
          el.src = data;
          box.querySelector('.cover-missing')?.remove();
          return;
        } catch {}
      }
    }
    missing();
  },
  true
);

// Friends: the counter in the bottom bar refreshes every minute; unread
// messages arrive from the chat service right away.
api?.onSocialEvent?.(ev => {
  if (ev?.type !== 'unread') return;
  unreadChats = ev.unread || {};
  renderFriends();
});
setInterval(() => {
  if (api && !demo && !document.hidden) loadFriends();
}, 60000);
setTimeout(() => loadFriends(), 4000);
