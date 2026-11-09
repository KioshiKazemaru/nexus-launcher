// In-game overlay (src/main/overlay.cjs): session, friends, achievements, FPS switch.
'use strict';
/* global api, $, esc, avatarTag, avatarUrl, statusLine */
let info = null;
let clockTimer = null;

function sessionText(since) {
  const min = Math.max(0, Math.floor((Date.now() - since) / 60000));
  return min < 60 ? `В игре ${min} мин.` : `В игре ${Math.floor(min / 60)} ч ${min % 60} мин.`;
}
function tick() {
  $('#ov-clock').textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (info?.game) $('#ov-session').textContent = sessionText(info.game.since);
}
function renderInfo() {
  $('#ov-name').textContent = info?.game?.name || 'Игра';
  $('#ov-fps').checked = !!info?.fps;
  $('#ov-fps-note').textContent =
    info?.fpsError || 'FPS считает PresentMon (из AMD Software или Intel PresentMon).';
  $('#ov-keys').textContent = `${info?.hotkey || 'Shift+Tab'} или Esc — вернуться в игру`;
  tick();
}
async function loadFriends() {
  const box = $('#ov-friends');
  try {
    const data = await api.friends({});
    const all = ['steam', 'epic'].flatMap(provider =>
      (data[provider] || []).flatMap(g => g.friends.map(f => ({ ...f, provider })))
    );
    const online = all.filter(f => f.status === 'ingame' || f.status === 'online' || f.status === 'away');
    box.innerHTML = online.length
      ? online
          .slice(0, 60)
          .map(
            f =>
              `<button class="ov-friend" data-conv="${esc(f.conv)}">${avatarTag(f)}<span><strong>${esc(f.name)}</strong><small class="${esc(f.status)}">${esc(statusLine(f))}</small></span>${f.unread ? `<b class="ov-unread">${f.unread}</b>` : ''}</button>`
          )
          .join('')
      : '<p class="ov-hint">Никого из друзей нет в сети.</p>';
  } catch (e) {
    box.innerHTML = `<p class="ov-hint">${esc(e.message)}</p>`;
  }
}
async function loadAchievements() {
  const box = $('#ov-achievements');
  if (!info?.game) return;
  try {
    const a = await api.achievements(info.game.id);
    if (!a?.available) {
      box.innerHTML = `<p class="ov-hint">${esc(a?.reason || 'Достижений нет')}</p>`;
      return;
    }
    $('#ov-ach-title').textContent = `ДОСТИЖЕНИЯ · ${a.unlocked}/${a.total}`;
    const list = [...a.list].sort(
      (x, y) => Number(x.unlocked) - Number(y.unlocked) || (y.unlockedAt || 0) - (x.unlockedAt || 0)
    );
    box.innerHTML = `<div class="ov-bar"><i style="width:${Number(a.percent) || 0}%"></i></div>${list
      .slice(0, 80)
      .map(
        x =>
          `<div class="ov-ach ${x.unlocked ? 'done' : ''}">${avatarUrl(x.icon) ? `<img src="${esc(x.icon)}" alt="" referrerpolicy="no-referrer">` : '<span class="ov-ach-icon"></span>'}<span><strong>${esc(x.name)}</strong><small>${esc(x.description || '')}</small></span></div>`
      )
      .join('')}`;
  } catch (e) {
    box.innerHTML = `<p class="ov-hint">${esc(e.message)}</p>`;
  }
}
function notice(ev) {
  const box = $('#ov-notices');
  if (box.querySelector('.ov-hint')) box.innerHTML = '';
  const text =
    ev.type === 'achievement'
      ? `🏆 ${ev.name}${ev.description ? ' — ' + ev.description : ''}`
      : ev.entry?.type === 'game'
        ? `${ev.entry.name} играет в ${ev.entry.game || 'игру'}`
        : ev.entry?.type === 'online'
          ? `${ev.entry.name} теперь в сети`
          : '';
  if (!text) return;
  const el = document.createElement('p');
  el.className = 'ov-notice';
  el.textContent = text;
  box.prepend(el);
}
const hide = () => api.overlayHide().catch(() => {});

api.onOverlayEvent(ev => {
  if (ev.kind === 'open') {
    info = ev.info;
    renderInfo();
    loadFriends();
    loadAchievements();
    clearInterval(clockTimer);
    clockTimer = setInterval(tick, 15000);
  } else if (ev.kind === 'notice') notice(ev);
});
api.onSocialEvent(ev => {
  if (ev.type === 'presence' || ev.type === 'unread') loadFriends();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') hide();
});
document.addEventListener('click', e => {
  const friend = e.target.closest('[data-conv]');
  if (friend) api.overlayChat(friend.dataset.conv).catch(() => {});
});
$('#ov-back').addEventListener('click', hide);
$('#ov-close-game').addEventListener('click', async () => {
  if (!info?.game || !confirm(`Закрыть «${info.game.name}»? Несохранённый прогресс может пропасть.`)) return;
  await hide();
  api.closeGame(info.game.id).catch(() => {});
});
$('#ov-fps').addEventListener('change', async e => {
  try {
    info = await api.overlayFps(e.target.checked);
    renderInfo();
  } catch {}
});
api
  .overlayInfo()
  .then(i => {
    info = i;
    renderInfo();
  })
  .catch(() => {});
