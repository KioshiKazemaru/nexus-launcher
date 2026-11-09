'use strict';
// News and patch notes of games (Steam's public news feed, no key needed):
// the game page shows the game's news, the library "Что нового" — news of
// the games played recently.

const CLAN_IMAGES = 'https://clan.akamai.steamstatic.com/images/';

function newsUrl(appId, count = 10) {
  const u = new URL('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/');
  u.search = new URLSearchParams({
    appid: String(appId),
    count: String(count),
    maxlength: '0',
    format: 'json',
  });
  return u.href;
}

// The first picture of a post: {STEAM_CLAN_IMAGE}/… or [img]https://…[/img] or <img src="…">.
function firstImage(text) {
  const s = String(text || '');
  const clan = /\{STEAM_CLAN_IMAGE\}\/([\w./-]+\.(?:png|jpe?g|gif|webp))/i.exec(s);
  if (clan) return CLAN_IMAGES + clan[1];
  const m = /\[img\]\s*(https:\/\/[^\s[\]"]+)\s*\[\/img\]|<img[^>]+src=["'](https:\/\/[^"']+)["']/i.exec(s);
  const url = m?.[1] || m?.[2] || '';
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)steamstatic\.com$/.test(u.hostname) ? u.href : '';
  } catch {
    return '';
  }
}

// BBCode / HTML of a post → plain text (paragraphs kept), at most `max` characters.
function plainText(text, max = 600) {
  const s = String(text || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\{STEAM_CLAN_IMAGE\}\/\S+/g, ' ')
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, ' ')
    .replace(/\[\/?img[^\]]*\]/gi, ' ')
    .replace(/\[(?:previewyoutube|video)[^\]]*\][\s\S]*?\[\/(?:previewyoutube|video)\]/gi, ' ')
    .replace(/<br\s*\/?>|\[br\]|\[\/?(?:p|h\d|list|olist)\]|<\/?(?:p|h\d|ul|ol|div)[^>]*>/gi, '\n')
    .replace(/\[\*\]|<li[^>]*>/gi, '\n• ')
    .replace(/\[\/?[a-z0-9]+(?:[= ][^\]]*)?\]/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '') + '…' : s;
}

const isPatch = item =>
  (Array.isArray(item?.tags) && item.tags.includes('patchnotes')) ||
  /patch|update|hotfix|обновлени|исправлени/i.test(String(item?.title || ''));

// GetNewsForApp → [{ id, title, url, date (ms), source, patch, text, image }].
function parseNews(json, appId) {
  const items = json?.appnews?.newsitems;
  if (!Array.isArray(items)) throw Error('Steam не отдал новости');
  return items
    .filter(x => x && typeof x.title === 'string' && Number(x.date) > 0)
    .map(x => {
      let url = '';
      try {
        const u = new URL(String(x.url || ''));
        if (u.protocol === 'https:') url = u.href;
      } catch {}
      return {
        id: String(x.gid || x.date),
        appId: Number(appId),
        title: x.title.slice(0, 200),
        url,
        date: Number(x.date) * 1000,
        source: String(x.feedlabel || x.author || '').slice(0, 80),
        patch: isPatch(x),
        text: plainText(x.contents),
        image: firstImage(x.contents),
      };
    });
}

// News of several games, newest first, without duplicates.
function mergeFeeds(lists, max = 40) {
  const seen = new Set();
  return lists
    .flat()
    .filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)))
    .sort((a, b) => b.date - a.date)
    .slice(0, max);
}

module.exports = { newsUrl, parseNews, plainText, firstImage, mergeFeeds, CLAN_IMAGES };
