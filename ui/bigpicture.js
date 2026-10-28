'use strict';
/* global state:writable, api, demo, esc, call, toast, activeGames, artwork, isRunning, names, hours, render,
   playToast, wantsInstallWindow, openInstallDialog, PROGRESS_LABELS, $ */
/* exported bigPicture */
// Gamepad mode (like Steam's Big Picture): full screen, large covers, controlled
// with a gamepad (D-pad / left stick, A, B, LB/RB, Y) or the keyboard (arrows,
// Enter, Esc). Opened with the 🎮 button or the gamepad's Guide button.

const bigPicture = (() => {
  const TABS = [
    { id: 'installed', label: 'Установленные' },
    { id: 'recent', label: 'Недавние' },
    { id: 'all', label: 'Вся библиотека' },
    { id: 'downloads', label: 'Загрузки' },
  ];
  let open = false,
    tab = 'installed',
    detail = null, // game id shown in detail
    focusKey = null, // data-bp of the focused element
    lastFocusByTab = {},
    pollId = 0;
  const held = new Map(); // gamepad control → { since, last }

  const root = () => $('#bigpicture');
  const providerOf = g =>
    g.offers.find(o => o.installed && o.provider === state.settings.preferred?.[g.id]) ||
    g.offers.find(o => o.installed) ||
    g.offers.find(o => o.provider === state.settings.preferred?.[g.id]) ||
    g.offers[0];
  function games() {
    const list = (activeGames() || []).filter(g => !g.hidden);
    if (tab === 'installed') return list.filter(g => g.offers.some(o => o.installed));
    if (tab === 'recent') {
      const order = new Map((state.settings.recent || []).map((r, i) => [r.id, i]));
      return list.filter(g => order.has(g.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
    }
    if (tab === 'downloads') return list.filter(g => state.progress?.[g.id]);
    return [...list].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }
  function tile(g) {
    const p = state.progress?.[g.id];
    const src = artwork(g);
    const run = isRunning(g.id);
    return `<button class="bp-tile ${run ? 'running' : ''}" data-bp="game:${esc(g.id)}" data-bp-game="${esc(g.id)}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="bp-noart">${esc(g.name)}</span>`}<span class="bp-tile-name">${esc(g.name)}</span>${run ? '<span class="bp-badge">В игре</span>' : p ? `<span class="bp-badge">${esc(PROGRESS_LABELS[p.state] || 'Загрузка')}${Number.isFinite(p.percent) ? ' ' + p.percent + '%' : ''}</span>` : ''}</button>`;
  }
  function detailView(g) {
    const o = providerOf(g);
    const p = state.progress?.[g.id];
    const run = isRunning(g.id);
    const action = run
      ? '<button class="bp-action stop" data-bp="act:close" data-bp-act="close">■ Закрыть игру</button>'
      : o?.installed
        ? '<button class="bp-action" data-bp="act:play" data-bp-act="play">▶ Играть</button>'
        : p
          ? `<button class="bp-action" data-bp="act:none" disabled>${esc(PROGRESS_LABELS[p.state] || 'Загрузка')}${Number.isFinite(p.percent) ? ' ' + p.percent + '%' : ''}</button>`
          : '<button class="bp-action" data-bp="act:install" data-bp-act="install">↓ Установить</button>';
    const src = artwork(g);
    return `<div class="bp-detail">${src ? `<img class="bp-hero" src="${esc(src)}" alt="" referrerpolicy="no-referrer">` : ''}<div class="bp-detail-body"><h1>${esc(g.name)}</h1><p class="bp-meta">${esc(names[o?.provider] || '')}${g.playtime ? ' · ' + esc(hours(g.playtime)) : ''}</p><div class="bp-actions">${action}<button class="bp-secondary" data-bp="act:back" data-bp-act="back">Назад</button></div><p class="bp-desc">${esc((g.desc || '').slice(0, 400))}</p></div></div>`;
  }
  function draw() {
    const el = root();
    if (!el) return;
    if (!open) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    const g = detail && activeGames().find(x => x.id === detail);
    const list = g ? [] : games();
    el.innerHTML = `<header class="bp-top"><span class="brand-mark">N</span><nav class="bp-tabs">${TABS.map(
      t =>
        `<button class="bp-tab ${t.id === tab ? 'active' : ''}" data-bp="tab:${t.id}" data-bp-tab="${t.id}">${esc(t.label)}</button>`
    ).join(
      ''
    )}</nav><span class="bp-clock">${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span><button class="bp-exit" data-bp="act:exit" data-bp-act="exit">Выйти ✕</button></header><main class="bp-main">${
      g
        ? detailView(g)
        : list.length
          ? `<div class="bp-grid">${list.map(tile).join('')}</div>`
          : `<p class="bp-empty">${tab === 'installed' ? 'Установленных игр нет — откройте «Вся библиотека».' : tab === 'downloads' ? 'Загрузок нет.' : 'Здесь пока пусто.'}</p>`
    }</main><footer class="bp-hints"><span><b>A</b> Выбрать</span><span><b>B</b> Назад</span><span><b>LB RB</b> Разделы</span><span><b>Y</b> Поиск по букве</span></footer>`;
    restoreFocus();
  }
  // ---- focus and spatial navigation -------------------------------------------------
  function scope() {
    const dlg = $('#install-dialog');
    return dlg?.open ? dlg : root();
  }
  function focusables() {
    const s = scope();
    if (!s) return [];
    const sel = s === root() ? '[data-bp]:not([disabled])' : 'button:not([disabled]), input:not([disabled])';
    return [...s.querySelectorAll(sel)].filter(e => e.offsetParent !== null);
  }
  function focus(el) {
    if (!el) return;
    el.focus({ preventScroll: false });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (el.dataset.bp) focusKey = el.dataset.bp;
  }
  function restoreFocus() {
    const all = focusables();
    const want = all.find(e => e.dataset.bp === focusKey);
    // The first thing of the page itself (a game, or the game's main button), not the header.
    focus(
      want ||
        all.find(e => e.closest('.bp-main') && e.dataset.bp?.startsWith(detail ? 'act:' : 'game:')) ||
        all[0]
    );
  }
  function move(dir) {
    const all = focusables();
    const cur =
      document.activeElement && all.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) return focus(all[0]);
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2,
      ay = a.top + a.height / 2;
    let best = null,
      bestScore = Infinity;
    for (const el of all) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2,
        by = b.top + b.height / 2;
      const dx = bx - ax,
        dy = by - ay;
      const ok = dir === 'left' ? dx < -4 : dir === 'right' ? dx > 4 : dir === 'up' ? dy < -4 : dy > 4;
      if (!ok) continue;
      // Along the direction counts once, across it counts more (stays in the row/column).
      const along = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = along + across * 3;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) focus(best);
  }
  function switchTab(step) {
    const i = TABS.findIndex(t => t.id === tab);
    setTab(TABS[(i + step + TABS.length) % TABS.length].id);
  }
  function setTab(id) {
    lastFocusByTab[tab] = focusKey;
    tab = id;
    detail = null;
    focusKey = lastFocusByTab[tab] || null;
    draw();
  }
  // Y: the next game whose name starts with the next letter (fast in long lists).
  function jumpLetter() {
    const all = focusables().filter(e => e.dataset.bpGame);
    if (!all.length) return;
    const cur = all.indexOf(document.activeElement);
    const name = e => (activeGames().find(g => g.id === e.dataset.bpGame)?.name || '').toUpperCase();
    const letter = name(all[Math.max(0, cur)])[0];
    focus(all.find((e, i) => i > cur && name(e)[0] !== letter) || all[0]);
  }
  // ---- actions --------------------------------------------------------------------
  async function activate(el = document.activeElement) {
    if (!el || !root()?.contains(el)) {
      el?.click?.();
      return;
    }
    if (el.dataset.bpTab) return setTab(el.dataset.bpTab);
    if (el.dataset.bpGame) {
      detail = el.dataset.bpGame;
      focusKey = null;
      return draw();
    }
    const act = el.dataset.bpAct;
    if (act === 'exit') return exit();
    if (act === 'back') return back();
    const g = activeGames().find(x => x.id === detail);
    if (!g) return;
    try {
      if (act === 'play' || act === 'install') {
        const o = providerOf(g);
        if (act === 'install' && wantsInstallWindow(g, o.provider)) return openInstallDialog(g.id);
        const r = await call('play', { id: g.id, provider: o.provider });
        state = r.state || r;
        toast(playToast(r.result));
      } else if (act === 'close') {
        const r = await call('closeGame', g.id);
        state = r.state || state;
      }
    } catch (e) {
      toast(e.message);
    }
    render();
    draw();
  }
  function back() {
    const dlg = $('#install-dialog');
    if (dlg?.open) return dlg.close();
    if (detail) {
      focusKey = `game:${detail}`;
      detail = null;
      return draw();
    }
    exit();
  }
  // ---- gamepad polling ------------------------------------------------------------
  const REPEAT_DELAY = 380,
    REPEAT_EVERY = 110;
  function pressed(key, isDown, fire, repeat = false) {
    const now = performance.now();
    const h = held.get(key);
    if (!isDown) return held.delete(key);
    if (!h) {
      held.set(key, { since: now, last: now });
      fire();
    } else if (repeat && now - h.since > REPEAT_DELAY && now - h.last > REPEAT_EVERY) {
      h.last = now;
      fire();
    }
  }
  function poll() {
    pollId = 0;
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    for (const gp of pads) {
      const b = i => !!gp.buttons[i]?.pressed;
      const ax = gp.axes[0] || 0,
        ay = gp.axes[1] || 0;
      // The Guide button opens the mode from anywhere in Nexus.
      pressed(`${gp.index}:guide`, b(16), () => (open ? exit() : enter()));
      if (!open) continue;
      pressed(`${gp.index}:up`, b(12) || ay < -0.6, () => move('up'), true);
      pressed(`${gp.index}:down`, b(13) || ay > 0.6, () => move('down'), true);
      pressed(`${gp.index}:left`, b(14) || ax < -0.6, () => move('left'), true);
      pressed(`${gp.index}:right`, b(15) || ax > 0.6, () => move('right'), true);
      pressed(`${gp.index}:a`, b(0), () => activate());
      pressed(`${gp.index}:b`, b(1), () => back());
      pressed(`${gp.index}:y`, b(3), () => jumpLetter());
      pressed(`${gp.index}:lb`, b(4), () => switchTab(-1));
      pressed(`${gp.index}:rb`, b(5), () => switchTab(1));
      pressed(`${gp.index}:start`, b(9), () => exit());
    }
    if (pads.length) pollId = requestAnimationFrame(poll);
  }
  function startPolling() {
    if (!pollId) pollId = requestAnimationFrame(poll);
  }
  window.addEventListener('gamepadconnected', () => {
    startPolling();
    if (!open) toast('Геймпад подключён — нажмите Guide или 🎮 для режима геймпада');
  });
  // ---- keyboard -------------------------------------------------------------------
  document.addEventListener(
    'keydown',
    e => {
      if (!open) return;
      const dlg = $('#install-dialog');
      if (dlg?.open && e.key !== 'Escape') return; // the dialog's own keys
      const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      if (map[e.key]) {
        e.preventDefault();
        move(map[e.key]);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      } else if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault();
        back();
      } else if (e.key === 'PageDown' || e.key === 'Tab') {
        e.preventDefault();
        switchTab(e.shiftKey ? -1 : 1);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        switchTab(-1);
      }
    },
    true
  );
  document.addEventListener(
    'click',
    e => {
      if (!open && e.target.closest('#bp-enter')) return enter();
      if (!open) return;
      const el = e.target.closest('[data-bp]');
      if (el && root()?.contains(el)) {
        e.preventDefault();
        e.stopPropagation();
        focus(el);
        activate(el);
      }
    },
    true
  );
  // ---- enter / exit -----------------------------------------------------------------
  function enter() {
    if (open) return;
    open = true;
    detail = null;
    if (!activeGames().some(g => g.offers.some(o => o.installed))) tab = 'all';
    document.body.classList.add('bp-on');
    if (api && !demo) call('bigPicture', true).catch(() => {});
    draw();
    startPolling();
  }
  function exit() {
    if (!open) return;
    open = false;
    document.body.classList.remove('bp-on');
    if (api && !demo) call('bigPicture', false).catch(() => {});
    draw();
  }
  startPolling();
  return {
    enter,
    exit,
    isOpen: () => open,
    // New state (progress, running games): the mode redraws itself.
    refresh: () => open && draw(),
  };
})();

// For app.js (top-level const is not a window property).
window.bigPicture = bigPicture;
