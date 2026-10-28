'use strict';
// Game library: installed games found on this PC plus account libraries of
// every connected Steam/Epic account, merged into one list.
//
// Disk is read only by scanLocal(). Everything else calls rebuild(), which
// recomputes the merged list in memory.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { catalog } = require('../catalog.cjs');
const { mergeGames, parseVdf } = require('../core.cjs');
const {
  steamOwned,
  parseSteamGames,
  parseSteamStoreLibrary,
  epicOwned,
  epicMetadata,
  STEAM_OWNED_PROBE,
  scopedGames,
} = require('../owned.cjs');
const steamLib = require('../steam-library.cjs');
const { fetchPlaytime } = require('../epic-oauth.cjs');
const { parseLegendaryList } = require('../legendary-import.cjs');
const { interruptedLibrary, shouldAttemptLibrary } = require('../library-sync.cjs');
const { steamCookieId, parseSteamAccount, STEAM_WINDOW_PROBE } = require('../accounts.cjs');
const { pairKey, suggestions } = require('../matching.cjs');
const { remapGameIds } = require('../game-ids.cjs');
const collections = require('../collections.cjs');
const achievements = require('../achievements.cjs');
const platforms = require('../platforms/index.cjs');

const ART_RETRY = 24 * 3600 * 1000;
const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

function otherName(before, after) {
  const names = [before.altName, before.name].filter(n => n && n !== before.appId && n !== after.name);
  return names[names.length - 1] || after.altName || '';
}

class LibraryService {
  constructor(ctx) {
    this.ctx = ctx;
    this.local = { offers: [], errors: [], steamRoots: [] };
    this.cloud = {}; // account key → offers
    this.state = {}; // account key → sync state
    this.checks = {}; // account key → in-flight sync
    this.games = [];
    this.artMisses = new Map();
    this.offerToGame = new Map();
    this.progress = {};
    this.localSignature = '';
    this.achievementCache = new Map();
    this.steamTypes = new Map(); // appId → Steam store type (0 = game), learned from GetItems
    this.steamAssets = new Map(); // appId → { image, portrait } real store image paths
    this.steamAssetsAsked = new Set();
    this.version = 0;
    this.suggestionsCache = null;
    this.artCache = new Map();
    this.localMeta = {}; // steam appId → { lastPlayed, playtime } from localconfig.vdf
    const raw = ctx.storage.loadOwned();
    // v1 cache was keyed by provider; v2 by provider:accountId.
    this.ownedCache = {};
    for (const [k, v] of Object.entries(raw)) {
      if ((k === 'steam' || k === 'epic') && v?.accountId) this.ownedCache[`${k}:${v.accountId}`] = v;
      else if (/^(steam|epic):/.test(k)) this.ownedCache[k] = v;
    }
  }
  cacheKey(key) {
    const s = this.ctx.accounts.monitor.states[key];
    return s?.id ? `${key.split(':')[0]}:${s.id}` : null;
  }
  saveOwned() {
    this.ctx.storage.saveOwned(this.ownedCache);
  }

  // ---- local scan -------------------------------------------------------

