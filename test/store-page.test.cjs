const test = require('node:test'),
  assert = require('node:assert/strict');
const { parseAppDetails, cleanHtml, parseLanguages } = require('../src/store-page.cjs');

const IMG = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/10/extras/a.gif';

test('store page html: formatting kept, scripts, handlers, links and foreign media dropped', () => {
  const html = cleanHtml(
    `<h2 class="bb_tag" onclick="x()">Title</h2><p style="color:red">Text <a href="https://evil.example">link</a></p>` +
      `<script>alert(1)</script><img src="${IMG}" onerror="alert(1)"><img src="https://evil.example/x.png">` +
      `<iframe src="https://evil.example"></iframe><video autoplay poster="https://evil.example/p.jpg"><source src="${IMG.replace('.gif', '.webm')}" type="video/webm; codecs=vp9"><source src="https://evil.example/v.mp4"></video>` +
      '<video><source src="https://evil.example/v.mp4"></video><source src="' +
      IMG +
      '">'
  );
  assert.match(html, /<h2 class="bb_tag">Title<\/h2>/);
  assert.match(html, /<p>Text link<\/p>/);
  assert.doesNotMatch(html, /script|onerror|onclick|style=|evil|iframe|href/);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, new RegExp(`<img src="${IMG.replace(/[.]/g, '\.')}" alt="" loading="lazy">`));
  assert.equal((html.match(/<video /g) || []).length, 1, 'a video without a Steam source is removed');
  assert.match(html, /type="video\/webm; codecs=vp9"/);
});

test('store page languages: full audio marked with an asterisk', () => {
  assert.deepEqual(
    parseLanguages('английский<strong>*</strong>, русский<br><strong>*</strong>языки с озвучкой'),
    [
      { name: 'английский', audio: true },
      { name: 'русский', audio: false },
    ]
  );
});

test('store page: Steam appdetails reduced to the fields Nexus shows', () => {
  const r = parseAppDetails(
    {
      success: true,
      data: {
        name: 'Game',
        type: 'game',
        short_description: 'Short &amp; <b>bold</b>',
        about_the_game: '<p>About</p>',
        reviews: '“Great”<br>9/10 – Site',
        header_image: 'https://shared.akamai.steamstatic.com/h.jpg',
        background: 'https://store.akamai.steamstatic.com/images/storepagebackground/app/10',
        website: 'javascript:alert(1)',
        developers: ['Dev'],
        publishers: ['Pub'],
        genres: [{ description: 'Экшен' }],
        categories: [{ id: 2, description: 'Для одного игрока' }],
        supported_languages: 'русский<strong>*</strong>',
        pc_requirements: { minimum: '<strong>Минимальные:</strong><ul><li>OS</li></ul>' },
        mac_requirements: [],
        platforms: { windows: true, mac: false, linux: false },
        release_date: { date: '1 янв. 2020 г.', coming_soon: false },
        metacritic: { score: 90, url: 'https://www.metacritic.com/game/x' },
        achievements: {
          total: 5,
          highlighted: [
            { name: 'A', path: IMG },
            { name: 'B', path: 'https://evil.example/a.jpg' },
          ],
        },
        screenshots: [
          { path_thumbnail: IMG, path_full: IMG },
          { path_thumbnail: 'https://evil.example/s.jpg' },
        ],
        movies: [{ name: 'Trailer', thumbnail: IMG, hls_h264: IMG.replace('.gif', '.m3u8') }],
      },
    },
    10
  );
  assert.equal(r.appId, '10');
  assert.equal(r.short, 'Short & bold');
  assert.equal(r.website, '');
  assert.deepEqual(r.genres, ['Экшен']);
  assert.deepEqual(r.features, [{ id: 2, name: 'Для одного игрока' }]);
  assert.deepEqual(Object.keys(r.requirements), ['windows']);
  assert.equal(r.achievements.list.length, 1);
  assert.equal(r.screenshots.length, 1);
  assert.equal(r.movies[0].hls, IMG.replace('.gif', '.m3u8'));
  assert.equal(r.metacritic.score, 90);
  assert.equal(parseAppDetails({ success: false }, 10), null);
});

