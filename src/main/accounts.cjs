'use strict';
// Store accounts: several Steam accounts (one browser partition each) and
// several Epic accounts (OAuth refresh tokens). Account keys:
//   steam:<slot>      slot 0 uses the legacy partition "nexus-steam"
//   epic:<accountId>  32-hex Epic account id
const crypto = require('node:crypto');
const { session, shell } = require('electron');
const {
  AccountMonitor,
  verifyAccount,
  shouldCloseLogin,
  parseSteamAccount,
  steamCookieId,
  STEAM_WINDOW_PROBE,
  SignedOut,
} = require('../accounts.cjs');
const epicOAuth = require('../epic-oauth.cjs');

const STEAM_LOGIN = 'https://store.steampowered.com/login/';

function allowedCookie(domain, provider) {
  const d = String(domain || '')
    .replace(/^\./, '')
    .toLowerCase();
  const list = provider === 'steam' ? ['steampowered.com', 'steamcommunity.com'] : ['epicgames.com'];
  return list.some(x => d === x || d.endsWith('.' + x));
}

class AccountsService {
  constructor(ctx) {
    this.ctx = ctx;
    this.sessions = new Map(); // partition key ("steam:0", "epic") → Session
    this.persistTimer = null;
    this.loginTimers = new Map();
    this.authTimers = new Map();
    this.lastCheck = new Map();
    this.tokens = new epicOAuth.EpicTokens(
      (url, options) => ctx.publicFetch(url, options),
      () => this.persistTokens()
    );
    this.monitor = new AccountMonitor(
      key => this.check(key),
      (key, state) => this.changed(key, state),
      []
    );
  }

  // ---- sessions & vault -------------------------------------------------
  //
  // Session keys:
  //   steam:<slot>     Steam account slot (partition nexus-steam[-<slot>])
  //   web:<partition>  Epic web session used for checkout, giveaways, wishlist.
  // Every Epic account gets its own web partition, so adding a second Epic
  // account does not sign the first one out of the store.

  partitionName(key) {
    if (key.startsWith('web:')) return key.slice(4);
    const slot = Number(key.split(':')[1]) || 0;
    return slot === 0 ? 'nexus-steam' : `nexus-steam-${slot}`;
  }
  vaultSlot(key) {
    // Backward compatible: slot 0 cookies live in vault.steam, the first Epic web session in vault.epic.
    if (key === 'steam:0') return ['steam'];
    if (key === 'web:nexus-epic') return ['epic'];
    if (key.startsWith('web:')) return ['epicWeb', key.slice(4)];
    return ['steamSlots', key.split(':')[1]];
  }
  readVault(key) {
    const [a, b] = this.vaultSlot(key);
    return b === undefined ? this.ctx.vault[a] : this.ctx.vault[a]?.[b];
  }
  writeVault(key, value) {
    const [a, b] = this.vaultSlot(key);
    if (b === undefined) {
      if (value) this.ctx.vault[a] = value;
      else delete this.ctx.vault[a];
      return;
    }
    this.ctx.vault[a] ||= {};
    if (value) this.ctx.vault[a][b] = value;
    else delete this.ctx.vault[a][b];
    if (!Object.keys(this.ctx.vault[a]).length) delete this.ctx.vault[a];
  }
  saveVault() {
    try {
      this.ctx.storage.saveVault(this.ctx.vault);
    } catch (e) {
      this.ctx.storage.warning = e.message;
      this.ctx.log?.warn('vault', e.message);
    }
  }
  steamKeys() {
    return this.ctx.settings.steamSlots.map(slot => `steam:${slot}`);
  }
  epicPartition(accountId) {
    return this.ctx.settings.epicPartitions[accountId] || 'nexus-epic';
  }
  webKey(accountId) {
    return 'web:' + this.epicPartition(accountId);
  }
  session(key) {
    if (key.startsWith('epic:')) return this.sessions.get(this.webKey(key.slice(5)));
    if (key === 'epic') return this.sessions.get('web:nexus-epic');
    return this.sessions.get(key);
  }
  async initSession(key) {
    if (this.sessions.has(key)) return this.sessions.get(key);
    const provider = key.startsWith('web:') ? 'epic' : 'steam';
    const s = session.fromPartition(this.partitionName(key));
    this.sessions.set(key, s);
    s.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
    if (this.ctx.settings.remember[provider]) {
      for (const cookie of this.readVault(key)?.cookies || []) {
        if (!allowedCookie(cookie.domain, provider)) continue;
        if (cookie.expirationDate && cookie.expirationDate < Date.now() / 1000) continue;
        const {
          name,
          value,
          domain,
          path: cookiePath,
          secure,
          httpOnly,
          sameSite,
          expirationDate,
          hostOnly,
        } = cookie;
        const c = {
          url: `${secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}${cookiePath || '/'}`,
          name,
          value,
          path: cookiePath,
          secure,
          httpOnly,
          sameSite,
        };
        if (!hostOnly) c.domain = domain;
        if (expirationDate) c.expirationDate = expirationDate;
        try {
          await s.cookies.set(c);
        } catch {
          this.ctx.storage.warning =
            'Часть сессии не восстановлена. При необходимости войдите в магазин снова.';
        }
      }
    }
    s.cookies.on('changed', (_e, cookie) => {
      if (
        provider === 'steam' &&
        allowedCookie(cookie.domain, 'steam') &&
        /steamLoginSecure|sessionid/i.test(cookie.name)
      )
        this.scheduleAuth(key);
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(
        () => this.captureSessions().catch(e => this.ctx.log?.warn('vault', e.message)),
        400
      );
    });
    s.on('will-download', event => event.preventDefault());
    return s;
  }
  async dropSession(key) {
    const s = this.sessions.get(key);
    if (s) {
      await s.clearStorageData().catch(() => {});
      await s.clearCache().catch(() => {});
    }
    this.sessions.delete(key);
    this.writeVault(key, null);
  }
  async captureSessions() {
    for (const key of [...this.sessions.keys()]) {
      const provider = key.startsWith('web:') ? 'epic' : 'steam';
      if (!this.ctx.settings.remember[provider]) {
        this.writeVault(key, null);
        continue;
      }
      const cookies = (await this.sessions.get(key).cookies.get({})).filter(c =>
        allowedCookie(c.domain, provider)
      );
      this.writeVault(key, { ...this.readVault(key), cookies });
    }
    this.saveVault();
  }
  persistTokens() {
    if (this.ctx.settings.remember.epic) this.ctx.vault.epicTokens = this.tokens.persisted();
    else delete this.ctx.vault.epicTokens;
    this.saveVault();
  }

