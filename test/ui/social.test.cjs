// The friends window and the chat window (ui/friends.html, ui/chat.html) with
// a mocked social API. Run with `npm run test:ui`; skipped without Playwright.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path'),
  { pathToFileURL } = require('node:url');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {}
const url = name => pathToFileURL(path.join(__dirname, '../../ui', name)).href;

const ME = '76561198000000010';
const conv = id => `steam|${ME}|${id}`;
const EPIC = 'e'.repeat(32);
const epicConv = `epic|${'a'.repeat(32)}|${EPIC}`;

function mockSocial() {
  const calls = [];
  window.__calls = calls;
  const friend = (id, name, status, game = '', unread = 0) => ({
    id,
    name,
    status,
    game,
    avatar: '',
    conv: `steam|76561198000000010|${id}`,
    unread,
  });
  const friends = {
    steam: [
      {
        account: { key: 'steam:0', id: '76561198000000010', name: 'SteamPlayer' },
        friends: [
          friend('76561198000000001', 'Alpha', 'ingame', 'Dota 2', 2),
          friend('76561198000000002', 'Beta', 'online'),
          friend('76561198000000003', 'Gamma', 'offline'),
        ],
      },
    ],
    epic: [
      {
        account: { key: 'epic:a', id: 'a'.repeat(32), name: 'EpicPlayer' },
        friends: [
          {
            id: 'e'.repeat(32),
            name: 'EpicPal',
            status: 'online',
            game: '',
            avatar: '',
            conv: `epic|${'a'.repeat(32)}|${'e'.repeat(32)}`,
            unread: 0,
          },
        ],
      },
    ],
    errors: [],
    epicLive: true,
    me: [
      { provider: 'steam', name: 'SteamPlayer', avatar: '', playing: 'Hades' },
      { provider: 'epic', name: 'EpicPlayer', avatar: '', playing: '' },
    ],
    unread: {},
    checkedAt: Date.now(),
  };
  const history = {
    'steam|76561198000000010|76561198000000001': [
      { from: 'them', text: 'привет', at: Date.now() - 120000 },
      { from: 'me', text: 'здорово', at: Date.now() - 60000 },
    ],
  };
  const info = c => {
    const all = [...friends.steam[0].friends, ...friends.epic[0].friends];
    const f = all.find(x => x.conv === c);
    return { ...f, provider: c.split('|')[0] };
  };
  let listener = null;
  window.__emit = ev => listener?.(ev);
  window.nexus = {
    onSocialEvent: cb => (listener = cb),
    friends: async p => (calls.push(['friends', p]), friends),
    openChat: async c => (calls.push(['openChat', c]), true),
    openProfile: async p => (calls.push(['openProfile', p]), true),
    chatTabs: async () => (calls.push(['chatTabs']), [info('steam|76561198000000010|76561198000000001')]),
    friendInfo: async c => info(c),
    chatMessages: async c => ({
      messages: history[c] || [],
      warning: c.startsWith('epic') ? 'Epic Games не даёт писать друзьям из сторонних программ' : '',
      readonly: c.startsWith('epic'),
      state: 'online',
    }),
    chatSend: async p => {
      calls.push(['chatSend', p]);
      if (p.text === 'fail') throw Error('Steam: HTTP 500');
      return { from: 'me', text: p.text, at: Date.now() };
    },
    chatViewing: async list => calls.push(['chatViewing', list]),
    focusMain: async () => {},
  };
}

