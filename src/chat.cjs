'use strict';
// Chat protocols without the official clients (pure functions; the
// connections live in main/chat.cjs).
//   Steam: Web API IFriendMessagesService with the session token Nexus already
//          has: history, sending, unread sessions (polled).
//   Epic:  the XMPP chat of the Epic launcher (wss://xmpp-service-prod…) with
//          the account token: messages and friends' presence in real time.
//          Epic keeps no history on its servers: Nexus stores it locally.

const STEAM_BASE = 76561197960265728n;
const STEAM_ID = /^7656119\d{10}$/;
const EPIC_ID = /^[0-9a-f]{32}$/i;
const EPIC_DOMAIN = 'prod.ol.epicgames.com';
const MAX_TEXT = 2000;

const steamId32 = id64 => String(BigInt(id64) - STEAM_BASE);
const steamId64 = id32 => String(BigInt(id32) + STEAM_BASE);

// A conversation: one of my accounts with one friend.
function convKey(provider, accountId, friendId) {
  return `${provider}|${accountId}|${friendId}`;
}
function parseConvKey(key) {
  const [provider, accountId, friendId] = String(key || '').split('|');
  if (provider === 'steam' && STEAM_ID.test(accountId) && STEAM_ID.test(friendId))
    return { provider, accountId, friendId };
  if (provider === 'epic' && EPIC_ID.test(accountId) && EPIC_ID.test(friendId))
    return { provider, accountId, friendId };
  return null;
}

function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_TEXT);
}

