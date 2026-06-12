/*
 * MetapelSync — архив расписок в приватном репозитории GitHub.
 * Каждая подписанная расписка сохраняется файлом receipts/<id>.json
 * через GitHub Contents API. Очередь хранится локально и досылается
 * при каждом открытии приложения (работает и после перерывов в сети).
 * Токен (fine-grained PAT с правом Contents: Read/Write только на
 * репозиторий данных) вводится в настройках и хранится локально.
 */
window.MetapelSync = (function () {
  'use strict';

  function conf(settings) { return settings.sync || {}; }

  function isOn(settings) {
    var c = conf(settings);
    return !!(c.enabled && c.repo && c.token);
  }

  // base64 для строк с юникодом
  function b64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function receiptPath(id) {
    return 'receipts/' + id + '.json';
  }

  // полные данные расписки для архива
  function buildReceipt(kind, rec, settings) {
    return {
      id: rec.id || null,
      kind: kind, // salary/pocket/... | gift | advance
      title: rec.title,
      amount: rec.paidAmount != null ? rec.paidAmount : rec.amount,
      currency: 'ILS',
      paidDate: rec.paidDate || rec.date,
      signedDate: rec.signedDate,
      method: rec.method,
      worker: settings.workerFullName || settings.workerName,
      employer: settings.employerName,
      note: rec.note || null,
      signature: rec.signature // PNG dataURL
    };
  }

  function headers(c) {
    return {
      'Authorization': 'Bearer ' + c.token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
  }

  function putFile(c, path, jsonStr, message) {
    var url = 'https://api.github.com/repos/' + c.repo + '/contents/' + path;
    // если файл уже есть (переподпись) — нужен его sha
    return fetch(url, { headers: headers(c) }).then(function (g) {
      if (g.status === 200) return g.json().then(function (j) { return j.sha; });
      return null;
    }).then(function (sha) {
      var body = { message: message, content: b64(jsonStr) };
      if (sha) body.sha = sha;
      return fetch(url, {
        method: 'PUT',
        headers: headers(c),
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('GitHub ' + r.status + ': ' + t.slice(0, 200));
        });
      }
      return true;
    });
  }

  /**
   * Ставит расписку в очередь отправки.
   * targetType: 'log' | 'extra'; kind — тип платежа для архива.
   */
  function enqueue(store, targetType, id, kind, rec, settings) {
    store.pushSync({
      path: receiptPath(id),
      targetType: targetType,
      id: id,
      json: JSON.stringify(buildReceipt(kind, rec, settings), null, 2)
    });
  }

  /**
   * Отправляет всё из очереди по порядку. При первой ошибке
   * останавливается (доотправит при следующем запуске).
   * onItemDone(item) вызывается после успешной отправки каждого файла.
   */
  function processQueue(settings, store, onItemDone) {
    if (!isOn(settings)) return Promise.resolve(0);
    var c = conf(settings);
    var queue = store.loadSyncQueue();
    var sent = 0;
    var chain = Promise.resolve();
    queue.forEach(function (item) {
      chain = chain.then(function () {
        return putFile(c, item.path, item.json, 'Receipt: ' + item.id).then(function () {
          store.removeSync(item.path);
          store.markSynced(item.targetType, item.id);
          store.setMeta('lastSyncError', null);
          sent++;
          if (onItemDone) onItemDone(item);
        });
      });
    });
    return chain.then(function () { return sent; }).catch(function (e) {
      store.setMeta('lastSyncError', String(e && e.message || e));
      return sent;
    });
  }

  return {
    isOn: isOn,
    enqueue: enqueue,
    processQueue: processQueue
  };
})();
