'use strict';
// Like the Steam client: friends and chat windows, profiles and comments, my status,
// the activity feed, notification and tray switches, and the in-game overlay.
const { setAutoStart } = require('../autostart.cjs');
const { HOTKEYS } = require('../overlay.cjs');
const { libraryList } = require('../../profile.cjs');
const { ACTIVITY_DAYS } = require('../../presence.cjs');
const { bool, wrappers } = require('./helpers.cjs');

// Notifications, tray and overlay switches.
const PRESENCE_SETTINGS = [
  'showPlaying',
  'notifyFriendOnline',
  'notifyFriendGame',
  'notifyAchievements',
  'closeToTray',
  'startHidden',
  'overlay',
  'activityRecord',
  'activityOnline',
  'activityGame',
  'activityStop',
];

function registerSocialIpc(register, ctx) {
  const { settings } = ctx;
  const { save } = wrappers(ctx);
  // Windows of their own: the friends list, chat and the overlay.
  const socialOnly = { social: true, mainWindow: false };

  // Friends of the connected Steam and Epic accounts (with Steam status).
  register('friends', p => ctx.friends.list({ force: p?.force === true }), {
    quiet: true,
    social: true,
    overlay: true,
  });
  // "Друзья и чат" as their own windows; chat with Steam and Epic friends.
  register('openFriendsWindow', () => ctx.social.openFriends());
  register('openChat', conv => ctx.social.openChat(String(conv || '')), { social: true });
  register('socialInfo', () => ctx.friends.me(), { social: true, quiet: true });
  register('chatTabs', () => ctx.social.takePending().map(k => ctx.social.friendInfo(k)), socialOnly);
  register('friendInfo', conv => ctx.social.friendInfo(String(conv || '')), { ...socialOnly, quiet: true });
  register('chatMessages', conv => ctx.chat.messages(String(conv || '')), { ...socialOnly, quiet: true });
  register(
    'chatSend',
    p => {
      if (typeof p?.text !== 'string' || p.text.length > 4000) throw Error('Слишком длинное сообщение');
      return ctx.chat.send(String(p.conv || ''), p.text);
    },
    socialOnly
  );
  register(
    'chatViewing',
    list => ctx.chat.setViewing(Array.isArray(list) ? list.slice(0, 50).map(String) : []),
    { ...socialOnly, quiet: true }
  );
  register('focusMain', () => ctx.focusMain(), socialOnly);
  register(
    'openProfile',
    ({ provider, id } = {}) => {
      if (provider !== 'steam' || !/^7656119\d{10}$/.test(String(id))) throw Error('Профиль недоступен');
      // The profile page inside Nexus (the main window), not the browser.
      ctx.showFriend(String(id));
      return true;
    },
    { social: true }
  );

  // Profiles: a friend's, its badges, mine and its game lists.
  register('friendProfile', id => ctx.friends.profile(id), { quiet: true });
  register('profileBadges', id => ctx.friends.badges(id), { quiet: true });
  register('profile', p => ctx.profile.info({ force: p?.force === true }), { quiet: true });
  // My profile: the games behind «Игр в библиотеке», «Установлено», «Запускались».
  register(
    'profileGames',
    ({ kind, source } = {}) =>
      libraryList(
        ctx.library.games || [],
        ['owned', 'family', 'installed', 'played'].includes(kind) ? kind : 'owned',
        ['steam', 'epic'].includes(source) ? source : 'all'
      ),
    { quiet: true }
  );
  register('gameFriends', appId => ctx.friends.gameFriends(appId), { quiet: true });
  // Comments under a Steam profile: read, post (the user's own text), delete.
  register('profileComments', p => ctx.friends.comments(p?.id, p?.start), { quiet: true });
  register('postProfileComment', p => ctx.friends.postComment(p?.id, p?.text));
  register('deleteProfileComment', p => ctx.friends.deleteComment(p?.id, p?.commentId));

  // My status and the friends' activity.
  register('setStatus', s => ctx.presence.setStatus(s), { social: true });
  register('activity', () => ctx.presence.feed(), { quiet: true, social: true });
  register('clearActivity', () => ctx.presence.clearActivity(), { social: true });
  register(
    'presenceSetting',
    save(({ name, value }) => {
      if (name === 'activityDays') {
        if (!ACTIVITY_DAYS.includes(Number(value))) throw Error('Неизвестный срок');
        settings.activityDays = Number(value);
      } else if (name === 'overlayHotkey') {
        if (!HOTKEYS.includes(value)) throw Error('Неизвестное сочетание клавиш');
        settings.overlayHotkey = value;
      } else {
        if (!PRESENCE_SETTINGS.includes(name)) throw Error('Неизвестная настройка');
        settings[name] = bool(value);
      }
      if (name === 'showPlaying') ctx.presence.applyAll();
      if (name === 'startHidden' && settings.autoStart) setAutoStart(true, bool(value));
      ctx.overlay.reconfigure();
    })
  );

  // The overlay window.
  const overlayOnly = { overlay: true, mainWindow: false };
  register('overlayInfo', () => ctx.overlay.info(), overlayOnly);
  register('overlayHide', () => ctx.overlay.hide(), overlayOnly);
  register('overlayFps', on => ctx.overlay.setFps(on === true), overlayOnly);
  register('overlayChat', conv => ctx.overlay.openChat(String(conv || '')), overlayOnly);
}

module.exports = { registerSocialIpc, PRESENCE_SETTINGS };
