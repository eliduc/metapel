/*
 * MetapelTimesheet — парсинг табеля Матав (יומן עבודה) и расстановка подписей.
 * Тяжёлые библиотеки (pdf.js, pdf-lib) грузятся лениво — только при заходе
 * в подписание, чтобы не тормозить основное приложение и не качать ~2 МБ зря.
 * Координаты берутся не фиксированными, а по ивритским заголовкам шаблона
 * (חתימת המטפלת / חתימה שבועית / סה״כ שעות / יום) — устойчиво к смене месяца.
 *
 * Системы координат pdf.js и pdf-lib совпадают: начало внизу-слева, y вверх.
 */
window.MetapelTimesheet = (function () {
  'use strict';

  var PDFJS = 'js/vendor/pdf.min.js';
  var WORKER = 'js/vendor/pdf.worker.min.js';
  var PDFLIB = 'js/vendor/pdf-lib.min.js';

  var loaded = false, loadingP = null;

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('Не удалось загрузить ' + src)); };
      document.head.appendChild(s);
    });
  }

  // лениво подгружает pdf.js + pdf-lib (один раз). Сбой (мигнула сеть) не
  // «залипает»: следующий вызов попробует снова, а не вернёт ту же ошибку до
  // перезагрузки страницы (иначе все загрузки бланков в этой сессии молча шли бы
  // без разбора — в текущий месяц, без отметки Claims).
  function ensureLibs() {
    if (loaded) return Promise.resolve();
    if (loadingP) return loadingP;
    loadingP = (window.pdfjsLib ? Promise.resolve() : loadScript(PDFJS)).then(function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
      return window.PDFLib ? null : loadScript(PDFLIB);
    }).then(function () { loaded = true; }, function (e) {
      loadingP = null;
      throw e;
    });
    return loadingP;
  }

  // 'data:application/pdf;base64,XXXX' | 'XXXX' -> Uint8Array
  function u8FromDataUrl(dataUrl) {
    var b64 = String(dataUrl).indexOf(',') >= 0 ? String(dataUrl).split(',')[1] : String(dataUrl);
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function bytesToDataUrl(u8, mime) {
    var bin = '';
    for (var i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return 'data:' + (mime || 'application/pdf') + ';base64,' + btoa(bin);
  }

  var DOW = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };

  function findOne(items, re) {
    for (var i = 0; i < items.length; i++) if (re.test(items[i].s)) return items[i];
    return null;
  }
  function isNumStr(s) { return /^\d+(\.\d+)?$/.test(s); }
  function dayNumOf(s) { var m = String(s).match(/\b([12]?\d|3[01])\b/); return m ? +m[1] : null; }

  // По извлечённым текстовым элементам строит список «слотов» подписи.
  // items: [{s, x, y, w}] в координатах pdf.js (низ-слева).
  // opts.claimsCare — места метапелет на бланке Claims (по дням). Только по явному
  // запросу: старый app.js из кэша (не знает о подписях по дням) получит прежнюю
  // карту и не поставит одну подпись метапелет во все дни бланка Claims.
  function computeSlots(items, opts) {
    opts = opts || {};
    var cCare = findOne(items, /חתימת המטפל/);   // подпись метапелет (по дням)
    var cWeek = findOne(items, /חתימה שבועית/);  // недельная подпись
    var cDay = findOne(items, /^יום$/);          // столбец дня (№)
    if (!cCare || !cWeek) throw new Error('Не похоже на бланк Матав: не найдены заголовки подписей (חתימת המטפלת / חתימה שבועית). Возможно, это скан-картинка.');
    var headerY = cCare.y;
    // «סה״כ שעות» именно в шапке таблицы (та, чей y ближе всего к заголовкам подписи)
    var cHours = null, best = 1e9;
    for (var i = 0; i < items.length; i++) {
      if (/שעות/.test(items[i].s)) {
        var d = Math.abs(items[i].y - headerY);
        if (d < best) { best = d; cHours = items[i]; }
      }
    }
    if (!cHours) throw new Error('Не найден столбец часов (סה״כ שעות).');

    var careX = cCare.x + cCare.w / 2;
    var weekX = cWeek.x + cWeek.w / 2;
    var hLo = cHours.x - 3, hHi = cHours.x + cHours.w + 3;
    var dayColX = cDay ? cDay.x : 526;

    // нижний блок подтверждения метапеля — нижняя граница строк таблицы
    var careBlock = findOne(items, /אישור המטפל/);
    // именно нижний блок «בן/בת משפחה», а НЕ поле «קרוב משפחה» вверху бланка
    var famBlock = findOne(items, /בן\/בת/);
    var bottomY = careBlock ? careBlock.y : 170;

    // строки-дни: правый столбец, между нижним блоком и шапкой
    var rowItems = items.filter(function (it) {
      return it.x > (dayColX - 16) && it.y > bottomY + 5 && it.y < headerY - 2;
    });
    var groups = [];
    rowItems.forEach(function (it) {
      var g = null;
      for (var k = 0; k < groups.length; k++) if (Math.abs(groups[k].y - it.y) < 4) { g = groups[k]; break; }
      if (!g) { g = { y: it.y, items: [] }; groups.push(g); }
      g.items.push(it);
    });
    var rows = [];
    groups.forEach(function (g) {
      var n = null, dow = null;
      g.items.forEach(function (it) {
        var nn = dayNumOf(it.s);
        if (nn != null) n = nn;
        for (var w in DOW) if (DOW.hasOwnProperty(w) && it.s.indexOf(w) >= 0) dow = DOW[w];
      });
      if (n != null) rows.push({ num: n, dow: dow, y: g.y });
    });
    rows.sort(function (a, b) { return a.num - b.num; });

    // часы по строке
    rows.forEach(function (r) {
      var h = null;
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        if (it.x >= hLo && it.x <= hHi && Math.abs(it.y - r.y) < 4 && isNumStr(it.s)) { h = parseFloat(it.s); break; }
      }
      r.hours = h || 0;
    });
    var work = rows.filter(function (r) { return r.hours > 0; });

    // нижние метки (שם / חתימה / תאריך) ~ на 16pt ниже заголовков блоков; САМИ
    // линии для подписи/даты ещё на ~22pt ниже меток. Ставим подпись на ЛИНИЮ.
    var subY = careBlock ? careBlock.y - 16 : 158;
    var careSig = null, careDate = null, famName = null;
    items.forEach(function (it) {
      if (Math.abs(it.y - subY) > 4) return;
      if (/^חתימה$/.test(it.s) && it.x > 250 && it.x < 360) careSig = it;       // подпись метапеля
      if (/^תאריך$/.test(it.s) && it.x > 200 && it.x < 290) careDate = it;       // дата метапеля
      if (/^שם$/.test(it.s) && it.x > 470) famName = it;                         // имя/подпись семьи
    });

    // Бланк Claims Conference («אל קרן נפגעי שואה», с 08/2026 — второй бланк
    // месяца): ответственный за него НЕ принимает одинаковые подписи — метапелет
    // расписывается ОТДЕЛЬНО за каждый рабочий день, Григорий — ОТДЕЛЬНО за каждую
    // неделю (живые подписи; сбор серий — в app.js). Места те же, что в обычном.
    // Ищем только в ШАПКЕ (выше таблицы — там адресат «אל …»): те же слова в
    // примечаниях под таблицей обычного бланка не должны отнимать места метапелет.
    // («הקרן לנפגעי השואה» — с артиклем ה — тоже: иначе одиночный бланк Claims молча
    // подписался бы одной подписью на все места)
    var claims = items.some(function (it) {
      return it.y > headerY + 10 && /נפגעי\s+ה?שואה|ועי?דת\s+התביעות|claims\s*conference/i.test(it.s);
    });

    // ДВА столбца подписи = ДВА подписанта (как в образце):
    //   חתימת המטפלת (careX)  — метапелет, в КАЖДЫЙ рабочий день;
    //   חתימה שבועית (weekX) — Григорий (член семьи), ОДНА подпись на неделю.
    // Плюс нижние блоки: אישור המטפל/ת (метапелет) и בן/בת משפחה (Григорий).
    // day — число месяца: по нему окно подписи называет, ЗА КАКОЙ день расписываться.
    var slots = [];
    if (!claims || opts.claimsCare) {
      work.forEach(function (r) {
        slots.push({ kind: 'care-day', cx: careX, cy: r.y + 2, w: 46, h: 11, label: 'метапелет — день ' + r.num, day: r.num });
      });
    }
    // недельные группы (новая начинается с воскресенья ראשון или с первой строки);
    // Григорий расписывается ОДИН раз на каждую неделю, где есть рабочие дни,
    // по центру строк этой недели в столбце חתימה שבועית.
    var weeks = [], cur = null;
    rows.forEach(function (r) {
      if (cur === null || r.dow === 0) { cur = { rows: [] }; weeks.push(cur); }
      cur.rows.push(r);
    });
    var wk = 0;
    weeks.forEach(function (w) {
      if (!w.rows.some(function (r) { return r.hours > 0; })) return;
      wk++;
      var ys = w.rows.map(function (r) { return r.y; });
      var cy = (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2;
      // days — рабочие дни недели: по ним окно подписи называет, ЗА КАКУЮ неделю
      // расписываться (Claims: отдельная подпись на каждую неделю)
      slots.push({ kind: 'family-week', cx: weekX, cy: cy + 2, w: 46, h: 18, label: 'Григорий — неделя ' + wk,
        week: wk, days: w.rows.filter(function (r) { return r.hours > 0; }).map(function (r) { return r.num; }) });
    });
    // НИЖНИЕ блоки подтверждения (אишур המטפл/ת, בн/бт משפחה) и дату НЕ заполняем:
    // Григорий расписывается сам, нижние подписи не нужны (по требованию пользователя).
    // Поэтому слотов care-bottom/family здесь больше нет.

    return {
      slots: slots,
      workDays: work.map(function (r) { return r.num; }),
      careDateAt: null,
      claims: claims
    };
  }

  // Парсит PDF (Uint8Array) первой страницы -> {slots, workDays, careDateAt, claims}.
  // pdf.js МОЖЕТ забрать (detach) переданный буфер в воркер — отдаём КОПИЮ
  // (.slice(0)), иначе исходный baseU8 «опустеет» и pdf-lib потом скажет
  // «No PDF header found» при штамповке того же массива.
  function parse(pdfU8, opts) {
    return ensureLibs().then(function () {
      return window.pdfjsLib.getDocument({ data: pdfU8.slice(0), isEvalSupported: false }).promise;
    }).then(function (doc) {
      return doc.getPage(1);
    }).then(function (page) {
      return page.getTextContent().then(function (tc) {
        var items = tc.items.map(function (it) {
          return { s: String(it.str).trim(), x: it.transform[4], y: it.transform[5], w: it.width };
        }).filter(function (it) { return it.s !== ''; });
        return computeSlots(items, opts);
      });
    });
  }

  // Достаёт ПЕРИОД табеля из шапки бланка («יומן עבודה לתקופה MM/YYYY») и
  // возвращает 'YYYY-MM' (или null). Это правильный месяц табеля — а НЕ дата
  // загрузки: табели сдаются за прошлый месяц, поэтому брать его надо из бланка.
  function parseMonth(pdfU8) {
    return ensureLibs().then(function () {
      return window.pdfjsLib.getDocument({ data: pdfU8.slice(0), isEvalSupported: false }).promise;
    }).then(function (doc) {
      return doc.getPage(1);
    }).then(function (page) {
      return page.getTextContent();
    }).then(function (tc) {
      return monthOfItems(tc.items);
    });
  }
  // период бланка по текстовым элементам pdf.js ({str}) → 'YYYY-MM' или null
  function monthOfItems(list) {
    function toYM(mo, yr) { return yr + '-' + ('0' + mo).slice(-2); }
    // 1) рядом с «לתקופה» / «יומן עבודה» — период MM/YYYY
    for (var i = 0; i < list.length; i++) {
      var s = String(list[i].str);
      if (s.indexOf('לתקופה') >= 0 || s.indexOf('יומן עבודה') >= 0) {
        var m = s.match(/(\d{1,2})\s*\/\s*(\d{4})/);
        if (m && +m[1] >= 1 && +m[1] <= 12) return toYM(+m[1], m[2]);
      }
    }
    // 2) запасной: отдельный токен MM/YYYY (не часть DD/MM/YYYY)
    for (var j = 0; j < list.length; j++) {
      var t = String(list[j].str).trim();
      var mm = t.match(/(?:^|[^\d\/])(\d{1,2})\/(\d{4})(?:$|[^\d\/])/);
      if (mm && +mm[1] >= 1 && +mm[1] <= 12) return toYM(+mm[1], mm[2]);
    }
    return null;
  }

  // Разбор бланка ПРИ ЗАГРУЗКЕ — за одно открытие PDF: период, Claims, бланк ли это
  // Матав вообще (есть ли столбцы подписи и рабочие дни) и не подписанный ли это уже
  // файл, скачанный из приложения (pdf-lib пишет себя в Producer при сохранении;
  // подписи поверх подписей встали бы второй раз).
  // → { month, claims, matav, workDays, error, signedByApp }. Сбой загрузки самого
  // pdf.js (сеть) — отклонённый промис: это не «не тот бланк».
  function inspect(pdfU8) {
    return ensureLibs().then(function () {
      return window.pdfjsLib.getDocument({ data: pdfU8.slice(0), isEvalSupported: false }).promise;
    }).then(function (doc) {
      return Promise.all([
        doc.getPage(1).then(function (page) { return page.getTextContent(); }),
        doc.getMetadata().catch(function () { return null; })
      ]);
    }).then(function (r) {
      var tc = r[0], info = (r[1] && r[1].info) || {};
      // signedByApp — своя метка подписанного бланка (v6.14+, см. saveSmall); pdfLib —
      // файл пересохранён pdf-lib (так собирали подписанные бланки и до метки)
      var out = { month: monthOfItems(tc.items), claims: null, matav: false, workDays: 0, error: null,
        signedByApp: String(info.Keywords || '').indexOf(SIGNED_MARK) >= 0,
        pdfLib: /pdf-lib/i.test(String(info.Producer || '') + ' ' + String(info.Creator || '')) };
      var items = tc.items.map(function (it) {
        return { s: String(it.str).trim(), x: it.transform[4], y: it.transform[5], w: it.width };
      }).filter(function (it) { return it.s !== ''; });
      try {
        var s = computeSlots(items, { claimsCare: true });
        out.matav = true;
        out.claims = s.claims;
        out.workDays = s.workDays.length;
      } catch (e) {
        out.error = (e && e.message) || String(e);
      }
      return out;
    });
  }

  // Бланк Матав хранит текст страницы и шрифты НЕСЖАТЫМИ — около 80% его веса (117
  // из 149 КБ). Перед сохранением подписанного бланка упаковываем такие потоки (Flate,
  // без потерь: то же содержимое, страница рисуется пиксель в пиксель так же) — пара
  // бланков в письме ~515 → ~270 КБ, в лимит вложений EmailJS (тариф Personal —
  // 500 КБ) с запасом. Не вышло (необычный файл) — сохраняем как есть: это только
  // размер, не содержание.
  function deflateRaw(pdf) {
    try {
      var L = window.PDFLib, ctx = pdf.context;
      if (!L || !L.PDFRawStream || !L.PDFName || typeof ctx.flateStream !== 'function') return;
      var FILTER = L.PDFName.of('Filter'), LENGTH = L.PDFName.of('Length'),
        PARMS = L.PDFName.of('DecodeParms'), TYPE = L.PDFName.of('Type'), META = L.PDFName.of('Metadata');
      ctx.enumerateIndirectObjects().forEach(function (pair) {
        var ref = pair[0], obj = pair[1];
        if (!(obj instanceof L.PDFRawStream)) return;
        var d = obj.dict;
        // уже сжатое, с параметрами декодирования или метаданные XMP — не трогаем
        if (d.get(FILTER) || d.get(PARMS) || d.get(TYPE) === META) return;
        var raw = obj.contents;
        if (!raw || raw.length < 256) return;
        var z = ctx.flateStream(raw);
        if (z.contents.length >= raw.length) return;
        d.entries().forEach(function (kv) {
          if (kv[0] !== LENGTH && kv[0] !== FILTER) z.dict.set(kv[0], kv[1]);
        });
        ctx.assign(ref, z);
      });
    } catch (e) { /* сохраняем без сжатия */ }
  }
  // метка «бланк подписан приложением» (ключевые слова PDF): загрузка такого файла как
  // нового бланка отклоняется — подписи встали бы поверх подписей
  var SIGNED_MARK = 'metapel-signed';
  function saveSmall(pdf) {
    try { pdf.setKeywords([SIGNED_MARK]); } catch (e) { /* без метки — не страшно */ }
    deflateRaw(pdf);
    return pdf.save();
  }
  // сжать уже подписанный файл (собранный до v6.14 без сжатия) — без потерь, только
  // размер; используется перед отправкой письма (лимит вложений EmailJS)
  function shrink(pdfU8) {
    return ensureLibs().then(function () {
      return window.PDFLib.PDFDocument.load(pdfU8, { updateMetadata: false });
    }).then(function (pdf) {
      deflateRaw(pdf);
      return pdf.save();
    });
  }

  // Штампует подпись (sigDataUrl PNG) в слоты с kind из kinds[] на baseU8.
  // opts.dateText + parsed.careDateAt -> печатает дату у תאריך (только при care-bottom).
  // Возвращает Uint8Array подписанного PDF.
  function stamp(baseU8, slots, kinds, sigDataUrl, opts) {
    opts = opts || {};
    return ensureLibs().then(function () {
      return window.PDFLib.PDFDocument.load(baseU8);
    }).then(function (pdf) {
      var page = pdf.getPages()[0];
      return pdf.embedPng(sigDataUrl).then(function (img) {
        slots.forEach(function (s) {
          if (kinds.indexOf(s.kind) >= 0) {
            page.drawImage(img, { x: s.cx - s.w / 2, y: s.cy - s.h / 2, width: s.w, height: s.h });
          }
        });
        if (opts.dateText && opts.dateAt && kinds.indexOf('care-bottom') >= 0) {
          return pdf.embedFont(window.PDFLib.StandardFonts.Helvetica).then(function (font) {
            page.drawText(opts.dateText, { x: opts.dateAt.x, y: opts.dateAt.y, size: 9, font: font });
            return saveSmall(pdf);
          });
        }
        return saveSmall(pdf);
      });
    });
  }

  // Штампует РАЗНЫЕ подписи по слотам (режим «по одному месту»).
  // pairs: [{slot, sigDataUrl}]. Одинаковые подписи переиспользуют один embedPng.
  function stampMulti(baseU8, pairs, opts) {
    opts = opts || {};
    return ensureLibs().then(function () {
      return window.PDFLib.PDFDocument.load(baseU8);
    }).then(function (pdf) {
      var page = pdf.getPages()[0];
      var cache = {};
      var chain = Promise.resolve();
      pairs.forEach(function (p) {
        chain = chain.then(function () {
          var pe = cache[p.sigDataUrl] ? Promise.resolve(cache[p.sigDataUrl])
            : pdf.embedPng(p.sigDataUrl).then(function (im) { cache[p.sigDataUrl] = im; return im; });
          return pe.then(function (img) {
            var s = p.slot;
            page.drawImage(img, { x: s.cx - s.w / 2, y: s.cy - s.h / 2, width: s.w, height: s.h });
          });
        });
      });
      return chain.then(function () {
        if (opts.dateText && opts.dateAt) {
          return pdf.embedFont(window.PDFLib.StandardFonts.Helvetica).then(function (font) {
            page.drawText(opts.dateText, { x: opts.dateAt.x, y: opts.dateAt.y, size: 9, font: font });
            return saveSmall(pdf);
          });
        }
        return saveSmall(pdf);
      });
    });
  }

  // Рендерит первую страницу PDF в canvas (для предпросмотра).
  // Тоже отдаём pdf.js КОПИЮ: иначе после предпросмотра те же байты «опустеют»
  // и сохранённый подписанный PDF окажется битым.
  // pdf.js не разрешает две отрисовки в один canvas одновременно («Cannot use the
  // same canvas during multiple render() operations»): новый предпросмотр, открытый
  // до окончания прошлого (медленный компьютер, быстрое «Отмена» и повторная
  // подпись), отменяет незаконченную отрисовку, а отмена ошибкой не считается.
  function render(pdfU8, canvas, scale) {
    var gen = canvas.__tsRenderGen = (canvas.__tsRenderGen || 0) + 1;
    if (canvas.__tsRenderTask) {
      try { canvas.__tsRenderTask.cancel(); } catch (e) { /* уже завершена */ }
      canvas.__tsRenderTask = null;
    }
    return ensureLibs().then(function () {
      return window.pdfjsLib.getDocument({ data: pdfU8.slice(0), isEvalSupported: false }).promise;
    }).then(function (doc) {
      return doc.getPage(1);
    }).then(function (page) {
      if (gen !== canvas.__tsRenderGen) return; // уже начата более новая отрисовка
      var vp = page.getViewport({ scale: scale || 1.3 });
      canvas.width = vp.width; canvas.height = vp.height;
      var task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      canvas.__tsRenderTask = task;
      return task.promise.then(function () {
        if (canvas.__tsRenderTask === task) canvas.__tsRenderTask = null;
      }, function (e) {
        if (canvas.__tsRenderTask === task) canvas.__tsRenderTask = null;
        if (e && (e.name === 'RenderingCancelledException' || /cancel/i.test(e.message || ''))) return;
        throw e;
      });
    });
  }

  return {
    // уровень API модуля: app.js проверяет его и отказывается подписывать со старой
    // копией из кэша (2 = Claims с местами метапелет по дням и полем slot.day;
    // 3 = inspect / shrink / метка подписанного бланка, v6.14)
    apiLevel: 3,
    ensureLibs: ensureLibs,
    parse: parse,
    parseMonth: parseMonth,
    inspect: inspect,
    shrink: shrink,
    stamp: stamp,
    stampMulti: stampMulti,
    render: render,
    computeSlots: computeSlots, // экспортируется для модульных тестов (чистая функция)
    u8FromDataUrl: u8FromDataUrl,
    bytesToDataUrl: bytesToDataUrl
  };
})();
