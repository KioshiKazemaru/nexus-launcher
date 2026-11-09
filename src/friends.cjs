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

// IPlayerService/GetPlayerLinkDetails → friends with status. Unlike
// ISteamUser/GetPlayerSummaries it takes the session token (GetPlayerSummaries
// wants a developer key: HTTP 400 "Required parameter 'key' is missing").
// The avatar is a base64 SHA-1; the game comes as an app id only (gameId).
const NO_AVATAR = '0000000000000000000000000000000000000000';
function avatarFromDigest(digest) {
  const hex = Buffer.from(String(digest || ''), 'base64').toString('hex');
  return /^[0-9a-f]{40}$/.test(hex) && hex !== NO_AVATAR
    ? `https://avatars.steamstatic.com/${hex}_medium.jpg`
    : '';
}
function parseSteamLinkDetails(json) {
  const accounts = json?.response?.accounts;
  if (!Array.isArray(accounts)) throw Error('Steam не отдал профили друзей');
  return accounts
    .filter(a => STEAM_ID.test(String(a?.public_data?.steamid)))
    .map(({ public_data: pub, private_data: priv = {} }) => {
      const state = Number(priv.persona_state) || 0;
      const gameId = Number(priv.game_id) > 0 ? String(priv.game_id) : '';
      const game = typeof priv.game_extra_info === 'string' ? priv.game_extra_info.slice(0, 120) : '';
      const status =
        gameId || game ? 'ingame' : state === 0 ? 'offline' : state === 3 || state === 4 ? 'away' : 'online';
      const off = Number(priv.last_logoff_time) || Number(priv.last_seen_online) || 0;
      return {
        id: String(pub.steamid),
        name: String(pub.persona_name || pub.steamid).slice(0, 100),
        avatar: avatarFromDigest(pub.sha_digest_avatar),
        status,
        game,
        gameId,
        lastOnline: off ? off * 1000 : null,
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

// IPlayerService/GetOwnedGames of a friend → games with playtime. A profile
// whose game details are hidden answers with an empty response: hidden.
function parseOwnedGames(json) {
  const r = json?.response;
  if (!r || typeof r !== 'object') throw Error('Steam не отдал игры профиля');
  if (!Array.isArray(r.games)) return { hidden: true, count: 0, minutes: 0, games: [] };
  const games = r.games
    .filter(g => Number(g?.appid) > 0)
    .map(g => ({
      appId: String(g.appid),
      name: String(g.name || '').slice(0, 200),
      minutes: Math.max(0, Number(g.playtime_forever) || 0),
      lastPlayed: Number(g.rtime_last_played) > 0 ? Number(g.rtime_last_played) * 1000 : null,
    }));
  return {
    hidden: false,
    count: Number(r.game_count) || games.length,
    minutes: games.reduce((n, g) => n + g.minutes, 0),
    games,
  };
}
// IPlayerService/GetRecentlyPlayedGames → the last two weeks.
function parseRecentGames(json) {
  const list = json?.response?.games;
  if (!Array.isArray(list)) return [];
  return list
    .filter(g => Number(g?.appid) > 0)
    .map(g => ({
      appId: String(g.appid),
      name: String(g.name || '').slice(0, 200),
      minutes2w: Math.max(0, Number(g.playtime_2weeks) || 0),
      minutes: Math.max(0, Number(g.playtime_forever) || 0),
    }));
}

// steamcommunity.com/profiles/<id>/?xml=1 → the parts of the profile page
// the Web API does not give: real name, location, "О себе", member since.
// The summary is HTML written by the person: only its text and line breaks are kept.
function parseSteamProfileXml(xml) {
  const $ = cheerio.load(String(xml || ''), { xml: true });
  if (!$('profile').length) return null;
  const text = sel =>
    $('profile > ' + sel)
      .first()
      .text()
      .trim();
  const summaryHtml = text('summary')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n');
  const doc = cheerio.load('<body>' + summaryHtml + '</body>');
  doc('script, style').remove();
  const summary = doc('body')
    .text()
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    realName: text('realname').slice(0, 100),
    location: text('location').replace(/\s+/g, ' ').slice(0, 120),
    summary: /^no information given\.?$/i.test(summary) ? '' : summary.slice(0, 3000),
    memberSince: text('memberSince').slice(0, 60),
    privacy: text('privacyState'),
  };
}
// IPlayerService/GetProfileItemsEquipped → the profile background and avatar frame.
// Steam keeps profile items (backgrounds, avatar frames) on its newer CDN; the old path answers 404 for frames.
const COMMUNITY_IMAGES = 'https://shared.akamai.steamstatic.com/community_assets/images/';
function parseProfileItems(json) {
  const r = json?.response || {};
  const img = path =>
    typeof path === 'string' && /^[\w\-./]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(path) && !path.includes('..')
      ? COMMUNITY_IMAGES + path
      : '';
  return {
    background: img(r.profile_background?.image_large),
    frame: img(r.avatar_frame?.image_small) || img(r.avatar_frame?.image_large),
  };
}

// IPlayerService/GetFriendsGameplayInfo (what the Steam client shows as "Играющие друзья"):
// friends in game now, played in the last two weeks, played before, owning it, wishing it.
// Each friend lands in the first of those lists only.
function parseGameplayInfo(json) {
  const r = json?.response;
  if (!r || typeof r !== 'object') throw Error('Steam не отдал друзей по игре');
  const seen = new Set();
  const take = key =>
    (Array.isArray(r[key]) ? r[key] : [])
      .map(x => ({
        id: String(x?.steamid || ''),
        minutes: Number(x?.minutes_played_forever) || 0,
        minutes2w: Number(x?.minutes_played) || 0,
      }))
      .filter(x => /^7656119\d{10}$/.test(x.id) && !seen.has(x.id) && seen.add(x.id));
  return {
    inGame: take('in_game'),
    recent: take('played_recently').sort((a, b) => b.minutes2w - a.minutes2w),
    ever: take('played_ever').sort((a, b) => b.minutes - a.minutes),
    owns: take('owns'),
    wishlist: take('in_wishlist'),
  };
}

// Steam's profile comments (comment/Profile/render and /post answer with comments_html).
const steamImage = u =>
  /^https:\/\/[\w.-]+\.(?:steamstatic\.com|akamaihd\.net)\/[^\s"'<>]*$/.test(u) ? u : '';
const STEAM_ID_BASE = 76561197960265728n;
function parseProfileComments(json) {
  if (!json || typeof json !== 'object') throw Error('Steam не отдал комментарии');
  if (json.success !== true) throw Error(String(json.error || 'Комментарии недоступны').slice(0, 200));
  const $ = cheerio.load(String(json.comments_html || ''));
  const comments = [];
  $('.commentthread_comment').each((_, el) => {
    const c = $(el);
    const id = String(c.attr('id') || '').replace(/^comment_/, '');
    if (!/^\d{1,25}$/.test(id)) return;
    const link = c.find('.commentthread_author_link').first();
    const mini = Number(
      link.attr('data-miniprofile') || c.find('[data-miniprofile]').first().attr('data-miniprofile')
    );
    const authorId = Number.isSafeInteger(mini) && mini > 0 ? String(STEAM_ID_BASE + BigInt(mini)) : '';
    const text = c.find('.commentthread_comment_text').first().clone();
    text.find('br').replaceWith('\n');
    text.find('img').each((_, img) => $(img).replaceWith($(img).attr('alt') || ''));
    // A profile frame comes first (<picture> with its PNG), the avatar last; an
    // animated avatar has its address only in srcset.
    const imgs = c
      .find('.commentthread_comment_avatar img')
      .toArray()
      .map(
        e =>
          String($(e).attr('src') || $(e).attr('srcset') || '')
            .trim()
            .split(/[\s,]+/)[0]
      )
      .filter(Boolean);
    const avatar = imgs.at(-1) || '';
    const frame = imgs.length > 1 ? imgs[0] : '';
    const at =
      Number(c.find('.commentthread_comment_timestamp[data-timestamp]').first().attr('data-timestamp')) || 0;
    comments.push({
      id,
      authorId,
      author: link.text().trim().slice(0, 100) || 'Пользователь Steam',
      avatar: steamImage(avatar),
      frame: steamImage(frame),
      text: text
        .text()
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 5000),
      at: at ? at * 1000 : null,
      canDelete:
        c.find('.commentthread_comment_actions a, .commentthread_comment_actions [onclick]').length > 0,
    });
  });
  return {
    comments,
    total: Number(json.total_count) || comments.length,
    start: Number(json.start) || 0,
  };
}

const ORDER = { ingame: 0, online: 1, away: 2, unknown: 3, offline: 4 };
function sortFriends(list) {
  return [...list].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' })
  );
}

// A page of steamcommunity.com/profiles/<id>/badges/ → badges shown inside Nexus.
function parseBadgePage(html) {
  const $ = cheerio.load(String(html || ''));
  const badges = [];
  $('.badge_row').each((_, el) => {
    const row = $(el);
    const info = row.find('.badge_info_description').first();
    const lines = info
      .children('div')
      .toArray()
      .map(d => $(d).text().replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const title = info.find('.badge_info_title').first().text().replace(/\s+/g, ' ').trim() || lines[0] || '';
    const unlocked = info.find('.badge_info_unlocked').first().text().replace(/\s+/g, ' ').trim();
    const level = lines.find(l => l !== title && l !== unlocked) || '';
    const link = String(row.find('a.badge_row_overlay').first().attr('href') || '');
    const icon = row.find('img.badge_icon').first();
    const game = row.find('.badge_title').first().clone();
    game.find('.badge_view_details').remove();
    if (!title) return;
    badges.push({
      title: title.slice(0, 200),
      level: level.slice(0, 200),
      unlocked: unlocked.slice(0, 200),
      game: game.text().replace(/\s+/g, ' ').trim().slice(0, 200),
      // The icon's address waits in data-delayed-image; src is a transparent placeholder.
      image: steamImage(
        String(
          icon.attr('data-delayed-image') ||
            (/trans\.gif$/.test(icon.attr('src') || '') ? '' : icon.attr('src')) ||
            ''
        )
      ),
      link: /^https:\/\/steamcommunity\.com\/[\w/%.-]+$/.test(link) ? link : '',
    });
  });
  const pages = Math.max(
    1,
    ...$('.pageLinks a, .pageLinks span')
      .toArray()
      .map(e => Number($(e).text().trim()) || 0)
  );
  return { badges, pages, private: $('.profile_private_info').length > 0 };
}

module.exports = {
  parseSteamFriendIds,
  parseSteamLinkDetails,
  avatarFromDigest,
  parseSteamFriendsPage,
  parseEpicFriendIds,
  parseEpicAccounts,
  sortFriends,
  parseOwnedGames,
  parseRecentGames,
  parseSteamProfileXml,
  parseProfileItems,
  parseGameplayInfo,
  parseProfileComments,
  parseBadgePage,
};
