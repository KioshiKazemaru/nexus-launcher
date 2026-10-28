// Nexus window, part 1 of 5: State, helpers, prices, the account bar and running games.
// The parts are classic scripts loaded in order by index.html and share one
// global scope (see eslint.config.cjs); app-boot.js starts the window.
let state,
  page = 'store',
  filter = 'all',
  query = '',
  demo = false,
  detailId = null,
  selectedProvider = 'steam',
  storeProvider = 'all',
  featuredIndex = 0,
  storeTag = null,
  storeList = 'featured',
  listStore = 'all', // store of the lists: all | steam | epic
  librarySelection = null,
  libraryProvider = null,
  librarySort = 'name',
  libraryLimit = 120,
  collectionFilter = null,
  showHidden = false,
  suggestionsOpen = false;
const LIBRARY_PAGE = 120;
const $ = s => document.querySelector(s);
const esc = s =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const names = { steam: 'Steam', epic: 'Epic Games', custom: 'Сторонняя игра' };
const api = window.nexus;
let searchState = { items: [], providers: {}, loading: false, query: '', start: 0 },
  searchSequence = 0,
  searchTimer;
const browseState = new Map(),
  dlcState = new Map(),
  homeState = new Map();
// Recommendations per region: { loading, items, profile, basedOn, error, checkedAt }.
const recState = new Map();
let hoverTimer,
  hoverGame = null,
  listPreviewId = null;