  async discoverSteam() {
    if (process.platform !== 'win32') return [this.ctx.settings.steamRoot].filter(Boolean);
    const roots = [
      this.ctx.settings.steamRoot,
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
    ];
    try {
      const { stdout } = await promisify(execFile)(
        'reg.exe',
        ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
        {
          windowsHide: true,
          timeout: 5000,
        }
      );
      const m = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/);
      if (m) roots.push(path.normalize(m[1].trim()));
    } catch {}
    return [...new Set(roots.filter(Boolean))];
  }
  async readLocal() {
    const steamRoots = await this.discoverSteam();
    const results = await Promise.all(
      platforms.list().map(p =>
        p
          .scanInstalled({
            steamRoots,
            settings: this.ctx.settings,
            nexusEpicDir: this.ctx.storage?.file?.('epic-manifests'),
          })
          .catch(e => {
            this.ctx.log.warn('scan', `${p.id}: ${e.message}`);
            return { offers: [], errors: [] };
          })
      )
    );
    const custom = await Promise.all(
      this.ctx.settings.custom.map(async x => {
        const time = this.ctx.settings.customPlaytime[x.id] || {};
        return {
          provider: 'custom',
          appId: x.id,
          name: x.name,
          installed: await fsp
            .access(x.exe)
            .then(() => true)
            .catch(() => false),
          source: 'manual',
          exe: x.exe,
          trackProcess: x.trackProcess || '',
          playtime: Number(time.minutes) || 0,
          lastPlayed: Number(time.lastPlayed) || 0,
        };
      })
    );
    return {
      offers: [...results.flatMap(r => r.offers), ...custom].filter(o => this.isGameOffer(o)),
      errors: results.flatMap(r => r.errors),
      steamRoots,
      steamAll: results
        .flatMap(r => r.offers)
        .filter(o => o.provider === 'steam')
        .map(o => o.appId),
    };
  }
  // Installed Steam apps include tools (redistributables, Proton, SteamVR) and
  // software. Known tools are dropped at once; others once the store says so.
  isGameOffer(o) {
    if (o.provider !== 'steam') return true;
    if (steamLib.STEAM_TOOL_IDS.has(String(o.appId))) return false;
    const type = this.steamTypes.get(String(o.appId));
    return type === undefined || type === null || type === 0;
  }
  rememberAssets(items) {
    for (const [id, info] of items) {
      this.steamAssetsAsked.add(id);
      if (info.image || info.portrait)
        this.steamAssets.set(id, { image: info.image, portrait: info.portrait });
    }
  }
  // Real image paths for Steam games (new apps have no plain header.jpg).
  // Each app is asked once per session; found images trigger one rebuild.
  async hydrateSteamAssets() {
    if (this.assetsRunning) return;
    const ids = [
      ...new Set(
        this.games.flatMap(g => g.offers.filter(o => o.provider === 'steam').map(o => String(o.appId)))
      ),
    ].filter(id => !this.steamAssetsAsked.has(id));
    if (!ids.length) return;
    this.assetsRunning = true;
    try {
      for (const id of ids) this.steamAssetsAsked.add(id);
      const before = this.steamAssets.size;
      this.rememberAssets(
        await steamLib.storeItems(this.ctx.publicFetch, ids, this.ctx.settings.storeCountry)
      );
      if (this.steamAssets.size !== before) this.rebuild();
    } catch (e) {
      for (const id of ids) this.steamAssetsAsked.delete(id);
      this.ctx.log.debug('art', `steam assets: ${e.message}`);
    } finally {
      this.assetsRunning = false;
    }
  }
  // Asks the store for the type of installed apps it has not classified yet.
  async classifyLocalSteam(local) {
    const unknown = (local.steamAll || []).filter(
      id => !this.steamTypes.has(id) && !steamLib.STEAM_TOOL_IDS.has(id)
    );
    if (!unknown.length) return false;
    try {
      const items = await steamLib.storeItems(this.ctx.publicFetch, unknown, this.ctx.settings.storeCountry);
      this.rememberAssets(items);
      for (const id of unknown) {
        const info = items.get(id);
        // Delisted apps are unknown to the store: treat them as games.
        this.steamTypes.set(id, info?.ok && Number.isInteger(info.type) ? info.type : 0);
      }
    } catch (e) {
      this.ctx.log.debug('scan', `steam types: ${e.message}`);
      return false;
    }
    return local.offers.length !== local.offers.filter(o => this.isGameOffer(o)).length;
  }
  // What the library depends on, without download progress: a progress-only
  // change must not rebuild the library.
  static signature(local) {
    return [
      local.steamRoots.join('|'),
      ...local.offers
        .map(
          o =>
            `${o.provider}:${o.appId}:${o.installed ? 1 : 0}:${o.name}:${o.playtime || 0}:${o.lastPlayed || 0}`
        )
        .sort(),
    ].join('\n');
  }
  // previous: the last map (with speed). Speed = written bytes per second
  // between two scans (smoothed); eta = seconds left at that speed.
  static progressMap(local, previous = {}, now = Date.now()) {
    const out = {};
    for (const o of local.offers) {
      if (!o.progress) continue;
      const key = `${o.provider}:${o.appId}`;
      const p = { ...o.progress, provider: o.provider, at: now };
      const old = previous[key];
      if (
        old &&
        old.state === p.state &&
        Number.isFinite(p.done) &&
        Number.isFinite(old.done) &&
        now > old.at
      ) {
        const instant = Math.max(0, (p.done - old.done) / ((now - old.at) / 1000));
        p.speed = Number.isFinite(old.speed)
          ? Math.round(old.speed * 0.5 + instant * 0.5)
          : Math.round(instant);
      }
      if (p.speed > 0 && Number.isFinite(p.total))
        p.eta = Math.max(0, Math.round((p.total - p.done) / p.speed));
      out[key] = p;
    }
    return out;
  }
  // Steam and Epic write their install folders while they download: watching
  // them starts the progress display also for downloads started in the clients.
  watchClientFolders() {
    if (process.platform !== 'win32') return;
    const dirs = [
      ...(this.local.steamRoots || []).map(r => path.join(r, 'steamapps')),
      path.join(platforms.get('epic').manifestDir(), 'Pending'),
      platforms.get('epic').manifestDir(),
    ];
    this.folderWatchers ||= new Map();
    for (const dir of dirs) {
      if (this.folderWatchers.has(dir)) continue;
      try {
        const w = fs.watch(dir, { persistent: false }, (_e, name) => {
          if (name && !/\.(acf|item)$/i.test(name)) return;
          clearTimeout(this.folderTimer);
          this.folderTimer = setTimeout(() => this.expectChange(2 * 60 * 1000), 1500);
          this.folderTimer.unref?.();
        });
        w.on('error', () => {});
        this.folderWatchers.set(dir, w);
      } catch {}
    }
  }
  async scanLocal() {
    const local = await this.readLocal();
    this.local = local;
    this.localSignature = LibraryService.signature(local);
    this.progress = LibraryService.progressMap(local, this.progress);
    await this.readSteamLocalMeta();
    this.rebuild();
    this.watchProgress();
    this.watchClientFolders();
    this.classify(local);
  }
  // In the background: drop installed tools and software once the store classifies them.
  classify(local) {
    this.classifying = this.classifyLocalSteam(local)
      .then(changed => {
        if (changed && this.local === local) {
          this.local = { ...local, offers: local.offers.filter(o => this.isGameOffer(o)) };
          this.localSignature = LibraryService.signature(this.local);
          this.rebuild();
        }
      })
      .catch(e => this.ctx.log.warn('scan', e.message));
    return this.classifying;
  }
  // Re-reads the manifests; rebuilds only if something besides progress changed.
  async pollProgress() {
    const local = await this.readLocal();
    if (LibraryService.signature(local) !== this.localSignature) {
      this.local = local;
      this.localSignature = LibraryService.signature(local);
      this.progress = LibraryService.progressMap(local, this.progress);
      await this.readSteamLocalMeta();
      this.rebuild();
      // An app installed while Nexus runs may be a tool or software.
      this.classify(local);
    } else {
      const next = LibraryService.progressMap(local, this.progress);
      const visible = m =>
        JSON.stringify(Object.entries(m).map(([k, p]) => [k, p.state, p.percent, p.done, p.speed]));
      if (visible(next) !== visible(this.progress)) {
        this.progress = next;
        this.local.offers = local.offers;
        this.ctx.hub.publish();
      }
    }
    this.watchProgress();
  }
  // Download progress per game id, from the latest scan.
  progressByGame() {
    const out = {};
    for (const [key, p] of Object.entries(this.progress || {})) {
      const id = this.offerToGame.get(key);
      if (id) out[id] = p;
    }
    return out;
  }
  // While Steam downloads something (or right after an install/uninstall
  // request) the manifests are re-read every 5 seconds to show progress.
  expectChange(ms = 10 * 60 * 1000) {
    this.progressUntil = Date.now() + ms;
    this.watchProgress();
  }
  watchProgress() {
    const busy = Object.keys(this.progress || {}).length > 0 || Date.now() < (this.progressUntil || 0);
    if (!busy || this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.pollProgress().catch(e => this.ctx.log.warn('scan', e.message));
    }, 5000);
    this.progressTimer.unref?.();
  }
  // Last played / playtime of the signed-in Steam accounts from localconfig.vdf.
  async readSteamLocalMeta() {
    const meta = {};
    const ids = this.ctx.accounts
      .connected('steam')
      .map(a => steamLib.toAccountId32(a.id))
      .filter(Boolean);
    for (const root of this.local.steamRoots) {
      for (const id of ids) {
        try {
          const text = await fsp.readFile(
            path.join(root, 'userdata', id, 'config', 'localconfig.vdf'),
            'utf8'
          );
          for (const [appId, v] of Object.entries(steamLib.parseLocalConfig(parseVdf(text)))) {
            const old = meta[appId] || {};
            meta[appId] = {
              lastPlayed: Math.max(old.lastPlayed || 0, v.lastPlayed),
              playtime: Math.max(old.playtime || 0, v.playtime),
            };
          }
        } catch {}
      }
    }
    this.localMeta = meta;
  }
  steamCacheDirs() {
    return this.local.steamRoots.map(r => path.join(r, 'appcache', 'librarycache'));
  }

  // ---- merge ------------------------------------------------------------

  rebuild() {
    const settings = this.ctx.settings;
    const cloudOffers = Object.values(this.cloud).flat();
    const nexusTime = settings.nexusPlaytime || {};
    const offers = [...cloudOffers, ...this.local.offers].map(o => {
      // Epic does not record games started without its launcher: Nexus adds its own minutes.
      const own = o.provider === 'epic' ? nexusTime[`epic:${o.appId}`] : null;
      if (own)
        o = {
          ...o,
          playtime: (Number(o.playtime) || 0) + (Number(own.minutes) || 0),
          lastPlayed: Math.max(Number(o.lastPlayed) || 0, Number(own.lastPlayed) || 0),
        };
      const m = o.provider === 'steam' ? this.localMeta[o.appId] : null;
      return m
        ? {
            ...o,
            lastPlayed: Math.max(o.lastPlayed || 0, m.lastPlayed),
            playtime: Math.max(o.playtime || 0, m.playtime),
          }
        : o;
    });
    const games = mergeGames(offers, {
      links: settings.links.map(l => [l.a, l.b]),
      splits: new Set(settings.splits),
      externalId: o => this.ctx.integrations.externalId(o),
    });
    for (const g of games) {
      const steam = g.offers.find(o => o.provider === 'steam');
      if (steam) g.steam = steam.appId;
      const known = catalog.find(c => c.id === g.id);
      const meta = this.ctx.integrations.metadata(g);
      const assets = steam ? this.steamAssets.get(String(steam.appId)) : null;
      g.image =
        known?.image ||
        assets?.image ||
        (steam ? steamLib.steamImage(steam.appId) : '') ||
        g.offers.find(o => o.image)?.image ||
        this.artCache.get(g.id) ||
        meta?.image ||
        '';
      g.portrait =
        this.ctx.integrations.portrait(g) ||
        g.offers.find(o => o.portrait)?.portrait ||
        known?.portrait ||
        (steam && this.local.steamRoots.length ? `nexus-art://steam/${steam.appId}/portrait` : '') ||
        assets?.portrait ||
        meta?.cover ||
        '';
      if (assets?.portrait) g.portraitCdn = assets.portrait;
      else delete g.portraitCdn;
      if (!g.desc && meta?.summary) g.desc = meta.summary;
      if ((!g.tags?.length || g.tags[0] === 'Моя библиотека') && meta?.genres?.length) g.tags = meta.genres;
      g.playtime = Math.max(0, ...g.offers.map(o => Number(o.playtime) || 0));
      g.lastPlayed = Math.max(0, ...g.offers.map(o => Number(o.lastPlayed) || 0));
    }
    const hidden = new Set(settings.hidden);
    for (const g of games) {
      g.hidden = hidden.has(g.id) || (g.aliases || []).some(a => hidden.has(a));
      g.collections = settings.collections.filter(c => c.games.includes(g.id)).map(c => c.id);
    }
    this.games = games;
    this.offerToGame = new Map(games.flatMap(g => g.offers.map(o => [`${o.provider}:${o.appId}`, g.id])));
    this.version++;
    this.suggestionsCache = null;
    if (remapGameIds(settings, games)) this.ctx.storage.saveSettings();
    this.ctx.hub.publish();
    this.hydrateArt().catch(e => this.ctx.log?.warn('art', e.message));
    this.hydrateSteamAssets();
    this.ctx.integrations.enqueue(games);
    return games;
  }
  // Computed once per rebuild, not on every state message.
  suggestions() {
    if (!this.suggestionsCache)
      this.suggestionsCache = suggestions(this.visible(), new Set(this.ctx.settings.splits)).slice(0, 20);
    return this.suggestionsCache;
  }
  // Accounts whose games count as owned: connected ones, and — when the
  // network is down — accounts that were verified before (offline mode).
  profiles() {
    const usable = p =>
      this.ctx.accounts
        .keys(p)
        .map(key => ({ key, ...this.ctx.accounts.monitor.states[key] }))
        .filter(a => a.id && (a.status === 'connected' || (a.status === 'unavailable' && a.verifiedAt)));
    return { steam: usable('steam'), epic: usable('epic') };
  }
  // Memoized per library version and account state (called on every window update).
  visible() {
    const profiles = this.profiles();
    const key = `${this.version}|${JSON.stringify(profiles.steam.map(a => a.id))}|${JSON.stringify(profiles.epic.map(a => a.id))}`;
    if (this.visibleCache?.key !== key) this.visibleCache = { key, games: scopedGames(this.games, profiles) };
    return this.visibleCache.games;
  }
  // Covers for Epic-only and manually added games. One lookup runs at a time;
  // misses are remembered for a day so rebuilds do not repeat the same searches.
  async hydrateArt() {
    if (this.artRunning) {
      this.artAgain = true;
      return;
    }
    this.artRunning = true;
    try {
      do {
        this.artAgain = false;
        const now = Date.now();
        const candidates = this.games.filter(
          g => !g.image && !(now - (this.artMisses.get(g.id) || 0) < ART_RETRY)
        );
        let found = 0;
        for (const g of candidates) {
          const custom = g.offers.find(o => o.provider === 'custom');
          const epic = g.offers.find(o => o.provider === 'epic');
          let image = '';
          try {
            if (epic) image = await this.ctx.store.epicImage(epic, g.name);
            else if (custom) {
              const c = this.ctx.settings.custom.find(x => x.id === custom.appId);
              if (c) image = (await app.getFileIcon(c.exe, { size: 'large' })).toDataURL();
            }
          } catch (e) {
            this.ctx.log.debug('art', `${g.id}: ${e.message}${e.detail ? ' (' + e.detail + ')' : ''}`);
          }
          if (!image) {
            this.artMisses.set(g.id, Date.now());
            continue;
          }
          this.artCache.set(g.id, image);
          for (const x of this.games) if (x.id === g.id) x.image = image;
          // The window receives the game list only when the library version changes.
          if (++found % 10 === 0) this.touch();
        }
        if (found % 10) this.touch();
      } while (this.artAgain);
    } finally {
      this.artRunning = false;
    }
  }
  // Marks the game list as changed without recomputing it.
  touch() {
    this.version++;
    this.visibleCache = null;
    this.ctx.hub.publish();
  }
  // Suggestions for "possibly the same game" and manual link/split.
  link(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a === b || a.length > 300 || b.length > 300)
      throw Error('Некорректные игры');
    const s = this.ctx.settings;
    s.splits = s.splits.filter(x => x !== pairKey(a, b));
    if (!s.links.some(l => pairKey(l.a, l.b) === pairKey(a, b))) s.links.push({ a, b });
    this.ctx.storage.saveSettings();
    this.rebuild();
  }
  split(gameId) {
    const g = this.games.find(x => x.id === gameId);
    if (!g || g.offers.length < 2) throw Error('Эта игра не объединена');
    const { offerKey } = require('../matching.cjs');
    const keys = g.offers.map(offerKey);
    const s = this.ctx.settings;
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const k = pairKey(keys[i], keys[j]);
        if (!s.splits.includes(k)) s.splits.push(k);
        s.links = s.links.filter(l => pairKey(l.a, l.b) !== k);
      }
    this.ctx.storage.saveSettings();
    this.rebuild();
  }

  // ---- account libraries ------------------------------------------------

  accountChanged(key, state) {
    if (state.status === 'connected') {
      this.syncOwned(key).catch(e => this.ctx.log?.warn('library', e.message));
      if (key.startsWith('steam:'))
        this.readSteamLocalMeta()
          .then(() => this.rebuild())
          .catch(e => this.ctx.log?.warn('steam-local', e.message));
    } else if (state.status === 'unavailable') {
      // Offline: show the last saved library of a previously verified account.
      if (state.id && !this.cloud[key]) {
        const cached = this.ownedCache[`${key.split(':')[0]}:${state.id}`];
        if (cached?.offers?.length) {
          this.cloud[key] = cached.offers;
          this.state[key] = {
            status: 'ready',
            provider: key.split(':')[0],
            accountId: state.id,
            count: cached.offers.length,
            checkedAt: cached.checkedAt,
            source: cached.source,
            offline: true,
          };
          this.rebuild();
          return;
        }
      }
      const next = interruptedLibrary(this.state[key], state);
      if (next !== this.state[key]) {
        this.state[key] = next;
        this.ctx.hub.publish();
      }
    } else if (state.status === 'signedOut') {
      delete this.cloud[key];
      this.state[key] = { status: 'signedOut' };
      this.rebuild();
    }
  }
  accountRemoved(key) {
    delete this.cloud[key];
    delete this.state[key];
    this.rebuild();
  }
  async syncAll(force = true) {
    await Promise.all(
      this.ctx.accounts.monitor.keys().map(async key => {
        if (this.ctx.accounts.monitor.states[key]?.status === 'unavailable')
          await this.ctx.accounts.monitor.refresh(key);
        await this.syncOwned(key, force);
      })
    );
  }
  async syncOwned(key, force = false) {
    const monitor = this.ctx.accounts.monitor;
    const profile = monitor.states[key];
    if (profile?.status !== 'connected') return;
    const accountId = profile.id,
      epoch = monitor.epochs[key],
      provider = key.split(':')[0],
      cacheKey = `${provider}:${accountId}`;
    if (this.checks[key]?.accountId === accountId) return this.checks[key].promise;
    if (!shouldAttemptLibrary(this.state[key], accountId, force)) return;
    const cached = this.ownedCache[cacheKey];
    const changed = this.state[key]?.accountId !== accountId;
    const attemptedAt = Date.now();
    this.state[key] = {
      status: 'loading',
      accountId,
      provider,
      count: changed ? cached?.offers?.length || 0 : this.cloud[key]?.length || 0,
      checkedAt: cached?.checkedAt || null,
      attemptedAt,
      source: cached?.source || null,
    };
    if (changed) {
      this.cloud[key] = cached?.offers || [];
      this.rebuild();
    } else this.ctx.hub.publish();
    const valid = () => monitor.epochs[key] === epoch && monitor.states[key]?.id === accountId;
    const work = (async () => {
      try {
        const offers =
          provider === 'steam'
            ? await withTimeout(
                this.steamOwned(key, accountId),
                45000,
                'Steam не ответил за 45 секунд. Сохранённый список оставлен.'
              )
            : await this.epicOwned(accountId);
        if (!valid()) return;
        // Metadata learned earlier (English title, images) survives a fresh list.
        if (provider === 'epic') {
          const before = new Map((this.ownedCache[cacheKey]?.offers || []).map(o => [o.appId, o]));
          for (const o of offers) {
            const old = before.get(o.appId);
            if (!old) continue;
            if (!o.altName && old.altName && old.altName !== o.name) o.altName = old.altName;
            if (old.name !== o.name && old.name !== o.appId && !o.altName) o.altName = old.name;
            o.image ||= old.image;
            o.portrait ||= old.portrait;
            o.englishChecked = old.englishChecked;
          }
        }
        if (monitor.states[key]?.status !== 'connected') {
          this.state[key] = {
            ...this.state[key],
            status: 'error',
            message: 'Проверка входа прервалась. Сохранённые игры оставлены.',
          };
          this.ctx.hub.publish();
          return;
        }
        this.cloud[key] = offers;
        this.ownedCache[cacheKey] = { accountId, offers, checkedAt: Date.now(), source: 'account' };
        this.saveOwned();
        this.state[key] = {
          status: 'ready',
          provider,
          accountId,
          count: offers.length,
          checkedAt: Date.now(),
          source: 'account',
        };
        this.rebuild();
        if (provider === 'epic')
          this.enrichEpic(key, accountId, epoch).catch(e => this.ctx.log?.warn('epic-meta', e.message));
        else if (offers.some(o => /^Steam #/.test(o.name) || !o.playtime))
          this.enrichSteam(key, accountId, epoch).catch(e => this.ctx.log?.warn('steam-meta', e.message));
      } catch (e) {
        if (valid()) {
          this.ctx.log.warn('library', `${key}: ${e.message}`);
          this.state[key] = {
            ...this.state[key],
            status: 'error',
            message: e.message || 'Не удалось загрузить библиотеку',
            attemptedAt,
          };
          this.ctx.hub.publish();
        }
      }
    })();
    this.checks[key] = { accountId, promise: work };
    try {
      await work;
    } finally {
      if (this.checks[key]?.promise === work) delete this.checks[key];
    }
  }

  async steamOwned(key, accountId) {
    const s = this.ctx.accounts.session(key);
    const sessionFetch = (url, options) => s.fetch(url, options);
    const errors = [];
    // 1. Session token → GetOwnedGames: only games, with names and playtime.
    try {
      const offers = await steamLib.fetchOwnedWithToken(sessionFetch, accountId);
      if (offers.length) return offers;
    } catch (e) {
      errors.push(e.message);
    }
    // 2. All licences, filtered to games.
    let licences = null;
    try {
      const requested = 'https://store.steampowered.com/dynamicstore/userdata/?v=' + Date.now();
      const r = await s.fetch(requested, {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(9000),
      });
      const u = new URL(r.url || requested);
      if (r.ok && u.origin === 'https://store.steampowered.com' && u.pathname === '/dynamicstore/userdata/')
        licences = parseSteamStoreLibrary(await r.json(), accountId);
    } catch (e) {
      errors.push(e.message);
    }
    if (!licences?.length) licences = await this.steamWindowLicences(key, accountId).catch(() => null);
    if (licences?.length) {
      try {
        const items = await steamLib.storeItems(
          this.ctx.publicFetch,
          licences.map(o => o.appId),
          this.ctx.settings.storeCountry
        );
        this.rememberAssets(items);
        return this.nameSteam(steamLib.filterGames(licences, items));
      } catch (e) {
        errors.push(e.message);
      }
    }
    // 3. Community page: games only, requires a public game list.
    let community = null;
    for (const suffix of ['?tab=all', '?xml=1']) {
      try {
        const requested = `https://steamcommunity.com/profiles/${accountId}/games/${suffix}`;
        const r = await s.fetch(requested, {
          credentials: 'include',
          signal: AbortSignal.timeout(8000),
        });
        const u = new URL(r.url || requested);
        if (
          r.ok &&
          u.origin === 'https://steamcommunity.com' &&
          u.pathname.startsWith(`/profiles/${accountId}/games`)
        ) {
          community = parseSteamGames(await r.text(), accountId);
          break;
        }
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (community && licences?.length) {
      // Keep only licences the community page knows as games.
      const games = new Map(community.map(o => [o.appId, o]));
      return licences.filter(o => games.has(o.appId)).map(o => ({ ...o, ...games.get(o.appId) }));
    }
    if (community) return community;
    if (licences) return this.nameSteam(licences.map(o => ({ ...o, typeUnknown: true })));
    throw Error(
      'Steam не отдал библиотеку: ' + ([...new Set(errors)].slice(0, 2).join('; ') || 'нет ответа')
    );
  }
  async steamWindowLicences(key, accountId) {
    const s = this.ctx.accounts.session(key);
    const helper = new BrowserWindow({
      show: false,
      webPreferences: { session: s, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    try {
      helper.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await withTimeout(
        helper.loadURL('https://store.steampowered.com/account/'),
        12000,
        'Steam: время ожидания истекло'
      );
      const identity = await helper.webContents.executeJavaScript(STEAM_WINDOW_PROBE);
      const cookieId = steamCookieId(await s.cookies.get({ url: 'https://store.steampowered.com/' }));
      if (!identity || parseSteamAccount(identity.html, identity.url, cookieId).id !== accountId)
        throw Error('Аккаунт Steam изменился');
      return steamOwned(await helper.webContents.executeJavaScript(STEAM_OWNED_PROBE), accountId);
    } finally {
      if (!helper.isDestroyed()) helper.destroy();
    }
  }
  nameSteam(offers) {
    const known = new Map();
    for (const g of this.games)
      for (const o of g.offers)
        if (o.provider === 'steam' && !/^Steam #/.test(o.name)) known.set(o.appId, o.name);
    for (const c of catalog) if (c.steam) known.set(c.steam, c.name);
    for (const v of Object.values(this.ownedCache))
      for (const o of v.offers || [])
        if (o.provider === 'steam' && !/^Steam #/.test(o.name)) known.set(o.appId, o.name);
    return offers.map(o =>
      /^Steam #/.test(o.name) && known.has(o.appId) ? { ...o, name: known.get(o.appId) } : o
    );
  }
  async enrichSteam(key, accountId, epoch) {
    const monitor = this.ctx.accounts.monitor;
    const s = this.ctx.accounts.session(key);
    const r = await s.fetch(`https://steamcommunity.com/profiles/${accountId}/games/?tab=all`, {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok || new URL(r.url || 'https://steamcommunity.com/').origin !== 'https://steamcommunity.com')
      return;
    const names = new Map(parseSteamGames(await r.text(), accountId).map(o => [o.appId, o]));
    if (monitor.epochs[key] !== epoch || monitor.states[key]?.id !== accountId) return;
    let changed = false;
    for (const o of this.cloud[key] || []) {
      const found = names.get(o.appId);
      if (found && (o.name !== found.name || o.playtime !== found.playtime)) {
        Object.assign(o, {
          name: found.name,
          playtime: found.playtime,
          lastPlayed: found.lastPlayed || o.lastPlayed,
        });
        changed = true;
      }
    }
    if (changed) {
      this.ownedCache[`steam:${accountId}`] = {
        accountId,
        offers: this.cloud[key],
        checkedAt: Date.now(),
        source: 'account',
      };
      this.saveOwned();
      this.rebuild();
    }
  }
  async epicOwned(accountId) {
    const token = await this.ctx.accounts.tokens.accessToken(accountId);
    return epicOwned(this.ctx.publicFetch, token, accountId);
  }
  async enrichEpic(key, accountId, epoch) {
    const monitor = this.ctx.accounts.monitor;
    const valid = () =>
      monitor.epochs[key] === epoch &&
      monitor.states[key]?.id === accountId &&
      monitor.states[key]?.status === 'connected';
    const token = await this.ctx.accounts.tokens.accessToken(accountId);
    // Playtime (minutes per appName).
    try {
      const minutes = await fetchPlaytime(this.ctx.publicFetch, token, accountId);
      for (const o of this.cloud[key] || []) if (minutes[o.appId]) o.playtime = minutes[o.appId];
    } catch {}
    // Also asked once: games without an English title (needed to match Steam names).
    const pending = (this.cloud[key] || []).filter(
      o => o.name === o.appId || !o.image || (!o.englishChecked && /[а-яё]/i.test(o.name) && !o.altName)
    );
    let index = 0,
      completed = 0,
      denied = false;
    if (pending.length) {
      this.state[key] = { ...this.state[key], metadataLoading: true };
      this.ctx.hub.publish();
    }
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (index < pending.length && valid() && !denied) {
          const o = pending[index++];
          try {
            const result = await epicMetadata(this.ctx.publicFetch, token, o, this.ctx.settings.storeCountry);
            if (!valid()) return;
            const list = this.cloud[key];
            const i = list.indexOf(o);
            if (i >= 0) {
              // Keep the library title as a second name: the catalogue answers in Russian
              // ("Хогвартс. Наследие"), Steam often in English ("Hogwarts Legacy").
              if (result)
                list[i] = {
                  ...result,
                  altName: otherName(o, result),
                  englishChecked: true,
                  playtime: o.playtime,
                };
              else list.splice(i, 1);
            }
          } catch (e) {
            if (e.status === 401 || e.status === 403) denied = true;
          }
          if (++completed % 25 === 0 && valid()) this.rebuild();
        }
      })
    );
    if (valid()) {
      this.state[key] = { ...this.state[key], metadataLoading: false, count: this.cloud[key].length };
      this.ownedCache[`epic:${accountId}`] = {
        accountId,
        offers: this.cloud[key],
        checkedAt: Date.now(),
        source: 'account',
      };
      this.saveOwned();
      this.rebuild();
    }
  }

  // Legendary JSON as a fallback when the account API is unavailable.
  async importLegendary(main) {
    const accounts = this.ctx.accounts.connected('epic');
    if (!accounts.length) throw Error('Сначала войдите в аккаунт Epic Games в Nexus.');
    const { canceled, filePaths } = await dialog.showOpenDialog(main, {
      title: 'Экспорт Legendary: legendary list --json',
      properties: ['openFile'],
      filters: [{ name: 'Список игр Legendary', extensions: ['json'] }],
    });
    if (canceled) return;
    const stat = await fsp.stat(filePaths[0]);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw Error('Файл должен быть JSON размером до 16 МБ');
    let json;
    try {
      json = JSON.parse(await fsp.readFile(filePaths[0], 'utf8'));
    } catch {
      throw Error('Не удалось прочитать JSON-список Legendary');
    }
    const buttons = [...accounts.map(a => a.name), 'Отмена'];
    const { response } = await dialog.showMessageBox(main, {
      type: 'question',
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
      title: 'Чей это список?',
      message: 'Какому аккаунту Epic принадлежит экспорт Legendary?',
      detail: 'Nexus не может проверить владельца файла. Выберите аккаунт, от которого сделан экспорт.',
    });
    if (response >= accounts.length) return;
    const account = accounts[response];
    const offers = parseLegendaryList(json, account.id);
    this.cloud[account.key] = offers;
    this.ownedCache[`epic:${account.id}`] = {
      accountId: account.id,
      offers,
      checkedAt: Date.now(),
      source: 'legendary',
    };
    this.saveOwned();
    this.state[account.key] = {
      status: 'ready',
      provider: 'epic',
      accountId: account.id,
      count: offers.length,
      checkedAt: Date.now(),
      source: 'legendary',
    };
    this.rebuild();
  }
  // Steam Web API import with a personal key (optional, for public profiles).
  async importSteamApi({ steamId, key }) {
    const account = this.ctx.accounts.connected('steam').find(a => a.id === steamId);
    if (!account)
      throw Error('Сначала войдите в этот аккаунт Steam. Импорт должен относиться к подключённому аккаунту.');
    const apiKey = key || this.ctx.vault.keys?.steamWebApi;
    if (!/^[A-Fa-f0-9]{32}$/.test(apiKey || '')) throw Error('Укажите личный Steam Web API key (32 символа)');
    const u = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
    u.search = new URLSearchParams({
      key: apiKey,
      steamid: steamId,
      include_appinfo: '1',
      include_played_free_games: '1',
    });
    const r = await this.ctx.publicFetch(u.href, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw Error('Steam отклонил запрос. Проверьте ключ API.');
    const offers = steamLib.parseOwnedGames(await r.json(), steamId).map(o => ({ ...o, source: 'api' }));
    if (key) this.ctx.integrations.setKey('steamWebApi', key);
    this.cloud[account.key] = offers;
    this.ownedCache[`steam:${steamId}`] = {
      accountId: steamId,
      offers,
      checkedAt: Date.now(),
      source: 'api',
    };
    this.saveOwned();
    this.state[account.key] = {
      status: 'ready',
      provider: 'steam',
      accountId: steamId,
      count: offers.length,
      checkedAt: Date.now(),
      source: 'api',
    };
    this.rebuild();
  }
  // ---- collections ------------------------------------------------------

  steamGameId(appId) {
    return (
      this.games.find(g => g.offers.some(o => o.provider === 'steam' && o.appId === String(appId)))?.id ||
      null
    );
  }
  async importSteamCollections() {
    const accounts = this.ctx.accounts.connected('steam');
    if (!accounts.length) throw Error('Сначала войдите в аккаунт Steam');
    if (!this.local.steamRoots.length) throw Error('Папка Steam не найдена. Укажите её в «Аккаунтах».');
    const total = { collections: 0, games: 0, hidden: 0, favorites: 0, accounts: 0 };
    const errors = [];
    for (const a of accounts) {
      const id32 = steamLib.toAccountId32(a.id);
      let found = false;
      for (const root of this.local.steamRoots) {
        const file = path.join(
          root,
          'userdata',
          id32,
          'config',
          'cloudstorage',
          'cloud-storage-namespace-1.json'
        );
        let text;
        try {
          text = await fsp.readFile(file, 'utf8');
        } catch {
          continue;
        }
        found = true;
        try {
          const report = collections.importSteamCollections(
            this.ctx.settings,
            collections.parseSteamCollections(JSON.parse(text)),
            appId => this.steamGameId(appId)
          );
          for (const k of ['collections', 'games', 'hidden', 'favorites']) total[k] += report[k];
          total.accounts++;
        } catch (e) {
          errors.push(`${a.name}: ${e.message}`);
        }
        break;
      }
      if (!found)
        errors.push(`${a.name}: коллекции не найдены — откройте библиотеку в клиенте Steam хотя бы раз`);
    }
    this.ctx.storage.saveSettings();
    this.rebuild();
    return { ...total, errors };
  }

  // ---- achievements -----------------------------------------------------

  async achievements(gameId) {
    const g = this.games.find(x => x.id === gameId);
    const offer = g?.offers.find(o => o.provider === 'steam');
    if (!offer) {
      if (g?.offers.some(o => o.provider === 'epic'))
        return { available: false, reason: 'Epic Games не даёт сторонним программам доступ к достижениям.' };
      throw Error('Игра не найдена');
    }
    const accounts = this.ctx.accounts.connected('steam');
    const account = accounts.find(a => offer.accountIds?.includes(a.id)) || accounts[0];
    if (!account) return { available: false, reason: 'Войдите в аккаунт Steam, чтобы увидеть достижения.' };
    const key = `${account.id}:${offer.appId}`;
    const cached = this.achievementCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
    const s = this.ctx.accounts.session(account.key);
    let api = null,
      xml = null;
    try {
      const token = await steamLib.sessionToken((url, o) => s.fetch(url, o), account.id);
      const u = new URL('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/');
      u.search = new URLSearchParams({
        access_token: token,
        steamid: account.id,
        appid: offer.appId,
        l: 'russian',
      });
      const r = await this.ctx.publicFetch(u.href, { signal: AbortSignal.timeout(12000) });
      if (r.ok) api = achievements.parseApiAchievements(await r.json());
    } catch (e) {
      this.ctx.log.debug('achievements', e.message);
    }
    for (const suffix of [
      `stats/${offer.appId}/achievements/?xml=1&l=russian`,
      `stats/${offer.appId}/?xml=1&tab=achievements&l=russian`,
    ]) {
      try {
        const r = await s.fetch(`https://steamcommunity.com/profiles/${account.id}/${suffix}`, {
          credentials: 'include',
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok || new URL(r.url || 'https://steamcommunity.com/').origin !== 'https://steamcommunity.com')
          continue;
        xml = achievements.parseXmlAchievements(await r.text());
        break;
      } catch (e) {
        this.ctx.log.debug('achievements', e.message);
      }
    }
    const list = achievements.mergeAchievements(api, xml);
    const value = list.length
      ? { available: true, account: account.name, list, ...achievements.summarize(list) }
      : {
          available: false,
          reason: api || xml ? 'У этой игры нет достижений.' : 'Steam не отдал достижения. Попробуйте позже.',
        };
    this.achievementCache.set(key, { at: Date.now(), value });
    return value;
  }

  statusList() {
    return this.ctx.accounts.list().map(a => ({
      ...a,
      library: this.state[a.key] || { status: a.status === 'connected' ? 'idle' : 'signedOut' },
    }));
  }
  // Per-provider summary for the legacy UI blocks.
  summary() {
    const out = {};
    for (const p of ['steam', 'epic']) {
      const states = this.statusList()
        .filter(a => a.provider === p && a.status === 'connected')
        .map(a => a.library);
      if (!states.length) {
        out[p] = { status: 'signedOut' };
        continue;
      }
      const status = states.some(s => s.status === 'loading')
        ? 'loading'
        : states.every(s => s.status === 'error')
          ? 'error'
          : states.some(s => s.status === 'ready')
            ? 'ready'
            : 'idle';
      out[p] = {
        status,
        count: states.reduce((n, s) => n + (s.count || 0), 0),
        checkedAt: Math.max(0, ...states.map(s => s.checkedAt || 0)) || null,
        message: states.find(s => s.status === 'error')?.message || '',
        source: states.find(s => s.source === 'legendary') ? 'legendary' : states[0].source,
        metadataLoading: states.some(s => s.metadataLoading),
      };
    }
    return out;
  }
}

module.exports = { LibraryService };
