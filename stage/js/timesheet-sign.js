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

  // лениво подгружает pdf.js + pdf-lib (один раз)
  function ensureLibs() {
    if (loaded) return Promise.resolve();
    if (loadingP) return loadingP;
    loadingP = loadScript(PDFJS).then(function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
      return loadScript(PDFLIB);
    }).then(function () { loaded = true; });
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
  function computeSlots(items) {
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
    var famBlock = findOne(items, /משפחה/);
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

    // недели: новая начинается с воскресенья (ראשון) либо с первой строки
    var weeks = [], cur = null;
    rows.forEach(function (r) {
      if (cur === null || r.dow === 0) { cur = { rows: [] }; weeks.push(cur); }
      cur.rows.push(r);
    });
    weeks.forEach(function (w) {
      var ys = w.rows.map(function (r) { return r.y; });
      w.yTop = Math.max.apply(null, ys);
      w.yBot = Math.min.apply(null, ys);
      w.work = w.rows.some(function (r) { return r.hours > 0; });
    });

    // нижние под-подписи (метка תאריך / חתימה / שם), строка ~ на 13pt ниже заголовков блоков
    var subY = careBlock ? careBlock.y - 14 : 150;
    var careSig = null, careDate = null;
    items.forEach(function (it) {
      if (Math.abs(it.y - subY) > 4) return;
      if (/^חתימה$/.test(it.s) && it.x > 250 && it.x < 360) careSig = it;
      if (/^תאריך$/.test(it.s) && it.x > 200 && it.x < 290) careDate = it;
    });

    var slots = [];
    work.forEach(function (r) {
      slots.push({ kind: 'care-day', cx: careX, cy: r.y + 2, w: 46, h: 11, label: 'день ' + r.num });
    });
    weeks.filter(function (w) { return w.work; }).forEach(function (w, i) {
      slots.push({ kind: 'care-week', cx: weekX, cy: (w.yTop + w.yBot) / 2, w: 46, h: 20, label: 'неделя ' + (i + 1) });
    });
    var csx = careSig ? careSig.x + careSig.w / 2 : 320;
    var csy = careSig ? careSig.y + 12 : 162;
    slots.push({ kind: 'care-bottom', cx: csx, cy: csy, w: 52, h: 16, label: 'подтверждение метапеля' });
    var fcx = famBlock ? famBlock.x + famBlock.w / 2 : 500;
    slots.push({ kind: 'family', cx: fcx, cy: (careBlock ? careBlock.y - 2 : 162), w: 52, h: 16, label: 'подпись семьи за Григория' });

    return {
      slots: slots,
      workDays: work.map(function (r) { return r.num; }),
      weekCount: weeks.filter(function (w) { return w.work; }).length,
      careDateAt: careDate ? { x: careDate.x - 6, y: careDate.y + 10 } : null
    };
  }

  // Парсит PDF (Uint8Array) первой страницы -> {slots, workDays, weekCount, careDateAt}
  function parse(pdfU8) {
    return ensureLibs().then(function () {
      return window.pdfjsLib.getDocument({ data: pdfU8, isEvalSupported: false }).promise;
    }).then(function (doc) {
      return doc.getPage(1);
    }).then(function (page) {
      return page.getTextContent().then(function (tc) {
        var items = tc.items.map(function (it) {
          return { s: String(it.str).trim(), x: it.transform[4], y: it.transform[5], w: it.width };
        }).filter(function (it) { return it.s !== ''; });
        return computeSlots(items);
      });
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
            return pdf.save();
          });
        }
        return pdf.save();
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
            return pdf.save();
          });
        }
        return pdf.save();
      });
    });
  }

  // Рендерит первую страницу PDF в canvas (для предпросмотра)
  function render(pdfU8, canvas, scale) {
    return ensureLibs().then(function () {
      return window.pdfjsLib.getDocument({ data: pdfU8, isEvalSupported: false }).promise;
    }).then(function (doc) {
      return doc.getPage(1);
    }).then(function (page) {
      var vp = page.getViewport({ scale: scale || 1.3 });
      canvas.width = vp.width; canvas.height = vp.height;
      return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    });
  }

  return {
    ensureLibs: ensureLibs,
    parse: parse,
    stamp: stamp,
    stampMulti: stampMulti,
    render: render,
    computeSlots: computeSlots, // экспортируется для модульных тестов (чистая функция)
    u8FromDataUrl: u8FromDataUrl,
    bytesToDataUrl: bytesToDataUrl
  };
})();
