// Loaded with `node --require`: makes require('electron') return the test stub,
// so main-process services run in plain Node without a window.
const Module = require('node:module');
const path = require('node:path');
const stub = path.join(__dirname, 'electron-stub.cjs');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return stub;
  return resolve.call(this, request, ...rest);
};
