'use strict';
// The Nexus browser: web links open in a Nexus window with tabs instead of the system
// browser. The window's own page (ui/browser.html, browser-preload.cjs) is the tab strip,
// address bar and downloads; each tab is a WebContentsView below it.
//   - Pages run sandboxed, without Nexus code, in their own profile (persist:nexus-browser).
//     Steam Community pages use the Steam account's session, so they open signed in.
//   - Pages ask for nothing: camera, microphone, notifications, location are refused.
//   - Links of programs (steam://, com.epicgames.launcher://, mailto:) go to the program.
//   - Downloads are saved to «Загрузки» and listed under the address bar.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, WebContentsView, ipcMain, session, shell } = require('electron');
const { webUrl, appUrl, addressInput, siteKind } = require('../browser-url.cjs');

const PAGE = pathToFileURL(path.join(__dirname, '../../ui/browser.html')).href;
const PARTITION = 'persist:nexus-browser';
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

// A free file name in the folder: name.ext, name (1).ext, …
function freePath(dir, name) {
  // The last part of the name only (no folders), without characters Windows forbids.
  const last = String(name || '')
    .split(/[\\/]/)
    .pop();
  const safe = last.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '') || 'download';
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let file = path.join(dir, safe);
  for (let n = 1; fs.existsSync(file) && n < 1000; n++) file = path.join(dir, `${base} (${n})${ext}`);
  return file;
}

class NexusBrowser {
  constructor(ctx, { icon } = {}) {
    this.ctx = ctx;
    this.icon = icon;
    this.win = null;
    this.tabs = []; // { id, view, kind, title, favicon, crashed }
    this.active = null;
    this.nextId = 1;
    this.downloads = [];
    this.toolbarHeight = 76;
    this.hooked = new WeakSet();
    this.pushTimer = null;
    this.ipcReady = false;
  }

  // ---- opening ----------------------------------------------------------------

