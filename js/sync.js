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

  // префикс путей в репозитории данных: у stage — 'stage/', чтобы боевые
  // backup/data.json и receipts/ не пересекались со stage (один репозиторий,
  // но разные папки — без гонки и затирания)
  function dataPrefix() {
    return (window.MetapelEnv && window.MetapelEnv.dataPrefix) || '';
  }

  function receiptPath(id) {
    return dataPrefix() + 'receipts/' + id + '.json';
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

  // casSha:
  //   undefined — legacy-режим (расписки): берём свежий sha и перезаписываем;
  //   строка/null — compare-and-swap: пишем с ИМЕННО этим sha; если файл изменился
  //   с другого устройства между чтением и записью (sha устарел), GitHub вернёт
  //   409/422 → бросаем ошибку и НЕ затираем чужую запись (защита от гонки).
  function putFile(c, path, jsonStr, message, casSha) {
    var url = 'https://api.github.com/repos/' + c.repo + '/contents/' + path;
    function doPut(sha) {
      var body = { message: message, content: b64(jsonStr) };
      if (sha) body.sha = sha;
      return fetch(url, { method: 'PUT', headers: headers(c), body: JSON.stringify(body) })
        .then(function (r) {
          if (r.status === 409 || r.status === 422) {
            throw new Error('Облачная копия изменилась с другого устройства — обновите страницу.');
          }
          if (!r.ok) {
            return r.text().then(function (t) {
              throw new Error('GitHub ' + r.status + ': ' + t.slice(0, 200));
            });
          }
          return true;
        });
    }
    if (typeof casSha !== 'undefined') return doPut(casSha);
    // legacy: подтянуть текущий sha и перезаписать
    return fetch(url, { headers: headers(c) }).then(function (g) {
      if (g.status === 200) return g.json().then(function (j) { return j.sha; });
      return null;
    }).then(doPut);
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

  function buildBackupObject(settings, store, generation) {
    var cleanSettings = JSON.parse(JSON.stringify(settings));
    if (cleanSettings.sync) cleanSettings.sync.token = ''; // токен не покидает устройство
    var log = store.loadLog();
    var lightLog = {};
    Object.keys(log).forEach(function (id) { lightLog[id] = lightenRecord(log[id]); });
    return {
      kind: 'metapel-backup',
      generation: generation, // монотонная версия копии (защита от затирания)
      settings: cleanSettings,
      log: lightLog,
      extras: store.loadExtras().map(lightenRecord),
      returns: store.loadReturns()
    };
  }

  function buildBackupJson(settings, store, generation) {
    return JSON.stringify(buildBackupObject(settings, store, generation), null, 2);
  }

  // мягкое чтение облачной копии. Возвращает { data, sha }:
  // data=null если копии ещё нет (404); sha нужен для compare-and-swap при записи.
  function readCloudBackup(settings) {
    var c = conf(settings);
    var url = 'https://api.github.com/repos/' + c.repo + '/contents/' + dataPrefix() + 'backup/data.json';
    return fetch(url, { headers: headers(c) }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('GitHub ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j === null) return { data: null, sha: null };
      var sha = j.sha || null;
      var content = String(j.content || '').replace(/\s/g, '');
      if (content) {
        return { data: JSON.parse(decodeURIComponent(escape(atob(content)))), sha: sha };
      }
      // файл >1 МБ: Contents API не вернул содержимое — тянем сырой по ссылке
      if (j.download_url) {
        return fetch(j.download_url).then(function (raw) {
          if (!raw.ok) throw new Error('GitHub ' + raw.status);
          return raw.json();
        }).then(function (d) { return { data: d, sha: sha }; });
      }
      throw new Error('Не удалось прочитать резервную копию.');
    });
  }

  // заливает backup/data.json, если данные изменились И эта копия не старше облачной
  function backupIfChanged(settings, store, hashFn) {
    if (!isOn(settings)) return Promise.resolve(false);
    // не затираем облачную копию пустыми/начальными данными СВЕЖЕГО устройства
    // (ещё не бэкапилось и не восстанавливалось → backupGeneration не задан):
    // быстрый путь без сетевого чтения. Но если устройство уже участвовало в
    // бэкапе (generation>0), пустота — это осознанное удаление всех записей,
    // и его НАДО донести до облака (иначе при restore удалённое «воскреснет»).
    // От затирания более свежей чужой истории по-прежнему защищают CAS+generation.
    var empty = Object.keys(store.loadLog()).length === 0 &&
                store.loadExtras().length === 0 &&
                store.loadReturns().length === 0;
    if (empty && !(store.getMeta('backupGeneration') > 0)) return Promise.resolve(false);
    // хэш только СОДЕРЖИМОГО (generation=0), чтобы рост версии не вызывал лишних заливок
    var dataHash = hashFn(buildBackupJson(settings, store, 0));
    if (store.getMeta('lastBackupHash') === dataHash) return Promise.resolve(false);
    return readCloudBackup(settings).then(function (res) {
      var cloud = res.data;
      var cloudGen = (cloud && typeof cloud.generation === 'number') ? cloud.generation : -1;
      var localGen = store.getMeta('backupGeneration') || 0;
      // устройство отстало от облака — НЕ затираем более свежую чужую историю
      // (устаревший ПК / свежее устройство, на котором ещё не восстанавливались)
      if (cloud && cloudGen > localGen) {
        store.setMeta('lastSyncError',
          'Облачная копия новее этого устройства — нажмите «Восстановить» перед изменениями.');
        return false;
      }
      var newGen = Math.max(cloudGen, localGen) + 1;
      var json = buildBackupJson(settings, store, newGen);
      // CAS по прочитанному sha: если другое устройство залило между нашим чтением
      // и записью — putFile бросит ошибку, и мы не затрём чужую запись (гонка)
      return putFile(conf(settings), dataPrefix() + 'backup/data.json', json, 'Data backup gen ' + newGen, res.sha).then(function () {
        store.setMeta('backupGeneration', newGen);
        store.setMeta('lastBackupHash', dataHash);
        store.setMeta('lastSyncError', null);
        return true;
      });
    }).catch(function (e) {
      store.setMeta('lastSyncError', String(e && e.message || e));
      return false;
    });
  }

  function fetchBackup(settings) {
    return readCloudBackup(settings).then(function (res) {
      var data = res.data;
      if (data === null) throw new Error('Резервной копии в архиве ещё нет.');
      if (!data || data.kind !== 'metapel-backup') throw new Error('Файл резервной копии повреждён.');
      return data;
    });
  }

  // Читает отдельную расписку receipts/<id>.json из архива (картинку подписи
  // в общий бэкап не кладут, поэтому на других устройствах её подгружаем по
  // запросу). Только чтение — на запись/синхронизацию не влияет.
  function fetchReceipt(settings, id) {
    var c = conf(settings);
    if (!c.repo || !c.token) return Promise.reject(new Error('Архив не настроен (нет токена).'));
    var url = 'https://api.github.com/repos/' + c.repo + '/contents/' + receiptPath(id);
    return fetch(url, { headers: headers(c) }).then(function (r) {
      if (r.status === 404) throw new Error('Расписка не найдена в архиве.');
      if (!r.ok) throw new Error('GitHub ' + r.status);
      return r.json();
    }).then(function (j) {
      var content = String(j.content || '').replace(/\s/g, '');
      if (content) return JSON.parse(decodeURIComponent(escape(atob(content))));
      if (j.download_url) {
        return fetch(j.download_url).then(function (raw) {
          if (!raw.ok) throw new Error('GitHub ' + raw.status);
          return raw.json();
        });
      }
      throw new Error('Не удалось прочитать расписку.');
    });
  }

  // ---------- автоподтягивание свежей облачной копии ----------

  // ЧИСТОЕ решение: нужно ли молча подтянуть облако (тестируется без сети).
  // state: { cloudExists, cloudGen, localGen, localEmpty, localHash, lastHash }
  //   'pull'     — облако новее, а локально терять нечего → безопасно подтянуть
  //   'conflict' — облако новее, НО локально есть несохранённые изменения → не трогаем
  //   'defer'    — облако не новее/нет → пусть решает backupIfChanged (пуш/ничего)
  function decideSync(state) {
    if (!state.cloudExists) return 'defer';
    if (state.cloudGen <= state.localGen) return 'defer';
    // Облако новее. Подтягивать (перезаписывать локальное) безопасно ТОЛЬКО если
    // локально терять нечего: либо данных нет совсем, либо они в точности
    // совпадают с последней синхронизацией (lastHash задан и совпал). Если же
    // есть локальные данные без доказательства, что они уже синхронизированы
    // (lastHash пуст ИЛИ хэш отличается) — это конфликт, молча НЕ перетираем
    // (иначе потеряли бы несохранённые правки, напр. на ещё не синхронном iPad).
    if (state.localEmpty) return 'pull';
    if (state.lastHash && state.localHash === state.lastHash) return 'pull';
    return 'conflict';
  }

  // Если в облаке более свежее поколение, а локально нет несохранённых правок —
  // молча подтягивает облачные log/extras/returns (настройки не трогаем: токен
  // и локальные параметры у каждого устройства свои, как и при ручном восстановлении).
  // Возвращает {generation} при подтягивании, иначе null. Конфликт (локальные
  // правки + облако новее) НЕ перезаписывает — это подсветит backupIfChanged
  // обычным сообщением «Облачная копия новее — нажмите Восстановить».
  function pullIfNewer(settings, store, hashFn) {
    if (!isOn(settings)) return Promise.resolve(null);
    return readCloudBackup(settings).then(function (res) {
      var cloud = res.data;
      if (!cloud || cloud.kind !== 'metapel-backup') return null;
      var state = {
        cloudExists: true,
        cloudGen: (typeof cloud.generation === 'number') ? cloud.generation : -1,
        localGen: store.getMeta('backupGeneration') || 0,
        localEmpty: Object.keys(store.loadLog()).length === 0 &&
                    store.loadExtras().length === 0 &&
                    store.loadReturns().length === 0,
        localHash: hashFn(buildBackupJson(settings, store, 0)),
        lastHash: store.getMeta('lastBackupHash')
      };
      if (decideSync(state) !== 'pull') return null;
      // безопасно: локально несохранённого нет. replaceData заодно чистит syncQueue.
      store.replaceData({ log: cloud.log || {}, extras: cloud.extras || [], returns: cloud.returns || [] });
      store.setMeta('backupGeneration', state.cloudGen);
      store.setMeta('lastBackupHash', hashFn(buildBackupJson(settings, store, 0)));
      store.setMeta('lastSyncError', null);
      return { generation: state.cloudGen };
    }).catch(function () { return null; }); // сеть/чтение упало — просто не тянем
  }

  return {
    isOn: isOn,
    enqueue: enqueue,
    processQueue: processQueue,
    backupIfChanged: backupIfChanged,
    pullIfNewer: pullIfNewer,
    decideSync: decideSync,
    fetchBackup: fetchBackup,
    fetchReceipt: fetchReceipt
  };
})();
