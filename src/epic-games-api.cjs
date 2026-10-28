'use strict';
// Epic Games services a game needs when it is started without the Epic
// launcher: a one-time login code for the game, the ownership token of
// protected games, the catalogue metadata (cloud save folder, extra command
// line) and the cloud save storage. Endpoints as used by the open-source
// Legendary launcher (legendary/api/egs.py).

const ACCOUNT_ID = /^[a-f0-9]{32}$/i;
const OAUTH_HOST = 'https://account-public-service-prod03.ol.epicgames.com';
const CATALOG_HOST = 'https://catalog-public-service-prod06.ol.epicgames.com';
const ECOMMERCE_HOST = 'https://ecommerceintegration-public-service-ecomprod02.ol.epicgames.com';
const DATASTORAGE_HOST = 'https://datastorage-public-service-liveegs.live.use1a.on.epicgames.com';

const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;
function check(value, what) {
  if (!SAFE_ID.test(String(value || ''))) throw Error(`Некорректный идентификатор Epic: ${what}`);
  return String(value);
}
async function call(fetcher, url, token, options = {}) {
  const r = await fetcher(url, {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    ...options,
    headers: { Authorization: `bearer ${token}`, Accept: 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 20000),
  });
  if (!r.ok) {
    const e = Error(`Epic: HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r;
}

// One-time code the game uses to sign in (-AUTH_PASSWORD).
async function gameLoginCode(fetcher, token) {
  const j = await (await call(fetcher, `${OAUTH_HOST}/account/api/oauth/exchange`, token)).json();
  if (typeof j?.code !== 'string' || !/^[A-Za-z0-9]{16,128}$/.test(j.code))
    throw Error('Epic не выдал код входа для игры');
  return j.code;
}

// Binary token for games protected by Epic's ownership check (-epicovt).
async function ownershipToken(fetcher, token, accountId, namespace, itemId) {
  if (!ACCOUNT_ID.test(accountId || '')) throw Error('Некорректный аккаунт Epic');
  const r = await call(
    fetcher,
    `${ECOMMERCE_HOST}/ecommerceintegration/api/public/platforms/EPIC/identities/${accountId}/ownershipToken`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
      body: new URLSearchParams({
        nsCatalogItemId: `${check(namespace, 'namespace')}:${check(itemId, 'item')}`,
      }).toString(),
    }
  );
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!bytes.length || bytes.length > 64 * 1024) throw Error('Epic выдал некорректный токен владения');
  return bytes;
}

// Catalogue item of an installed game: customAttributes hold the cloud save
// folder, filters, extra command line and the third-party store (EA, Ubisoft).
async function catalogItem(fetcher, token, namespace, itemId, country = 'US') {
  const u = new URL(
    `${CATALOG_HOST}/catalog/api/shared/namespace/${check(namespace, 'namespace')}/bulk/items`
  );
  u.search = new URLSearchParams({
    id: check(itemId, 'item'),
    includeDLCDetails: 'true',
    includeMainGameDetails: 'true',
    country,
    locale: 'en',
  });
  const j = await (await call(fetcher, u.href, token)).json();
  return j?.[itemId] || null;
}
function attribute(item, name) {
  const v = item?.customAttributes?.[name]?.value;
  return typeof v === 'string' ? v : '';
}
// What the launch needs from the catalogue item.
function launchInfo(item) {
  return {
    cloudFolder: attribute(item, 'CloudSaveFolder'),
    include: attribute(item, 'CloudIncludeList'),
    exclude: attribute(item, 'CloudExcludeList'),
    extraArgs: attribute(item, 'AdditionalCommandLine'),
    // Games run by another store's launcher cannot start without it.
    thirdParty: attribute(item, 'ThirdPartyManagedApp') || attribute(item, 'ThirdPartyManagedProvider'),
    canRunOffline: attribute(item, 'CanRunOffline')
      ? attribute(item, 'CanRunOffline').toLowerCase() === 'true'
      : true,
  };
}

// ---- cloud saves -------------------------------------------------------------

// All cloud files of the game: { "<path>": { readLink, lastModified, ... } }.
async function cloudFiles(fetcher, token, accountId, appName) {
  if (!ACCOUNT_ID.test(accountId || '')) throw Error('Некорректный аккаунт Epic');
  const r = await call(
    fetcher,
    `${DATASTORAGE_HOST}/api/v1/access/egstore/savesync/${accountId}/${encodeURIComponent(check(appName, 'app'))}/`,
    token
  );
  const files = (await r.json())?.files;
  return files && typeof files === 'object' ? files : {};
}
// Creates upload links for new cloud files: { "<path>": { writeLink } }.
async function cloudUploadLinks(fetcher, token, accountId, appName, paths) {
  if (!ACCOUNT_ID.test(accountId || '')) throw Error('Некорректный аккаунт Epic');
  const r = await call(
    fetcher,
    `${DATASTORAGE_HOST}/api/v1/access/egstore/savesync/${accountId}/${encodeURIComponent(check(appName, 'app'))}/`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: paths }),
    }
  );
  const files = (await r.json())?.files;
  if (!files || typeof files !== 'object') throw Error('Epic не выдал ссылки для загрузки сохранений');
  return files;
}
// Read/write links are pre-signed storage URLs: only HTTPS is accepted.
function storageLink(link) {
  const u = new URL(String(link || ''));
  if (u.protocol !== 'https:' || u.username || u.password)
    throw Error('Epic вернул небезопасную ссылку хранилища');
  return u.href;
}
async function downloadLink(fetcher, link, maxBytes = 64 * 1024 * 1024) {
  const r = await fetcher(storageLink(link), {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw Error(`Хранилище Epic: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > maxBytes) throw Error('Файл облачного сохранения слишком большой');
  return bytes;
}
async function uploadLink(fetcher, link, bytes) {
  const r = await fetcher(storageLink(link), {
    method: 'PUT',
    credentials: 'omit',
    body: bytes,
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw Error(`Загрузка сохранения в Epic: HTTP ${r.status}`);
}

// Newest save manifest among the cloud files: { name, path } or null.
function latestManifest(files) {
  const manifests = Object.keys(files)
    .filter(p => /\/manifests\/[^/]+\.manifest$/.test(p))
    .map(p => ({ path: p, name: p.split('/').pop() }))
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return manifests[0] || null;
}
// Remote path of a chunk listed in a manifest (same prefix as the manifest).
function chunkRemotePath(manifestPath, chunkPath) {
  const prefix = manifestPath.slice(0, manifestPath.indexOf('/manifests/'));
  return `${prefix}/${chunkPath}`;
}

// ---- command line --------------------------------------------------------------

// Splits a launch command like the Windows shell would ("a b" stays one argument).
function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}
// Arguments the Epic launcher passes to a game (see Legendary get_launch_parameters).
function launchArgs({
  appName,
  namespace,
  accountId,
  displayName,
  loginCode,
  ovtPath,
  launchCommand,
  extraArgs,
  locale = 'ru',
}) {
  return [
    ...splitArgs(launchCommand),
    ...splitArgs(extraArgs),
    '-AUTH_LOGIN=unused',
    `-AUTH_PASSWORD=${loginCode || ''}`,
    '-AUTH_TYPE=exchangecode',
    `-epicapp=${appName}`,
    '-epicenv=Prod',
    ...(ovtPath ? [`-epicovt=${ovtPath}`] : []),
    '-EpicPortal',
    `-epicusername=${displayName || ''}`,
    `-epicuserid=${accountId}`,
    `-epiclocale=${locale}`,
    `-epicsandboxid=${namespace || ''}`,
  ];
}

module.exports = {
  gameLoginCode,
  ownershipToken,
  catalogItem,
  launchInfo,
  cloudFiles,
  cloudUploadLinks,
  downloadLink,
  uploadLink,
  latestManifest,
  chunkRemotePath,
  splitArgs,
  launchArgs,
};
