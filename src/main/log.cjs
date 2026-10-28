'use strict';
// Rotating log file (%APPDATA%\Nexus Launcher\logs\nexus.log, 3 × 2 MB).
// Secrets are masked before anything is written: tokens, API keys,
// authorization codes and cookie values never reach the disk.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 3;

function redact(text) {
  return (
    String(text)
      .replace(
        /((?:access_token|refresh_token|webapi_token|token|key|client_secret|password)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
        '$1[скрыто]'
      )
      // Authorization codes are long hex strings; short values such as "exit code: 1" stay readable.
      .replace(/((?:authorizationCode|code)["']?\s*[:=]\s*["']?)[A-Za-z0-9]{16,}/gi, '$1[скрыто]')
      .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [скрыто]')
      .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[скрыт JWT]')
      .replace(/\/sessions\/kill\/[^\s"']+/g, '/sessions/kill/[скрыто]')
  );
}

class Log {
  constructor(dir, { console: echo = false } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'nexus.log');
    this.echo = echo;
    this.buffer = [];
    this.timer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
  write(level, scope, message, extra) {
    const detail =
      extra instanceof Error
        ? extra.stack || extra.message
        : extra === undefined
          ? ''
          : JSON.stringify(extra);
    const line = redact(
      `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${detail ? ' ' + detail : ''}`
    )
      .replace(/\r?\n/g, ' ⏎ ')
      .slice(0, 4000);
    if (this.echo) console.log(line);
    this.buffer.push(line);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 500);
    this.timer.unref?.();
  }
  debug(scope, message, extra) {
    this.write('debug', scope, message, extra);
  }
  info(scope, message, extra) {
    this.write('info', scope, message, extra);
  }
  warn(scope, message, extra) {
    this.write('warn', scope, message, extra);
  }
  error(scope, message, extra) {
    this.write('error', scope, message, extra);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer.length) return;
    const text = this.buffer.join('\n') + '\n';
    this.buffer = [];
    try {
      this.rotate(Buffer.byteLength(text));
      fs.appendFileSync(this.file, text, { mode: 0o600 });
    } catch {}
  }
  rotate(incoming) {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size + incoming <= MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      try {
        fs.renameSync(from, `${this.file}.${i}`);
      } catch {}
    }
  }
  // Last lines of the current and previous log file.
  tail(lines = 500) {
    this.flush();
    const read = f => {
      try {
        return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    return [...read(`${this.file}.1`), ...read(this.file)].slice(-lines);
  }
}

module.exports = { Log, redact };
