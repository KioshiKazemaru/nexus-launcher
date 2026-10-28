function interruptedLibrary(state, profile) {
  if (state?.status !== 'loading' || profile?.status !== 'unavailable' || state.accountId !== profile.id)
    return state;
  return {
    ...state,
    status: 'error',
    message: profile.message || 'Проверка входа недоступна. Повторите синхронизацию.',
  };
}
function shouldAttemptLibrary(state, accountId, force = false, now = Date.now()) {
  if (force || state?.accountId !== accountId) return true;
  if (['ready', 'loading'].includes(state.status)) return false;
  return state.status !== 'error' || now - (state.attemptedAt || 0) >= 900000;
}
module.exports = { interruptedLibrary, shouldAttemptLibrary };
