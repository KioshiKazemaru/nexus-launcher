'use strict';
// "Параметры запуска" of a game, like Steam's game properties: extra
// command-line arguments given to the game when Nexus starts it.

const MAX = 500;

// Cleans what the user typed: one line, no control characters, limited length.
function cleanOptions(text) {
  const s = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (s.length > MAX) throw Error(`Параметры запуска длиннее ${MAX} символов`);
  return s;
}

// "-novid -w 1920 "C:\My Mods"" → ['-novid', '-w', '1920', 'C:\My Mods'] (quotes group words).
function splitArgs(text) {
  const out = [];
  let cur = '',
    quoted = false,
    has = false;
  for (const ch of String(text || '')) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function optionsFor(settings, gameId) {
  const v = settings?.launchOptions?.[gameId];
  return typeof v === 'string' ? v : '';
}

// Steam with the client already running: steam://run/<appid>//<args>/ asks
// Steam to start the game with these arguments.
function steamRunUri(appId, text) {
  return `steam://run/${appId}//${encodeURIComponent(text)}/`;
}

module.exports = { cleanOptions, splitArgs, optionsFor, steamRunUri, MAX };
