'use strict';
// The tray icon, like Steam's: closing the window keeps Nexus running there
// (downloads, chat, status); its menu starts recent games, sets the status
// and opens the pages.

const { Tray, Menu, app, nativeImage } = require('electron');
const { STATUS_LABELS } = require('../presence.cjs');

class NexusTray {
  constructor(ctx, { icon }) {
    this.ctx = ctx;
    this.icon = icon;
    this.tray = null;
    this.hintShown = false;
  }
  create() {
    if (this.tray) return;
    // macOS and Linux panels want a small picture (the .ico of Windows holds every size).
    let image = this.icon;
    if (process.platform !== 'win32') {
      const size = process.platform === 'darwin' ? 18 : 24;
      const small = nativeImage.createFromPath(this.icon).resize({ width: size, height: size });
      if (!small.isEmpty()) image = small;
    }
    this.tray = new Tray(image);
    this.tray.setToolTip('Nexus');
    this.tray.on('click', () => this.ctx.focusMain());
    this.update();
  }
  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
  // The window was closed into the tray: said once per session.
  hidden() {
    if (this.hintShown || !this.tray) return;
    this.hintShown = true;
    try {
      this.tray.displayBalloon?.({
        title: 'Nexus работает в трее',
        content: 'Загрузки, чат и статус продолжают работать. Выйти — в меню значка Nexus.',
        iconType: 'info',
      });
    } catch {}
  }
  recentGames() {
    const games = this.ctx.library?.games || [];
    return (this.ctx.settings?.recent || [])
      .map(r => games.find(g => g.id === r.id))
      .filter(g => g && g.offers.some(o => o.installed))
      .slice(0, 8);
  }
  play(g) {
    const s = this.ctx.settings;
    const o =
      g.offers.find(x => x.installed && x.provider === s.preferred?.[g.id]) ||
      g.offers.find(x => x.installed);
    if (!o) return;
    this.ctx.actions
      .play({ id: g.id, provider: o.provider })
      .then(() => this.ctx.hub.publish())
      .catch(e => {
        this.ctx.focusMain();
        this.ctx.toast?.(e.message);
      });
  }
  update() {
    if (!this.tray) return;
    const ctx = this.ctx;
    const status = ctx.presence?.status() || 'online';
    const playing = ctx.presence?.playing;
    const recent = this.recentGames();
    const page = name => () => ctx.showPage(name);
    const menu = Menu.buildFromTemplate([
      { label: 'Открыть Nexus', click: () => ctx.focusMain() },
      ...(playing ? [{ label: `Сейчас в игре: ${playing.name}`.slice(0, 80), enabled: false }] : []),
      { type: 'separator' },
      { label: 'Магазин', click: page('store') },
      { label: 'Библиотека', click: page('library') },
      { label: 'Загрузки', click: page('downloads') },
      { label: 'Друзья и чат', click: () => ctx.social?.openFriends() },
      { label: 'Активность друзей', click: page('activity') },
      { type: 'separator' },
      recent.length
        ? {
            label: 'Недавние игры',
            submenu: recent.map(g => ({
              label: g.name.slice(0, 60),
              enabled: !ctx.running?.isRunning(g.id),
              click: () => this.play(g),
            })),
          }
        : { label: 'Недавних игр нет', enabled: false },
      {
        label: `Статус: ${STATUS_LABELS[status]}`,
        submenu: ['online', 'away', 'invisible', 'off'].map(s => ({
          label: STATUS_LABELS[s],
          type: 'radio',
          checked: s === status,
          click: () => ctx.presence?.setStatus(s).catch(e => ctx.log.warn('presence', e.message)),
        })),
      },
      { type: 'separator' },
      { label: 'Выйти из Nexus', click: () => app.quit() },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.setToolTip(playing ? `Nexus · в игре: ${playing.name}`.slice(0, 120) : 'Nexus');
  }
}

module.exports = { NexusTray };