  async init() {
    for (const key of this.steamKeys()) await this.initSession(key);
    for (const p of new Set(['nexus-epic', ...Object.values(this.ctx.settings.epicPartitions)]))
      await this.initSession('web:' + p);
    if (this.ctx.settings.remember.epic) this.tokens.restore(this.ctx.vault.epicTokens);
    for (const key of [...this.steamKeys(), ...this.tokens.ids().map(id => `epic:${id}`)]) {
      this.monitor.add(key);
      // The last verified identity lets the library work offline until the check succeeds.
      const known = this.ctx.settings.knownAccounts[key];
      if (known?.id) this.monitor.states[key] = { status: 'checking', ...known };
    }
  }
  refreshAll() {
    return Promise.all(this.monitor.keys().map(k => this.monitor.refresh(k)));
  }

  // ---- verification -----------------------------------------------------

  scheduleAuth(key) {
    if (this.ctx.windows.purpose.get(key) !== 'login' && Date.now() - (this.lastCheck.get(key) || 0) < 15000)
      return;
    clearTimeout(this.authTimers.get(key));
    this.authTimers.set(
      key,
      setTimeout(() => this.monitor.refresh(key), 650)
    );
  }
  async check(key) {
    if (key.startsWith('epic:')) return this.tokens.profile(key.slice(5));
    if (!key.startsWith('steam:')) throw Error('Неизвестный аккаунт');
    if (!this.sessions.has(key)) throw new SignedOut();
    const s = this.session(key);
    const cookies = await s.cookies.get({ url: 'https://store.steampowered.com/' });
    // Without the sign-in cookie Steam cannot be signed in: no need to ask the network.
    if (!cookies.some(c => c.name === 'steamLoginSecure')) throw new SignedOut();
    const cookieId = steamCookieId(cookies);
    const w = this.ctx.windows.get(key);
    if (w && new URL(w.webContents.getURL() || 'about:blank').origin === 'https://store.steampowered.com') {
      try {
        const result = await w.webContents.executeJavaScript(STEAM_WINDOW_PROBE);
        if (result)
          return this.unique(
            key,
            parseSteamAccount(result.html, result.url, cookieId || result.steamid || '')
          );
      } catch (e) {
        this.ctx.log?.debug('account', `${key}: window check: ${e.message}`);
      }
    }
    return this.unique(key, await verifyAccount('steam', (url, opts) => s.fetch(url, opts), cookieId));
  }
  // The same Steam account signed into two slots is reported once.
  unique(key, profile) {
    const other = this.steamKeys().find(
      k =>
        k !== key &&
        this.monitor.states[k]?.status === 'connected' &&
        this.monitor.states[k].id === profile.id
    );
    if (other) {
      const e = Error('duplicate');
      e.publicMessage = 'Этот аккаунт Steam уже подключён в другом слоте.';
      throw e;
    }
    return profile;
  }
  changed(key, state) {
    this.lastCheck.set(key, Date.now());
    const known = this.ctx.settings.knownAccounts;
    if (state.status === 'connected' && state.id) {
      const next = {
        id: state.id,
        name: state.name || '',
        avatar: state.avatar || '',
        verifiedAt: state.verifiedAt || Date.now(),
      };
      if (JSON.stringify(known[key]) !== JSON.stringify(next)) {
        known[key] = next;
        this.ctx.storage.saveSettings();
      }
    } else if (state.status === 'signedOut' && known[key]) {
      delete known[key];
      this.ctx.storage.saveSettings();
    }
    if (state.status !== 'connected')
      this.ctx.log?.info(
        'account',
        `${key}: ${state.status}${state.message ? ' — ' + state.message : ''}${state.reason ? ' [' + state.reason + ']' : ''}`
      );
    this.ctx.hub.publish();
    this.ctx.library.accountChanged(key, state);
    const purpose = this.ctx.windows.purpose.get(key);
    if (key.startsWith('steam:') && shouldCloseLogin(purpose, state)) {
      this.captureSessions()
        .catch(() => {})
        .finally(() => {
          if (shouldCloseLogin(this.ctx.windows.purpose.get(key), this.monitor.states[key])) {
            this.ctx.windows.close(key);
            this.stopLogin(key);
            this.ctx.focusMain();
          }
        });
    }
  }
  stopLogin(key) {
    clearInterval(this.loginTimers.get(key));
    this.loginTimers.delete(key);
  }

