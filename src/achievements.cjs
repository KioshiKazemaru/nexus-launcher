'use strict';
// Steam achievements of the signed-in account.
//  1. ISteamUserStats/GetPlayerAchievements with the session token (names and
//     unlock times, localized).
//  2. Community stats page in XML (adds icons; needs the game list to be
//     visible to the signed-in user, which is always true for one's own profile).
// Epic Games has no public achievements API for third-party launchers.

const cdata = s =>
  String(s || '')
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .trim();
const tag = (xml, name) => cdata((new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml) || [])[1]);
const safeIcon = url =>
  /^https:\/\/(?:cdn\.(?:akamai|cloudflare)\.steamstatic\.com|steamcdn-a\.akamaihd\.net|shared\.[a-z.]*steamstatic\.com)\//.test(
    url
  )
    ? url
    : '';

function parseApiAchievements(json) {
  const stats = json?.playerstats;
  if (!stats || stats.success === false) throw Error(stats?.error || 'Steam не вернул достижения');
  const list = Array.isArray(stats.achievements) ? stats.achievements : [];
  return list
    .filter(a => typeof a?.apiname === 'string')
    .map(a => ({
      id: a.apiname.slice(0, 120),
      name: String(a.name || a.apiname).slice(0, 200),
      description: String(a.description || '').slice(0, 400),
      unlocked: a.achieved === 1 || a.achieved === true,
      unlockedAt: Number(a.unlocktime) || 0,
      icon: '',
    }));
}

function parseXmlAchievements(xml) {
  if (typeof xml !== 'string' || !/<playerstats>/.test(xml))
    throw Error('Steam не открыл страницу достижений');
  if (/<error>/.test(xml)) throw Error(tag(xml, 'error') || 'Steam не открыл страницу достижений');
  const out = [];
  for (const m of xml.matchAll(/<achievement closed="(\d)">([\s\S]*?)<\/achievement>/g)) {
    const body = m[2];
    const unlocked = m[1] === '1';
    out.push({
      id: tag(body, 'apiname').slice(0, 120),
      name: tag(body, 'name').slice(0, 200),
      description: tag(body, 'description').slice(0, 400),
      unlocked,
      unlockedAt: Number(tag(body, 'unlockTimestamp')) || 0,
      icon: safeIcon(tag(body, unlocked ? 'iconClosed' : 'iconOpen')),
    });
  }
  return out;
}

// Icons from the XML page are merged into the API list by api name.
function mergeAchievements(api, xml) {
  if (!api?.length) return xml || [];
  const icons = new Map((xml || []).map(a => [a.id, a.icon]));
  return api.map(a => ({ ...a, icon: a.icon || icons.get(a.id) || '' }));
}

function summarize(list) {
  const unlocked = list.filter(a => a.unlocked).length;
  return {
    total: list.length,
    unlocked,
    percent: list.length ? Math.round((unlocked / list.length) * 100) : 0,
  };
}

module.exports = { parseApiAchievements, parseXmlAchievements, mergeAchievements, summarize };
