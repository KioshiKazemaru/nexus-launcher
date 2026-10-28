'use strict';
/* global api, $, esc, avatarTag, avatarUrl, statusLine, PROVIDER_NAMES */
// The friends window: my accounts on top ("В игре: …" in green), then
// friends grouped like Steam. A click opens the chat with the friend.

let data = null,
  loading = false,
  error = '',
  query = '';
const closedGroups = new Set(['offline']);
try {
  for (const g of JSON.parse(localStorage.getItem('nexus.friends.closed') || '[]')) closedGroups.add(g);
} catch {}

async function load(force = false) {
  if (loading) return;
  loading = true;
  render();
  try {
    data = await api.friends({ force });
    error = '';
  } catch (e) {
    error = e.message;
  }
  loading = false;
  render();
}
const unique = groups => [...new Map((groups || []).flatMap(g => g.friends).map(f => [f.id, f])).values()];

function row(f, provider) {
  const unread = f.unread ? `<b class="unread" title="Непрочитанные сообщения">${f.unread}</b>` : '';
  return `<div class="friend ${esc(f.status)}" role="listitem"><button class="friend-open" ${provider === 'steam' || f.unread ? `data-chat="${esc(f.conv)}" title="Написать: ${esc(f.name)}"` : 'title="Epic Games не даёт писать друзьям из сторонних программ" aria-disabled="true"'}>${avatarTag({ ...f, provider })}<span class="friend-text"><strong>${esc(f.name)}</strong><small>${esc(statusLine({ ...f, provider }))}</small></span>${unread}</button>${
    provider === 'steam'
      ? `<button class="icon profile" data-profile="${esc(f.id)}" title="Профиль Steam" aria-label="Профиль ${esc(f.name)}">👤</button>`
      : ''
  }</div>`;
}
function group(id, title, list, provider) {
  if (!list.length) return '';
  const open = query || !closedGroups.has(id);
  return `<section class="group"><button class="group-head" data-group="${esc(id)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${esc(title)} <span>(${list.length})</span></button>${open ? list.map(f => row(f, provider)).join('') : ''}</section>`;
}
function render() {
  const me = data?.me || [];
  $('#me').innerHTML = me.length
    ? me
        .map(
          a =>
            `<div class="me-row ${a.playing ? 'ingame' : 'online'}">${avatarTag({ name: a.name, avatar: avatarUrl(a.avatar), status: a.playing ? 'ingame' : 'online' })}<span class="friend-text"><strong>${esc(a.name)}</strong><small>${a.playing ? 'В игре: ' + esc(a.playing) : 'В сети · ' + PROVIDER_NAMES[a.provider]}</small></span></div>`
        )
        .join('')
    : '';
  const q = query.trim().toLowerCase();
  const match = f => !q || f.name.toLowerCase().includes(q) || (f.game || '').toLowerCase().includes(q);
  const steam = unique(data?.steam).filter(match);
  const epic = unique(data?.epic).filter(match);
  const live = !!data?.epicLive;
  const body = !data
    ? loading
      ? '<p class="empty">Загружаем друзей…</p>'
      : `<p class="empty">${esc(error || 'Нет данных')}</p>`
    : !me.length
      ? '<p class="empty">Войдите в Steam или Epic Games в «Аккаунтах» главного окна, чтобы видеть друзей.</p>'
      : group(
          'ingame',
          'В игре',
          steam.filter(f => f.status === 'ingame'),
          'steam'
        ) +
        group(
          'online',
          'В сети',
          steam.filter(f => f.status === 'online' || f.status === 'away'),
          'steam'
        ) +
        group(
          'offline',
          'Не в сети',
          steam.filter(f => f.status === 'offline' || f.status === 'unknown'),
          'steam'
        ) +
        (live
          ? group(
              'epic-online',
              'Epic Games · в сети',
              epic.filter(f => f.status !== 'offline' && f.status !== 'unknown'),
              'epic'
            ) +
            group(
              'epic-offline',
              'Epic Games · не в сети',
              epic.filter(f => f.status === 'offline' || f.status === 'unknown'),
              'epic'
            )
          : group('epic', 'Epic Games', epic, 'epic')) +
        (q && !steam.length && !epic.length ? '<p class="empty">Никого не найдено</p>' : '');
  $('#list').innerHTML = body;
  $('#note').innerHTML = [
    ...(data?.errors || []).map(e => `<p class="warning">${esc(e)}</p>`),
    error && data ? `<p class="warning">${esc(error)}</p>` : '',
    epic.length && !live ? '<p>Статусы друзей Epic появятся, когда подключится чат Epic.</p>' : '',
  ].join('');
  $('#refresh').classList.toggle('spin', loading);
}

document.addEventListener('click', async e => {
  const el = e.target.closest('button');
  if (!el) return;
  try {
    if (el.dataset.chat) await api.openChat(el.dataset.chat);
    else if (el.dataset.profile) await api.openProfile({ provider: 'steam', id: el.dataset.profile });
    else if (el.dataset.group) {
      const id = el.dataset.group;
      closedGroups.has(id) ? closedGroups.delete(id) : closedGroups.add(id);
      try {
        localStorage.setItem('nexus.friends.closed', JSON.stringify([...closedGroups]));
      } catch {}
      render();
    } else if (el.id === 'refresh') await load(true);
  } catch (err) {
    error = err.message;
    render();
  }
});
$('#search').addEventListener('input', e => {
  query = e.target.value;
  render();
});
// Live changes: presence of Epic friends and unread messages.
api.onSocialEvent(ev => {
  if (!data) return;
  if (ev.type === 'presence')
    for (const g of data.epic || [])
      for (const f of g.friends)
        if (f.id === ev.friendId) Object.assign(f, { status: ev.status, game: ev.game });
  if (ev.type === 'unread') {
    data.unread = ev.unread;
    for (const g of [...(data.steam || []), ...(data.epic || [])])
      for (const f of g.friends) f.unread = ev.unread[f.conv] || 0;
  }
  if (ev.type === 'chat-state' && ev.provider === 'epic' && ev.state === 'online') data.epicLive = true;
  if (['presence', 'unread', 'chat-state'].includes(ev.type)) render();
});
load();
setInterval(() => !document.hidden && load(), 60000);
window.addEventListener('focus', () => data && Date.now() - (data.checkedAt || 0) > 30000 && load());