const countries = {
  US: 'США · USD',
  RU: 'Россия · RUB',
  KZ: 'Казахстан · KZT',
  TR: 'Турция',
  DE: 'Германия · EUR',
  FI: 'Финляндия · EUR',
  UA: 'Украина · UAH',
  PL: 'Польша · PLN',
  GB: 'Великобритания · GBP',
  FR: 'Франция · EUR',
};
let priceFilter = { min: '', max: '', sale: false, sort: 'relevance' };
const currencyCountries = { USD: 'US', RUB: 'RU', KZT: 'KZ', EUR: 'DE', UAH: 'UA', PLN: 'PL', GBP: 'GB' };
const countryCurrencies = {
  US: 'USD',
  RU: 'RUB',
  KZ: 'KZT',
  TR: 'USD',
  DE: 'EUR',
  FI: 'EUR',
  UA: 'UAH',
  PL: 'PLN',
  GB: 'GBP',
  FR: 'EUR',
};
const currentCurrency = () => countryCurrencies[state.settings.storeCountry || 'US'] || 'USD';
function priceControls() {
  return `<div class="price-controls"><label>Валюта / регион<select id="store-currency">${Object.keys(
    currencyCountries
  )
    .map(c => `<option ${c === currentCurrency() ? 'selected' : ''}>${c}</option>`)
    .join(
      ''
    )}</select></label><label>Цена от<input id="price-min" type="number" min="0" step="0.01" placeholder="0" value="${esc(priceFilter.min)}"></label><label>До<input id="price-max" type="number" min="0" step="0.01" placeholder="Любая" value="${esc(priceFilter.max)}"></label><label class="check"><input id="sale-only" type="checkbox" ${priceFilter.sale ? 'checked' : ''}>Со скидкой</label><label>Порядок<select id="price-sort"><option value="relevance">По релевантности</option><option value="asc" ${priceFilter.sort === 'asc' ? 'selected' : ''}>Сначала дешевле</option><option value="desc" ${priceFilter.sort === 'desc' ? 'selected' : ''}>Сначала дороже</option><option value="discount" ${priceFilter.sort === 'discount' ? 'selected' : ''}>Больше скидка</option></select></label></div><p class="hint">Валюта выбирает регион каталога, без конвертации. Фильтры применяются к загруженным результатам; при нескольких предложениях достаточно одного подходящего. ${priceFilter.min !== '' && priceFilter.max !== '' && Number(priceFilter.min) > Number(priceFilter.max) ? 'Цена «от» больше цены «до».' : ''}</p>`;
}
function filteredOffers(g) {
  return (g.storeOffers || []).filter(
    o =>
      (!o.country || o.country === (state.settings.storeCountry || 'US')) &&
      Number.isFinite(o.amount) &&
      o.currency === currentCurrency() &&
      (priceFilter.min === '' || o.amount >= Number(priceFilter.min)) &&
      (priceFilter.max === '' || o.amount <= Number(priceFilter.max)) &&
      (!priceFilter.sale || o.discount > 0)
  );
}
function filterPrices(items) {
  const active =
    priceFilter.min !== '' || priceFilter.max !== '' || priceFilter.sale || priceFilter.sort !== 'relevance';
  if (!active) return items;
  const result = items.filter(g => filteredOffers(g).length);
  const value = g =>
    priceFilter.sort === 'discount'
      ? Math.max(...filteredOffers(g).map(o => o.discount || 0))
      : Math.min(...filteredOffers(g).map(o => o.amount));
  if (priceFilter.sort !== 'relevance')
    result.sort((a, b) => (value(a) - value(b)) * (priceFilter.sort === 'asc' ? 1 : -1));
  return result;
}
// An unexpected currency code from a store must not break the whole page.
function money(p) {
  if (!p) return 'Цена пока не получена';
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: p.currency }).format(p.amount);
  } catch {
    return Number.isFinite(p.amount)
      ? `${p.amount.toLocaleString('ru-RU')} ${String(p.currency || '').slice(0, 8)}`
      : 'Цена недоступна';
  }
}
function tracking() {
  const watches = (state.settings.priceWatches || []).filter(w =>
    w.name.toLowerCase().includes(query.toLowerCase())
  );
  return `<div class="section-head"><h1>Отслеживание скидок</h1><button class="secondary" id="check-prices">↻ Проверить цены</button></div><p class="subheading">При запуске и каждый час, пока Nexus открыт. Изменения сохраняются между запусками.</p>${
    watches.length
      ? watches
          .map(
            w =>
              `<section class="settings-card watch-card"><div><h2>${esc(w.name)}</h2><p>${names[w.provider]} · ${esc(countries[w.country] || w.country)}</p><strong class="watch-price">${esc(money(w.current))}</strong> ${w.current?.discount ? `<span class="pill blue">−${w.current.discount}%</span>` : ''}<p class="hint">${w.checkedAt ? 'Проверено: ' + new Date(w.checkedAt).toLocaleString('ru-RU') : 'Ожидает проверки'}</p>${w.error ? `<p class="watch-error">${esc(w.error)}. Показана последняя известная цена.</p>` : ''}${w.alert ? `<p class="watch-alert">${esc(w.alert.reason)} · ${esc(money(w.alert))} · ${new Date(w.alert.at).toLocaleString('ru-RU')}</p>` : ''}<details><summary>История цен (${w.historyCount ?? w.history?.length ?? 0})</summary>${(w.historyCount || 0) > (w.history?.length || 0) ? `<button class="ghost" data-full-history="${esc(w.key)}">Показать всю историю</button>` : ''}<ul>${(
                w.history || []
              )
                .slice()
                .reverse()
                .map(h => `<li>${new Date(h.at).toLocaleString('ru-RU')} · ${esc(money(h))}</li>`)
                .join(
                  ''
                )}</ul></details></div><div class="watch-actions"><label>Уведомить при цене не выше (${esc(w.current?.currency || '—')})<input type="number" min="0" max="100000000" step="0.01" data-target="${esc(w.key)}" value="${w.target ?? ''}" placeholder="Любое снижение" ${!w.current ? 'disabled' : ''}></label><span class="hint">Пусто — любое снижение. Изменение сохраняется после выхода из поля.</span><button class="ghost" data-unwatch="${esc(w.key)}">Прекратить отслеживание</button></div></section>`
          )
          .join('')
      : '<div class="empty"><h2>Выбери игру в магазине</h2><p>В карточке выбери Steam или Epic и нажми «Следить за ценой». Можно отслеживать оба предложения отдельно.</p></div>'
  }<p class="footnote">Уведомления появляются в Windows и сохраняются здесь. После закрытия Nexus проверки прекращаются. Регион каждого отслеживания фиксируется при добавлении; недоступная цена не считается скидкой.</p>`;
}
let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 6000);
}
async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
    return null;
  }
}
// Replies to actions carry only what changed (like pushed updates); they are
// merged into the current state here, so callers always get a complete state.
const isState = x =>
  !!x && typeof x === 'object' && 'accounts' in x && 'settings' in x && 'libraryState' in x;
