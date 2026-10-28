const cheerio = require('cheerio');
const { imageUrl } = require('./providers.cjs');
class SignedOut extends Error {}
function parseSteamAccount(html, url, cookieId = '') {
  const u = new URL(url);
  if (u.origin !== 'https://store.steampowered.com') throw Error('Неверный адрес ответа Steam');
  if (u.pathname.startsWith('/login')) throw new SignedOut();
  const $ = cheerio.load(html);
  if (/\bg_steamID\s*=\s*(false|null|["']["'])/.test(html)) throw new SignedOut();
  const name = $('#account_pulldown').first().text().trim();
  // An authenticated server-rendered account header is mandatory. A cookie alone is not proof.
  if (!name) throw new SignedOut();
  let id = /\bg_steamID\s*=\s*["']?(7656119\d{10})/.exec(html)?.[1];
  for (const el of $('[data-userinfo]').toArray()) {
    try {
      const info = JSON.parse($(el).attr('data-userinfo'));
      if (info.logged_in !== false && /^7656119\d{10}$/.test(String(info.steamid || '')))
        id = String(info.steamid);
    } catch {}
  }
  id ||= $('#global_actions a[href*="/profiles/"]')
    .first()
    .attr('href')
    ?.match(/\/profiles\/(7656119\d{10})(?:\/|$)/)?.[1];
  id ||= /^7656119\d{10}$/.test(cookieId) ? cookieId : '';
  if (!id) throw Error('Steam подтвердил вход, но не вернул идентификатор профиля');
  const avatar = imageUrl(
    $('#global_actions .playerAvatar img, #global_actions .user_avatar img').first().attr('src')
  );
  return { id, name: name.slice(0, 100), avatar };
}
function steamCookieId(cookies) {
  const ids = new Set(
    cookies
      .filter(
        c =>
          c.name === 'steamLoginSecure' &&
          ['store.steampowered.com', 'steampowered.com'].includes(c.domain.replace(/^\./, ''))
      )
      .map(c => {
        try {
          return decodeURIComponent(c.value).match(/^(7656119\d{10})\|\|/)?.[1];
        } catch {
          return '';
        }
      })
      .filter(Boolean)
  );
  return ids.size === 1 ? [...ids][0] : '';
}
// Runs only in the official store window. Returns public profile markup, never cookies/passwords.
const STEAM_WINDOW_PROBE = `(async()=>{
 if(location.origin!=='https://store.steampowered.com')return null;
 const r=await fetch('/account/',{credentials:'include',cache:'no-store',signal:AbortSignal.timeout(10000)});
 if(!r.ok)return null;
 const doc=new DOMParser().parseFromString(await r.text(),'text/html');
 const wrapper=doc.createElement('div');
 for(const selector of ['#global_actions','#account_pulldown','[data-userinfo]']){
  for(const node of doc.querySelectorAll(selector)){
   if(selector==='[data-userinfo]'){
    try{const x=JSON.parse(node.getAttribute('data-userinfo'));const el=doc.createElement('div');el.setAttribute('data-userinfo',JSON.stringify({steamid:x.steamid,logged_in:x.logged_in}));wrapper.append(el);}catch{}
   }else if(selector==='#account_pulldown'){
    const el=doc.createElement('span');el.id='account_pulldown';el.textContent=node.textContent;wrapper.append(el);
   }else{
    const el=doc.createElement('div');el.id='global_actions';
    const avatar=node.querySelector('.playerAvatar img, .user_avatar img');
    if(avatar){const a=doc.createElement('span');a.className='playerAvatar';const img=doc.createElement('img');img.setAttribute('src',avatar.getAttribute('src')||'');a.append(img);el.append(a);}
    const link=node.querySelector('a[href*="/profiles/"]');if(link){const a=doc.createElement('a');a.setAttribute('href',link.getAttribute('href'));el.append(a);}
    wrapper.append(el);
   }
  }
 }
 const own=typeof window.g_steamID==='string'&&/^7656119\d{10}$/.test(window.g_steamID)?window.g_steamID:'';
 return {html:wrapper.innerHTML,url:r.url||location.origin+'/account/',steamid:own};
})()`;
function parseSteamCommunity(xml, id, fallback) {
  const $ = cheerio.load(xml, { xml: true });
  if ($('steamID64').first().text() !== id) return fallback;
  return {
    ...fallback,
    name: $('steamID').first().text().trim().slice(0, 100) || fallback.name,
    avatar: imageUrl($('avatarMedium').first().text()) || fallback.avatar,
  };
}
function parseEpicAccount(json) {
  if (json?.errorCode || json?.error || json?.isLoggedIn === false) throw new SignedOut();
  const profile = require('./epic-auth.cjs').epicProfile(json);
  if (profile) return profile;
  throw Error('Epic не вернул подтверждённый профиль');
}
async function verifyAccount(provider, fetcher, cookieId = '') {
  const url =
    provider === 'steam'
      ? 'https://store.steampowered.com/account/'
      : 'https://www.epicgames.com/account/v2/personal/ajaxGet';
  const r = await fetcher(url, {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
  });
  if (r.status === 401) throw new SignedOut();
  if (!r.ok) throw Error(`Проверка ${provider}: HTTP ${r.status}`);
  if (provider === 'steam') {
    // Electron's net.fetch may leave url empty when there was no redirect.
    const profile = parseSteamAccount(await r.text(), r.url || url, cookieId);
    try {
      const response = await fetcher(`https://steamcommunity.com/profiles/${profile.id}/?xml=1`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return parseSteamCommunity(await response.text(), profile.id, profile);
    } catch {}
    return profile;
  }
  if (/\/id\/login/.test(r.url)) throw new SignedOut();
  return parseEpicAccount(await r.json());
}
// Epoch invalidates in-flight checks after logout. Neither cookies nor a cached nickname prove login.
class AccountMonitor {
  // Keys are account keys such as "steam:0", "steam:1" or "epic:<accountId>".
  constructor(check, onChange = () => {}, keys = ['steam', 'epic']) {
    this.check = check;
    this.onChange = onChange;
    this.epochs = {};
    this.inFlight = {};
    this.states = {};
    for (const k of keys) this.add(k);
  }
  add(p) {
    this.epochs[p] ??= 0;
    this.states[p] ??= { status: 'checking' };
  }
  remove(p) {
    this.epochs[p] = (this.epochs[p] || 0) + 1;
    delete this.inFlight[p];
    delete this.states[p];
  }
  keys() {
    return Object.keys(this.states);
  }
  forget(p) {
    this.add(p);
    this.epochs[p]++;
    delete this.inFlight[p];
    this.states[p] = { status: 'signedOut' };
    this.onChange(p, this.states[p]);
  }
  async refresh(p) {
    this.add(p);
    if (this.inFlight[p]) return this.inFlight[p];
    const epoch = this.epochs[p];
    const task = (async () => {
      let next;
      try {
        next = { status: 'connected', ...(await this.check(p)), verifiedAt: Date.now() };
      } catch (e) {
        next =
          e instanceof SignedOut || e?.signedOut === true
            ? { status: 'signedOut', message: e?.signedOut ? e.message : '' }
            : {
                ...this.states[p],
                status: 'unavailable',
                reason: String(e?.message || e).slice(0, 200),
                message:
                  e.publicMessage || 'Не удалось проверить вход. Повторить проверку можно в настройках.',
              };
      }
      if (this.epochs[p] === epoch) {
        this.states[p] = next;
        this.onChange(p, next);
      }
      return this.states[p];
    })();
    this.inFlight[p] = task;
    try {
      return await task;
    } finally {
      if (this.inFlight[p] === task) delete this.inFlight[p];
    }
  }
}
function shouldCloseLogin(purpose, profile) {
  return purpose === 'login' && profile?.status === 'connected' && !!profile.id && !!profile.name;
}
module.exports = {
  steamCookieId,
  STEAM_WINDOW_PROBE,
  shouldCloseLogin,
  SignedOut,
  parseSteamAccount,
  parseSteamCommunity,
  parseEpicAccount,
  verifyAccount,
  AccountMonitor,
};
