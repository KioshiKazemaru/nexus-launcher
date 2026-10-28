'use strict';
// Sends state to the window. Many background tasks change state at once
// (library sync, metadata, prices); publishing is coalesced into one message
// per frame-ish interval instead of one per change.

// build(full): full = true for IPC replies, false for pushed updates, which
// may omit large sections that did not change (see Sections).
class StateHub {
  constructor(build, send, delay = 120, onError = () => {}) {
    this.build = build;
    this.send = send;
    this.delay = delay;
    this.onError = onError;
    this.timer = null;
    this.version = 0;
  }
  publish() {
    this.version++;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.send(this.build(false));
      } catch (e) {
        this.onError(e);
      }
    }, this.delay);
  }
  // Complete state (first load of the window).
  now() {
    clearTimeout(this.timer);
    this.timer = null;
    return this.build(true);
  }
  // Reply to an action: like a pushed update, unchanged large sections are
  // omitted; the window merges it into its current state.
  reply() {
    clearTimeout(this.timer);
    this.timer = null;
    return this.build(false);
  }
}

// Large parts of the state (game list, catalog) are sent again only when
// their version key changed since the last message.
class Sections {
  constructor() {
    this.sent = new Map();
  }
  pick(name, key, produce, full) {
    if (!full && this.sent.get(name) === key) return undefined;
    this.sent.set(name, key);
    return produce();
  }
}

// Small bounded map (least recently set entries are evicted first).
class LruMap extends Map {
  constructor(limit, onSet = () => {}) {
    super();
    this.limit = limit;
    this.onSet = onSet;
    this.version = 0; // bumped on every change; used to skip unchanged state
  }
  set(key, value) {
    this.version++;
    this.onSet(key);
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    while (this.size > this.limit) this.delete(this.keys().next().value);
    return this;
  }
}

module.exports = { StateHub, Sections, LruMap };