test('Epic markdown: headings, lists, bold, Epic images only, no raw html or links', () => {
  const { markdownHtml } = require('../src/store-page.cjs');
  const html = markdownHtml(
    '<!--textBlock-->\nBright\-Falls **bold** <script>x</script> [link](https://evil.example)\n\nHeader\n======\n\n- one\n- two\n\n' +
      '![](https://cdn1.epicgames.com/offer/a.jpg) ![](https://evil.example/b.jpg)\n\n### Small'
  );
  assert.equal(
    html,
    '<p>Bright-Falls <strong>bold</strong> x link</p><h2>Header</h2><ul><li>one</li><li>two</li></ul>' +
      '<p><img src="https://cdn1.epicgames.com/offer/a.jpg" alt="" loading="lazy"> </p><h3>Small</h3>'
  );
});

test('Epic offer: languages, requirements, gallery and details in the Steam page shape', () => {
  const { parseEpicOffer, parseEpicLanguages } = require('../src/store-page.cjs');
  assert.deepEqual(
    parseEpicLanguages(['ОЗВУЧИВАНИЕ: английский | ТЕКСТ: английский, испанский (Испания, Мексика)']),
    [
      { name: 'английский', audio: true, ui: true },
      { name: 'испанский (Испания, Мексика)', audio: false, ui: true },
    ]
  );
  const r = parseEpicOffer(
    {
      title: 'Epic Game',
      description: 'Short',
      longDescription: 'About **it**',
      developerDisplayName: 'Dev',
      publisherDisplayName: 'Pub',
      releaseDate: '2023-10-27T04:00:00.000Z',
      keyImages: [
        { type: 'OfferImageWide', url: 'https://cdn1.epicgames.com/offer/wide.jpg' },
        { type: 'featuredMedia', url: 'https://cdn2.unrealengine.com/shot-1920x1080.jpg' },
        { type: 'featuredMedia', url: 'https://evil.example/shot.jpg' },
      ],
      tags: [
        { groupName: 'genre', name: 'Хоррор' },
        { groupName: 'epicfeature', name: 'Достижения' },
        { groupName: 'platform', name: 'Windows' },
      ],
    },
    {
      pages: [
        {
          type: 'productHome',
          data: {
            requirements: {
              languages: ['ТЕКСТ: русский'],
              systems: [
                {
                  systemType: 'Windows',
                  details: [{ title: 'ОС', minimum: 'Windows 10', recommended: '<b>11</b>' }],
                },
              ],
            },
          },
        },
      ],
    },
    'https://store.epicgames.com/p/epic-game'
  );
  assert.equal(r.store, 'epic');
  assert.equal(r.url, 'https://store.epicgames.com/p/epic-game');
  assert.equal(r.about, '<p>About <strong>it</strong></p>');
  assert.deepEqual([r.developers, r.publishers, r.genres], [['Dev'], ['Pub'], ['Хоррор']]);
  assert.deepEqual(r.features, [{ id: 0, name: 'Достижения' }]);
  assert.equal(r.header, 'https://cdn1.epicgames.com/offer/wide.jpg');
  assert.deepEqual(r.screenshots, [
    {
      thumb: 'https://cdn2.unrealengine.com/shot-1920x1080.jpg',
      full: 'https://cdn2.unrealengine.com/shot-1920x1080.jpg',
    },
  ]);
  assert.deepEqual(r.languages, [{ name: 'русский', audio: false, ui: true }]);
  assert.match(r.requirements.windows.minimum, /<li><strong>ОС:<\/strong> Windows 10<\/li>/);
  assert.match(r.requirements.windows.recommended, /&lt;b&gt;11&lt;\/b&gt;/);
  assert.equal(r.release.date, '27 окт. 2023 г.');
  // Without the product page (new Epic products) the page still has the catalog data.
  assert.deepEqual(parseEpicOffer({ title: 'X' }, null).requirements, {});
  assert.equal(parseEpicOffer(null, null), null);
});
