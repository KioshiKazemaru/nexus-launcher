'use strict';
// Friends of the connected accounts, in one shape for the window:
//   { id, name, avatar, status: 'ingame'|'online'|'away'|'offline'|'unknown', game }
// Steam gives the status ("В игре: …" when the friend's profile allows it);
// Epic gives only the list: presence is not available to other programs.

const cheerio = require('cheerio');
const { imageUrl } = require('./providers.cjs');

const STEAM_ID = /^7656119\d{10}$/;

// IFriendsListService/GetFriendsList → friend ids (relationship 3 = friend).
function parseSteamFriendIds(json) {
  const list = json?.response?.friendslist?.friends;
  if (!Array.isArray(list)) throw Error('Steam не отдал список друзей');
  return list
    .filter(f => Number(f?.efriendrelationship) === 3 && STEAM_ID.test(String(f.ulfriendid)))
    .map(f => String(f.ulfriendid));
}

// ISteamUser/GetPlayerSummaries → friends with status.
// personastate: 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 trade, 6 play.
function parseSteamSummaries(json) {
  const players = json?.response?.players;
  if (!Array.isArray(players)) throw Error('Steam не отдал профили друзей');
  return players
    .filter(p => STEAM_ID.test(String(p?.steamid)))
    .map(p => {
      const game = typeof p.gameextrainfo === 'string' ? p.gameextrainfo.slice(0, 120) : '';
      const state = Number(p.personastate) || 0;
      const status =
        game || p.gameid
          ? 'ingame'
          : state === 0
            ? 'offline'
            : state === 3 || state === 4
              ? 'away'
              : 'online';
      return {
        id: String(p.steamid),
        name: String(p.personaname || p.steamid).slice(0, 100),
        avatar: imageUrl(p.avatarmedium || p.avatar || '') || '',
        status,
        game,
        lastOnline: Number(p.lastlogoff) ? Number(p.lastlogoff) * 1000 : null,
      };
    });
}

// Fallback: the friends page of Steam Community (signed in as the user).
function parseSteamFriendsPage(html) {
  const $ = cheerio.load(String(html || ''));
  const out = [];
  $('.friend_block_v2[data-steamid]').each((_i, el) => {
    const b = $(el);
    const id = String(b.attr('data-steamid'));
    if (!STEAM_ID.test(id)) return;
    const cls = b.attr('class') || '';
    const small = b.find('.friend_small_text').first().text().replace(/\s+/g, ' ').trim();
    const status = /\bin-game\b/.test(cls) ? 'ingame' : /\bonline\b/.test(cls) ? 'online' : 'offline';
    out.push({
      id,
      name: b.find('.friend_block_content').first().contents().first().text().trim().slice(0, 100) || id,
      avatar: imageUrl(b.find('.player_avatar img').attr('src') || '') || '',
      status,
      // "В игре" + game name on the second line of the block.
      game: status === 'ingame' ? small.replace(/^(в игре|in-game|in game)\s*/i, '').slice(0, 120) : '',
      lastOnline: null,
    });
  });
  return out;
}

// Epic friends summary → account ids of accepted friends.
function parseEpicFriendIds(json) {
  const list = json?.friends;
  if (!Array.isArray(list)) throw Error('Epic не отдал список друзей');
  return list.map(f => String(f?.accountId || '')).filter(id => /^[a-f0-9]{32}$/i.test(id));
}
// Epic account lookup → names.
function parseEpicAccounts(list) {
  if (!Array.isArray(list)) return new Map();
  return new Map(
    list
      .filter(a => /^[a-f0-9]{32}$/i.test(String(a?.id || '')))
      .map(a => [String(a.id), String(a.displayName || '').slice(0, 100)])
  );
}

const ORDER = { ingame: 0, online: 1, away: 2, unknown: 3, offline: 4 };
function sortFriends(list) {
  return [...list].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' })
  );
}

module.exports = {
  parseSteamFriendIds,
  parseSteamSummaries,
  parseSteamFriendsPage,
  parseEpicFriendIds,
  parseEpicAccounts,
  sortFriends,
};
