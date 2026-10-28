'use strict';
// Shared by the friends window (friends.js) and the chat window (chat.js).
/* exported esc, avatarUrl, statusLine, avatarTag, timeText, dayText, PROVIDER_NAMES, api, $ */

const api = window.nexus;
const $ = selector => document.querySelector(selector);
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const PROVIDER_NAMES = { steam: 'Steam', epic: 'Epic Games' };
// Only avatar hosts allowed by the page's Content-Security-Policy.
function avatarUrl(url) {
  return /^https:\/\/([\w-]+\.)*(steamstatic\.com|akamaihd\.net|epicgames\.com)\//.test(String(url || ''))
    ? url
    : '';
}
const STATUS = { ingame: 'В игре', online: 'В сети', away: 'Нет на месте', offline: 'Не в сети' };
function statusLine(f) {
  if (f.status === 'ingame') return f.game ? 'В игре: ' + f.game : 'В игре';
  return STATUS[f.status] || (f.provider === 'epic' ? 'Друг в Epic Games' : '');
}
function avatarTag(f, cls = 'avatar') {
  const src = avatarUrl(f.avatar);
  return `<span class="${cls} ${esc(f.status || 'unknown')}">${
    src
      ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : esc((f.name || '?').trim().slice(0, 1).toUpperCase() || '?')
  }</span>`;
}
const timeText = at => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function dayText(at) {
  const d = new Date(at),
    today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}
