const { imageUrl } = require('./providers.cjs');
function parseLegendaryList(json, accountId) {
  if (!Array.isArray(json) || json.length > 10000)
    throw Error('Ожидается JSON-массив команды legendary list --json');
  const result = new Map();
  for (const game of json) {
    if (!game || typeof game !== 'object' || Array.isArray(game)) continue;
    const asset = game.asset_infos?.Windows || {};
    const appId = game.app_name,
      namespace = game.namespace || asset.namespace || game.metadata?.namespace,
      itemId = game.catalog_item_id || asset.catalog_item_id || game.metadata?.id,
      name = game.app_title;
    if (![appId, namespace, itemId, name].every(x => typeof x === 'string' && x.trim() && x.length < 300))
      continue;
    if (
      namespace === 'ue' ||
      game.is_dlc === true ||
      game.metadata?.mainGameItem ||
      game.metadata?.mainGameItemList?.length
    )
      continue;
    const category = game.metadata?.categories || [];
    if (category.some(c => /^(?:addons|dlc|software|mods|bundles)(?:\/|$)/i.test(c.path || c))) continue;
    const images = game.metadata?.keyImages || [];
    const picture = types =>
      types.map(t => imageUrl(images.find(i => i.type === t)?.url)).find(Boolean) || '';
    result.set(namespace + ':' + appId, {
      provider: 'epic',
      appId,
      namespace,
      itemId,
      accountId,
      name: name.trim(),
      image: picture(['DieselStoreFrontWide', 'OfferImageWide', 'DieselGameBox', 'Thumbnail']),
      portrait: picture(['DieselGameBoxTall', 'OfferImageTall']),
      owned: true,
      installed: false,
      licenseUnknown: true,
      source: 'legendary-import',
    });
  }
  if (json.length && !result.size) throw Error('В файле нет подходящих игр Epic Games для Windows');
  return [...result.values()];
}
module.exports = { parseLegendaryList };
