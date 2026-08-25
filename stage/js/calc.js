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

  // 'YYYY-MM' → «июль 2026» (ключи помесячных сумм от Матав)
  function monthKeyLabel(key) { return monthLabel(+key.slice(0, 4), +key.slice(5)); }

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

  // статус табеля Битуах Леуми из флагов (чистая функция)
  function timesheetStatus(rec) {
    if (rec && rec.sentMarked) return 'sent';
    if (rec && rec.caregiverSigned && rec.familySigned) return 'full';
    if (rec && rec.caregiverSigned) return 'caregiver';
    if (rec && rec.familySigned) return 'family';
    return 'unsigned';
  }

  // Бланков в месяце может быть НЕСКОЛЬКО (с 08/2026 Матав присылает два:
  // обычные часы + дополнительные от Claims Conference). Возвращает бланки
  // месяца в стабильном порядке загрузки: id = 'ts-<миллисекунды>', поэтому
  // строковая сортировка совпадает с хронологической.
  function timesheetsOfMonth(list, month) {
    return (list || []).filter(function (t) { return t && t.month === month; })
      .sort(function (a, b) { return String(a.id) < String(b.id) ? -1 : 1; });
  }

  // Совокупный статус месяца — по САМОМУ ОТСТАЮЩЕМУ бланку: месяц «полностью
  // подписан» или «отослан», только когда таковы ВСЕ его бланки.
  function timesheetGroupStatus(mates) {
    var rank = { unsigned: 0, caregiver: 1, family: 1, full: 2, sent: 3 };
    var worst = null, worstRank = 99;
    (mates || []).forEach(function (t) {
      var st = timesheetStatus(t);
      if (rank[st] < worstRank) { worstRank = rank[st]; worst = st; }
    });
    return worst || 'unsigned';
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
      // Гмлат сиуд от Матав: Матав платит работнику ЧАСТЬ зарплаты за счёт пособия
      // по уходу, остальное доплачивает семья. Сумма приходит 9-го числа и КАЖДЫЙ
      // МЕСЯЦ РАЗНАЯ, поэтому хранится ПОМЕСЯЧНО. Единое число применялось ко всем
      // месяцам сразу и уже дважды исказило расчёт (правка задним числом пересчитала
      // июнь; квартальный Битуах считался одной цифрой за три месяца).
      // approved=false → зачёта нет, всю зарплату платит семья.
      bl: {
        approved: false,     // Матав платит часть (отмечается на главном экране)
        matavAmount: 0,      // ЛЕГАСИ: одна сумма на все месяцы; только для старых
                             // конфигов, где помесячных данных ещё нет
        matavByMonth: {},    // ФАКТ: 'YYYY-MM' → сколько Матав заплатил за этот месяц, ₪
        applyToSocial: true  // уменьшать также взносы, пикадон и хавраа
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
      // авто-отправка табелей в Матав (EmailJS); ключи только на устройстве
      emailjs: { serviceId: '', templateId: '', publicKey: '', recipient: '' },
      types: {
        salary: {
          enabled: true, label: 'Зарплата',
          net: 6500, shabbatRate: 440, dayOfMonth: 8, noticeDays: 3,
          defaultMethod: 'cash'
        },
        pocket: {
          enabled: true, label: 'Карманные (дмей кис)',
          amount: 100, weekday: 0, noticeDays: 1,
          defaultMethod: 'cash'
        },
        insurance: {
          enabled: true, label: 'Мед. страховка',
          // Страховку Григорий платит САМ и РАЗ В ГОД (вперёд): полис продлевается
          // 09.07 каждый год. frequency='annual' → одна выплата в год на renewalDate.
          // Поля amount/dayOfMonth остаются для помесячного режима (frequency='monthly').
          frequency: 'annual',
          amountAnnual: 3300, renewalDate: '2026-07-09',
          amount: 300, dayOfMonth: 8, noticeDays: 14,
          defaultMethod: 'cash'
        },
        bituach: {
          enabled: true, label: 'Битуах Леуми',
          ratePercent: 3.6, grossBase: 6443.85,
          frequency: 'monthly', dayOfMonth: 8, quarterDay: 20, noticeDays: 5,
          defaultMethod: 'cash'
        },
        pikadon: {
          enabled: true, label: 'Пикадон (пенсия + компенсация)',
          // компенсация откладывается по ПОЛНОЙ ставке 8.33% (а не 6%) — Григорию
          // 89 лет, сценарий «работодатель умер/дом престарелых → полное выходное
          // пособие» реален; безопаснее накопить сразу 8.33%. Итого 6.5%+8.33%=14.83%.
          pensionPercent: 6.5, severancePercent: 8.33, grossBase: 6443.85,
          fromMonth: 7, dayOfMonth: 8, noticeDays: 5,
          defaultMethod: 'cash'
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
          defaultMethod: 'cash'
        },
        visa: {
          // «Интер-виза» 205 ₪ — сбор ТОЛЬКО при выезде/въезде работника (поездка
          // домой), а не ежегодно. Поэтому авто-напоминание выключено по умолчанию;
          // включить вручную, когда работник реально выезжает.
          enabled: false, label: 'Виза (интер-виза, при выезде работника)',
          amount: 205, noticeDays: 14,
          defaultMethod: 'cash'
        },
        tagid: {
          enabled: true, label: 'Корпорация (тагид)',
          amount: 840, noticeDays: 14,
          defaultMethod: 'cash'
        },
        permit: {
          // Разрешение работодателя (היתר) для подопечного 85+ продлевается
          // АВТОМАТИЧЕСКИ и БЕСПЛАТНО — Григорию 89, поэтому напоминание выключено.
          // (intervalYears=1 — корректная ежегодная частота, если кто-то включит.)
          enabled: false, label: 'Продление разрешения (для 85+ — бесплатно)',
          amount: 370, intervalYears: 1, noticeDays: 14,
          defaultMethod: 'cash'
        }
      }
    };
  }

  // ---------- зачёт суммы от Матав (гмлат сиуд) ----------

  var YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function ymKey(y, m) { return y + '-' + pad2(m); }

  function isMonthMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  // ключи 'YYYY-MM' с пригодными значениями (число ≥ 0). Карта приходит из облака
  // как произвольный JSON, поэтому мусор отсеиваем везде, где на неё смотрим.
  function monthKeys(byMonth) {
    if (!isMonthMap(byMonth)) return [];
    return Object.keys(byMonth).filter(function (k) {
      var v = byMonth[k];
      return YM_RE.test(k) && typeof v === 'number' && !isNaN(v) && v >= 0;
    });
  }

  // «помесячных данных нет вовсе» — только это разрешает откат на легаси-число.
  // Карта с ключами, но без валидных (строка вместо числа, ключ '2026-6', массив),
  // пустой НЕ считается: помесячный режим уже включён, и подставлять единое число
  // нельзя — иначе одна цифра снова расползётся по всем месяцам.
  function monthMapEmpty(byMonth) {
    if (byMonth === undefined || byMonth === null) return true;
    if (!isMonthMap(byMonth)) return false; // массив/примитив — данные испорчены, не «пусто»
    return Object.keys(byMonth).length === 0;
  }

  /**
   * Фактическая сумма от Матав (гмлат сиуд) за КОНКРЕТНЫЙ месяц, ₪.
   * null — сумма за месяц НЕ введена. Вызывающий обязан проверить null отдельно
   * и пометить начисление: молчаливый ноль завысил бы доплату семьи и занизил
   * взносы, а это ровно та ошибка, ради которой суммы стали помесячными.
   */
  function matavForMonth(settings, y, m) {
    var bl = settings && settings.bl;
    if (!bl || !bl.approved) return 0; // учёт выключен — зачёта нет, прежнее поведение
    var by = bl.matavByMonth;
    if (isMonthMap(by)) {
      var v = by[ymKey(y, m)];
      if (typeof v === 'number' && !isNaN(v) && v >= 0) return round2(v);
    }
    // Помесячных данных нет вовсе → конфиг ещё в ЛЕГАСИ-режиме и обязан считаться
    // в точности как до перехода на помесячные суммы: по единому числу, а если его
    // нет — с зачётом 0 (полная зарплата). Возвращать здесь null нельзя: старый
    // конфиг разом обнулился бы и платить стало бы нечем — это регрессия.
    if (monthMapEmpty(by)) {
      return (typeof bl.matavAmount === 'number' && bl.matavAmount > 0) ? round2(bl.matavAmount) : 0;
    }
    // Помесячные суммы уже есть → отсутствие нужного месяца означает «не введено»,
    // а не повод подставить старое единое число: именно так одна цифра расползалась
    // на все месяцы. Считать нечем — вызывающий обязан пометить начисление.
    return null;
  }

  // Нужна ли сумма от Матав для ВЗНОСОВ (Битуах, пикадон, хавраа) и не введена ли она.
  // Без applyToSocial зачёт этих начислений равен нулю по определению (blSocialOffset),
  // сумма на них не влияет вообще — и обнулять начисление из-за невведённого месяца
  // нельзя: владелец увидел бы нули по Битуах Леуми и пикадону и не заплатил их,
  // а «починить» это можно было бы только вводом сумм, которые на цифры не влияют.
  function blSocialMissing(settings, y, m) {
    var bl = (settings && settings.bl) || {};
    if (!bl.approved || !bl.applyToSocial) return false;
    return matavForMonth(settings, y, m) === null;
  }

  // зачёт ЗАРПЛАТЫ за месяц: ограничен нетто-зарплатой — государство не субсидирует
  // больше нетто, чем есть, иначе доплата семьи ушла бы «в минус»/«платить
  // нечего». Базы взносов/пикадона капить по net НЕЛЬЗЯ (см. blSocialOffset).
  function blMonthlyOffset(settings, y, m) {
    var off = matavForMonth(settings, y, m);
    if (off === null) return 0; // сумма не введена: null проверяет вызывающий сам
    var net = (settings.types && settings.types.salary) ? settings.types.salary.net : off;
    return Math.min(off, net);
  }

  // нормализация настроек при загрузке/восстановлении (mergeDeep уже заполнил
  // недостающие поля из дефолтов; одноразовая правка старых полей — в app.js migrateV6)
  function sanitizeSettings(settings) {
    if (settings && settings.bl) {
      var bl = settings.bl;
      // легаси-сумма ≥ 0 (защита от мусора в бэкапе/старых настройках)
      if (typeof bl.matavAmount !== 'number' || isNaN(bl.matavAmount) || bl.matavAmount < 0) {
        bl.matavAmount = 0;
      }
      // Помесячные суммы: оставляем только 'YYYY-MM' → неотрицательное число.
      // Ключи сортируем, чтобы JSON бэкапа не менялся от порядка ввода — иначе
      // хэш копии «плавал» бы и устройства заливали её без реальных изменений.
      var clean = {};
      monthKeys(bl.matavByMonth).sort().forEach(function (k) {
        clean[k] = round2(bl.matavByMonth[k]);
      });
      bl.matavByMonth = clean;
      // approved привязан к суммам: пока не введено НИЧЕГО (ни легаси-сумма, ни
      // хотя бы один месяц) учёт ВЫКЛЮЧЕН. Защита от рассинхрона галочки раздела
      // настроек и от восстановления старого бэкапа, где approved=true мог стоять
      // без суммы. ВАЖНО: введённый НОЛЬ — это данные («за этот месяц Матав не
      // платил»), а не отсутствие суммы. Раньше проверялся «положительный» месяц,
      // и единственный нулевой месяц гасил учёт целиком: остальные месяцы молча
      // считались по полной базе (зарплата 8260 вместо 3300) без единой пометки.
      if (!(bl.matavAmount > 0) && Object.keys(bl.matavByMonth).length === 0) bl.approved = false;
    }
    return settings;
  }

  // доля зарплаты за месяц, которую семья платит из своих средств (0..1)
  function blFamilyShare(settings, y, m) {
    var net = settings.types.salary.net;
    if (!net || net <= 0) return 1;
    var off = blMonthlyOffset(settings, y, m);
    if (off <= 0) return 1;
    if (off >= net) return 0;
    return (net - off) / net;
  }

  // зачёт за месяц для СОЦВЫПЛАТ (взносы/пикадон): берём ПОЛНЫЙ зачёт без потолка
  // по net — базы и так флорятся через Math.max(0, grossBase − зачёт). Кап по net
  // занижал бы соцзачёт и завышал взносы, если нетто-зарплата ниже зачёта.
  function blSocialOffset(settings, y, m) {
    var bl = settings.bl || {};
    if (!bl.approved || !bl.applyToSocial) return 0;
    var off = matavForMonth(settings, y, m);
    return off === null ? 0 : off;
  }

  // две строки, которыми начисление объясняет, что считать нечем
  function matavMissingLines(y, m) {
    return ['Сумма от Матав за ' + monthLabel(y, m) + ' не введена — посчитать нельзя',
      'Введите сумму, присланную Матав, — карточка пересчитается'];
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

  function genSalary(t, start, end, out, settings) {
    eachWorkedMonth(start, end, function (y, m, fromDay) {
      var due = nextMonthDue(y, m, t.dayOfMonth);
      if (due > end) return;
      // сумма от Матав своя за каждый месяц: берём по месяцу НАЧИСЛЕНИЯ (y, m),
      // а не по месяцу срока — платим 9-го числа следующего месяца
      var blRaw = matavForMonth(settings, y, m);
      var dim = daysInMonth(y, m);
      var workedDays = dim - fromDay + 1;
      var sats = countSaturdays(y, m, fromDay);          // субботы в отработанной части месяца
      var full = workedDays === dim;
      // Нетто прораторуется по КАЛЕНДАРНЫМ дням БЕЗ суббот: субботы оплачиваются
      // отдельно по shabbatRate, поэтому в пропорцию (и числитель, и знаменатель)
      // не входят. Полный месяц — полный нетто.
      var satsMonth = countSaturdays(y, m);              // все субботы месяца
      var nonSatMonth = dim - satsMonth;                 // будних (несубботних) дней в месяце
      var nonSatWorked = workedDays - sats;              // из отработанных — несубботних
      var netPart = full ? t.net : round2(t.net * nonSatWorked / nonSatMonth);
      if (blRaw === null) {
        // Считать нечем: любое подставленное число либо занизит, либо завысит
        // доплату семьи. Начисление всё равно показываем (иначе платёж просто
        // исчезнет с экрана) — с нулём, пометкой и объяснением.
        out.push({
          id: 'salary-' + y + '-' + pad2(m),
          type: 'salary',
          month: ymKey(y, m),
          blMissing: true,
          missingMonths: [ymKey(y, m)], // как у взносов: интерфейс берёт месяцы отсюда
          title: 'Зарплата за ' + monthLabel(y, m),
          dueDate: due,
          amount: 0,
          breakdown: matavMissingLines(y, m),
          // поля для пересчёта в диалоге оплаты обязаны остаться: карточка
          // могла устареть, а диалог читает их без проверок
          satCount: sats, satRate: t.shabbatRate, netPart: 0
        });
        return;
      }
      // Сумма от Матав (гмлат сиуд) — ФАКТИЧЕСКАЯ выплата за месяц (вводится вручную
      // помесячно по присланной цифре, blRaw — без потолка по net), поэтому НЕ
      // прораторуется; в зачёт берём в пределах нетто-части, чтобы доплата семьи не
      // ушла в минус.
      var offPart = Math.min(blRaw, netPart);
      var familyNet = Math.max(0, round2(netPart - offPart));
      var shabbat = sats * t.shabbatRate;
      var breakdown = [];
      if (full) {
        breakdown.push('Нетто за месяц: ' + fmtMoney(t.net));
      } else {
        breakdown.push('Нетто пропорц. (кроме суббот, с ' + fromDay + '-го числа): ' +
          fmtMoney(t.net) + ' × ' + nonSatWorked + '/' + nonSatMonth + ' дн. = ' + fmtMoney(netPart));
      }
      if (offPart > 0) {
        if (blRaw > offPart + 0.01) {
          // Матав платит больше, чем есть нетто-часть → зачёт ограничен нетто
          breakdown.push('Платит Матав (гмлат сиуд): ' + fmtMoney(blRaw));
          breakdown.push('Зачтено в пределах нетто-зарплаты: − ' + fmtMoney(offPart) +
            ' (платит организация по уходу)');
        } else {
          breakdown.push('Платит Матав (гмлат сиуд): − ' + fmtMoney(offPart) +
            ' (платит организация по уходу)');
        }
        breakdown.push('Доплата семьи: ' + fmtMoney(familyNet));
      }
      breakdown.push('Шабат: ' + sats + ' ' + satWord(sats) + ' × ' +
        fmtMoney(t.shabbatRate) + ' = ' + fmtMoney(shabbat));
      breakdown.push('Итого: ' + fmtMoney(familyNet + shabbat));
      out.push({
        id: 'salary-' + y + '-' + pad2(m),
        type: 'salary',
        month: ymKey(y, m), // на нём держится строка «Матав за …» в карточке
        blMissing: false,
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
    if (t.frequency === 'annual') { genInsuranceAnnual(t, start, end, out); return; }
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

  // Годовой режим страховки: одна выплата в год на дату продления renewalDate
  // (например 09.07). Полис оплачивается вперёд одной суммой; отмечается «оплачено»
  // один раз и не напоминает до следующего года.
  function genInsuranceAnnual(t, start, end, out) {
    var anchor = t.renewalDate;
    if (!anchor || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return;
    for (var k = 0; ; k++) {
      var due = addYears(anchor, k);
      if (due > end) break;
      if (due < start) continue; // продление раньше начала работы — пропускаем
      out.push({
        id: 'insurance-' + parseISO(due).getFullYear(),
        type: 'insurance',
        title: 'Мед. страховка (год с ' + fmtDate(due) + ')',
        dueDate: due,
        amount: t.amountAnnual,
        breakdown: ['Годовая премия частной мед. страховки (платится РАЗ В ГОД, вперёд): ' +
          fmtMoney(t.amountAnnual),
          'Дата продления: ' + fmtDate(due)]
      });
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

  // Обязанность платить взносы может возникать ПОЗЖЕ трудоустройства.
  // t.fromMonth — номер месяца работы, с которого идут взносы (как у пикадона):
  // 1 или поле отсутствует = с первого месяца, прежнее поведение.
  // Возвращает 1-е число первого облагаемого месяца (или null, если ограничения
  // нет). Именно 1-е число: первый облагаемый месяц считается ПОЛНЫМ, а не
  // пропорционально дате выхода на работу.
  function bituachSkipBefore(t, start) {
    var n = (t && typeof t.fromMonth === 'number' && t.fromMonth > 1) ? t.fromMonth : 1;
    if (n === 1) return null;
    var d = parseISO(addMonthsISO(start, n - 1));
    return mkDate(d.getFullYear(), d.getMonth() + 1, 1);
  }

  // При переключении частоты месяц/квартал оплаченные записи другого
  // режима остаются в журнале — учитываем их, чтобы не требовать
  // повторной оплаты тех же месяцев.
  function genBituach(t, start, end, out, paidLog, settings) {
    paidLog = paidLog || {};
    if (t.frequency === 'quarterly') {
      genBituachQuarterly(t, start, end, out, paidLog, settings);
      return;
    }
    var minISO = bituachSkipBefore(t, start);
    eachWorkedMonth(start, end, function (y, m, fromDay) {
      if (minISO && mkDate(y, m, 1) < minISO) return; // взносы ещё не начались
      var q = Math.floor((m - 1) / 3) + 1;
      if (paidLog['bituach-' + y + '-Q' + q]) return; // месяц покрыт оплаченным кварталом
      var due = nextMonthDue(y, m, t.dayOfMonth);
      if (due > end) return;
      if (blSocialMissing(settings, y, m)) {
        // База взноса = брутто минус сумма от Матав за ЭТОТ месяц. Без неё
        // взнос посчитать нельзя; месячный режим — это ровно один месяц,
        // поэтому «не включать месяц» = ноль с пометкой, а не пропуск карточки.
        out.push({
          id: 'bituach-' + y + '-' + pad2(m),
          type: 'bituach',
          blMissing: true,
          missingMonths: [ymKey(y, m)],
          title: 'Битуах Леуми за ' + monthLabel(y, m),
          dueDate: due,
          amount: 0,
          breakdown: matavMissingLines(y, m)
        });
        return;
      }
      var blOff = blSocialOffset(settings, y, m);
      var dim = daysInMonth(y, m);
      var workedDays = dim - fromDay + 1;
      var full = bituachMonthly(t, blOff);
      if (full <= 0) return; // зачёт покрывает всю базу
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
        blMissing: false,
        missingMonths: [],
        title: 'Битуах Леуми за ' + monthLabel(y, m),
        dueDate: due,
        amount: amount,
        breakdown: breakdown
      });
    });
  }

  function genBituachQuarterly(t, start, end, out, paidLog, settings) {
    paidLog = paidLog || {};
    // Квартал — это ТРИ месяца с РАЗНЫМИ суммами от Матав, поэтому и база, и
    // ранний выход «зачёт покрыл всю базу» считаются помесячно внутри цикла.
    var quarters = {}; // 'y-q' -> {y, q, items[], missing[]}
    function quarter(y, q) {
      var qk = y + '-' + q;
      return (quarters[qk] = quarters[qk] || { y: y, q: q, items: [], missing: [] });
    }
    var minISO = bituachSkipBefore(t, start);
    eachWorkedMonth(start, end, function (y, m, fromDay) {
      if (minISO && mkDate(y, m, 1) < minISO) return; // взносы ещё не начались
      if (paidLog['bituach-' + y + '-' + pad2(m)]) return; // месяц уже оплачен помесячно
      var q = Math.floor((m - 1) / 3) + 1;
      if (blSocialMissing(settings, y, m)) {
        // Месяц без суммы в квартал НЕ включаем: посчитать его по нулю значило бы
        // молча завысить взнос за квартал. Копим для пометки — не для тишины.
        quarter(y, q).missing.push(ymKey(y, m));
        return;
      }
      var blOff = blSocialOffset(settings, y, m);
      var full = bituachMonthly(t, blOff);
      if (full <= 0) return; // зачёт этого месяца покрыл всю базу
      var dim = daysInMonth(y, m);
      var workedDays = dim - fromDay + 1;
      quarter(y, q).items.push({
        y: y, m: m,
        base: bituachBase(t, blOff),
        amount: workedDays === dim ? full : round2(full * workedDays / dim)
      });
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
      breakdown.push('База каждого месяца: ' + fmtMoney(t.grossBase) +
        ' − сумма от Матав за этот месяц (взносы — только с доплаты семьи)');
      qu.items.forEach(function (it) {
        total = round2(total + it.amount);
        breakdown.push(MONTHS_NOM[it.m - 1] + ': ' + fmtPct(t.ratePercent) + ' × ' +
          fmtMoney(it.base) + ' = ' + fmtMoney(it.amount));
      });
      if (qu.missing.length) {
        breakdown.push('Не введена сумма от Матав за: ' +
          qu.missing.map(monthKeyLabel).join(', ') + ' — сумма квартала неполная');
      }
      breakdown.push('Итого за квартал: ' + fmtMoney(total));
      out.push({
        id: 'bituach-' + qu.y + '-Q' + qu.q,
        type: 'bituach',
        blMissing: qu.missing.length > 0,
        missingMonths: qu.missing,
        title: 'Битуах Леуми за ' + qu.q + '-й квартал ' + qu.y,
        dueDate: due,
        amount: total,
        breakdown: breakdown
      });
    });
  }

  function genPikadon(t, start, end, out, settings) {
    var pikStart = addMonthsISO(start, t.fromMonth - 1); // начало 7-го месяца работы
    eachWorkedMonth(start, end, function (y, m, fromDay) {
      var monthEnd = mkDate(y, m, daysInMonth(y, m));
      if (monthEnd < pikStart) return; // ещё не 7-й месяц
      var due = nextMonthDue(y, m, t.dayOfMonth);
      if (due > end) return;
      if (blSocialMissing(settings, y, m)) {
        out.push({
          id: 'pikadon-' + y + '-' + pad2(m),
          type: 'pikadon',
          blMissing: true,
          missingMonths: [ymKey(y, m)],
          title: 'Пикадон за ' + monthLabel(y, m),
          dueDate: due,
          amount: 0,
          breakdown: matavMissingLines(y, m)
        });
        return;
      }
      // база, проценты и ранний выход — помесячно: сумма от Матав своя у каждого месяца
      var blOff = blSocialOffset(settings, y, m);
      var base = Math.max(0, round2(t.grossBase - blOff));
      if (base <= 0) return; // зачёт покрыл всю базу — отчисления у организации
      var pension = round2(base * t.pensionPercent / 100);
      var severance = round2(base * t.severancePercent / 100);
      var amount = round2(pension + severance);
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
        blMissing: false,
        missingMonths: [],
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

  function genHavraa(t, start, end, out, settings) {
    for (var k = 1; ; k++) {
      var due = addYears(start, k);
      if (due > end) break;
      // Хавраа годовая, а зачёт стал помесячным: долю семьи берём по месяцу
      // годовщины. Если сумма за него не введена — доля ПОЛНАЯ (1): переплата
      // работнику безопаснее недоплаты.
      var dd = parseISO(due);
      var dy = dd.getFullYear(), dm = dd.getMonth() + 1;
      var blMissing = blSocialMissing(settings, dy, dm);
      var familyShare = (!blMissing && settings.bl && settings.bl.approved && settings.bl.applyToSocial)
        ? blFamilyShare(settings, dy, dm) : 1;
      if (familyShare <= 0) continue; // полностью у организации по уходу
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
      if (blMissing) {
        breakdown.push('Сумма от Матав за ' + monthLabel(dy, dm) +
          ' не введена — доля семьи взята полной (100%)');
      }
      breakdown.push('Выплачивается после каждого полного года работы (годовщина: ' + fmtDate(due) + ')');
      out.push({
        id: 'havraa-' + k,
        type: 'havraa',
        blMissing: blMissing,
        missingMonths: blMissing ? [ymKey(dy, dm)] : [],
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
    // Зачёт от Матав НЕ вычисляем здесь одной цифрой: она применялась бы ко всем
    // месяцам сразу. Генераторы берут сумму сами, по своему месяцу начисления.
    if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
      if (t.salary.enabled) genSalary(t.salary, start, end, out, settings);
      if (t.pocket.enabled) genPocket(t.pocket, start, end, out);
      if (t.insurance.enabled) genInsurance(t.insurance, start, end, out);
      if (t.bituach.enabled) genBituach(t.bituach, start, end, out, paidLog, settings);
      if (t.pikadon.enabled) genPikadon(t.pikadon, start, end, out, settings);
      if (t.havraa.enabled) genHavraa(t.havraa, start, end, out, settings);
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
    // Месяц окончания работы — ключ для помесячной суммы от Матав. Объявляем ДО
    // зачётов: они теперь зависят от (y, m).
    var e = parseISO(endISO);
    var y = e.getFullYear(), m = e.getMonth() + 1, endDay = e.getDate();
    var blMissing = matavForMonth(settings, y, m) === null;
    if (blMissing) {
      warnings.push('Сумма от Матав за ' + monthLabel(y, m) +
        ' не введена — расчёт ориентировочный, база взята полной.');
    }
    var blOff = blMonthlyOffset(settings, y, m);
    var blSoc = blSocialOffset(settings, y, m);
    var famShare = (!blMissing && settings.bl && settings.bl.approved && settings.bl.applyToSocial)
      ? blFamilyShare(settings, y, m) : 1;
    // ДОПУЩЕНИЕ: выходное пособие и отпуск считаются ОДНОЙ базой, умноженной на
    // число месяцев стажа. Суммы от Матав помесячные, но менять формулу выходного
    // пособия здесь нельзя, поэтому базу берём по месяцу окончания работы.
    var base = Math.max(0, round2(t.pikadon.grossBase - blSoc));
    var months = monthsBetween(start, endISO);

    // 1. зарплата за последний неполный месяц (+ шабат по календарю)
    var dim = daysInMonth(y, m);
    var s0 = parseISO(start);
    var fromDay = (y === s0.getFullYear() && m === s0.getMonth() + 1) ? s0.getDate() : 1;
    var workedDays = endDay - fromDay + 1;
    var sats = countSaturdays(y, m, fromDay, endDay);
    // нетто последнего месяца — по календарным дням КРОМЕ суббот (как в genSalary);
    // сумма от Матав НЕ прораторуется (фактическая за месяц), капится по нетто-части
    var nonSatMonth = dim - countSaturdays(y, m);
    var nonSatWorked = workedDays - sats;
    var netPart = round2(t.salary.net * nonSatWorked / nonSatMonth);
    var offPart = Math.min(blOff, netPart);
    var famNet = Math.max(0, round2(netPart - offPart));
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
    monthKeyLabel: monthKeyLabel,
    plural: plural,
    hashString: hashString,
    timesheetStatus: timesheetStatus,
    timesheetsOfMonth: timesheetsOfMonth,
    timesheetGroupStatus: timesheetGroupStatus,
    defaultSettings: defaultSettings,
    sanitizeSettings: sanitizeSettings,
    matavForMonth: matavForMonth,
    blSocialMissing: blSocialMissing,
    blMonthlyOffset: blMonthlyOffset,
    blSocialOffset: blSocialOffset,
    blFamilyShare: blFamilyShare,
    monthsBetween: monthsBetween,
    calcFinalSettlement: calcFinalSettlement,
    generateOccurrences: generateOccurrences,
    getStatus: getStatus
  };
})();
