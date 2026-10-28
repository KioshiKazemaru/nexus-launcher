'use strict';
// Installing Epic games without the Epic launcher, the way Legendary does it:
//   1. the launcher API gives the manifest URLs of the current build (assets v2);
//   2. the manifest lists the files and the 1 MiB chunks they are made of;
//   3. every chunk is downloaded once from the CDN, checked (SHA-1) and written
//      into all the file ranges that use it;
//   4. the files are checked against their SHA-1 from the manifest.
// Pure helpers here; the service with the queue and the files is main/epic-install.cjs.

const path = require('node:path');
const { readManifest, chunkPath } = require('./epic-saves.cjs');

const LAUNCHER_HOST = 'https://launcher-public-service-prod06.ol.epicgames.com';
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

function assetsUrl({ namespace, itemId, appId }, platform = 'Windows', label = 'Live') {
  for (const [v, what] of [
    [namespace, 'namespace'],
    [itemId, 'item'],
    [appId, 'app'],
  ])
    if (!SAFE_ID.test(String(v || ''))) throw Error(`Некорректный идентификатор Epic: ${what}`);
  return `${LAUNCHER_HOST}/launcher/api/public/assets/v2/platform/${platform}/namespace/${namespace}/catalogItem/${itemId}/app/${appId}/label/${label}`;
}

// Only Epic's CDNs: the chunks are fetched from the folders of the manifests.
const CDN_HOST = /(^|\.)(epicgames\.com|epicgamescdn\.com|akamaized\.net|fastly-edge\.com|cloudfront\.net)$/i;
function parseAssets(json) {
  const el = json?.elements?.[0];
  if (!el || !Array.isArray(el.manifests) || !el.manifests.length)
    throw Error('Epic не выдал файлы этой игры');
  const manifests = el.manifests
    .map(m => {
      let u;
      try {
        u = new URL(m.uri);
      } catch {
        return null;
      }
      if (u.protocol !== 'https:' || !CDN_HOST.test(u.hostname)) return null;
      for (const p of m.queryParams || []) if (p?.name) u.searchParams.set(p.name, String(p.value ?? ''));
      return { url: u.href, base: m.uri.slice(0, m.uri.lastIndexOf('/')) };
    })
    .filter(Boolean);
  if (!manifests.length) throw Error('Epic выдал неизвестные адреса загрузки');
  return {
    appName: String(el.appName || ''),
    buildVersion: String(el.buildVersion || ''),
    hash: String(el.hash || ''),
    manifests,
  };
}

