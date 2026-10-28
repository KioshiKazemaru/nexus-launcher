'use strict';
const { scanSteam, launchUri, storeUrl } = require('../core.cjs');

// steam://uninstall and steam://validate are handled by the Steam client,
// which asks the user to confirm.
function clientUri(action, offer) {
  if (!/^\d+$/.test(String(offer?.appId))) throw Error('Некорректная игра Steam');
  if (action === 'install') return `steam://install/${offer.appId}`;
  if (action === 'uninstall') return `steam://uninstall/${offer.appId}`;
  if (action === 'verify') return `steam://validate/${offer.appId}`;
  throw Error('Неизвестное действие');
}

module.exports = {
  id: 'steam',
  name: 'Steam',
  scanInstalled: ({ steamRoots }) => scanSteam(steamRoots || []),
  launchUri,
  clientUri,
  storeUrl: game => storeUrl('steam', game),
};
