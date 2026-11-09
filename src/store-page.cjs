'use strict';
// The full store page of a Steam game (store.steampowered.com/api/appdetails),
// reduced to what the Nexus game page shows. Steam's HTML (about the game,
// requirements, critic quotes) is cut down to plain formatting tags; images and
// looping videos are kept only from Steam's own image servers.

const cheerio = require('cheerio');

const STEAM_MEDIA = /^https:\/\/[\w.-]+\.(?:steamstatic\.com|akamaihd\.net)\/[^\s"'<>]*$/;
const media = u => (STEAM_MEDIA.test(String(u || '')) ? String(u) : '');
const httpsLink = u => (/^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : '');
const text = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const list = (v, max = 10) =>
  (Array.isArray(v) ? v : [])
    .map(x => text(typeof x === 'string' ? x : x?.description))
    .filter(Boolean)
    .slice(0, max)
    .map(x => x.slice(0, 120));

const ALLOWED = new Set([
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'strong',
  'b',
  'i',
  'em',
  'u',
  'img',
  'video',
  'source',
]);
const DROP =
  'script,style,iframe,object,embed,form,input,button,textarea,select,svg,math,link,meta,noscript,template';

function cleanHtml(html) {
  const $ = cheerio.load(`<div id="nexus-root">${String(html || '').slice(0, 300000)}</div>`, null, false);
  const root = $('#nexus-root');
  root.find(DROP).remove();
  // Deepest first, so unwrapping an element never skips its children.
  for (const el of root.find('*').toArray().reverse()) {
    const node = $(el);
    const tag = String(el.tagName || '').toLowerCase();
    if (!ALLOWED.has(tag)) {
      node.replaceWith(node.contents());
      continue;
    }
    const a = el.attribs || {};
    const keep = {};
    if (tag === 'img') {
      const src = media(a.src);
      if (!src) {
        node.remove();
        continue;
      }
      Object.assign(keep, { src, alt: '', loading: 'lazy' });
    } else if (tag === 'video') {
      if (media(a.poster)) keep.poster = media(a.poster);
      Object.assign(keep, { autoplay: '', muted: '', loop: '', playsinline: '' });
    } else if (tag === 'source') {
      const src = media(a.src);
      if (!src || !node.parent().is('video')) {
        node.remove();
        continue;
      }
      keep.src = src;
      if (/^video\/(?:webm|mp4)\b[\w ;=.,"-]*$/.test(a.type || '')) keep.type = a.type;
    } else if (/^h\d$/.test(tag) && /\bbb_tag\b/.test(a.class || '')) keep.class = 'bb_tag';
    el.attribs = keep;
  }
  root.find('video').each((_, v) => {
    if (!$(v).find('source').length) $(v).remove();
  });
  return (root.html() || '').trim();
}

// "английский<strong>*</strong>, русский<br><strong>*</strong>озвучивание…" → [{name, audio}]
function parseLanguages(html) {
  const head = String(html || '').split(/<br\s*\/?>/i)[0];
  return head
    .split(',')
    .map(part => ({
      name: text(cheerio.load(part, null, false).text().replace(/\*/g, '')).slice(0, 60),
      audio: /\*/.test(part),
    }))
    .filter(x => x.name)
    .slice(0, 40);
}

function requirements(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const minimum = cleanHtml(r.minimum),
    recommended = cleanHtml(r.recommended);
  return minimum || recommended ? { minimum, recommended } : null;
}

function parseAppDetails(entry, appId) {
  if (!entry?.success || !entry.data) return null;
  const d = entry.data;
  const shots = (Array.isArray(d.screenshots) ? d.screenshots : [])
    .map(s => ({ thumb: media(s?.path_thumbnail), full: media(s?.path_full) }))
    .filter(s => s.thumb || s.full)
    .slice(0, 30);
  const movies = (Array.isArray(d.movies) ? d.movies : [])
    .map(m => ({
      name: text(m?.name).slice(0, 200),
      thumb: media(m?.thumbnail),
      hls: media(m?.hls_h264),
      mp4: media(m?.mp4?.max || m?.mp4?.['480']),
      webm: media(m?.webm?.max || m?.webm?.['480']),
    }))
    .filter(m => m.thumb)
    .slice(0, 10);
  const achievements = d.achievements && typeof d.achievements === 'object' ? d.achievements : {};
  const req = {
    windows: requirements(d.pc_requirements),
    mac: requirements(d.mac_requirements),
    linux: requirements(d.linux_requirements),
  };
  for (const k of Object.keys(req)) if (!req[k]) delete req[k];
  return {
    appId: String(appId),
    name: text(d.name).slice(0, 200),
    type: text(d.type).slice(0, 30),
    short: text(cheerio.load(String(d.short_description || ''), null, false).text()).slice(0, 1000),
    about: cleanHtml(d.about_the_game || d.detailed_description),
    critics: cleanHtml(d.reviews),
    legal: text(cheerio.load(String(d.legal_notice || ''), null, false).text()).slice(0, 1500),
    header: media(d.header_image),
    background: media(d.background) || media(d.background_raw),
    website: httpsLink(d.website),
    developers: list(d.developers),
    publishers: list(d.publishers),
    genres: list(d.genres),
    features: (Array.isArray(d.categories) ? d.categories : [])
      .map(c => ({ id: Number(c?.id) || 0, name: text(c?.description).slice(0, 80) }))
      .filter(c => c.name)
      .slice(0, 30),
    languages: parseLanguages(d.supported_languages),
    requirements: req,
    platforms: {
      windows: d.platforms?.windows === true,
      mac: d.platforms?.mac === true,
      linux: d.platforms?.linux === true,
    },
    release: { date: text(d.release_date?.date).slice(0, 60), soon: d.release_date?.coming_soon === true },
    metacritic:
      Number.isFinite(d.metacritic?.score) && d.metacritic.score > 0
        ? { score: d.metacritic.score, url: httpsLink(d.metacritic.url) }
        : null,
    recommendations: Number(d.recommendations?.total) || 0,
    achievements: {
      total: Number(achievements.total) || 0,
      list: (Array.isArray(achievements.highlighted) ? achievements.highlighted : [])
        .map(a => ({ name: text(a?.name).slice(0, 120), icon: media(a?.path) }))
        .filter(a => a.icon)
        .slice(0, 10),
    },
    dlc: Array.isArray(d.dlc) ? d.dlc.length : 0,
    age: Number(d.required_age) || 0,
    free: d.is_free === true,
    screenshots: shots,
    movies,
  };
}

// ---- Epic Games Store -----------------------------------------------------------
// Epic's long descriptions are Markdown; images only from Epic's CDN.
const EPIC_MEDIA = /^https:\/\/(?:cdn[12]\.epicgames\.com|cdn2\.unrealengine\.com)\/[^\s"'<>()]*$/;
const epicMedia = u => (EPIC_MEDIA.test(String(u || '')) ? String(u) : '');
const epicThumb = u =>
  /^https:\/\/cdn[12]\.epicgames\.com\/[^?]*$/.test(u) ? u + '?resize=1&w=640&h=360&quality=medium' : u;
const escHtml = s =>
  String(s).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

function markdownHtml(md) {
  const src = String(md || '')
    .slice(0, 200000)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\r/g, '');
  // Inline: escape first, then the few Markdown marks Epic uses.
  const inline = s => {
    let out = escHtml(s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1'));
    out = out.replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, (_, u) => {
      const url = epicMedia(u.replace(/&amp;/g, '&'));
      return url ? `<img src="${escHtml(url)}" alt="" loading="lazy">` : '';
    });
    out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    out = out.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
    out = out.replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>');
    return out;
  };
  const lines = src.split('\n');
  const html = [];
  let para = [],
    list = [];
  const flush = () => {
    if (para.length) html.push(`<p>${para.map(inline).join('<br>')}</p>`);
    if (list.length) html.push(`<ul>${list.map(x => `<li>${inline(x)}</li>`).join('')}</ul>`);
    para = [];
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const next = (lines[i + 1] || '').trim();
    if (!line) {
      flush();
      continue;
    }
    if (/^(=+|-{3,})$/.test(next) && !/^[-*]\s/.test(line)) {
      flush();
      html.push(`<h2>${inline(line)}</h2>`);
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      html.push(
        `<h${h[1].length > 2 ? 3 : 2}>${inline(h[2].replace(/\s*#+$/, ''))}</h${h[1].length > 2 ? 3 : 2}>`
      );
      continue;
    }
    if (/^(?:-{3,}|\*{3,})$/.test(line)) {
      flush();
      continue;
    }
    const li = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      if (para.length) flush();
      list.push(li[1]);
      continue;
    }
    if (list.length) flush();
    para.push(line);
  }
  flush();
  return html.join('');
}

// "ОЗВУЧИВАНИЕ: английский, немецкий | ТЕКСТ: английский, русский" → [{name, audio, ui}]
function parseEpicLanguages(list) {
  const audio = new Set(),
    ui = new Set(),
    order = [];
  for (const raw of (Array.isArray(list) ? list : [list]).filter(x => typeof x === 'string')) {
    const parts = raw.split('|');
    for (const part of parts) {
      const m = part.match(/^\s*([^:]+):\s*(.*)$/);
      const kind = m ? m[1].trim().toLowerCase() : 'текст';
      const names = (m ? m[2] : part)
        .split(/,(?![^()]*\))/)
        .map(x => text(x).slice(0, 60))
        .filter(Boolean);
      for (const n of names) {
        if (!order.includes(n)) order.push(n);
        if (/озвуч|audio|voice/.test(kind)) audio.add(n);
        else ui.add(n);
      }
    }
  }
  return order.slice(0, 40).map(name => ({ name, audio: audio.has(name), ui: ui.has(name) }));
}

function epicRequirements(systems) {
  const out = {};
  for (const s of Array.isArray(systems) ? systems : []) {
    const key = /mac/i.test(s?.systemType) ? 'mac' : /windows/i.test(s?.systemType) ? 'windows' : '';
    const items = (Array.isArray(s?.details) ? s.details : []).filter(d => text(d?.title));
    if (!key || !items.length || out[key]) continue;
    const column = (label, field) => {
      const rows = items.filter(d => text(d[field]));
      return rows.length
        ? `<strong>${label}:</strong><ul>${rows
            .map(
              d =>
                `<li><strong>${escHtml(text(d.title).slice(0, 80))}:</strong> ${escHtml(text(d[field]).slice(0, 300))}</li>`
            )
            .join('')}</ul>`
        : '';
    };
    out[key] = {
      minimum: column('Минимальные', 'minimum'),
      recommended: column('Рекомендованные', 'recommended'),
    };
  }
  return out;
}

// catalogOffer from Epic's GraphQL (+ the product page content when Epic still has it).
function parseEpicOffer(offer, content, url = '') {
  if (!offer?.title) return null;
  const images = Array.isArray(offer.keyImages) ? offer.keyImages : [];
  const pick = types => types.map(t => epicMedia(images.find(i => i?.type === t)?.url)).find(Boolean) || '';
  const tags = Array.isArray(offer.tags) ? offer.tags : [];
  const group = g => [
    ...new Set(
      tags
        .filter(t => t?.groupName === g)
        .map(t => text(t.name).slice(0, 80))
        .filter(Boolean)
    ),
  ];
  const home =
    (Array.isArray(content?.pages) ? content.pages : []).find(p => p?.type === 'productHome') || null;
  const data = home?.data || {};
  const released = Date.parse(offer.releaseDate || '');
  const about = markdownHtml(offer.longDescription || data.about?.description || '');
  const developers = [text(offer.developerDisplayName || data.about?.developerAttribution)].filter(Boolean);
  const publishers = [
    text(offer.publisherDisplayName || data.about?.publisherAttribution || offer.seller?.name),
  ].filter(Boolean);
  const platforms = group('platform').join(' ');
  return {
    store: 'epic',
    appId: '',
    url: /^https:\/\/store\.epicgames\.com\/[\w/%.-]+$/.test(url) ? url : '',
    name: text(offer.title).slice(0, 200),
    type: 'game',
    short: text(offer.description).slice(0, 1000),
    about,
    critics: '',
    legal: '',
    header: pick(['OfferImageWide', 'DieselStoreFrontWide', 'Thumbnail']),
    background: '',
    website: '',
    developers: developers.map(x => x.slice(0, 120)),
    publishers: publishers.map(x => x.slice(0, 120)),
    genres: group('genre').slice(0, 10),
    features: group('epicfeature')
      .concat(group('feature'))
      .slice(0, 30)
      .map(name => ({ id: 0, name })),
    languages: parseEpicLanguages(data.requirements?.languages),
    requirements: epicRequirements(data.requirements?.systems),
    platforms: {
      windows: !platforms || /windows/i.test(platforms),
      mac: /mac/i.test(platforms),
      linux: false,
    },
    release: {
      date: Number.isFinite(released)
        ? new Date(released).toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          })
        : '',
      soon: Number.isFinite(released) && released > Date.now(),
    },
    metacritic: null,
    recommendations: 0,
    achievements: { total: 0, list: [] },
    dlc: 0,
    age: 0,
    free: false,
    screenshots: images
      .filter(i => /featuredmedia|screenshot|gallery/i.test(i?.type || ''))
      .map(i => epicMedia(i.url))
      .filter(Boolean)
      .filter((u, i, all) => all.indexOf(u) === i)
      .slice(0, 30)
      .map(u => ({ thumb: epicThumb(u), full: u })),
    movies: [],
  };
}

module.exports = {
  parseAppDetails,
  cleanHtml,
  parseLanguages,
  markdownHtml,
  parseEpicLanguages,
  parseEpicOffer,
};
