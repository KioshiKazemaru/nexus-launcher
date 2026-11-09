'use strict';
// Every IPC channel of the windows, grouped by the service behind it:
//   app.cjs       window state, updates, start with Windows, backup, logs, links
//   store.cjs     catalogue, prices and watches, region, wishlist, purchase windows
//   accounts.cjs  Steam / Epic sign-in, keys of outside services
//   library.cjs   scan, sync, imports, merging, collections, news, Workshop
//   games.cjs     play, install, downloads, storage, uninstall, cloud saves
//   social.cjs    friends, chat, profiles, status, overlay
// `register(name, fn, options)` comes from main.cjs: it checks which window sent
// the call and turns errors into { ok: false, error }.
const { registerAppIpc } = require('./app.cjs');
const { registerStoreIpc } = require('./store.cjs');
const { registerAccountsIpc } = require('./accounts.cjs');
const { registerLibraryIpc } = require('./library.cjs');
const { registerGamesIpc } = require('./games.cjs');
const { registerSocialIpc } = require('./social.cjs');

function registerAllIpc(register, ctx, deps) {
  for (const add of [
    registerAppIpc,
    registerStoreIpc,
    registerAccountsIpc,
    registerLibraryIpc,
    registerGamesIpc,
    registerSocialIpc,
  ])
    add(register, ctx, deps);
}

module.exports = { registerAllIpc };