  // ---- login / logout ---------------------------------------------------

  async login({ provider, add = false }) {
    if (provider === 'steam') {
      const free = this.steamKeys().filter(k => this.monitor.states[k]?.status !== 'connected');
      // Reuse an unconnected slot before creating a new one.
      let key = add ? free.find(k => k !== 'steam:0') || null : free[0] || null;
      if (!key && !add) key = 'steam:0';
      if (!key) {
        if (this.ctx.settings.steamSlots.length >= 5) throw Error('Можно подключить до 5 аккаунтов Steam');
        const slot = Math.max(...this.ctx.settings.steamSlots) + 1;
        this.ctx.settings.steamSlots.push(slot);
        this.ctx.storage.saveSettings();
        key = `steam:${slot}`;
      }
      const s = await this.initSession(key);
      this.monitor.add(key);
      this.stopLogin(key);
      this.loginTimers.set(
        key,
        setInterval(() => this.monitor.refresh(key), 2500)
      );
      this.ctx.windows.open({ key, provider: 'steam', session: s, url: STEAM_LOGIN, purpose: 'login' });
      return { key };
    }
    if (provider === 'epic') {
      // A login window is already open: bring it forward with its own session
      // instead of creating a second session the window would never use.
      const open = this.ctx.windows.get('epic-login');
      if (open && this.pendingEpic) {
        open.show();
        open.focus();
        return { key: 'epic-login' };
      }
      // The first Epic account uses the legacy partition, every further one a
      // fresh partition: Epic would otherwise return a code for the account
      // that is already signed in on the web.
      const used = new Set(this.connected('epic').map(a => this.epicPartition(a.id)));
      const partition =
        !add && !used.has('nexus-epic')
          ? 'nexus-epic'
          : `nexus-epic-${crypto.randomBytes(4).toString('hex')}`;
      const key = 'web:' + partition;
      const s = await this.initSession(key);
      this.pendingEpic = partition;
      this.ctx.windows.open({
        key: 'epic-login',
        provider: 'epic',
        session: s,
        url: epicOAuth.LOGIN_URL,
        purpose: 'login',
        onNavigate: (url, wc) => this.captureEpicCode(url, wc, partition),
      });
      return { key: 'epic-login' };
    }
    throw Error('Неизвестный магазин');
  }
  async captureEpicCode(url, wc, partition) {
    if (!epicOAuth.isRedirectPage(url)) return;
    try {
      const text = await wc.executeJavaScript('document.body ? document.body.innerText : ""');
      const code = epicOAuth.extractAuthCode(text);
      if (!code) return;
      await this.signInEpic(code, partition);
      this.captureSessions().catch(e => this.ctx.log?.warn('vault', e.message));
      this.ctx.windows.close('epic-login');
      this.ctx.focusMain();
    } catch (e) {
      this.ctx.log?.warn('epic-login', e.message);
      this.ctx.toast?.(e.message);
    }
  }
  async signInEpic(code, partition) {
    const token = await this.tokens.signIn(code);
    const previous = this.ctx.settings.epicPartitions[token.accountId];
    // Pasted codes have no web session: give the account its own empty one;
    // the user signs in to the store there when buying.
    const next = partition || previous || `nexus-epic-${token.accountId.slice(0, 8)}`;
    this.ctx.settings.epicPartitions[token.accountId] = next;
    this.ctx.storage.saveSettings();
    await this.initSession('web:' + next);
    if (previous && previous !== next && !this.partitionInUse(previous, token.accountId))
      await this.dropSession('web:' + previous);
    if (partition === this.pendingEpic) this.pendingEpic = null;
    const key = `epic:${token.accountId}`;
    this.monitor.add(key);
    await this.monitor.refresh(key);
    this.ctx.log?.info('epic', 'signed in ' + key);
    return key;
  }
  partitionInUse(partition, exceptId) {
    return Object.entries(this.ctx.settings.epicPartitions).some(
      ([id, p]) => p === partition && id !== exceptId
    );
  }
  // "Войти через браузер": the user copies the code (or the whole JSON) from
  // the redirect page of the system browser and pastes it into Nexus.
  async epicCode(input) {
    const code = epicOAuth.extractAuthCode(input);
    if (!code) throw Error('Вставьте authorizationCode (32 символа) или весь JSON со страницы Epic');
    return this.signInEpic(code);
  }
  openInBrowser(provider) {
    return shell.openExternal(provider === 'epic' ? epicOAuth.LOGIN_URL : STEAM_LOGIN);
  }
  // A login window closed without signing in must not leave an empty slot or partition behind.
  // Only a login window for a new, never verified slot that ends signed out
  // removes the slot. Closing a store/checkout window, or a network error
  // during the check, never removes an account.
  async windowClosed(key, purpose) {
    if (key.startsWith('steam:') && this.steamKeys().includes(key)) {
      this.stopLogin(key);
      const slot = Number(key.split(':')[1]);
      await this.monitor.refresh(key).catch(() => {});
      const abandoned =
        purpose === 'login' &&
        slot !== 0 &&
        this.monitor.states[key]?.status === 'signedOut' &&
        !this.ctx.settings.knownAccounts[key];
      if (abandoned) await this.removeSteamSlot(key);
      else this.scheduleAuth(key);
    }
    if (key === 'epic-login' && this.pendingEpic) {
      const partition = this.pendingEpic;
      this.pendingEpic = null;
      if (partition !== 'nexus-epic' && !this.partitionInUse(partition))
        await this.dropSession('web:' + partition);
    }
    await this.captureSessions().catch(e => this.ctx.log?.warn('vault', e.message));
  }
  async removeSteamSlot(key) {
    const slot = Number(key.split(':')[1]);
    if (slot === 0) return;
    this.monitor.remove(key);
    await this.dropSession(key);
    delete this.ctx.settings.knownAccounts[key];
    this.ctx.settings.steamSlots = this.ctx.settings.steamSlots.filter(x => x !== slot);
    this.ctx.storage.saveSettings();
    this.saveVault();
    this.ctx.library.accountRemoved(key);
  }
  async forget(key) {
    if (key === 'steam' || key === 'epic') key = this.primaryKey(key) || key;
    if (key.startsWith('steam:')) {
      this.monitor.forget(key);
      this.stopLogin(key);
      clearTimeout(this.authTimers.get(key));
      this.ctx.windows.close(key);
      if (Number(key.split(':')[1]) !== 0) await this.removeSteamSlot(key);
      else {
        const s = this.session(key);
        await s?.clearStorageData();
        await s?.clearCache();
        this.writeVault(key, null);
      }
    } else if (key.startsWith('epic:')) {
      const id = key.slice(5);
      const partition = this.epicPartition(id);
      this.monitor.forget(key);
      this.ctx.windows.close(key);
      await this.tokens.signOut(id);
      this.monitor.remove(key);
      delete this.ctx.settings.epicPartitions[id];
      if (!this.partitionInUse(partition)) {
        if (partition === 'nexus-epic') {
          const s = this.sessions.get('web:nexus-epic');
          await s?.clearStorageData();
          await s?.clearCache();
          this.writeVault('web:nexus-epic', null);
        } else await this.dropSession('web:' + partition);
      }
      for (const p of ['steam', 'epic'])
        if (this.ctx.settings.purchaseAccount[p] === key) delete this.ctx.settings.purchaseAccount[p];
    }
    delete this.ctx.settings.knownAccounts[key];
    this.saveVault();
    this.ctx.storage.saveSettings();
    this.ctx.library.accountRemoved(key);
  }
  async setRemember(provider, enabled) {
    if (enabled && !this.ctx.storage.encryptionAvailable())
      throw Error('Защищённое хранилище Windows недоступно. Вход можно использовать без сохранения.');
    const previous = this.ctx.settings.remember[provider];
    this.ctx.settings.remember[provider] = enabled;
    try {
      await this.captureSessions();
      if (provider === 'epic') this.persistTokens();
      this.ctx.storage.saveSettings();
    } catch (e) {
      this.ctx.settings.remember[provider] = previous;
      throw e;
    }
  }

