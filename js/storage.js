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

  // ---------- дополнительные платежи (подарок / под отчёт) ----------

  function loadExtras() {
    return loadRaw().extras || [];
  }

  function addExtra(rec) {
    var raw = loadRaw();
    raw.extras = (raw.extras || []).concat([rec]);
    saveRaw(raw);
  }

  function updateExtra(id, rec) {
    var raw = loadRaw();
    raw.extras = (raw.extras || []).map(function (e) { return e.id === id ? rec : e; });
    saveRaw(raw);
  }

  function deleteExtra(id) {
    var raw = loadRaw();
    raw.extras = (raw.extras || []).filter(function (e) { return e.id !== id; });
    saveRaw(raw);
  }

  // ---------- возвраты по отчёту (чеки / сдача) ----------

  function loadReturns() {
    return loadRaw().returns || [];
  }

  function addReturn(rec) {
    var raw = loadRaw();
    raw.returns = (raw.returns || []).concat([rec]);
    saveRaw(raw);
  }

  function deleteReturn(id) {
    var raw = loadRaw();
    raw.returns = (raw.returns || []).filter(function (e) { return e.id !== id; });
    saveRaw(raw);
  }

  // ---------- очередь отправки расписок в архив GitHub ----------

  function loadSyncQueue() {
    return loadRaw().syncQueue || [];
  }

  function pushSync(item) {
    var raw = loadRaw();
    raw.syncQueue = (raw.syncQueue || []).filter(function (q) { return q.path !== item.path; });
    raw.syncQueue.push(item);
    saveRaw(raw);
  }

  function removeSync(path) {
    var raw = loadRaw();
    raw.syncQueue = (raw.syncQueue || []).filter(function (q) { return q.path !== path; });
    saveRaw(raw);
  }

  // пометить запись как сохранённую в архиве
  function markSynced(targetType, id) {
    var raw = loadRaw();
    if (targetType === 'log' && raw.log && raw.log[id]) {
      raw.log[id].synced = true;
    } else if (targetType === 'extra' && raw.extras) {
      raw.extras = raw.extras.map(function (e) {
        if (e.id === id) e.synced = true;
        return e;
      });
    }
    saveRaw(raw);
  }

  return {
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    resetSettings: resetSettings,
    loadLog: loadLog,
    markPaid: markPaid,
    unmarkPaid: unmarkPaid,
    loadExtras: loadExtras,
    addExtra: addExtra,
    updateExtra: updateExtra,
    deleteExtra: deleteExtra,
    loadReturns: loadReturns,
    addReturn: addReturn,
    deleteReturn: deleteReturn,
    loadSyncQueue: loadSyncQueue,
    pushSync: pushSync,
    removeSync: removeSync,
    markSynced: markSynced,
    getMeta: getMeta,
    setMeta: setMeta
  };
})();