  // A web page in a new tab (the window opens when needed). Anything but http(s) is refused.
  open(url) {
    const href = webUrl(url);
    if (!href || href === 'about:blank') throw Error('Ссылка недоступна');
    this.window();
    this.addTab(href);
    this.focus();
    return true;
  }
  focus() {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
  window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.listen();
    const main = this.ctx.mainWindow?.();
    const w = new BrowserWindow({
      width: 1240,
      height: 860,
      minWidth: 640,
      minHeight: 420,
      backgroundColor: '#171a21',
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#171a21', symbolColor: '#aeb6c0', height: 36 },
      title: 'Браузер Nexus',
      icon: this.icon,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../browser-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (main && !main.isDestroyed()) {
      const b = main.getBounds();
      w.setPosition(b.x + 40, b.y + 40);
    }
    w.removeMenu?.();
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', e => e.preventDefault());
    w.once('ready-to-show', () => w.show());
    w.on('resize', () => this.layout());
    w.on('closed', () => {
      for (const t of this.tabs) if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
      this.tabs = [];
      this.active = null;
      this.win = null;
    });
    this.win = w;
    w.loadURL(PAGE).catch(e => this.ctx.log?.warn('browser', e.message));
    return w;
  }

  // ---- tabs ---------------------------------------------------------------------

  sessionFor(href) {
    let s = null;
    if (siteKind(href) === 'steam') {
      try {
        s = this.ctx.accounts.checkoutTarget('steam').session || null;
      } catch {}
    }
    s ||= session.fromPartition(PARTITION);
    this.hookSession(s);
    return s;
  }
  // Downloads and permissions of the browser's own profile; account sessions keep
  // their own rules (they refuse both).
  hookSession(s) {
    if (this.hooked.has(s) || s !== session.fromPartition(PARTITION)) return;
    this.hooked.add(s);
    s.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
    s.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    s.on('will-download', (_e, item, wc) => this.download(item, wc));
  }
  addTab(href, { background = false } = {}) {
    const ses = this.sessionFor(href);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor?.('#ffffff');
    const tab = { id: this.nextId++, view, kind: siteKind(href), title: '', favicon: '', crashed: false };
    this.tabs.push(tab);
    this.wire(tab);
    this.win.contentView.addChildView(view);
    if (!background || !this.active) this.activate(tab.id);
    else view.setVisible(false);
    view.webContents.loadURL(href).catch(e => {
      if (!/ERR_ABORTED/.test(e.message)) this.ctx.log?.debug?.('browser', e.message);
    });
    this.layout();
    this.push();
    return tab;
  }
  wire(tab) {
    const wc = tab.view.webContents;
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const href = webUrl(url);
      if (href) setImmediate(() => this.addTab(href, { background: disposition === 'background-tab' }));
      else this.openApp(url);
      return { action: 'deny' };
    });
    // A click to another kind of site (Steam Community ↔ the rest) opens it in a new tab
    // with the right session; program links go to the program.
    wc.on('will-navigate', (e, url) => {
      const href = webUrl(url);
      if (!href) {
        e.preventDefault();
        this.openApp(url);
      } else if (siteKind(href) !== tab.kind) {
        e.preventDefault();
        this.addTab(href);
      }
    });
    wc.on('will-frame-navigate', e => {
      if (!e.isMainFrame && !webUrl(e.url) && !/^(about|data|blob):/.test(e.url)) e.preventDefault();
    });
    const update = () => this.push();
    wc.on('page-title-updated', (_e, title) => {
      tab.title = String(title || '').slice(0, 300);
      update();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = (icons || []).find(i => /^https:\/\//.test(i)) || '';
      update();
    });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page'])
      wc.on(ev, update);
    wc.on('did-start-navigation', () => {
      tab.crashed = false;
    });
    wc.on('render-process-gone', (_e, d) => {
      tab.crashed = d?.reason !== 'clean-exit';
      update();
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && this.shortcut(input)) e.preventDefault();
    });
  }
  tab(id) {
    return this.tabs.find(t => t.id === id) || null;
  }
  current() {
    return this.tab(this.active);
  }
  activate(id) {
    const tab = this.tab(id);
    if (!tab) return;
    this.active = id;
    for (const t of this.tabs) t.view.setVisible(t.id === id);
    this.layout();
    tab.view.webContents.focus();
    this.push();
  }
  close(id) {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    const [tab] = this.tabs.splice(i, 1);
    this.win?.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (!this.tabs.length) {
      this.win?.close();
      return;
    }
    if (this.active === id) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    else this.push();
  }
  layout() {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    const [width, height] = w.getContentSize();
    const top = Math.max(0, Math.min(this.toolbarHeight, height));
    for (const t of this.tabs) t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }
  // Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+Tab, F5, Alt+←/→ (Cmd on macOS) — in the page and the bar.
  shortcut(input) {
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    const key = String(input.key || '').toLowerCase();
    const tab = this.current();
    if ((mod && key === 'r') || key === 'f5') return (this.command({ cmd: 'reload' }), true);
    if (mod && key === 'w') return (tab && this.close(tab.id), true);
    if (mod && key === 't') return (this.newTab(), true);
    if (mod && key === 'l') return (this.send('browser-focus-address'), true);
    if (mod && key === 'tab' && this.tabs.length > 1) {
      const i = this.tabs.findIndex(t => t.id === this.active);
      const next = (i + (input.shift ? -1 : 1) + this.tabs.length) % this.tabs.length;
      this.activate(this.tabs[next].id);
      return true;
    }
    if (input.alt && key === 'arrowleft') return (this.command({ cmd: 'back' }), true);
    if (input.alt && key === 'arrowright') return (this.command({ cmd: 'forward' }), true);
    return false;
  }
  newTab() {
    this.addTab('about:blank');
    this.send('browser-focus-address');
  }

  // ---- programs and downloads --------------------------------------------------------

  openApp(url) {
    const href = appUrl(url);
    if (href) shell.openExternal(href).catch(e => this.ctx.log?.warn('browser', e.message));
  }
  download(item, wc) {
    // A tab opened only for this file (nothing shown in it) closes, like in other browsers.
    const tab = this.tabs.find(t => t.view.webContents === wc);
    if (
      tab &&
      this.tabs.length > 1 &&
      ['', 'about:blank'].includes(wc.getURL()) &&
      !wc.navigationHistory.canGoBack()
    )
      setTimeout(() => this.close(tab.id), 300);
    const file = freePath(app.getPath('downloads'), item.getFilename());
    item.setSavePath(file);
    const d = {
      id: this.nextId++,
      name: path.basename(file),
      file,
      received: 0,
      total: item.getTotalBytes() || 0,
      state: 'progressing',
      item,
    };
    this.downloads = [d, ...this.downloads].slice(0, 5);
    item.on('updated', (_e, state) => {
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes() || d.total;
      d.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
      this.push();
    });
    item.once('done', (_e, state) => {
      d.state = state; // completed | cancelled | interrupted
      d.received = item.getReceivedBytes();
      d.item = null;
      this.ctx.log?.info('browser', `download ${state}`);
      this.push();
    });
    this.push();
  }

