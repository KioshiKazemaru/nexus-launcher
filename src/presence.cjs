'use strict';
// Status like the Steam client: my status for the friends, the friends'
// status in real time and the friends' activity (who started what, when).
// Pure helpers; the service is main/presence.cjs.

const STATUSES = ['online', 'away', 'invisible', 'off'];
const STATUS_LABELS = {
  online: 'В сети',
  away: 'Нет на месте',
  invisible: 'Невидимка',
  off: 'Не подключаться',
};
// Steam's EPersonaState.
const STEAM_PERSONA = { online: 1, away: 3, invisible: 7 };

function checkStatus(v) {
  if (!STATUSES.includes(v)) throw Error('Неизвестный статус');
  return v;
}

// A persona of steam-user ('user' event) → { status, game, appId, name, avatar }.
// persona_state: 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 trade, 6 play, 7 invisible.
function steamPersona(user, gameName = '') {
  const state = Number(user?.persona_state) || 0;
  const appId = Number(user?.gameid || user?.game_played_app_id || 0);
  const named = typeof user?.game_name === 'string' ? user.game_name.slice(0, 120) : '';
  const playing = state !== 0 && (appId > 0 || !!named);
  const avatar =
    typeof user?.avatar_url_medium === 'string' && /^https:\/\//.test(user.avatar_url_medium)
      ? user.avatar_url_medium
      : '';
  return {
    status: playing ? 'ingame' : state === 0 ? 'offline' : state === 3 || state === 4 ? 'away' : 'online',
    game: playing ? named || gameName : '',
    // Non-Steam games have a 64-bit "game id" with no Steam app behind it.
    appId: playing && appId > 0 && appId < 2 ** 32 ? appId : 0,
    name: typeof user?.player_name === 'string' ? user.player_name.slice(0, 100) : '',
    avatar,
  };
}

// What changed for a friend: [] or events { type: 'online'|'game'|'stop' }.
function changes(old, now) {
  if (!old) return [];
  const out = [];
  if (old.status === 'offline' && now.status !== 'offline') out.push({ type: 'online' });
  const oldGame = old.status === 'ingame' ? old.game || String(old.appId || '') : '';
  const newGame = now.status === 'ingame' ? now.game || String(now.appId || '') : '';
  if (newGame && newGame !== oldGame) out.push({ type: 'game', game: now.game, appId: now.appId });
  else if (!newGame && oldGame) out.push({ type: 'stop', game: old.game, appId: old.appId });
  return out;
}

// Activity feed: newest first, at most `max`, nothing older than a week.
const WEEK = 7 * 24 * 3600 * 1000;
function addActivity(list, entry, now = Date.now(), max = 300) {
  const clean = (Array.isArray(list) ? list : []).filter(x => x && now - x.at < WEEK);
  // The same friend switching back and forth within a minute is one entry.
  const dup = clean.findIndex(
    x =>
      x.friendId === entry.friendId &&
      x.type === entry.type &&
      x.game === entry.game &&
      Math.abs(x.at - entry.at) < 60000
  );
  if (dup >= 0) return clean;
  return [entry, ...clean].slice(0, max);
}

// "Играет в … через Nexus": Steam friends see a non-Steam game with this name.
function playingName(game) {
  return `${String(game || '').slice(0, 60)} · Nexus`;
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  STEAM_PERSONA,
  checkStatus,
  steamPersona,
  changes,
  addActivity,
  playingName,
  WEEK,
};
