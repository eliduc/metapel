/*
 * MetapelStore — слой хранения поверх localStorage.
 * Один ключ 'metapel-app-v1': { settings, log, meta }.
 * log: { [occurrenceId]: {title, dueDate, amount, paidDate, paidAmount} }
 */
window.MetapelStore = (function () {
  'use strict';

  var KEY = 'metapel-app-v1';

  function loadRaw() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveRaw(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  // Объекты сливаются рекурсивно, массивы и примитивы заменяются целиком.
  function mergeDeep(base, over) {
    if (Array.isArray(base) || Array.isArray(over) ||
        typeof base !== 'object' || base === null ||
        typeof over !== 'object' || over === null) {
      return over === undefined ? base : over;
    }
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(over).forEach(function (k) {
      out[k] = mergeDeep(base[k], over[k]);
    });
    return out;
  }

  function loadSettings() {
    return mergeDeep(window.MetapelCalc.defaultSettings(), loadRaw().settings || {});
  }

  function saveSettings(settings) {
    var raw = loadRaw();
    raw.settings = settings;
    saveRaw(raw);
  }

  function resetSettings() {
    var raw = loadRaw();
    delete raw.settings;
    saveRaw(raw);
  }

  function loadLog() {
    return loadRaw().log || {};
  }

  function markPaid(id, record) {
    var raw = loadRaw();
    raw.log = raw.log || {};
    raw.log[id] = record;
    saveRaw(raw);
  }

  function unmarkPaid(id) {
    var raw = loadRaw();
    if (raw.log) {
      delete raw.log[id];
      saveRaw(raw);
    }
  }

  function getMeta(k) {
    return (loadRaw().meta || {})[k];
  }

  function setMeta(k, v) {
    var raw = loadRaw();
    raw.meta = raw.meta || {};
    raw.meta[k] = v;
    saveRaw(raw);
  }

  return {
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    resetSettings: resetSettings,
    loadLog: loadLog,
    markPaid: markPaid,
    unmarkPaid: unmarkPaid,
    getMeta: getMeta,
    setMeta: setMeta
  };
})();
