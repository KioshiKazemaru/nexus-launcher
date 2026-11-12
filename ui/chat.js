'use strict';
/* global api, $, esc, avatarTag, statusLine, timeText, dayText, PROVIDER_NAMES, chatParts */
// The chat window: a tab per friend, the conversation and the input.
// Enter sends, Shift+Enter starts a new line.

const tabs = []; // { conv, provider, id, name, avatar, status, game, unread }
const conversations = new Map(); // conv → { messages, warning, state, loaded, draft, error }
let active = null,
  sending = false;

const conversation = conv => {
  if (!conversations.has(conv))
    conversations.set(conv, { messages: [], warning: '', loaded: false, draft: '', error: '' });
  return conversations.get(conv);
};

async function openTab(info, focus = true) {
  if (!info?.conv) return;
  let tab = tabs.find(t => t.conv === info.conv);
  if (!tab) {
    tab = { ...info, unread: 0 };
    tabs.push(tab);
  } else Object.assign(tab, info, { unread: tab.unread });
  if (focus || !active) await activate(tab.conv);
  else renderTabs();
}
async function activate(conv) {
  saveDraft();
  active = conv;
  const tab = tabs.find(t => t.conv === conv);
  if (tab) tab.unread = 0;
  reportViewing();
  render();
  const c = conversation(conv);
  if (!c.loaded) await loadMessages(conv);
  $('#input')?.focus();
}
async function loadMessages(conv) {
  const c = conversation(conv);
  try {
    const r = await api.chatMessages(conv);
    c.messages = r.messages || [];
    c.warning = r.warning || '';
    c.state = r.state;
    c.readonly = !!r.readonly;
    c.loaded = true;
  } catch (e) {
    c.warning = e.message;
    c.loaded = true;
  }
  if (conv === active) render();
}
function closeTab(conv) {
  const i = tabs.findIndex(t => t.conv === conv);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (active === conv) {
    active = tabs[Math.min(i, tabs.length - 1)]?.conv || null;
    if (active) return activate(active);
  }
  reportViewing();
  render();
}
function reportViewing() {
  api.chatViewing(active && document.hasFocus() ? [active] : []).catch(() => {});
}
function saveDraft() {
  const input = $('#input');
  if (active && input) conversation(active).draft = input.value;
}