async function call(name, payload) {
  if (!api)
    throw Error('Это браузерный просмотр. Вход, сканирование и запуск доступны в Windows-приложении.');
  const result = await api[name](payload);
  if (isState(result)) return absorbState(result);
  if (result && isState(result.state)) return { ...result, state: absorbState(result.state) };
  return result;
}
function activeGames() {
  return demo ? window.NexusDemo.games : state.games;
}
const detailPrices = new Map();
function game(id) {
  const owned = activeGames().find(x => x.id === id),
    found = searchState.items.find(x => x.id === id),
    browse = [
      ...browseState.values(),
      ...dlcState.values(),
      homeState.get(state.settings.storeCountry || 'US') || {},
      recState.get(state.settings.storeCountry || 'US') || {},
    ]
      .flatMap(x => [...(x.items || []), ...(x.promotions || [])])
      .find(x => x.id === id),
    saved = state.catalog.find(x => x.id === id),
    store = [saved, browse, found]
      .filter(Boolean)
      .sort((a, b) => (b.pricesUpdatedAt || 0) - (a.pricesUpdatedAt || 0))[0];
  const g = owned ? { ...store, ...owned, storeOffers: store?.storeOffers || owned.storeOffers } : store;
  if (!g) return g;
  const live = detailPrices.get(id);
  return live?.country === (state.settings.storeCountry || 'US')
    ? { ...g, storeOffers: live.storeOffers }
    : g;
}
// "$69.99", "9,99 $" or "34 999,00₸" from a store page → number (NaN if none).
function parseMoney(text) {
  const digits = String(text ?? '').replace(/[^\d.,]/g, '');
  const m = /^(.*?)[.,](\d{2})$/.exec(digits);
  const n = Number((m ? m[1] : digits).replace(/[.,]/g, '') + (m ? '.' + m[2] : ''));
  return digits && Number.isFinite(n) ? n : NaN;
}
// Both stores in one format: Steam pages write "$69.99", Epic "9,99 $" and "0" for free games.
function displayPrice(offer) {
  if (Number.isFinite(offer?.amount) && offer.currency)
    return offer.amount === 0 ? 'Бесплатно' : money(offer);
  if (offer?.price && parseMoney(offer.price) === 0) return 'Бесплатно';
  return offer?.price || '';
}
function displayOriginal(offer, price) {
  if (!offer?.originalPrice || !(offer.discount > 0)) return '';
  const n = parseMoney(offer.originalPrice);
  const text =
    Number.isFinite(n) && n > 0 && offer.currency
      ? money({ amount: n, currency: offer.currency })
      : offer.originalPrice;
  return text !== price ? text : '';
}
function salePrice(offer) {
  if (offer?.country && offer.country !== (state.settings.storeCountry || 'US'))
    return '<span class="price-pending">Загрузка цены…</span>';
  const price = displayPrice(offer);
  if (price) {
    const original = displayOriginal(offer, price);
    return `<span class="price-value">${esc(price)}</span>${original ? `<del>${esc(original)}</del>` : ''}${offer.discount > 0 ? `<b class="sale-percent">−${offer.discount}%</b>` : ''}`;
  }
  return `<span class="price-pending" title="${esc(offer?.priceError || '')}">${offer?.priceStatus === 'error' ? 'Цена недоступна' : offer?.priceStatus === 'unavailable' ? esc(offer.priceError || 'Нет цены в регионе') : 'Загрузка цены…'}</span>`;
}
function priceOffers(g) {
  if (g.storeOffers?.length) return g.storeOffers;
  return [
    ...new Set([
      ...(g.steam ? ['steam'] : []),
      ...(g.epic ? ['epic'] : []),
      ...(g.offers || []).map(o => o.provider).filter(p => p !== 'custom'),
    ]),
  ].map(provider => ({ provider }));
}
// "Где дешевле": cheapest of comparable offers (same currency, both priced).
function bestOffer(offers) {
  const priced = (offers || []).filter(
    o =>
      Number.isFinite(o?.amount) &&
      o.currency &&
      o.priceStatus !== 'error' &&
      (!o.country || o.country === (state.settings.storeCountry || 'US'))
  );
  if (priced.length < 2 || new Set(priced.map(o => o.currency)).size !== 1) return null;
  const sorted = [...priced].sort((a, b) => a.amount - b.amount);
  if (sorted[0].amount === sorted[1].amount) return { equal: true };
  return {
    provider: sorted[0].provider,
    saving: sorted[1].amount - sorted[0].amount,
    currency: sorted[0].currency,
  };
}
function bestBadge(g) {
  const b = bestOffer(priceOffers(g));
  if (!b) return '';
  if (b.equal) return '<div class="best-price equal">Цена одинаковая в обоих магазинах</div>';
  return `<div class="best-price">Дешевле в ${names[b.provider]} на ${esc(money({ amount: b.saving, currency: b.currency }))}</div>`;
}
function ownsOffer(offer) {
  return (
    !!offer &&
    (
      state.ownedOffers ||
      activeGames()
        .flatMap(g => g.offers || [])
        .filter(o => o.owned === true)
    ).some(o => {
      if (o.provider !== offer.provider) return false;
      if (o.provider === 'steam')
        return /^\d+$/.test(String(o.appId)) && String(o.appId) === String(offer.appId || '');
      if (o.namespace && offer.namespace && o.namespace !== offer.namespace) return false;
      return !!(
        (o.appId && offer.appId && o.appId === offer.appId) ||
        (o.namespace &&
          o.itemId &&
          o.namespace === offer.namespace &&
          offer.items?.some(i => i.namespace === o.namespace && i.id === o.itemId))
      );
    })
  );
}
function ownedProviders(g) {
  // A library game (account offers) is owned even when the store has no offer for it.
  const library = (g.offers || [])
    .filter(o => o.owned === true && ['steam', 'epic'].includes(o.provider))
    .map(o => o.provider);
  return [...library, ...storeOwnedProviders(g)];
}
function storeOwnedProviders(g) {
  return priceOffers(g)
    .filter(
      o =>
        ownsOffer(o) ||
        (o.provider === 'steam' && g.steam && ownsOffer({ provider: 'steam', appId: g.steam }))
    )
    .map(o => o.provider);
}
async function refreshDetailPrice(force = false) {
  const id = detailId,
    country = state.settings.storeCountry || 'US';
  if (!id || !api?.gamePrices || demo) return;
  try {
    const result = await call('gamePrices', { id, force });
    if (country === (state.settings.storeCountry || 'US')) {
      detailPrices.set(id, result);
      refreshCards(new Set([id]));
    }
  } catch (e) {
    toast(e.message);
  }
}

