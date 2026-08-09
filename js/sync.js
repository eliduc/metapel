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
      returns: store.loadReturns(),
      timesheets: store.loadTimesheets()
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

  // Локальные данные «накрывают» облачные, если ВСЕ облачные записи есть локально
  // и ни по одной из них локально не потеряна расписка, которая есть в облаке.
  // Тогда писать локальную копию безопасно (ничего облачного не теряем), даже
  // если локальный номер версии отстал. Это снимает «застревание»: устройство
  // залило копию, но не успело записать у себя новый номер (закрыли приложение),
  // и потом отказывалось дозаливать уже полученную расписку, считая себя «старее».
  // Чистая функция (тестируется без сети).
  function localSupersedesCloud(cloud, localLog, localExtras, localReturns, localTimesheets) {
    function received(r) { return !!(r && (r.signature || r.signatureArchived)); }
    var cl = (cloud && cloud.log) || {};
    var ce = (cloud && cloud.extras) || [];
    var cr = (cloud && cloud.returns) || [];
    // Состав записей должен СОВПАДАТЬ (равные наборы id). Если локально есть
    // лишняя запись или какой-то нет — это добавление/удаление на другом
    // устройстве, т.е. конфликт состава, а НЕ «локально просто свежее»; такое
    // не затираем молча (вернём false → ручное «Восстановить»). Так мы не
    // воскрешаем удалённое и не теряем чужие добавления.
    var clIds = Object.keys(cl), llIds = Object.keys(localLog);
    if (clIds.length !== llIds.length) return false;
    for (var i = 0; i < clIds.length; i++) {
      var id = clIds[i], lr = localLog[id], c = cl[id];
      if (!lr) return false;
      // деньги и дата оплаты ДОЛЖНЫ совпадать — иначе на другом устройстве
      // правили сумму того же платежа; это конфликт контента, не затираем.
      // (поля расписки signedDate/signature НЕ сверяем — им и положено
      //  отличаться: легитимный случай «локально расписались, в облаке ещё нет».)
      if (lr.paidAmount !== c.paidAmount || lr.paidDate !== c.paidDate) return false;
      if (received(c) && !received(lr)) return false; // облачную расписку локально не теряем
    }
    if (ce.length !== localExtras.length) return false;
    for (var j = 0; j < ce.length; j++) {
      var le = null;
      for (var k = 0; k < localExtras.length; k++) if (localExtras[k].id === ce[j].id) { le = localExtras[k]; break; }
      if (!le) return false;
      if (le.amount !== ce[j].amount || le.date !== ce[j].date) return false;
      if (received(ce[j]) && !received(le)) return false;
    }
    if (cr.length !== localReturns.length) return false;
    for (var m = 0; m < cr.length; m++) {
      var ok = false;
      for (var n = 0; n < localReturns.length; n++) if (localReturns[n].id === cr[m].id) { ok = true; break; }
      if (!ok) return false;
    }
    // Табели: локально может быть БОЛЬШЕ табелей, чем в облаке — это нормальное
    // ДОБАВЛЕНИЕ табеля на этом устройстве, и его надо донести до облака. Поэтому
    // равенства числа НЕ требуем (иначе свежезагруженный табель навсегда застревал
    // бы: устройство не может залить табель, которого ещё нет в облаке, а из-за
    // этого вместе с ним застревают и настройки — EmailJS и пр.). Требуем лишь,
    // чтобы все ОБЛАЧНЫЕ табели были у нас (облачный/чужой табель не теряем).
    // Цена компромисса: табель, удалённый на другом устройстве, на отставшем
    // устройстве может «воскреснуть» при заливке — для табелей это безвредно
    // (можно удалить повторно). Для ДЕНЕГ (log/extras/returns) состав выше
    // по-прежнему сверяется СТРОГО на равенство, чтобы не воскрешать удалённые суммы.
    var ct = (cloud && cloud.timesheets) || [];
    var lt = localTimesheets || [];
    for (var p = 0; p < ct.length; p++) {
      var okt = false;
      for (var q = 0; q < lt.length; q++) if (lt[q].id === ct[p].id) { okt = true; break; }
      if (!okt) return false;
    }
    return true;
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
                store.loadReturns().length === 0 &&
                store.loadTimesheets().length === 0; // табель — тоже данные: свежее
                // устройство только с табелем НЕ «пустое», иначе его не зальём в облако
    if (empty && !(store.getMeta('backupGeneration') > 0)) return Promise.resolve(false);
    // хэш только СОДЕРЖИМОГО (generation=0), чтобы рост версии не вызывал лишних заливок
    var dataHash = hashFn(buildBackupJson(settings, store, 0));
    if (store.getMeta('lastBackupHash') === dataHash) return Promise.resolve(false);
    return readCloudBackup(settings).then(function (res) {
      var cloud = res.data;
      var cloudGen = (cloud && typeof cloud.generation === 'number') ? cloud.generation : -1;
      var localGen = store.getMeta('backupGeneration') || 0;
      // Номер облака выше нашего. Отказываемся затирать чужую историю ТОЛЬКО
      // если локально мы её не накрываем (в облаке есть данные/расписки, которых
      // у нас нет) — тогда просим «Восстановить». Но если локальные данные
      // накрывают облачные (всё облачное есть у нас, и расписки не потеряны),
      // значит мы на самом деле свежее — просто номер отстал; пишем свою копию,
      // ничего облачного не теряя (CAS по sha по-прежнему защищает от гонки).
      if (cloud && cloudGen > localGen &&
          !localSupersedesCloud(cloud, store.loadLog(), store.loadExtras(), store.loadReturns(), store.loadTimesheets())) {
        store.setMeta('lastSyncError',
          'Облачная копия новее этого устройства — нажмите «Восстановить» перед изменениями.');
        return false;
      }
      // ОБЩИЙ параметр «суммы от Матав»: если облако новее (cloudGen>localGen), но мы
      // заливаем (наши ДАННЫЕ накрывают облачные) — ПРИНИМАЕМ облачные суммы ПЕРЕД
      // заливкой, иначе затёрли бы более новые своими устаревшими (откат у всех).
      // Помесячные суммы при этом ОБЪЕДИНЯЮТСЯ: другое устройство могло ввести
      // месяц, которого у нас нет, и он обязан уехать в облако вместе с нашими.
      applySharedSettings(settings, store,
        sharedSettingsFromCloud(cloud && cloud.settings, cloud && (cloudGen > localGen)));
      var newGen = Math.max(cloudGen, localGen) + 1;
      var json = buildBackupJson(settings, store, newGen);
      // CAS по прочитанному sha: если другое устройство залило между нашим чтением
      // и записью — putFile бросит ошибку, и мы не затрём чужую запись (гонка)
      return putFile(conf(settings), dataPrefix() + 'backup/data.json', json, 'Data backup gen ' + newGen, res.sha).then(function () {
        store.setMeta('backupGeneration', newGen);
        // пересчитываем хэш по АКТУАЛЬНЫМ настройкам (могли принять облачную сумму),
        // чтобы lastBackupHash отражал реально залитое содержимое
        store.setMeta('lastBackupHash', hashFn(buildBackupJson(settings, store, 0)));
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

  function timesheetPath(id, suffix) {
    return dataPrefix() + 'timesheets/' + id + (suffix || '') + '.json';
  }

  // заливает файл табеля (исходный или подписанный) в репозиторий данных.
  // obj — { pdf: 'data:application/pdf;base64,...', fileName, month }.
  function putTimesheetFile(settings, id, suffix, obj) {
    if (!isOn(settings)) return Promise.reject(new Error('Архив не настроен (нет токена).'));
    var json = JSON.stringify(obj);
    return putFile(conf(settings), timesheetPath(id, suffix), json, 'Timesheet ' + id + (suffix || ''));
  }

  // читает файл табеля из репозитория данных. Возвращает разобранный объект.
  function fetchTimesheetFile(settings, id, suffix) {
    var c = conf(settings);
    if (!c.repo || !c.token) return Promise.reject(new Error('Архив не настроен (нет токена).'));
    var url = 'https://api.github.com/repos/' + c.repo + '/contents/' + timesheetPath(id, suffix);
    return fetch(url, { headers: headers(c) }).then(function (r) {
      if (r.status === 404) throw new Error('Файл табеля не найден в архиве.');
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
      throw new Error('Не удалось прочитать файл табеля.');
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

  // маска ключа помесячной суммы от Матав (та же, что в calc.sanitizeSettings)
  var YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  /**
   * ЧИСТАЯ: объединяет помесячные суммы от Матав. Локальные ключи, поверх —
   * облачные (облако свежее, поэтому при совпадении месяца выигрывает оно).
   * Месяц, которого в облаке нет, СОХРАНЯЕТСЯ: устройства вводят РАЗНЫЕ месяцы,
   * и заливка не должна стирать чужие.
   * Мусор отбрасываем (поле приходит из облака произвольным JSON), а ключи
   * сортируем: порядок вставки попадает в JSON бэкапа, и без сортировки два
   * устройства с одинаковым набором месяцев давали бы разный хэш — то есть
   * бесконечные «изменения» и лишние заливки.
   */
  function mergeMatavByMonth(local, cloud) {
    var merged = {};
    function take(src) {
      if (!src || typeof src !== 'object' || Array.isArray(src)) return;
      Object.keys(src).forEach(function (k) {
        var v = src[k];
        if (YM_RE.test(k) && typeof v === 'number' && !isNaN(v) && v >= 0) merged[k] = v;
      });
    }
    take(local);
    take(cloud);
    var out = {};
    Object.keys(merged).sort().forEach(function (k) { out[k] = merged[k]; });
    return out;
  }

  function hasPositiveMonth(byMonth) {
    if (!byMonth || typeof byMonth !== 'object') return false;
    return Object.keys(byMonth).some(function (k) {
      return YM_RE.test(k) && typeof byMonth[k] === 'number' && byMonth[k] > 0;
    });
  }

  // ЧИСТАЯ: что принять из облачной «суммы от Матав», если облако СВЕЖЕЕ.
  // cloudNewer — при pull всегда true (decideSync гарантирует cloudGen>localGen);
  // при push поверх облака — (cloudGen>localGen). Возвращает {matavAmount?, approved,
  // matavByMonth?} к принятию, либо null (принимать нечего: облако не свежее / нет полей).
  // Зачем: суммы от Матав — ОБЩИЙ параметр; устройство НЕ должно затирать более новую
  // облачную сумму своей устаревшей (иначе сумма «откатывалась» бы у всех — деньги).
  function sharedSettingsFromCloud(cloudSettings, cloudNewer) {
    if (!cloudNewer) return null;
    var bl = cloudSettings && cloudSettings.bl;
    if (!bl) return null;
    var hasAmount = typeof bl.matavAmount === 'number';
    var hasMonths = !!bl.matavByMonth && typeof bl.matavByMonth === 'object' && !Array.isArray(bl.matavByMonth);
    if (!hasAmount && !hasMonths) return null; // старый/битый бэкап — принимать нечего
    // порядок ключей значим: тесты сравнивают результат через JSON.stringify
    var shared = {};
    if (hasAmount) shared.matavAmount = bl.matavAmount;
    shared.approved = !!bl.approved;
    // облачные месяцы отдаём СЫРЫМИ: слить их здесь не с чем — локальных настроек
    // у чистой функции нет. Объединение делает applySharedSettings.
    if (hasMonths) shared.matavByMonth = bl.matavByMonth;
    return shared;
  }

  // применяет принятую общую настройку к локальным settings и персистит (мутирует
  // settings по ссылке — вызывающий держит ту же ссылку). Возвращает true, если приняли.
  function applySharedSettings(settings, store, shared) {
    if (!shared || !settings.bl) return false;
    // легаси-число принимаем, только если оно в облаке есть: иначе undefined затёр
    // бы локальную сумму и сломал бы конфиг без помесячных данных
    if (typeof shared.matavAmount === 'number') settings.bl.matavAmount = shared.matavAmount;
    if (shared.matavByMonth) {
      settings.bl.matavByMonth = mergeMatavByMonth(settings.bl.matavByMonth, shared.matavByMonth);
    }
    // approved — общий выключатель зачёта (calc: !approved → зачёта нет вообще).
    // Чужой false НЕ гасит его, пока у нас есть месяц с положительной суммой: иначе
    // устройство со старым кодом обнулило бы зачёт сразу после ввода суммы здесь.
    settings.bl.approved = !!shared.approved || hasPositiveMonth(settings.bl.matavByMonth);
    store.saveSettings(settings);
    return true;
  }

  // Если в облаке более свежее поколение, а локально нет несохранённых правок —
  // молча подтягивает облачные log/extras/returns/timesheets. Из НАСТРОЕК
  // синхронизируем ТОЛЬКО «суммы от Матав» (bl.matavByMonth/matavAmount/approved) —
  // это общий параметр, влияющий на расчёт на всех устройствах; токен и прочие
  // личные настройки остаются локальными (как и при ручном восстановлении).
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
                    store.loadReturns().length === 0 &&
                    store.loadTimesheets().length === 0, // несинхронизированный
                    // локальный табель — это «есть что терять»: не отдаём pull'у
                    // молча перезаписать его облачной копией (уходим в conflict)

        localHash: hashFn(buildBackupJson(settings, store, 0)),
        lastHash: store.getMeta('lastBackupHash')
      };
      if (decideSync(state) !== 'pull') return null;
      // безопасно: локально несохранённого нет. replaceData заодно чистит syncQueue.
      store.replaceData({ log: cloud.log || {}, extras: cloud.extras || [], returns: cloud.returns || [], timesheets: cloud.timesheets || [] });
      // подтянуть ОБЩИЕ «суммы от Матав» из облака (при pull облако всегда свежее).
      // Применяем ДО пересчёта lastBackupHash, чтобы хэш отражал новое состояние
      // (иначе следующая синхронизация сочла бы локальное изменённым).
      applySharedSettings(settings, store, sharedSettingsFromCloud(cloud.settings, true));
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
    sharedSettingsFromCloud: sharedSettingsFromCloud,
    applySharedSettings: applySharedSettings, // нужна тестам и «Восстановить» в app.js
    mergeMatavByMonth: mergeMatavByMonth,
    localSupersedesCloud: localSupersedesCloud,
    fetchBackup: fetchBackup,
    buildBackupJson: buildBackupJson,
    fetchReceipt: fetchReceipt,
    putTimesheetFile: putTimesheetFile,
    fetchTimesheetFile: fetchTimesheetFile
  };
})();
