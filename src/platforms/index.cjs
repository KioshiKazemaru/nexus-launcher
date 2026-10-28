'use strict';
// Nexus supports exactly two stores: Steam and Epic Games. Each platform file
// describes how installed games are found and how the official client is
// asked to launch, install or uninstall a game.
//
//   id, name                 'steam' | 'epic'
//   scanInstalled(ctx)       → { offers, errors } games installed on this PC
//   launchUri(offer)         → URI handled by the official client
//   clientUri(action, offer) → install / uninstall / verify through the client
//   storeUrl(game)           → official store page

const steam = require('./steam.cjs');
const epic = require('./epic.cjs');

const registry = new Map([
  [steam.id, steam],
  [epic.id, epic],
]);

module.exports = {
  get: id => registry.get(id),
  list: () => [...registry.values()],
};
