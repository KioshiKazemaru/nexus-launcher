// ---- «Желаемое» and «Скидки» ----------------------------------------------------
// Желаемое: the wishlists of the connected Steam and Epic accounts (synced by the main
// process, main/store.cjs) and the games added in Nexus, with where each one came from.
// Скидки: the wishlist games on sale, the games on sale in the Steam and Epic stores
// (page by page, with the date each discount ends) and the price watches.

let wishFilter = 'all'; // all | steam | epic | nexus | sale
let wishSort = 'added'; // added | discount | price | ends | name
let dealsProvider = 'all'; // all | steam | epic
let dealsSort = 'popular'; // popular | price (the stores' order) | discount | ends (loaded games)
// Store pages of discounts; the loaded games live in browseState under 'deals', so the
// store page of a game opens from them like from any store list.
let saleList = { key: '', items: [], next: null, totals: {}, errors: [], loading: false };

const SALE_MONTH = { day: 'numeric', month: 'long' };
// «до 18 ноября», with the year when it is not this year; the last day in hours.
function saleEndText(t, now = Date.now()) {
  if (!Number.isFinite(t) || t <= now) return '';
  const left = t - now;
  if (left < 86400000) {
    const hours = Math.max(1, Math.round(left / 3600000));
    return `осталось ${hours} ч`;
  }
  const d = new Date(t);
  const opts =
    d.getFullYear() === new Date(now).getFullYear() ? SALE_MONTH : { ...SALE_MONTH, year: 'numeric' };
  return 'до ' + d.toLocaleDateString('ru-RU', opts);
}
function saleEndTag(offer) {
  const text = offer?.discount > 0 ? saleEndText(offer.saleEnd) : '';
  return text
    ? `<small class="sale-end" title="Скидка действует до ${esc(new Date(offer.saleEnd).toLocaleString('ru-RU'))}">${esc(text)}</small>`
    : '';
}
// Offers priced in the current region.
function regionOffers(g) {
  const country = state.settings.storeCountry || 'US';
  return priceOffers(g).filter(o => !o.country || o.country === country);
}
// The deepest discount of a game now (null when it is not on sale).
function bestSale(g) {
  return (
    regionOffers(g)
      .filter(o => o.discount > 0)
      .sort((a, b) => b.discount - a.discount)[0] || null
  );
}
function lowestPrice(g) {
  const priced = regionOffers(g).filter(o => Number.isFinite(o.amount));
  return priced.length ? Math.min(...priced.map(o => o.amount)) : Infinity;
}
function soonestEnd(g) {
  const ends = regionOffers(g)
    .filter(o => o.discount > 0 && o.saleEnd > Date.now())
    .map(o => o.saleEnd);
  return ends.length ? Math.min(...ends) : Infinity;
}

// ---- Желаемое -----------------------------------------------------------------

