'use strict';
// Steam Families (Семейная библиотека Steam).
//
// Steam installs a game only when the PC's signed-in user can play it, but that
// right may come from another member of the family. Nexus must not count such
// games as the user's own. Two unofficial Web API methods tell them apart; both
// take the same session token (webapi_token) as IPlayerService/GetOwnedGames:
//   IFamilyGroupsService/GetFamilyGroupForUser → the family id (or "no family");
//   IFamilyGroupsService/GetSharedLibraryApps  → the family's apps with owner_steamids.
//
// Every Steam offer gets a library source:
//   own          the connected account owns it (GetOwnedGames or another account list);
//   family       another family member owns it (owners in familyOwners);
//   unconfirmed  installed, but found neither in the account list nor in the family;
//   local        installed and no Steam account is connected: «Найдено на ПК».

const STEAM_ID = /^7656119\d{10}$/;
const API = 'https://api.steampowered.com/IFamilyGroupsService/';

// The ids come as strings (uint64); a number has lost precision and is not trusted.
const steamId = v => (typeof v === 'string' && STEAM_ID.test(v) ? v : '');

function parseFamilyGroup(json) {
  const r = json?.response;
  if (!r || typeof r !== 'object') throw Error('Steam не вернул сведения о семье');
  const raw = r.family_groupid;
  const groupId = /^\d{1,20}$/.test(String(raw ?? '')) && String(raw) !== '0' ? String(raw) : '';
  const members = (Array.isArray(r.family_group?.members) ? r.family_group.members : [])
    .map(m => steamId(m?.steamid))
    .filter(Boolean);
  return {
    groupId: r.is_not_member_of_any_group === true ? '' : groupId,
    name: typeof r.family_group?.name === 'string' ? r.family_group.name.slice(0, 100) : '',
    members,
  };
}

// → { appId: { owners: [steamid], name } }. Apps the family cannot share
// (exclude_reason ≠ 0) are left out.
function parseSharedApps(json) {
  const apps = json?.response?.apps;
  if (!Array.isArray(apps)) {
    if (json?.response && typeof json.response === 'object' && !('apps' in json.response)) return {};
    throw Error('Steam не вернул общую библиотеку семьи');
  }
  const out = {};
  for (const a of apps) {
    if (!/^\d+$/.test(String(a?.appid))) continue;
    if (Number(a.exclude_reason) > 0) continue;
    const owners = [
      ...new Set((Array.isArray(a.owner_steamids) ? a.owner_steamids : []).map(steamId)),
    ].filter(Boolean);
    out[String(a.appid)] = { owners, name: typeof a.name === 'string' ? a.name.slice(0, 200) : '' };
  }
  return out;
}

async function familyCall(fetcher, method, token, params) {
  const u = new URL(API + method + '/v1/');
  u.search = new URLSearchParams({ access_token: token, ...params });
  const r = await fetcher(u.href, {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const e = Error(`Steam ${method}: HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// The family of an account and the apps it shares. No family → empty apps.
async function fetchFamily(fetcher, token, accountId) {
  const group = parseFamilyGroup(
    await familyCall(fetcher, 'GetFamilyGroupForUser', token, {
      steamid: accountId,
      include_family_group_response: 'true',
    })
  );
  if (!group.groupId) return { groupId: '', name: '', members: [], apps: {} };
  const apps = parseSharedApps(
    await familyCall(fetcher, 'GetSharedLibraryApps', token, {
      family_groupid: group.groupId,
      steamid: accountId,
      include_own: 'true',
      include_excluded: 'false',
      include_free: 'false',
      include_non_games: 'false',
      language: 'russian',
    })
  );
  return { ...group, apps };
}

// Library source of every offer and game, in place.
//   active    Set of connected (or offline-verified) Steam account ids;
//   family    Map appId → { owners } joined over those accounts;
//   names     Map steamid → nickname.
function classifyLibrary(games, { active = new Set(), family = new Map(), names = new Map() } = {}) {
  for (const g of games) {
    for (const o of g.offers || []) {
      delete o.familyOwners;
      if (o.provider !== 'steam') {
        o.librarySource = 'own';
        continue;
      }
      const ids = o.accountIds?.length ? o.accountIds : o.accountId ? [o.accountId] : [];
      if (!active.size) o.librarySource = 'local';
      else if (o.owned === true && ids.some(id => active.has(id))) o.librarySource = 'own';
      else {
        const shared = family.get(String(o.appId));
        const owners = (shared?.owners || []).filter(id => !active.has(id));
        if (shared && (owners.length || !shared.owners.length)) {
          o.librarySource = 'family';
          o.familyOwners = owners.map(id => ({ id, name: names.get(id) || '' }));
        } else o.librarySource = 'unconfirmed';
      }
    }
    g.librarySource = gameSource(g);
  }
  return games;
}

const RANK = ['own', 'family', 'unconfirmed', 'local'];
function gameSource(g) {
  const list = (g.offers || []).map(o => o.librarySource || 'own');
  return RANK.find(s => list.includes(s)) || 'own';
}

module.exports = { parseFamilyGroup, parseSharedApps, fetchFamily, classifyLibrary, gameSource, STEAM_ID };
