const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { ArtworkCache } = require('../src/artwork.cjs');
test('cover cache returns real image bytes, reuses disk and rejects unsafe input', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-art-'));
  let calls = 0;
  const bytes = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
  const cache = new ArtworkCache(dir, async () => {
    calls++;
    return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
  try {
    const url = 'https://cdn1.epicgames.com/art.jpg';
    const first = await cache.get(url);
    assert.match(first, /^data:image\/jpeg;base64,/);
    assert.equal(await cache.get(url), first);
    assert.equal(calls, 1);
    await assert.rejects(() => cache.get('file:///C:/secret'));
    await assert.rejects(() => cache.get('https://127.0.0.1/a'));
    assert.throws(() => cache.data(Buffer.from('<svg onload="alert(1)">')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
