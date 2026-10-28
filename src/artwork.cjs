const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { imageUrl } = require('./providers.cjs');
class ArtworkCache {
  constructor(directory, fetcher) {
    this.directory = directory;
    this.fetcher = fetcher;
    this.pending = new Map();
    this.active = 0;
    this.queue = [];
  }
  async get(url) {
    const safe = imageUrl(url);
    if (!safe) throw Error('Недопустимый адрес изображения');
    if (this.pending.has(safe)) return this.pending.get(safe);
    const promise = this.load(safe);
    this.pending.set(safe, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(safe);
    }
  }
  async load(url) {
    await fs.mkdir(this.directory, { recursive: true });
    const filename = path.join(
      this.directory,
      crypto.createHash('sha256').update(url).digest('hex') + '.img'
    );
    try {
      const stat = await fs.stat(filename);
      if (Date.now() - stat.mtimeMs < 7 * 86400000) return this.data(await fs.readFile(filename));
    } catch {}
    while (this.active >= 4) await new Promise(resolve => this.queue.push(resolve));
    this.active++;
    try {
      const r = await this.fetcher(url, {
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) {
        const e = Error('Изображение недоступно');
        e.status = r.status;
        throw e;
      }
      if (Number(r.headers.get('content-length')) > 5000000) throw Error('Слишком большое изображение');
      const reader = r.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 5000000) {
            await reader.cancel();
            throw Error('Слишком большое изображение');
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = Buffer.concat(chunks),
        result = this.data(bytes);
      await fs.writeFile(filename, bytes);
      return result;
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
  // Covers are re-read after 7 days but were never deleted: files not
  // refreshed for maxAge are removed (run once in the background at start).
  async prune(maxAge = 30 * 86400000, now = Date.now()) {
    let names;
    try {
      names = await fs.readdir(this.directory);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.img$/.test(name)) continue;
      const file = path.join(this.directory, name);
      try {
        if (now - (await fs.stat(file)).mtimeMs > maxAge) {
          await fs.unlink(file);
          removed++;
        }
      } catch {}
    }
    return removed;
  }
  data(bytes) {
    const mime =
      bytes[0] === 255 && bytes[1] === 216
        ? 'image/jpeg'
        : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? 'image/png'
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
            ? 'image/webp'
            : null;
    if (!mime) throw Error('Неподдерживаемый формат изображения');
    return `data:${mime};base64,${bytes.toString('base64')}`;
  }
}
module.exports = { ArtworkCache };
