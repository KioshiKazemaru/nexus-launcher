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
// ---- store front, modelled on the Steam store ------------------------------

// The carousel shows the most popular games, like "Популярное и рекомендуемое" in Steam.
const FEATURED_LIMIT = 12;
let currentFeatured = null; // id of the game on screen, kept when the list changes
// Like "Популярное и рекомендуемое" in Steam, the carousel takes turns between
// three kinds of games: picked for you from your Steam and Epic libraries,
// popular new releases, and top sellers. Games you already own are skipped.
const NEW_DAYS = 60;
function featuredItems() {
  const country = state.settings.storeCountry || 'US',
    home = homeState.get(country);
  const keep = (g, kind) => {
    const live = game(g.id);
    const merged = live
      ? {
          ...live,
          reason: g.reason || live.reason,
          match: g.match || live.match,
          capsule: live.capsule || g.capsule,
          reviews: live.reviews || g.reviews,
          released: live.released || g.released,
          tags: live.tags?.length ? live.tags : g.tags,
        }
      : g;
    return { ...merged, featured: kind };
  };
  const recent = g => {
    const at = Number(g.released) || 0;
    return !at || (at <= Date.now() && Date.now() - at < NEW_DAYS * 86400000);
  };
  const lanes = [
    (recState.get(country)?.items || []).map(g => keep(g, 'recommended')),
    (home?.newReleases || [])
      .map(g => keep(g, 'new'))
      .filter(recent)
      // Steam shows the new releases people play: the most reviewed first.
      .sort((a, b) => (b.reviews?.count || 0) - (a.reviews?.count || 0)),
    storePool().map(g => keep(g, priceOffers(g).some(o => o.provider === 'steam') ? 'top' : 'epic')),
  ].map(lane => storePlatform(lane).filter(g => !ownedProviders(g).length));
  const out = [],
    seen = new Set();
  for (let i = 0; out.length < FEATURED_LIMIT && lanes.some(l => i < l.length); i++)
    for (const lane of lanes) {
      const g = lane[i];
      if (g && !seen.has(g.id) && out.length < FEATURED_LIMIT) {
        seen.add(g.id);
        out.push(g);
      }
    }
  return out;
}
// Why the game is in the carousel, as the labels of the Steam carousel.
function featuredLabel(g) {
  if (g.featured === 'recommended')
    return {
      title: 'Рекомендуем вам',
      note: g.reason ? reasonText(g.reason) : 'Подходит под ваши любимые метки',
      kind: 'recommended',
    };
  if (g.featured === 'new') {
    const at = Number(g.released) || 0;
    return {
      title: 'Новинка',
      note: at
        ? 'Вышла ' + new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
        : 'Недавно вышла',
      kind: 'new',
    };
  }
  if (g.featured === 'epic')
    return {
      title: 'Скидка в Epic Games',
      note: g.storeOffers?.[0]?.releaseDate ? 'Дата выхода: ' + g.storeOffers[0].releaseDate : '',
      kind: 'top',
    };
  return {
    title: 'Лидер продаж',
    note: releaseLabel(g) === 'Популярный товар' ? '' : releaseLabel(g),
    kind: 'top',
  };
}
// "Очень положительные (96 920)" — the user review summary of the Steam store.
function reviewLine(g, short = false) {
  const r = g?.reviews;
  if (!r?.label) return '';
  const tone = r.score >= 7 ? 'positive' : r.score >= 5 ? 'mixed' : 'negative';
  const count = Number(r.count || 0).toLocaleString('ru-RU');
  return `<span class="review-summary ${tone}" title="${esc(`Положительных обзоров: ${r.percent}% из ${count}`)}">${esc(r.label)}${short ? '' : ` <small>(${count})</small>`}</span>`;
}
function releaseLabel(g) {
  const at = Number(g?.released) || 0;
  if (at > Date.now())
    return `Выходит ${new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  if (at && Date.now() - at < 30 * 86400000) return 'Новинка';
  return 'Популярный товар';
}
function gameScreens(g, count = 4) {
  const offers = priceOffers(g);
  const source =
    offers.find(o => o.provider === 'steam' && o.screenshots?.length) ||
    offers.find(o => o.screenshots?.length);
  return (source?.screenshots || []).map(safeImage).filter(Boolean).slice(0, count);
}
function gameDescription(g) {
  return g?.desc || priceOffers(g).find(o => o.description)?.description || '';
}
function showcase() {
  const items = featuredItems();
  if (!items.length) return '';
  const index = featuredIndex % items.length,
    g = items[index],
    capsule = safeImage(g.capsule),
    main = capsule || artwork(g),
    screens = gameScreens(g),
    tags = (g.tags || []).filter(t => t !== 'Моя библиотека').slice(0, 4);
  currentFeatured = g.id;
  return `<div id="showcase-block"><div class="section-head"><h2>ПОПУЛЯРНОЕ И РЕКОМЕНДУЕМОЕ</h2>${homeStatus()}</div><section class="store-showcase" aria-roledescription="карусель" aria-label="${esc(`${g.name}, ${index + 1} из ${items.length}`)}"><button class="showcase-image" data-detail="${esc(g.id)}">${
    main
      ? `<img id="showcase-main" src="${esc(main)}" data-default="${esc(main)}" data-fallback="${esc(artwork(g))}" alt="${esc(g.name)}" referrerpolicy="no-referrer">`
      : '<span class="cover-missing">Обложка недоступна</span>'
  }${capsule ? '' : `<span class="showcase-name">${esc(g.name)}</span>`}</button><div class="showcase-info"><h2>${esc(g.name)}</h2>${
    screens.length
      ? `<div class="screenshot-grid">${screens.map(src => `<img src="${esc(src)}" data-showcase-shot="${esc(src)}" alt="Скриншот ${esc(g.name)}" loading="lazy" referrerpolicy="no-referrer">`).join('')}</div>`
      : `<div class="showcase-description">${esc(gameDescription(g) || 'Описание появится, когда магазин его пришлёт.')}</div>`
  }${(() => {
    const label = featuredLabel(g);
    return `<div class="showcase-status"><span class="feature-label ${label.kind}">${esc(label.title)}</span>${reviewLine(g)}</div>${label.note ? `<div class="feature-note">${esc(label.note)}</div>` : ''}`;
  })()}${
    tags.length ? `<div class="showcase-tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''
  }<div class="showcase-prices">${priceOffers(g)
    .map(o => `<div><span>${names[o.provider]}</span>${salePrice(o)}</div>`)
    .join(
      ''
    )}</div><button class="primary" data-detail="${esc(g.id)}">Открыть игру →</button></div><button class="carousel-arrow left" data-feature-step="-1" aria-label="Предыдущая игра">❮</button><button class="carousel-arrow right" data-feature-step="1" aria-label="Следующая игра">❯</button></section><div class="carousel-dots">${items.map((_, i) => `<button class="${i === index ? 'active' : ''}" data-feature-index="${i}" aria-label="Игра ${i + 1}"></button>`).join('')}</div></div>`;
}
// Updates only the carousel (auto-rotation must not rebuild the whole page).
function updateShowcase(keepCurrent = false) {
  if (keepCurrent) {
    const items = featuredItems();
    const current = currentFeatured;
    const at = items.findIndex(g => g.id === current);
    featuredIndex = at >= 0 ? at : 0;
  }
  const block = $('#showcase-block');
  if (block) block.outerHTML = showcase();
  // No carousel yet: a full render only when there is now something to show
  // (otherwise render → request → update would repeat endlessly).
  else if (page === 'store' && !query.trim() && featuredItems().length) render();
}
// Store front status in one small line instead of two technical rows.
function homeStatus() {
  const home = homeState.get(state.settings.storeCountry || 'US');
  const label = home?.loading
    ? 'Обновляем подборки…'
    : home?.checkedAt
      ? 'Обновлено в ' +
        new Date(home.checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : 'Steam + Epic Games';
  return `<span class="home-status">${esc(label)}<button class="ghost" id="refresh-home" title="Обновить витрину" aria-label="Обновить витрину">↻</button></span>`;
}
// Every store item loaded on this page (store front, sales, opened lists).
function allStoreGames() {
  const country = state.settings.storeCountry || 'US',
    home = homeState.get(country);
  const lists = [...browseState.entries()]
    .filter(([k]) => k.startsWith(country + ':'))
    .flatMap(([, v]) => v.items || []);
  return storePlatform([
    ...new Map(
      [...storePool(), ...(home?.promotions || []), ...lists, ...(recState.get(country)?.items || [])].map(
        g => [g.id, game(g.id) || g]
      )
    ).values(),
  ]);
}
// "Категории": the most common tags of the loaded games; a tile filters the catalogue.
function categoryTiles(pool) {
  const counts = new Map();
  for (const g of pool)
    for (const t of (g.tags || []).slice(0, 4))
      if (t && t !== 'Моя библиотека' && t !== 'Дополнение') counts.set(t, (counts.get(t) || 0) + 1);
  const top = [...counts]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (top.length < 4) return '';
  return `<div class="section-head"><h2>КАТЕГОРИИ</h2><span>По меткам игр на витрине</span></div><div class="category-grid">${top
    .map(([tag, n]) => {
      const cover = pool.find(g => g.tags?.includes(tag) && (safeImage(g.capsule) || artwork(g)));
      const src = cover ? safeImage(cover.capsule) || artwork(cover) : '';
      return `<button class="category-tile ${storeTag === tag ? 'active' : ''}" data-store-tag="${esc(tag)}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span>${esc(tag)}</span><small>${n} ${plural(n, 'игра', 'игры', 'игр')}</small></button>`;
    })
    .join('')}</div>`;
}
function plural(n, one, few, many) {
  const a = n % 10,
    b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}
// "До 10 $": inexpensive games of the region, like the price shelf of the Steam store.
const CHEAP_LIMIT = { USD: 10, EUR: 10, GBP: 10, RUB: 500, KZT: 5000, UAH: 400, PLN: 40 };
function cheapShelf(pool) {
  const currency = countryCurrencies[state.settings.storeCountry || 'US'],
    limit = CHEAP_LIMIT[currency];
  if (!limit) return '';
  const items = pool
    .filter(g =>
      priceOffers(g).some(
        o =>
          o.currency === currency &&
          Number.isFinite(o.amount) &&
          o.amount > 0 &&
          o.amount <= limit &&
          o.priceStatus !== 'error' &&
          (!o.country || o.country === (state.settings.storeCountry || 'US'))
      )
    )
    .slice(0, 12);
  if (items.length < 3) return '';
  return `<div class="section-head"><h2>ДО ${esc(money({ amount: limit, currency }).toUpperCase())}</h2><span>Недорогие игры Steam и Epic Games</span></div><div class="sale-rail">${items.map(card).join('')}</div>`;
}
const storeListLabels = {
  featured: 'Актуальное',
  new: 'Новинки',
  top: 'Лидеры',
  coming: 'Скоро',
  sales: 'Скидки',
  free: 'Бесплатные',
};
// Each list exists for both stores; "Все" takes turns between Steam and Epic.
const listStores = () => (listStore === 'all' ? ['steam', 'epic'] : [listStore]);
const browseKey = (kind, provider, country = state.settings.storeCountry || 'US') =>
  provider === 'epic' ? `${country}:epic:${kind}` : `${country}:${kind}`;
function listItems() {
  if (storeList === 'featured') {
    const pool = storePool();
    return listStore === 'all' ? pool : pool.filter(g => priceOffers(g).some(o => o.provider === listStore));
  }
  const lanes = listStores().map(p => browseState.get(browseKey(storeList, p))?.items || []);
  const remote = [];
  for (let i = 0; i < Math.max(0, ...lanes.map(l => l.length)); i++)
    for (const lane of lanes) if (lane[i]) remote.push(lane[i]);
  const curated = storePool().filter(g =>
    storeList === 'sales'
      ? priceOffers(g).some(o => o.discount > 0)
      : storeList === 'free'
        ? priceOffers(g).some(o => o.amount === 0 && o.priceStatus === 'ready')
        : false
  );
  return [...new Map([...remote, ...curated].map(g => [g.id, game(g.id) || g])).values()];
}
// Tags that are Nexus placeholders, not store tags.
const PLACEHOLDER_TAGS = new Set(['Моя библиотека', 'В каталоге магазина']);
// Game preview like the right panel of the Steam store lists: title, release
// date, user reviews, tags and large screenshots (Steam and Epic alike).
function previewContent(item, { shots = 4 } = {}) {
  const g = game(item?.id) || item;
  if (!g) return '';
  const offers = priceOffers(g),
    source =
      offers.find(o => o.provider === 'steam' && o.screenshots?.length) ||
      offers.find(o => o.screenshots?.length);
  const pictures = [...new Set([...(source?.screenshots || []), ...gameScreens(g, shots)])]
    .map(safeImage)
    .filter(Boolean)
    .slice(0, shots);
  const tags = [
    ...new Set(
      [...(g.tags || []), ...offers.flatMap(o => o.tags || [])].filter(t => t && !PLACEHOLDER_TAGS.has(t))
    ),
  ].slice(0, 6);
  const description =
    g.desc || offers.find(o => o.description || o.desc)?.description || offers.find(o => o.desc)?.desc || '';
  const released =
    offers.find(o => o.releaseDate)?.releaseDate ||
    (g.released
      ? new Date(g.released).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
      : '');
  const facts = [
    released ? `<div><span>Дата выхода:</span> ${esc(released)}</div>` : '',
    reviewLine(g) ? `<div><span>Обзоры:</span> ${reviewLine(g)}</div>` : '',
    `<div><span>Магазины:</span> ${[...new Set(offers.map(o => names[o.provider]).filter(Boolean))].join(' · ') || '—'}</div>`,
  ].join('');
  return `<strong>${esc(g.name)}</strong><div class="preview-facts">${facts}</div>${description ? `<p>${esc(description)}</p>` : ''}${
    tags.length ? `<div class="preview-tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''
  }<div class="preview-images ${pictures.length ? '' : 'no-shots'}">${pictures.length ? pictures.map(src => `<img src="${esc(src)}" alt="Скриншот ${esc(g.name)}" loading="lazy" referrerpolicy="no-referrer">`).join('') : `<div class="preview-cover">${artTag(g)}</div>`}</div><div class="preview-prices">${offers.map(o => `<div><span>${names[o.provider]}</span>${salePrice(o)}</div>`).join('')}</div>`;
}
function storeLists() {
  const states = listStores()
    .map(p => browseState.get(browseKey(storeList, p)))
    .filter(Boolean);
  const current = {
    loading: states.some(x => x.loading),
    error: states
      .map(x => x.error)
      .filter(Boolean)
      .join(' · '),
  };
  const note = states.map(x => x.note).filter(Boolean)[0] || '';
  const items = storePlatform(listItems()).slice(0, 9),
    selected = items.find(x => x.id === listPreviewId) || items[0];
  return `<section class="store-lists"><div class="store-list-tabs" role="tablist" aria-label="Списки игр">${Object.entries(
    storeListLabels
  )
    .map(
      ([key, label]) =>
        `<button role="tab" aria-selected="${storeList === key}" class="${storeList === key ? 'active' : ''}" data-store-list="${key}">${label}</button>`
    )
    .join(
      ''
    )}<span class="list-tabs-gap"></span><div class="list-store-switch" role="group" aria-label="Магазин списка">${[
    ['all', 'Все'],
    ['steam', 'Steam'],
    ['epic', 'Epic Games'],
  ]
    .map(
      ([key, label]) =>
        `<button class="${listStore === key ? 'active' : ''}" data-list-store="${key}" aria-pressed="${listStore === key}">${label}</button>`
    )
    .join(
      ''
    )}</div></div>${note ? `<p class="list-note">${esc(note)}</p>` : ''}<div class="store-list-body"><div class="store-list-rows">${
    items
      .map(g => {
        const o = priceOffers(g).find(x => x.provider === 'steam') || priceOffers(g)[0];
        return `<button class="store-list-row ${selected?.id === g.id ? 'selected' : ''}" data-detail="${esc(g.id)}" data-list-preview="${esc(g.id)}" data-price-game="${esc(g.id)}">${artTag(g)}<span class="list-row-copy"><strong>${esc(g.name)}</strong><small>${ownershipBadge(g) || (g.tags || []).slice(0, 4).map(esc).join(', ')}</small><em>${[
          o?.releaseDate
            ? 'Дата выхода: ' + esc(o.releaseDate)
            : g.released
              ? 'Дата выхода: ' +
                new Date(g.released).toLocaleDateString('ru-RU', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })
              : '',
          reviewLine(g, true),
          priceOffers(g)
            .map(x => names[x.provider])
            .join(' · '),
        ]
          .filter(Boolean)
          .join(' · ')}</em></span><span class="list-row-price">${salePrice(o)}</span></button>`;
      })
      .join('') ||
    `<div class="empty"><h2>${current?.loading ? 'Загружаем игры…' : 'Здесь пока нет предложений'}</h2><p>${esc(current?.error || 'Попробуйте другой раздел или регион каталога.')}</p></div>`
  }</div><div id="store-list-preview" class="store-list-preview" aria-live="polite">${selected ? previewContent(selected) : '<p>Наведите указатель на игру, чтобы увидеть её описание и скриншоты.</p>'}</div></div></section>`;
}
// Several connected accounts of one store: let the user choose the buyer.
function connectedAccounts(provider) {
  return (state.accountList || []).filter(a => a.provider === provider && a.status === 'connected');
}
function accountSelect(provider, id) {
  const list = connectedAccounts(provider);
  if (list.length < 2) return '';
  const chosen = state.accounts?.[provider]?.purchaseAccount;
  return `<label class="account-select">Аккаунт ${names[provider]} <select id="${id}">${list
    .map(a => `<option value="${esc(a.key)}" ${a.key === chosen ? 'selected' : ''}>${esc(a.name)}</option>`)
    .join('')}</select></label>`;
}
function dateRange(g) {
  const f = t => new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return `${f(g.start)} — ${f(g.end)}`;
}
function freeShelf() {
  const free = state.free;
  if (!free || (!free.current?.length && !free.upcoming?.length) || storeProvider === 'steam') return '';
  const tile = (g, now) =>
    `<article class="free-card ${now ? 'now' : 'soon'}"><div class="free-art">${safeImage(g.image) ? `<img src="${esc(safeImage(g.image))}" alt="${esc(g.name)}" loading="lazy" referrerpolicy="no-referrer">` : '<span class="cover-missing">Обложка недоступна</span>'}<span class="free-label">${now ? 'Бесплатно сейчас' : 'Скоро бесплатно'}</span></div><strong>${esc(g.name)}</strong><small>${esc(dateRange(g))}${g.originalPrice ? ' · обычно ' + esc(g.originalPrice) : ''}</small>${now && g.url ? `<button class="primary" data-claim="${esc(g.appId)}" ${demo ? 'disabled' : ''}>Забрать в Epic ↗</button>` : ''}</article>`;
  return `<div class="section-head"><h2>БЕСПЛАТНО В EPIC GAMES</h2><span>Раздачи недели · забирайте в официальном магазине</span>${accountSelect('epic', 'claim-account')}</div><div class="free-rail">${(free.current || []).map(g => tile(g, true)).join('')}${(free.upcoming || []).map(g => tile(g, false)).join('')}</div>`;
}
function dlcShelf() {
  const items = dlcState.get(state.settings.storeCountry || 'US')?.items || [];
  if (!items.length) return '';
  return `<div class="section-head"><h2>ДОПОЛНЕНИЯ ДЛЯ ВАШИХ ИГР</h2><span>Steam · для игр в библиотеке или на ПК</span></div><div class="dlc-rail">${items.map(card).join('')}</div>`;
}
async function requestDlc() {
  if (
    !api?.browseDlc ||
    demo ||
    !activeGames().some(g => g.offers?.some(o => o.provider === 'steam' && (o.owned || o.installed)))
  )
    return;
  const country = state.settings.storeCountry || 'US',
    old = dlcState.get(country);
  if (old && (old.loading || Date.now() - old.checkedAt < 600000)) return;
  dlcState.set(country, { loading: true, items: old?.items || [] });
  try {
    const result = await call('browseDlc', { country });
    dlcState.set(country, result);
  } catch (e) {
    dlcState.set(country, { items: [], error: e.message, checkedAt: Date.now() });
  }
  if (page === 'store' && country === (state.settings.storeCountry || 'US') && !query.trim()) render();
}
async function requestBrowse(kind) {
  if (kind === 'featured' || !api?.browseCatalog || demo) return;
  await Promise.all(listStores().map(p => requestBrowseFrom(kind, p)));
}
async function requestBrowseFrom(kind, provider) {
  const country = state.settings.storeCountry || 'US',
    key = browseKey(kind, provider, country),
    old = browseState.get(key);
  if (old && (old.loading || Date.now() - old.checkedAt < 180000)) return;
  browseState.set(key, { loading: true, items: old?.items || [] });
  render();
  try {
    const result = await call('browseCatalog', { kind, country, provider });
    browseState.set(key, { ...result, loading: false });
  } catch (e) {
    browseState.set(key, {
      items: old?.items || [],
      error: e.message,
      checkedAt: Date.now(),
      loading: false,
    });
  }
  if (storeList === kind && country === (state.settings.storeCountry || 'US') && page === 'store') render();
}
// ---- "Рекомендовано вам": games picked from the Steam and Epic libraries ----
function hasAccountGames() {
  return activeGames().some(g =>
    g.offers?.some(o => ['steam', 'epic'].includes(o.provider) && (o.owned || o.installed))
  );
}
async function requestRecommendations(force = false) {
  if (!api?.recommendations || demo || !hasAccountGames()) return;
  const country = state.settings.storeCountry || 'US',
    old = recState.get(country);
  if (!force && old && (old.loading || Date.now() - old.checkedAt < 600000)) return;
  recState.set(country, { ...old, loading: true });
  if (page === 'store' && !query.trim()) updateRecommendations();
  try {
    const result = await call('recommendations', { country, force });
    // checkedAt always set: it is what stops the next render from asking again.
    recState.set(country, { ...result, checkedAt: result?.checkedAt || Date.now(), loading: false });
  } catch (e) {
    recState.set(country, { ...old, loading: false, error: e.message, checkedAt: Date.now() });
  }
  if (page === 'store' && !query.trim()) {
    updateRecommendations();
    updateShowcase(true);
  }
}
function updateRecommendations() {
  const block = $('#recommendations');
  if (block) block.outerHTML = recommendationsShelf();
}
function reasonText(r) {
  if (!r) return 'Подходит под ваши любимые метки';
  const where = r.provider === 'epic' ? ' (Epic Games)' : r.provider === 'both' ? ' (Steam + Epic)' : '';
  return `Потому что вы играли в ${r.name}${where}${r.minutes >= 60 ? ' · ' + hours(r.minutes) : ''}`;
}
function recommendationsShelf() {
  if (demo || !api?.recommendations) return '';
  const country = state.settings.storeCountry || 'US',
    rec = recState.get(country);
  const head = (sub, button = true) =>
    `<div class="section-head"><h2>РЕКОМЕНДОВАНО НА ОСНОВЕ ИГР, В КОТОРЫЕ ВЫ ИГРАЕТЕ</h2><span class="home-status">${sub}${button ? '<button class="ghost" id="refresh-recs" title="Подобрать заново" aria-label="Подобрать заново">↻</button>' : ''}</span></div>`;
  if (!hasAccountGames())
    return `<section id="recommendations" class="rec-section">${head('Steam + Epic Games', false)}<div class="rec-empty"><p>Войдите в Steam или Epic Games — Nexus изучит игры обоих аккаунтов и время в них и подберёт похожие, как это делает Steam.</p><button class="secondary" data-page="accounts">Перейти к аккаунтам</button></div></section>`;
  if (!rec || (rec.loading && !rec.items?.length))
    return `<section id="recommendations" class="rec-section">${head('Подбираем…', false)}<div class="rec-empty"><p>Изучаем вашу библиотеку Steam и Epic Games…</p></div></section>`;
  const count = (n, store) => (n ? `${n} ${plural(n, 'игры', 'игр', 'игр')} ${store}` : '');
  const based = rec.basedOn
    ? 'На основе ' +
      [count(rec.basedOn.steam, 'Steam'), count(rec.basedOn.epic, 'Epic Games')].filter(Boolean).join(' и ')
    : 'Steam + Epic Games';
  // Live store data (prices) wins, but the reason and match belong to the recommendation.
  const items = storePlatform(
    (rec.items || []).map(g => {
      const live = game(g.id);
      return live
        ? {
            ...live,
            reason: g.reason,
            match: g.match,
            capsule: live.capsule || g.capsule,
            tags: g.tags?.length ? g.tags : live.tags,
            reviews: live.reviews || g.reviews,
          }
        : g;
    })
  );
  const profile = (rec.profile || []).slice(0, 6);
  if (!items.length)
    return `<section id="recommendations" class="rec-section">${head(esc(based))}<div class="rec-empty"><p>${esc(rec.error || 'Пока нечего предложить: в библиотеке мало игр с метками Steam или всё подходящее у вас уже есть.')}</p></div></section>`;
  return `<section id="recommendations" class="rec-section">${head(esc(based) + (rec.loading ? ' · обновляем…' : ''))}${
    profile.length
      ? `<div class="rec-profile"><span>Ваши любимые метки:</span>${profile.map(t => `<button class="rec-tag" data-store-tag="${esc(t.tag)}" title="${esc(t.share + '% вашего игрового профиля')}">${esc(t.tag)}</button>`).join('')}</div>`
      : ''
  }<div class="rec-rail">${items
    .map(g => {
      const o = priceOffers(g).find(x => x.provider === 'steam') || priceOffers(g)[0];
      const src = safeImage(g.capsule) || artwork(g);
      return `<article class="rec-card" data-price-game="${esc(g.id)}"><button class="heart ${has('wishlist', g.id) ? 'saved' : ''}" data-wish="${esc(g.id)}" aria-label="${has('wishlist', g.id) ? 'Убрать из' : 'Добавить в'} желаемое: ${esc(g.name)}">${has('wishlist', g.id) ? '♥' : '♡'}</button><button class="rec-open" data-detail="${esc(g.id)}">${src ? `<img src="${esc(src)}" data-fallback="${esc(artwork(g))}" alt="${esc(g.name)}" loading="lazy" referrerpolicy="no-referrer">` : '<span class="cover-missing">Обложка недоступна</span>'}<span class="rec-reason">${esc(reasonText(g.reason))}</span><span class="rec-body"><strong>${esc(g.name)}</strong><small>${(g.tags || []).slice(0, 3).map(esc).join(' · ')}</small><span class="rec-meta">${reviewLine(g, true)}${g.match ? `<em>Совпадение ${g.match}%</em>` : ''}</span><span class="rec-price">${salePrice(o)}</span></span></button></article>`;
    })
    .join('')}</div></section>`;
}
function store() {
  const searching = !!query.trim();
  const pool = searching ? [] : allStoreGames();
  // Without a search the catalogue lists every loaded game, filtered by the chosen category.
  const source = searching
    ? searchState.items
    : storeTag
      ? pool.filter(g => g.tags?.includes(storeTag))
      : pool;
  const items = filterPrices(storePlatform(source.map(g => game(g.id) || g)));
  const errors = searching
    ? Object.values(searchState.providers || {})
        .filter(p => !p.ok)
        .map(p => p.error)
    : [];
  const home = homeState.get(state.settings.storeCountry || 'US');
  const discounted = storePlatform([
    ...new Map([...(home?.promotions || []), ...storePool()].map(g => [g.id, game(g.id) || g])).values(),
  ]).filter(g => priceOffers(g).some(o => o.discount > 0));
  // Only failures are worth a line; successful counts were technical noise.
  const failed = Object.entries(home?.providers || {}).filter(([, v]) => !v.ok);
  return `${notice()}<div class="store-subnav"><div class="store-platforms">${[
    ['all', 'Все магазины'],
    ['steam', 'Steam'],
    ['epic', 'Epic Games'],
  ]
    .map(
      ([p, n]) =>
        `<button class="${storeProvider === p ? 'active' : ''}" data-store-platform="${p}">${n}</button>`
    )
    .join('')}<button data-page="wishlist">★ Желаемое</button></div>${regionControl()}</div>
 ${
   !searching
     ? (showcase() ||
         (home?.loading ? '<div class="store-loading">Загружаем подборки Steam и Epic Games…</div>' : '')) +
       recommendationsShelf()
     : `<div class="section-head"><h2>Результаты поиска · «${esc(query)}»</h2><button class="ghost" id="retry-search">↻ Обновить</button></div><div class="search-status">${searchState.loading ? 'Загрузка…' : items.length + ' карточек'} · ${Object.entries(
         searchState.providers || {}
       )
         .filter(([, p]) => p.ok)
         .map(([p, r]) => names[p] + ': ' + r.total)
         .join(' · ')}</div>`
 }
 ${!searching && home?.error ? `<div class="notice warning">${esc(home.error)}</div>` : ''}${
   !searching && failed.length
     ? `<div class="notice warning">${failed.map(([, v]) => esc(v.error)).join(' · ')}. Показаны предложения доступного магазина.</div>`
     : ''
 }
 ${errors.length ? `<div class="notice warning">${errors.map(esc).join(' · ')}. Результаты доступного магазина показаны ниже.</div>` : ''}${searchState.error && searching ? `<div class="notice warning">${esc(searchState.error)}</div>` : ''}
 ${!searching && discounted.length ? `<div class="section-head"><h2>СКИДКИ И ПРЕДЛОЖЕНИЯ</h2><button class="ghost" id="show-sales">Все скидки</button></div><div class="sale-rail">${discounted.map(card).join('')}</div>` : ''}
 ${!searching ? freeShelf() + dlcShelf() + categoryTiles(pool) + storeLists() + cheapShelf(pool) : ''}
 ${!searching ? `<div class="section-head" id="store-catalog"><h2>${storeTag ? 'МЕТКА: ' + esc(storeTag.toUpperCase()) : 'ВСЕ ИГРЫ НА ВИТРИНЕ'}</h2>${storeTag ? '<button class="ghost" data-store-tag-clear>✕ Сбросить метку</button>' : `<small>${items.length} ${plural(items.length, 'игра', 'игры', 'игр')} · Steam выбирается первым</small>`}</div>` : ''}
 ${priceControls()}<div class="grid">${items.map(card).join('')}</div>
 ${!items.length && !searchState.loading && !(home?.loading && !searching) ? '<div class="empty"><h2>Нет подходящих игр</h2><p>Измените поиск, диапазон цены или выбранный магазин. Если подборки недоступны, нажмите «Обновить витрину».</p></div>' : ''}
 ${searching && Object.values(searchState.providers || {}).some(p => p.ok && p.total > (searchState.start || 0) + 24) ? `<div class="load-more"><button class="secondary" id="more-results" ${searchState.loading ? 'disabled' : ''}>Показать ещё</button></div>` : ''}
 <p class="footnote">Цены относятся к выбранному региону. Поиск, сравнение и карточки остаются в Nexus; покупку подтверждает официальный магазин.</p>`;
}
function libraryMode() {
  return state.settings.libraryView || 'installed';
}
function libraryGames() {
  return activeGames().filter(g =>
    libraryMode() === 'owned'
      ? g.offers?.some(o => o.owned === true || o.installed === true)
      : g.progress || g.offers?.some(o => o.installed === true)
  );
}
function hiddenCount() {
  return libraryGames().filter(g => g.hidden).length;
}
function filteredLibrary() {
  let list = libraryGames();
  if (!showHidden) list = list.filter(g => !g.hidden);
  if (collectionFilter) {
    const c = (state.settings.collections || []).find(x => x.id === collectionFilter);
    list = c ? list.filter(g => c.games.includes(g.id)) : list;
  }
  if (filter !== 'all')
    list = list.filter(g =>
      g.offers?.some(
        o =>
          o.provider === filter &&
          (libraryMode() === 'owned' ? o.owned === true || o.installed === true : o.installed)
      )
    );
  if (query) list = list.filter(g => g.name.toLowerCase().includes(query.toLowerCase()));
  if (librarySort === 'recent')
    list = [...list].sort((a, b) => lastPlayedAt(b) - lastPlayedAt(a) || a.name.localeCompare(b.name));
  if (librarySort === 'playtime')
    list = [...list].sort((a, b) => (b.playtime || 0) - (a.playtime || 0) || a.name.localeCompare(b.name));
  return list;
}
// Latest of: launch through Nexus, Steam/Epic "last played" (seconds).
function lastPlayedAt(g) {
  const nexus = state.settings.recent?.find(r => r.id === g.id)?.time || 0;
  return Math.max(nexus, (g.lastPlayed || 0) * 1000);
}
function hours(minutes) {
  return (Number(minutes) / 60).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ч.';
}
function portrait(g) {
  const src =
    safeImage(g.portrait) ||
    (g.steam
      ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.steam}/library_600x900.jpg`
      : artwork(g));
  // Local Steam cover → Steam CDN vertical cover → horizontal header.
  const cdn =
    safeImage(g.portraitCdn) ||
    (g.steam
      ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.steam}/library_600x900.jpg`
      : '');
  const fallback = src.startsWith('nexus-art:') && cdn ? cdn : artwork(g);
  return src
    ? `<img src="${esc(src)}" data-fallback="${esc(fallback)}" data-fallback2="${esc(artwork(g))}" alt="${esc(g.name)}" loading="lazy">`
    : '<span class="cover-missing">' + esc(g.name) + '</span>';
}
function libraryCard(g) {
  g = game(g.id) || g;
  const platforms = [
    ...new Set(
      g.offers.filter(o => (libraryMode() === 'owned' ? o.owned : o.installed)).map(o => o.provider)
    ),
  ];
  return `<article class="library-card" data-price-game="${esc(g.id)}" data-library-preview="${esc(g.id)}"><button data-detail="${esc(g.id)}" class="portrait-open">${portrait(g)}<span class="portrait-title">${esc(g.name)}</span><span class="portrait-platforms">${platforms.map(p => `<span class="pill ${p === 'steam' ? 'blue' : ''}">${names[p]}</span>`).join('')}</span>${g.offers.some(o => o.installed) ? '<span class="installed-mark">✓</span>' : ''}${g.hidden ? '<span class="hidden-mark">скрыта</span>' : ''}${g.progress && Number.isFinite(g.progress.percent) ? `<span class="card-progress"><i style="width:${g.progress.percent}%"></i></span>` : ''}</button><div class="library-card-price">${salePrice(g.storeOffers?.find(o => o.provider === 'steam') || g.storeOffers?.[0])}</div></article>`;
}
function accountLibraryLine(a) {
  const x = a.library || {},
    source = x.source === 'legendary' ? ' · импорт Legendary' : x.source === 'api' ? ' · Web API' : '';
  const text =
    x.status === 'loading'
      ? `Проверяем библиотеку…${x.count ? ' Сохранено ' + x.count + ' игр' + source : ''}`
      : x.status === 'ready'
        ? x.count +
          ' игр' +
          source +
          (x.metadataLoading ? ' · уточняем названия…' : '') +
          ' · ' +
          new Date(x.checkedAt).toLocaleString('ru-RU')
        : x.status === 'error'
          ? esc(x.message) + (x.count ? ' · сохранено ' + x.count + ' игр' + source : '')
          : a.status === 'connected'
            ? 'Ожидает синхронизации'
            : 'Войдите в аккаунт';
  return `<div><b>${names[a.provider]} · ${esc(a.name || 'аккаунт')}</b><span>${text}</span></div>`;
}
function libraryStatus() {
  if (libraryMode() !== 'owned') return '';
  const list = (state.accountList ? state.libraryAccounts || [] : []).filter(a => a.status === 'connected');
  if (list.length)
    return `<div class="collection-sync">${list.map(accountLibraryLine).join('')}</div>${state.libraryState?.epic?.status === 'error' ? `<div class="epic-import-hint">Epic не отдал библиотеку. Можно повторить вход или импортировать список <code>legendary list --json &gt; epic-games.json</code>: <button class="secondary" id="import-legendary">Импортировать JSON Legendary</button></div>` : ''}${suggestionsPanel()}`;
  return `<div class="collection-sync">${['steam', 'epic']
    .map(p => {
      const x = state.libraryState?.[p] || {},
        a = state.accounts[p],
        source = x.source === 'legendary' ? ' · импорт Legendary' : '';
      return `<div><b>${names[p]}</b><span>${x.status === 'loading' ? `Проверяем библиотеку…${x.count ? ' Сохранено ' + x.count + ' игр' + source : ''}` : x.status === 'ready' ? x.count + ' игр' + source + ' · ' + new Date(x.checkedAt).toLocaleString('ru-RU') : x.status === 'error' ? esc(x.message) + (x.count ? ' · сохранено ' + x.count + ' игр' + source : '') : a?.status === 'connected' ? 'Ожидает синхронизации' : 'Войдите в аккаунт'}</span></div>`;
    })
    .join(
      ''
    )}</div>${state.accounts.epic?.status === 'connected' && state.libraryState?.epic?.status === 'error' ? `<div class="epic-import-hint">Epic не открыл библиотеку через сайт. Экспортируйте список командой <code>legendary list --json &gt; epic-games.json</code>, затем <button class="secondary" id="import-legendary">Импортировать JSON Legendary</button>. Файл должен быть от аккаунта ${esc(state.accounts.epic.name)}.</div>` : ''}`;
}
function suggestionsPanel() {
  const list = state.suggestions || [];
  if (!list.length || demo) return '';
  return `<details class="merge-suggestions" ${suggestionsOpen ? 'open' : ''}><summary>Возможно, одна и та же игра в двух магазинах (${list.length})</summary>${list
    .slice(0, 10)
    .map(
      x =>
        `<div class="merge-row"><span><b>Steam:</b> ${esc(x.aName)}</span><span><b>Epic:</b> ${esc(x.bName)}</span><small>совпадение ${Math.round(x.score * 100)}%</small><button class="secondary" data-link-a="${esc(x.a)}" data-link-b="${esc(x.b)}">Объединить</button></div>`
    )
    .join(
      ''
    )}<p class="hint">Объединение влияет только на отображение в Nexus. Разделить игру можно на её странице.</p></details>`;
}
function collectionName() {
  return (state.settings.collections || []).find(c => c.id === collectionFilter)?.name || '';
}
function libraryTools() {
  const hidden = hiddenCount();
  const parts = [];
  if (collectionFilter)
    parts.push(
      `<button class="ghost" data-collection="">← Все игры</button>${demo ? '' : `<button class="ghost" data-delete-collection="${esc(collectionFilter)}">Удалить коллекцию</button>`}`
    );
  if (hidden)
    parts.push(
      `<label class="check"><input type="checkbox" id="show-hidden" ${showHidden ? 'checked' : ''}> Показать скрытые (${hidden})</label>`
    );
  return parts.length ? `<div class="library-tools">${parts.join('')}</div>` : '';
}
function sortControl() {
  return `<label class="library-sort">Порядок <select id="library-sort"><option value="name" ${librarySort === 'name' ? 'selected' : ''}>По названию</option><option value="recent" ${librarySort === 'recent' ? 'selected' : ''}>Недавно запущенные</option><option value="playtime" ${librarySort === 'playtime' ? 'selected' : ''}>Больше всего времени</option></select></label>`;
}
function epicImportPanel() {
  return `<section class="settings-card epic-import-panel"><h3>Запасной импорт Epic · Legendary</h3><p>Нужен только если Epic не отдаёт библиотеку после входа. После входа в Legendary выполните <code>legendary list --json &gt; epic-games.json</code> в CMD и выберите полученный файл. Дополнения и Unreal-ассеты не смешиваются с играми. Перед импортом Nexus спросит, какому из подключённых аккаунтов Epic принадлежит файл.</p><button class="secondary" id="import-legendary" ${state.accounts.epic?.status === 'connected' ? '' : 'disabled'}>Импортировать JSON Legendary</button><p class="hint">Nexus читает только названия и идентификаторы игр, не переносит пароли или сеанс Legendary. Импортированный список остаётся доступным при повторном входе в тот же аккаунт.</p></section>`;
}
function library() {
  let list = filteredLibrary();
  if (page === 'favorites') list = list.filter(g => has('favorites', g.id));
  if (page === 'recent') list = state.settings.recent.map(r => list.find(g => g.id === r.id)).filter(Boolean);
  if (page === 'wishlist') {
    const wished = state.catalog.filter(g => has('wishlist', g.id)).map(g => game(g.id) || g);
    return `${notice()}<div class="section-head"><h1>Желаемое</h1><span>${wished.length} игр</span></div><div class="grid">${wished
      .filter(g => !query || g.name.toLowerCase().includes(query.toLowerCase()))
      .map(card)
      .join(
        ''
      )}</div>${!wished.length ? '<div class="empty"><h2>Сохраняйте игры из магазина</h2><p>Нажмите сердечко на карточке, чтобы добавить игру в желаемое.</p></div>' : ''}`;
  }
  const recent = state.settings.recent
      .map(r => list.find(g => g.id === r.id))
      .filter(Boolean)
      .slice(0, 8),
    quick = list.slice(0, 5);
  return `${notice()}<div class="library-heading"><h1>${page === 'favorites' ? 'Избранное' : page === 'recent' ? 'Недавние игры' : collectionName() || 'Библиотека'}</h1><div class="library-view" role="group" aria-label="Состав библиотеки"><button data-library-view="installed" class="${libraryMode() === 'installed' ? 'active' : ''}">↓ Скачанные</button><button data-library-view="owned" class="${libraryMode() === 'owned' ? 'active' : ''}">▦ Имеющиеся</button></div><button class="ghost" id="sync-libraries">↻ Обновить аккаунты</button></div>${libraryTools()}<div id="library-status">${libraryStatus()}</div>
 ${quick.length && page === 'library' ? `<section class="library-quick"><div class="shelf-title"><h2>Быстрый доступ</h2><span>Steam + Epic Games</span></div><div class="quick-rail">${quick.map(g => `<button data-detail="${esc(g.id)}"><div>${artTag(g)}</div><strong>${esc(g.name)}</strong><small>${g.offers.some(o => o.installed) ? 'Готова к запуску' : 'В аккаунте · можно установить'}</small></button>`).join('')}</div></section>` : ''}
 ${recent.length && page === 'library' ? `<div class="shelf-title"><h2>Недавние игры</h2><span>Запускались через Nexus</span></div><div class="recent-shelf">${recent.map(libraryCard).join('')}</div>` : ''}
 <div class="shelf-title"><h2>${libraryMode() === 'installed' ? 'Скачанные игры' : 'Игры на аккаунтах'} <span>(${list.length})</span></h2><div class="library-platforms">${[
   ['all', 'Все'],
   ['steam', 'Steam'],
   ['epic', 'Epic Games'],
 ]
   .map(([p, n]) => `<button class="${filter === p ? 'active' : ''}" data-list-filter="${p}">${n}</button>`)
   .join('')}${sortControl()}</div></div>
 ${list.length ? `<div class="library-grid">${list.slice(0, libraryLimit).map(libraryCard).join('')}</div>${list.length > libraryLimit ? `<div class="load-more" id="library-more-sentinel"><button class="secondary" id="library-more">Показать ещё (${list.length - libraryLimit})</button></div>` : ''}` : `<div class="empty"><h2>${libraryMode() === 'owned' ? 'Библиотека аккаунтов пока пуста' : 'Скачанные игры не найдены'}</h2><p>${libraryMode() === 'owned' ? 'После синхронизации здесь появятся приобретённые игры, включая неустановленные. Статус каждого аккаунта показан выше.' : 'Обновите список игр на ПК или добавьте исполняемый файл.'}</p><button class="primary" ${libraryMode() === 'owned' ? 'id="sync-libraries"' : 'id="empty-scan"'}>${libraryMode() === 'owned' ? '↻ Повторить синхронизацию' : 'Найти игры на компьютере'}</button></div>`}
 <p class="footnote">${libraryMode() === 'owned' ? '«Имеющиеся» — подтверждённая или сохранённая библиотека подключённого аккаунта. Список может быть недоступен из-за настроек приватности или ограничений сервиса.' : '«Скачанные» — игры на этом компьютере. Право запуска проверяет официальный клиент.'}</p>`;
}
function selectedLibraryOffer(g) {
  const offers = g?.offers || [];
  return (
    offers.find(o => o.provider === libraryProvider) ||
    offers.find(o => o.provider === state.settings.preferred[g.id]) ||
    offers.find(o => o.provider === 'steam' && o.installed) ||
    offers.find(o => o.installed) ||
    offers.find(o => o.provider === 'steam') ||
    offers[0]
  );
}
// ---- downloads (Steam and Epic Games), like the downloads page of Steam ----
const PROGRESS_LABELS = {
  downloading: 'Загрузка',
  installing: 'Установка',
  updating: 'Обновление',
  paused: 'Пауза',
  uninstalling: 'Удаление',
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
      ? '<button class="secondary" data-download-action="repair" title="Проверить файлы и докачать повреждённые">Проверить</button>'
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
    }${o.thirdParty ? '<p class="notice warning">Эта игра работает через лаунчер издателя (EA, Ubisoft и т. п.): для игры понадобится он.</p>' : ''}${enough ? '' : '<p class="watch-error">На этом диске может не хватить места.</p>'}<div class="install-buttons"><button class="primary" data-install-start ${x.busy ? 'disabled' : ''}>↓ Установить</button><button class="secondary" data-install-client>Через Epic Games Launcher</button><button class="secondary" data-install-cancel>Отмена</button></div>`;
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
document.addEventListener('click', event =>
  run(async () => {
    const el = event.target.closest('button');
    if (!el || el.disabled) return;
    if (el.dataset.unwatch) {
      state = await call('removeWatch', el.dataset.unwatch);
      render();
      return;
    }
    if (el.dataset.page) return setPage(el.dataset.page);
    if (el.dataset.filter) {
      page = 'library';
      filter = el.dataset.filter;
      render();
      return;
    }
    if (el.dataset.libraryView) {
      state = api
        ? await call('libraryView', el.dataset.libraryView)
        : { ...state, settings: { ...state.settings, libraryView: el.dataset.libraryView } };
      filter = 'all';
      render();
      if (
        el.dataset.libraryView === 'owned' &&
        api &&
        ['steam', 'epic'].some(
          p =>
            state.accounts[p]?.status === 'connected' &&
            !['loading', 'ready'].includes(state.libraryState?.[p]?.status)
        )
      )
        call('syncLibraries')
          .then(next => {
            state = next;
            render();
          })
          .catch(e => toast(e.message));
      return;
    }
    if (el.dataset.friend) {
      await call('openProfile', { provider: 'steam', id: el.dataset.friend });
      return;
    }
    if (el.dataset.installCancel !== undefined) {
      installDlg = null;
      renderInstallDialog();
      return;
    }
    if (el.dataset.installRoot !== undefined && installDlg?.opts) {
      const r = await call('chooseInstallRoot', installDlg.root);
      if (r) Object.assign(installDlg, r);
      renderInstallDialog();
      return;
    }
    if (el.dataset.installClient !== undefined && installDlg) {
      const gid = installDlg.id;
      installDlg = null;
      renderInstallDialog();
      const r = await call('clientAction', { id: gid, provider: 'epic', action: 'install' });
      state = r.state;
      render();
      toast(
        r.result.viaLibrary
          ? 'Открыта библиотека Epic Games: выберите игру там.'
          : 'Установка передана Epic Games Launcher.'
      );
      return;
    }
    if (el.dataset.installStart !== undefined && installDlg?.opts) {
      const x = installDlg;
      x.busy = true;
      renderInstallDialog();
      try {
        const r = await call('startInstall', {
          id: x.id,
          root: x.root,
          tags: x.opts.components.length ? [...x.tags] : null,
          dlcs: [...x.dlcs],
        });
        state = r.state;
        installDlg = null;
        renderInstallDialog();
        render();
        toast('Загрузка началась — прогресс на странице «Загрузки».');
      } catch (e) {
        x.busy = false;
        x.error = '';
        renderInstallDialog();
        throw e;
      }
      return;
    }
    if (el.dataset.dlcInstall) {
      el.disabled = true;
      const r = await call('installDlc', { id: librarySelection, appId: el.dataset.dlcInstall });
      state = r.state;
      ownedDlcState.delete(librarySelection);
      render();
      toast('Дополнение добавлено в загрузки.');
      return;
    }
    if (el.dataset.downloadAction) {
      el.disabled = true;
      const action = el.dataset.downloadAction;
      const r = await call('downloadControl', { id: el.dataset.downloadId || librarySelection, action });
      state = r.state;
      render();
      if (action === 'update' || action === 'repair')
        toast(
          action === 'update'
            ? 'Обновление началось — прогресс на странице «Загрузки».'
            : 'Проверяем файлы игры…'
        );
      return;
    }
    if (el.dataset.clientDownloads) {
      await call('openClientDownloads', el.dataset.clientDownloads);
      return;
    }
    if (el.dataset.listStore) {
      listStore = el.dataset.listStore;
      listPreviewId = null;
      render();
      requestBrowse(storeList);
      return;
    }
    if (el.dataset.storeList) {
      storeList = el.dataset.storeList;
      listPreviewId = null;
      render();
      requestBrowse(storeList);
      document.querySelector('.store-lists')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (el.hasAttribute('data-library-back')) {
      librarySelection = null;
      render();
      return;
    }
    if (el.dataset.libraryProvider) {
      libraryProvider = el.dataset.libraryProvider;
      if (api && !demo) state = await call('preferred', { id: librarySelection, provider: libraryProvider });
      else state.settings.preferred[librarySelection] = libraryProvider;
      render();
      return;
    }
    if (el.dataset.storePlatform) {
      storeProvider = el.dataset.storePlatform;
      featuredIndex = 0;
      render();
      return;
    }
    if (el.dataset.featureStep) {
      const count = Math.max(1, featuredItems().length);
      featuredIndex = (featuredIndex + Number(el.dataset.featureStep) + count) % count;
      updateShowcase();
      return;
    }
    if (el.dataset.featureIndex !== undefined) {
      featuredIndex = Number(el.dataset.featureIndex);
      updateShowcase();
      return;
    }
    if (el.dataset.storeTag !== undefined) {
      storeTag = storeTag === el.dataset.storeTag ? null : el.dataset.storeTag;
      render();
      $('#store-catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (el.dataset.storeTagClear !== undefined) {
      storeTag = null;
      render();
      return;
    }
    if (el.dataset.listFilter) {
      filter = el.dataset.listFilter;
      libraryLimit = LIBRARY_PAGE;
      render();
      return;
    }
    if (el.dataset.detail) return showDetail(el.dataset.detail);
    if (el.dataset.wish) return toggle('wishlist', el.dataset.wish);
    if (el.dataset.login || el.dataset.loginAdd) {
      const provider = el.dataset.login || el.dataset.loginAdd;
      await call('login', { provider, add: !!el.dataset.loginAdd });
      toast('Вход выполняется на официальной странице магазина.');
      return;
    }
    if (el.dataset.claim) {
      const r = await call('claimFree', {
        appId: el.dataset.claim,
        account: $('#claim-account')?.value || undefined,
      });
      toast(
        `Открыта страница раздачи в Epic Games${r?.account ? ' · аккаунт ' + r.account : ''}. Нажмите «Получить» и подтвердите заказ.`
      );
      return;
    }
    if (el.dataset.collection !== undefined) {
      collectionFilter = el.dataset.collection || null;
      page = 'library';
      librarySelection = null;
      libraryLimit = LIBRARY_PAGE;
      render();
      return;
    }
    if (el.dataset.deleteCollection) {
      state = await call('deleteCollection', el.dataset.deleteCollection);
      collectionFilter = null;
      render();
      toast('Коллекция удалена. Игры остались в библиотеке.');
      return;
    }
    if (el.dataset.uninstall) {
      el.disabled = true;
      const r = await call('uninstallGame', { id: librarySelection, provider: el.dataset.uninstall });
      state = r.state;
      render();
      const res = r.result;
      if (res.how === 'started') toast('Удаление началось — прогресс на странице «Загрузки».');
      else if (res.how === 'client')
        toast(
          res.result?.how === 'canceled'
            ? 'Действие отменено.'
            : res.result?.viaLibrary
              ? 'Открыта библиотека Epic Games: удалите игру там.'
              : 'Запрос на удаление передан клиенту — подтвердите его там.'
        );
      return;
    }
    if (el.dataset.clientAction) {
      const g = activeGames().find(x => x.id === librarySelection);
      const provider = selectedLibraryOffer(g)?.provider;
      const r = await call('clientAction', {
        id: librarySelection,
        provider,
        action: el.dataset.clientAction,
      });
      state = r.state;
      render();
      toast(
        r.result.how === 'client-install'
          ? 'Устанавливаем лаунчер. После входа в аккаунт игра откроется в нём.'
          : r.result.how === 'canceled'
            ? 'Действие отменено.'
            : r.result.viaLibrary
              ? 'Открыта библиотека Epic Games: выберите игру там.'
              : {
                  verify: 'Проверка файлов запущена в клиенте.',
                  uninstall: 'Запрос на удаление передан клиенту — подтвердите его там.',
                  install: 'Установка передана клиенту.',
                }[el.dataset.clientAction]
      );
      return;
    }
    if (el.dataset.fullHistory) {
      const list = await call('watchHistory', el.dataset.fullHistory);
      const box = el.closest('details')?.querySelector('ul');
      if (box)
        box.innerHTML = list
          .slice()
          .reverse()
          .map(h => `<li>${new Date(h.at).toLocaleString('ru-RU')} · ${esc(money(h))}</li>`)
          .join('');
      el.remove();
      return;
    }
    if (el.dataset.linkA) {
      state = await call('linkGames', { a: el.dataset.linkA, b: el.dataset.linkB });
      render();
      toast('Игры объединены');
      return;
    }
    if (el.dataset.split) {
      state = await call('splitGame', el.dataset.split);
      librarySelection = null;
      render();
      toast('Игра разделена по магазинам');
      return;
    }
    if (el.dataset.saveKey || el.dataset.clearKey) {
      const name = el.dataset.saveKey || el.dataset.clearKey;
      const input = document.querySelector(`[data-key-input="${name}"]`);
      const value = el.dataset.clearKey ? '' : input?.value.trim() || '';
      if (el.dataset.saveKey && !value) throw Error('Введите ключ');
      state = await call('setKey', { name, value });
      render();
      toast(value ? 'Ключ сохранён' : 'Ключ удалён');
      return;
    }
    if (el.dataset.browser) {
      await call('browser', el.dataset.browser);
      toast(
        el.dataset.browser === 'epic'
          ? 'Войдите в браузере, затем скопируйте authorizationCode со страницы и вставьте его в поле «Код из браузера».'
          : 'Открыт системный браузер. Его сессия хранится отдельно от Nexus.'
      );
      return;
    }
    if (el.dataset.forget) {
      state = await call('forget', el.dataset.forget);
      render();
      toast('Сессия Nexus удалена. Официальный клиент остаётся в своём аккаунте.');
      return;
    }
    if (el.dataset.buy) return buy(el.dataset.buy);

    if (el.classList.contains('close')) {
      $('#details').close();
      detailId = null;
      return;
    }
    switch (el.id) {
      case 'library-store': {
        const id = librarySelection;
        await setPage('store');
        showDetail(id);
        break;
      }
      case 'library-play':
        {
          const lg = activeGames().find(g => g.id === librarySelection);
          if (wantsInstallWindow(lg, selectedLibraryOffer(lg)?.provider))
            return openInstallDialog(librarySelection);
        }
        el.disabled = true;
        try {
          const r = await call('play', {
            id: librarySelection,
            provider: selectedLibraryOffer(activeGames().find(g => g.id === librarySelection))?.provider,
          });
          state = r.state || r;
          toast(playToast(r.result));
        } finally {
          render();
        }
        break;
      case 'epic-sync': {
        el.disabled = true;
        try {
          const r = await call('epicSyncSaves', librarySelection);
          state = r.state;
          toast(
            r.result?.supported
              ? 'Сохранения синхронизированы с облаком Epic.'
              : 'Эта игра не использует облачные сохранения Epic.'
          );
        } finally {
          el.disabled = false;
        }
        break;
      }
      case 'library-hide': {
        const g = activeGames().find(x => x.id === librarySelection);
        state = await call('setHidden', { id: librarySelection, hidden: !g?.hidden });
        toast(
          g?.hidden
            ? 'Игра снова видна в библиотеке'
            : 'Игра скрыта. Её можно показать флажком «Показать скрытые».'
        );
        if (!g?.hidden && !showHidden) librarySelection = null;
        render();
        break;
      }
      case 'import-collections': {
        el.disabled = true;
        try {
          const r = await call('importSteamCollections');
          state = r.state;
          render();
          toast(
            `Коллекций: ${r.report.collections}, скрытых: +${r.report.hidden}, избранных: +${r.report.favorites}${r.report.errors.length ? '. ' + r.report.errors.join('; ') : ''}`
          );
        } finally {
          el.disabled = false;
        }
        break;
      }
      case 'export-backup': {
        const r = await call('exportBackup');
        if (r) toast('Резервная копия сохранена: ' + r.file);
        break;
      }
      case 'import-backup': {
        const r = await call('importBackup');
        if (r?.result) {
          state = r.state;
          render();
          toast('Настройки восстановлены');
        }
        break;
      }
      case 'save-diagnostics': {
        const r = await call('saveDiagnostics');
        if (r) toast('Диагностика сохранена: ' + r.file + '. Токены и ключи в ней скрыты.');
        break;
      }
      case 'open-logs':
        await call('openLogs');
        break;
      case 'library-favorite':
        await toggle('favorites', librarySelection);
        break;
      case 'library-wish':
        await toggle('wishlist', librarySelection);
        break;
      case 'sync-libraries':
        el.disabled = true;
        try {
          state = await call('syncLibraries');
          render();
        } finally {
          el.disabled = false;
        }
        break;
      case 'import-legendary':
        el.disabled = true;
        try {
          state = await call('importLegendary');
          render();
          toast('Список Epic импортирован для подключённого аккаунта.');
        } finally {
          el.disabled = false;
        }
        break;
      case 'library-more':
        libraryLimit += LIBRARY_PAGE;
        render();
        break;
      case 'import-wishlists': {
        el.disabled = true;
        try {
          const r = await call('importWishlists');
          state = r.state;
          render();
          toast(
            `Добавлено в желаемое: Steam ${r.report.steam}, Epic ${r.report.epic}${r.report.errors.length ? '. ' + r.report.errors.join('; ') : ''}`
          );
        } finally {
          el.disabled = false;
        }
        break;
      }
      case 'check-update':
        state = await call('checkUpdate');
        render();
        break;
      case 'install-update':
        await call('installUpdate');
        break;
      case 'show-sales':
        priceFilter.sale = true;
        render();
        document.querySelector('.price-controls')?.scrollIntoView({ behavior: 'smooth' });
        break;
      case 'refresh-home':
        await requestHome(true);
        break;
      case 'refresh-detail-price':
        el.disabled = true;
        await refreshDetailPrice(true);
        break;
      case 'watch-price':
        state = await call('watchPrice', { id: detailId, provider: selectedProvider });
        toast('Отслеживание включено. Цены будут проверяться каждый час, пока Nexus открыт.');
        break;
      case 'open-tracking':
        $('#details').close();
        detailId = null;
        await setPage('tracking');
        break;
      case 'check-prices':
        el.disabled = true;
        el.textContent = 'Проверяем…';
        try {
          state = await call('checkPrices');
          render();
        } finally {
          el.disabled = false;
        }
        break;
      case 'retry-search':
        await searchCatalog();
        break;
      case 'more-results':
        await searchCatalog(true);
        break;
      case 'refresh-accounts':
        el.disabled = true;
        try {
          state = await call('refreshAccounts');
          render();
        } finally {
          el.disabled = false;
        }
        break;
      case 'refresh-recs':
        return requestRecommendations(true);
      case 'library-stop':
      case 'detail-stop': {
        el.disabled = true;
        el.textContent = 'Закрываем…';
        const id = el.id === 'library-stop' ? librarySelection : detailId;
        const r = await call('closeGame', id);
        state = r.state || state;
        if (r.result === 'kept') toast('Игра продолжает работать.');
        render();
        if ($('#details').open) renderDetail();
        return;
      }
      case 'friends-toggle':
        return call('openFriendsWindow');
      case 'check-game-updates': {
        el.disabled = true;
        const r = await call('checkUpdates');
        state = r.state;
        render();
        const n = Object.keys(r.result || {}).length;
        toast(
          n
            ? `Обновления есть у ${n} ${plural(n, 'игры', 'игр', 'игр')}`
            : 'Все установленные игры Epic обновлены'
        );
        return;
      }
      case 'nav-back':
      case 'nav-forward':
        return goHistory(el.id === 'nav-back' ? -1 : 1);
      case 'scan':
      case 'empty-scan':
        el.disabled = true;
        try {
          state = await call('scan');
          demo = false;
          render();
          toast(`Найдено игр: ${state.games.length}`);
        } finally {
          el.disabled = false;
        }
        break;
      case 'add-game':
      case 'footer-add':
        state = await call('add');
        demo = false;
        page = 'library';
        render();
        break;
      case 'demo':
        demo = true;
        page = 'library';
        filter = 'all';
        query = '';
        $('#search').value = '';
        render();
        break;
      case 'exit-demo':
        demo = false;
        if (api) state = await call('state');
        render();
        break;
      case 'steam-root':
        state = await call('steamRoot');
        render();
        break;
      case 'buy-selected':
        await buy(selectedProvider);
        break;
      case 'detail-wish':
        await toggle('wishlist', detailId);
        renderDetail();
        break;
      case 'favorite':
        await toggle('favorites', detailId);
        renderDetail();
        break;
      case 'play':
        if (wantsInstallWindow(game(detailId), selectedProvider)) {
          $('#details').close();
          return openInstallDialog(detailId);
        }
        el.disabled = true;
        try {
          const r = await call('play', { id: detailId, provider: selectedProvider });
          state = r.state || r;
          render();
          toast(playToast(r.result));
        } finally {
          renderDetail();
        }
        break;
    }
  })
);
document.addEventListener('change', event =>
  run(async () => {
    const el = event.target;
    if (el.dataset.target) {
      const value = el.value.trim();
      if (!el.checkValidity()) throw Error('Введите неотрицательную цену');
      state = await call('priceTarget', {
        key: el.dataset.target,
        target: value === '' ? null : Number(value),
      });
      toast('Желаемая цена сохранена');
      return;
    }
    if (['price-min', 'price-max', 'sale-only', 'price-sort'].includes(el.id)) {
      if (!el.checkValidity()) return;
      if (el.id === 'price-min') priceFilter.min = el.value;
      if (el.id === 'price-max') priceFilter.max = el.value;
      if (el.id === 'sale-only') priceFilter.sale = el.checked;
      if (el.id === 'price-sort') priceFilter.sort = el.value;
      render();
      return;
    }
    if (el.id === 'store-currency') {
      detailPrices.clear();
      const c = currencyCountries[el.value];
      state = api ? await call('country', c) : { ...state, settings: { ...state.settings, storeCountry: c } };
      priceFilter.min = '';
      priceFilter.max = '';
      if (query.trim()) await searchCatalog();
      else {
        render();
        requestBrowse(storeList);
      }
      return;
    }
    if (el.id === 'store-country') {
      detailPrices.clear();
      priceFilter.min = '';
      priceFilter.max = '';
      state = api
        ? await call('country', el.value)
        : { ...state, settings: { ...state.settings, storeCountry: el.value } };
      if (query.trim()) await searchCatalog();
      else {
        render();
        requestBrowse(storeList);
      }
      return;
    }
    if (el.dataset.remember) {
      try {
        state = await call('remember', { provider: el.dataset.remember, enabled: el.checked });
        render();
      } catch (e) {
        el.checked = !el.checked;
        throw e;
      }
    }
    if (el.dataset.collectionToggle) {
      state = await call('setInCollection', {
        collection: el.dataset.collectionToggle,
        id: librarySelection,
        include: el.checked,
      });
      render();
      return;
    }
    if (el.id === 'show-hidden') {
      showHidden = el.checked;
      libraryLimit = LIBRARY_PAGE;
      render();
      return;
    }
    if (el.id === 'library-sort') {
      librarySort = el.value;
      libraryLimit = LIBRARY_PAGE;
      render();
      return;
    }
    if (el.id === 'notify-giveaways') state = await call('notifyGiveaways', el.checked);
    if (el.id === 'auto-update') state = await call('autoUpdate', el.checked);
    if (el.dataset.installTag && installDlg?.opts) {
      installDlg.tags[el.checked ? 'add' : 'delete'](el.dataset.installTag);
      renderInstallDialog();
      return;
    }
    if (el.dataset.installDlc && installDlg?.opts) {
      installDlg.dlcs[el.checked ? 'add' : 'delete'](el.dataset.installDlc);
      return;
    }
    if (el.dataset.launchSetting)
      state = await call('launchSetting', { name: el.dataset.launchSetting, value: el.checked });
    if (el.id === 'download-limit') {
      if (!el.checkValidity()) throw Error('Укажите скорость от 0 до 10000 МБ/с');
      state = await call('downloadSettings', { downloadLimit: Math.round(Number(el.value || 0) * 1024) });
      toast(
        Number(el.value) ? `Загрузки Nexus ограничены ${el.value} МБ/с` : 'Скорость загрузок не ограничена'
      );
    }
    if (['schedule-enabled', 'schedule-from', 'schedule-to'].includes(el.id)) {
      state = await call('downloadSettings', {
        schedule: {
          enabled: $('#schedule-enabled').checked,
          from: $('#schedule-from').value,
          to: $('#schedule-to').value,
        },
      });
      render();
    }
    if (el.id === 'epic-auto-update') state = await call('downloadSettings', { epicAutoUpdate: el.checked });
    if (el.id === 'download-notify') state = await call('downloadSettings', { downloadNotify: el.checked });
    if (el.id === 'auto-start') {
      try {
        state = await call('autoStart', el.checked);
      } catch (e) {
        el.checked = !el.checked;
        throw e;
      }
    }
    if (el.name === 'provider') {
      selectedProvider = el.value;
      if (!demo && api) state = await call('preferred', { id: detailId, provider: selectedProvider });
      else state.settings.preferred[detailId] = selectedProvider;
      renderDetail();
    }
  })
);
document.addEventListener('submit', event => {
  if (event.target.id === 'track-process-form') {
    event.preventDefault();
    run(async () => {
      state = await call('setTrackProcess', { id: librarySelection, process: $('#track-process').value });
      render();
      toast('Сохранено');
    });
    return;
  }
  if (event.target.id === 'new-collection-form') {
    event.preventDefault();
    run(async () => {
      const name = $('#new-collection').value.trim();
      if (!name) throw Error('Введите название коллекции');
      state = await call('createCollection', name);
      const c = state.settings.collections.find(x => x.name === name);
      if (c && librarySelection)
        state = await call('setInCollection', { collection: c.id, id: librarySelection, include: true });
      render();
      toast('Коллекция создана');
    });
    return;
  }
  if (event.target.id === 'epic-code-form') {
    event.preventDefault();
    run(async () => {
      const input = $('#epic-code');
      state = await call('epicCode', input.value);
      input.value = '';
      render();
      toast('Аккаунт Epic Games подключён');
    });
    return;
  }
  if (event.target.id !== 'steam-form') return;
  event.preventDefault();
  run(async () => {
    const b = event.target.querySelector('button');
    b.disabled = true;
    b.textContent = 'Загрузка…';
    try {
      state = await call('steamImport', {
        steamId: $('#steam-id').value.trim(),
        key: $('#api-key').value.trim(),
      });
      $('#api-key').value = '';
      render();
      toast('Библиотека Steam импортирована.');
    } finally {
      b.disabled = false;
      b.textContent = 'Импортировать';
    }
  });
});
$('#search').addEventListener('input', e => {
  query = e.target.value;
  clearTimeout(searchTimer);
  searchSequence++;
  if (page === 'store') {
    searchState = { items: [], providers: {}, loading: !!query.trim(), query: query.trim(), start: 0 };
    render();
    if (query.trim()) searchTimer = setTimeout(() => searchCatalog(), 450);
  } else render();
});
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