// Where an entry came from: 'steam', 'epic', 'nexus' (an old entry not yet synced
// counts as added in Nexus).
function wishSources(id) {
  const from = state.settings.wishlistFrom?.[id] || ['nexus'];
  return [...new Set(from.map(o => (o === 'legacy' ? 'nexus' : o.split(':')[0])))].filter(s =>
    ['steam', 'epic', 'nexus'].includes(s)
  );
}
const WISH_SOURCE = { steam: 'Steam', epic: 'Epic Games', nexus: 'Nexus' };
function wishFromTag(id) {
  return `<div class="wish-from">${wishSources(id)
    .map(
      s =>
        `<span class="wish-src ${s}">${s === 'nexus' ? 'Добавлено в Nexus' : 'Желаемое ' + WISH_SOURCE[s]}</span>`
    )
    .join('')}</div>`;
}
// The heart of a card. A game removed here stays on its store wishlist: say so.
async function toggleWish(id) {
  const stores = has('wishlist', id) ? wishSources(id).filter(s => s !== 'nexus') : [];
  await toggle('wishlist', id);
  if (stores.length)
    toast(
      `Убрано из желаемого Nexus. В списке желаемого ${stores.map(s => WISH_SOURCE[s]).join(' и ')} игра остаётся.`
    );
}
// The wishlist in its own order (newest store entries last, like the stores).
function wishedGames() {
  const order = new Map(state.settings.wishlist.map((id, i) => [id, i]));
  return state.catalog
    .filter(g => order.has(g.id))
    .map(g => game(g.id) || g)
    .sort((a, b) => order.get(a.id) - order.get(b.id));
}
const WISH_SORTS = {
  added: null,
  discount: (a, b) => (bestSale(b)?.discount || 0) - (bestSale(a)?.discount || 0),
  price: (a, b) => lowestPrice(a) - lowestPrice(b),
  ends: (a, b) => soonestEnd(a) - soonestEnd(b),
  name: (a, b) => a.name.localeCompare(b.name, 'ru'),
};
function wishMatches(g, f) {
  if (f === 'all') return true;
  if (f === 'sale') return !!bestSale(g);
  return wishSources(g.id).includes(f);
}
function wishSyncLine() {
  const sync = state.wishlistSync;
  const accounts = (state.accountList || []).filter(a => a.status === 'connected');
  if (sync?.running) return 'Синхронизация со Steam и Epic…';
  if (!accounts.length)
    return 'Подключите Steam или Epic Games в «Аккаунтах»: их списки желаемого появятся здесь сами.';
  if (!sync?.at) return 'Списки желаемого Steam и Epic загружаются после входа в аккаунт и каждые 3 часа.';
  return `Синхронизировано со Steam и Epic: ${new Date(sync.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Обновляется после входа и каждые 3 часа.`;
}
function wishlistPage() {
  const all = wishedGames();
  const q = query.toLowerCase();
  const counts = Object.fromEntries(
    ['all', 'steam', 'epic', 'nexus', 'sale'].map(f => [f, all.filter(g => wishMatches(g, f)).length])
  );
  let list = all.filter(g => wishMatches(g, wishFilter) && (!q || g.name.toLowerCase().includes(q)));
  if (WISH_SORTS[wishSort]) list = [...list].sort(WISH_SORTS[wishSort]);
  const errors = state.wishlistSync?.errors || [];
  const signIn = (state.wishlistSync?.storeSignIn || [])
    .map(
      a =>
        `<button class="secondary" data-epic-store-signin="${esc(a.key)}">Войти в магазин Epic${a.name ? ' · ' + esc(a.name) : ''}</button>`
    )
    .join('');
  const chips = [
    ['all', 'Все'],
    ['steam', 'Steam'],
    ['epic', 'Epic Games'],
    ['nexus', 'Добавлены в Nexus'],
    ['sale', 'Со скидкой'],
  ]
    .map(
      ([f, n]) =>
        `<button class="${wishFilter === f ? 'active' : ''}" data-wish-filter="${f}">${n} <span>${counts[f]}</span></button>`
    )
    .join('');
  const sorts = [
    ['added', 'По порядку добавления'],
    ['discount', 'Больше скидка'],
    ['price', 'Дешевле'],
    ['ends', 'Скоро закончится скидка'],
    ['name', 'По названию'],
  ]
    .map(([v, n]) => `<option value="${v}" ${wishSort === v ? 'selected' : ''}>${n}</option>`)
    .join('');
  const empty = !all.length
    ? '<div class="empty"><h2>Список желаемого пуст</h2><p>Здесь собираются списки желаемого подключённых аккаунтов Steam и Epic Games и игры, отмеченные сердечком в Nexus.</p></div>'
    : !list.length
      ? '<div class="empty"><h2>Ничего не найдено</h2><p>Выберите другой фильтр.</p></div>'
      : '';
  return `${notice()}<div class="section-head"><h1>Желаемое</h1><span>${all.length} игр</span><button class="secondary" id="sync-wishlists" ${state.wishlistSync?.running || !(state.accountList || []).some(a => a.status === 'connected') ? 'disabled' : ''}>↻ Синхронизировать</button></div><p class="subheading">${esc(wishSyncLine())}</p>${errors.length ? `<div class="notice warning">${errors.map(esc).join('<br>')}${signIn ? `<p>Аккаунт Epic подключён к Nexus, но сайт магазина Epic просит войти отдельно. Откроется окно магазина со входом вашего аккаунта: пароль не нужен, Epic может попросить пройти проверку. После закрытия окна Nexus синхронизирует желаемое.</p><div class="account-actions">${signIn}</div>` : ''}</div>` : ''}<div class="wish-tools"><div class="library-platforms">${chips}</div><label class="library-sort">Порядок <select id="wish-sort">${sorts}</select></label></div><div class="grid">${list.map(g => card(g, wishFromTag(g.id))).join('')}</div>${empty}<p class="footnote">Убранная в Nexus игра остаётся в списке желаемого Steam или Epic и не возвращается при синхронизации. Игра, убранная из списка в магазине, исчезает и отсюда, если её не добавляли в Nexus.</p>`;
}

// ---- Скидки -------------------------------------------------------------------

