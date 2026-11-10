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
// The scenarios describe Windows (its clients, folders and installers) and run
// on any system: Nexus takes Windows behaviour here. macOS and Linux are tested
// through the functions that take the system as a parameter (test/os.test.cjs).
process.env.NEXUS_PLATFORM ||= 'win32';
