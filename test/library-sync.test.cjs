const test = require('node:test'),
  assert = require('node:assert/strict');
const { interruptedLibrary, shouldAttemptLibrary } = require('../src/library-sync.cjs');
test('lost Steam verification ends loading, while another account and completed sync stay unchanged', () => {
  const loading = {
    status: 'loading',
    accountId: 'steam-user',
    count: 15,
    source: 'account',
    attemptedAt: 100,
  };
  const interrupted = interruptedLibrary(loading, {
    status: 'unavailable',
    id: 'steam-user',
    message: 'Проверка недоступна',
  });
  assert.equal(interrupted.status, 'error');
  assert.equal(interrupted.count, 15);
  assert.equal(interrupted.message, 'Проверка недоступна');
  assert.equal(interruptedLibrary(loading, { status: 'unavailable', id: 'other' }), loading);
  assert.equal(
    interruptedLibrary(
      { status: 'ready', accountId: 'steam-user' },
      { status: 'unavailable', id: 'steam-user' }
    ).status,
    'ready'
  );
});
test('automatic failed synchronization cools down, explicit retry remains available', () => {
  const error = { status: 'error', accountId: 'steam-user', attemptedAt: 100 };
  assert.equal(shouldAttemptLibrary(error, 'steam-user', false, 200), false);
  assert.equal(shouldAttemptLibrary(error, 'steam-user', true, 200), true);
  assert.equal(shouldAttemptLibrary(error, 'steam-user', false, 900101), true);
  assert.equal(shouldAttemptLibrary(error, 'other', false, 200), true);
});
