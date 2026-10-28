// Minimal Electron replacement for main-process tests. Network access goes
// through `routes` (set by each test); nothing leaves the machine.
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stub-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const handlers = new Map();
const windows = [];
const requests = [];
const opened = [];
let routes = [];
let online = true;
const dialogs = { save: null, open: null, errors: [] };

const response = (u, status, body, type = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  url: u,
  headers: { get: h => (/content-type/i.test(h) ? type : null) },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  body: null,
});
async function fetchImpl(url, options = {}) {
  const u = String(url);
  requests.push({ url: u, options });
  if (!online) throw Error('net::ERR_INTERNET_DISCONNECTED');
  for (const [test, reply] of routes) {
    if (typeof test === 'string' ? u.includes(test) : test.test(u)) {
      const r = await reply(u, options);
      if (r && typeof r === 'object' && 'status' in r && 'body' in r)
        return response(r.url || u, r.status, r.body, r.type);
      return response(u, 200, r);
    }
  }
  return response(u, 404, '', 'text/plain');
}

class Session extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.jar = [];
    this.cleared = 0;
    this.cookies = Object.assign(new EventEmitter(), {
      // Tests may add cookies for a partition, e.g. a Steam sign-in.
      get: async () => [...this.jar, ...(globalThis.__stubCookies?.(this.name) || [])],
      set: async c => this.jar.push(c),
    });
  }
  fetch(url, options) {
    return fetchImpl(url, { ...options, partition: this.name });
  }
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
  async clearStorageData() {
    this.jar = [];
    this.cleared++;
  }
  async clearCache() {}
}
const sessions = new Map();

class WebContents extends EventEmitter {
  constructor(win) {
    super();
    this.win = win;
    this.url = 'about:blank';
    this.sent = [];
    this.scriptResult = null;
  }
  setWindowOpenHandler() {}
  setAudioMuted() {}
  getURL() {
    return this.url;
  }
  send(channel, value) {
    this.sent.push([channel, value]);
  }
  async executeJavaScript() {
    return typeof this.scriptResult === 'function' ? this.scriptResult(this.url) : this.scriptResult;
  }
}
class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new WebContents(this);
    this.destroyed = false;
    windows.push(this);
  }
  removeMenu() {}
  show() {}
  focus() {}
  isMinimized() {
    return false;
  }
  restore() {}
  setTitle() {}
  async loadURL(u) {
    this.webContents.url = u;
    this.webContents.emit('did-finish-load');
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
}

const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  requestSingleInstanceLock: () => true,
  setAppUserModelId() {},
  getPath: () => dir,
  getVersion: () => '0.10.0-test',
  quit() {},
  exit(code) {
    app.exitCode = code;
  },
  relaunch() {
    app.relaunched = true;
  },
  whenReady: () => new Promise(r => setImmediate(r)),
  setLoginItemSettings() {},
  getFileIcon: async () => ({ toDataURL: () => 'data:image/png;base64,AA' }),
});

module.exports = {
  app,
  BrowserWindow,
  Menu: { setApplicationMenu() {} },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  dialog: {
    showErrorBox: (title, text) => dialogs.errors.push(title + ': ' + text),
    showMessageBox: async () => ({ response: 0 }),
    showOpenDialog: async () =>
      dialogs.open ? { canceled: false, filePaths: [dialogs.open] } : { canceled: true, filePaths: [] },
    showSaveDialog: async () =>
      dialogs.save ? { canceled: false, filePath: dialogs.save } : { canceled: true },
  },
  shell: {
    openExternal: async u => opened.push(u),
    openPath: async () => '',
  },
  session: {
    fromPartition: name => {
      if (!sessions.has(name)) sessions.set(name, new Session(name));
      return sessions.get(name);
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: s => Buffer.from('enc:' + s),
    decryptString: b => b.toString().slice(4),
  },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  net: { fetch: fetchImpl, isOnline: () => online },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
  contextBridge: {},
  ipcRenderer: {},
  __test: {
    dir,
    handlers,
    windows,
    requests,
    opened,
    sessions,
    setRoutes: r => (routes = r),
    setOnline: v => (online = v),
    dialogs,
  },
};