  // ---- the bar's calls ---------------------------------------------------------------

  listen() {
    if (this.ipcReady) return;
    this.ipcReady = true;
    ipcMain.handle('nexus-browser', (event, msg) => {
      // Only the bar of the browser window, never a page.
      if (!this.win || event.sender !== this.win.webContents || event.senderFrame?.url !== PAGE)
        return { ok: false, error: 'forbidden' };
      try {
        return { ok: true, data: this.command(msg || {}) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });
  }
  command({ cmd, id, value }) {
    const fn = this.commands()[cmd];
    if (!fn) throw Error('Неизвестная команда');
    return fn({ id: Number(id), value });
  }
  // What the bar may ask; each works on the current tab unless it names one.
  commands() {
    const wc = () => this.current()?.view.webContents;
    const history = () => wc()?.navigationHistory;
    const download = id => {
      const d = this.downloads.find(x => x.id === id);
      if (!d || d.state !== 'completed') throw Error('Файл ещё не загружен');
      return d;
    };
    return {
      state: () => this.state(),
      layout: ({ value }) => {
        this.toolbarHeight = Math.max(40, Math.min(200, Number(value) || 76));
        this.layout();
        return true;
      },
      navigate: ({ value }) => this.navigate(value),
      back: () => (history()?.canGoBack() && history().goBack(), true),
      forward: () => (history()?.canGoForward() && history().goForward(), true),
      reload: () => (wc()?.reload(), true),
      stop: () => (wc()?.stop(), true),
      newTab: () => (this.newTab(), true),
      activate: ({ id }) => (this.activate(id), true),
      close: ({ id }) => (this.close(id), true),
      focusPage: () => (wc()?.focus(), true),
      showDownload: ({ id }) => (shell.showItemInFolder(download(id).file), true),
      openDownload: async ({ id }) => {
        const err = await shell.openPath(download(id).file);
        if (err) throw Error(err);
        return true;
      },
      cancelDownload: ({ id }) => (this.downloads.find(x => x.id === id)?.item?.cancel(), true),
      dismissDownloads: () => {
        this.downloads = this.downloads.filter(d => d.state === 'progressing' || d.state === 'paused');
        this.push();
        return true;
      },
    };
  }
  // The address bar: a page in this tab, or a new tab when the site needs another session.
  navigate(value) {
    const href = addressInput(value);
    if (!href) throw Error('Адрес не распознан');
    const tab = this.current();
    if (!tab) return !!this.addTab(href);
    const wc = tab.view.webContents;
    if (siteKind(href) !== tab.kind) {
      const blank = !wc.getURL() || wc.getURL() === 'about:blank';
      this.addTab(href);
      if (blank) this.close(tab.id);
      return true;
    }
    wc.loadURL(href).catch(() => {});
    return true;
  }
  state() {
    return {
      platform: process.platform,
      active: this.active,
      tabs: this.tabs.map(t => {
        const wc = t.view.webContents;
        const url = wc.isDestroyed() ? '' : wc.getURL();
        return {
          id: t.id,
          title: t.title || (url === 'about:blank' ? 'Новая вкладка' : url),
          url: url === 'about:blank' ? '' : url,
          favicon: t.favicon,
          loading: !wc.isDestroyed() && wc.isLoading(),
          canBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
          canForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
          signedIn: t.kind === 'steam',
          crashed: t.crashed,
          secure: /^https:/.test(url),
        };
      }),
      downloads: this.downloads.map(({ id, name, received, total, state }) => ({
        id,
        name,
        received,
        total,
        state,
      })),
    };
  }
  send(channel, value) {
    const w = this.win;
    if (w && !w.isDestroyed()) w.webContents.send(channel, value);
  }
  push() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.send('browser-state', this.state());
    }, 30);
  }
}

module.exports = { NexusBrowser, freePath };
