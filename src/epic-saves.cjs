'use strict';
// Epic Games cloud saves in the format of the Epic Games Launcher, so saves
// made by Nexus and by the official launcher are the same thing.
//
// A cloud save is one binary manifest ("manifests/<UTC date>.manifest") and
// chunks ("ChunksV4/<group>/<hash>_<guid>.chunk", up to 1 MiB of file data
// each). The format follows the open-source Legendary launcher
// (legendary/models/manifest.py, chunk.py, utils/savegame_helper.py).
//
// Pure functions: no network and no file system access here.

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const CHUNK_SIZE = 1024 * 1024;
const CHUNK_MAGIC = 0xb1fe3aa2;
const MANIFEST_MAGIC = 0x44bec00c;

// ---- rolling hash (a variation of CRC-64-ECMA used by Epic) -----------------

const POLY = 0xc96c5795d7870f42n;
const MASK = 0xffffffffffffffffn;
let TABLE = null;
function hashTable() {
  if (TABLE) return TABLE;
  TABLE = new Array(256);
  for (let i = 0; i < 256; i++) {
    let v = BigInt(i);
    for (let j = 0; j < 8; j++) v = v & 1n ? (v >> 1n) ^ POLY : v >> 1n;
    TABLE[i] = v;
  }
  return TABLE;
}
function rollingHash(data) {
  const table = hashTable();
  let h = 0n;
  for (let i = 0; i < data.length; i++) h = (((h << 1n) | (h >> 63n)) ^ table[data[i]]) & MASK;
  return h;
}

// ---- small binary reader / writer -------------------------------------------

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.buf.length) throw Error('Повреждённое сохранение Epic: неожиданный конец данных');
  }
  u8() {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  u32() {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(n) {
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Buffer.from(v);
  }
  guid() {
    return [this.u32(), this.u32(), this.u32(), this.u32()];
  }
  // FString: positive length = ASCII + NUL, negative = UTF-16 chars + NUL.
  fstring() {
    const length = this.i32();
    if (length < 0) {
      const bytes = -length * 2;
      const s = this.bytes(bytes - 2).toString('utf16le');
      this.pos += 2;
      return s;
    }
    if (length > 0) {
      const s = this.bytes(length - 1).toString('latin1');
      this.pos += 1;
      return s;
    }
    return '';
  }
}
class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  push(buf) {
    this.parts.push(buf);
    this.length += buf.length;
  }
  u8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    this.push(b);
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    this.push(b);
  }
  i32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.push(b);
  }
  u64(v) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    this.push(b);
  }
  i64(v) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v));
    this.push(b);
  }
  bytes(buf) {
    this.push(Buffer.from(buf));
  }
  guid(g) {
    for (const v of g) this.u32(v);
  }
  fstring(s) {
    if (!s) return this.i32(0);
    // ASCII when possible, UTF-16 otherwise (Epic's serializer does the same).
    if (/^[\x00-\x7f]*$/.test(s)) {
      this.i32(s.length + 1);
      this.push(Buffer.from(s, 'latin1'));
      this.u8(0);
    } else {
      this.i32(-(s.length + 1));
      this.push(Buffer.from(s, 'utf16le'));
      this.push(Buffer.alloc(2));
    }
  }
  // Sections start with their own size: write the body, then prefix it.
  section(fn) {
    const inner = new Writer();
    fn(inner);
    const body = inner.toBuffer();
    this.u32(body.length + 4);
    this.push(body);
  }
  toBuffer() {
    return Buffer.concat(this.parts, this.length);
  }
}

// ---- GUIDs and chunk paths ---------------------------------------------------

