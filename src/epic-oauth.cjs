'use strict';
// Epic Games account access through the same OAuth flow that Legendary and
// Heroic use: the user signs in on epicgames.com, Epic shows a one-time
// authorization code, the code is exchanged for an access token and a refresh
// token. Only the refresh token is persisted (encrypted with Windows DPAPI).
//
// NOTE: Epic has no public library API for third-party launchers. These are the
// Epic Games Launcher client credentials published by the Legendary project.
// Using them is a grey area of Epic's terms; see README.

const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
const CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';
const ACCOUNT_HOST = 'https://account-public-service-prod03.ol.epicgames.com';
const LIBRARY_HOST = 'https://library-service.live.use1a.on.epicgames.com';
const REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${CLIENT_ID}&responseType=code`;
const LOGIN_URL = `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(REDIRECT_URL)}`;
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

function isRedirectPage(url) {
  try {
    const u = new URL(url);
    return u.origin === 'https://www.epicgames.com' && u.pathname === '/id/api/redirect';
  } catch {
    return false;
  }
}

// Accepts the raw JSON shown on the redirect page, the bare 32-char code, or a
// pasted URL containing ?code=. Returns '' when nothing valid was found.
function extractAuthCode(input) {
  if (typeof input !== 'string') return '';
  const text = input.trim();
  if (!text || text.length > 20000) return '';
  if (/^[a-f0-9]{32}$/i.test(text)) return text.toLowerCase();
  try {
    const json = JSON.parse(text);
    const code = json?.authorizationCode ?? json?.redirectUrl?.match?.(/[?&]code=([a-f0-9]{32})/i)?.[1];
    if (typeof code === 'string' && /^[a-f0-9]{32}$/i.test(code)) return code.toLowerCase();
    return '';
  } catch {}
  const m =
    /"authorizationCode"\s*:\s*"([a-f0-9]{32})"/i.exec(text) || /[?&]code=([a-f0-9]{32})\b/i.exec(text);
  return m ? m[1].toLowerCase() : '';
}

function parseToken(json, now = Date.now()) {
  if (!json || typeof json !== 'object' || json.errorCode || json.error) {
    const message = json?.errorMessage || json?.error_description || 'Epic отклонил вход';
    const e = Error(String(message).slice(0, 300));
    e.code = json?.errorCode || json?.error || 'epic_oauth_error';
    e.signedOut = /invalid_grant|refresh_token|expired|not_found/i.test(String(e.code) + ' ' + message);
    throw e;
  }
  const accountId = json.account_id;
  if (typeof json.access_token !== 'string' || !ACCOUNT_ID.test(accountId || ''))
    throw Error('Epic вернул неполный ответ авторизации');
  const at = (iso, seconds) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : now + (Number(seconds) || 0) * 1000;
  };
  return {
    accessToken: json.access_token,
    expiresAt: at(json.expires_at, json.expires_in || 7200),
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : '',
    refreshExpiresAt: at(json.refresh_expires_at, json.refresh_expires || 0),
    accountId: accountId.toLowerCase(),
    displayName: String(json.displayName || '')
      .trim()
      .slice(0, 100),
  };
}

async function tokenRequest(fetcher, params) {
  const r = await fetcher(`${ACCOUNT_HOST}/account/api/oauth/token`, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    headers: {
      Authorization: 'basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ ...params, token_type: 'eg1' }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  if (!r.ok && !json?.errorCode) throw Error(`Epic OAuth: HTTP ${r.status}`);
  return parseToken(json);
}

function exchangeCode(fetcher, code) {
  if (!/^[a-f0-9]{32}$/i.test(code || '')) throw Error('Некорректный код авторизации Epic');
  return tokenRequest(fetcher, { grant_type: 'authorization_code', code });
}

function refresh(fetcher, refreshToken) {
  if (typeof refreshToken !== 'string' || !refreshToken) throw Error('Нет сохранённого входа Epic');
  return tokenRequest(fetcher, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function killSession(fetcher, accessToken) {
  try {
    await fetcher(`${ACCOUNT_HOST}/account/api/oauth/sessions/kill/${encodeURIComponent(accessToken)}`, {
      method: 'DELETE',
      credentials: 'omit',
      headers: { Authorization: `bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {}
}

