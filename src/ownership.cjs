function ownedOffers(games) {
  return games.flatMap(g =>
    (g.offers || [])
      .filter(o => o.owned === true && ['steam', 'epic'].includes(o.provider))
      .map(o => ({
        provider: o.provider,
        appId: String(o.appId || ''),
        namespace: o.namespace || '',
        itemId: o.itemId || '',
      }))
  );
}
function ownsOffer(owned, offer) {
  if (!offer || !['steam', 'epic'].includes(offer.provider)) return false;
  return owned.some(o => {
    if (o.provider !== offer.provider) return false;
    if (o.provider === 'steam') return /^\d+$/.test(o.appId) && o.appId === String(offer.appId || '');
    if (o.namespace && offer.namespace && o.namespace !== offer.namespace) return false;
    if (o.appId && offer.appId && o.appId === String(offer.appId)) return true;
    return !!(
      o.namespace &&
      o.itemId &&
      o.namespace === offer.namespace &&
      offer.items?.some(i => i.namespace === o.namespace && i.id === o.itemId)
    );
  });
}
module.exports = { ownedOffers, ownsOffer };
