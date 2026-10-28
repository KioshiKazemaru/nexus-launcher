const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  SignedOut,
  parseSteamAccount,
  parseSteamCommunity,
  parseEpicAccount,
  AccountMonitor,
  verifyAccount,
} = require('../src/accounts.cjs');
const id = '76561198012345678';
test('Steam profile is accepted only from authenticated account page', () => {
  const p = parseSteamAccount(
    `<script>var g_steamID = "${id}";</script><span id="account_pulldown">test &amp; player</span>`,
    'https://store.steampowered.com/account/'
  );
  assert.equal(p.id, id);
  assert.equal(p.name, 'test & player');
  assert.throws(() =>
    parseSteamAccount('<span id="account_pulldown">someone</span>', 'https://store.steampowered.com/account/')
  );
});
test('redirect to login and anonymous Steam globals never confirm login', () => {
  assert.throws(
    () => parseSteamAccount('', 'https://store.steampowered.com/login/?redir=account'),
    SignedOut
  );
  assert.throws(
    () => parseSteamAccount('var g_steamID = false;', 'https://store.steampowered.com/account/'),
    SignedOut
  );
});
test('persona data must match the authenticated SteamID', () => {
  const profile = { id, name: 'account' };
  assert.deepEqual(
    parseSteamCommunity(
      '<profile><steamID64>76561198000000000</steamID64><steamID>other</steamID></profile>',
      id,
      profile
    ),
    profile
  );
  assert.equal(
    parseSteamCommunity(
      `<profile><steamID64>${id}</steamID64><steamID><![CDATA[My nickname]]></steamID></profile>`,
      id,
      profile
    ).name,
    'My nickname'
  );
});
test('Epic requires an account id and display name, not just cookies or a nickname', () => {
  assert.equal(
    parseEpicAccount({ data: { accountInfo: { accountId: 'a'.repeat(32), displayName: 'Epic player' } } })
      .name,
    'Epic player'
  );
  assert.throws(() => parseEpicAccount({ displayName: 'unverified' }));
  assert.throws(() => parseEpicAccount({ isLoggedIn: false }), SignedOut);
});
test('logout invalidates a previously pending account verification', async () => {
  let finish;
  const m = new AccountMonitor(() => new Promise(resolve => (finish = resolve)));
  const check = m.refresh('steam');
  m.forget('steam');
  finish({ id, name: 'Old' });
  await check;
  assert.equal(m.states.steam.status, 'signedOut');
});
test('only successful checks mark account connected; failures do not keep green status', async () => {
  let fails = false;
  const m = new AccountMonitor(async () => {
    if (fails) throw Error('offline');
    return { id, name: 'Player' };
  });
  await m.refresh('steam');
  assert.equal(m.states.steam.status, 'connected');
  fails = true;
  await m.refresh('steam');
  assert.equal(m.states.steam.status, 'unavailable');
});
test('network 403 is not reported as successful authentication', async () => {
  await assert.rejects(() => verifyAccount('epic', async () => ({ ok: false, status: 403 })), /403/);
});

test('only a verified login window closes; checkout stays open', () => {
  const { shouldCloseLogin } = require('../src/accounts.cjs');
  const profile = { status: 'connected', id, name: 'Player' };
  assert.equal(shouldCloseLogin('login', profile), true);
  assert.equal(shouldCloseLogin('checkout', profile), false);
  assert.equal(shouldCloseLogin('login', { status: 'unavailable', id, name: 'Player' }), false);
  assert.equal(shouldCloseLogin('login', { status: 'connected' }), false);
});

test('modern Steam userdata, numeric globals and cookie identity with verified account header', () => {
  const url = 'https://store.steampowered.com/account/';
  assert.equal(
    parseSteamAccount(
      `<div data-userinfo='{"steamid":"${id}","logged_in":true}'></div><div id="account_pulldown">Modern</div>`,
      url
    ).id,
    id
  );
  assert.equal(
    parseSteamAccount(`<script>g_steamID=${id};</script><div id="account_pulldown">Numeric</div>`, url).id,
    id
  );
  assert.equal(parseSteamAccount('<div id="account_pulldown">Verified by server</div>', url, id).id, id);
  assert.throws(() => parseSteamAccount('<form>Log in</form>', url, id), SignedOut);
  assert.throws(() =>
    parseSteamAccount(
      '<div id="account_pulldown">Old header</div>',
      'https://store.steampowered.com.evil.test/account/',
      id
    )
  );
  assert.throws(
    () =>
      parseSteamAccount(
        '<div id="account_pulldown">Old header</div><script>g_steamID=false</script>',
        url,
        id
      ),
    SignedOut
  );
});
test('Steam cookie extraction only yields an unambiguous account id, never a token', () => {
  const { steamCookieId } = require('../src/accounts.cjs');
  const cookie = { name: 'steamLoginSecure', domain: '.store.steampowered.com', value: id + '%7C%7Csecret' };
  assert.equal(steamCookieId([cookie]), id);
  assert.equal(steamCookieId([{ ...cookie, domain: 'evil.test' }]), '');
  assert.equal(steamCookieId([cookie, { ...cookie, value: '76561198000000000%7C%7Cother' }]), '');
});
