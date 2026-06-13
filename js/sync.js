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
      employer: settings.employerFullName || settings.employerName,
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
    return chain.then(function () {
      // очередь успешно опустела — старые ошибки больше не актуальны
      store.setMeta('lastSyncError', null);
      return sent;
    }).catch(function (e) {
      store.setMeta('lastSyncError', String(e && e.message || e));
      return sent;
    });
  }

  // ---------- резервная копия всех данных ----------

  // Картинки подписей (PNG dataURL, десятки КБ каждая) в общий бэкап НЕ кладём:
  // сами подписи уже лежат отдельными файлами receipts/<id>.json. Иначе бэкап
  // раздувается >1 МБ, и GitHub Contents API не отдаёт его на чтение (content:"").
  // Вместо подписи оставляем флаг signatureArchived — статус «расписка получена ✓»
  // при восстановлении сохраняется.
  function lightenRecord(r) {
    var c = JSON.parse(JSON.stringify(r));
    // PNG выбрасываем ТОЛЬКО если расписка уже в архиве (synced) — её файл
    // receipts/<id>.json на GitHub существует. Не отправленную подпись
    // выбрасывать нельзя: она пропадёт при восстановлении (файла ещё нет)
    if (c.signature && c.synced) { c.signature = null; c.signatureArchived = true; }
    return c;
  }

  function buildBackupJson(settings, store) {
    var cleanSettings = JSON.parse(JSON.stringify(settings));
    if (cleanSettings.sync) cleanSettings.sync.token = ''; // токен не покидает устройство
    var log = store.loadLog();
    var lightLog = {};
    Object.keys(log).forEach(function (id) { lightLog[id] = lightenRecord(log[id]); });
    return JSON.stringify({
      kind: 'metapel-backup',
      settings: cleanSettings,
      log: lightLog,
      extras: store.loadExtras().map(lightenRecord),
      returns: store.loadReturns()
    }, null, 2);
  }

  // загружает backup/data.json в архив, если данные изменились
  function backupIfChanged(settings, store, hashFn) {
    if (!isOn(settings)) return Promise.resolve(false);
    var json = buildBackupJson(settings, store);
    var h = hashFn(json);
    if (store.getMeta('lastBackupHash') === h) return Promise.resolve(false);
    return putFile(conf(settings), 'backup/data.json', json, 'Data backup').then(function () {
      store.setMeta('lastBackupHash', h);
      return true;
    }).catch(function (e) {
      store.setMeta('lastSyncError', String(e && e.message || e));
      return false;
    });
  }

  function fetchBackup(settings) {
    var c = conf(settings);
    var url = 'https://api.github.com/repos/' + c.repo + '/contents/backup/data.json';
    return fetch(url, { headers: headers(c) }).then(function (r) {
      if (r.status === 404) throw new Error('Резервной копии в архиве ещё нет.');
      if (!r.ok) throw new Error('GitHub ' + r.status);
      return r.json();
    }).then(function (j) {
      var content = String(j.content || '').replace(/\s/g, '');
      if (content) {
        return JSON.parse(decodeURIComponent(escape(atob(content))));
      }
      // файл >1 МБ: Contents API не вернул содержимое — тянем сырой по ссылке
      // (на случай старых «тяжёлых» бэкапов, сделанных до облегчения)
      if (j.download_url) {
        return fetch(j.download_url).then(function (raw) {
          if (!raw.ok) throw new Error('GitHub ' + raw.status);
          return raw.json();
        });
      }
      throw new Error('Не удалось прочитать резервную копию.');
    }).then(function (data) {
      if (!data || data.kind !== 'metapel-backup') throw new Error('Файл резервной копии повреждён.');
      return data;
    });
  }

  return {
    isOn: isOn,
    enqueue: enqueue,
    processQueue: processQueue,
    backupIfChanged: backupIfChanged,
    fetchBackup: fetchBackup
  };
})();
