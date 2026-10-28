'use strict';
// A crash in the main process leaves services in an unknown state: log it,
// save settings, tell the user and restart once. A crash within the first
// 30 seconds (or right after an automatic restart) quits instead of looping.
const { redact } = require('./log.cjs');

function createCrashHandler({
  app,
  dialog,
  log,
  flush,
  env = process.env,
  now = Date.now,
  startedAt = now(),
  onQuit = () => {},
}) {
  let crashed = false;
  return error => {
    log.error('process', 'uncaught', error);
    if (crashed) return;
    crashed = true;
    onQuit();
    try {
      flush();
    } catch {}
    log.flush();
    const restart = now() - startedAt > 30000 && env.NEXUS_RELAUNCHED !== '1';
    try {
      dialog.showErrorBox(
        'Nexus: внутренняя ошибка',
        `${redact(error?.message || String(error)).slice(0, 500)}\n\n${restart ? 'Nexus перезапустится.' : 'Nexus будет закрыт.'} Подробности — в журнале: Аккаунты → «Открыть папку журналов».`
      );
    } catch {}
    if (restart) {
      env.NEXUS_RELAUNCHED = '1';
      app.relaunch();
    }
    app.exit(1);
  };
}

module.exports = { createCrashHandler };