const guidKey = g => g.map(v => v.toString(16).padStart(8, '0')).join('');
function newGuid() {
  const b = crypto.randomBytes(16);
  return [b.readUInt32BE(0), b.readUInt32BE(4), b.readUInt32BE(8), b.readUInt32BE(12)];
}
function groupNum(guid) {
  const b = Buffer.alloc(16);
  guid.forEach((v, i) => b.writeUInt32LE(v, i * 4));
  return (zlib.crc32(b) >>> 0) % 100;
}
function chunkDir(version) {
  if (version >= 22) return 'ChunksV5';
  if (version >= 15) return 'ChunksV4';
  if (version >= 6) return 'ChunksV3';
  if (version >= 3) return 'ChunksV2';
  return 'Chunks';
}
function chunkPath(info, version = 18) {
  if (version >= 22) {
    const b64 = buf => buf.toString('base64url');
    const pack = g => {
      const b = Buffer.alloc(16);
      g.forEach((v, i) => b.writeUInt32LE(v, i * 4));
      return b;
    };
    const secret = info.secretGuid && info.secretGuid.some(Boolean) ? b64(pack(info.secretGuid)) : 'plain';
    const h = Buffer.alloc(8);
    h.writeBigUInt64LE(info.hash);
    return `${chunkDir(version)}/${secret}/${String(info.groupNum).padStart(2, '0')}/${b64(h)}_${b64(pack(info.guid))}.chunk`;
  }
  return `${chunkDir(version)}/${String(info.groupNum).padStart(2, '0')}/${info.hash
    .toString(16)
    .toUpperCase()
    .padStart(16, '0')}_${info.guid.map(v => v.toString(16).toUpperCase().padStart(8, '0')).join('')}.chunk`;
}

// ---- chunks ------------------------------------------------------------------

function readChunk(buf) {
  const r = new Reader(buf);
  if (r.u32() !== CHUNK_MAGIC) throw Error('Повреждённое сохранение Epic: это не чанк');
  const version = r.u32();
  const headerSize = r.u32();
  r.u32(); // compressed size
  const guid = r.guid();
  r.u64(); // rolling hash
  const storedAs = r.u8();
  if (version >= 2) {
    r.bytes(20); // sha1
    r.u8(); // hash type
  }
  if (version >= 3) r.u32(); // uncompressed size
  if (version >= 4) {
    r.guid(); // secret guid
    r.bytes(16); // encryption tag
  }
  if (storedAs & 0x2) throw Error('Зашифрованные сохранения Epic не поддерживаются');
  let data = buf.subarray(headerSize);
  if (storedAs & 0x1) data = zlib.inflateSync(data);
  return { guid, data };
}
// file data (≤ 1 MiB) → { info for the manifest, bytes to upload }
function writeChunk(data, guid = newGuid()) {
  if (data.length > CHUNK_SIZE) throw Error('Чанк больше 1 МиБ');
  const padded = Buffer.alloc(CHUNK_SIZE);
  data.copy(padded);
  const hash = rollingHash(padded);
  const sha = crypto.createHash('sha1').update(padded).digest();
  const compressed = zlib.deflateSync(padded);
  const w = new Writer();
  w.u32(CHUNK_MAGIC);
  w.u32(3); // header version
  w.u32(66); // header size for version 3
  w.u32(compressed.length);
  w.guid(guid);
  w.u64(hash);
  w.u8(0x1); // stored compressed
  w.bytes(sha);
  w.u8(0x3); // rolling + sha hash
  w.u32(CHUNK_SIZE);
  w.bytes(compressed);
  const bytes = w.toBuffer();
  return {
    info: { guid, hash, sha, groupNum: groupNum(guid), windowSize: CHUNK_SIZE, fileSize: bytes.length },
    bytes,
  };
}

// ---- manifests ---------------------------------------------------------------

