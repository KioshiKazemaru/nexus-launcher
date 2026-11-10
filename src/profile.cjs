'use strict';
// "Профиль": the connected accounts (Steam level and badges) and statistics
// of the library: games, hours, the most played games, latest achievements.

// What an offer adds to the profile: 'own' (the account's), 'family' (Steam
// Families) or null. Installed Steam games found without a connected account
// ('local') and those Steam did not confirm ('unconfirmed') are not counted.
function offerShare(o) {
  if (!o) return null;
  if (o.provider === 'steam') {
    if (o.librarySource === 'family') return 'family';
    if (o.librarySource === 'local' || o.librarySource === 'unconfirmed') return null;
    return o.owned || o.installed ? 'own' : null;
  }
  return o.owned || o.installed || o.provider === 'custom' ? 'own' : null;
}
// own wins over family when a game is both.
function gameShare(g, provider) {
  const shares = (g.offers || []).filter(o => !provider || o.provider === provider).map(offerShare);
  return shares.includes('own') ? 'own' : shares.includes('family') ? 'family' : null;
}

// Library games → statistics for the profile page.
// games / byProvider.*.games count the account's own games; family counts
// Steam Families games apart; launches and hours cover both.
function libraryStats(games, now = Date.now()) {
  const all = (Array.isArray(games) ? games : []).filter(g => g && Array.isArray(g.offers));
  const list = all.filter(g => gameShare(g));
  const own = list.filter(g => gameShare(g) === 'own');
  const counted = (g, p) => g.offers.filter(o => o.provider === p && offerShare(o));
  const byProvider = p => ({
    games: list.filter(g => gameShare(g, p) === 'own').length,
    family: list.filter(g => gameShare(g, p) === 'family').length,
    minutes: list.reduce((n, g) => n + Math.max(0, ...counted(g, p).map(o => Number(o.playtime) || 0)), 0),
  });
  // Launched: has playtime, or a launch date.
  const played = list.filter(g => Number(g.playtime) > 0 || Number(g.lastPlayed) > 0);
  const total = list.reduce((n, g) => n + (Number(g.playtime) || 0), 0);
  const month = list.filter(g => (Number(g.lastPlayed) || 0) * 1000 > now - 30 * 24 * 3600 * 1000).length;
  return {
    games: own.length,
    family: list.length - own.length,
    // Installed Steam games the library cannot count (no account, or not confirmed).
    foundOnPc: all.filter(g => !gameShare(g) && g.offers.some(o => o.installed)).length,
    unconfirmed: all.filter(g => g.librarySource === 'unconfirmed').length,
    installed: list.filter(g => g.offers.some(o => o.installed && offerShare(o))).length,
    played: played.length,
    neverPlayed: list.length - played.length,
    minutes: total,
    byProvider: { steam: byProvider('steam'), epic: byProvider('epic'), custom: byProvider('custom') },
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
// The games behind a label of my profile: 'owned' | 'family' | 'installed' | 'played',
// of all stores or one ('steam' | 'epic'); most played first, like Steam's list.
function libraryList(games, kind = 'owned', source = 'all') {
  const list = (Array.isArray(games) ? games : []).filter(g => g && Array.isArray(g.offers));
  // Only what the profile counts (see offerShare): never games merely found on the PC.
  const of = g => g.offers.filter(o => (source === 'all' || o.provider === source) && offerShare(o));
  return list
    .filter(g => {
      const offers = of(g);
      if (!offers.length) return false;
      if (kind === 'installed') return offers.some(o => o.installed);
      if (kind === 'played') return Number(g.playtime) > 0 || Number(g.lastPlayed) > 0;
      // «Игр в библиотеке» lists the account's own games, «из семьи» the shared ones.
      const share = gameShare(g, source === 'all' ? '' : source);
      return kind === 'family' ? share === 'family' : share === 'own';
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

module.exports = { libraryStats, libraryList, offerShare, latestAchievements, parseBadges, epicStats };
