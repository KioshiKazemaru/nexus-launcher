'use strict';
// The friends list and the chat as their own windows, like Steam's
// "Друзья и чат": a narrow friends window and one chat window with a tab per
// conversation. Both load local pages with their own small preload
// (social-preload.cjs); main.cjs accepts their calls only for social channels.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, screen } = require('electron');
const { parseConvKey } = require('../chat.cjs');

const UI = path.join(__dirname, '../../ui');
const PAGES = { friends: 'friends.html', chat: 'chat.html' };
const pageUrl = kind => pathToFileURL(path.join(UI, PAGES[kind])).href;

class SocialWindows {
  constructor(ctx, { icon } = {}) {
    this.ctx = ctx;
    this.icon = icon;
    this.windows = { friends: null, chat: null };
    this.pending = []; // conversations to open as tabs when the chat window asks
  }
  win(kind) {
    const w = this.windows[kind];
    return w && !w.isDestroyed() ? w : null;
  }
  // Which social window sent an IPC call ('' when none).
  senderKind(event) {
    for (const kind of Object.keys(PAGES)) {
      const w = this.win(kind);
      if (w && event.sender === w.webContents && event.senderFrame?.url === pageUrl(kind)) return kind;
    }
    return '';
  }
  anyOpen() {
    return !!(this.win('friends') || this.win('chat'));
  }
  chatFocused() {
    return !!this.win('chat')?.isFocused();
  }
  create(kind, options) {
    const existing = this.win(kind);
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    const w = new BrowserWindow({
      backgroundColor: '#1b2838',
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#171d25', symbolColor: '#aeb6c0', height: 30 },
      icon: this.icon,
      show: false,
      ...options,
      webPreferences: {
        preload: path.join(__dirname, '../social-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    w.removeMenu?.();
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', e => e.preventDefault());
    w.once('ready-to-show', () => w.show());
    w.on('closed', () => {
      this.windows[kind] = null;
      if (kind === 'chat') this.ctx.chat?.setViewing([]);
    });
    this.windows[kind] = w;
    w.loadURL(pageUrl(kind)).catch(e => this.ctx.log.warn('social', `${kind}: ${e.message}`));
    return w;
  }
  openFriends() {
    // Next to the main window on the right, like Steam's friends list.
    const main = this.ctx.mainWindow?.();
    const b = main?.getBounds?.();
    const area = screen?.getDisplayMatching?.(b || { x: 0, y: 0, width: 1, height: 1 })?.workArea;
    const width = 330,
      height = Math.min(780, area?.height || 780);
    const x = b && area ? Math.min(b.x + b.width + 8, area.x + area.width - width) : undefined;
    const y = b && area ? Math.max(area.y, Math.min(b.y, area.y + area.height - height)) : undefined;
    this.create('friends', {
      width,
      height,
      minWidth: 270,
      minHeight: 420,
      ...(x !== undefined ? { x, y } : {}),
      title: 'Друзья · Nexus',
    });
    this.ctx.chat?.connectChats();
    return true;
  }
  openChat(conv) {
    if (!parseConvKey(conv)) throw Error('Некорректный собеседник');
    const loaded = this.win('chat');
    if (loaded && !loaded.webContents.isLoading())
      loaded.webContents.send('social-event', { type: 'open', conv });
    else if (!this.pending.includes(conv)) this.pending.push(conv);
    this.create('chat', { width: 760, height: 580, minWidth: 480, minHeight: 360, title: 'Чат · Nexus' });
    this.ctx.chat?.connectChats();
    return true;
  }
  takePending() {
    const list = this.pending;
    this.pending = [];
    return list;
  }
  // Name, avatar and status of the friend of a conversation (from the friends list).
  friendInfo(conv) {
    const k = parseConvKey(conv);
    if (!k) return null;
    const data = this.ctx.friends?.cache;
    for (const group of data?.[k.provider] || []) {
      const f = group.friends.find(x => x.id === k.friendId);
      if (f) {
        const live = k.provider === 'epic' ? this.ctx.chat?.epicStatus(f.id) : null;
        return { conv, provider: k.provider, ...f, ...(live || {}), account: group.account?.name || '' };
      }
    }
    return {
      conv,
      provider: k.provider,
      id: k.friendId,
      name: k.provider === 'steam' ? 'Друг в Steam' : 'Друг в Epic Games',
      avatar: '',
      status: 'unknown',
      game: '',
    };
  }
  broadcast(event) {
    for (const w of [this.win('friends'), this.win('chat'), this.ctx.mainWindow?.()])
      if (w && !w.isDestroyed()) w.webContents.send('social-event', event);
  }
  closeAll() {
    for (const kind of Object.keys(PAGES)) this.win(kind)?.destroy();
  }
}

module.exports = { SocialWindows, pageUrl };