test(
  'friends window: me in game on top, groups like Steam, unread badge, click opens the chat',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 330, height: 760 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockSocial);
      await p.goto(url('friends.html'));
      await p.waitForSelector('.friend');
      const me = p.locator('.me-row').first();
      assert.match(await me.getAttribute('class'), /ingame/);
      assert.match(await me.textContent(), /В игре: Hades/);
      const text = await p.locator('#list').textContent();
      assert.match(text, /В игре \(1\)/);
      assert.match(text, /В игре: Dota 2/);
      assert.match(text, /В сети \(1\)/);
      assert.match(text, /Не в сети \(1\)/);
      assert.match(text, /Epic Games · в сети \(1\)/);
      // "Не в сети" starts collapsed, like Steam.
      assert.equal(await p.locator('.friend', { hasText: 'Gamma' }).count(), 0);
      await p.click('[data-group="offline"]');
      assert.equal(await p.locator('.friend', { hasText: 'Gamma' }).count(), 1);
      assert.equal(await p.locator('.friend', { hasText: 'Alpha' }).locator('.unread').textContent(), '2');
      // Search.
      await p.fill('#search', 'bet');
      assert.deepEqual(await p.locator('.friend strong').allTextContents(), ['Beta']);
      await p.fill('#search', '');
      // A click opens the chat; the profile button opens Steam Community.
      await p.click('.friend:has-text("Alpha") .friend-open');
      await p.hover('.friend:has-text("Beta")');
      await p.click('.friend:has-text("Beta") .profile');
      const calls = await p.evaluate(() => window.__calls.filter(c => c[0] !== 'friends'));
      assert.deepEqual(calls, [
        ['openChat', conv('76561198000000001')],
        ['openProfile', { provider: 'steam', id: '76561198000000002' }],
      ]);
      // Epic does not deliver messages from other programs: no chat for Epic friends.
      assert.match(
        await p.locator('.friend:has-text("EpicPal") .friend-open').getAttribute('title'),
        /не даёт писать/
      );
      // Live: an Epic friend starts playing; a new unread message.
      await p.evaluate(
        e =>
          window.__emit({
            type: 'presence',
            provider: 'epic',
            friendId: e,
            status: 'ingame',
            game: 'Fortnite',
          }),
        EPIC
      );
      assert.match(await p.locator('.friend', { hasText: 'EpicPal' }).textContent(), /В игре: Fortnite/);
      await p.evaluate(c => window.__emit({ type: 'unread', unread: { [c]: 5 } }), conv('76561198000000002'));
      assert.equal(await p.locator('.friend', { hasText: 'Beta' }).locator('.unread').textContent(), '5');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  'chat window: tabs, history, sending with Enter, incoming messages, errors',
  { skip: !chromium && 'playwright is not installed' },
  async () => {
    const browser = await chromium.launch();
    try {
      const p = await browser.newPage({ viewport: { width: 760, height: 580 } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.addInitScript(mockSocial);
      await p.goto(url('chat.html'));
      await p.waitForSelector('.msg');
      assert.match(await p.locator('.chat-head').textContent(), /Alpha.*В игре: Dota 2/);
      assert.deepEqual(await p.locator('.msg p').allTextContents(), ['привет', 'здорово']);
      assert.match(await p.locator('.messages').textContent(), /Сегодня/);
      // Enter sends; Shift+Enter is a new line.
      await p.fill('#input', 'как ты?');
      await p.press('#input', 'Shift+Enter');
      await p.type('#input', 'играем?');
      await p.press('#input', 'Enter');
      await p.waitForFunction(() => document.querySelectorAll('.msg').length === 3);
      const sent = await p.evaluate(() => window.__calls.filter(c => c[0] === 'chatSend').map(c => c[1]));
      assert.deepEqual(sent, [{ conv: conv('76561198000000001'), text: 'как ты?\nиграем?' }]);
      assert.equal(await p.inputValue('#input'), '');
      // A failed message stays in the input with the reason.
      await p.fill('#input', 'fail');
      await p.press('#input', 'Enter');
      await p.waitForSelector('#chat-error:not([hidden])');
      assert.match(await p.locator('#chat-error').textContent(), /Не отправлено: Steam: HTTP 500/);
      assert.equal(await p.inputValue('#input'), 'fail');
      // Typing is not interrupted by an incoming message.
      await p.fill('#input', 'черновик');
      await p.evaluate(
        c =>
          window.__emit({ type: 'message', conv: c, message: { from: 'them', text: 'го', at: Date.now() } }),
        conv('76561198000000001')
      );
      assert.equal(await p.locator('.msg p').last().textContent(), 'го');
      assert.equal(await p.inputValue('#input'), 'черновик');
      // A message from someone else opens a tab with an unread mark.
      await p.evaluate(
        c =>
          window.__emit({ type: 'message', conv: c, message: { from: 'them', text: 'hi', at: Date.now() } }),
        conv('76561198000000002')
      );
      const beta = p.locator('.tab', { hasText: 'Beta' });
      await beta.waitFor();
      assert.equal(await beta.locator('.unread').textContent(), '1');
      await beta.locator('.tab-open').click();
      await p.waitForFunction(() => /Beta/.test(document.querySelector('.chat-head')?.textContent || ''));
      assert.equal(await beta.locator('.unread').count(), 0);
      // "open" from the friends window: Epic tab with its note about local history.
      await p.evaluate(c => window.__emit({ type: 'open', conv: c }), epicConv);
      await p.waitForFunction(() => /EpicPal/.test(document.querySelector('.chat-head')?.textContent || ''));
      await p.waitForSelector('#chat-note:not([hidden])');
      assert.match(await p.locator('#chat-note').textContent(), /не даёт писать/);
      assert.equal(await p.locator('#input').isDisabled(), true);
      assert.equal(await p.locator('#send').isDisabled(), true);
      assert.equal(await p.locator('.tab').count(), 3);
      await p.locator('.tab', { hasText: 'EpicPal' }).locator('.tab-close').click();
      assert.equal(await p.locator('.tab').count(), 2);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);