function readManifest(buf) {
  const r = new Reader(buf);
  if (r.u32() !== MANIFEST_MAGIC) throw Error('Повреждённое сохранение Epic: это не манифест');
  const headerSize = r.u32();
  r.u32(); // uncompressed size
  r.u32(); // compressed size
  const sha = r.bytes(20);
  const storedAs = r.u8();
  const version = r.u32();
  if (storedAs & 0x2) throw Error('Зашифрованные сохранения Epic не поддерживаются');
  let body = buf.subarray(headerSize);
  if (storedAs & 0x1) {
    body = zlib.inflateSync(body);
    if (!crypto.createHash('sha1').update(body).digest().equals(sha))
      throw Error('Повреждённое сохранение Epic: контрольная сумма не совпадает');
  }
  const b = new Reader(body);
  // meta
  const metaStart = b.pos;
  const metaSize = b.u32();
  const dataVersion = b.u8();
  const featureLevel = b.u32();
  b.u8(); // is file data
  b.u32(); // app id
  const meta = {
    appName: b.fstring(),
    buildVersion: b.fstring(),
    launchExe: b.fstring(),
    launchCommand: b.fstring(),
  };
  const prereqs = b.u32();
  for (let i = 0; i < prereqs; i++) b.fstring();
  // Components a game needs (VC++ runtimes, DirectX, …), run once after installing.
  meta.prereqName = b.fstring();
  meta.prereqPath = b.fstring();
  meta.prereqArgs = b.fstring();
  if (dataVersion >= 1) b.fstring();
  if (dataVersion >= 2) {
    b.fstring();
    b.fstring();
  }
  b.pos = metaStart + metaSize;
  // chunk data list
  const cdlStart = b.pos;
  const cdlSize = b.u32();
  b.u8();
  const count = b.u32();
  const chunks = Array.from({ length: count }, () => ({}));
  for (const c of chunks) c.guid = b.guid();
  for (const c of chunks) c.hash = b.u64();
  for (const c of chunks) c.sha = b.bytes(20);
  for (const c of chunks) c.groupNum = b.u8();
  for (const c of chunks) c.windowSize = b.u32();
  for (const c of chunks) c.fileSize = Number(b.i64());
  if (featureLevel >= 22) {
    for (const c of chunks) c.secretGuid = b.guid();
    for (const c of chunks) c.windowSizeCompressed = b.u32();
    for (const c of chunks) c.encryptionTag = b.bytes(16);
  }
  b.pos = cdlStart + cdlSize;
  // file manifest list
  const fmlStart = b.pos;
  const fmlSize = b.u32();
  const fmlVersion = b.u8();
  const fileCount = b.u32();
  const files = Array.from({ length: fileCount }, () => ({ parts: [] }));
  for (const f of files) f.filename = b.fstring();
  for (const f of files) f.symlinkTarget = b.fstring();
  for (const f of files) f.hash = b.bytes(20);
  for (const f of files) f.flags = b.u8();
  // Install tags: optional parts of a game (languages, high-resolution textures, …).
  for (const f of files) {
    const tags = b.u32();
    f.installTags = Array.from({ length: tags }, () => b.fstring());
  }
  for (const f of files) {
    const parts = b.u32();
    for (let i = 0; i < parts; i++) {
      const start = b.pos;
      const size = b.u32();
      f.parts.push({ guid: b.guid(), offset: b.u32(), size: b.u32() });
      b.pos = start + size;
    }
  }
  if (fmlVersion >= 1) {
    for (let i = 0; i < files.length; i++) if (b.u32()) b.bytes(16);
    for (let i = 0; i < files.length; i++) b.fstring();
  }
  b.pos = fmlStart + fmlSize;
  for (const f of files) f.size = f.parts.reduce((n, p) => n + p.size, 0);
  // custom fields
  const custom = {};
  if (b.pos < body.length) {
    b.u32();
    b.u8();
    const n = b.u32();
    const keys = Array.from({ length: n }, () => b.fstring());
    const values = Array.from({ length: n }, () => b.fstring());
    keys.forEach((k, i) => (custom[k] = values[i]));
  }
  for (const c of chunks) c.path = chunkPath(c, featureLevel);
  return { version, featureLevel, meta, chunks, files, custom };
}

