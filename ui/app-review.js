// Nexus window: «Итоги Nexus» — the year in games (like Steam's year in review), from
// the sessions Nexus records and the play time of the Steam and Epic libraries.
/* global state, demo, api, call, page, render, esc, artTag, game, spHours, plural */
let reviewState = { year: null, loading: false, data: null, error: '' };
const REVIEW_MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const REVIEW_STORES = { steam: 'Steam', epic: 'Epic Games', custom: 'Другие' };

async function loadReview(year) {
  if (!api?.yearReview || demo || reviewState.loading) return;
  reviewState = { ...reviewState, year: year ?? reviewState.year, loading: true, error: '' };
  try {
    const data = await call('yearReview', reviewState.year ?? undefined);
    reviewState = { year: data.year, loading: false, data, error: '', at: Date.now() };
  } catch (e) {
    reviewState = { ...reviewState, loading: false, error: e.message };
  }
  if (page === 'review') render();
}

function reviewHours(minutes) {
  const h = minutes / 60;
  return `${spHours(minutes)} ${plural(Math.round(h), 'час', 'часа', 'часов')}`;
}
function reviewTile(value, label) {
  return `<div class="review-tile"><b>${value}</b><span>${label}</span></div>`;
}
function reviewGameRow(x, i, extra) {
  const g = game(x.id);
  return `<button class="review-game" ${g ? `data-detail="${esc(x.id)}"` : ''}><span class="review-rank">${i + 1}</span><span class="review-cover">${g ? artTag(g) : ''}</span><span class="review-name"><strong>${esc(g?.name || x.name || x.id)}</strong><small>${extra}</small></span></button>`;
}

function reviewPage() {
  if (demo || !api?.yearReview)
    return '<section class="review"><div class="review-empty"><h2>Итоги Nexus</h2><p>Итоги года собираются из ваших игр: подключите Steam или Epic Games и играйте — Nexus запишет каждую сессию.</p></div></section>';
  const d = reviewState.data;
  // Opened again later: the numbers are counted anew (a game may have ended since).
  if (d && !reviewState.loading && Date.now() - (reviewState.at || 0) > 60000) setTimeout(() => loadReview(), 0);
  if (!d) {
    if (!reviewState.loading && !reviewState.error) setTimeout(() => loadReview(), 0);
    return `<section class="review"><div class="review-empty"><p>${esc(reviewState.error || 'Считаем ваш год в играх…')}</p></div></section>`;
  }
  const years = d.years
    .map(y => `<button class="${y === d.year ? 'active' : ''}" data-review-year="${y}">${y}</button>`)
    .join('');
  const head = `<header class="review-head"><div><small>ИТОГИ NEXUS</small><h1>${d.year}</h1><p>Ваш год в играх Steam, Epic Games и других программах — всё, что запускалось на этом компьютере.</p></div><div class="review-years" role="tablist" aria-label="Год">${years}</div></header>`;
  const since = d.logSince
    ? `<p class="review-note">Nexus записывает игровые сессии с ${new Date(d.logSince).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}: игры до этой даты в итоги года не вошли. Время за все годы ниже — из Steam и Epic Games.</p>`
    : '';
  let year;
  if (!d.sessions)
    year = `<section class="review-panel"><h2>${d.year}</h2><p class="hint">${d.year === new Date().getFullYear() ? 'Сессий в этом году пока нет. Запустите игру — Nexus учтёт её, даже если она запущена через Steam, Epic Games или ярлык.' : 'В этом году Nexus сессий не записал.'}</p></section>`;
  else {
    const max = Math.max(...d.months, 1);
    const months = d.months
      .map(
        (m, i) =>
          `<div class="review-month" title="${REVIEW_MONTHS[i]}: ${reviewHours(m)}"><i style="height:${Math.round((m / max) * 100)}%"></i><span>${REVIEW_MONTHS[i]}</span></div>`
      )
      .join('');
    const total = Object.values(d.stores).reduce((a, b) => a + b, 0) || 1;
    const stores = Object.entries(d.stores)
      .filter(([, m]) => m > 0)
      .map(
        ([p, m]) =>
          `<i class="review-store ${p}" style="width:${((m / total) * 100).toFixed(1)}%" title="${REVIEW_STORES[p]}: ${reviewHours(m)}"></i>`
      )
      .join('');
    const legend = Object.entries(d.stores)
      .filter(([, m]) => m > 0)
      .map(([p, m]) => `<span><i class="review-store ${p}"></i>${REVIEW_STORES[p]} · ${Math.round((m / total) * 100)}%</span>`)
      .join('');
    const longest = d.longest
      ? `<section class="review-panel review-longest"><h2>Самая долгая сессия</h2><strong>${esc(game(d.longest.id)?.name || d.longest.name)}</strong><p>${reviewHours(d.longest.minutes)} без перерыва · ${new Date(d.longest.start).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</p></section>`
      : '';
    year = `<div class="review-tiles">${[
      reviewTile(spHours(d.minutes), plural(Math.round(d.minutes / 60), 'час в играх', 'часа в играх', 'часов в играх')),
      reviewTile(d.sessions, plural(d.sessions, 'игровая сессия', 'игровые сессии', 'игровых сессий')),
      reviewTile(d.days, plural(d.days, 'день с играми', 'дня с играми', 'дней с играми')),
      reviewTile(d.games, plural(d.games, 'игра', 'игры', 'игр')),
      reviewTile(d.newGames, plural(d.newGames, 'новая игра', 'новые игры', 'новых игр')),
    ].join('')}</div>
    <div class="review-grid">
      <section class="review-panel"><h2>Игры года</h2><div class="review-games">${d.top
        .map((x, i) => reviewGameRow(x, i, `${reviewHours(x.minutes)} · ${x.sessions} ${plural(x.sessions, 'сессия', 'сессии', 'сессий')}`))
        .join('')}</div></section>
      <div class="review-side">
        <section class="review-panel"><h2>По месяцам</h2><div class="review-months">${months}</div></section>
        <section class="review-panel"><h2>Магазины</h2><div class="review-stores">${stores}</div><div class="review-legend">${legend}</div></section>
        ${longest}
      </div>
    </div>`;
  }
  const lib = d.library;
  const libStores = Object.entries(lib.stores)
    .filter(([, n]) => n > 0)
    .map(([p, n]) => `${REVIEW_STORES[p]}: ${n}`)
    .join(' · ');
  const library = `<section class="review-panel review-library"><h2>Вся библиотека</h2><div class="review-tiles small">${[
    reviewTile(spHours(lib.minutes), 'часов за всё время'),
    reviewTile(lib.games, plural(lib.games, 'игра в библиотеке', 'игры в библиотеке', 'игр в библиотеке')),
    reviewTile(lib.playedThisYear, `запускали в ${d.year}`),
    reviewTile(d.wishlist, 'в желаемом'),
  ].join('')}</div>${libStores ? `<p class="hint">${esc(libStores)}</p>` : ''}${
    lib.top.length
      ? `<h3>Больше всего часов за всё время</h3><div class="review-games">${lib.top.map((x, i) => reviewGameRow(x, i, reviewHours(x.minutes))).join('')}</div>`
      : ''
  }</section>`;
  return `<section class="review">${head}${since}${year}${library}</section>`;
}

document.addEventListener('click', event => {
  const el = event.target.closest('[data-review-year]');
  if (!el) return;
  loadReview(Number(el.dataset.reviewYear));
});
