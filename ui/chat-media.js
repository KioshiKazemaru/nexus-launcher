'use strict';
// Links in chat messages: pictures are shown as previews (click → large),
// Steam screenshot pages too, other links open in the browser.
/* exported chatParts, chatImageSrc, CHAT_SHARED */

// The same hosts as img-src in chat.html. Steam's uploaded pictures (ugc) have no
// file extension; elsewhere only links that end in a picture are previews.
const CHAT_UGC = /^https:\/\/(([\w-]+\.)*steamusercontent\.com|steamuserimages-a\.akamaihd\.net)\//;
const CHAT_IMG_HOSTS =
  /^https:\/\/(([\w-]+\.)*steamstatic\.com|steamcdn-a\.akamaihd\.net|i\.imgur\.com|cdn\.discordapp\.com|media\.discordapp\.net|i\.gyazo\.com)\//;
const CHAT_IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)([?#]|$)/i;
// steamcommunity.com/sharedfiles/filedetails/?id=123 (a screenshot or a workshop item).
const CHAT_SHARED = /^https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/?\?(?:[^#\s]*&)?id=(\d{1,20})/;

function chatImageSrc(url) {
  const u = String(url || '');
  if (/[\s"'<>\\]/.test(u)) return '';
  if (CHAT_UGC.test(u)) return u;
  if (CHAT_IMG_HOSTS.test(u) && CHAT_IMG_EXT.test(u)) return u;
  return '';
}

// Text → [{ text } | { url, image } | { url, shared }]. A trailing ")" or "." is not
// part of the link ("текст (https://…)" is how a Steam [url=…] link reads).
function chatParts(text) {
  const out = [];
  // Messages saved by older versions: Steam's picture tag and "url (url)" read once.
  const s = String(text ?? '')
    .replace(/\[img\s[^\]]*?src="?([^"\s\]]+)"?[^\]]*\][\s\S]*?\[\/img\]/gi, ' $1 ')
    .replace(/(https?:\/\/[^\s()]+) \(\1\)/g, '$1')
    .replace(/\[\/img\]/gi, '')
    .trim();
  const re = /https?:\/\/[^\s<>"]+/g;
  let last = 0,
    m;
  while ((m = re.exec(s))) {
    let url = m[0];
    while (/[).,!?:;'\]]$/.test(url)) {
      if (url.endsWith(')') && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
      url = url.slice(0, -1);
    }
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    const image = chatImageSrc(url);
    const shared = !image && CHAT_SHARED.exec(url)?.[1];
    out.push(image ? { url, image } : shared ? { url, shared } : { url });
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}

if (typeof module !== 'undefined') module.exports = { chatParts, chatImageSrc };
