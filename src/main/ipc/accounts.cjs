'use strict';
// Steam and Epic accounts (sign-in, remember, forget) and the keys of outside services.
const { bool, isAccountKey, isProvider, wrappers } = require('./helpers.cjs');

function registerAccountsIpc(register, ctx) {
  const { accounts, integrations } = ctx;
  const { withState } = wrappers(ctx);

  register(
    'refreshAccounts',
    withState(() => accounts.refreshAll())
  );
  register(
    'remember',
    withState(({ provider, enabled }) => {
      if (!isProvider(provider)) throw Error('Некорректные параметры');
      return accounts.setRemember(provider, bool(enabled));
    })
  );
  register('login', p => {
    const args = typeof p === 'string' ? { provider: p } : p || {};
    if (!isProvider(args.provider)) throw Error('Неизвестный магазин');
    return accounts.login({ provider: args.provider, add: args.add === true });
  });
  register(
    'epicCode',
    withState(text => accounts.epicCode(text))
  );
  register('browser', p => {
    if (!isProvider(p)) throw Error('Неизвестный магазин');
    return accounts.openInBrowser(p);
  });
  register(
    'forget',
    withState(key => {
      if (!isAccountKey(key)) throw Error('Неизвестный аккаунт');
      return accounts.forget(key);
    })
  );
  register(
    'setKey',
    withState(({ name, value }) => integrations.setKey(name, value))
  );
}

module.exports = { registerAccountsIpc };