function has(list, id) {
  return state.settings[list].includes(id);
}
async function toggle(list, id) {
  if (demo || !api) {
    state.settings[list] = has(list, id)
      ? state.settings[list].filter(x => x !== id)
      : [...state.settings[list], id];
  } else state = await call('toggle', { list, id });
  render();
}
function safeImage(value) {
  if (typeof value !== 'string') return '';
  if (
    /^assets\/covers\/\d+(?:-hero|-portrait)?\.jpg$/.test(value) ||
    /^data:image\/(?:png|jpeg|webp);base64,/.test(value) ||
    /^nexus-art:\/\/steam\/\d+\/(?:portrait|header|hero)$/.test(value)
  )
    return value;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' &&
      (/(^|\.)steamstatic\.com$/.test(u.hostname) ||
        [
          'steamcdn-a.akamaihd.net',
          'cdn1.epicgames.com',
          'cdn2.epicgames.com',
          'cdn2.unrealengine.com',
          'images.igdb.com',
          'cdn2.steamgriddb.com',
        ].includes(u.hostname))
      ? value
      : '';
  } catch {
    return '';
  }
}
function artwork(g) {
  return (
    safeImage(g.image) ||
    (g.steam
      ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.steam}/header.jpg`
      : '') ||
    // A tall cover is better than none (e.g. Epic games without a wide image).
    (String(g.portrait || '').startsWith('https:') ? safeImage(g.portrait) : '')
  );
}
function artTag(g, cls = '') {
  const src = artwork(g);
  return src
    ? `<img class="${cls}" data-fallback="${esc(g.steam ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.steam}/header.jpg` : src)}" src="${esc(src)}" alt="Обложка ${esc(g.name)}" loading="lazy" referrerpolicy="no-referrer">`
    : '<span class="cover-missing">Обложка недоступна</span>';
}
function ownershipBadge(g) {
  const ps = [...new Set(ownedProviders(g))];
  return ps.length
    ? `<div class="owned-badge">✓ Уже в библиотеке: ${ps.map(p => names[p]).join(' · ')}</div>`
    : '';
}
function card(g) {
  g = game(g.id) || g;
  return `<article class="game-card" data-price-game="${esc(g.id)}" data-preview="${esc(g.id)}"><button class="heart ${has('wishlist', g.id) ? 'saved' : ''}" data-wish="${esc(g.id)}" aria-label="${has('wishlist', g.id) ? 'Убрать из' : 'Добавить в'} желаемое: ${esc(g.name)}">${has('wishlist', g.id) ? '♥' : '♡'}</button><button class="card-open" data-detail="${esc(g.id)}"><div class="card-art real-cover">${artTag(g)}</div><div class="card-info"><strong title="${esc(g.name)}">${esc(g.name)}</strong><div class="card-tags">${(g.tags || []).slice(0, 3).map(esc).join(' · ') || reviewLine(g, true)}</div><div class="card-prices">${
    priceOffers(g)
      .map(
        o => `<div class="card-price-row"><span>${names[o.provider]}</span><div>${salePrice(o)}</div></div>`
      )
      .join('') || '<span class="price-pending">Добавлена вручную</span>'
  }</div>${ownershipBadge(g) || bestBadge(g)}</div></button></article>`;
}
// ---- running games and friends --------------------------------------------
// The running game of a store (for "В игре: …"); a manually added game counts for Steam.
function runningOf(provider) {
  const list = Object.entries(state.running || {}).map(([id, r]) => ({ id, ...r }));
  return (
    list.find(r => r.provider === provider) ||
    (provider === 'steam' ? list.find(r => r.provider === 'custom') : null) ||
    null
  );
}
const isRunning = id => !!state.running?.[id];
// "Друзья и чат" is its own window (ui/friends.html); here only the counter
// in the bottom bar: friends online and unread messages.
let friendsState = { loading: false, data: null },
  unreadChats = {};
async function loadFriends(force = false) {
  if (!api?.friends || demo || friendsState.loading) return;
  if (!(state.accountList || []).some(a => a.status === 'connected')) {
    friendsState = { loading: false, data: null };
    renderFriends();
    return;
  }
  friendsState = { ...friendsState, loading: true };
  try {
    const data = await call('friends', { force });
    friendsState = { loading: false, data };
    unreadChats = data.unread || {};
  } catch {
    friendsState = { ...friendsState, loading: false };
  }
  renderFriends();
}
function renderFriends() {
  const count = $('#friends-count');
  if (!count) return;
  const steamAll = [
    ...new Map((friendsState.data?.steam || []).flatMap(x => x.friends).map(f => [f.id, f])).values(),
  ];
  const online = steamAll.filter(f => f.status !== 'offline').length;
  const unread = Object.values(unreadChats).reduce((n, x) => n + (Number(x) || 0), 0);
  count.textContent = friendsState.data ? `· ${online} в сети` : '';
  const badge = $('#friends-unread');
  if (badge) {
    badge.hidden = !unread;
    badge.textContent = unread;
  }
  $('#friends-toggle')?.classList.toggle('has-unread', unread > 0);
}
function renderProfiles() {
  $('#account-status').innerHTML = ['steam', 'epic']
    .map(p => {
      const a = state.accounts[p] || {},
        connected = a.status === 'connected',
        status =
          { checking: 'Проверяем вход…', signedOut: 'Не выполнен вход', unavailable: 'Проверка недоступна' }[
            a.status
          ] || 'Не выполнен вход';
      const playing = connected ? runningOf(p) : null;
      return `<button class="profile-chip ${connected ? 'connected' : ''} ${playing ? 'in-game' : ''}" data-page="accounts" title="${esc(names[p] + ': ' + (connected ? a.name : status) + (playing ? ' · в игре: ' + playing.name : ''))}"><span class="profile-avatar">${safeImage(a.avatar) ? `<img src="${esc(safeImage(a.avatar))}" alt="" referrerpolicy="no-referrer">` : p === 'steam' ? 'S' : 'E'}</span><span class="profile-text"><small>${playing ? 'В игре: ' + esc(playing.name) : names[p]} <i class="status-dot"></i></small><strong>${esc(connected ? a.name : status)}</strong></span></button>`;
    })
    .join('');
}
function regionControl() {
  return `<label class="region">Регион каталога <select id="store-country">${Object.entries(countries)
    .map(
      ([k, v]) =>
        `<option value="${k}" ${k === (state.settings.storeCountry || 'US') ? 'selected' : ''}>${v}</option>`
    )
    .join('')}</select></label>`;
}
async function searchCatalog(append = false) {
  const current = query.trim(),
    country = state.settings.storeCountry || 'US',
    sequence = ++searchSequence;
  clearTimeout(searchTimer);
  if (page !== 'store' || !current) {
    searchState = { items: [], providers: {}, loading: false, query: '', start: 0 };
    render();
    return;
  }
  const start = append ? searchState.start + 24 : 0;
  const previous = append ? searchState.items : [];
  searchState = {
    items: previous,
    providers: append ? searchState.providers : {},
    loading: true,
    query: current,
    start,
  };
  render();
  try {
    if (!api) throw Error('Живой поиск доступен в Windows-приложении.');
    const result = await call('searchCatalog', { query: current, country, start });
    if (sequence !== searchSequence || query.trim() !== current || page !== 'store') return;
    const merged = new Map(previous.map(g => [g.id, g]));
    for (const g of result.items) {
      const old = merged.get(g.id);
      merged.set(
        g.id,
        old
          ? {
              ...old,
              ...g,
              storeOffers: [
                ...new Map(
                  [...(old.storeOffers || []), ...(g.storeOffers || [])].map(o => [o.provider + o.appId, o])
                ).values(),
              ],
            }
          : g
      );
    }
    searchState = { ...result, items: [...merged.values()], loading: false };
  } catch (e) {
    if (sequence !== searchSequence) return;
    searchState = { ...searchState, loading: false, error: e.message };
  }
  render();
}
function notice() {
  return demo
    ? '<div class="notice warning">Демонстрационный режим: игры, лицензии и история условные. Запуск и покупка отключены. <button class="ghost" id="exit-demo">Вернуться к моей библиотеке</button></div>'
    : '';
}
function storePool() {
  const home = homeState.get(state.settings.storeCountry || 'US');
  return api?.homeCatalog && !demo
    ? (home?.items || []).map(g => game(g.id) || g)
    : state.catalog.slice(0, 8).map(g => game(g.id) || g);
}
async function requestHome(force = false) {
  if (!api?.homeCatalog || demo) return;
  const country = state.settings.storeCountry || 'US',
    old = homeState.get(country);
  if (!force && old && (old.loading || Date.now() - old.checkedAt < 300000)) return;
  homeState.set(country, { ...old, loading: true });
  if (page === 'store' && !query.trim()) render();
  try {
    const result = await call('homeCatalog', { country, force });
    homeState.set(country, { ...result, checkedAt: result?.checkedAt || Date.now(), loading: false });
    if (result.free) state.free = result.free;
  } catch (e) {
    homeState.set(country, {
      items: old?.items || [],
      promotions: old?.promotions || [],
      error: e.message,
      checkedAt: Date.now(),
      loading: false,
    });
  }
  if (page === 'store' && country === (state.settings.storeCountry || 'US') && !query.trim()) render();
}
function storePlatform(items) {
  return storeProvider === 'all'
    ? items
    : items.filter(g => priceOffers(g).some(o => o.provider === storeProvider));
}