function writeManifest({ appName, buildVersion, chunks, files, custom = {} }) {
  const version = 18; // what Legendary writes for saves
  const body = new Writer();
  body.section(w => {
    w.u8(0); // data version
    w.u32(version); // feature level
    w.u8(0); // is file data
    w.u32(0); // app id
    w.fstring(appName);
    w.fstring(buildVersion);
    w.fstring('');
    w.fstring('');
    w.u32(0); // prerequisites
    w.fstring('');
    w.fstring('');
    w.fstring('');
  });
  body.section(w => {
    w.u8(0);
    w.u32(chunks.length);
    for (const c of chunks) w.guid(c.guid);
    for (const c of chunks) w.u64(c.hash);
    for (const c of chunks) w.bytes(c.sha);
    for (const c of chunks) w.u8(c.groupNum);
    for (const c of chunks) w.u32(c.windowSize);
    for (const c of chunks) w.i64(c.fileSize);
  });
  body.section(w => {
    w.u8(0);
    w.u32(files.length);
    for (const f of files) w.fstring(f.filename);
    for (let i = 0; i < files.length; i++) w.fstring(''); // symlink targets
    for (const f of files) w.bytes(f.hash);
    for (let i = 0; i < files.length; i++) w.u8(0); // flags
    for (let i = 0; i < files.length; i++) w.u32(0); // install tags
    for (const f of files) {
      w.u32(f.parts.length);
      for (const p of f.parts) {
        w.u32(28);
        w.guid(p.guid);
        w.u32(p.offset);
        w.u32(p.size);
      }
    }
  });
  body.section(w => {
    const keys = Object.keys(custom);
    w.u8(0);
    w.u32(keys.length);
    for (const k of keys) w.fstring(k);
    for (const k of keys) w.fstring(custom[k]);
  });
  const data = body.toBuffer();
  const sha = crypto.createHash('sha1').update(data).digest();
  const compressed = zlib.deflateSync(data);
  const head = new Writer();
  head.u32(MANIFEST_MAGIC);
  head.u32(41); // header size
  head.u32(data.length);
  head.u32(compressed.length);
  head.bytes(sha);
  head.u8(0x1); // compressed
  head.u32(version);
  head.bytes(compressed);
  return head.toBuffer();
}

// ---- packing and unpacking a save folder -----------------------------------

