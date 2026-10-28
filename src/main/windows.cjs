'use strict';
// Official store windows (login, checkout) and a hidden page used to call
// store APIs that are protected by bot checks for non-browser clients.

const { BrowserWindow, dialog } = require('electron');

const providerNames = { steam: 'Steam', epic: 'Epic Games' };
const secure = { nodeIntegration: false, contextIsolation: true, sandbox: true };

class StoreWindows {
  constructor({ getMain, onAuthActivity, onClosed }) {
    this.getMain = getMain;
    this.onAuthActivity = onAuthActivity;
    this.onClosed = onClosed;
    this.windows = new Map(); // key → BrowserWindow (key: "steam:0", "epic", ...)
    this.children = new Map();
    this.purpose = new Map();
  }
  get(key) {
    const w = this.windows.get(key);
    return w && !w.isDestroyed() ? w : null;
  }
  // provider is "steam" or "epic"; key distinguishes Steam account slots.
  open({ key, provider, session, url, purpose = 'checkout', onNavigate }) {
    if (!providerNames[provider]) throw Error('Неизвестный магазин');
    this.purpose.set(key, purpose);
    const existing = this.get(key);
    if (existing) {
      existing.show();
      existing.focus();
      existing.loadURL(url).catch(() => {});
      existing.__nexusNavigate = onNavigate;
      return existing;
    }
    const w = new BrowserWindow({
      width: 1150,
      height: 820,
      minWidth: 850,
      minHeight: 600,
      title: `${providerNames[provider]} · официальный сайт`,
      backgroundColor: '#171d25',
      autoHideMenuBar: true,
      webPreferences: { session, ...secure },
    });
    w.removeMenu();
    w.__nexusNavigate = onNavigate;
    this.windows.set(key, w);
    const children = new Set();
    this.children.set(key, children);
    const httpsOnly = (event, u) => {
      try {
        if (new URL(u).protocol !== 'https:') event.preventDefault();
      } catch {
        event.preventDefault();
      }
    };
    const activity = wc => {
      wc.on('did-finish-load', () => {
        this.onAuthActivity(key);
        w.__nexusNavigate?.(wc.getURL(), wc);
      });
      wc.on('did-navigate-in-page', () => this.onAuthActivity(key));
      wc.on('will-navigate', httpsOnly);
      wc.on('will-redirect', httpsOnly);
    };
    w.webContents.on('page-title-updated', e => e.preventDefault());
    w.webContents.on('did-navigate', (_e, current) => {
      try {
        w.setTitle(`${providerNames[provider]} · ${new URL(current).hostname} · Nexus`);
      } catch {}
    });
    activity(w.webContents);
    w.webContents.setWindowOpenHandler(({ url: target }) => {
      try {
        if (target === 'about:blank' || new URL(target).protocol === 'https:')
          return {
            action: 'allow',
            overrideBrowserWindowOptions: {
              parent: w,
              width: 1000,
              height: 780,
              autoHideMenuBar: true,
              webPreferences: { session, ...secure },
            },
          };
      } catch {}
      return { action: 'deny' };
    });
    w.webContents.on('did-create-window', child => {
      children.add(child);
      child.removeMenu();
      activity(child.webContents);
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      child.on('closed', () => {
        children.delete(child);
        this.onAuthActivity(key);
      });
    });
    w.on('closed', () => {
      for (const child of children) if (!child.isDestroyed()) child.close();
      const purpose = this.purpose.get(key);
      this.windows.delete(key);
      this.children.delete(key);
      this.purpose.delete(key);
      this.onClosed(key, provider, purpose);
    });
    w.loadURL(url).catch(() =>
      dialog.showMessageBox(this.getMain(), {
        type: 'warning',
        message: 'Магазин не загрузился',
        detail: 'Проверьте соединение или используйте кнопку «Открыть в браузере» в настройках.',
      })
    );
    return w;
  }
  close(key) {
    this.get(key)?.close();
  }
}

// A hidden window on the store origin performs fetch() with real browser
// fingerprints. Used only after a direct request was refused (HTTP 403).
class PageFetcher {
  constructor({ session, origin, startUrl, idleMs = 10 * 60 * 1000 }) {
    this.session = session;
    this.origin = origin;
    this.startUrl = startUrl;
    this.idleMs = idleMs;
    this.window = null;
    this.ready = null;
    this.idle = null;
  }
  async page() {
    if (this.window && !this.window.isDestroyed() && this.ready) return this.ready;
    this.window = new BrowserWindow({ show: false, webPreferences: { session: this.session, ...secure } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.setAudioMuted(true);
    let timer;
    this.ready = Promise.race([
      this.window.loadURL(this.startUrl),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Страница магазина не загрузилась')), 20000);
      }),
    ])
      .then(() => this.window)
      .finally(() => clearTimeout(timer));
    this.ready.catch(() => this.dispose());
    return this.ready;
  }
  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.dispose(), this.idleMs);
    this.idle.unref?.();
  }
  dispose() {
    clearTimeout(this.idle);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.ready = null;
  }
  // Returns a minimal Response-like object.
  async fetch(url, options = {}) {
    const u = new URL(url);
    if (u.origin !== this.origin) throw Error('PageFetcher: другой домен');
    const w = await this.page();
    this.touch();
    const request = {
      url: u.pathname + u.search,
      method: options.method || 'GET',
      body: typeof options.body === 'string' ? options.body : undefined,
      contentType: options.headers?.['Content-Type'] || undefined,
    };
    const script = `(async r=>{const res=await fetch(r.url,{method:r.method,credentials:'include',headers:r.contentType?{'Content-Type':r.contentType}:{},body:r.body,signal:AbortSignal.timeout(15000)});const text=await res.text();return {status:res.status,text:text.slice(0,5000000)};})(${JSON.stringify(request)})`;
    const result = await w.webContents.executeJavaScript(script, true);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      url,
      headers: { get: () => null },
      text: async () => result.text,
      json: async () => JSON.parse(result.text),
    };
  }
  async run(script) {
    const w = await this.page();
    this.touch();
    return w.webContents.executeJavaScript(script, true);
  }
}

// fetch that falls back to the hidden page when the direct request is blocked.
function withPageFallback(direct, pageFetcher) {
  return async (url, options = {}) => {
    let response;
    try {
      response = await direct(url, options);
      if (response.status !== 403 && response.status !== 429) return response;
    } catch (e) {
      if (!pageFetcher || new URL(url).origin !== pageFetcher.origin) throw e;
    }
    if (!pageFetcher || new URL(url).origin !== pageFetcher.origin) return response;
    return pageFetcher.fetch(url, options);
  };
}

module.exports = { StoreWindows, PageFetcher, withPageFallback, providerNames };
