/*
 * MetapelApp — UI: вкладки, карточки платежей, отметка «оплачено»,
 * настройки за паролем, браузерные уведомления.
 * Для отладки дату «сегодня» можно подменить: index.html?today=2026-12-09
 */
(function () {
  'use strict';

  var C = window.MetapelCalc;
  var S = window.MetapelStore;

  // Поднимать при каждой публикации — по этой надписи внизу страницы
  // видно, что загрузилась новая версия, а не кэш.
  // Раздел «Табели» ПРОМОТИРОВАН на прод (23.06.2026): фича (вкладка, версия,
  // раздел EmailJS) включена в ОБЕИХ средах. Гейт оставлен константой = false —
  // если понадобится снова заморозить прод, вернуть на `!(window.MetapelEnv &&
  // window.MetapelEnv.stage)`. Среды по-прежнему различает баннер STAGE и путь /stage/.
  var TS_STAGE_ONLY = false;
  var APP_VERSION = '6.13 от 04.10.2026 (подписи табелей хранятся отдельными файлами архива — бэкап и память устройства не разрастаются)';

  // ---------- «сегодня» ----------

  var params = new URLSearchParams(location.search);
  var simToday = params.get('today');
  if (simToday && !/^\d{4}-\d{2}-\d{2}$/.test(simToday)) simToday = null;

  function realToday() { return C.toISO(new Date()); }
  function today() { return simToday || realToday(); }

  // ---------- состояние ----------

  var settings = S.loadSettings();
  var log = S.loadLog();
  var extras = S.loadExtras();   // доп. платежи: подарки / под отчёт
  var returns = S.loadReturns(); // возвраты по отчёту (чеки, сдача)
  var timesheets = S.loadTimesheets(); // как log/extras/returns: грузим сразу, иначе уже сохранённый табель не виден до первого reloadData
  var activeTab = 'due';

  // пароль настроек «помнится» заданное число минут (реальное время,
  // не зависит от симуляции даты)
  function settingsUnlockedNow() {
    return Date.now() < (S.getMeta('settingsUnlockUntil') || 0);
  }

  function unlockSettings() {
    var ttl = settings.passwordTtlMinutes;
    if (ttl == null || isNaN(ttl) || ttl < 0) ttl = 10;
    // ttl=0 запер бы настройки навсегда (пароль «протухал» бы мгновенно) —
    // минимум одна минута, чтобы успеть войти
    if (ttl < 1) ttl = 1;
    S.setMeta('settingsUnlockUntil', Date.now() + ttl * 60 * 1000);
  }
  var currentPay = null;       // вхождение в диалоге оплаты
  var payMethod = 'cash';      // выбранный способ в диалоге оплаты (по умолчанию наличные)
  var currentSign = null;      // {type:'log'|'extra', id} — чья подпись ставится
  var signCallback = null;     // если задан — окно подписи работает в режиме «вернуть PNG» (табели)
  var signColor = null;        // цвет чернил подписи табеля (метапелет — синий, Григорий — чёрный)
  var extraKind = 'gift';      // тип в диалоге доп. платежа
  var extraMethod = 'cash';    // способ в диалоге доп. платежа

  function reloadData() {
    log = S.loadLog();
    extras = S.loadExtras();
    returns = S.loadReturns();
    timesheets = S.loadTimesheets();
  }

  var HORIZON_DAYS = 60;

  var TYPE_COLORS = {
    salary: '#2563eb', pocket: '#16a34a', insurance: '#9333ea',
    bituach: '#0891b2', pikadon: '#d97706', havraa: '#db2777',
    visa: '#4f46e5', tagid: '#64748b', permit: '#475569'
  };

  var TYPE_ICONS = {
    salary: '💰', pocket: '👛', insurance: '🏥',
    bituach: '🏛️', pikadon: '🏦', havraa: '🌴',
    visa: '🛂', tagid: '📋', permit: '📄'
  };

  // ---------- помощники ----------

  function $(sel) { return document.querySelector(sel); }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }

  function setPath(obj, path, value) {
    var keys = path.split('.');
    var o = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      // создаём промежуточные объекты, если их нет (напр. новый раздел emailjs)
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }

  function occurrences() {
    // журнал нужен движку: Битуах Леуми не должен требовать повторной
    // оплаты месяцев при переключении частоты месяц/квартал
    return C.generateOccurrences(settings, today(), HORIZON_DAYS, log);
  }

  // ---------- большие диалоги, тост, защита от двойных касаний ----------

  var confirmCallback = null;
  var actionLockUntil = 0;
  var tapShieldUntil = 0;

  // true один раз в 600 мс — гасит дребезг двойного нажатия
  function actionGuard() {
    var now = Date.now();
    if (now < actionLockUntil) return false;
    actionLockUntil = now + 600;
    return true;
  }

  function appConfirm(text, yesLabel, onYes) {
    confirmCallback = onYes;
    $('#confirm-title').textContent = 'Подтверждение';
    $('#confirm-text').textContent = text;
    var yes = $('#confirm-yes');
    yes.textContent = yesLabel || 'Да';
    yes.style.display = '';
    $('#confirm-no').textContent = 'Нет, вернуться назад';
    $('#modal-confirm').classList.add('open');
    updateScrollLock();
  }

  function appAlert(text) {
    confirmCallback = null;
    $('#confirm-title').textContent = 'Внимание';
    $('#confirm-text').textContent = text;
    $('#confirm-yes').style.display = 'none';
    $('#confirm-no').textContent = 'Понятно';
    $('#modal-confirm').classList.add('open');
    updateScrollLock();
  }

  // закрывает только окно подтверждения (под ним может быть другое окно)
  function closeConfirm() {
    $('#modal-confirm').classList.remove('open');
    confirmCallback = null;
    updateScrollLock();
  }

  var toastTimer = null;
  function showToast(text) {
    var t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  // блокировка прокрутки фона, пока открыто любое окно (iOS-совместимая)
  var savedScrollY = 0;
  function updateScrollLock() {
    var anyOpen = !!document.querySelector('.modal.open');
    var locked = document.body.style.position === 'fixed';
    if (anyOpen && !locked) {
      savedScrollY = window.scrollY || 0;
      document.body.style.position = 'fixed';
      document.body.style.top = -savedScrollY + 'px';
      document.body.style.left = '0';
      document.body.style.right = '0';
    } else if (!anyOpen && locked) {
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      window.scrollTo(0, savedScrollY);
    }
  }

  // фоновая перерисовка (после синхронизации, в полночь): не должна
  // стирать недозаполненную форму настроек или открытое окно
  function backgroundRender() {
    if (activeTab === 'settings') return;
    if (document.querySelector('.modal.open')) return;
    render();
  }

  // системное уведомление: iOS поддерживает только показ через service
  // worker, обычный new Notification() там бросает исключение
  function showSystemNotification(title, options) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (navigator.serviceWorker) {
      navigator.serviceWorker.ready.then(function (reg) {
        if (reg.showNotification) reg.showNotification(title, options);
        else new Notification(title, options);
      }).catch(function () {
        try { new Notification(title, options); } catch (e) { /* нет поддержки */ }
      });
    } else {
      try { new Notification(title, options); } catch (e) { /* нет поддержки */ }
    }
  }

  function withStatus(list) {
    return list.map(function (o) {
      o.status = C.getStatus(o, log, today(), settings);
      return o;
    });
  }

  // ---------- рендер ----------

  // масштаб текста: настройка пользователя × прибавка для планшета
  function applyScale() {
    var tablet = window.matchMedia('(min-width: 768px)').matches ? 1.08 : 1;
    // 125 — потолок: «очень крупный» из старых настроек (130) тоже ужимается
    var scale = Math.min(settings.uiScale || 100, 125) / 100;
    var zoom = tablet * scale;
    document.body.style.zoom = String(zoom);
    // vh внутри zoom «растягивается» — пересчитываем потолок окон в пикселях,
    // иначе при крупном шрифте низ окна (кнопка «Закрыть») уходит за экран
    document.documentElement.style.setProperty('--modal-max',
      Math.round(window.innerHeight / zoom * 0.92) + 'px');
  }

  // ⚠ «Синхронизация застряла» — КРУПНО на любой вкладке (кроме настроек, где и так
  // есть строка состояния). Раньше ошибка была видна только в Настройках за паролем —
  // застрявшее устройство неделями копило неотправленные оплаты (инцидент 02.08.2026).
  // Специально БЕЗ инструкции «нажмите Восстановить»: на устройстве с несинхронными
  // оплатами это стёрло бы их — разруливает родственник, а не домашние.
  function syncAlertCard(content) {
    if (activeTab === 'settings') return;
    if (!window.MetapelSync.isOn(settings)) return;
    if (!S.getMeta('lastSyncError')) return;
    content.appendChild(el('div', 'banner banner-alert',
      '⚠ Данные не уходят в облако' +
      '<div class="banner-sub">Оплаты, отмеченные на этом устройстве, не видны на других. ' +
      'Ничего не нажимайте в настройках — просто сообщите родственнику (Льву).</div>'));
  }

  function render() {
    applyScale();
    var occ = withStatus(occurrences());
    renderHeader();
    renderNav(occ);
    var content = $('#content');
    content.innerHTML = '';
    syncAlertCard(content);
    if (activeTab === 'due') { blStatusCard(content, occ); renderDue(occ, content); }
    else if (activeTab === 'upcoming') renderUpcoming(occ, content);
    else if (activeTab === 'history') renderHistory(content);
    else if (activeTab === 'advance') renderAdvance(content);
    else if (activeTab === 'timesheets') renderTimesheets(content);
    else if (activeTab === 'settings') renderSettings(content);
    maybeNotify(occ);
  }

  function renderHeader() {
    $('#hdr-title').textContent = 'Выплаты метапелю · ' + settings.workerName;
    var d = C.parseISO(today());
    $('#hdr-today').innerHTML = 'Сегодня: <b>' + C.fmtDate(today()) + '</b>' +
      ' (' + C.WEEKDAYS[d.getDay()] + ')' +
      (simToday ? ' <span class="sim-badge">симуляция даты</span>' : '');
    // Кнопка уведомлений: только если браузер реально может их выдать.
    // На file:// Chrome не сохраняет разрешение (Allow спрашивается заново) —
    // там кнопку не показываем, напоминанием служит баннер при открытии.
    var btn = $('#btn-notify');
    var canAsk = 'Notification' in window &&
      location.protocol !== 'file:' &&
      Notification.permission === 'default';
    btn.style.display = canAsk ? '' : 'none';
  }

  function renderNav(occ) {
    var dueCount = occ.filter(function (o) {
      return o.status === 'due' || o.status === 'overdue';
    }).length;
    var badge = $('#badge-due');
    badge.textContent = dueCount;
    badge.style.display = dueCount ? '' : 'none';
    // точка на вкладке «Под отчёт», пока за метапелем числятся деньги под отчёт
    var badgeA = $('#badge-advance');
    if (badgeA) badgeA.style.display = advanceBalance() > 0 ? '' : 'none';
    // бейдж табелей: полностью подписанные, но не отмеченные «Отослано»
    var tsCount = timesheets.filter(function (t) {
      return C.timesheetStatus(t) === 'full';
    }).length;
    var badgeT = $('#badge-timesheets');
    if (badgeT) { badgeT.textContent = tsCount; badgeT.style.display = tsCount ? '' : 'none'; }
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === activeTab);
    });
    var gear = $('#btn-settings');
    gear.style.background = activeTab === 'settings' ? '#dbeafe' : '';
    gear.style.borderColor = activeTab === 'settings' ? '#1d4ed8' : '';
  }

  function dueLabel(o) {
    var diff = C.diffDays(o.dueDate, today());
    var wd = C.parseISO(o.dueDate).getDay();
    if (o.status === 'overdue') {
      return '<span class="late">🔴 Просрочено на ' + (-diff) + ' ' +
        C.plural(-diff, 'день', 'дня', 'дней') + '!</span><br>Срок был: ' + C.fmtDate(o.dueDate);
    }
    if (diff === 0) {
      return '<span class="soon">🟡 Заплатить СЕГОДНЯ</span>';
    }
    if (o.status === 'due') {
      return '<span class="soon">🟡 Заплатить ' + C.WEEKDAYS_ACC[wd] + ', ' +
        C.fmtDate(o.dueDate) + '</span><br>Осталось: ' + diff + ' ' +
        C.plural(diff, 'день', 'дня', 'дней');
    }
    return '<span class="fine">📅 ' + C.WEEKDAYS_ACC[wd].charAt(0).toUpperCase() +
      C.WEEKDAYS_ACC[wd].slice(1) + ', ' + C.fmtDate(o.dueDate) +
      ' (через ' + diff + ' ' + C.plural(diff, 'день', 'дня', 'дней') + ')</span>';
  }

  function card(o, withPayBtn) {
    var div = el('div', 'card ' + o.status);
    div.style.borderLeftColor = TYPE_COLORS[o.type] || '#888';
    var head = el('div', 'card-head');
    var left = el('div', 'card-left');
    var title = el('div', 'card-title');
    title.appendChild(el('span', 'card-icon', TYPE_ICONS[o.type] || '💵'));
    title.appendChild(el('span', null, esc(o.title)));
    left.appendChild(title);
    left.appendChild(el('div', 'card-due', dueLabel(o)));
    head.appendChild(left);
    head.appendChild(el('div', 'card-amount', C.fmtMoney(o.amount)));
    div.appendChild(head);

    // сумма от Матав за месяц этого начисления: без неё зарплату посчитать
    // нельзя, а взносы/пикадон считаются по неполному набору месяцев
    if (o.type === 'salary' && occMonth(o)) div.appendChild(matavRow(o));
    else if (o.blMissing) div.appendChild(matavMissingRow(o));

    // большая кнопка-раскрывашка вместо мелкого <details>
    var btnB = el('button', 'btn-breakdown', '📖 Как посчитана сумма ▾');
    var body = el('ul', 'breakdown-body');
    o.breakdown.forEach(function (line) { body.appendChild(el('li', null, esc(line))); });
    btnB.addEventListener('click', function () {
      var open = body.classList.toggle('open');
      btnB.textContent = open ? '📖 Как посчитана сумма ▴' : '📖 Как посчитана сумма ▾';
    });
    div.appendChild(btnB);
    div.appendChild(body);

    if (withPayBtn && !payBlocked(o)) {
      var actions = el('div', 'card-actions');
      var btn = el('button', 'btn btn-pay', '✓ Я заплатил');
      btn.addEventListener('click', function () { openPayModal(o); });
      actions.appendChild(btn);
      div.appendChild(actions);
    }
    return div;
  }

  function sumAmounts(list) {
    return list.reduce(function (s, o) { return s + o.amount; }, 0);
  }

  // Начисление, посчитанное БЕЗ суммы от Матав, платить нельзя. Отметка об оплате
  // ВЕЧНАЯ: getStatus по тому же id всегда вернёт 'paid', а отдельного «добора»
  // разницы в приложении нет. Поэтому оплаченный неполный квартальный Битуах
  // закрывал бы квартал навсегда — недоплата (напр. 53,45 ₪ вместо 160,35 ₪)
  // исчезала бы со всех экранов, а это дыра в страховом стаже работника.
  // У зарплаты и помесячных взносов сумма и вовсе нулевая, у хавраа — завышенная.
  // Сначала ввести суммы месяцев, потом платить.
  function payBlocked(o) {
    return !!o.blMissing;
  }

  // Итог складывается из amount, а начисление без суммы от Матав посчитано неверно:
  // зарплата и помесячные взносы — нулём, квартальный Битуах — по неполному набору
  // месяцев, хавраа — наоборот по ПОЛНОЙ доле семьи (то есть завышена). Молча
  // принятый итог владелец счёл бы верным — пишем, сколько начислений в нём неточны.
  function missingNote(list) {
    var n = list.filter(function (o) { return o.blMissing; }).length;
    if (!n) return '';
    return '<br>⚠ Итог неточный: ' + n + ' ' +
      C.plural(n, 'начисление посчитано', 'начисления посчитаны', 'начислений посчитаны') +
      ' без суммы от Матав — введите её, и суммы пересчитаются.';
  }

  function renderDue(occ, content) {
    var due = occ.filter(function (o) { return o.status === 'due' || o.status === 'overdue'; });
    if (!due.length) {
      var next = occ.filter(function (o) { return o.status === 'upcoming'; })[0];
      content.appendChild(el('div', 'banner banner-ok',
        '✅ Сегодня платить ничего не нужно' +
        (next ? '<div class="banner-sub">Следующий платёж: <b>' + esc(next.title) + '</b> — ' +
          C.fmtDate(next.dueDate) + ' (' + C.fmtMoney(next.amount) + ')</div>' : '')));
      return;
    }
    content.appendChild(el('div', 'banner banner-alert',
      '⚠️ Нужно заплатить: ' + C.fmtMoney(sumAmounts(due)) +
      '<div class="banner-sub">' + due.length + ' ' +
      C.plural(due.length, 'платёж', 'платежа', 'платежей') +
      ' — список ниже. После каждой оплаты нажмите зелёную кнопку.' +
      missingNote(due) + '</div>'));
    due.forEach(function (o) { content.appendChild(card(o, true)); });
  }

  // ---------- сумма от Матав (гмлат сиуд): помесячно ----------

  // прямая сумма от Матав (₪ за месяц): ≥ 0, округление до копеек
  function clampAmount(v) {
    if (isNaN(v) || v < 0) return 0;
    return C.round2(v);
  }

  var YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/; // ключ месяца в settings.bl.matavByMonth

  function ymParse(key) {
    var p = /^(\d{4})-(\d{2})$/.exec(key || '');
    return (p && YM_RE.test(key)) ? { y: +p[1], m: +p[2] } : null;
  }

  function ymLabel(key) {
    var p = ymParse(key);
    return p ? C.monthLabel(p.y, p.m) : String(key);
  }

  // Месяц НАЧИСЛЕНИЯ, а не календарный: зарплата за июнь платится 9 июля.
  // Берём поле occurrence, а если его нет — из id вида 'salary-2026-06'
  // (у квартального Битуаха id другой — 'bituach-2026-Q3' — и месяца тут нет).
  function occMonth(o) {
    if (o.month && YM_RE.test(o.month)) return o.month;
    var p = /-(\d{4})-(0[1-9]|1[0-2])$/.exec(o.id || '');
    return p ? p[1] + '-' + p[2] : null;
  }

  function matavAmountFor(ym) {
    var p = ymParse(ym);
    return p ? C.matavForMonth(settings, p.y, p.m) : null;
  }

  // Учитывать суммы от Матав можно, пока есть хоть одна ВВЕДЁННАЯ: старая единая
  // (matavAmount) или любая помесячная — включая нулевую («за этот месяц Матав не
  // платил» — это данные, а не пустота). Условие то же, что в calc.sanitizeSettings:
  // разойдутся — сохранение настроек будет гасить учёт, который sanitize оставил.
  // Если снять approved, зачёт обнулится СРАЗУ ВО ВСЕХ месяцах (правило 1
  // matavForMonth), причём молча — тихое завышение доплаты семьи.
  function blHasAmount(bl) {
    if (!bl) return false;
    if (typeof bl.matavAmount === 'number' && bl.matavAmount > 0) return true;
    var by = bl.matavByMonth;
    if (!by || typeof by !== 'object') return false;
    return Object.keys(by).some(function (k) {
      return YM_RE.test(k) && typeof by[k] === 'number' && !isNaN(by[k]) && by[k] >= 0;
    });
  }

  // Порядок ключей объекта попадает в JSON бэкапа, а по его хэшу синхронизация
  // решает «изменилось / не изменилось». Держим месяцы отсортированными, иначе
  // два устройства с одинаковыми суммами дают разный хэш и вечные перезаливки.
  function sortedMonths(by) {
    var out = {};
    Object.keys(by).sort().forEach(function (k) { out[k] = by[k]; });
    return out;
  }

  // месяц, за который сейчас платится зарплата (для верхней карточки):
  // из ближайшего неоплаченного начисления, а не из календаря
  function currentSalaryMonth(occ) {
    var sal = occ.filter(function (o) { return o.type === 'salary' && o.status !== 'paid'; });
    var due = sal.filter(function (o) { return o.status === 'due' || o.status === 'overdue'; });
    var pick = (due.length ? due : sal)[0];
    return pick ? occMonth(pick) : null;
  }

  // кнопки в блоке про Матав — отдельной строкой (иначе прилипают к тексту)
  function blButtons(box, buttons) {
    var actions = el('div', 'card-actions');
    buttons.forEach(function (b) { actions.appendChild(b); });
    box.appendChild(actions);
    return box;
  }

  function matavButton(ym, label, cls) {
    var btn = el('button', 'btn ' + cls, label);
    btn.type = 'button';
    btn.addEventListener('click', function () { openMatavModal(ym); });
    return btn;
  }

  // Учёт выключен (bl.approved = false) — это НЕ «сумма не введена»: расчёт идёт
  // без зачёта, как будто Матав не платит вовсе (matavForMonth возвращает 0).
  // Показываем это отдельным состоянием, иначе «0 ₪» выглядит как введённая сумма.
  function blOff() { return !(settings.bl && settings.bl.approved); }

  function blStatusCard(content, occ) {
    var ym = currentSalaryMonth(occ);
    if (!ym) return; // не за какой месяц вводить — карточку не показываем
    // Если карточка зарплаты за этот же месяц и так в списке ниже, она уже
    // показывает и сумму от Матав, и кнопку ввода (matavRow) — второй такой же
    // блок сверху только удлиняет экран вдвое.
    var inList = occ.some(function (o) {
      return o.type === 'salary' && occMonth(o) === ym &&
        (o.status === 'due' || o.status === 'overdue');
    });
    if (inList) return;
    var amt = matavAmountFor(ym);
    var box;
    if (blOff()) {
      box = el('div', 'bl-card bl-pending',
        '<div class="bl-sub">Учёт суммы от Матав (гмлат сиуд) выключен — суммы ниже ' +
        'посчитаны так, будто Матав не платит. Введите присланную сумму, и она будет вычтена.</div>');
      blButtons(box, [matavButton(ym, '✓ Указать сумму от Матав', 'btn-light')]);
    } else if (amt == null) {
      box = el('div', 'bl-card bl-pending',
        '⚠ <b>Сумма от Матав за ' + esc(ymLabel(ym)) + ' не введена</b>' +
        '<div class="bl-sub">Матав присылает её 9-го числа, и каждый месяц она разная. ' +
        'Пока не введёте — зарплату за этот месяц посчитать нельзя.</div>');
      blButtons(box, [matavButton(ym, '✓ Ввести сумму от Матав', 'btn-pay')]);
    } else {
      box = el('div', 'bl-card bl-approved',
        '✅ <b>Матав за ' + esc(ymLabel(ym)) + ': ' + C.fmtMoney(amt) + '</b>' +
        '<div class="bl-sub">Эта сумма вычтена из зарплаты — суммы ниже это доплата семьи.</div>');
      blButtons(box, [matavButton(ym, '✎ Изменить сумму от Матав', 'btn-light')]);
    }
    content.appendChild(box);
  }

  // строка про Матав в карточке зарплаты: сумма месяца либо призыв её ввести
  function matavRow(o) {
    var ym = occMonth(o);
    var amt = matavAmountFor(ym);
    var box;
    if (blOff()) {
      box = el('div', 'bl-card bl-pending',
        '<div class="bl-sub">Учёт суммы от Матав выключен — зарплата посчитана полностью, ' +
        'без вычета гмлат сиуд.</div>');
      blButtons(box, [matavButton(ym, '✓ Указать сумму от Матав за ' + esc(ymLabel(ym)), 'btn-light')]);
    } else if (amt == null) {
      box = el('div', 'bl-card bl-pending',
        '⚠ <b>Сумма от Матав за ' + esc(ymLabel(ym)) + ' не введена</b>' +
        '<div class="bl-sub">Введите сумму, присланную Матав, — карточка пересчитается.</div>');
      blButtons(box, [matavButton(ym, '✓ Ввести сумму от Матав', 'btn-pay')]);
    } else {
      box = el('div', 'bl-card bl-approved',
        '🤝 <b>Матав за ' + esc(ymLabel(ym)) + ': ' + C.fmtMoney(amt) + '</b>');
      blButtons(box, [matavButton(ym, '✎ Изменить сумму от Матав', 'btn-light')]);
    }
    return box;
  }

  // Взносы и пикадон считаются помесячно: месяц без суммы от Матав в начисление
  // не вошёл. Даём ввести его прямо отсюда — карточка зарплаты за тот месяц
  // могла быть уже оплачена и с экрана исчезнуть. Про «занижено» здесь не пишем:
  // у хавраа без суммы доля семьи берётся полной, то есть начисление ЗАВЫШЕНО.
  function matavMissingRow(o) {
    var months = (o.missingMonths || []).filter(function (k) { return YM_RE.test(k); });
    var box = el('div', 'bl-card bl-pending',
      '⚠ <b>Сумма неточная: нет данных от Матав</b>' +
      '<div class="bl-sub">Не введена сумма за: ' +
      (months.length ? esc(months.map(ymLabel).join(', ')) : 'часть месяцев') +
      '. Пока их нет, платить это начисление нельзя — сумма посчитана неверно.</div>');
    return blButtons(box, months.map(function (k) {
      return matavButton(k, '✎ Ввести за ' + esc(ymLabel(k)), 'btn-light');
    }));
  }

  var matavMonth = null; // месяц ('YYYY-MM'), который правится в окне #modal-hours

  function openMatavModal(ym) {
    if (!YM_RE.test(ym || '')) { appAlert('Не удалось определить месяц.'); return; }
    matavMonth = ym;
    var cur = matavAmountFor(ym);
    var box = $('#modal-hours');
    box.querySelector('h2').textContent = '🤝 Сумма от Матав за ' + ymLabel(ym);
    box.querySelector('.muted').textContent = 'Матав присылает сумму 9-го числа, и каждый ' +
      'месяц она разная. Введите ту, что пришла за ' + ymLabel(ym) + ', — остальное доплачивает семья.';
    box.querySelector('label[for="hours-input"]').textContent = 'Матав заплатил, ₪';
    var inp = $('#hours-input');
    inp.step = '0.01'; // суммы копеечные (напр. 4959.03) — шаг разметки в 100 ₪ их бы испортил
    // пусто, а не 0: «сумма не введена» и «введён ноль» — разные состояния
    inp.value = (cur == null ? '' : cur);
    // «Матав вообще не платит» в помесячной модели = ввод нуля за месяц (кнопка
    // глобального отключения убрана: отсюда она обнулила бы и все прочие месяцы;
    // выключатель учёта — галочка раздела «Гмлат сиуд» в настройках)
    updateHoursEffect();
    box.classList.add('open');
    updateScrollLock();
  }

  function stepHours(delta) {
    var v = parseFloat($('#hours-input').value);
    if (isNaN(v)) v = 0;
    v = clampAmount(v + delta * 100); // шаг ±100 ₪, копейки правятся вводом
    $('#hours-input').value = v;
    updateHoursEffect();
  }

  function updateHoursEffect() {
    if (!matavMonth) return; // окно закрыто — подсказке не о каком месяце говорить
    var raw = parseFloat($('#hours-input').value);
    if (isNaN(raw)) {
      $('#hours-effect').textContent = 'Введите сумму, присланную Матав за ' +
        ymLabel(matavMonth) + ', — карточка пересчитается.';
      return;
    }
    var amt = clampAmount(raw);
    var net = (settings.types && settings.types.salary) ? settings.types.salary.net : amt;
    var doplata = Math.max(0, C.round2(net - Math.min(amt, net)));
    $('#hours-effect').textContent = 'Матав за ' + ymLabel(matavMonth) + ': ' + C.fmtMoney(amt) +
      ' → ваша доплата зарплаты ≈ ' + C.fmtMoney(doplata) + ' (плюс субботы).';
  }

  function saveMatavMonth() {
    if (!actionGuard()) return;
    if (!YM_RE.test(matavMonth || '')) { appAlert('Не выбран месяц.'); return; }
    var raw = parseFloat($('#hours-input').value);
    if (isNaN(raw) || raw < 0) {
      appAlert('Укажите сумму, присланную Матав (₪). 0 — если за этот месяц Матав не платил.');
      return;
    }
    var amt = clampAmount(raw);
    var saved = matavMonth;
    settings.bl = settings.bl || {};
    var src = (settings.bl.matavByMonth && typeof settings.bl.matavByMonth === 'object')
      ? settings.bl.matavByMonth : {};
    var by = {};
    Object.keys(src).forEach(function (k) { by[k] = src[k]; });
    by[saved] = amt;
    settings.bl.matavByMonth = sortedMonths(by);
    // Ввод месяца (в том числе нулевого) означает «суммы от Матав ведём»: без
    // approved зачёт не применяется НИГДЕ (правило 1 matavForMonth), и остальные
    // месяцы посчитались бы по полной базе молча, без пометки «не введено».
    settings.bl.approved = true;
    S.saveSettings(settings);
    settings = S.loadSettings();
    closeModals(); // сбрасывает matavMonth — месяц запомнили выше
    render();
    showToast('✓ Матав за ' + ymLabel(saved) + ': сумма сохранена');
    runSync();
  }

  // баланс «под отчёт»: выдано под отчёт минус принятые отчёты (подарки не в счёт)
  function advanceBalance() {
    var given = extras.reduce(function (s, e) {
      return e.kind === 'advance' ? s + e.amount : s;
    }, 0);
    var back = returns.reduce(function (s, r) { return s + r.amount; }, 0);
    return C.round2(given - back);
  }

  // одна раскрывающаяся карточка-баланс: сумма + (по клику) список записей,
  // из которых она сложилась. records — массив {type:'extra'|'return', rec}.
  function collapsibleBalance(content, cfg) {
    var bal = cfg.amount;
    var card = el('div', 'balance-card ' + cfg.cls + (bal === 0 ? ' balance-zero' : ''));
    var head = el('div', 'balance-head',
      (bal === 0 ? cfg.zeroLabel : cfg.posLabel) + ': <b>' + C.fmtMoney(bal) + '</b>' +
      '<div class="hint">' + (bal === 0 ? cfg.zeroHint : cfg.posHint) + '</div>');
    card.appendChild(head);

    var details = null;
    if (cfg.records.length) {
      var toggle = el('div', 'balance-toggle', '📋 Из чего эта сумма ▾');
      head.appendChild(toggle);
      // раскрывашка доступна и с клавиатуры/скринридера: настоящая роль кнопки,
      // фокусируемость и реакция на Enter/Space (для пальца по iPad как было)
      head.className = 'balance-head clickable';
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.setAttribute('aria-expanded', 'false');
      details = el('div', 'balance-details');
      cfg.records.slice().sort(function (a, b) {
        return a.rec.date < b.rec.date ? 1 : -1; // новые сверху
      }).forEach(function (it) {
        details.appendChild(it.type === 'return'
          ? returnCard(it.rec)
          : historyCard({ kind: 'extra', id: it.rec.id, rec: it.rec, date: it.rec.date }));
      });
      var toggleDetails = function () {
        var open = details.classList.toggle('open');
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? '📋 Из чего эта сумма ▴' : '📋 Из чего эта сумма ▾';
      };
      head.addEventListener('click', toggleDetails);
      head.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault();
          toggleDetails();
        }
      });
    }
    (cfg.buttons || []).forEach(function (b) { card.appendChild(b); });
    content.appendChild(card);
    if (details) content.appendChild(details);
  }

  var TS_LABELS = { unsigned: 'не подписан', caregiver: 'подписан метапелем', family: 'подписан Григорием', full: 'полностью подписан', sent: 'отослано' };
  // метка бланка, распознанного как Claims Conference (record.claims ставится при
  // загрузке и при подписании) — чтобы ДО подписания было видно, что его ждёт
  var TS_CLAIMS_NOTE = '<b>Claims Conference</b>: подписи отдельные — Джамшид за каждый рабочий день, Григорий за каждую неделю';

  // «подписанный» файл -signed в архиве есть, только когда в бланк реально
  // поставлена подпись (caregiverSig — картинка или метка «подпись в файле
  // архива»): у бланка Claims одна лишь отметка метапелет файла не даёт
  function tsHasSignedFile(t) { return !!(t && (t.familySigned || t.caregiverSig)); }

  // подпись роли засчитана? (правило «по местам» для Claims — в calc.js); запасной
  // путь — если calc.js остался старым в кэше браузера, вкладка всё равно рисуется
  function tsCareDone(t) {
    return typeof C.timesheetCareDone === 'function' ? C.timesheetCareDone(t) : !!(t && t.caregiverSigned);
  }
  function tsFamDone(t) {
    return typeof C.timesheetFamilyDone === 'function' ? C.timesheetFamilyDone(t) : !!(t && t.familySigned);
  }

  // «Отпечаток» набора подписей eff (см. calc.js timesheetSigKey), из которого
  // собирается файл -signed. При отправке файл сверяется с подписями бланка: файл,
  // пересобранный не из них (старой версией приложения, в гонке устройств), не
  // уйдёт — его предложат пересобрать из сохранённых подписей.
  function tsKeyOf(eff, claims) { return C.timesheetSigKey(C.timesheetSigSpec(eff, claims === true)); }

  // Новый app.js со старым calc.js / sync.js / модулем подписи из кэша браузера
  // подписал бы не так (или не нашёл бы подписи в архиве) — тогда отказываемся.
  function tsModulesFresh() {
    return (window.MetapelTimesheet.apiLevel || 0) >= 2 && typeof C.timesheetCareDone === 'function' &&
      typeof C.timesheetSigsEffective === 'function' && typeof window.MetapelSync.readTimesheetFile === 'function';
  }

  function tsName(t) { return String((t && (t.fileName || t.id)) || ''); }

  // Картинки подписей лежат в файле архива timesheets/<id>-sigs.json (в записи —
  // только метки и счётчики, см. calc.js) и читаются по требованию: перед
  // пересборкой, при пересборке вручную и при отправке. Файла может и не быть
  // (бланк не подписан или подписи пока в самой записи). Возвращает { data, sha }.
  function tsReadSigs(t) {
    return window.MetapelSync.readTimesheetFile(settings, t.id, '-sigs').then(function (res) {
      if (!C.timesheetSigsFileValid(res.data)) {
        throw tsAlertError('Файл подписей бланка «' + tsName(t) + '» в архиве повреждён. Ничего не делаю — сообщите Льву.');
      }
      return res;
    });
  }
  // запись числит подписи (метка / счётчик), а картинок нет ни в ней, ни в архиве —
  // собирать или отправлять бланк без них нельзя (потеряли бы подпись)
  function tsCheckSigs(t, file, roles) {
    var miss = C.timesheetSigsMissing(t, file).filter(function (r) { return !roles || roles.indexOf(r) >= 0; });
    if (!miss.length) return;
    throw tsAlertError('Подписи ' + miss.map(function (r) { return r === 'care' ? 'метапелет' : 'Григория'; }).join(' и ') +
      ' для бланка «' + tsName(t) + '» не найдены в архиве. Без них бланк собирать и отправлять нельзя — сообщите Льву.');
  }
  // ошибка с готовым текстом для пользователя (показывается как есть)
  function tsAlertError(text) { var e = new Error(text); e.tsAlert = true; return e; }

  function findTimesheet(id) {
    for (var i = 0; i < timesheets.length; i++) if (timesheets[i].id === id) return timesheets[i];
    return null;
  }

  function tsBtn(label, cls, fn) {
    var b = el('button', 'btn ' + cls + ' ts-act', label);
    b.addEventListener('click', fn);
    return b;
  }

  function renderTimesheets(content) {
    var btnUp = el('button', 'btn btn-upload', '⬆ Загрузить табель (PDF)');
    btnUp.addEventListener('click', function () { $('#ts-file-input').click(); });
    content.appendChild(btnUp);

    if (!timesheets.length) {
      content.appendChild(el('div', 'empty', 'Табелей пока нет. Загрузите присланный Матав PDF.'));
      return;
    }
    // Карточка = МЕСЯЦ. С 08/2026 Матав присылает ДВА однотипных бланка
    // (обычные часы + дополнительные от Claims Conference) — они объединяются
    // в одну карточку: каждый подписант расписывается ОДИН раз (подпись встаёт
    // в оба бланка), отправка — одним письмом с двумя PDF.
    var months = [], seen = {};
    timesheets.slice().sort(function (a, b) { return a.month < b.month ? 1 : -1; }).forEach(function (t) {
      if (!seen[t.month]) { seen[t.month] = true; months.push(t.month); }
    });
    months.forEach(function (month) {
      var mates = C.timesheetsOfMonth(timesheets, month);
      content.appendChild(mates.length > 1 ? tsGroupCard(month, mates) : tsSingleCard(mates[0]));
    });
  }

  // одиночный бланк месяца — карточка прежнего вида (поведение не менялось)
  function tsSingleCard(t) {
    var st = C.timesheetStatus(t);
    var card = el('div', 'card paid-card');
    var head = el('div', 'card-head');
    var left = el('div', 'card-left');
    left.appendChild(el('div', 'card-title', '📋 Табель ' + esc(tsMonthSlash(t.month))));
    left.appendChild(el('div', 'card-due', 'загружен ' + C.fmtDate(t.uploadedDate)));
    if (t.claims) left.appendChild(el('div', 'card-due', TS_CLAIMS_NOTE));
    head.appendChild(left);
    head.appendChild(el('div', 'ts-chip ts-' + st, TS_LABELS[st]));
    card.appendChild(head);

    var acts = el('div', 'ts-actions');
    // кнопки подписи — пока подпись роли действительно нужна: у бланка Claims — пока
    // нет подписей «по местам», даже если бланк уже отослан (подписанное старой
    // версией так переподписывается и уходит повторно)
    if (!tsCareDone(t)) {
      acts.appendChild(tsBtn('✍ Подписать Метапелет', 'btn-pay', function () { tsSignGroup(t.month, 'caregiver'); }));
    }
    if (!tsFamDone(t)) {
      acts.appendChild(tsBtn('✍ Подпись Григория (член семьи)', 'btn-give-gift', function () { tsSignGroup(t.month, 'family'); }));
    }
    if (tsHasSignedFile(t)) {
      acts.appendChild(tsBtn('⬇ Скачать подписанный PDF', 'btn-light', function () { tsDownload(t.id); }));
    }
    if (st === 'full') {
      // тестовая отправка — себе, для проверки вложения ПЕРЕД письмом в Матав
      acts.appendChild(tsBtn('🧪 Тестовая отправка (только себе)', 'btn-light', function () { tsSend(t.id, true); }));
      acts.appendChild(tsBtn('📧 Отослать в Матав', 'btn-pay', function () { tsSend(t.id); }));
      acts.appendChild(tsBtn('✓ Отметить «Отослано»', 'btn-light', function () { tsMarkSent(t.id); }));
    }
    if (st === 'sent') {
      acts.appendChild(el('div', 'card-due', 'отослано ' + C.fmtDate(t.sentDate)));
      acts.appendChild(tsBtn('🧪 Тестовая отправка (только себе)', 'btn-light', function () { tsSend(t.id, true); }));
      acts.appendChild(tsBtn('📧 Отослать повторно', 'btn-pay', function () { tsSend(t.id); }));
    }
    acts.appendChild(tsBtn('🗑 Удалить табель', 'btn-undo', function () { tsDelete(t.id); }));
    card.appendChild(acts);
    return card;
  }

  // месяц с НЕСКОЛЬКИМИ бланками: одна карточка, одна пара кнопок подписания
  // (каждая подпись рисуется один раз и штампуется во ВСЕ неподписанные бланки),
  // отправка — когда полностью подписаны ВСЕ бланки, одним письмом.
  function tsGroupCard(month, mates) {
    var st = C.timesheetGroupStatus(mates);
    var card = el('div', 'card paid-card');
    var head = el('div', 'card-head');
    var left = el('div', 'card-left');
    left.appendChild(el('div', 'card-title', '📋 Табель ' + esc(tsMonthSlash(month)) + ' · ' +
      mates.length + ' бланка'));
    mates.forEach(function (t, i) {
      left.appendChild(el('div', 'card-due', 'бланк ' + (i + 1) + ': ' +
        esc(String(t.fileName || t.id)) + ' — загружен ' + C.fmtDate(t.uploadedDate) +
        (t.claims ? '<br>' + TS_CLAIMS_NOTE : '')));
    });
    head.appendChild(left);
    head.appendChild(el('div', 'ts-chip ts-' + st, TS_LABELS[st]));
    card.appendChild(head);

    var allSent = mates.every(function (t) { return C.timesheetStatus(t) === 'sent'; });
    var allFull = mates.every(function (t) { var s = C.timesheetStatus(t); return s === 'full' || s === 'sent'; });
    var acts = el('div', 'ts-actions');
    // кнопки подписи — пока подпись роли нужна хоть одному бланку (у бланка Claims —
    // пока нет подписей «по местам», даже после отправки: подписанное старой версией
    // так переподписывается). Сколько раз расписываться, объясняет само окно подписи:
    // обычный бланк — один раз, Claims — метапелет по дням, Григорий по неделям.
    if (mates.some(function (t) { return !tsCareDone(t); })) {
      acts.appendChild(tsBtn('✍ Подписать Метапелет', 'btn-pay',
        function () { tsSignGroup(month, 'caregiver'); }));
    }
    if (mates.some(function (t) { return !tsFamDone(t); })) {
      acts.appendChild(tsBtn('✍ Подпись Григория', 'btn-give-gift',
        function () { tsSignGroup(month, 'family'); }));
    }
    mates.forEach(function (t, i) {
      if (tsHasSignedFile(t)) {
        acts.appendChild(tsBtn('⬇ Скачать бланк ' + (i + 1) + ' (подписанный)', 'btn-light',
          function () { tsDownload(t.id); }));
      }
    });
    if (allFull && !allSent) {
      // тестовая отправка — себе, для проверки вложений ПЕРЕД письмом в Матав
      acts.appendChild(tsBtn('🧪 Тестовая отправка (только себе)', 'btn-light',
        function () { tsSendGroup(month, true); }));
      acts.appendChild(tsBtn('📧 Отослать в Матав (оба бланка одним письмом)', 'btn-pay',
        function () { tsSendGroup(month); }));
      acts.appendChild(tsBtn('✓ Отметить «Отослано»', 'btn-light', function () { tsMarkSentGroup(month); }));
    }
    if (allSent) {
      acts.appendChild(el('div', 'card-due', 'отослано ' + C.fmtDate(mates[0].sentDate)));
      acts.appendChild(tsBtn('🧪 Тестовая отправка (только себе)', 'btn-light',
        function () { tsSendGroup(month, true); }));
      acts.appendChild(tsBtn('📧 Отослать повторно (оба)', 'btn-pay', function () { tsSendGroup(month); }));
    }
    mates.forEach(function (t, i) {
      acts.appendChild(tsBtn('🗑 Удалить бланк ' + (i + 1), 'btn-undo', function () { tsDelete(t.id); }));
    });
    card.appendChild(acts);
    return card;
  }

  function tsDelete(id) {
    appConfirm('Удалить эту карточку табеля? (Файлы в архиве не удаляются.)', '🗑 Удалить', function () {
      S.deleteTimesheet(id);
      reloadData();
      render();
      showToast('Табель удалён');
      runSync();
    });
  }

  // ---------- подписание табелей (Этап 2) ----------

  function tsDateStr(iso) {
    var d = C.parseISO(iso);
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
  }

  // цвет чернил: метапелет (Джамшид) — синий, Григорий (семья) — чёрный
  function tsInkColor(signer) { return signer === 'caregiver' ? '#1d4ed8' : '#000000'; }

  // месяц для показа/письма в формате бланка MM/YYYY (внутри храним YYYY-MM)
  function tsMonthSlash(ym) {
    var p = String(ym || '').split('-');
    return p.length === 2 ? (p[1] + '/' + p[0]) : String(ym || '');
  }

  // получателей письма можно задать НЕСКОЛЬКО — через запятую ИЛИ точку с запятой.
  // EmailJS в поле «To Email» принимает список через запятую, поэтому нормализуем
  // оба разделителя к запятой. Возвращаем массив очищенных адресов.
  function tsParseRecipients(raw) {
    return String(raw || '').split(/[;,]/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }
  function tsIsEmail(a) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a); }

  // Подписать может каждый ОДИН раз. Подписанный PDF ВСЕГДА собирается заново из
  // ИСХОДНОГО бланка + ВСЕХ сохранённых подписей бланка (запись + файл архива
  // timesheets/<id>-sigs.json). Поэтому второе/повторное
  // подписание не может потерять чужую подпись (раньше копили поверх скачанного
  // подписанного — сбой сети/кэша мог затереть подпись первого подписанта).
  // Одиночный бланк и пара бланков месяца подписываются одним путём — tsSignGroup.

  // АНТИ-ГОНКА (инциденты 27.08 и 16.09.2026): перед пересборкой подписанного
  // PDF подтягиваем из облачной копии подписи, которых НЕТ в локальной записи.
  // Иначе устройство, не успевшее сделать pull после подписи на другом
  // устройстве, пересобирало бы файл без чужой подписи и затирало её (пересборка
  // всегда идёт из оригинала + подписей бланка — см. tsBuildSigned).
  // Из облачной ЗАПИСИ берём флаги, метки «подпись в файле архива», счётчики (и
  // картинки — у ещё не перенесённых в файл записей); сами картинки подписей
  // приезжают из файла архива (tsReadSigs). Свою (локальную) подпись облачной не
  // заменяем; облако недоступно — подписываем по локальной записи и файлу архива.
  function tsAdoptCloudSigs(recs) {
    return window.MetapelSync.fetchBackup(settings).then(function (cloud) {
      var byId = {};
      ((cloud && cloud.timesheets) || []).forEach(function (c) { byId[c.id] = c; });
      var changed = false;
      recs.forEach(function (t) {
        var c = byId[t.id];
        if (!c) return;
        var patch = {};
        if (!t.caregiverSig && c.caregiverSig) patch.caregiverSig = c.caregiverSig;
        // отметку без картинки берём только у бланка Claims (так его отмечала v6.11);
        // обычный бланк с флагом без картинки пересобрался бы без подписи метапелет
        if (!t.caregiverSigned && c.caregiverSigned && (c.caregiverSig || c.claims === true)) {
          patch.caregiverSigned = true;
          patch.caregiverSignedDate = c.caregiverSignedDate || today();
        }
        if (!t.familySig && c.familySig) {
          patch.familySig = c.familySig;
          patch.familySigned = true;
          patch.familySignedDate = c.familySignedDate || today();
        }
        // подписи «по местам» (Claims: по дням / по неделям) — массив картинок или
        // счётчик — берём только к ТОЙ ЖЕ первой подписи (или метке), что уже есть у
        // записи (или только что взята): чужой набор к своей подписи не лепим
        tsAdoptPlaces(t, c, patch, 'care');
        tsAdoptPlaces(t, c, patch, 'fam');
        var keys = Object.keys(patch);
        if (keys.length) {
          S.updateTimesheet(t.id, patch);
          // объект t дальше используется пересборкой и колбэками — обновляем и его
          keys.forEach(function (k) { t[k] = patch[k]; });
          changed = true;
        }
      });
      if (changed) reloadData();
    }).catch(function () {});
  }
  function tsAdoptPlaces(t, c, patch, role) {
    var one = role === 'care' ? 'caregiverSig' : 'familySig';
    var many = role === 'care' ? 'caregiverSigs' : 'familySigs';
    var n = role === 'care' ? 'caregiverSigsN' : 'familySigsN';
    var first = patch[one] || t[one];
    if (C.timesheetSigsCount(t, role) > 0 || !(C.timesheetSigsCount(c, role) > 0) || first !== c[one]) return;
    if (Array.isArray(c[many]) && c[many].length) patch[many] = c[many];
    if (typeof c[n] === 'number') patch[n] = c[n];
  }

  // Собирает подписанный PDF из ИСХОДНОГО бланка: метапелет (care-day, синий) +
  // Григорий (family-week, чёрный). sig = { care, cares, fam, fams }: для роли —
  // либо набор подписей «по местам» (бланк Claims: свой день / своя неделя), либо
  // одна подпись во все её места. Роль без подписи или без мест в бланке
  // пропускается — её картинка в PDF даже не встраивается.
  function tsBuildSigned(origU8, slots, sig) {
    var T = window.MetapelTimesheet;
    var p = Promise.resolve(origU8);
    function role(kind, one, many, what) {
      var places = slots.filter(function (s) { return s.kind === kind; });
      if (!places.length) return;
      if (many && many.length) {
        // строго одна подпись на место: «растянуть» последнюю на оставшиеся места
        // значило бы вернуть в бланк одинаковые подписи
        if (many.length < places.length) {
          p = p.then(function () {
            throw new Error('подписей ' + what + ' (' + many.length + ') меньше, чем мест в бланке (' + places.length + ')');
          });
          return;
        }
        p = p.then(function (u8) {
          return T.stampMulti(u8, places.map(function (s, i) { return { slot: s, sigDataUrl: many[i] }; }), {});
        });
      } else if (one) {
        p = p.then(function (u8) { return T.stamp(u8, places, [kind], one, {}); });
      }
    }
    role('care-day', sig.care, sig.cares, 'метапелет по дням');
    role('family-week', sig.fam, sig.fams, 'Григория по неделям');
    return p;
  }

  var tsPreviewSave = null;
  function tsShowPreview(signedU8, onSave, opts) {
    opts = opts || {};
    tsPreviewSave = onSave;
    // тексты ставим КАЖДЫЙ раз (иначе после группового предпросмотра одиночный
    // унаследовал бы «Сохранить оба бланка»)
    $('#ts-preview-save').textContent = opts.btnText || '✓ Сохранить подписанный табель';
    var hint = document.querySelector('#modal-ts-preview .hint');
    if (hint) hint.textContent = opts.hintText || 'Проверьте, что подписи встали по местам. Затем сохраните.';
    $('#modal-ts-preview').classList.add('open');
    updateScrollLock();
    window.MetapelTimesheet.render(signedU8, $('#ts-preview-canvas'), 1.5)
      .catch(function (e) { appAlert('Предпросмотр не отрисовался: ' + (e && e.message || e)); });
  }

  function tsSlotsOf(job, kind) {
    return job.slots.filter(function (s) { return s.kind === kind; });
  }
  function tsHasKind(job, kind) { return tsSlotsOf(job, kind).length > 0; }
  // «1–4 сентября 2026» — рабочие дни недели по бланку (для окна подписи)
  function tsWeekDaysText(month, days) {
    if (!days || !days.length) return '';
    var last = C.fmtDate(month + '-' + ('0' + days[days.length - 1]).slice(-2));
    return (days.length > 1 ? days[0] + '–' : '') + last;
  }
  // «вт, 1 сентября» — рабочий день по бланку (для окна подписи метапелет)
  function tsDayText(month, day) {
    return C.fmtDateShort(month + '-' + ('0' + day).slice(-2));
  }
  // подписи серии по местам бланка: i-е место получает i-ю подпись (серия
  // собирается по бланку Claims с НАИБОЛЬШИМ числом мест — хватает на любой)
  function tsSigsFor(job, kind, sigs) {
    var places = tsSlotsOf(job, kind);
    if (places.length > sigs.length) throw new Error('подписей меньше, чем мест в бланке «' + (job.t.fileName || job.t.id) + '»');
    return places.map(function (s, i) { return sigs[i]; });
  }
  // бланк Claims с наибольшим числом мест данного вида — по нему собирается серия
  function tsClaimsJobFor(jobs, kind) {
    var best = null;
    jobs.forEach(function (j) {
      if (j.claims && tsHasKind(j, kind) && (!best || tsSlotsOf(j, kind).length > tsSlotsOf(best, kind).length)) best = j;
    });
    return best;
  }

  // Занятость подписания: пока бланки грузятся, собираются и сохраняются, окна на
  // экране нет и карточка доступна для нажатий — второе нажатие игнорируем, иначе
  // второй поток перехватил бы окно подписи. Во время открытого окна карточку и
  // так закрывает затемнение. От «вечной» занятости страхует истечение через минуту.
  var tsBusyUntil = 0;
  function tsBusy() { return Date.now() < tsBusyUntil; }
  function tsSetBusy(on) { tsBusyUntil = on ? Date.now() + 60000 : 0; }

  // Перед пересборкой: свежие записи бланков + подписи из облака для ВСЕХ бланков
  // месяца. Выгрузка после подписи отдаёт в облако записи месяца целиком, и чужая
  // подпись (с другого устройства), которой нет в устаревшей локальной записи, была
  // бы затёрта — в том числе на бланке, который сейчас не пересобирается.
  function tsFreshen(jobs, month) {
    reloadData();
    for (var i = 0; i < jobs.length; i++) {
      var f = findTimesheet(jobs[i].t.id);
      // бланк удалили (на другом устройстве) прямо во время подписания
      if (!f) return Promise.reject(new Error('бланк «' + (jobs[i].t.fileName || jobs[i].t.id) + '» удалён — подписание отменено'));
      jobs[i].t = f;
    }
    return tsAdoptCloudSigs(C.timesheetsOfMonth(timesheets, month));
  }

  var TS_NO_CLAIMS = 'В этом месяце два бланка, но бланк Claims Conference не распознан ' +
    '(возможно, Матав изменил бланк). Подписывать не буду, чтобы не ошибиться, — сообщите Льву.';

  function tsHasDup(arr) {
    var seen = {};
    for (var i = 0; i < arr.length; i++) { if (seen[arr[i]]) return true; seen[arr[i]] = true; }
    return false;
  }
  // Последний рубеж перед отправкой в Матав: бланк Claims, подписанный НЕ так, как
  // требует его ответственный (старой версией приложения, по ошибке), не уходит.
  // eff — подписи бланка (запись + файл архива, см. tsSendSigs): полная проверка с
  // дублями. Без eff — предварительная, до чтения архива: по картинкам, оставшимся
  // в записи, или по счётчикам подписей «по местам» (дубли тогда проверятся после).
  function tsClaimsProblem(t, eff) {
    if (!t || t.claims !== true) return null;
    function places(role) {
      var r = eff ? eff[role] : C.timesheetRecordRole(t, role);
      return r && r.sigs ? r.sigs : (eff ? [] : null);
    }
    var cs = places('care'), fs = places('fam');
    if (!(cs ? cs.length : C.timesheetSigsCount(t, 'care'))) return 'нет отдельных подписей метапелет за каждый рабочий день';
    if (!(fs ? fs.length : C.timesheetSigsCount(t, 'fam'))) return 'нет отдельных подписей Григория за каждую неделю';
    if (cs && tsHasDup(cs)) return 'одинаковые подписи метапелет в разных днях';
    if (fs && tsHasDup(fs)) return 'одинаковые подписи Григория в разных неделях';
    return null;
  }

  var TS_STALE = 'Модуль подписи табелей устарел — в браузере осталась его старая копия. ' +
    'Нажмите кнопку 🔄 вверху экрана (обновить приложение) и попробуйте снова.';

  // ПОДПИСАНИЕ бланков месяца (одного или пары): каждая роль расписывается один
  // раз, и подпись штампуется во ВСЕ ещё не подписанные ею бланки; каждый бланк
  // пересобирается из СВОЕГО оригинала + подписей ЕГО записи. Исключение — бланк
  // Claims Conference (parsed.claims): ответственный за него не принимает
  // одинаковые подписи — метапелет расписывается ОТДЕЛЬНО за каждый рабочий день,
  // Григорий — ОТДЕЛЬНО за каждую неделю (серии окон, живые подписи).
  function tsSignGroup(month, signer) {
    if (!window.MetapelSync.isOn(settings)) { appAlert('Архив не настроен (нет токена) — подпись табеля недоступна. Введите токен в настройках.'); return; }
    if (tsBusy()) { showToast('Подождите — идёт подписание…'); return; }
    // новый app.js со старым модулем (или calc.js / sync.js) из кэша подписал бы не так
    if (!tsModulesFresh()) { appAlert(TS_STALE); return; }
    var mates = C.timesheetsOfMonth(timesheets, month);
    var targets = mates.filter(function (t) {
      return signer === 'caregiver' ? !tsCareDone(t) : !tsFamDone(t);
    });
    if (!targets.length) return;
    tsSetBusy(true);
    showToast(targets.length > 1 ? 'Загружаю бланки…' : 'Загружаю бланк…');
    // бланк и его подписи из архива — ДО окон подписи: сбой сети или ненайденные
    // подписи другой роли должны выясниться до того, как человек распишется (у
    // Claims — до 21 раза), а не после
    Promise.all(targets.map(function (t) {
      return Promise.all([
        window.MetapelSync.fetchTimesheetFile(settings, t.id, ''),
        tsReadSigs(t)
      ]).then(function (r) {
        var u8 = window.MetapelTimesheet.u8FromDataUrl(r[0].pdf);
        return window.MetapelTimesheet.parse(u8, { claimsCare: true }).then(function (parsed) {
          if (typeof parsed.claims !== 'boolean') throw new Error(TS_STALE);
          if (!parsed.slots.length) throw new Error('в бланке «' + (t.fileName || t.id) + '» не нашлось мест для подписи');
          return { t: t, u8: u8, slots: parsed.slots, claims: parsed.claims, sigs: r[1] };
        });
      });
    })).then(function (jobs) {
      // два бланка, а Claims среди них не распознан (ни сейчас, ни раньше) —
      // подпись «по-старому» Claims отклонит; лучше остановиться
      var anyClaims = jobs.some(function (j) { return j.claims; }) ||
        mates.some(function (m) { return m.claims === true; });
      if (mates.length >= 2 && !anyClaims) throw new Error(TS_NO_CLAIMS);
      // подписи другой роли должны найтись в записи или в архиве: без них бланк не
      // собрать — останавливаемся до окон подписи
      jobs.forEach(function (j) { tsCheckSigs(j.t, j.sigs.data, [signer === 'caregiver' ? 'fam' : 'care']); });
      // подпись роли уже лежит в архиве (поставлена на другом устройстве, а запись
      // этого бланка проиграла гонку выгрузки) — отмечаем по архиву, не просим заново
      return tsHealFromSigs(jobs).then(function (healed) {
        jobs = jobs.filter(function (j) { return signer === 'caregiver' ? !tsCareDone(j.t) : !tsFamDone(j.t); });
        // отмеченное по архиву — сразу в облако (серию подписи могут и прервать)
        if (healed) { reloadData(); render(); runSync(); }
        if (!jobs.length) {
          tsSetBusy(false);
          appAlert('Эта подпись уже поставлена (на другом устройстве) — карточка обновлена, подписанный бланк пересобран.');
          return;
        }
        tsSetBusy(false);
        if (signer === 'caregiver') tsSignCaregiver(jobs, month);
        else tsSignFamily(jobs, month);
      });
    }).catch(function (e) {
      tsSetBusy(false);
      // часть бланков могла успеть отметиться по архиву (tsHealFromSigs) — показать и выгрузить
      reloadData();
      render();
      runSync();
      var msg = (e && e.message) || String(e);
      appAlert(e && e.tsAlert ? msg : msg === TS_STALE || msg === TS_NO_CLAIMS ? msg : 'Не удалось загрузить/разобрать бланки: ' + msg);
    });
  }

  // Роль, чьи подписи уже лежат в файле архива, а запись бланка их не числит (запись
  // с того устройства проиграла гонку выгрузки) — отмечается по архиву: флаг, метка,
  // счётчик (calc.js timesheetSigsFromFile). Такой бланк сначала ПЕРЕСОБИРАЕТСЯ из
  // полного набора подписей (подписанный PDF того устройства мог остаться без этой
  // роли), и только потом правится запись; не вышло — запись не трогаем. Роль из
  // «не подписана» стала «подписана» — версия бланка, ушедшая в Матав, устарела:
  // «отослано» снимается. Промис: true, если что-то отметили.
  function tsHealFromSigs(jobs) {
    var todo = [];
    jobs.forEach(function (j) {
      var p = C.timesheetSigsFromFile(j.t, j.sigs.data);
      if (!p) return;
      p.claims = j.claims; // как при сохранении подписи: правило «по местам» — по бланку
      var before = JSON.parse(JSON.stringify(j.t)), after = JSON.parse(JSON.stringify(j.t));
      before.claims = j.claims;
      for (var k in p) if (p.hasOwnProperty(k)) after[k] = p[k];
      if ((!tsCareDone(before) && tsCareDone(after)) || (!tsFamDone(before) && tsFamDone(after))) {
        if (j.t.sentMarked) { p.sentMarked = false; p.sentDate = null; }
      }
      todo.push({ job: j, patch: p });
    });
    var chain = Promise.resolve();
    todo.forEach(function (h) {
      chain = chain.then(function () {
        tsCheckSigs(h.job.t, h.job.sigs.data); // собрать можно только из полного набора
        var spec = C.timesheetSigSpec(C.timesheetSigsEffective(h.job.t, h.job.sigs.data), h.job.claims);
        return tsBuildSigned(h.job.u8, h.job.slots, spec).then(function (u8) {
          return window.MetapelSync.putTimesheetFile(settings, h.job.t.id, '-signed', {
            pdf: window.MetapelTimesheet.bytesToDataUrl(u8, 'application/pdf'),
            fileName: h.job.t.fileName, month: h.job.t.month, api: 2, sigKey: C.timesheetSigKey(spec)
          });
        }).then(function () {
          S.updateTimesheet(h.job.t.id, h.patch);
          for (var k in h.patch) if (h.patch.hasOwnProperty(k)) h.job.t[k] = h.patch[k];
        });
      });
    });
    return chain.then(function () { return todo.length > 0; });
  }
  // Подписи бланков перед сборкой — свежие из архива; сеть мигнула — по прочитанному
  // перед подписанием (сохранение всё равно перечитает файл с CAS, проверит подписи
  // другой роли и пересоберёт PDF, если они изменились). Только что поставленные
  // подписи из-за сбоя сети не теряются.
  function tsRefreshSigs(jobs) {
    return Promise.all(jobs.map(function (job) {
      return tsReadSigs(job.t).then(function (res) { job.sigs = res; job.sigsStale = false; }, function (e) {
        if (e && e.tsAlert) throw e; // файл повреждён — это не сбой сети
        job.sigsStale = true;
      });
    }));
  }

  // Серия окон подписи: по ОДНОЙ живой подписи на каждое место (день / неделю)
  // бланка Claims. «Прервать» в любом окне отменяет ВСЮ серию — ничего не
  // сохраняется. Подпись, точь-в-точь совпавшая с подписью другого места, — это
  // одинаковые касания, а не живая роспись: то же место просим подписать заново.
  // o: { n, unit, title(k), desc(k), toast(k), dupText, abortText, color, onDone(sigs) }
  function tsSignSeries(o) {
    var sigs = [];
    function ask(k) {
      openFingerSign(o.title(k), o.desc(k),
        k + 1 < o.n ? '✓ Готово — дальше ' + o.unit + ' ' + (k + 2) : '✓ Готово',
        'Распишитесь пальцем в рамке и нажмите «Готово».',
        function (sig) {
          if (sigs.indexOf(sig) >= 0) {
            appAlert(o.dupText);
            ask(k);
            return;
          }
          sigs.push(sig);
          if (k + 1 < o.n) {
            showToast(o.toast(k));
            // следующее окно — сразу, без паузы: в паузе окна нет и карточка под
            // ним открыта для случайного нажатия; двойное касание «Готово» гасит
            // щит от касаний (0,5 с после закрытия окна)
            ask(k + 1);
          } else {
            tsSeriesCount = 0;
            o.onDone(sigs);
          }
        }, o.color);
      // в серии эта кнопка выбрасывает и уже собранные подписи — так и назовём;
      // при уже собранных подписях «Прервать» сначала переспросит (см. sign-later)
      $('#sign-later').textContent = o.abortText;
      tsSeriesCount = sigs.length;
    }
    ask(0);
  }
  // сколько живых подписей уже собрано в текущей серии окон (для вопроса при «Прервать»)
  var tsSeriesCount = 0;

  // Метапелет: на обычном бланке — одна подпись во все рабочие дни (как раньше).
  // Если среди бланков есть Claims — подписи собираются ПО ОДНОЙ на каждый его
  // рабочий день; первая из них встаёт и во все дни обычного бланка (не
  // расписываться лишний раз).
  function tsSignCaregiver(jobs, month) {
    var stampJobs = jobs.filter(function (j) { return tsHasKind(j, 'care-day'); });
    // бланк без единого рабочего дня (мест метапелет нет) — только отметка
    var flagJobs = jobs.filter(function (j) { return !tsHasKind(j, 'care-day'); });
    function flagPatch(j) { return { caregiverSigned: true, caregiverSignedDate: today(), claims: j.claims }; }
    if (!stampJobs.length) {
      appConfirm('В этом бланке нет мест для подписи метапелет. Отметить этот шаг как выполненный?', '✓ Отметить', function () {
        if (tsBusy()) { showToast('Подождите — идёт подписание…'); return; }
        tsSetBusy(true);
        // и здесь сперва облако: отметка уходит в облако вместе с записями месяца
        tsFreshen(jobs, month).then(function () {
          flagJobs.forEach(function (j) { S.updateTimesheet(j.t.id, flagPatch(j)); });
          tsSetBusy(false);
          reloadData();
          render();
          showToast('✓ Отмечено');
          runSync();
        }).catch(function (e) { tsSetBusy(false); appAlert('Не удалось отметить: ' + (e && e.message || e)); });
      });
      return;
    }
    var claimsJob = tsClaimsJobFor(stampJobs, 'care-day');
    var days = claimsJob ? tsSlotsOf(claimsJob, 'care-day') : [];

    function finish(sigs) {
      var items = [];
      tsSetBusy(true);
      showToast('Расставляю подписи…');
      tsFreshen(jobs, month).then(function () {
        return tsRefreshSigs(stampJobs);
      }).then(function () {
        // у бланка Claims подписи Григория — только «по неделям» (fams);
        // одна старая подпись на все недели в него не ставится (см. timesheetSigSpec)
        items = stampJobs.map(function (job) {
          return tsSignItem(job, 'care', { sig: sigs[0], sigs: job.claims ? tsSigsFor(job, 'care-day', sigs) : null, date: today() });
        });
        return Promise.all(items.map(function (it) { return tsBuildSigned(it.job.u8, it.job.slots, C.timesheetSigSpec(it.eff, it.job.claims)); }));
      }).then(function (signedList) {
        signedList.forEach(function (u8, i) { items[i].u8 = u8; });
        var all = items.concat(flagJobs.map(function (j) { return { job: j, flag: flagPatch(j) }; }));
        var opts = null;
        if (claimsJob) {
          opts = { btnText: all.length > 1 ? '✓ Сохранить оба бланка' : null,
            hintText: 'Показан бланк Claims Conference: в каждом рабочем дне — своя подпись метапелет.' +
              (stampJobs.length > 1 ? ' В другом бланке подпись дня 1 встанет во все дни.' : '') + ' Затем сохраните.' };
        } else if (all.length > 1) {
          opts = { btnText: '✓ Сохранить оба бланка',
            hintText: 'Показан бланк 1 из ' + stampJobs.length + ' — во втором подписи встанут так же. Затем сохраните.' };
        }
        tsSetBusy(false);
        tsShowPreview(signedList[claimsJob ? stampJobs.indexOf(claimsJob) : 0],
          function () { tsSaveSignedGroup(all); }, opts);
      }).catch(function (e) { tsSetBusy(false); appAlert(tsSignErrorText(e)); });
    }

    if (!days.length) {
      openFingerSign('✍ Подпись Метапелет',
        'Распишитесь <b>один раз</b> — синяя подпись Джамшида встанет в каждый рабочий день' +
          (stampJobs.length > 1 ? ' <b>в обоих бланках месяца</b>.' : '.'),
        '✓ Готово', 'Распишитесь пальцем в рамке и нажмите «Готово».',
        function (sig) { finish([sig]); }, tsInkColor('caregiver'));
      return;
    }
    tsSignSeries({
      n: days.length, unit: 'день', color: tsInkColor('caregiver'),
      title: function (k) { return '✍ Подпись Метапелет — день ' + (k + 1) + ' из ' + days.length; },
      desc: function (k) {
        return 'Для бланка Claims Conference нужна <b>отдельная подпись за каждый рабочий день</b>.<br>' +
          'Сейчас — день ' + (k + 1) + ': <b>' + esc(tsDayText(month, days[k].day)) + '</b>.' +
          (k === 0 && stampJobs.length > 1 ? '<br>Эта подпись встанет и во все дни другого бланка.' : '');
      },
      toast: function (k) { return '✓ День ' + (k + 1) + ' из ' + days.length + ' подписан'; },
      dupText: 'Эта подпись точь-в-точь совпадает с подписью другого дня. Распишитесь за этот день ещё раз.',
      abortText: 'Прервать (все дни — заново)',
      onDone: finish
    });
  }

  // Григорий: обычный бланк — одна подпись во все недели (как раньше). Если среди
  // бланков есть Claims — подписи собираются ПО ОДНОЙ на каждую его неделю; первая
  // из них встаёт и во все недели обычного бланка (не расписываться лишний раз).
  function tsSignFamily(jobs, month) {
    var claimsJob = tsClaimsJobFor(jobs, 'family-week');
    var weeks = claimsJob ? tsSlotsOf(claimsJob, 'family-week') : [];

    function finish(sigs) {
      var items = [];
      tsSetBusy(true);
      showToast('Расставляю подписи…');
      tsFreshen(jobs, month).then(function () {
        return tsRefreshSigs(jobs);
      }).then(function () {
        // у бланка Claims подписи метапелет — только «по дням» (cares)
        items = jobs.map(function (job) {
          return tsSignItem(job, 'fam', { sig: sigs[0], sigs: job.claims ? tsSigsFor(job, 'family-week', sigs) : null, date: today() });
        });
        return Promise.all(items.map(function (it) { return tsBuildSigned(it.job.u8, it.job.slots, C.timesheetSigSpec(it.eff, it.job.claims)); }));
      }).then(function (signedList) {
        signedList.forEach(function (u8, i) { items[i].u8 = u8; });
        var opts = null;
        if (claimsJob) {
          opts = { btnText: jobs.length > 1 ? '✓ Сохранить оба бланка' : null,
            hintText: 'Показан бланк Claims Conference: в каждой неделе — своя подпись.' +
              (jobs.length > 1 ? ' В другом бланке подпись недели 1 встанет во все недели.' : '') + ' Затем сохраните.' };
        } else if (jobs.length > 1) {
          opts = { btnText: '✓ Сохранить оба бланка',
            hintText: 'Показан бланк 1 из ' + jobs.length + ' — во втором подписи встанут так же. Затем сохраните.' };
        }
        tsSetBusy(false);
        tsShowPreview(signedList[claimsJob ? jobs.indexOf(claimsJob) : 0],
          function () { tsSaveSignedGroup(items); }, opts);
      }).catch(function (e) { tsSetBusy(false); appAlert(tsSignErrorText(e)); });
    }

    if (!weeks.length) {
      openFingerSign('✍ Подпись за Григория',
        'Распишитесь <b>один раз</b> за Григория — чёрная недельная подпись встанет на каждую рабочую неделю' +
          (jobs.length > 1 ? ' <b>в обоих бланках месяца</b>.' : '.'),
        '✓ Готово', 'Распишитесь пальцем в рамке и нажмите «Готово».',
        function (sig) { finish([sig]); }, tsInkColor('family'));
      return;
    }
    tsSignSeries({
      n: weeks.length, unit: 'неделя', color: tsInkColor('family'),
      title: function (k) { return '✍ Подпись Григория — неделя ' + (k + 1) + ' из ' + weeks.length; },
      desc: function (k) {
        return 'Для бланка Claims Conference нужна <b>отдельная подпись за каждую неделю</b>.<br>' +
          'Сейчас — неделя ' + (k + 1) + ': <b>' + esc(tsWeekDaysText(month, weeks[k].days)) + '</b>.' +
          (k === 0 && jobs.length > 1 ? '<br>Эта подпись встанет и во все недели другого бланка.' : '');
      },
      toast: function (k) { return '✓ Неделя ' + (k + 1) + ' из ' + weeks.length + ' подписана'; },
      dupText: 'Эта подпись точь-в-точь совпадает с подписью другой недели. Распишитесь за эту неделю ещё раз.',
      abortText: 'Прервать (все недели — заново)',
      onDone: finish
    });
  }

  // Подпись роли для бланка job: own — только что поставленные подписи роли
  // ({ sig, sigs, date }); eff — полный набор бланка (с подписями другой роли из
  // записи / файла архива), из которого собирается предпросмотр. Подписи ДРУГОЙ
  // роли должны быть на месте — без них бланк не собираем (потеряли бы чужую подпись).
  // Если файл перечитать не удалось (сеть), решает сохранение: оно перечитает файл,
  // проверит подписи другой роли и пересоберёт PDF (а новые подписи не выбросим).
  function tsSignItem(job, role, own) {
    if (!job.sigsStale) tsCheckSigs(job.t, job.sigs.data, [role === 'care' ? 'fam' : 'care']);
    var eff = C.timesheetSigsWith(C.timesheetSigsEffective(job.t, job.sigs.data), role, own);
    return { job: job, role: role, own: own, eff: eff };
  }
  function tsSignErrorText(e) {
    return e && e.tsAlert ? e.message : 'Ошибка расстановки подписи: ' + (e && e.message || e);
  }

  // Сохраняет подпись роли на одном бланке:
  //  1) файл подписей timesheets/<id>-sigs.json — с CAS по sha: свежая версия файла
  //     перечитывается и сводится с новой подписью; подпись другой роли, поставленная
  //     тем временем на ДРУГОМ устройстве, не теряется (тогда и PDF пересобирается с
  //     ней); гонка записи — перечитать и повторить;
  //  2) подписанный PDF с отпечатком набора (sigKey);
  //  3) запись — метки, счётчики, отпечаток, флаги (картинок в записи больше нет).
  function tsCommitSigned(it, n) {
    var job = it.job, id = job.t.id, role = it.role, other = role === 'care' ? 'fam' : 'care';
    return tsReadSigs(job.t).then(function (res) {
      reloadData();
      var cur = findTimesheet(id);
      if (!cur) throw tsAlertError('Бланк «' + tsName(job.t) + '» удалён — подпись не сохранена.');
      tsCheckSigs(cur, res.data, [other]);
      var base = C.timesheetSigsEffective(cur, res.data);
      // прежний набор этой роли (в т.ч. поставленный на другом устройстве, пока здесь
      // расписывались) остаётся в prev — живая подпись не пропадает; действует новый
      var eff = C.timesheetSigsWith(base, role, it.own, true);
      var spec = C.timesheetSigSpec(eff, job.claims);
      var key = C.timesheetSigKey(spec);
      // подписи другой роли изменились с момента предпросмотра — PDF собираем заново
      // (не собирается — это не сбой сети: повтором не исправить)
      var built = key === tsKeyOf(it.eff, job.claims) ? Promise.resolve(it.u8)
        : tsBuildSigned(job.u8, job.slots, spec).catch(function (be) {
          throw tsAlertError('Бланк «' + tsName(job.t) + '» не собрать: ' + (be && be.message || be) + ' — сообщите Льву.');
        });
      return built.then(function (u8) {
        var putSigs = C.timesheetSigsFileSame(res.data, cur, eff) ? Promise.resolve()
          : window.MetapelSync.putTimesheetFile(settings, id, '-sigs', C.timesheetSigsFile(cur, eff), res.sha || null);
        return putSigs.then(function () {
          return window.MetapelSync.putTimesheetFile(settings, id, '-signed', {
            pdf: window.MetapelTimesheet.bytesToDataUrl(u8, 'application/pdf'),
            fileName: cur.fileName, month: cur.month, api: 2, sigKey: key
          });
        }).then(function () {
          var patch = C.timesheetSigsLight(eff, job.claims);
          patch.claims = job.claims;
          if (role === 'care') { patch.caregiverSigned = true; patch.caregiverSignedDate = today(); }
          else { patch.familySigned = true; patch.familySignedDate = today(); }
          // подпись другой роли есть в архиве, а запись её не числит (запись того
          // устройства проиграла гонку выгрузки) — отмечаем по архиву
          if (other === 'care' && eff.care && !cur.caregiverSigned) {
            patch.caregiverSigned = true; patch.caregiverSignedDate = eff.care.date || today();
          }
          if (other === 'fam' && eff.fam && !cur.familySigned) {
            patch.familySigned = true; patch.familySignedDate = eff.fam.date || today();
          }
          // переподписанный бланк — уже НЕ та версия, что ушла в Матав: снимаем
          // «отослано», чтобы новую версию не забыли отправить
          if (cur.sentMarked) { patch.sentMarked = false; patch.sentDate = null; }
          S.updateTimesheet(id, patch);
        });
      });
    }).catch(function (e) {
      if (e && e.cas) {
        if ((n || 0) < 2) return tsCommitSigned(it, (n || 0) + 1);
        // не «обновите страницу»: подписи пока только в памяти — перезагрузка их выбросит
        throw new Error('архив в эту минуту меняет другое устройство');
      }
      throw e;
    });
  }

  // Сохраняет бланки ПОСЛЕДОВАТЕЛЬНО (см. tsCommitSigned); it.flag — только отметка
  // в записи, без файла. При сбое на середине уже сохранённые остаются, а
  // несохранённые можно сохранить повторно из уже поставленных подписей —
  // расписываться заново (до 21 подписи) не нужно. Бланк, который сохранить
  // нельзя в принципе (удалён, нет подписей другой роли в архиве), пропускается —
  // остальные сохраняются; итог перечисляет пропущенные.
  function tsSaveSignedGroup(items, skipped) {
    skipped = skipped || [];
    tsSetBusy(true);
    showToast('Сохраняю подписанные бланки…');
    var i = 0;
    function next() {
      if (i >= items.length) {
        tsSetBusy(false);
        reloadData();
        render();
        if (skipped.length) appAlert('Не сохранено:\n' + skipped.join('\n'));
        else showToast(items.length > 1 ? '✓ Подписи сохранены' : '✓ Подпись сохранена');
        runSync();
        return;
      }
      var at = i, it = items[i];
      i++;
      if (!it.own) { S.updateTimesheet(it.job.t.id, it.flag); next(); return; }
      tsCommitSigned(it, 0).then(next, function (e) {
        if (e && e.tsAlert) { skipped.push(e.message); next(); return; }
        tsSetBusy(false);
        reloadData();
        render();
        runSync();
        appConfirm('Бланк «' + tsName(it.job.t) + '» не сохранился: ' + (e && e.message || e) +
          (skipped.length ? '\nНе сохранено и повтором не исправить:\n' + skipped.join('\n') : '') +
          '\nОстальные сохранённые бланки в порядке. Повторить сохранение? Расписываться заново не нужно.',
          '🔁 Повторить сохранение', function () { tsSaveSignedGroup(items.slice(at), skipped); });
      });
    }
    next();
  }

  // Файлы -signed не совпали с подписями бланков (их пересобрала старая версия
  // приложения или другое устройство в гонке) — предлагаем пересобрать из
  // сохранённых подписей, без новой росписи. list — один бланк или оба бланка
  // месяца сразу; forDownload — пересборку предложило скачивание.
  function tsOfferRebuild(list, forDownload) {
    var many = list.length > 1;
    var names = list.map(function (t) { return '«' + tsName(t) + '»' + (t.claims === true ? ' (Claims Conference)' : ''); }).join(' и ');
    appConfirm((many ? 'Файлы бланков ' : 'Файл бланка ') + names + (many ? ' не совпадают' : ' не совпадает') +
      ' с сохранёнными подписями — похоже, ' + (many ? 'их' : 'его') + ' пересобрала старая версия приложения. ' +
      (forDownload ? 'Скачивать такой файл не стоит.' : 'В Матав не отправляю.') + '\n' +
      'Пересобрать из сохранённых подписей? Расписываться заново не нужно. Потом ' +
      (forDownload ? 'скачайте' : 'отправьте') + ' ещё раз.',
      '🔧 Пересобрать', function () { tsRebuildSigned(list.map(function (t) { return t.id; }), forDownload); });
  }
  function tsRebuildSigned(ids, forDownload) {
    if (tsBusy()) { showToast('Подождите — идёт подписание…'); return; }
    if (!tsModulesFresh()) { appAlert(TS_STALE); return; }
    ids = [].concat(ids);
    tsSetBusy(true);
    showToast(ids.length > 1 ? 'Пересобираю бланки…' : 'Пересобираю бланк…');
    var chain = Promise.resolve();
    ids.forEach(function (id) { chain = chain.then(function () { return tsRebuildOne(id); }); });
    chain.then(function () {
      tsSetBusy(false);
      showToast('✓ Пересобрано из сохранённых подписей — ' + (forDownload ? 'скачайте' : 'отправьте') + ' ещё раз');
    }).catch(function (e) {
      tsSetBusy(false);
      appAlert(e && e.tsAlert ? e.message : 'Не удалось пересобрать бланк: ' + (e && e.message || e));
    });
  }
  function tsRebuildOne(id) {
    var t = findTimesheet(id);
    if (!t) return Promise.resolve();
    var spec = null;
    return tsReadSigs(t).then(function (res) {
      tsCheckSigs(t, res.data);
      spec = C.timesheetSigSpec(C.timesheetSigsEffective(t, res.data), t.claims === true);
      return window.MetapelSync.fetchTimesheetFile(settings, id, '');
    }).then(function (obj) {
      var u8 = window.MetapelTimesheet.u8FromDataUrl(obj.pdf);
      return window.MetapelTimesheet.parse(u8, { claimsCare: true }).then(function (parsed) {
        return tsBuildSigned(u8, parsed.slots, spec);
      });
    }).then(function (signedU8) {
      return window.MetapelSync.putTimesheetFile(settings, id, '-signed', {
        pdf: window.MetapelTimesheet.bytesToDataUrl(signedU8, 'application/pdf'),
        fileName: t.fileName, month: t.month, api: 2, sigKey: C.timesheetSigKey(spec)
      });
    });
  }
  // ошибка этапа «бланк и подписи из архива» — не ошибка EmailJS (в Матав ничего не ушло)
  function tsArchiveStage(e) {
    if (e && typeof e === 'object' && !e.tsAlert && !e.tsRebuild) e.tsArchive = true;
    throw e;
  }
  function tsArchiveFailText(e) {
    return 'Не удалось получить подписанный бланк или подписи из архива: ' + (e && e.message || e) +
      '\nВ Матав ничего не ушло. Проверьте интернет и попробуйте ещё раз.';
  }
  // true — файл -signed собран НЕ из подписей бланка eff. Бланк Claims сверяется
  // всегда (кроме непригодных подписей — их и так не отправить); обычный — если
  // файл несёт отпечаток (файлы до v6.12 его не несут — им верим, как раньше).
  function tsStaleSigned(t, eff, obj) {
    if (!t) return false;
    var key = tsKeyOf(eff, t.claims);
    if (t.claims === true) {
      if (tsClaimsProblem(t, eff)) return false;
      return !obj || obj.sigKey !== key;
    }
    return !!(obj && obj.sigKey) && obj.sigKey !== key;
  }
  // Подписи бланка для проверки перед отправкой: запись + файл архива; бланк Claims,
  // подписанный не так, как требуется, не уходит (кроме теста себе). n — номер
  // бланка в письме (0 — бланк один).
  function tsSendSigs(t, file, isTest, n) {
    tsCheckSigs(t, file);
    var eff = C.timesheetSigsEffective(t, file);
    var prob = isTest ? null : tsClaimsProblem(t, eff);
    if (prob) throw tsAlertError(tsClaimsBlockText(n, prob));
    return eff;
  }

  // ---------- скачивание / отправка (Этап 3) ----------

  function tsDownload(id) {
    var t = findTimesheet(id);
    if (!t) return;
    if (!window.MetapelSync.isOn(settings)) { appAlert('Архив не настроен (нет токена).'); return; }
    var suffix = tsHasSignedFile(t) ? '-signed' : '';
    showToast('Готовлю файл…');
    Promise.all([
      window.MetapelSync.fetchTimesheetFile(settings, id, suffix),
      // подписи бланка — чтобы, как и отправка, не выдать файл, собранный не из них
      // (не прочитались — скачиваем как есть: скачивание ничего не отправляет)
      suffix && tsModulesFresh() ? tsReadSigs(t).catch(function () { return null; }) : null
    ]).then(function (r) {
      var obj = r[0], sigs = r[1];
      if (sigs && !C.timesheetSigsMissing(t, sigs.data).length &&
          tsStaleSigned(t, C.timesheetSigsEffective(t, sigs.data), obj)) { tsOfferRebuild([t], true); return; }
      var u8 = window.MetapelTimesheet.u8FromDataUrl(obj.pdf);
      var blob = new Blob([u8], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = String(t.fileName || ('tabel-' + t.month)).replace(/\.pdf$/i, '') + (suffix ? '-signed' : '') + '.pdf';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.parentNode && a.parentNode.removeChild(a); }, 1500);
    }).catch(function (e) { appAlert('Не удалось скачать: ' + (e && e.message || e)); });
  }

  function tsMarkSent(id) {
    appConfirm('Отметить табель как отосланный в Матав?', '✓ Отослано', function () {
      S.updateTimesheet(id, { sentMarked: true, sentDate: today() });
      reloadData();
      render();
      showToast('✓ Отмечено: отослано');
      runSync();
    });
  }

  function tsMarkSentGroup(month) {
    var mates = C.timesheetsOfMonth(timesheets, month);
    appConfirm('Отметить ОБА бланка месяца как отосланные в Матав?', '✓ Отослано', function () {
      mates.forEach(function (t) { S.updateTimesheet(t.id, { sentMarked: true, sentDate: today() }); });
      reloadData();
      render();
      showToast('✓ Отмечено: отослано');
      runSync();
    });
  }

  // Отправка ВСЕХ бланков месяца ОДНИМ письмом. Второй PDF идёт параметрами
  // content2/filename2 — в шаблоне EmailJS должно быть настроено ВТОРОЕ
  // Variable Attachment (см. настройку шаблона); для месяцев с одним бланком
  // параметры content2/filename2 не передаются вовсе — вложение пропускается.
  // isTest: письмо уходит ТОЛЬКО на «тестового получателя» из настроек, тема с
  // пометкой [ТЕСТ], статус «отослано» НЕ ставится — проверка вложений перед
  // боевым письмом в Матав (ошибки отправки табелей уже случались).
  function tsClaimsBlockText(n, prob) {
    return 'Бланк ' + (n ? n + ' ' : '') + '(Claims Conference) подписан не так, как требуется: ' + prob + '. ' +
      'В Матав не отправляю. Как исправить: обновите приложение (🔄) — на карточке появится кнопка подписи; ' +
      'распишитесь заново (Джамшид — за каждый день, Григорий — за каждую неделю) и отправьте. ' +
      'Если кнопки нет — удалите бланк кнопкой «🗑 Удалить бланк» и загрузите его PDF заново.';
  }

  function tsSendGroup(month, isTest) {
    var mates = C.timesheetsOfMonth(timesheets, month);
    if (mates.length > 2) { appAlert('Поддерживается не больше двух бланков в месяце (в письме два вложения).'); return; }
    if (mates.length < 2) { if (mates.length === 1) tsSend(mates[0].id, isTest); return; }
    // подписи бланков проверяются по файлам архива — нужен свежий calc.js / sync.js
    if (!tsModulesFresh()) { appAlert(TS_STALE); return; }
    if (!isTest) {
      for (var qi = 0; qi < mates.length; qi++) {
        var prob = tsClaimsProblem(mates[qi]);
        if (prob) { appAlert(tsClaimsBlockText(qi + 1, prob)); return; }
      }
    }
    var ej = settings.emailjs || {};
    if (!ej.serviceId || !ej.templateId || !ej.publicKey || (!isTest && !ej.recipient)) {
      appAlert('Авто-отправка (EmailJS) не настроена. Зайдите в Настройки → «Отправка в Матав (EmailJS)» и заполните поля. Либо скачайте оба подписанных PDF, отправьте письмом вручную и отметьте «Отослано».');
      return;
    }
    if (!window.MetapelSync.isOn(settings)) { appAlert('Архив не настроен (нет токена).'); return; }
    var toList = tsParseRecipients(isTest ? ej.testRecipient : ej.recipient);
    if (!toList.length) {
      appAlert(isTest
        ? 'Тестовый адрес не указан. Настройки → «Отправка табелей в Матав (EmailJS)» → «Тестовый получатель».'
        : 'Не указан e-mail получателя (Матав) в настройках.');
      return;
    }
    var badEmails = toList.filter(function (a) { return !tsIsEmail(a); });
    if (badEmails.length) {
      appAlert('Похоже, эти адреса записаны с ошибкой:\n' + badEmails.join('\n') +
        '\n\nПроверьте список получателей в Настройках (адреса через запятую или точку с запятой).');
      return;
    }
    var toStr = toList.join(', ');
    var already = mates.every(function (t) { return !!t.sentMarked; });
    var confirmMsg = isTest
      ? 'Отправить ОБА бланка ТЕСТОВЫМ письмом — только себе, БЕЗ Матав?\n\nКому: ' + toList.join(', ')
      : (already ? 'Отправить ОБА бланка ПОВТОРНО' : 'Отправить ОБА подписанных бланка') +
        ' одним письмом в Матав?\n\nКому: ' + toList.join(', ');
    appConfirm(confirmMsg, isTest ? '🧪 Отправить тест' : (already ? '📧 Отослать повторно' : '📧 Отправить'), function () {
      showToast('Готовлю и отправляю…');
      Promise.all(mates.map(function (t, qi) {
        return Promise.all([
          window.MetapelSync.fetchTimesheetFile(settings, t.id, '-signed'),
          tsReadSigs(t)
        ]).then(function (r) {
          var obj = r[0], eff = tsSendSigs(t, r[1].data, isTest, qi + 1);
          // файл должен быть собран ровно из подписей бланка (см. timesheetSigKey)
          return { t: t, obj: obj, stale: tsStaleSigned(t, eff, obj) };
        });
      })).catch(tsArchiveStage).then(function (res) {
        // несовпавшие файлы — оба сразу (одна пересборка, а не «пересобрать → отправить» дважды)
        var stale = res.filter(function (x) { return x.stale; }).map(function (x) { return x.t; });
        if (stale.length) { var se = new Error('stale'); se.tsRebuild = stale; throw se; }
        return res.map(function (x) {
          var dataUri = String(x.obj.pdf);
          return dataUri.indexOf('data:') === 0 ? dataUri : 'data:application/pdf;base64,' + dataUri;
        });
      }).then(function (uris) {
        var monthSlash = tsMonthSlash(month);
        var subject = (isTest ? '[ТЕСТ] ' : '') + 'יומן עבודה חתום — ' + monthSlash;
        var messageHtml =
          '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:#1f2937;">' +
            '<p>לכבוד מטב,</p>' +
            '<p>מצורפים בזאת <b>שני יומני עבודה חתומים</b> עבור המטופל <b>גריגורי רזומובסקי</b> לתקופה <b>' + monthSlash + '</b>.</p>' +
            '<p>היומנים חתומים כנדרש.</p>' +
            '<p>נא לאשר את קבלת המסמכים. תודה רבה.</p>' +
            '<p style="margin-top:18px;">בברכה,<br>משפחת רזומובסקי</p>' +
          '</div>';
        return tsLoadEmailJS().then(function () {
          return window.emailjs.send(ej.serviceId, ej.templateId, {
            to_email: toStr, recipient: toStr, month: monthSlash,
            subject: subject, message_html: messageHtml,
            filename: 'tabel-' + month + '-1-signed.pdf', content: uris[0],
            filename2: 'tabel-' + month + '-2-signed.pdf', content2: uris[1]
          }, { publicKey: ej.publicKey });
        });
      }).then(function () {
        if (isTest) {
          // статусы НЕ трогаем: тест — не отправка в Матав
          showToast('✓ Тестовое письмо отправлено — проверьте почту');
          return;
        }
        mates.forEach(function (t) { S.updateTimesheet(t.id, { sentMarked: true, sentDate: today() }); });
        reloadData();
        render();
        showToast('✓ Оба бланка отосланы в Матав');
        runSync();
      }).catch(function (e) {
        if (e && e.tsRebuild) { tsOfferRebuild(e.tsRebuild); return; }
        if (e && e.tsAlert) { appAlert(e.message); return; }
        if (e && e.tsArchive) { appAlert(tsArchiveFailText(e)); return; }
        appAlert('Не удалось отправить через EmailJS: ' + (e && (e.text || e.message) || e) +
          '\n\nЗапасной путь: скачать оба подписанных PDF, отправить вручную, затем «Отметить Отослано».');
      });
    });
  }

  function tsSend(id, isTest) {
    // авто-отправка через EmailJS (см. tsSendEmail); при отсутствии настроек —
    // подсказываем запасной путь (скачать + отметить вручную)
    tsSendEmail(id, isTest);
  }

  function tsLoadEmailJS() {
    if (window.emailjs) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'js/vendor/emailjs.min.js';
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('EmailJS SDK не загрузился')); };
      document.head.appendChild(s);
    });
  }

  function tsSendEmail(id, isTest) {
    var t = findTimesheet(id);
    if (!t) return;
    // подписи бланка проверяются по файлу архива — нужен свежий calc.js / sync.js
    if (!tsModulesFresh()) { appAlert(TS_STALE); return; }
    var prob = isTest ? null : tsClaimsProblem(t);
    if (prob) { appAlert(tsClaimsBlockText(0, prob)); return; }
    var ej = settings.emailjs || {};
    if (!ej.serviceId || !ej.templateId || !ej.publicKey || (!isTest && !ej.recipient)) {
      appAlert('Авто-отправка (EmailJS) не настроена. Зайдите в Настройки → «Отправка в Матав (EmailJS)» и заполните поля. Либо нажмите «Скачать подписанный PDF», отправьте письмом вручную и отметьте «Отослано».');
      return;
    }
    if (!window.MetapelSync.isOn(settings)) { appAlert('Архив не настроен (нет токена).'); return; }
    // получателей может быть несколько (через запятую/точку с запятой) — нормализуем;
    // тест уходит ТОЛЬКО на тестового получателя (см. tsSendGroup)
    var toList = tsParseRecipients(isTest ? ej.testRecipient : ej.recipient);
    if (!toList.length) {
      appAlert(isTest
        ? 'Тестовый адрес не указан. Настройки → «Отправка табелей в Матав (EmailJS)» → «Тестовый получатель».'
        : 'Не указан e-mail получателя (Матав) в настройках.');
      return;
    }
    var badEmails = toList.filter(function (a) { return !tsIsEmail(a); });
    if (badEmails.length) {
      appAlert('Похоже, эти адреса записаны с ошибкой:\n' + badEmails.join('\n') +
        '\n\nПроверьте список получателей в Настройках (адреса через запятую или точку с запятой).');
      return;
    }
    var toStr = toList.join(', '); // EmailJS «To Email» принимает список через запятую
    var already = !!t.sentMarked;
    var confirmMsg = isTest
      ? 'Отправить табель ТЕСТОВЫМ письмом — только себе, БЕЗ Матав?\n\nКому: ' + toList.join(', ')
      : (already ? 'Отправить табель ПОВТОРНО' : 'Отправить подписанный табель') +
        ' письмом в Матав?\n\nКому: ' + toList.join(', ');
    appConfirm(confirmMsg, isTest ? '🧪 Отправить тест' : (already ? '📧 Отослать повторно' : '📧 Отправить'), function () {
      showToast('Готовлю и отправляю…');
      var suffix = tsHasSignedFile(t) ? '-signed' : '';
      Promise.all([
        window.MetapelSync.fetchTimesheetFile(settings, id, suffix),
        tsReadSigs(t)
      ]).then(function (r) {
        var obj = r[0], eff = tsSendSigs(t, r[1].data, isTest, 0);
        // файл должен быть собран ровно из подписей бланка (см. timesheetSigKey)
        if (tsStaleSigned(t, eff, obj)) { var stale = new Error('stale'); stale.tsRebuild = [t]; throw stale; }
        return obj;
      }).catch(tsArchiveStage).then(function (obj) {
        // Динамическое вложение EmailJS («Variable Attachment») ждёт в параметре
        // content URI — data:URL вида data:application/pdf;base64,... (а НЕ «сырой»
        // base64). obj.pdf уже хранится в таком виде, поэтому шлём его как есть.
        var dataUri = String(obj.pdf);
        if (dataUri.indexOf('data:') !== 0) dataUri = 'data:application/pdf;base64,' + dataUri;
        // Тему и тело письма (иврит, RTL) формируем ЗДЕСЬ, в коде, и шлём как
        // переменные. В шаблоне EmailJS остаётся только «{{{subject}}}» и
        // «{{{message_html}}}» (тройные фигурные = БЕЗ html-эскейпа, иначе «/»
        // в 06/2026 превращался в &#x2F;, а визуальный редактор тела был хрупким
        // и текст не сохранялся). Так весь текст письма — под контролем кода.
        var monthSlash = tsMonthSlash(t.month);
        var subject = (isTest ? '[ТЕСТ] ' : '') + 'יומן עבודה חתום — ' + monthSlash;
        var messageHtml =
          '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:#1f2937;">' +
            '<p>לכבוד מטב,</p>' +
            '<p>מצורף בזאת <b>יומן עבודה חתום</b> עבור המטופל <b>גריגורי רזומובסקי</b> לתקופה <b>' + monthSlash + '</b>.</p>' +
            '<p>היומן חתום כנדרש.</p>' +
            '<p>נא לאשר את קבלת המסמך. תודה רבה.</p>' +
            '<p style="margin-top:18px;">בברכה,<br>משפחת רזומובסקי</p>' +
          '</div>';
        return tsLoadEmailJS().then(function () {
          return window.emailjs.send(ej.serviceId, ej.templateId, {
            to_email: toStr, recipient: toStr, month: monthSlash,
            subject: subject, message_html: messageHtml,
            filename: 'tabel-' + t.month + '-signed.pdf', content: dataUri
          }, { publicKey: ej.publicKey });
        });
      }).then(function () {
        if (isTest) {
          // статусы НЕ трогаем: тест — не отправка в Матав
          showToast('✓ Тестовое письмо отправлено — проверьте почту');
          return;
        }
        S.updateTimesheet(id, { sentMarked: true, sentDate: today() });
        reloadData();
        render();
        showToast('✓ Отослано в Матав');
        runSync();
      }).catch(function (e) {
        if (e && e.tsRebuild) { tsOfferRebuild(e.tsRebuild); return; }
        if (e && e.tsAlert) { appAlert(e.message); return; }
        if (e && e.tsArchive) { appAlert(tsArchiveFailText(e)); return; }
        appAlert('Не удалось отправить через EmailJS: ' + (e && (e.text || e.message) || e) +
          '\n\nЗапасной путь: «Скачать подписанный PDF», отправить вручную, затем «Отметить Отослано».');
      });
    });
  }

  // вкладка «Под отчёт»: два отдельных баланса — деньги под отчёт (выдачи минус
  // принятые отчёты) и подарки (общая сумма). У каждого — раскрытие списка сумм
  // и своя кнопка выдачи. Вынесено из «Платить».
  function renderAdvance(content) {
    // --- баланс «под отчёт» ---
    var bal = advanceBalance();
    var advRecords = [];
    extras.forEach(function (e) { if (e.kind === 'advance') advRecords.push({ type: 'extra', rec: e }); });
    returns.forEach(function (r) { advRecords.push({ type: 'return', rec: r }); });
    var advButtons = [];
    if (bal > 0) {
      var rbtn = el('button', 'btn btn-return', '➖ Принять отчёт (чеки / сдача)');
      rbtn.addEventListener('click', openReturnModal);
      advButtons.push(rbtn);
    }
    collapsibleBalance(content, {
      cls: 'bc-advance',
      amount: bal,
      zeroLabel: '🧾 Под отчёт у метапеля', zeroHint: 'Сейчас под отчёт ничего не числится',
      posLabel: '🧾 На руках под отчёт', posHint: 'Выдано под отчёт минус принятые отчёты (чеки, сдача)',
      records: advRecords,
      buttons: advButtons
    });
    var giveAdv = el('button', 'btn btn-give-advance', '🧾 Выдать деньги под отчёт');
    giveAdv.addEventListener('click', function () { openExtraModal('advance'); });
    content.appendChild(giveAdv);

    // --- баланс «подарки» (общая сумма, отчёт не нужен) ---
    var giftTotal = C.round2(extras.reduce(function (s, e) {
      return e.kind === 'gift' ? s + e.amount : s;
    }, 0));
    var giftRecords = [];
    extras.forEach(function (e) { if (e.kind === 'gift') giftRecords.push({ type: 'extra', rec: e }); });
    collapsibleBalance(content, {
      cls: 'bc-gift',
      amount: giftTotal,
      zeroLabel: '🎁 Подарков выдано', zeroHint: 'Подарки метапелю пока не выдавались',
      posLabel: '🎁 Подарков выдано всего', posHint: 'Сумма всех подарков — отчёт по ним не нужен',
      records: giftRecords,
      buttons: []
    });
    var giveGift = el('button', 'btn btn-give-gift', '🎁 Дать подарок');
    giveGift.addEventListener('click', function () { openExtraModal('gift'); });
    content.appendChild(giveGift);
  }

  function renderUpcoming(occ, content) {
    var up = occ.filter(function (o) { return o.status === 'upcoming'; });
    var unpaid = occ.filter(function (o) { return o.status !== 'paid'; });
    content.appendChild(el('div', 'summary',
      'Всего заплатить в ближайшие ' + HORIZON_DAYS + ' дней: <b>' +
      C.fmtMoney(sumAmounts(unpaid)) + '</b>' + missingNote(unpaid)));
    if (!up.length) {
      content.appendChild(el('div', 'empty', 'Ближайших платежей нет.'));
      return;
    }
    up.forEach(function (o) { content.appendChild(card(o, true)); });
  }

  // бейдж способа оплаты + статус расписки и архива
  function methodBadge(rec) {
    var hasReceipt = rec.signature || rec.signatureArchived;
    var line;
    if ((rec.method || 'transfer') === 'cash') {
      line = hasReceipt
        ? '💵 Наличные · ✍ Расписка получена ✓'
        : (rec.kind === 'gift'
          ? '💵 Наличные · без расписки (для подарка не обязательна)'
          : '💵 Наличные · <span class="no-receipt">⚠ Нет расписки</span>');
    } else {
      line = '🏦 Перевод';
    }
    if (hasReceipt && window.MetapelSync.isOn(settings)) {
      line += rec.synced
        ? '<div class="sync-badge">☁ Сохранена в архиве</div>'
        : '<div class="sync-badge">⏳ Ждёт отправки в архив</div>';
    }
    return line;
  }

  // история обязательных платежей (зарплата, карманные, страховка и т.д.).
  // Подарки, выдачи под отчёт и отчёты — на отдельной вкладке «Под отчёт».
  function renderHistory(content) {
    var items = [];
    Object.keys(log).forEach(function (id) {
      var r = log[id];
      items.push({ kind: 'scheduled', id: id, rec: r, date: r.paidDate });
    });
    if (!items.length) {
      content.appendChild(el('div', 'empty', 'Оплаченных платежей пока нет.'));
      return;
    }
    items.sort(function (a, b) { return a.date < b.date ? 1 : -1; });

    var paidTotal = items.reduce(function (s, it) { return s + it.rec.paidAmount; }, 0);
    content.appendChild(el('div', 'summary',
      'Всего выплачено: <b>' + C.fmtMoney(paidTotal) + '</b> · записей: ' + items.length));

    items.forEach(function (it) { content.appendChild(historyCard(it)); });
  }

  function returnCard(r) {
    var div = el('div', 'card paid-card return-card');
    var head = el('div', 'card-head');
    var left = el('div', 'card-left');
    var title = el('div', 'card-title');
    title.appendChild(el('span', 'card-icon', '↩'));
    title.appendChild(el('span', null, 'Возврат по отчёту' + (r.note ? ': ' + esc(r.note) : '')));
    left.appendChild(title);
    left.appendChild(el('div', 'card-due', C.fmtDate(r.date)));
    head.appendChild(left);
    head.appendChild(el('div', 'card-amount return-amount', '− ' + C.fmtMoney(r.amount)));
    div.appendChild(head);
    var actions = el('div', 'card-actions');
    var btn = el('button', 'link-undo', '↩ Отменить запись (нажали по ошибке)');
    btn.addEventListener('click', function () {
      appConfirm('Удалить возврат на ' + C.fmtMoney(r.amount) + '? Сумма вернётся в баланс «под отчёт».',
        'Да, удалить', function () {
          S.deleteReturn(r.id);
          reloadData();
          render();
          showToast('✓ Запись удалена');
          runSync(); // сразу донести удаление в облако (сузить окно расхождения)
        });
    });
    actions.appendChild(btn);
    div.appendChild(actions);
    return div;
  }

  function historyCard(it) {
    var e = it.rec;
    var amount = it.kind === 'scheduled' ? e.paidAmount : e.amount;
    var div = el('div', 'card paid-card');
    var head = el('div', 'card-head');
    var left = el('div', 'card-left');
    var title = el('div', 'card-title');
    var icon = it.kind === 'extra' ? (e.kind === 'gift' ? '🎁' : '🧾')
      : (TYPE_ICONS[it.id.replace(/-.*$/, '')] || '💵');
    title.appendChild(el('span', 'card-icon', icon));
    title.appendChild(el('span', null, esc(e.title) + (e.note ? ' — ' + esc(e.note) : '')));
    left.appendChild(title);
    left.appendChild(el('div', 'card-due', it.kind === 'scheduled'
      ? 'оплачено ' + C.fmtDate(e.paidDate) + (e.dueDate ? ' · срок был ' + C.fmtDate(e.dueDate) : '')
      : 'выдано ' + C.fmtDate(e.date)));
    left.appendChild(el('div', 'method-badge', methodBadge(e)));
    head.appendChild(left);
    head.appendChild(el('div', 'card-amount', C.fmtMoney(amount)));
    div.appendChild(head);
    if (e.signature) {
      // подпись есть локально — показываем по кнопке (свёрнута по умолчанию,
      // переключатель «Показать»/«Скрыть» — как у подтянутых из архива)
      var locWrap = el('div', 'sig-view');
      var locImg = el('img', 'sig-img');
      locImg.src = e.signature;
      locImg.alt = 'Подпись метапеля';
      locImg.style.display = 'none';
      var locBtn = el('button', 'btn btn-light', '👁 Показать расписку');
      var locShown = false;
      locBtn.addEventListener('click', function () {
        locShown = !locShown;
        locImg.style.display = locShown ? '' : 'none';
        locBtn.textContent = locShown ? '🙈 Скрыть расписку' : '👁 Показать расписку';
      });
      locWrap.appendChild(locImg);
      locWrap.appendChild(locBtn);
      div.appendChild(locWrap);
    } else if (e.signatureArchived && window.MetapelSync.isOn(settings)) {
      // подпись есть в архиве, но не на этом устройстве (напр. лэптоп) —
      // подгрузим картинку из архива по запросу (в общий бэкап её не кладут)
      var viewWrap = el('div', 'sig-view');
      var btnView = el('button', 'btn btn-light', '👁 Показать расписку');
      var sigImg = null;   // кэш картинки после первой загрузки
      var shown = false;
      function setViewLabel() {
        btnView.textContent = shown ? '🙈 Скрыть расписку' : '👁 Показать расписку';
      }
      btnView.addEventListener('click', function () {
        if (sigImg) { // уже загружена — просто переключаем видимость, без повторной загрузки
          shown = !shown;
          sigImg.style.display = shown ? '' : 'none';
          setViewLabel();
          return;
        }
        btnView.disabled = true;
        btnView.textContent = '⏳ Загружаю расписку…';
        window.MetapelSync.fetchReceipt(settings, it.id).then(function (rec) {
          btnView.disabled = false;
          if (rec && rec.signature) {
            sigImg = el('img', 'sig-img');
            sigImg.src = rec.signature;
            sigImg.alt = 'Подпись метапеля';
            viewWrap.insertBefore(sigImg, btnView); // картинка над кнопкой «Скрыть»
            shown = true;
            setViewLabel();
          } else {
            setViewLabel();
            appAlert('В архиве нет картинки подписи для этой расписки.');
          }
        }).catch(function (err) {
          btnView.disabled = false;
          setViewLabel();
          appAlert('Не удалось загрузить расписку из архива: ' + (err && err.message || err));
        });
      });
      viewWrap.appendChild(btnView);
      div.appendChild(viewWrap);
    }
    var actions = el('div', 'card-actions');
    if ((e.method || 'transfer') === 'cash' && !e.signature && !e.signatureArchived) {
      var signLabel = e.kind === 'gift'
        ? '✍ Расписаться (по желанию)'
        : '✍ Метапель получил — расписаться';
      var btnSign = el('button', 'btn btn-sign', signLabel);
      btnSign.addEventListener('click', function () {
        openSignModal(it.kind === 'scheduled' ? 'log' : 'extra', it.id);
      });
      actions.appendChild(btnSign);
    }
    var btn = el('button', 'link-undo', '↩ Отменить запись (нажали по ошибке)');
    btn.addEventListener('click', function () {
      // нельзя удалить выдачу под отчёт, если по ней уже приняты возвраты:
      // баланс «под отчёт» ушёл бы в минус (возвраты не привязаны к выдаче).
      // Сначала надо отменить лишние возвраты во вкладке «Под отчёт».
      if (it.kind === 'extra' && e.kind === 'advance' && advanceBalance() - e.amount < 0) {
        appAlert('По этой выдаче уже приняты отчёты (возвраты). Сначала отмените возвраты — ' +
          'иначе баланс «под отчёт» станет отрицательным.');
        return;
      }
      var q = it.kind === 'scheduled'
        ? 'Убрать отметку об оплате «' + e.title + '»? Платёж вернётся в напоминания.'
        : 'Удалить запись «' + e.title + '» на ' + C.fmtMoney(amount) + '?';
      appConfirm(q, 'Да, отменить', function () {
        if (it.kind === 'scheduled') S.unmarkPaid(it.id);
        else S.deleteExtra(it.id);
        reloadData();
        render();
        showToast('✓ Запись отменена');
        runSync(); // сразу донести удаление в облако (сузить окно расхождения)
      });
    });
    actions.appendChild(btn);
    div.appendChild(actions);
    return div;
  }

  // ---------- диалог оплаты ----------

  function openPayModal(o) {
    // страховка на случай устаревшей карточки (фоновая синхронизация могла
    // убрать сумму от Матав): платить по непосчитанному начислению нечего
    if (payBlocked(o)) {
      appAlert('Сначала введите сумму, присланную Матав, — без неё это начисление не посчитано.');
      return;
    }
    currentPay = o;
    $('#pay-title').textContent = (TYPE_ICONS[o.type] || '💵') + ' ' + o.title;
    $('#pay-due').textContent = 'Срок: ' + C.fmtDate(o.dueDate);
    var ul = $('#pay-breakdown');
    ul.innerHTML = '';
    o.breakdown.forEach(function (line) { ul.appendChild(el('li', null, esc(line))); });

    var satsRow = $('#pay-sats-row');
    if (o.type === 'salary') {
      satsRow.style.display = '';
      $('#pay-sats').value = o.satCount;
    } else {
      satsRow.style.display = 'none';
    }
    $('#pay-amount').value = o.amount;
    $('#pay-date').value = today();
    $('#pay-details').style.display = 'none'; // детали — по явному запросу
    payMethod = settings.types[o.type].defaultMethod || 'cash';
    updateMethodButtons();
    updatePayBig();
    $('#modal-pay').classList.add('open');
    updateScrollLock();
  }

  function updateMethodButtons() {
    $('#pay-method-transfer').classList.toggle('active', payMethod === 'transfer');
    $('#pay-method-cash').classList.toggle('active', payMethod === 'cash');
    $('#pay-cash-hint').style.display = payMethod === 'cash' ? '' : 'none';
  }

  function updatePayBig() {
    var v = parseFloat($('#pay-amount').value);
    $('#pay-amount-big').textContent = C.fmtMoney(isNaN(v) ? 0 : v);
  }

  function recalcSalaryAmount() {
    if (!currentPay || currentPay.type !== 'salary') return;
    var sats = parseInt($('#pay-sats').value, 10);
    if (isNaN(sats) || sats < 0) sats = 0;
    // в месяце максимум 5 суббот: ручной ввод «55» вместо «5» не должен
    // раздуть сумму — держим поле и сумму согласованными
    if (sats > 5) { sats = 5; $('#pay-sats').value = sats; }
    $('#pay-amount').value = C.round2(currentPay.netPart + sats * currentPay.satRate);
    updatePayBig();
  }

  function stepSats(delta) {
    if (!currentPay || currentPay.type !== 'salary') return;
    var sats = parseInt($('#pay-sats').value, 10);
    if (isNaN(sats)) sats = 0;
    sats = Math.max(0, Math.min(5, sats + delta));
    $('#pay-sats').value = sats;
    recalcSalaryAmount();
  }

  function confirmPay() {
    if (!actionGuard()) return;
    if (currentPay && payBlocked(currentPay)) {
      appAlert('Сначала введите сумму, присланную Матав, — без неё это начисление не посчитано.');
      return;
    }
    var amount = parseFloat($('#pay-amount').value);
    var paidDate = $('#pay-date').value;
    if (isNaN(amount) || amount < 0) { appAlert('Укажите сумму.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) { appAlert('Укажите дату оплаты.'); return; }
    var id = currentPay.id;
    var needSign = payMethod === 'cash';
    S.markPaid(id, {
      title: currentPay.title,
      dueDate: currentPay.dueDate,
      amount: currentPay.amount,
      paidAmount: C.round2(amount),
      paidDate: paidDate,
      method: payMethod,
      signature: null,
      signedDate: null
    });
    log = S.loadLog();
    closeModals();
    render();
    showToast('✓ Записано');
    if (needSign) openSignModal('log', id); // наличные — сразу расписка
  }

  // ---------- расписка (подпись пальцем) ----------

  var signCtx = null;
  var signDrawing = false;
  var signInk = false;

  function findExtra(id) {
    for (var i = 0; i < extras.length; i++) if (extras[i].id === id) return extras[i];
    return null;
  }

  function signRecord(target) {
    return target.type === 'log' ? log[target.id] : findExtra(target.id);
  }

  // Открывает окно подписи в режиме «вернуть PNG» (для табелей). onDone(pngDataUrl).
  // Подпись с ПРОЗРАЧНЫМ фоном — чтобы накладывалась поверх бланка.
  function openFingerSign(title, descHtml, okText, hintText, onDone, color) {
    signCallback = onDone;
    signColor = color || '#1e293b';
    currentSign = null;
    $('#sign-title').textContent = title;
    $('#sign-text').innerHTML = descHtml || '';
    $('#sign-ok').textContent = okText || '✓ Готово';
    $('#sign-later').textContent = 'Позже (расписаться потом)'; // серия окон переименует после вызова
    tsSeriesCount = 0;                                            // …и сама скажет, сколько уже собрано
    var hint = $('#sign-hint'); if (hint) hint.textContent = hintText || 'Распишитесь пальцем в рамке выше и нажмите кнопку.';
    $('#modal-sign').classList.add('open');
    // окно открывается с ВЕРХА: в серии недель прокрутка от прошлого окна иначе
    // спрятала бы заголовок «неделя k из N» с датами (на небольших экранах)
    var box = document.querySelector('#modal-sign .modal-box'); if (box) box.scrollTop = 0;
    updateScrollLock();
    setupSignCanvas(true, signColor);
  }

  // Обрезает подпись до рамки чернил (+поля) — чтобы в маленькой ячейке бланка
  // подпись заполняла место и была видна, а не превращалась в точку.
  // размер росчерка на холсте (рамка непрозрачных пикселей) или null, если пусто
  function signInkBox(canvas) {
    try {
      var w = canvas.width, h = canvas.height;
      var d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      var minX = w, minY = h, maxX = -1, maxY = -1;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 16) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      return maxX < 0 ? null : { w: maxX - minX + 1, h: maxY - minY + 1 };
    } catch (e) { return null; }
  }

  function trimSignature(canvas) {
    try {
      var w = canvas.width, h = canvas.height;
      var d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      var minX = w, minY = h, maxX = -1, maxY = -1;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 16) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return canvas.toDataURL('image/png');
      var pad = 8;
      minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
      maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
      var cw = maxX - minX + 1, ch = maxY - minY + 1;
      // В бланке подпись встаёт в клетку ~46×11 pt (день) / 46×18 pt (неделя) — хранить
      // холст в полном разрешении незачем: уменьшаем до ≤200×60 px (та же живая
      // роспись, только мельче; в клетке это ~170–390 dpi). Иначе десятки подписей в
      // месяц (Claims: по дням и неделям) быстро раздули бы бэкап и хранилище браузера.
      var k = Math.min(1, 200 / cw, 60 / ch);
      var ow = Math.max(1, Math.round(cw * k)), oh = Math.max(1, Math.round(ch * k));
      var out = document.createElement('canvas'); out.width = ow; out.height = oh;
      var g = out.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.drawImage(canvas, minX, minY, cw, ch, 0, 0, ow, oh);
      return out.toDataURL('image/png');
    } catch (e) { return canvas.toDataURL('image/png'); }
  }

  function openSignModal(targetType, id) {
    var target = { type: targetType, id: id };
    var r = signRecord(target);
    if (!r) return;
    signCallback = null;
    signColor = null;
    currentSign = target;
    // вернуть «расписочные» подписи модалки (табели могли их поменять)
    $('#sign-title').textContent = '✍ Расписка о получении';
    $('#sign-ok').textContent = '✓ ОК — деньги получил';
    $('#sign-later').textContent = 'Позже (расписаться потом)';
    var h = $('#sign-hint'); if (h) h.textContent = 'Метапель: распишитесь пальцем в рамке выше и нажмите ОК.';
    var what = 'наличными'; // обычный платёж
    if (r.kind === 'gift') what = 'в подарок';
    if (r.kind === 'advance') what = 'под отчёт';
    $('#sign-text').innerHTML = 'Я, <b>' + esc(settings.workerFullName || settings.workerName) +
      '</b>, получил ' + what + ' <b>' + C.fmtMoney(r.paidAmount != null ? r.paidAmount : r.amount) +
      '</b><br>' + esc(r.title) + (r.note ? ' (' + esc(r.note) + ')' : '') +
      ' · от: ' + esc(settings.employerFullName || settings.employerName) +
      ' · дата: ' + C.fmtDate(r.paidDate || r.date);
    $('#modal-sign').classList.add('open');
    updateScrollLock();
    setupSignCanvas();
  }

  function setupSignCanvas(transparent, color) {
    var canvas = $('#sign-canvas');
    // внутреннее разрешение по фактическому размеру на экране
    var rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(300, Math.round(rect.width));
    canvas.height = 300; // задание width/height очищает холст в прозрачный
    signCtx = canvas.getContext('2d');
    if (!transparent) {
      // расписки — на белом фоне; табели — прозрачный (накладываем на бланк)
      signCtx.fillStyle = '#ffffff';
      signCtx.fillRect(0, 0, canvas.width, canvas.height);
    }
    signCtx.strokeStyle = color || '#1e293b';
    signCtx.lineWidth = transparent ? 7 : 4.5; // табели — толще для контраста
    signCtx.lineCap = 'round';
    signCtx.lineJoin = 'round';
    signInk = false;
    signDrawing = false;
  }

  function signPos(e) {
    var canvas = $('#sign-canvas');
    var rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * canvas.width / rect.width,
      y: (e.clientY - rect.top) * canvas.height / rect.height
    };
  }

  function confirmSign() {
    if (!actionGuard()) return;
    if (!signInk) { appAlert('Сначала распишитесь пальцем в рамке.'); return; }
    // режим табелей: вернуть PNG в колбэк, обычную «расписочную» логику пропускаем
    if (signCallback) {
      // случайное касание (точка) — не подпись: в бланке оно стало бы «подписью» недели
      var ink = signInkBox($('#sign-canvas'));
      if (ink && Math.max(ink.w, ink.h) < 40) {
        appAlert('Подпись получилась слишком маленькой — похоже на случайное касание. ' +
          'Нажмите «Стереть и расписаться заново» и распишитесь полностью.');
        return;
      }
      var data = trimSignature($('#sign-canvas'));
      var cb = signCallback; signCallback = null;
      closeModals();
      cb(data);
      return;
    }
    if (!currentSign) { closeModals(); return; }
    var target = currentSign;
    var r = signRecord(target);
    if (!r) { closeModals(); return; }
    r.signature = $('#sign-canvas').toDataURL('image/png');
    r.signedDate = today();
    if (target.type === 'log') S.markPaid(target.id, r);
    else S.updateExtra(target.id, r);
    reloadData();
    closeModals();
    render();
    showToast('✓ Расписка записана');
    runSync();
  }

  // Ставит в очередь все подписанные, но ещё не отправленные расписки
  // (в т.ч. подписанные до включения архива), отправляет очередь и
  // обновляет резервную копию данных. Параллельные запуски запрещены —
  // иначе дубль-отправки и гонка sha на GitHub.
  var syncInFlight = false;
  // Запрос, пришедший во время активного прогона, НЕ выбрасываем, а повторяем
  // после завершения: раньше «дослать метаданные» после загрузки табеля молча
  // терялся, пока шла стартовая синхронизация, — карточки оставались только в
  // localStorage (инциденты 27.08 и 15.09.2026: PDF в архиве, в облаке пусто).
  var syncAgain = false;
  var syncTail = Promise.resolve(); // промис последнего запрошенного прогона

  function runSync() {
    if (syncInFlight) { syncAgain = true; return syncTail; }
    if (!window.MetapelSync.isOn(settings)) return Promise.resolve();
    syncInFlight = true;
    var errBefore = S.getMeta('lastSyncError') || null;
    // Пролог — внутри промиса: синхронный throw (например, недопустимый символ в
    // токене → fetch бросает TypeError сразу, не как rejected promise) иначе
    // пролетел бы мимо catch и НАВСЕГДА оставил syncInFlight=true — sync молчал
    // бы до перезагрузки страницы (находка ревью v6.5).
    var pullStep = Promise.resolve().then(function () {
      // 1) Автоподтягивание свежей облачной копии — только если включено для среды
      //    (env.js: autoSync=true и на проде, и на stage).
      return (window.MetapelEnv && window.MetapelEnv.autoSync)
        ? window.MetapelSync.pullIfNewer(settings, S, C.hashString)
        : null;
    });
    syncTail = pullStep.then(function (pulled) {
      if (pulled) {
        settings = S.loadSettings(); // подтянулась и общая «сумма от Матав»
        reloadData();
        backgroundRender();
        showToast('✓ Данные обновлены с другого устройства');
      }
      // 2) (пере)поставить в очередь подписанные, но не отправленные расписки —
      //    по актуальным данным (после возможного подтягивания).
      Object.keys(log).forEach(function (id) {
        var r = log[id];
        if (r.signature && !r.synced) {
          window.MetapelSync.enqueue(S, 'log', id, id.replace(/-.*$/, ''), r, settings);
        }
      });
      extras.forEach(function (e) {
        if (e.signature && !e.synced) {
          window.MetapelSync.enqueue(S, 'extra', e.id, e.kind, e, settings);
        }
      });
      // 3) дослать расписки и 4) залить локальные изменения (если есть и не устарели)
      // Суммы от Матав принимаются ВНУТРИ backupIfChanged, ДО заливки: если сама
      // заливка потом упадёт (CAS 409, обрыв сети), в хранилище уже новые суммы, а
      // на экране остались бы карточки по старым — и заплатить можно по устаревшей
      // цифре (диалог оплаты берёт сумму из отрисованного начисления).
      var blBefore = JSON.stringify(settings.bl || null);
      return window.MetapelSync.processQueue(settings, S, null).then(function (sent) {
        return window.MetapelSync.backupIfChanged(settings, S, C.hashString).then(function (backedUp) {
          syncInFlight = false;
          settings = S.loadSettings(); // backupIfChanged мог принять облачную «сумму от Матав»
          if (sent > 0 || backedUp || JSON.stringify(settings.bl || null) !== blBefore) {
            reloadData();
            backgroundRender();
          } else if ((S.getMeta('lastSyncError') || null) !== errBefore) {
            // ошибка появилась/ушла БЕЗ успешной заливки — баннер «данные не
            // уходят в облако» должен обновиться СРАЗУ, а не при следующем
            // действии пользователя или полуночной перерисовке (ревью v6.5)
            backgroundRender();
          }
        });
      });
    }).catch(function () {
      syncInFlight = false;
      if ((S.getMeta('lastSyncError') || null) !== errBefore) backgroundRender();
    }).then(syncAfterRun, syncAfterRun);
    return syncTail;
  }

  // Накопившийся за время прогона повтор (см. syncAgain); промис runSync
  // резолвится только ПОСЛЕ повтора — ожидающие получают состояние, в котором
  // их данные действительно попали в прогон. Вторым аргументом .then — чтобы
  // даже сбой в отрисовке внутри catch-ветки не проглотил повтор и не подвесил
  // ожидающих реджектом (у загрузчика табеля нет своего catch на этот промис).
  function syncAfterRun() {
    if (syncAgain) { syncAgain = false; return runSync(); }
    return tsMaybeArchive(); // перенос подписей в архив — тоже «прогон» (см. ниже)
  }

  // ПЕРЕНОС подписей табелей из записей в файлы архива (записи до v6.13 и то, что
  // дописала старая версия приложения): картинки → timesheets/<id>-sigs.json,
  // в записи — метки и счётчики. Только на «чистом» устройстве — когда всё
  // локальное уже в облаке (хэш = залитому/подтянутому, ошибок нет): тогда любая
  // убираемая из записи картинка уже лежит и в истории облачного бэкапа, и в файле.
  // Не во время подписания, не под открытым окном и не в настройках. Переносятся
  // только ПОЛНОСТЬЮ подписанные бланки: месяц, который старая версия приложения
  // (машина в доме Григория, если её не обновили) начала подписывать, она должна
  // суметь дописать — по картинкам первой подписи в самой записи (метки ей не
  // годятся). Месяц, начатый НОВОЙ версией, старая дописать не сможет (её сборка
  // упадёт на метке — без потерь, но после серии подписей): устройства обновить до
  // подписания. Перед записью файлов — свежая сверка generation облака: если облако
  // ушло вперёд, здешние записи могли устареть, и сводить их с файлами рано.
  // Облегчённые записи фиксируются сначала в облаке, потом локально
  // (commitArchivedSigs) — кто-то записал облако за это время — ничего не меняется.
  // Весь перенос идёт «под замком» синхронизации (syncInFlight): параллельный
  // runSync подождёт (syncAgain) и повторится после; замок снимается при любом
  // исходе. Запись, которую перенести нельзя в принципе («подписи числятся в
  // архиве, а их нет», битый файл — пусть увидит Лев), до следующего запуска не
  // трогаем; сбой сети и ничего не перенеслось — пауза 15 минут.
  var tsArchRetryAt = 0, tsArchSkip = {};
  function tsArchIdle() {
    return !document.querySelector('.modal.open') && !tsBusy() && activeTab !== 'settings';
  }
  function tsMaybeArchive() {
    if (syncInFlight || Date.now() < tsArchRetryAt) return;
    if (!window.MetapelSync.isOn(settings) || !tsModulesFresh() ||
        typeof window.MetapelSync.commitArchivedSigs !== 'function') return;
    if (!tsArchIdle() || S.getMeta('lastSyncError')) return;
    var todo = S.loadTimesheets().filter(function (t) {
      return C.timesheetHasRecordSigs(t) && tsCareDone(t) && tsFamDone(t) && !tsArchSkip[t.id];
    });
    if (!todo.length) return;
    if (C.hashString(window.MetapelSync.buildBackupJson(settings, S, 0)) !== S.getMeta('lastBackupHash')) return;
    syncInFlight = true;
    var gen = S.getMeta('backupGeneration'), ready = [], netFailed = 0;
    var job = Promise.resolve().then(function () {
      return window.MetapelSync.fetchBackup(settings);
    }).then(function (cloud) {
      if (!cloud || cloud.generation !== gen) return 0; // облако ушло вперёд — сначала подтянуть
      var chain = Promise.resolve();
      todo.forEach(function (t) {
        chain = chain.then(function () {
          return window.MetapelSync.archiveTimesheetSigs(settings, t).then(function (r) {
            if (r) ready.push(r);
          }, function (e) {
            if (e && e.permanent) tsArchSkip[t.id] = true; else netFailed++;
          });
        });
      });
      return chain.then(function () {
        if (netFailed && !ready.length) tsArchRetryAt = Date.now() + 15 * 60 * 1000;
        if (!ready.length || !tsArchIdle()) return 0;
        return window.MetapelSync.commitArchivedSigs(settings, S, ready, C.hashString);
      });
    }).then(function (n) {
      if (n) { reloadData(); backgroundRender(); }
    });
    function release() {
      syncInFlight = false;
      if (syncAgain) { syncAgain = false; return runSync(); }
    }
    return job.then(release, release);
  }

  // ---------- дополнительные платежи (подарок / под отчёт) ----------

  function openExtraModal(kind) {
    extraKind = kind || 'advance'; // тип задаёт кнопка, открывшая окно
    extraMethod = 'cash'; // доп. платежи по умолчанию наличными
    $('#extra-amount').value = '';
    $('#extra-date').value = today();
    $('#extra-note').value = '';
    $('#extra-title').textContent = extraKind === 'gift'
      ? '🎁 Дать подарок' : '🧾 Выдать деньги под отчёт';
    updateExtraButtons();
    $('#modal-extra').classList.add('open');
    updateScrollLock();
  }

  function updateExtraButtons() {
    $('#extra-kind-gift').classList.toggle('active', extraKind === 'gift');
    $('#extra-kind-advance').classList.toggle('active', extraKind === 'advance');
    $('#extra-method-transfer').classList.toggle('active', extraMethod === 'transfer');
    $('#extra-method-cash').classList.toggle('active', extraMethod === 'cash');
    $('#extra-kind-hint').textContent = extraKind === 'gift'
      ? 'Подарок: отчёт не нужен, расписка по желанию (кнопка будет в «Под отчёт»).'
      : 'Под отчёт: метапель отчитывается чеками или сдачей, сумма попадает в баланс.';
  }

  function confirmExtra() {
    if (!actionGuard()) return;
    var amount = parseFloat($('#extra-amount').value);
    var date = $('#extra-date').value;
    if (isNaN(amount) || amount <= 0) { appAlert('Укажите сумму.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { appAlert('Укажите дату.'); return; }
    var rec = {
      id: 'extra-' + Date.now(),
      kind: extraKind,
      title: extraKind === 'gift' ? 'Подарок' : 'Деньги под отчёт',
      amount: C.round2(amount),
      date: date,
      note: $('#extra-note').value.trim(),
      method: extraMethod,
      signature: null,
      signedDate: null
    };
    S.addExtra(rec);
    reloadData();
    closeModals();
    render();
    showToast('✓ Записано');
    // под отчёт наличными — сразу расписка; подарок — по желанию
    if (extraMethod === 'cash' && rec.kind === 'advance') openSignModal('extra', rec.id);
  }

  // ---------- калькулятор окончания работы ----------

  var finalReason = 'employer';

  function openFinalModal() {
    finalReason = 'employer';
    $('#final-date').value = today();
    $('#final-vacation-used').value = '0';
    $('#final-result').innerHTML = '';
    updateFinalButtons();
    $('#modal-final').classList.add('open');
    updateScrollLock();
  }

  function updateFinalButtons() {
    $('#final-reason-employer').classList.toggle('active', finalReason === 'employer');
    $('#final-reason-worker').classList.toggle('active', finalReason === 'worker');
  }

  function runFinalCalc() {
    var endDate = $('#final-date').value;
    var used = parseInt($('#final-vacation-used').value, 10) || 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) { appAlert('Укажите последний день работы.'); return; }
    var res = C.calcFinalSettlement(settings, endDate, finalReason, used);
    var box = $('#final-result');
    box.innerHTML = '';
    if (res.breakdown.length) {
      var ul = el('ul', 'breakdown-body open');
      res.breakdown.forEach(function (l) {
        ul.appendChild(el('li', null, esc(l.text) + ' — <b>' + C.fmtMoney(l.amount) + '</b>'));
      });
      box.appendChild(ul);
      box.appendChild(el('div', 'pay-amount-big', 'Итого: ' + C.fmtMoney(res.total)));
    }
    res.warnings.forEach(function (w) {
      box.appendChild(el('div', 'hint', '⚠ ' + esc(w)));
    });
  }

  function openReturnModal() {
    $('#return-amount').value = '';
    $('#return-date').value = today();
    $('#return-note').value = '';
    $('#modal-return').classList.add('open');
    updateScrollLock();
  }

  function confirmReturn() {
    if (!actionGuard()) return;
    var amount = parseFloat($('#return-amount').value);
    var date = $('#return-date').value;
    if (isNaN(amount) || amount <= 0) { appAlert('Укажите сумму.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { appAlert('Укажите дату.'); return; }
    var bal = advanceBalance();
    if (amount > bal) {
      appAlert('Сейчас под отчёт числится ' + C.fmtMoney(bal) +
        ' — нельзя принять возврат на большую сумму.');
      return;
    }
    S.addReturn({
      id: 'return-' + Date.now(),
      amount: C.round2(amount),
      date: date,
      note: $('#return-note').value.trim()
    });
    reloadData();
    closeModals();
    render();
    showToast('✓ Отчёт принят');
  }

  // ---------- настройки ----------

  var WEEKDAY_OPTIONS = C.WEEKDAYS.map(function (w, i) { return [i, w]; });
  var METHOD_OPTIONS = [['transfer', 'перевод'], ['cash', 'наличные']];

  function methodField(typeKey) {
    return { path: 'types.' + typeKey + '.defaultMethod', label: 'Способ оплаты по умолчанию',
      type: 'select', options: METHOD_OPTIONS };
  }

  function syncStatusLine() {
    if (!window.MetapelSync.isOn(settings)) return '⚪ Состояние: архив выключен.';
    var q = S.loadSyncQueue().length;
    var err = S.getMeta('lastSyncError');
    if (err) return '🔴 Состояние: ошибка отправки — ' + err + (q ? ' (в очереди: ' + q + ')' : '');
    if (q) return '🟡 Состояние: в очереди ' + q + ', отправится при следующем подключении.';
    return '🟢 Состояние: всё отправлено.';
  }

  // Список сумм от Матав по месяцам в настройках: правка существующих и
  // добавление месяца. ВАЖНО: полям этого списка НЕ ставим dataset.path —
  // иначе их подхватит общий сборщик формы (saveSettingsForm) и попытается
  // записать значение по несуществующему пути настроек.
  function renderMatavMonths(fs) {
    var bl = settings.bl || {};
    var by = (bl.matavByMonth && typeof bl.matavByMonth === 'object') ? bl.matavByMonth : {};
    var keys = Object.keys(by).filter(function (k) { return YM_RE.test(k); }).sort().reverse();
    if (!keys.length) {
      fs.appendChild(el('div', 'hint', 'Помесячных сумм пока нет' +
        (bl.matavAmount > 0
          ? ' — пока считается по старой единой сумме ' + C.fmtMoney(bl.matavAmount) +
            ' в месяц. Как только введёте первый месяц, считаться будут только помесячные суммы.'
          : '.')));
    }
    keys.forEach(function (k) {
      var row = el('div', 'form-row');
      row.appendChild(el('label', null,
        esc(ymLabel(k)) + ': <b>' + C.fmtMoney(by[k]) + '</b>'));
      var btn = el('button', 'btn btn-light', '✎ Изменить');
      btn.type = 'button';
      btn.addEventListener('click', function () { openMatavModal(k); });
      row.appendChild(btn);
      fs.appendChild(row);
    });
    var addRow = el('div', 'form-row');
    var lbl = el('label', null, 'Добавить месяц');
    lbl.htmlFor = 'matav-add-month';
    addRow.appendChild(lbl);
    // <input type="month"> даёт готовый формат 'YYYY-MM' — руками ключ не собираем
    var inp = el('input');
    inp.type = 'month';
    inp.id = 'matav-add-month';
    addRow.appendChild(inp);
    var add = el('button', 'btn btn-light', '➕ Ввести сумму');
    add.type = 'button';
    add.addEventListener('click', function () {
      if (!YM_RE.test(inp.value)) { appAlert('Выберите месяц (год и месяц).'); return; }
      openMatavModal(inp.value);
    });
    addRow.appendChild(add);
    fs.appendChild(addRow);
  }

  function settingsForm() {
    return [
      { section: 'Общие', fields: [
        { path: 'workerName', label: 'Имя работника', type: 'text' },
        { path: 'workerFullName', label: 'ФИО работника (для расписок)', type: 'text' },
        { path: 'employerName', label: 'Имя работодателя', type: 'text' },
        { path: 'employerFullName', label: 'ФИО работодателя (для расписок)', type: 'text' },
        { path: 'startDate', label: 'Дата начала работы', type: 'date' },
        { path: 'uiScale', label: 'Размер текста', type: 'select',
          options: [[100, 'обычный'], [115, 'крупный'], [125, 'очень крупный']] },
        { path: 'passwordTtlMinutes', label: 'Помнить пароль настроек, минут', type: 'number' }
      ] },
      { section: '🤝 Гмлат сиуд: сколько платит Матав', enable: 'bl.approved',
        // список сумм по месяцам рисуется своим кодом (renderMatavMonths):
        // одним полем формы его не выразить, а старое единое поле bl.matavAmount
        // убрано из интерфейса — оно осталось только в данных, для совместимости
        custom: renderMatavMonths,
        hint: 'Матав платит работнику часть зарплаты (за счёт пособия по уходу от ' +
          'Битуах Леуми), остальное доплачиваете вы. Сумма приходит 9-го числа и ' +
          'каждый месяц РАЗНАЯ, поэтому вводится за конкретный месяц: на главном ' +
          'экране кнопкой у карточки зарплаты или в списке выше. Галочка слева — ' +
          'учитывать эти суммы. Суммы месяцев сохраняются сразу, отдельной кнопкой ' +
          'окна; если вы правили другие поля — сначала нажмите «Сохранить настройки».',
        fields: [
        { path: 'bl.applyToSocial', label: 'Уменьшать также взносы, пикадон и хавраа', type: 'checkbox' }
      ] },
      { section: '🧮 Окончание работы (для калькулятора)',
        hint: 'Параметры финального расчёта из раздела 6 памятки. Сам калькулятор — кнопка 🧮 вверху экрана.',
        fields: [
        { path: 'final.severanceFullPercent', label: 'Полное выходное пособие, % в месяц', type: 'number' },
        { path: 'final.vacationDaysPerYear', label: 'Дней отпуска в год', type: 'number' },
        { path: 'final.vacationDayRate', label: 'Компенсация за день отпуска, ₪', type: 'number' }
      ] },
      { section: '☁ Архив расписок на GitHub', enable: 'sync.enabled',
        hint: 'Подписанные расписки сохраняются файлами в приватный репозиторий GitHub. ' +
          'Токен: github.com → Settings → Developer settings → Fine-grained tokens; ' +
          'доступ только к репозиторию данных, право Contents: Read and write. ' +
          'Токен хранится только на этом устройстве. ' + syncStatusLine(),
        fields: [
        { path: 'sync.repo', label: 'Репозиторий (владелец/имя)', type: 'text' },
        { path: 'sync.token', label: 'Токен доступа', type: 'password' }
      ] },
      { section: '📧 Отправка табелей в Матав (EmailJS)', stageOnly: true,
        hint: 'Авто-отправка подписанного табеля письмом. Нужен платный план EmailJS ' +
          'с вложениями. Ключи берутся в кабинете emailjs.com и хранятся только на ' +
          'этом устройстве. В шаблоне письма настройте динамическое вложение из ' +
          'переменных {{content}} (base64) и {{filename}}; получателя — {{recipient}}. ' +
          'Получателей можно указать НЕСКОЛЬКО — через запятую или точку с запятой. ' +
          'Если не заполнено — табель можно скачать и отправить вручную.',
        fields: [
        { path: 'emailjs.serviceId', label: 'Service ID', type: 'text' },
        { path: 'emailjs.templateId', label: 'Template ID', type: 'text' },
        { path: 'emailjs.publicKey', label: 'Public Key', type: 'text' },
        { path: 'emailjs.recipient', label: 'E-mail Матав (получатель, можно несколько)', type: 'text',
          placeholder: 'mail1@matav.co.il, mail2@matav.co.il' },
        { path: 'emailjs.testRecipient', label: 'Тестовый получатель («Тестовая отправка» шлёт только сюда)', type: 'text',
          placeholder: 'свой@адрес' }
      ] },
      { section: 'Зарплата', enable: 'types.salary.enabled', fields: [
        { path: 'types.salary.net', label: 'Нетто в месяц, ₪', type: 'number' },
        { path: 'types.salary.shabbatRate', label: 'За субботу (шабат), ₪', type: 'number' },
        { path: 'types.salary.dayOfMonth', label: 'День выплаты (числа следующего месяца)', type: 'number' },
        { path: 'types.salary.noticeDays', label: 'Первое напоминание за, дней', type: 'number' },
        methodField('salary')
      ] },
      { section: 'Карманные (дмей кис)', enable: 'types.pocket.enabled', fields: [
        { path: 'types.pocket.amount', label: 'Сумма в неделю, ₪', type: 'number' },
        { path: 'types.pocket.weekday', label: 'День недели', type: 'select', options: WEEKDAY_OPTIONS },
        { path: 'types.pocket.noticeDays', label: 'Первое напоминание за, дней', type: 'number' },
        methodField('pocket')
      ] },
      { section: 'Мед. страховка', enable: 'types.insurance.enabled', fields: [
        { path: 'types.insurance.frequency', label: 'Частота оплаты', type: 'select',
          options: [['annual', 'раз в год'], ['monthly', 'ежемесячно']] },
        { path: 'types.insurance.amountAnnual', label: 'Сумма в год, ₪ (для годовой)', type: 'number' },
        { path: 'types.insurance.renewalDate', label: 'Дата продления (для годовой)', type: 'date' },
        { path: 'types.insurance.amount', label: 'Сумма в месяц, ₪ (для помесячной)', type: 'number' },
        { path: 'types.insurance.dayOfMonth', label: 'День оплаты (для помесячной)', type: 'number' },
        { path: 'types.insurance.noticeDays', label: 'Первое напоминание за, дней', type: 'number' },
        methodField('insurance')
      ] },
      { section: 'Битуах Леуми', enable: 'types.bituach.enabled', fields: [
        { path: 'types.bituach.ratePercent', label: 'Ставка, % от брутто', type: 'number' },
        { path: 'types.bituach.grossBase', label: 'Брутто-база, ₪', type: 'number' },
        { path: 'types.bituach.frequency', label: 'Частота оплаты', type: 'select',
          options: [['monthly', 'ежемесячно'], ['quarterly', 'раз в квартал']] },
        { path: 'types.bituach.dayOfMonth', label: 'День оплаты при ежемесячной (числа след. месяца)', type: 'number' },
        { path: 'types.bituach.quarterDay', label: 'День оплаты при квартальной (числа месяца после квартала)', type: 'number' },
        { path: 'types.bituach.noticeDays', label: 'Первое напоминание за, дней', type: 'number' },
        methodField('bituach')
      ] },
      { section: 'Пикадон (пенсия + компенсация)', enable: 'types.pikadon.enabled', fields: [
        { path: 'types.pikadon.pensionPercent', label: 'Пенсия, %', type: 'number' },
        { path: 'types.pikadon.severancePercent', label: 'Компенсация, %', type: 'number' },
        { path: 'types.pikadon.grossBase', label: 'Брутто-база, ₪', type: 'number' },
        { path: 'types.pikadon.fromMonth', label: 'Платится начиная с месяца работы №', type: 'number' },
        { path: 'types.pikadon.dayOfMonth', label: 'День оплаты (числа след. месяца)', type: 'number' },
        { path: 'types.pikadon.noticeDays', label: 'Первое напоминание за, дней', type: 'number' },
        methodField('pikadon')
      ] },
      { section: 'Дмей хавраа (оздоровительные)', enable: 'types.havraa.enabled', fields: [
        { path: 'types.havraa.dayRate', label: 'Ставка за день, ₪', type: 'number' },
        { path: 'types.havraa.tiers.0.days', label: 'Дней за 1-й год', type: 'number' },
        { path: 'types.havraa.tiers.1.days', label: 'Дней за 2–3-й годы', type: 'number' },
        { path: 'types.havraa.tiers.2.days', label: 'Дней за 4–10-й годы', type: 'number' },
        { path: 'types.havraa.noticeDays', label: 'Первое напоминание за, дней', type: 'number' },
        methodField('havraa')
      ] },
      { section: 'Продление визы', enable: 'types.visa.enabled', fields: [
        { path: 'types.visa.amount', label: 'Сумма, ₪ (раз в год)', type: 'number' },
        { path: 'types.visa.noticeDays', label: 'Первое напоминание за, дней', type: 'number' },
        methodField('visa')
      ] },
      { section: 'Корпорация (тагид)', enable: 'types.tagid.enabled', fields: [
        { path: 'types.tagid.amount', label: 'Сумма, ₪ (раз в год)', type: 'number' },
        { path: 'types.tagid.noticeDays', label: 'Первое напоминание за, дней', type: 'number' },
        methodField('tagid')
      ] },
      { section: 'Продление разрешения', enable: 'types.permit.enabled', fields: [
        { path: 'types.permit.amount', label: 'Сумма, ₪', type: 'number' },
        { path: 'types.permit.intervalYears', label: 'Раз во сколько лет', type: 'number' },
        { path: 'types.permit.noticeDays', label: 'Первое напоминание за, дней', type: 'number' },
        methodField('permit')
      ] }
    ];
  }

  function renderSettings(content) {
    if (!settingsUnlockedNow()) {
      content.appendChild(el('div', 'empty', 'Настройки защищены паролем.'));
      openPasswordModal();
      return;
    }
    // настоящий <form> (а не div), чтобы поля пароля/токена были внутри формы
    // (требование Chrome). submit гасим — сохранение идёт по кнопкам (type=button).
    var form = el('form', 'settings-form');
    form.setAttribute('autocomplete', 'off');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    settingsForm().forEach(function (sec) {
      if (sec.stageOnly && TS_STAGE_ONLY) return; // раздел только для среды с «Табелями»
      var fs = el('fieldset');
      var legend = el('legend');
      if (sec.enable) {
        var cb = el('input');
        cb.type = 'checkbox';
        cb.checked = !!getPath(settings, sec.enable);
        cb.dataset.path = sec.enable;
        cb.dataset.kind = 'checkbox';
        var lbl = el('label', 'legend-label');
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' ' + sec.section));
        legend.appendChild(lbl);
      } else {
        legend.textContent = sec.section;
      }
      fs.appendChild(legend);
      sec.fields.forEach(function (f) {
        var row = el('div', 'form-row');
        var fieldId = 'set-' + f.path.replace(/\./g, '-');
        var lbl = el('label', null, esc(f.label));
        lbl.htmlFor = fieldId;
        row.appendChild(lbl);
        var input;
        if (f.type === 'select') {
          input = el('select');
          f.options.forEach(function (opt) {
            var o = el('option', null, esc(opt[1]));
            o.value = opt[0];
            input.appendChild(o);
          });
          input.value = getPath(settings, f.path);
          if (input.selectedIndex === -1) {
            // сохранённое значение из старой версии не входит в список —
            // берём ближайшую опцию, иначе select «пустой» и при сохранении
            // значение молча обнулилось бы
            var cur = parseFloat(getPath(settings, f.path));
            var best = 0, bestD = Infinity;
            f.options.forEach(function (opt, i) {
              var d = Math.abs(parseFloat(opt[0]) - cur);
              if (!isNaN(d) && d < bestD) { bestD = d; best = i; }
            });
            input.selectedIndex = best;
          }
        } else if (f.type === 'checkbox') {
          input = el('input');
          input.type = 'checkbox';
          input.checked = !!getPath(settings, f.path);
        } else {
          input = el('input');
          input.type = f.type;
          if (f.type === 'number') input.step = 'any';
          if (f.max != null) input.max = f.max;
          if (f.min != null) input.min = f.min;
          if (f.placeholder) input.placeholder = f.placeholder;
          input.value = getPath(settings, f.path);
        }
        input.id = fieldId;
        input.dataset.path = f.path;
        input.dataset.kind = f.type;
        if (f.max != null) input.dataset.max = f.max;
        if (f.min != null) input.dataset.min = f.min;
        row.appendChild(input);
        fs.appendChild(row);
      });
      if (sec.custom) sec.custom(fs); // раздел со своей разметкой (список месяцев Матав)
      if (sec.hint) fs.appendChild(el('div', 'hint', esc(sec.hint)));
      form.appendChild(fs);
    });

    // смена пароля
    var fsP = el('fieldset');
    fsP.appendChild(el('legend', null, 'Пароль настроек'));
    var rowP1 = el('div', 'form-row');
    var lblP1 = el('label', null, 'Новый пароль (пусто — не менять)');
    lblP1.htmlFor = 'set-pass1';
    rowP1.appendChild(lblP1);
    var p1 = el('input'); p1.type = 'password'; p1.id = 'set-pass1';
    rowP1.appendChild(p1);
    fsP.appendChild(rowP1);
    var rowP2 = el('div', 'form-row');
    var lblP2 = el('label', null, 'Повторите новый пароль');
    lblP2.htmlFor = 'set-pass2';
    rowP2.appendChild(lblP2);
    var p2 = el('input'); p2.type = 'password'; p2.id = 'set-pass2';
    rowP2.appendChild(p2);
    fsP.appendChild(rowP2);
    fsP.appendChild(el('div', 'hint',
      'Пароль — защита от случайного входа, данные хранятся локально в этом браузере.'));
    form.appendChild(fsP);

    var actions = el('div', 'settings-actions');
    var btnSave = el('button', 'btn btn-pay', 'Сохранить настройки');
    btnSave.type = 'button';
    btnSave.addEventListener('click', function () { saveSettingsForm(form); });
    var btnReset = el('button', 'btn btn-undo', 'Сбросить к значениям по умолчанию');
    btnReset.type = 'button';
    btnReset.addEventListener('click', function () {
      appConfirm('Вернуть все настройки к значениям по умолчанию? История оплат сохранится.',
        'Да, сбросить', function () {
          S.resetSettings();
          settings = S.loadSettings();
          render();
          showToast('✓ Настройки сброшены');
        });
    });
    actions.appendChild(btnSave);
    actions.appendChild(btnReset);
    if (window.MetapelSync.isOn(settings)) {
      var btnRestore = el('button', 'btn btn-light', '⟳ Восстановить данные из архива GitHub');
      btnRestore.type = 'button';
      btnRestore.addEventListener('click', function () {
        appConfirm('Заменить данные на этом устройстве резервной копией из архива GitHub? ' +
          'Текущие записи будут перезаписаны.', 'Да, восстановить', function () {
          window.MetapelSync.fetchBackup(settings).then(function (data) {
            // Настройки берём облачные, но device-local поля (токен синхронизации,
            // размер текста) остаются свои, а помесячные суммы от Матав —
            // ОБЪЕДИНЯЮТСЯ: их вводят на разных устройствах, и месяц, введённый
            // здесь и ещё не уехавший в облако, потерять нельзя — иначе вместо него
            // снова заработала бы легаси-цифра, одна на все месяцы (ровно тот дефект,
            // ради которого суммы стали помесячными). Та же функция применяется при
            // обычном подтягивании, чтобы обе дороги давали одинаковый результат.
            data.settings = window.MetapelSync.mergeSettingsFromCloud(settings, data.settings || {})
              || settings;
            S.saveSettings(data.settings);
            // ВАЖНО: восстанавливаем И табели — иначе устройство после «Восстановить»
            // остаётся без них (они есть в бэкапе), и автоподтягивание потом считает
            // состав расходящимся (cloud-табель отсутствует локально → conflict).
            S.replaceData({
              log: data.log || {},
              extras: data.extras || [],
              returns: data.returns || [],
              timesheets: data.timesheets || []
            });
            // «усыновляем» версию облака: устройство теперь актуально и может
            // дописывать бэкап, не считаясь устаревшим; чужую историю не затрёт
            S.setMeta('backupGeneration', (typeof data.generation === 'number') ? data.generation : 0);
            settings = S.loadSettings();
            // lastBackupHash = хэш ВОССТАНОВЛЕННОГО состояния (а НЕ null). Раньше тут
            // стоял null — и устройство навсегда уходило в conflict: decideSync требует
            // lastHash && localHash===lastHash для авто-pull, а с null авто-pull НИКОГДА
            // не срабатывал (новые облачные данные, напр. табель, не приезжали). Теперь
            // localHash совпадёт с lastHash → последующие авто-подтягивания работают.
            S.setMeta('lastBackupHash', C.hashString(window.MetapelSync.buildBackupJson(settings, S, 0)));
            S.setMeta('lastSyncError', null); // снять «облачная копия новее» после успешного восстановления
            reloadData();
            render();
            showToast('✓ Данные восстановлены');
          }).catch(function (e) {
            appAlert('Не получилось восстановить: ' + (e && e.message || e));
          });
        });
      });
      actions.appendChild(btnRestore);
    }
    form.appendChild(actions);
    content.appendChild(form);
  }

  function saveSettingsForm(form) {
    // все значения собираем в черновик: если валидация прервёт сохранение,
    // рабочие настройки не должны остаться «полуизменёнными» в памяти
    var draft = JSON.parse(JSON.stringify(settings));
    var inputs = form.querySelectorAll('[data-path]');
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var kind = inp.dataset.kind;
      var value;
      if (kind === 'checkbox') value = inp.checked;
      else if (kind === 'number') {
        value = parseFloat(inp.value);
        if (isNaN(value)) {
          appAlert('Проверьте числовые поля: «' + inp.previousSibling.textContent + '» не число.');
          return;
        }
        // кламп к диапазону поля, если задан (напр. часы БЛ ≤ 26):
        // опечатка вроде 260 иначе обнулила бы все выплаты
        if (inp.dataset.min != null) value = Math.max(parseFloat(inp.dataset.min), value);
        if (inp.dataset.max != null) value = Math.min(parseFloat(inp.dataset.max), value);
      } else if (kind === 'select') {
        value = inp.value;
        if (value === '') continue; // нет выбранной опции — оставить старое значение
        if (/^\d+$/.test(value)) value = parseInt(value, 10);
      } else {
        // лишние пробелы при вставке (особенно токена) ломают доступ
        value = inp.value.trim();
      }
      setPath(draft, inp.dataset.path, value);
    }
    var p1 = $('#set-pass1').value, p2 = $('#set-pass2').value;
    if (p1 || p2) {
      if (p1 !== p2) { appAlert('Пароли не совпадают.'); return; }
      if (p1.length < 4) { appAlert('Пароль должен быть не короче 4 символов.'); return; }
      draft.passwordHash = C.hashString(p1);
    }
    // approved привязан к суммам от Матав: галочка раздела «Гмлат сиуд» без единой
    // введённой суммы не должна включать учёт (иначе занижение доплаты семьи).
    // Но и подменять галочку нельзя: снятая вручную — это единственный способ
    // сказать «Матав больше не платит» и вернуться к полной зарплате, а прежнее
    // безусловное присваивание делало галочку мёртвой.
    if (draft.bl) draft.bl.approved = !!draft.bl.approved && blHasAmount(draft.bl);
    S.saveSettings(draft);
    settings = S.loadSettings();
    render();
    showToast('✓ Настройки сохранены');
    runSync(); // если включили архив — дослать накопившиеся расписки
  }

  // ---------- пароль ----------

  function openPasswordModal() {
    $('#pass-input').value = '';
    $('#pass-error').style.display = 'none';
    $('#pass-hint').style.display =
      settings.passwordHash === C.hashString('1234') ? '' : 'none';
    $('#modal-pass').classList.add('open');
    updateScrollLock();
    setTimeout(function () { $('#pass-input').focus(); }, 50);
  }

  function checkPassword() {
    var v = $('#pass-input').value;
    if (C.hashString(v) === settings.passwordHash) {
      unlockSettings();
      closeModals();
      render();
    } else {
      $('#pass-error').style.display = '';
    }
  }

  // ---------- уведомления ----------

  function maybeNotify(occ) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    var due = occ.filter(function (o) { return o.status === 'due' || o.status === 'overdue'; });
    if (!due.length) return;
    var t = realToday(); // уведомление — раз в реальный день
    if (S.getMeta('lastNotify') === t) return;
    S.setMeta('lastNotify', t);
    // сумма считается по amount, а начисления без суммы от Матав в ней нулевые:
    // на экране про это пишет missingNote, в уведомлении — эта же оговорка,
    // иначе с экрана блокировки цифра выглядит как полная сумма к оплате
    var incomplete = due.filter(function (o) { return o.blMissing; }).length;
    showSystemNotification('Выплаты метапелю — ' + settings.workerName, {
      body: 'Требуют внимания: ' + due.length + ' ' +
        C.plural(due.length, 'платёж', 'платежа', 'платежей') +
        ' на ' + C.fmtMoney(due.reduce(function (s, o) { return s + o.amount; }, 0)) +
        (incomplete ? ' (без учёта ' + incomplete + ' — не введена сумма от Матав)' : ''),
      tag: 'metapel-daily'
    });
  }

  // ---------- принудительное обновление приложения ----------

  // Сбрасывает кэш service worker и перечитывает оболочку из сети, минуя любой
  // кэш — на случай, когда планшет «застрял» на старой версии. Данные (оплаты,
  // расписки, под отчёт) лежат в localStorage и НЕ затрагиваются.
  function forceRefresh() {
    // actionGuard НЕ вызываем: кнопка идёт через appConfirm, чей «Да» уже
    // прошёл actionGuard — повторный вызов попал бы в 600-мс блокировку.
    // Без сети чистить кэш и снимать service worker нельзя — иначе после
    // reload приложение не загрузится (офлайн-копии уже не будет). На file://
    // service worker не регистрируется, обновление — это перечитывание файла
    // с диска, сеть не нужна — там гард не применяем.
    if (navigator.onLine === false && location.protocol !== 'file:') {
      appAlert('Нет интернета — обновить не получится. Подключитесь к сети и попробуйте снова.');
      return;
    }
    showToast('🔄 Обновляю…');
    // ВСЕ свои скрипты, включая модуль подписи табелей: иначе новый app.js
    // мог бы работать со старым парсером из HTTP-кэша (Pages: max-age=600)
    var SHELL = ['index.html', 'css/styles.css', 'js/env.js', 'js/calc.js',
      'js/storage.js', 'js/sync.js', 'js/timesheet-sign.js', 'js/app.js', 'manifest.json'];
    var fam = (window.MetapelEnv && window.MetapelEnv.cacheFamily) || 'metapel-shell-';
    function clearCaches() {
      if (!(window.caches && caches.keys)) return Promise.resolve();
      return caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) {
          // только кэши своей среды — не трогаем другую (stage/prod) на общем origin
          if (k.indexOf(fam) === 0) return caches.delete(k);
        }));
      });
    }
    function dropWorkers() {
      // getRegistration() (без аргумента) возвращает регистрацию ТЕКУЩЕЙ страницы —
      // снимаем только свой service worker, чужой среды (stage/prod) не трогаем
      if (!(navigator.serviceWorker && navigator.serviceWorker.getRegistration)) return Promise.resolve();
      return navigator.serviceWorker.getRegistration().then(function (reg) {
        return reg ? reg.unregister() : null;
      });
    }
    function refetchShell() {
      // {cache:'reload'} заставляет обойти и HTTP-кэш браузера, а не только SW
      return Promise.all(SHELL.map(function (f) {
        return fetch(f, { cache: 'reload' }).catch(function () { /* офлайн — не критично */ });
      }));
    }
    // reload гарантирован таймаутом: если сеть «подвисла» (открытый, но не
    // отвечающий сокет — captive-portal, мигающий мобильный) и refetchShell не
    // завершился, через 4 с всё равно перезагрузим — свежую оболочку при
    // следующем заходе заново закэширует sw.js. reloadOnce страхует от двойной
    // перезагрузки, если успеют сработать и цепочка, и таймаут.
    var reloaded = false;
    function reloadOnce() { if (reloaded) return; reloaded = true; location.reload(); }
    Promise.race([
      clearCaches().then(dropWorkers).then(refetchShell),
      new Promise(function (r) { setTimeout(r, 4000); })
    ]).then(reloadOnce, reloadOnce);
  }

  // ---------- модальные окна и события ----------

  function closeModals() {
    document.querySelectorAll('.modal').forEach(function (m) { m.classList.remove('open'); });
    currentPay = null;
    currentSign = null;
    signCallback = null;
    tsPreviewSave = null;
    matavMonth = null;
    confirmCallback = null;
    updateScrollLock();
    // полсекунды игнорируем касания: «дребезг» пальца после закрытия окна
    // не должен нажать то, что оказалось под ним
    tapShieldUntil = Date.now() + 500;
  }

  // одноразовая правка настроек для установок старше v6.0 (ПЕРСИСТЕНТНО):
  // сбрасываем старое «утверждение по часам» (теперь привязано к сумме от Матав),
  // выключаем визу (платится при выезде) и разрешение (для 85+ бесплатно), ставим
  // компенсацию 8.33%. Маркер _v6 НЕ входит в дефолты → срабатывает один раз и не
  // затирает последующие правки пользователя (mergeDeep сохраняет _v6 из stored).
  function migrateV6() {
    if (settings._v6) return;
    settings._v6 = true;
    settings.bl = settings.bl || {};
    // помесячные суммы тоже считаются «введённой суммой»: устройство, которое ещё
    // не мигрировало, но уже получило matavByMonth из облака, иначе снесло бы approved
    settings.bl.approved = blHasAmount(settings.bl);
    if (settings.types) {
      if (settings.types.visa) settings.types.visa.enabled = false;
      if (settings.types.permit) settings.types.permit.enabled = false;
      if (settings.types.pikadon) settings.types.pikadon.severancePercent = 8.33;
    }
    S.saveSettings(settings);
    settings = S.loadSettings();
  }

  // По умолчанию способ оплаты — наличные (а не перевод). У уже установленных
  // копий types.<тип>.defaultMethod хранит старое 'transfer' (mergeDeep сохраняет
  // имеющиеся значения), поэтому переводим все типы на 'cash' однократно по маркеру.
  function migrateDefaultCash() {
    if (settings._defCash) return;
    settings._defCash = true;
    if (settings.types) {
      Object.keys(settings.types).forEach(function (k) {
        if (settings.types[k]) settings.types[k].defaultMethod = 'cash';
      });
    }
    // заодно убираем мёртвое «фото подписи» (v6.2): функциональность удалена,
    // а сам data-URL мог осесть в установках — чистим, чтобы не тащить его в бэкап
    if ('savedSignature' in settings) delete settings.savedSignature;
    S.saveSettings(settings);
    settings = S.loadSettings();
  }

  function init() {
    migrateV6(); // привести старые установки к v6.0 до первого render
    migrateDefaultCash(); // по умолчанию — наличные (одноразово по маркеру _defCash)
    // на staging — заметная плашка вверху и пометка в заголовке вкладки, чтобы
    // тестовую версию нельзя было спутать с боевой (данные у них РАЗНЫЕ)
    if (window.MetapelEnv && window.MetapelEnv.stage) {
      document.title = 'STAGE · ' + document.title;
      var sb = el('div', 'stage-banner', '🧪 ТЕСТОВАЯ ВЕРСИЯ (STAGE) — данные отдельные от боевой');
      document.body.insertBefore(sb, document.body.firstChild);
    }
    // раздел «Табели» пока только на stage — на проде прячем вкладку
    if (TS_STAGE_ONLY) {
      var ttab = document.querySelector('.tab[data-tab="timesheets"]');
      if (ttab) ttab.style.display = 'none';
      if (activeTab === 'timesheets') activeTab = 'due';
    }
    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () {
        activeTab = b.dataset.tab;
        render();
      });
    });
    $('#btn-settings').addEventListener('click', function () {
      activeTab = 'settings';
      render();
    });
    $('#btn-final').addEventListener('click', openFinalModal);
    $('#btn-refresh').addEventListener('click', function () {
      appConfirm('Обновить приложение до последней версии? Данные (оплаты, расписки, под отчёт) сохранятся.',
        'Да, обновить', forceRefresh);
    });
    window.addEventListener('resize', applyScale);
    $('#btn-notify').addEventListener('click', function () {
      Notification.requestPermission().then(function (perm) {
        if (perm === 'granted') {
          showSystemNotification('Напоминания включены ✓', {
            body: 'Когда подойдёт срок платежа, появится такое уведомление.'
          });
        } else if (perm === 'denied') {
          appAlert('Уведомления запрещены. На компьютере: значок замка возле адреса. ' +
            'На iPad: Настройки → Уведомления → Выплаты.');
        }
        render();
      });
    });
    $('#pay-sats').addEventListener('input', recalcSalaryAmount);
    $('#pay-sats-minus').addEventListener('click', function () { stepSats(-1); });
    $('#pay-sats-plus').addEventListener('click', function () { stepSats(1); });
    $('#pay-amount').addEventListener('input', updatePayBig);
    $('#pay-method-transfer').addEventListener('click', function () {
      payMethod = 'transfer';
      updateMethodButtons();
    });
    $('#pay-method-cash').addEventListener('click', function () {
      payMethod = 'cash';
      updateMethodButtons();
    });

    // рисование подписи пальцем/мышью
    var canvas = $('#sign-canvas');
    canvas.addEventListener('pointerdown', function (e) {
      if (!signCtx) return;
      signDrawing = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* синтетические события */ }
      var p = signPos(e);
      signCtx.beginPath();
      signCtx.moveTo(p.x, p.y);
      signCtx.lineTo(p.x + 0.1, p.y + 0.1); // точка при простом касании
      signCtx.stroke();
      signInk = true;
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!signDrawing || !signCtx) return;
      var p = signPos(e);
      signCtx.lineTo(p.x, p.y);
      signCtx.stroke();
      e.preventDefault();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      canvas.addEventListener(ev, function () { signDrawing = false; });
    });
    $('#sign-ok').addEventListener('click', confirmSign);
    // «стереть»: пере-инициализировать в нужном режиме (табель — прозрачный фон + цвет)
    $('#sign-clear').addEventListener('click', function () { setupSignCanvas(!!signCallback, signColor); });
    $('#sign-later').addEventListener('click', function () {
      // в серии окон (бланк Claims) случайное касание не должно выбросить уже
      // поставленные подписи (до 20 подписей Джамшида) — сначала переспросим
      if (signCallback && tsSeriesCount > 0) {
        appConfirm('Прервать подписание? Уже поставленные подписи (' + tsSeriesCount + ') не сохранятся — ' +
          'начинать придётся заново.', 'Да, прервать', closeModals);
        return;
      }
      closeModals();
    });
    // предпросмотр подписанного табеля
    $('#ts-preview-save').addEventListener('click', function () {
      if (!actionGuard()) return;
      var cb = tsPreviewSave; tsPreviewSave = null;
      closeModals();
      if (cb) cb();
    });
    $('#ts-preview-cancel').addEventListener('click', function () { tsPreviewSave = null; closeModals(); });

    // окно подтверждения
    $('#confirm-yes').addEventListener('click', function () {
      if (!actionGuard()) return;
      var cb = confirmCallback;
      closeConfirm();
      tapShieldUntil = Date.now() + 500;
      if (cb) cb();
    });
    $('#confirm-no').addEventListener('click', function () {
      closeConfirm();
      tapShieldUntil = Date.now() + 500;
    });

    // детали оплаты (сумма/дата) — по явному запросу
    $('#pay-details-toggle').addEventListener('click', function () {
      var d = $('#pay-details');
      d.style.display = d.style.display === 'none' ? '' : 'none';
    });

    // «щит» от двойных касаний: гасим клики 0,5 с после закрытия окон
    document.addEventListener('click', function (e) {
      if (Date.now() < tapShieldUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    // дополнительные платежи и возвраты
    $('#extra-kind-gift').addEventListener('click', function () {
      extraKind = 'gift';
      updateExtraButtons();
    });
    $('#extra-kind-advance').addEventListener('click', function () {
      extraKind = 'advance';
      updateExtraButtons();
    });
    $('#extra-method-transfer').addEventListener('click', function () {
      extraMethod = 'transfer';
      updateExtraButtons();
    });
    $('#extra-method-cash').addEventListener('click', function () {
      extraMethod = 'cash';
      updateExtraButtons();
    });
    $('#extra-confirm').addEventListener('click', confirmExtra);
    $('#return-confirm').addEventListener('click', confirmReturn);

    // калькулятор окончания работы
    $('#final-reason-employer').addEventListener('click', function () {
      finalReason = 'employer';
      updateFinalButtons();
    });
    $('#final-reason-worker').addEventListener('click', function () {
      finalReason = 'worker';
      updateFinalButtons();
    });
    $('#final-calc').addEventListener('click', runFinalCalc);

    // сумма от Матав за месяц (окно вызывается с карточки зарплаты и из настроек)
    $('#hours-minus').addEventListener('click', function () { stepHours(-1); });
    $('#hours-plus').addEventListener('click', function () { stepHours(1); });
    $('#hours-input').addEventListener('input', updateHoursEffect);
    $('#hours-save').addEventListener('click', saveMatavMonth);

    // загрузка табеля Битуах Леуми (PDF) — метаданные локально, файл в архив
    $('#ts-file-input').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = ''; // позволить повторный выбор того же файла
      if (!file) return;
      // PDF табеля хранится ТОЛЬКО в архиве (в localStorage он не лежит). Без токена
      // его негде сохранить — иначе карточка появится, а подпись потом упадёт
      // «файл не найден в архиве». Поэтому требуем настроенный архив сразу.
      if (!window.MetapelSync.isOn(settings)) {
        appAlert('Архив не настроен (нет токена). Введите токен GitHub в настройках, затем загрузите табель — без архива PDF негде хранить.');
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        var dataUrl = reader.result;
        // месяц табеля берём ИЗ БЛАНКА (период «לתקופה MM/YYYY»), а не из даты
        // загрузки: табель сдают за прошлый месяц. Если не распознали — текущий.
        var fallbackMonth = C.parseISO(today()).getFullYear() + '-' +
          ('0' + (C.parseISO(today()).getMonth() + 1)).slice(-2);
        showToast('Читаю период бланка…');
        var pdfU8 = window.MetapelTimesheet.u8FromDataUrl(dataUrl);
        Promise.all([
          window.MetapelTimesheet.parseMonth(pdfU8).catch(function () { return null; }),
          // бланк Claims Conference помечаем сразу — на карточке видно ДО подписания
          window.MetapelTimesheet.parse(pdfU8).then(function (p) { return p.claims; }).catch(function () { return null; })
        ]).then(function (res) {
            var parsedMonth = res[0], claims = res[1];
            var month = parsedMonth || fallbackMonth;
            var id = 'ts-' + Date.now();
            var rec = { id: id, month: month, fileName: file.name, uploadedDate: today(),
              caregiverSigned: false, caregiverSignedDate: null, familySigned: false,
              familySignedDate: null, sentMarked: false, sentDate: null };
            if (typeof claims === 'boolean') rec.claims = claims;
            S.addTimesheet(rec);
            reloadData();
            render();
            showToast('Загружаю табель в архив…');
            window.MetapelSync.putTimesheetFile(settings, id, '', {
              pdf: dataUrl, fileName: file.name, month: month
            }).then(function () {
              // «✓» — только когда карточка реально ушла в облако: раньше тост
              // появлялся ДО синхронизации метаданных, приложение закрывали — и
              // на других устройствах табеля не было (PDF в архиве, бэкап без записи)
              showToast('PDF в архиве, отправляю карточку в облако…');
              return runSync().then(function () {
                // «Синхронизировано» = локальный хэш совпал с залитым (lastBackupHash) —
                // глобальный lastSyncError тут не годится: его могла поставить чужая
                // застрявшая расписка ПОСЛЕ успешного пуша карточки (ложная тревога)
                var clean = false;
                try {
                  clean = C.hashString(window.MetapelSync.buildBackupJson(settings, S, 0)) ===
                    S.getMeta('lastBackupHash');
                } catch (e) {}
                if (clean) {
                  showToast('✓ Табель загружен и синхронизирован (' + month + ')');
                } else {
                  var err = S.getMeta('lastSyncError');
                  appAlert('PDF табеля в архиве, но карточка ещё НЕ в облаке' +
                    (err ? ' (' + err + ')' : '') +
                    '.\nОставьте приложение открытым — оно дошлёт само (авто-синхронизация раз в 15 минут). Повторно загружать не нужно.');
                }
              });
            }, function (err) {
              // PDF не попал в архив — убираем «битую» карточку, чтобы подпись потом
              // не падала. Обработчик ВТОРЫМ аргументом then: откат карточки только
              // при провале putTimesheetFile, а не из-за ошибки последующего sync.
              S.deleteTimesheet(id);
              reloadData();
              render();
              appAlert('Не удалось сохранить PDF табеля в архив: ' + (err && err.message || err) +
                '\nКарточка удалена. Проверьте интернет/токен и загрузите снова.');
            });
          });
      };
      reader.readAsDataURL(file);
    });

    $('#pay-confirm').addEventListener('click', confirmPay);
    $('#pass-confirm').addEventListener('click', checkPassword);
    // поле пароля теперь внутри <form> — Enter шлёт submit; гасим перезагрузку и проверяем
    $('#pass-form').addEventListener('submit', function (e) { e.preventDefault(); checkPassword(); });
    document.querySelectorAll('.modal-close').forEach(function (b) {
      b.addEventListener('click', closeModals);
    });
    // Касание тёмного фона окна НЕ закрывает: при слабой моторике ладонь
    // рядом с окном сбрасывала бы ввод. Закрытие — только явными кнопками.
    // если страница остаётся открытой — перерисовка при смене даты
    var lastDay = realToday();
    setInterval(function () {
      if (realToday() !== lastDay) {
        lastDay = realToday();
        backgroundRender(); // не стирать открытое окно или форму настроек
      }
    }, 60 * 1000);
    // АНТИ-«ОТСТАВАНИЕ» (инцидент 02.08.2026): устройство, неделями открытое без
    // перезапуска (машина в доме Григория), тянуло облако только при открытии;
    // отметка оплаты на ОТСТАВШЕМ устройстве запирала данные локально (conflict).
    // Периодический runSync держит устройство актуальным. Это безопасно: pull
    // внутри защищён decideSync (тянет ТОЛЬКО «чистое» устройство), push — хэшем
    // и CAS по sha, повторный вход — флагом syncInFlight, а перерисовка после
    // pull идёт через backgroundRender (открытые окна и настройки не трогает).
    // ФОНОВЫЙ запуск пропускаем при открытой модалке или на вкладке настроек:
    // pull под открытой ФОРМОЙ (сумма от Матав, настройки) выровнял бы generation,
    // и «Сохранить» потом откатило бы свежую облачную сумму устаревшим значением
    // из полей формы (находка ревью v6.5). Ручные runSync после действий не
    // фильтруем — они идут ПОСЛЕ записи данных.
    function maybeAutoSync() {
      if (document.querySelector('.modal.open')) return;
      if (activeTab === 'settings') return;
      runSync();
    }
    setInterval(maybeAutoSync, 15 * 60 * 1000);
    // и сразу при возврате к приложению (развернули окно/вкладку)
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) maybeAutoSync();
    });
    $('#app-version').textContent = 'Версия ' + APP_VERSION +
      (window.MetapelEnv && window.MetapelEnv.stage ? ' · 🧪 STAGE' : '');
    // офлайн-режим: приложение открывается из кэша без интернета
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () { /* не критично */ });
    }
    // просим браузер не выселять данные при нехватке места
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () { /* не критично */ });
    }
    // переполнение хранилища не должно проходить молча
    S.setOnSaveError(function () {
      appAlert('Память устройства для приложения заполнена — последняя запись могла не сохраниться. ' +
        'Проверьте «Оплачено» / «Под отчёт» и сообщите родственникам.');
    });
    render();
    runSync(); // дослать расписки, не отправленные в прошлый раз
  }

  document.addEventListener('DOMContentLoaded', init);
})();