// Steam chat BBCode → plain text: emoticons as :name:, links and stickers readable.
function steamText(message) {
  return cleanText(
    String(message ?? '')
      // Escaped brackets are text: kept aside while the tags are read.
      .replace(/\\\[/g, '')
      .replace(/\[emoticon\]([^[]*)\[\/emoticon\]/gi, ':$1:')
      .replace(/\[emoticon name="?([^"\]]*)"?\]\[\/emoticon\]/gi, ':$1:')
      .replace(/\[sticker type="?([^"\]]*)"?[^\]]*\]\[\/sticker\]/gi, '[стикер $1]')
      .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/gi, '$2 ($1)')
      .replace(/\[img\]([^[]*)\[\/img\]/gi, '$1')
      .replace(
        /\[(\/?)(b|i|u|s|code|quote|spoiler|lobbyinvite|gameinvite|random|flip)(?=[\s=\]])[^\]]*\]/gi,
        ''
      )
      .replace(/\\\]/g, ']')
      .replace(//g, '[')
  );
}
// Plain text → Steam message: square brackets are escaped so they are not BBCode.
const steamEscape = text => cleanText(text).replace(/\[/g, '\\[');

// IFriendMessagesService/GetRecentMessages → [{ from: 'me'|'them', text, at }] (oldest first).
function parseSteamMessages(json, myId64) {
  const list = json?.response?.messages;
  if (!Array.isArray(list)) return [];
  const me = steamId32(myId64);
  return list
    .filter(m => m && typeof m.message === 'string' && Number(m.timestamp))
    .map(m => ({
      from: String(m.accountid) === me ? 'me' : 'them',
      text: steamText(m.message),
      at: Number(m.timestamp) * 1000,
      ordinal: Number(m.ordinal) || 0,
    }))
    .filter(m => m.text)
    .sort((a, b) => a.at - b.at || a.ordinal - b.ordinal);
}
// GetActiveMessageSessions → [{ friendId (64-bit), last (ms), unread }]
function parseSteamSessions(json) {
  const list = json?.response?.message_sessions;
  if (!Array.isArray(list)) return [];
  return list
    .filter(s => Number(s?.accountid_friend))
    .map(s => ({
      friendId: steamId64(s.accountid_friend),
      last: Number(s.last_message) * 1000 || 0,
      unread: Number(s.unread_message_count) || 0,
    }));
}

// ---- XMPP (Epic) ---------------------------------------------------------------
const xmlEscape = s =>
  String(s ?? '').replace(
    /[<>&"']/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]
  );
const xmlUnescape = s =>
  String(s ?? '').replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e) => {
    const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
    if (named) return named;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
function attrs(tag) {
  const out = {};
  for (const m of String(tag).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    out[m[1]] = xmlUnescape(m[2] ?? m[3]);
  return out;
}
const child = (xml, name) => {
  const m = String(xml).match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? xmlUnescape(m[1]) : null;
};
const bareId = jid => String(jid || '').split('@')[0];

// One stanza (as framed by the WebSocket) → a small object.
function parseStanza(xml) {
  const x = String(xml || '').trim();
  const open = x.match(/^<([\w:]+)([^>]*?)\/?>/);
  if (!open) return null;
  const name = open[1],
    a = attrs(open[2]);
  const base = { name, id: a.id || '', from: a.from || '', to: a.to || '', type: a.type || '', raw: x };
  if (name === 'message') return { ...base, body: child(x, 'body') };
  if (name === 'presence') return { ...base, status: child(x, 'status'), show: child(x, 'show') };
  if (name === 'iq')
    return { ...base, ping: /<ping\s[^>]*xmlns=["']urn:xmpp:ping["']/.test(x), bind: /<bind[\s>]/.test(x) };
  return base;
}

// Epic presence → { status, game } like Steam's: 'ingame' | 'online' | 'away' | 'offline'.
function epicPresence(p) {
  if (!p || p.type === 'unavailable') return { status: 'offline', game: '' };
  let info = {};
  try {
    info = JSON.parse(p.status || '{}') || {};
  } catch {
    info = { Status: p.status || '' };
  }
  const text = typeof info.Status === 'string' ? info.Status.slice(0, 120) : '';
  const away = p.show === 'away' || p.show === 'xa' || p.show === 'dnd';
  if (info.bIsPlaying) return { status: 'ingame', game: text };
  return { status: away ? 'away' : 'online', game: '' };
}

const xmpp = {
  open: () => `<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="${EPIC_DOMAIN}" version="1.0"/>`,
  close: () => '<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>',
  auth: (accountId, token) =>
    `<auth xmlns="urn:ietf:params:xml:ns:xmpp-sasl" mechanism="PLAIN">${Buffer.from(`\0${accountId}\0${token}`).toString('base64')}</auth>`,
  bind: (id, resource) =>
    `<iq type="set" id="${id}" xmlns="jabber:client"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><resource>${xmlEscape(resource)}</resource></bind></iq>`,
  presence: (status = 'Nexus') =>
    `<presence xmlns="jabber:client"><status>${xmlEscape(
      JSON.stringify({
        Status: status,
        bIsPlaying: false,
        bIsJoinable: false,
        bHasVoiceSupport: false,
        SessionId: '',
        Properties: {},
      })
    )}</status></presence>`,
  message: (friendId, text, id) =>
    `<message xmlns="jabber:client" type="chat" id="${id}" to="${friendId}@${EPIC_DOMAIN}"><body>${xmlEscape(cleanText(text))}</body></message>`,
  ping: id => `<iq xmlns="jabber:client" type="get" id="${id}"><ping xmlns="urn:xmpp:ping"/></iq>`,
  pong: (id, to) => `<iq xmlns="jabber:client" type="result" id="${xmlEscape(id)}" to="${xmlEscape(to)}"/>`,
};

// Local history: newest last, limited per conversation.
function addToHistory(list, msg, max = 300) {
  const next = Array.isArray(list) ? list.slice() : [];
  // The same message from two sources (sent here + polled back) is kept once.
  if (next.some(m => m.from === msg.from && m.text === msg.text && Math.abs(m.at - msg.at) < 60000))
    return next;
  next.push(msg);
  next.sort((a, b) => a.at - b.at);
  return next.slice(-max);
}
function mergeHistory(local, remote, max = 300) {
  return (remote || []).reduce((list, m) => addToHistory(list, m, max), Array.isArray(local) ? local : []);
}

module.exports = {
  STEAM_ID,
  EPIC_ID,
  EPIC_DOMAIN,
  MAX_TEXT,
  steamId32,
  steamId64,
  convKey,
  parseConvKey,
  cleanText,
  steamText,
  steamEscape,
  parseSteamMessages,
  parseSteamSessions,
  xmlEscape,
  xmlUnescape,
  parseStanza,
  bareId,
  epicPresence,
  xmpp,
  addToHistory,
  mergeHistory,
};
