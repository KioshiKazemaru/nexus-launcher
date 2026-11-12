'use strict';
// Addresses of the Nexus browser (main/browser.cjs): what may load in a tab, what goes
// to an installed program, what the address bar turns into a search.

const SEARCH = 'https://duckduckgo.com/?q=';
// Links that start a program instead of a page: Steam, Epic, Heroic, mail.
const APP_PROTOCOLS = new Set(['steam:', 'com.epicgames.launcher:', 'heroic:', 'mailto:']);
// Pages that need the Steam sign-in of Nexus (Workshop, profiles, discussions).
const STEAM_COMMUNITY = /(^|\.)steamcommunity\.com$/;

function parse(value) {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}

// A page a tab may show: http(s) without a user name or password in it, or a blank tab.
function webUrl(value) {
  const u = parse(value);
  if (!u) return null;
  if (u.href === 'about:blank') return u.href;
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return null;
  return u.href;
}

// A link for an installed program (steam://, com.epicgames.launcher://, mailto:).
function appUrl(value) {
  const u = parse(value);
  return u && APP_PROTOCOLS.has(u.protocol) ? u.href : null;
}

// What the address bar means: an address (with or without https://) or a search.
function addressInput(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s === 'about:blank') return webUrl(s);
  // example.com, store.steampowered.com/app/1, localhost:3000
  if (!/\s/.test(s) && /^([\w-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$|^localhost(:\d+)?(\/.*)?$/i.test(s))
    return webUrl('https://' + s);
  return SEARCH + encodeURIComponent(s);
}

// 'steam' for Steam Community pages (they open signed in), '' for everything else.
function siteKind(value) {
  const u = parse(value);
  return u && u.protocol === 'https:' && STEAM_COMMUNITY.test(u.hostname) ? 'steam' : '';
}

module.exports = { webUrl, appUrl, addressInput, siteKind, SEARCH };