function renderTabs() {
  $('#tabs').innerHTML = tabs
    .map(
      t =>
        `<span class="tab ${t.conv === active ? 'active' : ''} ${t.unread ? 'has-unread' : ''}" role="tab" aria-selected="${t.conv === active}"><button class="tab-open" data-tab="${esc(t.conv)}" title="${esc(t.name)} · ${PROVIDER_NAMES[t.provider]}">${avatarTag(t, 'avatar small')}<span>${esc(t.name)}</span>${t.unread ? `<b class="unread">${t.unread}</b>` : ''}</button><button class="tab-close" data-close="${esc(t.conv)}" aria-label="Закрыть чат с ${esc(t.name)}">×</button></span>`
    )
    .join('');
}
function messagesHtml(list) {
  let html = '',
    lastDay = '',
    prev = null;
  const tab = tabs.find(t => t.conv === active);
  for (const m of list) {
    const day = dayText(m.at);
    if (day !== lastDay) {
      html += `<div class="day"><span>${esc(day)}</span></div>`;
      lastDay = day;
      prev = null;
    }
    const grouped = prev && prev.from === m.from && m.at - prev.at < 5 * 60000;
    const who = m.from === 'me' ? 'Вы' : tab?.name || 'Друг';
    const state = m.pending
      ? `<small class="msg-state">⏳ ${m.wait === 'restart' ? 'перезапустите Steam один раз — сообщение уйдёт само' : 'отправится, как только Steam сможет'} <button class="link" data-retry="${esc(m.id)}" data-drop="1">Отменить</button></small>`
      : m.failed
        ? `<small class="msg-state failed">Не отправлено: ${esc(m.failed)} <button class="link" data-retry="${esc(m.id)}">Повторить</button> <button class="link" data-retry="${esc(m.id)}" data-drop="1">Удалить</button></small>`
        : '';
    html += `<div class="msg ${m.from === 'me' ? 'mine' : 'theirs'} ${grouped ? 'grouped' : ''} ${m.pending ? 'pending' : ''}">${grouped ? '' : `<div class="msg-head"><strong>${esc(who)}</strong><time>${timeText(m.at)}</time></div>`}${messageBody(m)}${state}</div>`;
    prev = m;
  }
  return html;
}
// The text with its links: pictures as previews, Steam screenshot pages too.
const sharedImages = new Map(); // id → { url, title } | null | 'loading'
function messageBody(m) {
  const parts = chatParts(m.text);
  let text = '',
    media = '';
  const shown = new Set();
  for (const p of parts) {
    const shared = p.shared && sharedImages.get(p.shared);
    if (p.shared && shared === undefined) loadShared(p.shared);
    let src = p.image || (shared && shared.url);
    if (src && brokenImages.has(src)) src = '';
    if (src && shown.has(src)) continue; // the same picture twice in one message: once
    if (src && shown.add(src))
      media += `<button class="chat-img" data-img="${esc(src)}" data-link="${esc(p.url)}" title="Открыть картинку"><img src="${esc(src)}" alt="${esc(shared?.title || 'Картинка')}" loading="lazy" referrerpolicy="no-referrer"></button>`;
    else if (p.url)
      text += `<a href="#" data-link="${esc(p.url)}" title="Открыть в браузере">${esc(p.shared ? 'Скриншот Steam' : p.url)}</a>`;
    else text += esc(p.text);
  }
  // A message that is only a picture shows just the picture.
  const title = esc(new Date(m.at).toLocaleString('ru-RU'));
  return `${text.trim() ? `<p title="${title}">${text}</p>` : ''}${media ? `<div class="chat-media">${media}</div>` : ''}`;
}
async function loadShared(id) {
  sharedImages.set(id, 'loading');
  const r = await api.chatImage(id).catch(() => null);
  sharedImages.set(id, r?.url ? r : null);
  render();
}
function openViewer(src, link) {
  closeViewer();
  const box = document.createElement('div');
  box.id = 'viewer';
  box.className = 'viewer';
  box.innerHTML = `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer"><div class="viewer-bar"><button class="ghost" data-link="${esc(link || src)}">Открыть в браузере</button><button class="ghost" data-viewer-close>Закрыть (Esc)</button></div>`;
  document.body.append(box);
}
function closeViewer() {
  document.getElementById('viewer')?.remove();
}
function render() {
  renderTabs();
  const tab = tabs.find(t => t.conv === active);
  if (!tab) {
    $('#chat').dataset.conv = '';
    $('#chat').innerHTML =
      '<div class="chat-empty"><h2>Нет открытых чатов</h2><p>Выберите друга в окне «Друзья», чтобы написать ему.</p></div>';
    return;
  }
  const c = conversation(tab.conv);
  const root = $('#chat');
  // The input stays the same element while the conversation is open (focus, cursor, IME).
  const fresh = root.dataset.conv !== tab.conv;
  if (fresh) {
    root.dataset.conv = tab.conv;
    root.innerHTML =
      '<div id="chat-head" class="chat-head"></div><p id="chat-note" class="chat-note" hidden></p><div id="messages" class="messages"></div><p id="chat-error" class="chat-error" role="alert" hidden></p><form id="composer" class="composer"><textarea id="input" rows="2" maxlength="2000" aria-label="Сообщение"></textarea><button type="submit" id="send" aria-label="Отправить">➤</button></form>';
    $('#input').value = c.draft || '';
  }
  $('#chat-head').innerHTML =
    `${avatarTag(tab, 'avatar big')}<div class="friend-text"><strong>${esc(tab.name)}</strong><small class="${esc(tab.status)}">${esc(statusLine(tab))} · ${PROVIDER_NAMES[tab.provider]}</small></div>${
      tab.provider === 'steam' ? `<button class="ghost" data-profile="${esc(tab.id)}">Профиль</button>` : ''
    }`;
  const note = $('#chat-note');
  note.hidden = !c.warning;
  note.textContent = c.warning;
  const box = $('#messages');
  const atBottom = fresh || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = !c.loaded
    ? '<p class="chat-note">Загружаем переписку…</p>'
    : c.messages.length
      ? messagesHtml(c.messages)
      : '<p class="chat-note">Сообщений пока нет. Напишите первым!</p>';
  if (atBottom) box.scrollTop = box.scrollHeight;
  const err = $('#chat-error');
  err.hidden = !c.error;
  err.textContent = c.error;
  // Epic does not deliver messages from other programs: the input is off.
  $('#input').disabled = !!c.readonly;
  $('#input').placeholder = c.readonly
    ? 'Писать друзьям Epic можно только в Epic Games Launcher или в игре'
    : c.state === 'connecting'
      ? 'Подключаемся к чату Steam…'
      : 'Сообщение для ' + tab.name;
  $('#send').disabled = sending || !!c.readonly;
}
function addMessage(conv, msg) {
  const c = conversation(conv);
  if (c.messages.some(m => m.from === msg.from && m.text === msg.text && Math.abs(m.at - msg.at) < 60000))
    return;
  c.messages.push(msg);
  c.messages.sort((a, b) => a.at - b.at);
}

