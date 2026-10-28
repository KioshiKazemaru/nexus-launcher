// Nexus window, part 2 of 5: The store front: showcase, lists, recommendations.
// The parts are classic scripts loaded in order by index.html and share one
// global scope (see eslint.config.cjs); app-boot.js starts the window.
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
