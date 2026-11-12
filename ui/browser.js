'use strict';
// The bar of the Nexus browser: tabs, address, navigation, downloads. The pages are
// drawn by the main process below this bar (main/browser.cjs); its height is reported
// so they start right under it.

const api = globalThis.nexusBrowser;
const $ = s => document.querySelector(s);
let view = { tabs: [], downloads: [], active: null };
let editing = false;

const run = fn =>
  Promise.resolve()
    .then(fn)
    .catch(e => console.warn(e.message));
const send = (cmd, extra = {}) => run(() => api.command({ cmd, ...extra }));

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
const safeIcon = url => (/^https:\/\/[^\s"'<>]+$/.test(url || '') ? url : '');
function size(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1 ? mb.toFixed(mb >= 100 ? 0 : 1) + ' МБ' : Math.max(1, Math.round(bytes / 1024)) + ' КБ';
}

function renderTabs() {
  $('#tabs').innerHTML = view.tabs
    .map(t => {
      const icon = safeIcon(t.favicon);
      const mark = t.loading
        ? '<span class="dot loading"></span>'
        : icon
          ? `<img src="${esc(icon)}" alt="" referrerpolicy="no-referrer">`
          : '<span class="dot"></span>';
      return `<div class="tab${t.id === view.active ? ' active' : ''}" role="tab" aria-selected="${t.id === view.active}" data-tab="${t.id}" title="${esc(t.title)}">${mark}<span class="title">${esc(t.title)}</span><button class="close" data-close="${t.id}" title="Закрыть (Ctrl+W)" aria-label="Закрыть вкладку">×</button></div>`;
    })
    .join('');
}
function renderNav() {
  const t = view.tabs.find(x => x.id === view.active);
  $('#back').disabled = !t?.canBack;
  $('#forward').disabled = !t?.canForward;
  $('#reload').textContent = t?.loading ? '✕' : '↻';
  $('#reload').title = t?.loading ? 'Остановить' : 'Обновить (F5)';
  if (!editing) $('#address').value = t?.url || '';
  $('#lock').className = 'lock' + (t?.url ? (t.secure ? ' secure' : ' insecure') : '');
  $('#lock').title = t?.url ? (t.secure ? 'Защищённое соединение' : 'Соединение не защищено') : '';
  $('#signed').hidden = !t?.signedIn;
  $('#crashed').hidden = !t?.crashed;
  document.title = t?.title ? `${t.title} — Браузер Nexus` : 'Браузер Nexus';
}
function renderDownloads() {
  const box = $('#downloads');
  box.hidden = !view.downloads.length;
  box.innerHTML = view.downloads.length
    ? view.downloads
        .map(d => {
          const progress =
            d.state === 'completed'
              ? `<small>${size(d.received)}</small><button data-open="${d.id}">Открыть</button><button data-show="${d.id}">В папке</button>`
              : d.state === 'progressing' || d.state === 'paused'
                ? `<small>${size(d.received)}${d.total ? ' из ' + size(d.total) : ''}</small><button data-cancel="${d.id}">Отмена</button>`
                : `<small>${d.state === 'cancelled' ? 'отменено' : 'не загрузилось'}</small>`;
          return `<div class="download"><span class="name" title="${esc(d.name)}">${esc(d.name)}</span>${progress}</div>`;
        })
        .join('') + '<button id="dismiss-downloads" title="Убрать завершённые">Скрыть</button>'
    : '';
}
let lastHeight = 0;
function reportHeight() {
  const h = Math.ceil($('#bar').getBoundingClientRect().height);
  if (h !== lastHeight) {
    lastHeight = h;
    send('layout', { value: h });
  }
}
function render(state) {
  view = state || view;
  document.body.classList.toggle('mac', view.platform === 'darwin');
  renderTabs();
  renderNav();
  renderDownloads();
  reportHeight();
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-close],[data-tab],[data-open],[data-show],[data-cancel],button');
  if (!el) return;
  if (el.dataset.close) return send('close', { id: Number(el.dataset.close) });
  if (el.dataset.tab) return send('activate', { id: Number(el.dataset.tab) });
  if (el.dataset.open) return send('openDownload', { id: Number(el.dataset.open) });
  if (el.dataset.show) return send('showDownload', { id: Number(el.dataset.show) });
  if (el.dataset.cancel) return send('cancelDownload', { id: Number(el.dataset.cancel) });
  const t = view.tabs.find(x => x.id === view.active);
  const act = {
    'new-tab': () => send('newTab'),
    back: () => send('back'),
    forward: () => send('forward'),
    reload: () => send(t?.loading ? 'stop' : 'reload'),
    'crash-reload': () => send('reload'),
    'dismiss-downloads': () => send('dismissDownloads'),
  }[el.id];
  act?.();
});
// Middle click closes a tab, like in other browsers.
document.addEventListener('auxclick', e => {
  const tab = e.button === 1 && e.target.closest('[data-tab]');
  if (tab) send('close', { id: Number(tab.dataset.tab) });
});
$('#address-form').addEventListener('submit', e => {
  e.preventDefault();
  editing = false;
  const value = $('#address').value;
  run(async () => {
    await api.command({ cmd: 'navigate', value });
    await api.command({ cmd: 'focusPage' });
  });
});
$('#address').addEventListener('focus', () => {
  editing = true;
  $('#address').select();
});
$('#address').addEventListener('blur', () => {
  editing = false;
  renderNav();
});
$('#address').addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    editing = false;
    renderNav();
    send('focusPage');
  }
});
// The same shortcuts as in a page (they arrive there through the main process).
document.addEventListener('keydown', e => {
  const mod = view.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  const t = view.tabs.find(x => x.id === view.active);
  let handled = true;
  if ((mod && key === 'r') || key === 'f5') send('reload');
  else if (mod && key === 'w' && t) send('close', { id: t.id });
  else if (mod && key === 't') send('newTab');
  else if (mod && key === 'l') $('#address').focus();
  else if (e.altKey && key === 'arrowleft') send('back');
  else if (e.altKey && key === 'arrowright') send('forward');
  else handled = false;
  if (handled) e.preventDefault();
});
new ResizeObserver(reportHeight).observe($('#bar'));

api.onState(render);
api.onFocusAddress(() => $('#address').focus());
run(async () => render(await api.command({ cmd: 'state' })));