// Keeps one valid access token per account and refreshes it shortly before expiry.
class EpicTokens {
  constructor(fetcher, onChange = () => {}) {
    this.fetcher = fetcher;
    this.onChange = onChange;
    this.accounts = new Map();
    this.pending = new Map();
  }
  restore(saved) {
    for (const [id, s] of Object.entries(saved || {})) {
      if (ACCOUNT_ID.test(id) && typeof s?.refreshToken === 'string')
        this.accounts.set(id, {
          accountId: id,
          refreshToken: s.refreshToken,
          refreshExpiresAt: Number(s.refreshExpiresAt) || 0,
          displayName: String(s.displayName || ''),
        });
    }
  }
  persisted() {
    return Object.fromEntries(
      [...this.accounts.values()]
        .filter(a => a.refreshToken)
        .map(a => [
          a.accountId,
          { refreshToken: a.refreshToken, refreshExpiresAt: a.refreshExpiresAt, displayName: a.displayName },
        ])
    );
  }
  ids() {
    return [...this.accounts.keys()];
  }
  async signIn(code) {
    const token = await exchangeCode(this.fetcher, code);
    this.accounts.set(token.accountId, token);
    this.onChange(token.accountId);
    return token;
  }
  async accessToken(accountId, now = Date.now()) {
    const a = this.accounts.get(accountId);
    if (!a) {
      const e = Error('Аккаунт Epic не подключён');
      e.signedOut = true;
      throw e;
    }
    if (a.accessToken && a.expiresAt - now > 120000) return a.accessToken;
    if (this.pending.has(accountId)) return this.pending.get(accountId);
    const task = (async () => {
      if (a.refreshExpiresAt && a.refreshExpiresAt < now) {
        const e = Error('Срок входа Epic истёк. Войдите снова.');
        e.signedOut = true;
        throw e;
      }
      const token = await refresh(this.fetcher, a.refreshToken);
      if (token.accountId !== accountId) throw Error('Epic вернул токен другого аккаунта');
      this.accounts.set(accountId, { ...a, ...token, displayName: token.displayName || a.displayName });
      this.onChange(accountId);
      return token.accessToken;
    })();
    this.pending.set(accountId, task);
    try {
      return await task;
    } finally {
      this.pending.delete(accountId);
    }
  }
  async profile(accountId) {
    const token = await this.accessToken(accountId);
    const a = this.accounts.get(accountId);
    return { id: accountId, name: a.displayName || 'Epic Games', avatar: '', tokenReady: !!token };
  }
  async signOut(accountId) {
    const a = this.accounts.get(accountId);
    this.accounts.delete(accountId);
    if (a?.accessToken) await killSession(this.fetcher, a.accessToken);
    this.onChange(accountId);
  }
}

// Seconds per appName (artifactId) → minutes, to match Steam's playtime units.
function parsePlaytime(json) {
  if (!Array.isArray(json)) throw Error('Epic не вернул время в играх');
  const out = {};
  for (const x of json) {
    if (typeof x?.artifactId === 'string' && Number.isFinite(x.totalTime))
      out[x.artifactId] = (out[x.artifactId] || 0) + Math.round(x.totalTime / 60);
  }
  return out;
}

async function fetchPlaytime(fetcher, token, accountId) {
  const r = await fetcher(`${LIBRARY_HOST}/library/api/public/playtime/account/${accountId}/all`, {
    credentials: 'omit',
    redirect: 'error',
    headers: { Authorization: `bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw Error(`Epic playtime: HTTP ${r.status}`);
  return parsePlaytime(await r.json());
}

// C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat lists installs
// even when the per-game .item manifests are missing.
function parseLauncherInstalled(json) {
  const list = json?.InstallationList;
  if (!Array.isArray(list)) return [];
  return list
    .filter(x => typeof x?.AppName === 'string' && x.AppName && typeof x.InstallLocation === 'string')
    .filter(x => !/^(UE_|ue)/.test(x.AppName) && x.NamespaceId !== 'ue')
    .map(x => ({
      appId: x.AppName,
      namespace: typeof x.NamespaceId === 'string' ? x.NamespaceId : '',
      itemId: typeof x.ItemId === 'string' ? x.ItemId : '',
      installLocation: x.InstallLocation,
    }));
}

module.exports = {
  CLIENT_ID,
  LOGIN_URL,
  REDIRECT_URL,
  isRedirectPage,
  extractAuthCode,
  parseToken,
  exchangeCode,
  refresh,
  killSession,
  EpicTokens,
  parsePlaytime,
  fetchPlaytime,
  parseLauncherInstalled,
};
