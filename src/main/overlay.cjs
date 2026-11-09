'use strict';
// The in-game overlay, like Steam's Shift+Tab: a window over the game with
// the session, the friends (chat opens on top), the game's achievements and
// the FPS counter switch. A small click-through corner window (the "HUD")
// shows the FPS and in-game notices (achievements, friends).
//
// Limits: a window cannot cover a game in exclusive full screen; games in a
// window or borderless full screen are covered. The hotkey is taken only
// while a game runs.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, globalShortcut, screen } = require('electron');
const fps = require('../fps.cjs');

const UI = path.join(__dirname, '../../ui');
const PAGES = { overlay: 'overlay.html', hud: 'hud.html' };
const pageUrl = kind => pathToFileURL(path.join(UI, PAGES[kind])).href;
const HOTKEYS = ['Shift+Tab', 'Shift+F1', 'Ctrl+Shift+O', 'Alt+F12'];

class Overlay {
  constructor(ctx) {
    this.ctx = ctx;
    this.windows = { overlay: null, hud: null };
    this.hotkey = '';
    this.fpsProc = null;
    this.fpsMeter = null;
    this.fpsTimer = null;
    this.fpsError = '';
    this.hudTimer = null;
  }
  win(kind) {
    const w = this.windows[kind];
    return w && !w.isDestroyed() ? w : null;
  }
  isSender(event) {
    for (const kind of Object.keys(PAGES)) {
      const w = this.win(kind);
      if (w && event.sender === w.webContents && event.senderFrame?.url === pageUrl(kind)) return kind;
    }
    return '';
  }
  start() {
    this.ctx.gameEvents?.on('start', () => this.gamesChanged());
    this.ctx.gameEvents?.on('stop', () => this.gamesChanged());
  }
  settings() {
    return this.ctx.settings;
  }
  current() {
    const running = Object.entries(this.ctx.running?.snapshot() || {});
    if (!running.length) return null;
    const [id, r] = running.sort((a, b) => b[1].since - a[1].since)[0];
    return { id, name: r.name, provider: r.provider, since: r.since };
  }
  // ---- hotkey ---------------------------------------------------------------------
  gamesChanged() {
    const playing = !!this.current();
    if (playing && this.settings().overlay !== false) this.arm();
    else this.disarm();
    this.syncFps();
    if (!playing) {
      this.hide();
      this.win('hud')?.hide();
    }
  }
  arm() {
    const key = HOTKEYS.includes(this.settings().overlayHotkey) ? this.settings().overlayHotkey : 'Shift+Tab';
    if (this.hotkey === key) return;
    this.disarm();
    try {
      if (globalShortcut.register(key, () => this.toggle())) this.hotkey = key;
      else this.ctx.log.warn('overlay', `hotkey ${key} is taken by another program`);
    } catch (e) {
      this.ctx.log.warn('overlay', e.message);
    }
  }
  disarm() {
    if (!this.hotkey) return;
    try {
      globalShortcut.unregister(this.hotkey);
    } catch {}
    this.hotkey = '';
  }
  // Settings changed in the main window.
  reconfigure() {
    this.disarm();
    this.gamesChanged();
  }
  // ---- windows ----------------------------------------------------------------------
  display() {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
      return screen.getPrimaryDisplay();
    }
  }
  create(kind, options) {
    const existing = this.win(kind);
    if (existing) return existing;
    const w = new BrowserWindow({
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      ...options,
      webPreferences: {
        preload: path.join(__dirname, '../overlay-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', e => e.preventDefault());
    w.on('closed', () => (this.windows[kind] = null));
    this.windows[kind] = w;
    w.loadURL(pageUrl(kind)).catch(e => this.ctx.log.warn('overlay', `${kind}: ${e.message}`));
    return w;
  }
  toggle() {
    const w = this.win('overlay');
    if (w?.isVisible()) this.hide();
    else this.show();
  }
  show() {
    if (!this.current()) return;
    const area = this.display().bounds;
    const w = this.create('overlay', { ...area });
    w.setBounds(area);
    const reveal = () => {
      w.webContents.send('overlay-event', { kind: 'open', info: this.info() });
      w.show();
      w.focus();
    };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal);
    else reveal();
  }
  hide() {
    const w = this.win('overlay');
    if (w?.isVisible()) w.hide();
    // A chat opened from the overlay goes back to a normal window.
    const chat = this.ctx.social?.win?.('chat');
    if (chat) chat.setAlwaysOnTop(false);
  }
  openChat(conv) {
    this.ctx.social.openChat(conv);
    const chat = this.ctx.social.win('chat');
    if (this.win('overlay')?.isVisible() && chat) {
      chat.setAlwaysOnTop(true, 'screen-saver', 1);
      chat.show();
      chat.focus();
    }
    return true;
  }
  info() {
    const g = this.current();
    return {
      game: g,
      fps: this.settings().overlayFps === true,
      fpsError: this.fpsError,
      hotkey: this.hotkey || this.settings().overlayHotkey || 'Shift+Tab',
      status: this.ctx.presence?.status() || 'online',
    };
  }
  // ---- HUD: FPS and notices in the corner ------------------------------------------
  hud() {
    const area = this.display().workArea;
    const width = 320,
      height = 200;
    const w = this.create('hud', {
      x: area.x + area.width - width - 12,
      y: area.y + 12,
      width,
      height,
      focusable: false,
    });
    w.setIgnoreMouseEvents(true);
    return w;
  }
  sendHud(event) {
    if (!this.current()) return;
    const w = this.hud();
    const go = () => {
      w.webContents.send('overlay-event', event);
      if (!w.isVisible()) w.showInactive();
    };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go);
    else go();
    clearTimeout(this.hudTimer);
    // Without the FPS counter the corner window goes away after the notice.
    if (!this.fpsProc) {
      this.hudTimer = setTimeout(() => this.win('hud')?.hide(), 7000);
      this.hudTimer.unref?.();
    }
  }
  // Achievements and friends' activity while a game runs.
  event(ev) {
    if (!this.current()) return;
    const notice = { ...ev, type: ev.kind, kind: 'notice' };
    this.sendHud(notice);
    this.win('overlay')?.webContents.send('overlay-event', notice);
  }
  // ---- FPS --------------------------------------------------------------------------
  presentMon() {
    return fps.presentMonCandidates().find(f => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });
  }
  async setFps(on) {
    this.settings().overlayFps = on === true;
    this.ctx.storage.saveSettings();
    this.syncFps();
    return this.info();
  }
  syncFps() {
    const want = this.settings().overlayFps === true && !!this.current() && process.platform === 'win32';
    if (want && !this.fpsProc) this.startFps();
    if (!want && this.fpsProc) this.stopFps();
  }
  startFps() {
    const exe = this.presentMon();
    if (!exe) {
      this.fpsError =
        'Для счётчика FPS нужен PresentMon — он входит в AMD Software и Intel PresentMon. Установите одно из них.';
      this.sendHud({ kind: 'fps', fps: 0, error: this.fpsError });
      return;
    }
    this.fpsError = '';
    this.fpsMeter = new fps.FpsMeter(1000);
    const child = spawn(
      exe,
      ['--output_stdout', '--no_console_stats', '--stop_existing_session', '--session_name', 'NexusFps'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    this.fpsProc = child;
    let cols = null,
      rest = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      const pids = new Set(this.ctx.running?.running?.[this.current()?.id]?.pids || []);
      for (const line of lines) {
        if (!cols) {
          cols = fps.columns(line);
          continue;
        }
        const f = fps.frameOf(line, cols);
        if (f && pids.has(f.pid)) this.fpsMeter.add(f.ms);
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', e => {
      this.fpsError = `Счётчик FPS не запустился: ${e.message}`;
      this.stopFps();
    });
    child.on('exit', code => {
      if (this.fpsProc !== child) return;
      this.fpsProc = null;
      clearInterval(this.fpsTimer);
      if (code)
        this.fpsError =
          'PresentMon не смог читать кадры: запустите Nexus от имени администратора или установите AMD Software / Intel PresentMon.';
      this.sendHud({ kind: 'fps', fps: 0, error: this.fpsError });
    });
    this.fpsTimer = setInterval(() => this.sendHud({ kind: 'fps', fps: this.fpsMeter.fps() }), 1000);
    this.fpsTimer.unref?.();
  }
  stopFps() {
    const child = this.fpsProc;
    this.fpsProc = null;
    clearInterval(this.fpsTimer);
    try {
      child?.kill();
    } catch {}
    this.win('hud')?.hide();
  }
  stop() {
    this.disarm();
    this.stopFps();
    for (const kind of Object.keys(PAGES)) this.win(kind)?.destroy();
  }
}

module.exports = { Overlay, HOTKEYS, pageUrl };