  // ---- views ------------------------------------------------------------

  keys(provider) {
    return this.monitor.keys().filter(k => k.startsWith(provider + ':'));
  }
  connected(provider) {
    return this.keys(provider)
      .map(key => ({ key, ...this.monitor.states[key] }))
      .filter(a => a.status === 'connected' && a.id);
  }
  primaryKey(provider) {
    const keys = this.keys(provider);
    return keys.find(k => this.monitor.states[k]?.status === 'connected') || keys[0] || null;
  }
  // Which account a purchase or giveaway opens in. The user's choice wins,
  // then the remembered choice, then the first connected account.
  checkoutTarget(provider, accountKey, remember = false) {
    const connected = this.connected(provider);
    const wanted = accountKey || this.ctx.settings.purchaseAccount[provider];
    const account = connected.find(a => a.key === wanted) || connected[0];
    if (accountKey && account?.key !== accountKey) throw Error('Этот аккаунт сейчас не подключён');
    // Only an explicit purchase/claim remembers the choice (not lookups such as wishlist import).
    if (accountKey && remember && this.ctx.settings.purchaseAccount[provider] !== accountKey) {
      this.ctx.settings.purchaseAccount[provider] = accountKey;
      this.ctx.storage.saveSettings();
    }
    if (provider === 'steam') {
      const key = account?.key || 'steam:0';
      return { key, session: this.session(key), account: account || null };
    }
    if (!account)
      return { key: 'web:nexus-epic', session: this.sessions.get('web:nexus-epic'), account: null };
    return { key: account.key, session: this.session(account.key), account };
  }
  list() {
    return this.monitor.keys().map(key => {
      const s = this.monitor.states[key] || {};
      return {
        key,
        provider: key.split(':')[0],
        status: s.status,
        id: s.id || '',
        name: s.name || '',
        avatar: s.avatar || '',
        message: s.message || '',
        verifiedAt: s.verifiedAt || null,
      };
    });
  }
  // Legacy single-account view used across the UI.
  summary() {
    const out = {};
    for (const p of ['steam', 'epic']) {
      const key = this.primaryKey(p);
      const s = key ? this.monitor.states[key] : null;
      out[p] = {
        ...(s || { status: 'signedOut' }),
        key,
        remember: this.ctx.settings.remember[p],
        hasSavedSession:
          p === 'steam' ? !!this.ctx.vault.steam?.cookies?.length : this.tokens.ids().length > 0,
        purchaseAccount: this.ctx.settings.purchaseAccount[p] || null,
        count: this.connected(p).length,
        steamId: p === 'steam' ? s?.id || '' : undefined,
      };
    }
    return out;
  }
}

module.exports = { AccountsService, allowedCookie };
