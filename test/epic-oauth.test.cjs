const test = require('node:test'),
  assert = require('node:assert/strict');
const e = require('../src/epic-oauth.cjs');
const id = 'a'.repeat(32),
  code = 'b'.repeat(32);
const tokenJson = (over = {}) => ({
  access_token: 'access',
  expires_at: new Date(Date.now() + 7200000).toISOString(),
  refresh_token: 'refresh',
  refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
  account_id: id,
  displayName: 'Player',
  ...over,
});

test('authorization code is taken from JSON, bare code or URL, never from junk', () => {
  assert.equal(
    e.extractAuthCode(JSON.stringify({ redirectUrl: 'x', authorizationCode: code, sid: null })),
    code
  );
  assert.equal(e.extractAuthCode(code.toUpperCase()), code);
  assert.equal(e.extractAuthCode(`https://localhost/?code=${code}`), code);
  assert.equal(e.extractAuthCode('{"authorizationCode":null}'), '');
  assert.equal(e.extractAuthCode('hello'), '');
  assert.equal(e.isRedirectPage(e.REDIRECT_URL), true);
  assert.equal(e.isRedirectPage('https://evil.test/id/api/redirect'), false);
  assert.ok(e.LOGIN_URL.startsWith('https://www.epicgames.com/id/login?redirectUrl='));
});

test('code exchange posts launcher credentials and returns account + tokens', async () => {
  let request;
  const t = await e.exchangeCode(async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => tokenJson() };
  }, code);
  assert.equal(request.url, 'https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token');
  assert.equal(request.options.method, 'POST');
  assert.match(request.options.headers.Authorization, /^basic /);
  assert.match(request.options.body, /grant_type=authorization_code/);
  assert.match(request.options.body, new RegExp('code=' + code));
  assert.deepEqual([t.accountId, t.displayName, t.refreshToken], [id, 'Player', 'refresh']);
  assert.throws(() => e.exchangeCode(async () => ({}), 'nope'));
});

test('Epic errors are reported; expired refresh marks account signed out', () => {
  assert.throws(
    () =>
      e.parseToken({
        errorCode: 'errors.com.epicgames.account.oauth.authorization_code_not_found',
        errorMessage: 'not found',
      }),
    err => err.signedOut === true
  );
  assert.throws(() => e.parseToken({ access_token: 'x', account_id: 'short' }), /неполный/);
});

test('EpicTokens refreshes before expiry, persists only refresh tokens, rejects foreign tokens', async () => {
  let calls = 0,
    changes = 0;
  const tokens = new e.EpicTokens(
    async () => {
      calls++;
      return { ok: true, json: async () => tokenJson({ access_token: 'fresh' + calls }) };
    },
    () => changes++
  );
  tokens.restore({
    [id]: { refreshToken: 'saved', refreshExpiresAt: Date.now() + 1e9, displayName: 'Saved' },
    bad: {},
  });
  assert.deepEqual(tokens.ids(), [id]);
  assert.equal(await tokens.accessToken(id), 'fresh1');
  assert.equal(await tokens.accessToken(id), 'fresh1');
  assert.equal(calls, 1);
  assert.ok(changes >= 1);
  const saved = tokens.persisted()[id];
  assert.deepEqual(Object.keys(saved).sort(), ['displayName', 'refreshExpiresAt', 'refreshToken']);
  await assert.rejects(
    () => tokens.accessToken('c'.repeat(32)),
    err => err.signedOut === true
  );

  const foreign = new e.EpicTokens(async () => ({
    ok: true,
    json: async () => tokenJson({ account_id: 'd'.repeat(32) }),
  }));
  foreign.restore({ [id]: { refreshToken: 'r' } });
  await assert.rejects(() => foreign.accessToken(id), /другого аккаунта/);

  const expired = new e.EpicTokens(async () => assert.fail('must not refresh'));
  expired.restore({ [id]: { refreshToken: 'r', refreshExpiresAt: 1 } });
  await assert.rejects(
    () => expired.accessToken(id),
    err => err.signedOut === true
  );
});

test('playtime is summed per app in minutes; LauncherInstalled skips engine installs', () => {
  assert.deepEqual(
    e.parsePlaytime([
      { artifactId: 'Fortnite', totalTime: 3600 },
      { artifactId: 'Fortnite', totalTime: 60 },
      { x: 1 },
    ]),
    {
      Fortnite: 61,
    }
  );
  assert.throws(() => e.parsePlaytime({}));
  assert.deepEqual(
    e
      .parseLauncherInstalled({
        InstallationList: [
          { AppName: 'Game', InstallLocation: 'C:/G', NamespaceId: 'n', ItemId: 'i' },
          { AppName: 'UE_5.4', InstallLocation: 'C:/UE' },
        ],
      })
      .map(x => x.appId),
    ['Game']
  );
});