async function send() {
  const input = $('#input');
  const text = input?.value.trim();
  if (!active || !text || sending) return;
  const conv = active;
  sending = true;
  conversation(conv).error = '';
  $('#send').disabled = true;
  try {
    const msg = await api.chatSend({ conv, text });
    addMessage(conv, msg);
    conversation(conv).draft = '';
    if (conv === active) input.value = '';
  } catch (e) {
    conversation(conv).error = 'Не отправлено: ' + e.message;
  }
  sending = false;
  if (conv === active) {
    render();
    $('#input')?.focus();
  }
}

document.addEventListener('click', e => {
  if (e.target.id === 'viewer') return closeViewer();
  const el = e.target.closest('button, a[data-link]');
  if (!el) return;
  if (el.tagName === 'A') e.preventDefault();
  if (el.dataset.img) openViewer(el.dataset.img, el.dataset.link);
  else if (el.dataset.link) api.chatOpenLink(el.dataset.link).catch(() => {});
  else if (el.dataset.viewerClose !== undefined) closeViewer();
  else if (el.dataset.retry && active) {
    const conv = active;
    api
      .chatRetry({ conv, id: el.dataset.retry, drop: el.dataset.drop === '1' })
      .catch(err => ((conversation(conv).error = err.message), render()));
  } else if (el.dataset.tab) activate(el.dataset.tab);
  else if (el.dataset.close) closeTab(el.dataset.close);
  else if (el.dataset.profile) api.openProfile({ provider: 'steam', id: el.dataset.profile }).catch(() => {});
});
document.addEventListener('auxclick', e => {
  const el = e.target.closest('[data-tab]');
  if (el && e.button === 1) closeTab(el.dataset.tab);
});
document.addEventListener('submit', e => {
  e.preventDefault();
  send();
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
  if (e.key === 'Escape' && document.getElementById('viewer')) {
    e.preventDefault();
    return closeViewer();
  }
  if (e.key === 'Escape' && e.ctrlKey && active) closeTab(active);
});
// A picture that does not load (an expired Discord link, a removed upload): the link
// instead of an empty frame. Remembered, so the next render does not try again.
const brokenImages = new Set();
document.addEventListener(
  'error',
  e => {
    const btn = e.target.closest?.('.chat-img');
    if (!btn || e.target.tagName !== 'IMG') return;
    brokenImages.add(btn.dataset.img);
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'chat-img-broken';
    a.dataset.link = btn.dataset.link || btn.dataset.img;
    a.title = 'Картинка не загрузилась — открыть в браузере';
    a.textContent = '🖼 ' + a.dataset.link;
    btn.replaceWith(a);
  },
  true
);
window.addEventListener('focus', reportViewing);
window.addEventListener('blur', reportViewing);

api.onSocialEvent(async ev => {
  if (ev.type === 'open') return openTab(await api.friendInfo(ev.conv));
  if (ev.type === 'message') {
    if (!tabs.some(t => t.conv === ev.conv)) await openTab(await api.friendInfo(ev.conv), false);
    addMessage(ev.conv, ev.message);
    const tab = tabs.find(t => t.conv === ev.conv);
    if (ev.conv !== active && ev.message.from === 'them' && tab) tab.unread++;
    if (ev.conv === active) render();
    else renderTabs();
  }
  // A message that waited (or failed) has changed: sent, failed or removed.
  if (ev.type === 'message-update') {
    const c = conversations.get(ev.conv);
    if (!c) return;
    c.messages = ev.removed
      ? c.messages.filter(m => m.id !== ev.id)
      : c.messages.map(m => (m.id === ev.id ? ev.message : m)).sort((a, b) => a.at - b.at);
    if (ev.conv === active) render();
  }
  if (ev.type === 'presence')
    for (const t of tabs)
      if (t.provider === 'epic' && t.id === ev.friendId) {
        Object.assign(t, { status: ev.status, game: ev.game });
        if (t.conv === active) render();
      }
  if (ev.type === 'chat-state') {
    const prefix = `${ev.provider}|${ev.accountId}|`;
    for (const [conv, c] of conversations) if (conv.startsWith(prefix)) c.state = ev.state;
    const c = active && conversations.get(active);
    if (c && active.startsWith(prefix)) {
      if (ev.error && ev.provider === 'steam' && ev.state !== 'client') c.error = ev.error;
      render();
    }
  }
});

(async () => {
  render();
  const list = await api.chatTabs().catch(() => []);
  for (const [i, info] of list.entries()) await openTab(info, i === list.length - 1);
})();
