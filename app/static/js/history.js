/* history.js — prediction history in localStorage.

   Each entry keeps the full input state alongside the result, so loading one
   restores the form exactly as it was rather than approximately. Editing a
   loaded entry and predicting again appends a new entry; nothing is ever
   rewritten in place, because the point of a history is to be able to compare
   two attempts rather than to watch the first one disappear. */
(function (global) {
  'use strict';

  const KEY = 'csp.predictions.v1';
  const LIMIT = 60;      // enough to be useful, small enough to stay quick

  function read() {
    let raw;
    try {
      raw = global.localStorage.getItem(KEY);
    } catch (e) {
      return [];         // private browsing, or storage disabled
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];         // corrupt entry: start clean rather than throw
    }
  }

  function write(entries) {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(entries));
      return true;
    } catch (e) {
      return false;      // quota or disabled; the page still works
    }
  }

  const History = {
    available: function () {
      try {
        const k = KEY + '.probe';
        global.localStorage.setItem(k, '1');
        global.localStorage.removeItem(k);
        return true;
      } catch (e) {
        return false;
      }
    },

    all: function () { return read(); },

    add: function (state, result) {
      const entries = read();
      entries.unshift({
        // Date.now alone collides when two predictions land in the same
        // millisecond, which happens when replaying history entries quickly.
        id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
        at: new Date().toISOString(),
        state: state,
        result: result
      });
      write(entries.slice(0, LIMIT));
      return entries[0];
    },

    remove: function (id) {
      write(read().filter(function (e) { return e.id !== id; }));
    },

    clear: function () { write([]); },

    get: function (id) {
      return read().find(function (e) { return e.id === id; }) || null;
    }
  };

  global.History = History;
})(window);
