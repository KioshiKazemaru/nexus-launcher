// Extracts a verified Epic profile (id + display name) from Epic account API
// responses. Secrets in the same payload are never returned.
// Only profile fields are returned from the official, authenticated account page.
function epicProfile(json) {
  const queue = [json];
  let visited = 0;
  while (queue.length && visited++ < 30) {
    let x = queue.shift();
    if (typeof x === 'string') {
      try {
        x = JSON.parse(x);
      } catch {
        continue;
      }
    }
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    if (x.errorCode || x.error || x.isLoggedIn === false || x.loggedIn === false) continue;
    const id = x.accountId || x.account_id || x.id,
      name = x.displayName || x.display_name;
    if (typeof id === 'string' && /^[a-f0-9]{32}$/i.test(id) && typeof name === 'string' && name.trim())
      return { id, name: name.trim().slice(0, 100), avatar: '' };
    for (const key of [
      'data',
      'account',
      'accountInfo',
      'user',
      'userInfo',
      'profile',
      'personal',
      'personalDetails',
    ])
      if (x[key]) queue.push(x[key]);
  }
  return null;
}
module.exports = { epicProfile };