// ---- JSON manifests (older games) ---------------------------------------------
// Numbers are "blobs": every byte as three decimal digits, little-endian.
function blobBytes(s) {
  const str = String(s || '');
  if (!/^(\d{3})*$/.test(str)) throw Error('Повреждённый манифест Epic');
  const out = Buffer.alloc(str.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = Number(str.slice(i * 3, i * 3 + 3)) & 0xff;
  return out;
}
function blobNum(s) {
  const b = blobBytes(s);
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}
function jsonGuid(s) {
  const hex = String(s || '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw Error('Повреждённый манифест Epic: GUID');
  return [0, 8, 16, 24].map(i => parseInt(hex.slice(i, i + 8), 16) >>> 0);
}
function parseJsonManifest(json) {
  const featureLevel = Number(blobNum(json.ManifestFileVersion || '013000000000'));
  const chunks = new Map();
  const chunk = key => {
    const k = key.toUpperCase();
    if (!chunks.has(k)) chunks.set(k, { guid: jsonGuid(k) });
    return chunks.get(k);
  };
  for (const [k, v] of Object.entries(json.ChunkHashList || {})) chunk(k).hash = blobNum(v);
  for (const [k, v] of Object.entries(json.ChunkShaList || {}))
    if (/^[0-9a-f]{40}$/i.test(v)) chunk(k).sha = Buffer.from(v, 'hex');
  for (const [k, v] of Object.entries(json.DataGroupList || {})) chunk(k).groupNum = Number(blobNum(v));
  for (const [k, v] of Object.entries(json.ChunkFilesizeList || {})) chunk(k).fileSize = Number(blobNum(v));
  for (const c of chunks.values()) {
    c.hash ??= 0n;
    c.groupNum ??= 0;
    c.fileSize ??= 0;
    c.windowSize = 1048576;
    c.path = chunkPath(c, featureLevel);
  }
  const files = (json.FileManifestList || []).map(f => {
    const parts = (f.FileChunkParts || []).map(p => ({
      guid: chunk(p.Guid).guid,
      offset: Number(blobNum(p.Offset)),
      size: Number(blobNum(p.Size)),
    }));
    return {
      filename: String(f.Filename || ''),
      symlinkTarget: String(f.SymlinkTarget || ''),
      hash: blobBytes(f.FileHash || ''),
      flags: 0,
      installTags: Array.isArray(f.InstallTags) ? f.InstallTags.map(String) : [],
      parts,
      size: parts.reduce((n, p) => n + p.size, 0),
    };
  });
  return {
    version: featureLevel,
    featureLevel,
    meta: {
      appName: String(json.AppNameString || ''),
      buildVersion: String(json.BuildVersionString || ''),
      launchExe: String(json.LaunchExeString || ''),
      launchCommand: String(json.LaunchCommand || ''),
      prereqName: String(json.PrereqName || ''),
      prereqPath: String(json.PrereqPath || ''),
      prereqArgs: String(json.PrereqArgs || ''),
    },
    chunks: [...chunks.values()],
    files,
    custom: json.CustomFields || {},
  };
}
function parseManifest(buf) {
  if (buf[0] === 0x7b) {
    let json;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      throw Error('Повреждённый манифест Epic');
    }
    return parseJsonManifest(json);
  }
  return readManifest(buf);
}

const guidKey = g =>
  g
    .map(v => (v >>> 0).toString(16).padStart(8, '0'))
    .join('')
    .toUpperCase();

// A file name from the manifest inside the install folder (never outside it).
function safeTarget(root, filename) {
  const rel = String(filename || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').some(p => p === '..' || p === ''))
    throw Error(`Небезопасный путь в манифесте Epic: ${filename}`);
  const full = path.resolve(root, rel);
  const r = path.resolve(root);
  if (!full.toLowerCase().startsWith(r.toLowerCase() + path.sep))
    throw Error(`Небезопасный путь: ${filename}`);
  return full;
}

// What to download: the chunks of the given files, each with every place it
// is written to. Files are written whole (fresh install, repair, update).
function plan(manifest, filenames = null) {
  const wanted = filenames ? new Set(filenames) : null;
  const byGuid = new Map(manifest.chunks.map(c => [guidKey(c.guid), c]));
  const jobs = new Map(); // guid → { chunk, targets: [{ file, fileOffset, chunkOffset, size }] }
  const files = [];
  for (const f of manifest.files) {
    if (wanted && !wanted.has(f.filename)) continue;
    if (f.symlinkTarget) continue; // Windows games do not use links
    files.push(f);
    let fileOffset = 0;
    for (const p of f.parts) {
      const key = guidKey(p.guid);
      const chunk = byGuid.get(key);
      if (!chunk) throw Error(`В манифесте Epic нет части ${key}`);
      if (!jobs.has(key)) jobs.set(key, { key, chunk, targets: [] });
      jobs.get(key).targets.push({ file: f.filename, fileOffset, chunkOffset: p.offset, size: p.size });
      fileOffset += p.size;
    }
  }
  const list = [...jobs.values()];
  return {
    files,
    chunks: list,
    downloadSize: list.reduce((n, j) => n + (j.chunk.fileSize || 0), 0),
    installSize: files.reduce((n, f) => n + f.size, 0),
  };
}

// Optional parts of a game: files with install tags. Files without tags are
// always installed; a tagged file is installed when one of its tags is chosen.
const TAG_NAMES = {
  de: 'Немецкий язык',
  fr: 'Французский язык',
  es: 'Испанский язык',
  'es-mx': 'Испанский (Латинская Америка)',
  it: 'Итальянский язык',
  ja: 'Японский язык',
  ko: 'Корейский язык',
  pl: 'Польский язык',
  pt: 'Португальский язык',
  'pt-br': 'Португальский (Бразилия)',
  ru: 'Русский язык',
  en: 'Английский язык',
  tr: 'Турецкий язык',
  ar: 'Арабский язык',
  zh: 'Китайский язык',
  'zh-hans': 'Китайский (упрощённый)',
  'zh-hant': 'Китайский (традиционный)',
};
function tagLabel(tag) {
  const t = String(tag).toLowerCase();
  if (TAG_NAMES[t]) return TAG_NAMES[t];
  const lang = /(?:^|[_-])(?:lang(?:uage)?|vo|audio|voice)[_-]?([a-z]{2}(?:-[a-z]{2,4})?)$/i.exec(t);
  if (lang && TAG_NAMES[lang[1]]) return TAG_NAMES[lang[1]] + ' (озвучка)';
  if (/hd|highres|4k|texture/i.test(t)) return `Текстуры высокого разрешения (${tag})`;
  return tag;
}
function components(manifest) {
  const byTag = new Map();
  for (const f of manifest.files)
    for (const t of f.installTags || []) {
      const c = byTag.get(t) || { tag: t, label: tagLabel(t), size: 0, files: 0 };
      c.size += f.size;
      c.files++;
      byTag.set(t, c);
    }
  return [...byTag.values()].sort((a, b) => b.size - a.size);
}
// The files of the chosen parts (null tags = everything, like Legendary).
function selectFiles(manifest, tags) {
  if (!Array.isArray(tags)) return null;
  const chosen = new Set(tags);
  return manifest.files
    .filter(f => !(f.installTags || []).length || f.installTags.some(t => chosen.has(t)))
    .map(f => f.filename);
}

// An update: files that are new or changed, and old files that are gone.
function diff(oldManifest, newManifest) {
  const old = new Map((oldManifest?.files || []).map(f => [f.filename.toLowerCase(), f]));
  const changed = newManifest.files
    .filter(f => {
      const o = old.get(f.filename.toLowerCase());
      return !o || !o.hash.equals(f.hash);
    })
    .map(f => f.filename);
  const keep = new Set(newManifest.files.map(f => f.filename.toLowerCase()));
  const removed = (oldManifest?.files || [])
    .filter(f => !keep.has(f.filename.toLowerCase()))
    .map(f => f.filename);
  return { changed, removed };
}

// The folder name for a game: the catalogue's FolderName, else the title.
function folderName(title, catalogFolder) {
  const name = String(catalogFolder || title || 'Game')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) || !name ? 'Game' : name;
}

// The .item file the Epic launcher keeps for an installed game (also read by Nexus).
function launcherItem({
  manifest,
  assets,
  offer,
  title,
  installDir,
  installGuid,
  ownershipToken,
  canRunOffline,
  tags = null,
}) {
  return {
    FormatVersion: 0,
    bIsIncompleteInstall: false,
    LaunchCommand: manifest.meta.launchCommand || '',
    LaunchExecutable: manifest.meta.launchExe || '',
    ManifestLocation: path.join(installDir, '.egstore'),
    ManifestHash: assets.hash || '',
    bIsApplication: true,
    bIsExecutable: true,
    bIsManaged: false,
    bNeedsValidation: false,
    bRequiresAuth: true,
    bAllowMultipleInstances: false,
    bCanRunOffline: canRunOffline !== false,
    bAllowUriCmdArgs: false,
    BaseURLs: assets.manifests.map(m => m.base),
    BuildLabel: 'Live',
    AppCategories: ['public', 'games', 'applications'],
    ChunkDbs: [],
    CompatibleApps: [],
    DisplayName: title,
    InstallationGuid: installGuid,
    InstallLocation: installDir,
    InstallSessionId: installGuid,
    InstallTags: [],
    InstallComponents: [],
    HostInstallationGuid: '00000000000000000000000000000000',
    PrereqIds: [],
    PrereqSHA1Hash: '',
    LastPrereqSucceededSHA1Hash: '',
    StagingLocation: path.join(installDir, '.egstore', 'bps'),
    TechnicalType: '',
    VaultThumbnailUrl: '',
    VaultTitleText: '',
    InstallSize: plan(manifest, selectFiles(manifest, tags)).installSize,
    MainWindowProcessName: '',
    ProcessNames: [],
    BackgroundProcessNames: [],
    IgnoredProcessNames: [],
    DlcProcessNames: [],
    MandatoryAppFolderName: path.basename(installDir),
    OwnershipToken: ownershipToken ? 'true' : 'false',
    CatalogNamespace: offer.namespace,
    CatalogItemId: offer.itemId,
    AppName: offer.appId,
    AppVersionString: assets.buildVersion || manifest.meta.buildVersion,
    MainGameCatalogNamespace: offer.namespace,
    MainGameCatalogItemId: offer.itemId,
    MainGameAppName: offer.appId,
    AllowedUriEnvVars: [],
  };
}

module.exports = {
  LAUNCHER_HOST,
  assetsUrl,
  parseAssets,
  blobBytes,
  blobNum,
  parseJsonManifest,
  parseManifest,
  guidKey,
  safeTarget,
  plan,
  diff,
  tagLabel,
  components,
  selectFiles,
  folderName,
  launcherItem,
};
