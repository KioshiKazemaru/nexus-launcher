'use strict';
// The store: catalogue, prices and their watches, region, wishlist, purchase windows.
const { bool, optionalAccount, wrappers } = require('./helpers.cjs');

function registerStoreIpc(register, ctx) {
  const { store, accounts, settings } = ctx;
  const { withState, save } = wrappers(ctx);

  register('searchCatalog', p => store.search(p));
  register('browseCatalog', p => store.browse(p));
  register('homeCatalog', p => store.home(p));
  register('browseDlc', p => store.dlc(p));
  register('recommendations', p => store.recommendations(p));
  register('gamePrices', p => store.gamePrices(p));
  register('gameDeals', p => store.deals(p));
  register('gameStorePage', p => store.storePage(p), { quiet: true });
  register('watchHistory', key => settings.priceWatches.find(w => w.key === key)?.history || []);
  register(
    'refreshCatalogPrices',
    withState(() => store.initialPrices())
  );
  register(
    'watchPrice',
    withState(p => store.watch(p))
  );
  register(
    'checkPrices',
    withState(() => store.watcher.check())
  );
  register(
    'removeWatch',
    withState(key => store.unwatch(key))
  );
  register(
    'priceTarget',
    withState(p => store.target(p))
  );
  register(
    'country',
    save(country => {
      store.checkCountry(country);
      settings.storeCountry = country;
      store.initialPrices().catch(e => ctx.log.warn('prices', e.message));
    })
  );
  register(
    'toggle',
    withState(p => store.toggle(p))
  );
  register(
    'preferred',
    save(({ id, provider }) => {
      if (!['steam', 'epic', 'custom'].includes(provider) || typeof id !== 'string' || id.length > 200)
        throw Error('Некорректная платформа');
      settings.preferred[id] = provider;
    })
  );
  register('buy', ({ id, provider, account }) => {
    const acc = optionalAccount(account);
    const url = store.buyUrl({ id, provider, account: acc });
    const target = accounts.checkoutTarget(provider, acc, true);
    ctx.windows.open({ key: target.key, provider, session: target.session, url, purpose: 'checkout' });
    return { opened: true, account: target.account?.name || null };
  });
  register('claimFree', ({ appId, account }) => {
    const acc = optionalAccount(account);
    const url = store.claimUrl({ appId });
    const target = accounts.checkoutTarget('epic', acc, true);
    ctx.windows.open({
      key: target.key,
      provider: 'epic',
      session: target.session,
      url,
      purpose: 'checkout',
    });
    return { opened: true, account: target.account?.name || null };
  });
  register('freeGames', () => store.freeGames(true));
  register('syncWishlists', async () => ({
    report: await store.syncWishlists(),
    state: ctx.hub.reply(),
  }));
  register('deals', p => store.deals(p || {}), { quiet: true });
  // «Войти в магазин Epic»: the official store window, signed in with a one-time code.
  register('epicStoreSignIn', async key => {
    const target = accounts.checkoutTarget('epic', optionalAccount(key));
    if (!target.account) throw Error('Сначала подключите аккаунт Epic Games');
    const url = await store.epicStoreSignInUrl(target.account);
    ctx.windows.open({
      key: target.key,
      provider: 'epic',
      session: target.session,
      url,
      purpose: 'wishlist',
    });
    return { opened: true };
  });
  register('importWishlists', async () => ({
    report: await store.importWishlists(),
    state: ctx.hub.reply(),
  }));
  register(
    'notifyWishSales',
    save(enabled => (settings.notifyWishSales = bool(enabled)))
  );
  // The bell: opened (everything read), one notice removed, all cleared.
  register(
    'noticesRead',
    withState(() => ctx.notices.readAll()),
    { quiet: true }
  );
  register(
    'noticeRemove',
    withState(id => {
      if (typeof id !== 'string' || id.length > 40) throw Error('Некорректное уведомление');
      ctx.notices.remove(id);
    })
  );
  register(
    'noticesClear',
    withState(() => ctx.notices.clear())
  );
  register(
    'notifyGiveaways',
    save(enabled => (settings.notifyGiveaways = bool(enabled)))
  );
}

module.exports = { registerStoreIpc };
