'use strict';
// "Профиль": the connected accounts (Steam level and badges) and statistics
// of the library: games, hours, the most played games, latest achievements.

// Library games → statistics for the profile page.
function libraryStats(games, now = Date.now()) {
  const list = (Array.isArray(games) ? games : []).filter(g => g && Array.isArray(g.offers));
  const owned = p =>
    list.filter(g => g.offers.some(o => o.provider === p && (o.owned || o.installed))).length;
  const minutes = p =>
    list.reduce(
      (n, g) => n + Math.max(0, ...g.offers.filter(o => o.provider === p).map(o => Number(o.playtime) || 0)),
      0
    );
  // Launched: has playtime, or a launch date (known from local files even before sign-in).
  const played = list.filter(g => Number(g.playtime) > 0 || Number(g.lastPlayed) > 0);
  const total = list.reduce((n, g) => n + (Number(g.playtime) || 0), 0);
  const month = list.filter(g => (Number(g.lastPlayed) || 0) * 1000 > now - 30 * 24 * 3600 * 1000).length;
  return {
    games: list.length,
    installed: list.filter(g => g.offers.some(o => o.installed)).length,
    played: played.length,
    neverPlayed: list.length - played.length,
    minutes: total,
    byProvider: {
      steam: { games: owned('steam'), minutes: minutes('steam') },
      epic: { games: owned('epic'), minutes: minutes('epic') },
      custom: { games: owned('custom'), minutes: minutes('custom') },
    },
    playedThisMonth: month,
    top: played
      .filter(g => Number(g.playtime) > 0)
      .sort((a, b) => b.playtime - a.playtime)
      .slice(0, 10)
      .map(g => ({ id: g.id, name: g.name, minutes: Number(g.playtime) || 0, steam: g.steam || '' })),
  };
}

// The newest unlocked achievements in the cached achievement lists.
function latestAchievements(entries, gameName, max = 12) {
  const out = [];
  for (const [key, hit] of entries) {
    const v = hit?.value;
    if (!v?.available) continue;
    const appId = String(key).split(':')[1];
    for (const a of v.list || [])
      if (a.unlocked && a.unlockedAt)
        out.push({
          name: a.name,
          description: a.description,
          icon: a.icon,
          at: a.unlockedAt * 1000,
          game: gameName(appId),
        });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}

// IPlayerService/GetBadges → { level, xp, badges, xpNeeded }.
function parseBadges(json) {
  const r = json?.response;
  if (!r || typeof r !== 'object') return null;
  return {
    level: Number(r.player_level) || 0,
    xp: Number(r.player_xp) || 0,
    badges: Array.isArray(r.badges) ? r.badges.length : 0,
    xpNeeded: Number(r.player_xp_needed_to_level_up) || 0,
    xpCurrent: Number(r.player_xp_needed_current_level) || 0,
  };
}

// The Epic Games side of the library for the Epic profile tab.
function epicStats(games) {
  const list = (Array.isArray(games) ? games : []).filter(g => g && Array.isArray(g.offers));
  const rows = list
    .map(g => {
      const o = g.offers.filter(x => x.provider === 'epic' && (x.owned || x.installed));
      if (!o.length) return null;
      // Some Epic games keep an id as the name of the merged game: the offer has the title.
      const titled = o.find(x => x.name && !/^[0-9a-f]{20,}$/i.test(x.name))?.name;
      return {
        id: g.id,
        name: /^[0-9a-f]{20,}$/i.test(g.name || '') ? titled || g.name : g.name,
        installed: o.some(x => x.installed),
        minutes: Math.max(0, ...o.map(x => Number(x.playtime) || 0)),
        lastPlayed: Math.max(0, ...o.map(x => Number(x.lastPlayed) || 0)),
      };
    })
    .filter(Boolean);
  // lastPlayed is in seconds (as Steam's); shown in milliseconds.
  const ms = t => (t > 1e12 ? t : t * 1000);
  return {
    games: rows.length,
    installed: rows.filter(x => x.installed).length,
    minutes: rows.reduce((n, x) => n + x.minutes, 0),
    played: rows.filter(x => x.minutes > 0 || x.lastPlayed > 0).length,
    top: rows
      .filter(x => x.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 10)
      .map(({ id, name, minutes }) => ({ id, name, minutes })),
    recent: rows
      .filter(x => x.lastPlayed > 0)
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .slice(0, 6)
      .map(({ id, name, minutes, lastPlayed }) => ({ id, name, minutes, lastPlayed: ms(lastPlayed) })),
  };
}
// The games behind a label of my profile: 'owned' | 'installed' | 'played',
// of all stores or one ('steam' | 'epic'); most played first, like Steam's list.
function libraryList(games, kind = 'owned', source = 'all') {
  const list = (Array.isArray(games) ? games : []).filter(g => g && Array.isArray(g.offers));
  const of = g => (source === 'all' ? g.offers : g.offers.filter(o => o.provider === source));
  return list
    .filter(g => {
      const offers = of(g);
      if (!offers.length) return false;
      if (kind === 'installed') return offers.some(o => o.installed);
      if (kind === 'played') return Number(g.playtime) > 0 || Number(g.lastPlayed) > 0;
      return source === 'all' || offers.some(o => o.owned || o.installed);
    })
    .map(g => ({
      id: g.id,
      name: g.name || '',
      minutes:
        source === 'all' ? Number(g.playtime) || 0 : Math.max(0, ...of(g).map(o => Number(o.playtime) || 0)),
      lastPlayed: Number(g.lastPlayed) > 0 ? Number(g.lastPlayed) * 1000 : null,
      installed: of(g).some(o => o.installed),
      steam: g.steam ? String(g.steam) : '',
      image: typeof g.image === 'string' ? g.image : '',
    }))
    .sort(
      (a, b) =>
        b.minutes - a.minutes || (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.name.localeCompare(b.name)
    );
}

module.exports = { libraryStats, libraryList, latestAchievements, parseBadges, epicStats };
