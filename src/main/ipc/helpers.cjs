'use strict';
// Checks of IPC arguments and wrappers shared by the channel groups in this folder.

const isProvider = p => p === 'steam' || p === 'epic';
const isAccountKey = k => typeof k === 'string' && /^(steam:\d{1,2}|epic:[a-f0-9]{32}|steam|epic)$/i.test(k);
const optionalAccount = k => {
  if (k !== undefined && k !== null && !isAccountKey(k)) throw Error('Неизвестный аккаунт');
  return k || undefined;
};
const bool = (v, name = 'значение') => {
  if (typeof v !== 'boolean') throw Error('Некорректное ' + name);
  return v;
};
const gameId = v => {
  if (typeof v !== 'string' || v.length > 300) throw Error('Некорректная игра');
  return v;
};

// withState: the reply is the new window state.
// save: the same, after the settings are written to disk.
function wrappers(ctx) {
  const withState =
    fn =>
    async (...args) => {
      await fn(...args);
      return ctx.hub.reply();
    };
  const save = fn =>
    withState(async (...a) => {
      await fn(...a);
      ctx.storage.saveSettings();
    });
  return { withState, save };
}

module.exports = { isProvider, isAccountKey, optionalAccount, bool, gameId, wrappers };
