const test = require('node:test'),
  assert = require('node:assert/strict');
const { epicProfile } = require('../src/epic-auth.cjs');
const id = 'a'.repeat(32);
test('Epic profile accepts protected response envelopes and account_id but returns no secrets', () => {
  assert.deepEqual(
    epicProfile({
      data: JSON.stringify({
        user: { account_id: id, display_name: ' Player ', access_token: 'secret', email: 'private' },
      }),
    }),
    { id, name: 'Player', avatar: '' }
  );
  assert.equal(epicProfile({ errorCode: 'denied', data: { id, displayName: 'Fake' } }), null);
  assert.equal(epicProfile({ data: { isLoggedIn: false, id, displayName: 'Fake' } }), null);
  assert.equal(epicProfile({ displayName: 'Nickname only' }), null);
});
