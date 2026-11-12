// Corner of the screen during a game (src/main/overlay.cjs): FPS and short notices.
'use strict';
/* global api, esc, avatarUrl */
const fpsBox = document.querySelector('#hud-fps');
const notices = document.querySelector('#hud-notices');

function show(ev) {
  const text =
    ev.type === 'achievement'
      ? { title: 'Достижение получено', body: ev.name, icon: ev.icon }
      : ev.entry?.type === 'game'
        ? { title: ev.entry.name, body: `Играет в ${ev.entry.game || 'игру'}`, icon: ev.entry.avatar }
        : ev.entry?.type === 'online'
          ? { title: ev.entry.name, body: 'Теперь в сети', icon: ev.entry.avatar }
          : null;
  if (!text) return;
  const el = document.createElement('div');
  el.className = 'hud-notice';
  el.innerHTML = `${avatarUrl(text.icon) ? `<img src="${esc(text.icon)}" alt="" referrerpolicy="no-referrer">` : '<span class="hud-mark">N</span>'}<span><strong>${esc(text.title)}</strong><small>${esc(text.body)}</small></span>`;
  notices.prepend(el);
  setTimeout(() => el.remove(), 6500);
  while (notices.children.length > 3) notices.lastChild.remove();
}

api.onOverlayEvent(ev => {
  // The counter was switched off: it goes away (later notices show the corner without it).
  if (ev.kind === 'fps' && ev.off) fpsBox.hidden = true;
  else if (ev.kind === 'fps') {
    fpsBox.hidden = false;
    fpsBox.textContent = ev.error ? 'FPS —' : `${ev.fps || 0} FPS`;
    fpsBox.title = ev.error || '';
  } else if (ev.kind === 'notice') show(ev);
});