function dealsKey() {
  return [
    state.settings.storeCountry || 'US',
    dealsProvider,
    dealsSort === 'price' ? 'price' : 'popular',
  ].join(':');
}
// The first page, or the next one ("Показать ещё").
async function requestSaleList(more = false) {
  if (!api?.deals || demo || saleList.loading) return;
  const key = dealsKey();
  if (!more && saleList.key === key && (saleList.items.length || saleList.errors.length)) return;
  const fresh = !more || saleList.key !== key;
  const cursor = fresh ? { steamStart: 0, epicStart: 0 } : saleList.next;
  if (!cursor || (cursor.steamStart === null && cursor.epicStart === null)) return;
  saleList = { ...(fresh ? { items: [], totals: {}, errors: [] } : saleList), key, loading: true };
  if (page === 'tracking') render();
  try {
    const r = await call('deals', {
      provider: dealsProvider,
      sort: dealsSort === 'price' ? 'price' : 'popular',
      ...cursor,
    });
    if (dealsKey() !== key) return;
    const seen = new Set(saleList.items.map(g => g.id));
    saleList = {
      key,
      items: [...saleList.items, ...r.items.filter(g => !seen.has(g.id))],
      next: r.next,
      totals: r.totals,
      errors: r.errors,
      loading: false,
    };
  } catch (e) {
    saleList = { ...saleList, loading: false, errors: [e.message] };
  }
  browseState.set('deals', { items: saleList.items });
  if (page === 'tracking') render();
}
const DEAL_SORTS = {
  popular: null,
  price: null,
  discount: (a, b) => (bestSale(b)?.discount || 0) - (bestSale(a)?.discount || 0),
  ends: (a, b) => soonestEnd(a) - soonestEnd(b),
};
function wishDealsBlock() {
  const sale = wishedGames()
    .filter(g => bestSale(g))
    .sort((a, b) => soonestEnd(a) - soonestEnd(b));
  const body = sale.length
    ? `<div class="grid">${sale.map(g => card(g, wishFromTag(g.id))).join('')}</div>`
    : `<p class="hint">${state.settings.wishlist.length ? 'Сейчас на игры из желаемого скидок нет. Цены проверяются при запуске Nexus.' : 'Добавьте игры в желаемое: скидки на них появятся здесь первыми.'}</p>`;
  return `<section class="deals-block"><div class="shelf-title"><h2>Со скидкой в желаемом <span>(${sale.length})</span></h2><span>Сначала те, у которых скидка закончится раньше</span></div>${body}</section>`;
}
function storeDealsBlock() {
  const tabs = [
    ['all', 'Все магазины'],
    ['steam', 'Steam'],
    ['epic', 'Epic Games'],
  ]
    .map(
      ([p, n]) =>
        `<button class="${dealsProvider === p ? 'active' : ''}" data-deals-provider="${p}">${n}</button>`
    )
    .join('');
  const sorts = [
    ['popular', 'Популярные'],
    ['price', 'Дешевле'],
    ['discount', 'Больше скидка'],
    ['ends', 'Скоро закончится'],
  ]
    .map(([v, n]) => `<option value="${v}" ${dealsSort === v ? 'selected' : ''}>${n}</option>`)
    .join('');
  const q = query.toLowerCase();
  let list = saleList.items.filter(g => !q || g.name.toLowerCase().includes(q));
  if (DEAL_SORTS[dealsSort]) list = [...list].sort(DEAL_SORTS[dealsSort]);
  const t = saleList.totals || {};
  const total = [
    dealsProvider !== 'epic' && t.steam ? `Steam: ${t.steam.toLocaleString('ru-RU')}` : '',
    dealsProvider !== 'steam' && t.epic ? `Epic Games: ${t.epic.toLocaleString('ru-RU')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const next = saleList.next;
  const more = next && (next.steamStart !== null || next.epicStart !== null);
  const sortNote =
    dealsSort === 'discount' || dealsSort === 'ends'
      ? '<p class="hint">Порядок применяется к загруженным играм. «Показать ещё» добавляет следующие.</p>'
      : '';
  return `<section class="deals-block"><div class="shelf-title"><h2>Все скидки магазинов</h2><span>${total ? esc(total) + ' игр со скидкой' : ''}</span></div><div class="wish-tools"><div class="library-platforms">${tabs}</div><label class="library-sort">Порядок <select id="deals-sort">${sorts}</select></label></div>${sortNote}${saleList.errors.length ? `<div class="notice warning">${saleList.errors.map(esc).join('<br>')}</div>` : ''}${list.length ? `<div class="grid">${list.map(g => card(g)).join('')}</div>` : saleList.loading ? '' : '<p class="hint">Скидок не найдено.</p>'}${saleList.loading ? '<p class="hint">Загружаем скидки…</p>' : more ? `<div class="load-more"><button class="secondary" id="deals-more">Показать ещё</button></div>` : ''}</section>`;
}
function watchesBlock() {
  const watches = (state.settings.priceWatches || []).filter(w =>
    w.name.toLowerCase().includes(query.toLowerCase())
  );
  if (!watches.length) return '';
  return `<details class="deals-block watches" open><summary><h2>Мои отслеживания цен <span>(${watches.length})</span></h2></summary><button class="secondary" id="check-prices">↻ Проверить цены</button>${watches.map(watchCard).join('')}</details>`;
}
function dealsPage() {
  // After this render (the request renders again when the page arrives).
  setTimeout(() => requestSaleList());
  return `<div class="section-head"><h1>Скидки</h1><span>Steam и Epic Games · ${esc(countries[state.settings.storeCountry] || state.settings.storeCountry || '')}</span></div><p class="subheading">Игры со скидкой и дата, до которой она действует. Цены — в регионе магазина.</p>${wishDealsBlock()}${watchesBlock()}${storeDealsBlock()}`;
}
