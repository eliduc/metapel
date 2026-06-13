/*
 * MetapelCalc — чистый движок расчётов выплат (без DOM).
 * Все функции принимают «сегодня» параметром, чтобы движок был
 * тестируемым и переносимым в Android-версию.
 * Даты — строки ISO 'YYYY-MM-DD' (сравниваются как строки).
 */
window.MetapelCalc = (function () {
  'use strict';

  var MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  var MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  var WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  // «заплатить … в среду / во вторник»
  var WEEKDAYS_ACC = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду',
    'в четверг', 'в пятницу', 'в субботу'];

  // ---------- даты ----------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseISO(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function toISO(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function mkDate(y, m, day) { return y + '-' + pad2(m) + '-' + pad2(day); }

  function addDays(iso, n) {
    var d = parseISO(iso);
    d.setDate(d.getDate() + n);
    return toISO(d);
  }

  // a - b, в днях
  function diffDays(a, b) {
    return Math.round((parseISO(a) - parseISO(b)) / 86400000);
  }

  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); } // m: 1..12

  function clampDay(y, m, day) { return Math.min(day, daysInMonth(y, m)); }

  // дата через n лет с тем же днём/месяцем
  function addYears(iso, n) {
    var d = parseISO(iso);
    return mkDate(d.getFullYear() + n, d.getMonth() + 1,
      clampDay(d.getFullYear() + n, d.getMonth() + 1, d.getDate()));
  }

  function addMonthsISO(iso, n) {
    var d = parseISO(iso);
    var m0 = d.getMonth() + n;
    var y = d.getFullYear() + Math.floor(m0 / 12);
    var m = (m0 % 12 + 12) % 12 + 1;
    return mkDate(y, m, clampDay(y, m, d.getDate()));
  }

  function countSaturdays(y, m, fromDay, toDay) {
    fromDay = fromDay || 1;
    toDay = toDay || daysInMonth(y, m);
    var c = 0;
    for (var d = fromDay; d <= toDay; d++) {
      if (new Date(y, m - 1, d).getDay() === 6) c++;
    }
    return c;
  }

  // ---------- форматирование ----------

  function round2(n) { return Math.round(n * 100) / 100; }

  function fmtMoney(n) {
    var r = round2(n);
    var s = r.toLocaleString('ru-RU', {
      minimumFractionDigits: (r % 1 === 0 ? 0 : 2),
      maximumFractionDigits: 2
    });
    return s + ' ₪';
  }

  function fmtPct(n) { return String(n).replace('.', ',') + '%'; }

  function fmtDate(iso) {
    var d = parseISO(iso);
    return d.getDate() + ' ' + MONTHS_GEN[d.getMonth()] + ' ' + d.getFullYear();
  }

  function fmtDateShort(iso) {
    var d = parseISO(iso);
    return WEEKDAYS_SHORT[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS_GEN[d.getMonth()];
  }

  function monthLabel(y, m) { return MONTHS_NOM[m - 1] + ' ' + y; }

  function plural(n, one, few, many) {
    var n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  }

  function satWord(n) { return plural(n, 'суббота', 'субботы', 'суббот'); }

  // Простой хэш для пароля настроек — защита от случайного входа, не криптография.
  function hashString(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return 'h' + (h >>> 0).toString(16);
  }

  // ---------- настройки по умолчанию ----------

  function defaultSettings() {
    return {
      workerName: 'Джамшид',
      workerFullName: 'Джамшид Эргашев', // ФИО для текста расписок
      employerName: 'Григорий',
      employerFullName: 'Григорий Разумовский', // ФИО работодателя для расписок
      uiScale: 100, // размер текста, % (115 — крупный, 125 — очень крупный)
      passwordTtlMinutes: 10, // сколько минут не спрашивать пароль настроек повторно
      // Часы по уходу от Битуах Леуми (гмлат сиуд): организация по уходу
      // получает деньги за часы и платит метапелю свою часть зарплаты.
      // Пока часы не утверждены (approved=false) — зачёт 0, всю зарплату
      // платит семья. После утверждения зачёт = hoursPerWeek × hourValueMonth;
      // максимум 26 ч/нед (уровень 6, иностранный работник), час ≈ 241 ₪/мес (2025).
      bl: {
        approved: false,    // часы утверждены (отмечается на главном экране)
        hoursPerWeek: 26,   // сколько часов/нед применять, когда утверждены
        hourValueMonth: 241,
        applyToSocial: true // уменьшать также взносы, пикадон и хавраа
      },
      // параметры калькулятора окончания работы (раздел 6 памятки)
      final: {
        severanceFullPercent: 8.33, // полное выходное пособие, %/мес от базы
        vacationDaysPerYear: 14,    // дней отпуска в год (первые 5 лет)
        vacationDayRate: 258        // компенсация за день отпуска, ₪
      },
      startDate: '2026-06-10',
      passwordHash: hashString('1234'),
      // архив расписок: приватный репозиторий GitHub (Contents API)
      sync: { enabled: false, repo: 'eliduc/metapel-data', token: '' },
      types: {
        salary: {
          enabled: true, label: 'Зарплата',
          net: 6500, shabbatRate: 440, dayOfMonth: 8, noticeDays: 3,
          defaultMethod: 'transfer'
        },
        pocket: {
          enabled: true, label: 'Карманные (дмей кис)',
          amount: 100, weekday: 0, noticeDays: 1,
          defaultMethod: 'cash'
        },
        insurance: {
          enabled: true, label: 'Мед. страховка',
          amount: 300, dayOfMonth: 8, noticeDays: 3,
          defaultMethod: 'transfer'
        },
        bituach: {
          enabled: true, label: 'Битуах Леуми',
          ratePercent: 3.6, grossBase: 6443.85,
          frequency: 'monthly', dayOfMonth: 8, quarterDay: 20, noticeDays: 5,
          defaultMethod: 'transfer'
        },
        pikadon: {
          enabled: true, label: 'Пикадон (пенсия + компенсация)',
          pensionPercent: 6.5, severancePercent: 6, grossBase: 6443.85,
          fromMonth: 7, dayOfMonth: 8, noticeDays: 5,
          defaultMethod: 'transfer'
        },
        havraa: {
          enabled: true, label: 'Дмей хавраа',
          dayRate: 418,
          tiers: [
            { from: 1, to: 1, days: 5 },
            { from: 2, to: 3, days: 6 },
            { from: 4, to: 10, days: 7 },
            { from: 11, to: 99, days: 7 }
          ],
          noticeDays: 14,
          defaultMethod: 'transfer'
        },
        visa: {
          enabled: true, label: 'Продление визы',
          amount: 205, noticeDays: 14,
          defaultMethod: 'transfer'
        },
        tagid: {
          enabled: true, label: 'Корпорация (тагид)',
          amount: 840, noticeDays: 14,
          defaultMethod: 'transfer'
        },
        permit: {
          enabled: true, label: 'Продление разрешения',
          amount: 370, intervalYears: 4, noticeDays: 14,
          defaultMethod: 'transfer'
        }
      }
    };
  }

  // ---------- зачёт часов Битуах Леуми ----------

  // сумма, которую покрывает организация по уходу за счёт часов БЛ, ₪/мес
  function blMonthlyOffset(settings) {
    var bl = settings.bl || {};
    if (!bl.approved) return 0; // часы ещё не утверждены — зачёта нет
    return round2((bl.hoursPerWeek || 0) * (bl.hourValueMonth || 0));
  }

  // доля зарплаты, которую семья платит из своих средств (0..1)
  function blFamilyShare(settings) {
    var net = settings.types.salary.net;
    if (!net || net <= 0) return 1;
    var off = blMonthlyOffset(settings);
    if (off <= 0) return 1;
    if (off >= net) return 0;
    return (net - off) / net;
  }

  function blSocialOffset(settings) {
    var bl = settings.bl || {};
    return bl.approved && bl.applyToSocial ? blMonthlyOffset(settings) : 0;
  }

  // ---------- генерация вхождений ----------

  // Обходит отработанные календарные месяцы от даты начала работы,
  // пока 1-е число месяца <= endISO. cb(y, m, fromDay) — fromDay > 1
  // только в первом (частичном) месяце.
  function eachWorkedMonth(startISO, endISO, cb) {
    var sd = parseISO(startISO);
    var y = sd.getFullYear(), m = sd.getMonth() + 1;
    while (mkDate(y, m, 1) <= endISO) {
      var fromDay = (y === sd.getFullYear() && m === sd.getMonth() + 1) ? sd.getDate() : 1;
      cb(y, m, fromDay);
      m++;
      if (m > 12) { m = 1; y++; }
    }
  }

  function nextMonthDue(y, m, dayOfMonth) {
    var dy = m === 12 ? y + 1 : y;
    var dm = m === 12 ? 1 : m + 1;
    return mkDate(dy, dm, clampDay(dy, dm, dayOfMonth));
  }

  function genSalary(t, start, end, out, blOff, blSettings) {
    eachWorkedMonth(start, end, function (y, m, fromDay) {
      var due = nextMonthDue(y, m, t.dayOfMonth);
      if (due > end) return;
      var dim = daysInMonth(y, m);
      var workedDays = dim - fromDay + 1;
      var sats = countSaturdays(y, m, fromDay);
      var netPart = workedDays === dim ? t.net : round2(t.net * workedDays / dim);
      var offPart = workedDays === dim ? blOff : round2(blOff * workedDays / dim);
      var familyNet = Math.max(0, round2(netPart - offPart));
      var shabbat = sats * t.shabbatRate;
      var breakdown = [];
      if (workedDays === dim) {
        breakdown.push('Нетто за месяц: ' + fmtMoney(t.net));
      } else {
        breakdown.push('Нетто пропорционально (с ' + fromDay + '-го числа): ' +
          fmtMoney(t.net) + ' × ' + workedDays + '/' + dim + ' дней = ' + fmtMoney(netPart));
      }
      if (offPart > 0) {
        breakdown.push('Часы Битуах Леуми: ' + blSettings.hoursPerWeek + ' ч/нед × ' +
          fmtMoney(blSettings.hourValueMonth) + (workedDays === dim ? '' : ' (пропорц.)') +
          ' = − ' + fmtMoney(offPart) + ' (платит организация по уходу)');
        breakdown.push('Доплата семьи: ' + fmtMoney(familyNet));
      }
      breakdown.push('Шабат: ' + sats + ' ' + satWord(sats) + ' × ' +
        fmtMoney(t.shabbatRate) + ' = ' + fmtMoney(shabbat));
      breakdown.push('Итого: ' + fmtMoney(familyNet + shabbat));
      out.push({
        id: 'salary-' + y + '-' + pad2(m),
        type: 'salary',
        title: 'Зарплата за ' + monthLabel(y, m),
        dueDate: due,
        amount: round2(familyNet + shabbat),
        breakdown: breakdown,
        // для пересчёта в диалоге оплаты
        satCount: sats, satRate: t.shabbatRate, netPart: familyNet
      });
    });
  }

  function genPocket(t, start, end, out) {
    var d = parseISO(start);
    while (d.getDay() !== t.weekday) d.setDate(d.getDate() + 1);
    while (toISO(d) <= end) {
      var iso = toISO(d);
      out.push({
        id: 'pocket-' + iso,
        type: 'pocket',
        title: 'Карманные деньги',
        dueDate: iso,
        amount: t.amount,
        breakdown: ['Еженедельные карманные (дмей кис): ' + fmtMoney(t.amount),
          'Выдаются каждое ' + WEEKDAYS[t.weekday] + ' (сверх зарплаты, по договорённости)']
      });
      d.setDate(d.getDate() + 7);
    }
  }

  function genInsurance(t, start, end, out) {
    var sd = parseISO(start);
    var y = sd.getFullYear(), m = sd.getMonth() + 1;
    while (true) {
      var due = mkDate(y, m, clampDay(y, m, t.dayOfMonth));
      if (due > end) break;
      if (due >= start) {
        out.push({
          id: 'insurance-' + y + '-' + pad2(m),
          type: 'insurance',
          title: 'Мед. страховка за ' + monthLabel(y, m),
          dueDate: due,
          amount: t.amount,
          breakdown: ['Страховка больничной кассы (Клалит/Маккаби/Леумит): ' +
            fmtMoney(t.amount) + ' в месяц']
        });
      }
      m++;
      if (m > 12) { m = 1; y++; }
    }
  }

  // база для взносов: брутто минус часть, которую покрывают часы БЛ
  // (взносы платятся только с доплаты из собственных средств семьи)
  function bituachBase(t, blOff) {
    return Math.max(0, round2(t.grossBase - blOff));
  }

  function bituachMonthly(t, blOff) {
    return round2(bituachBase(t, blOff) * t.ratePercent / 100);
  }

  function bituachBaseLine(t, blOff) {
    return blOff > 0
      ? 'База: ' + fmtMoney(t.grossBase) + ' − зачёт часов БЛ ' + fmtMoney(blOff) +
        ' = ' + fmtMoney(bituachBase(t, blOff)) + ' (взносы — только с доплаты семьи)'
      : null;
  }

  // При переключении частоты месяц/квартал оплаченные записи другого
  // режима остаются в журнале — учитываем их, чтобы не требовать
  // повторной оплаты тех же месяцев.
  function genBituach(t, start, end, out, paidLog, blOff) {
    paidLog = paidLog || {};
    if (t.frequency === 'quarterly') {
      genBituachQuarterly(t, start, end, out, paidLog, blOff);
      return;
    }
    eachWorkedMonth(start, end, function (y, m, fromDay) {
      var q = Math.floor((m - 1) / 3) + 1;
      if (paidLog['bituach-' + y + '-Q' + q]) return; // месяц покрыт оплаченным кварталом
      var due = nextMonthDue(y, m, t.dayOfMonth);
      if (due > end) return;
      var dim = daysInMonth(y, m);
      var workedDays = dim - fromDay + 1;
      var full = bituachMonthly(t, blOff);
      if (full <= 0) return; // часы БЛ покрывают всю базу
      var amount = workedDays === dim ? full : round2(full * workedDays / dim);
      var breakdown = [];
      var baseLine = bituachBaseLine(t, blOff);
      if (baseLine) breakdown.push(baseLine);
      breakdown.push('Битуах Леуми: ' + fmtPct(t.ratePercent) + ' × ' +
        fmtMoney(bituachBase(t, blOff)) + ' = ' + fmtMoney(full));
      if (workedDays !== dim) {
        breakdown.push('Пропорционально ' + workedDays + '/' + dim + ' дней: ' + fmtMoney(amount));
      }
      out.push({
        id: 'bituach-' + y + '-' + pad2(m),
        type: 'bituach',
        title: 'Битуах Леуми за ' + monthLabel(y, m),
        dueDate: due,
        amount: amount,
        breakdown: breakdown
      });
    });
  }

  function genBituachQuarterly(t, start, end, out, paidLog, blOff) {
    paidLog = paidLog || {};
    if (bituachMonthly(t, blOff) <= 0) return; // часы БЛ покрывают всю базу
    var months = {}; // 'y-m' -> {y, m, amount}
    eachWorkedMonth(start, end, function (y, m, fromDay) {
      if (paidLog['bituach-' + y + '-' + pad2(m)]) return; // месяц уже оплачен помесячно
      var dim = daysInMonth(y, m);
      var workedDays = dim - fromDay + 1;
      var full = bituachMonthly(t, blOff);
      months[y + '-' + m] = {
        y: y, m: m,
        amount: workedDays === dim ? full : round2(full * workedDays / dim)
      };
    });
    var quarters = {}; // 'y-q' -> {y, q, items[]}
    Object.keys(months).forEach(function (k) {
      var it = months[k];
      var q = Math.floor((it.m - 1) / 3) + 1;
      var qk = it.y + '-' + q;
      (quarters[qk] = quarters[qk] || { y: it.y, q: q, items: [] }).items.push(it);
    });
    Object.keys(quarters).sort().forEach(function (qk) {
      var qu = quarters[qk];
      var dueM = qu.q * 3 + 1; // месяц после квартала
      var dueY = qu.y;
      if (dueM > 12) { dueM = 1; dueY++; }
      var due = mkDate(dueY, dueM, clampDay(dueY, dueM, t.quarterDay));
      if (due > end) return;
      var total = 0;
      var breakdown = [];
      var baseLine = bituachBaseLine(t, blOff);
      if (baseLine) breakdown.push(baseLine);
      breakdown.push('Битуах Леуми: ' + fmtPct(t.ratePercent) + ' × ' +
        fmtMoney(bituachBase(t, blOff)) + ' в месяц');
      qu.items.forEach(function (it) {
        total = round2(total + it.amount);
        breakdown.push(MONTHS_NOM[it.m - 1] + ': ' + fmtMoney(it.amount));
      });
      breakdown.push('Итого за квартал: ' + fmtMoney(total));
      out.push({
        id: 'bituach-' + qu.y + '-Q' + qu.q,
        type: 'bituach',
        title: 'Битуах Леуми за ' + qu.q + '-й квартал ' + qu.y,
        dueDate: due,
        amount: total,
        breakdown: breakdown
      });
    });
  }

  function genPikadon(t, start, end, out, blOff) {
    var pikStart = addMonthsISO(start, t.fromMonth - 1); // начало 7-го месяца работы
    var base = Math.max(0, round2(t.grossBase - blOff));
    if (base <= 0) return; // часы БЛ покрывают всю базу — отчисления у организации
    var pension = round2(base * t.pensionPercent / 100);
    var severance = round2(base * t.severancePercent / 100);
    var amount = round2(pension + severance);
    eachWorkedMonth(start, end, function (y, m, fromDay) {
      var monthEnd = mkDate(y, m, daysInMonth(y, m));
      if (monthEnd < pikStart) return; // ещё не 7-й месяц
      var due = nextMonthDue(y, m, t.dayOfMonth);
      if (due > end) return;
      var breakdown = [];
      if (blOff > 0) {
        breakdown.push('База: ' + fmtMoney(t.grossBase) + ' − зачёт часов БЛ ' +
          fmtMoney(blOff) + ' = ' + fmtMoney(base) +
          ' (за свою часть отчисляет организация по уходу)');
      }
      breakdown.push('Пенсия: ' + fmtPct(t.pensionPercent) + ' × ' + fmtMoney(base) + ' = ' + fmtMoney(pension));
      breakdown.push('Компенсация: ' + fmtPct(t.severancePercent) + ' × ' + fmtMoney(base) + ' = ' + fmtMoney(severance));
      breakdown.push('Итого: ' + fmtMoney(amount));
      breakdown.push('Платится с ' + t.fromMonth + '-го месяца работы (с ' + fmtDate(pikStart) + ') в депозит «пикадон»');
      out.push({
        id: 'pikadon-' + y + '-' + pad2(m),
        type: 'pikadon',
        title: 'Пикадон за ' + monthLabel(y, m),
        dueDate: due,
        amount: amount,
        breakdown: breakdown
      });
    });
  }

  function havraaTier(t, yearN) {
    for (var i = 0; i < t.tiers.length; i++) {
      if (yearN >= t.tiers[i].from && yearN <= t.tiers[i].to) return t.tiers[i];
    }
    return t.tiers[t.tiers.length - 1];
  }

  function genHavraa(t, start, end, out, familyShare) {
    if (familyShare <= 0) return; // полностью у организации по уходу
    for (var k = 1; ; k++) {
      var due = addYears(start, k);
      if (due > end) break;
      var tier = havraaTier(t, k);
      var full = round2(tier.days * t.dayRate);
      var amount = round2(full * familyShare);
      var breakdown = [
        'Оздоровительные: ' + tier.days + ' ' + plural(tier.days, 'день', 'дня', 'дней') +
          ' × ' + fmtMoney(t.dayRate) + ' = ' + fmtMoney(full)
      ];
      if (familyShare < 1) {
        breakdown.push('Доля семьи в зарплате: ' + String(round2(familyShare * 100)).replace('.', ',') +
          '% → ' + fmtMoney(amount) + ' (остальное — организация по уходу)');
      }
      breakdown.push('Выплачивается после каждого полного года работы (годовщина: ' + fmtDate(due) + ')');
      out.push({
        id: 'havraa-' + k,
        type: 'havraa',
        title: 'Дмей хавраа — за ' + k + '-й год работы',
        dueDate: due,
        amount: amount,
        breakdown: breakdown
      });
    }
  }

  function genYearly(typeKey, t, start, end, out, titleFn, breakdownFn, intervalYears) {
    var step = intervalYears || 1;
    for (var k = step; ; k += step) {
      var due = addYears(start, k);
      if (due > end) break;
      out.push({
        id: typeKey + '-' + parseISO(due).getFullYear(),
        type: typeKey,
        title: titleFn(due),
        dueDate: due,
        amount: t.amount,
        breakdown: breakdownFn(due)
      });
    }
  }

  /**
   * Генерирует все вхождения платежей от даты начала работы
   * до today + horizonDays. Прошлые неоплаченные остаются видимыми
   * (статус overdue — напоминание каждый день).
   * paidLog (опционально) — журнал оплат: нужен Битуах Леуми, чтобы
   * при смене частоты месяц/квартал не требовать оплаченное повторно.
   */
  function generateOccurrences(settings, todayISO, horizonDays, paidLog) {
    if (horizonDays == null) horizonDays = 60;
    var end = addDays(todayISO, horizonDays);
    var start = settings.startDate;
    var t = settings.types;
    var out = [];
    var blOff = blMonthlyOffset(settings);
    var blSoc = blSocialOffset(settings);
    var famShare = (settings.bl && settings.bl.approved && settings.bl.applyToSocial)
      ? blFamilyShare(settings) : 1;
    if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
      if (t.salary.enabled) genSalary(t.salary, start, end, out, blOff, settings.bl || {});
      if (t.pocket.enabled) genPocket(t.pocket, start, end, out);
      if (t.insurance.enabled) genInsurance(t.insurance, start, end, out);
      if (t.bituach.enabled) genBituach(t.bituach, start, end, out, paidLog, blSoc);
      if (t.pikadon.enabled) genPikadon(t.pikadon, start, end, out, blSoc);
      if (t.havraa.enabled) genHavraa(t.havraa, start, end, out, famShare);
      if (t.visa.enabled) {
        genYearly('visa', t.visa, start, end, out,
          function (due) { return 'Продление визы (' + parseISO(due).getFullYear() + ')'; },
          function () {
            return ['Сбор за продление визы: ' + fmtMoney(t.visa.amount) + ' (раз в год)',
              'Платится в Управление по делам населения и иммиграции'];
          });
      }
      if (t.tagid.enabled) {
        genYearly('tagid', t.tagid, start, end, out,
          function (due) { return 'Корпорация — тагид (' + parseISO(due).getFullYear() + ')'; },
          function () {
            return ['Регистрация в лицензированной корпорации: ' + fmtMoney(t.tagid.amount) +
              ' в год (70 × 12)'];
          });
      }
      if (t.permit.enabled) {
        genYearly('permit', t.permit, start, end, out,
          function (due) { return 'Продление разрешения (' + parseISO(due).getFullYear() + ')'; },
          function () {
            return ['Сбор за продление разрешения: ' + fmtMoney(t.permit.amount) +
              ' (раз в ' + t.permit.intervalYears + ' года)'];
          },
          t.permit.intervalYears);
      }
    }
    out.sort(function (a, b) {
      return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : (a.type < b.type ? -1 : 1);
    });
    return out;
  }

  // ---------- калькулятор окончания работы ----------

  // месяцев между датами, с дробной частью (день ≈ 1/30 месяца)
  function monthsBetween(aISO, bISO) {
    if (bISO < aISO) return 0;
    var a = parseISO(aISO), b = parseISO(bISO);
    var months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    months += (b.getDate() - a.getDate()) / 30;
    return Math.max(0, round2(months));
  }

  /**
   * Финальный расчёт при окончании трудоустройства (раздел 6 памятки).
   * reason: 'employer' (увольняет работодатель) | 'worker' (уходит сам).
   * Возвращает { breakdown: [{text, amount}], total, warnings: [] }.
   */
  function calcFinalSettlement(settings, endISO, reason, usedVacationDays) {
    var t = settings.types;
    var fin = settings.final || {};
    var start = settings.startDate;
    var used = usedVacationDays || 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endISO) || endISO < start) {
      return { breakdown: [], total: 0,
        warnings: ['Дата окончания раньше даты начала работы — проверьте дату.'] };
    }
    var lines = [];
    var warnings = [];
    var blOff = blMonthlyOffset(settings);
    var blSoc = blSocialOffset(settings);
    var famShare = (settings.bl && settings.bl.approved && settings.bl.applyToSocial)
      ? blFamilyShare(settings) : 1;
    var base = Math.max(0, round2(t.pikadon.grossBase - blSoc));
    var months = monthsBetween(start, endISO);

    // 1. зарплата за последний неполный месяц (+ шабат по календарю)
    var e = parseISO(endISO);
    var y = e.getFullYear(), m = e.getMonth() + 1, endDay = e.getDate();
    var dim = daysInMonth(y, m);
    var s0 = parseISO(start);
    var fromDay = (y === s0.getFullYear() && m === s0.getMonth() + 1) ? s0.getDate() : 1;
    var workedDays = endDay - fromDay + 1;
    var netPart = round2(t.salary.net * workedDays / dim);
    var offPart = round2(blOff * workedDays / dim);
    var famNet = Math.max(0, round2(netPart - offPart));
    var sats = countSaturdays(y, m, fromDay, endDay);
    var lastSalary = round2(famNet + sats * t.salary.shabbatRate);
    lines.push({
      text: 'Зарплата за ' + monthLabel(y, m) + ' по ' + endDay + '-е (' + workedDays +
        ' дн.' + (offPart > 0 ? ', с зачётом часов БЛ −' + fmtMoney(offPart) : '') +
        ') + шабат: ' + sats + ' ' + satWord(sats) + ' × ' + fmtMoney(t.salary.shabbatRate),
      amount: lastSalary
    });

    // 2. выходное пособие
    var pikStart = addMonthsISO(start, t.pikadon.fromMonth - 1);
    if (reason === 'employer') {
      var fullPct = fin.severanceFullPercent || 8.33;
      var full = round2(base * fullPct / 100 * months);
      var pikMonths = monthsBetween(pikStart, endISO);
      var deposited = round2(base * t.pikadon.severancePercent / 100 * pikMonths);
      var doplata = Math.max(0, round2(full - deposited));
      lines.push({
        text: 'Доплата до полного выходного пособия: ' + fmtPct(fullPct) + ' × ' +
          fmtMoney(base) + ' × ' + String(months).replace('.', ',') + ' мес = ' + fmtMoney(full) +
          ' − накоплено в пикадоне (' + fmtPct(t.pikadon.severancePercent) + ' × ' +
          String(pikMonths).replace('.', ',') + ' мес) ' + fmtMoney(deposited),
        amount: doplata
      });
      if (months < 12) {
        warnings.push('Стаж меньше года: право на выходное пособие обычно возникает после года работы — уточните у специалиста.');
      }
    } else {
      lines.push({
        text: 'Уход по собственному желанию: компенсация ' + fmtPct(t.pikadon.severancePercent) +
          ' уже накоплена в пикадоне — доплата не требуется',
        amount: 0
      });
    }

    // 3. неиспользованный отпуск
    var vacPerYear = fin.vacationDaysPerYear || 14;
    var vacRate = fin.vacationDayRate || 258;
    var accrued = round2(vacPerYear * months / 12);
    var remaining = Math.max(0, round2(accrued - used));
    var vacAmount = round2(remaining * vacRate * famShare);
    lines.push({
      text: 'Неиспользованный отпуск: накоплено ' + String(accrued).replace('.', ',') +
        ' − использовано ' + used + ' = ' + String(remaining).replace('.', ',') + ' дн. × ' +
        fmtMoney(vacRate) + (famShare < 1 ? ' × доля семьи' : ''),
      amount: vacAmount
    });

    // 4. хавраа за неполный последний год
    var yearsFull = Math.floor(months / 12);
    var frac = round2((months - yearsFull * 12) / 12 * 100) / 100;
    if (frac > 0) {
      var tier = havraaTier(t.havraa, yearsFull + 1);
      var hav = round2(tier.days * t.havraa.dayRate * frac * famShare);
      lines.push({
        text: 'Хавраа за неполный ' + (yearsFull + 1) + '-й год: ' + tier.days + ' дн. × ' +
          fmtMoney(t.havraa.dayRate) + ' × ' + String(round2(frac * 100)).replace('.', ',') + '%' +
          (famShare < 1 ? ' × доля семьи' : ''),
        amount: hav
      });
    }

    // 5. пикадон за последний неполный месяц
    if (base > 0 && monthsBetween(pikStart, endISO) > 0) {
      var pikPct = t.pikadon.pensionPercent + t.pikadon.severancePercent;
      var pikPart = round2(base * pikPct / 100 * workedDays / dim);
      lines.push({
        text: 'Пикадон за последний месяц: ' + fmtPct(round2(pikPct)) + ' × ' + fmtMoney(base) +
          ' × ' + workedDays + '/' + dim + ' дн. (внести в депозит до закрытия)',
        amount: pikPart
      });
    }

    var total = round2(lines.reduce(function (sum, l) { return sum + l.amount; }, 0));
    warnings.push('Расчёт ориентировочный (т.л.х.): перед окончательным расчётом сверьтесь со специалистом. Не забудьте закрыть депозит «пикадон» и «тик масиким» в Битуах Леуми.');
    return { breakdown: lines, total: total, warnings: warnings };
  }

  /**
   * Статус вхождения:
   *  paid     — есть отметка об оплате;
   *  overdue  — срок прошёл, не оплачено (напоминать каждый день);
   *  due      — сегодня внутри окна напоминания (noticeDays до срока);
   *  upcoming — будущий платёж вне окна.
   */
  function getStatus(occ, log, todayISO, settings) {
    if (log && log[occ.id]) return 'paid';
    if (occ.dueDate < todayISO) return 'overdue';
    var notice = settings.types[occ.type] ? settings.types[occ.type].noticeDays : 0;
    if (diffDays(occ.dueDate, todayISO) <= notice) return 'due';
    return 'upcoming';
  }

  return {
    MONTHS_NOM: MONTHS_NOM,
    MONTHS_GEN: MONTHS_GEN,
    WEEKDAYS: WEEKDAYS,
    WEEKDAYS_ACC: WEEKDAYS_ACC,
    parseISO: parseISO,
    toISO: toISO,
    mkDate: mkDate,
    addDays: addDays,
    addYears: addYears,
    addMonthsISO: addMonthsISO,
    diffDays: diffDays,
    daysInMonth: daysInMonth,
    countSaturdays: countSaturdays,
    round2: round2,
    fmtMoney: fmtMoney,
    fmtPct: fmtPct,
    fmtDate: fmtDate,
    fmtDateShort: fmtDateShort,
    monthLabel: monthLabel,
    plural: plural,
    hashString: hashString,
    defaultSettings: defaultSettings,
    blMonthlyOffset: blMonthlyOffset,
    blFamilyShare: blFamilyShare,
    monthsBetween: monthsBetween,
    calcFinalSettlement: calcFinalSettlement,
    generateOccurrences: generateOccurrences,
    getStatus: getStatus
  };
})();