// Manifest name = UTC time of the save, as the Epic launcher names it.
function buildVersion(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}.${p(date.getUTCMonth() + 1)}.${p(date.getUTCDate())}-${p(date.getUTCHours())}.${p(
    date.getUTCMinutes()
  )}.${p(date.getUTCSeconds())}`;
}
function manifestDate(name) {
  const m = /(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})\.manifest$/.exec(String(name));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// files: [{ path: 'relative/path', data: Buffer }] (sorted case-insensitively, like Legendary)
// → { manifestPath, uploads: Map(remote path → Buffer) }
function packSave(files, { appName, accountId, cloudFolder, date = new Date() }) {
  const sorted = [...files].sort((a, b) =>
    a.path.toLowerCase() < b.path.toLowerCase() ? -1 : a.path.toLowerCase() > b.path.toLowerCase() ? 1 : 0
  );
  const uploads = new Map();
  const chunks = [];
  const fileEntries = [];
  let guid = null,
    buffer = [],
    used = 0;
  const finish = () => {
    if (!guid) return;
    const { info, bytes } = writeChunk(Buffer.concat(buffer, used), guid);
    chunks.push(info);
    uploads.set(chunkPath(info), bytes);
    guid = null;
    buffer = [];
    used = 0;
  };
  for (const f of sorted) {
    const entry = {
      filename: f.path.replace(/\\/g, '/'),
      hash: crypto.createHash('sha1').update(f.data).digest(),
      parts: [],
    };
    let offset = 0;
    while (offset < f.data.length) {
      if (!guid) guid = newGuid();
      const size = Math.min(f.data.length - offset, CHUNK_SIZE - used);
      entry.parts.push({ guid, offset: used, size });
      buffer.push(f.data.subarray(offset, offset + size));
      used += size;
      offset += size;
      if (used >= CHUNK_SIZE) finish();
    }
    fileEntries.push(entry);
  }
  finish();
  const version = buildVersion(date);
  const manifestPath = `manifests/${version}.manifest`;
  uploads.set(
    manifestPath,
    writeManifest({
      appName: `${appName}${accountId}`,
      buildVersion: version,
      chunks,
      files: fileEntries,
      custom: { CloudSaveFolder: cloudFolder || '' },
    })
  );
  return { manifestPath, uploads };
}

// manifest + chunk buffers by guid key → [{ path, data }], every file checked by SHA-1.
function unpackSave(manifest, chunkData) {
  return manifest.files.map(f => {
    const pieces = f.parts.map(p => {
      const data = chunkData.get(guidKey(p.guid));
      if (!data) throw Error(`В облачном сохранении не хватает части файла ${f.filename}`);
      return data.subarray(p.offset, p.offset + p.size);
    });
    const data = Buffer.concat(pieces);
    if (!crypto.createHash('sha1').update(data).digest().equals(f.hash))
      throw Error(`Файл ${f.filename} из облака повреждён`);
    return { path: f.filename, data };
  });
}

// ---- save folder from the game metadata ("CloudSaveFolder") ------------------

// vars: { installdir, epicid, appdata, userdir, userprofile, usersavedgames }
function resolveSaveFolder(template, vars) {
  if (typeof template !== 'string' || !template.trim()) return null;
  const known = Object.fromEntries(Object.entries(vars).map(([k, v]) => [`{${k.toLowerCase()}}`, v]));
  const parts = template.replace(/\\/g, '/').split('/');
  const resolved = parts.map(p => (Object.hasOwn(known, p.toLowerCase()) ? known[p.toLowerCase()] : p));
  if (resolved.some(p => /^\{.*\}$/.test(p))) return null; // unknown variable: do not guess a folder
  return resolved.join('/');
}

// Include / exclude patterns of the game metadata (comma separated).
function globToRegExp(pattern) {
  let re = '';
  for (const ch of pattern)
    re += ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${re}$`);
}
function matchesFilter(path, patterns) {
  return patterns.some(
    p => (p.endsWith('/') && path.startsWith(p)) || path.endsWith(p) || globToRegExp(p).test(path)
  );
}
function filterSaveFiles(paths, { include, exclude } = {}) {
  const inc = (include || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const exc = (exclude || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return paths.filter(p => (!inc.length || matchesFilter(p, inc)) && !(exc.length && matchesFilter(p, exc)));
}

// What to do before / after playing. lastSync: { manifest, localTime } of the last sync.
// localTime: newest modification of the local save files (ms, 0 = none);
// remote: newest cloud manifest name (or null).
function syncDecision({ localTime, remote, lastSync }) {
  const remoteTime = remote ? manifestDate(remote) : null;
  if (!localTime && !remote) return 'none';
  if (!remote) return 'upload';
  if (!localTime) return 'download';
  const localChanged = !lastSync || localTime > (lastSync.localTime || 0) + 2000;
  const remoteChanged = !lastSync || remote !== lastSync.manifest;
  if (lastSync && localChanged && remoteChanged) return 'conflict';
  if (lastSync && !localChanged && !remoteChanged) return 'same';
  if (lastSync) return remoteChanged ? 'download' : 'upload';
  // First sync on this PC: compare times like Legendary (within a minute = same).
  if (Math.abs(localTime - remoteTime) < 60000) return 'same';
  return localTime > remoteTime ? 'upload' : 'download';
}

module.exports = {
  CHUNK_SIZE,
  rollingHash,
  readChunk,
  writeChunk,
  readManifest,
  writeManifest,
  chunkPath,
  guidKey,
  groupNum,
  buildVersion,
  manifestDate,
  packSave,
  unpackSave,
  resolveSaveFolder,
  filterSaveFiles,
  syncDecision,
};
