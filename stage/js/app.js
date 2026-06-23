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
  var APP_VERSION = '6.0.2 от 23.06.2026 (Сумма от Матав вручную; пикадон 8.33%; виза/разрешение выкл.; страховка раз в год)';

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
  var payMethod = 'transfer';  // выбранный способ в диалоге оплаты
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

  function render() {
    applyScale();
    var occ = withStatus(occurrences());
    renderHeader();
    renderNav(occ);
    var content = $('#content');
    content.innerHTML = '';
    if (activeTab === 'due') { blStatusCard(content); renderDue(occ, content); }
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

    if (withPayBtn) {
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
      ' — список ниже. После каждой оплаты нажмите зелёную кнопку.</div>'));
    due.forEach(function (o) { content.appendChild(card(o, true)); });
  }

  // ---------- часы Битуах Леуми: статус на главном экране ----------

  // законный максимум — 26 ч/нед (уровень 6, иностранный работник);
  // единый источник правды — calc.js (clampHours/saveHours/настройки)
  var MAX_BL_HOURS = C.BL_MAX_HOURS;

  function clampHours(h) {
    if (isNaN(h) || h < 0) return 0;
    return Math.min(MAX_BL_HOURS, h);
  }
  // прямая сумма от Матав (₪/мес): ≥ 0, округление до копеек
  function clampAmount(v) {
    if (isNaN(v) || v < 0) return 0;
    return C.round2(v);
  }

  function blStatusCard(content) {
    var bl = settings.bl || {};
    if (bl.approved) {
      var cardA = el('div', 'bl-card bl-approved',
        '✅ <b>Матав (гмлат сиуд) оплачивает часть зарплаты</b>' +
        '<div class="bl-sub">Государство оплачивает часть зарплаты. Суммы ниже — это доплата семьи.</div>');
      var btnA = el('button', 'btn btn-light', '✎ Изменить сумму от Матав');
      btnA.addEventListener('click', openHoursModal);
      cardA.appendChild(btnA);
      content.appendChild(cardA);
    } else {
      var cardP = el('div', 'bl-card bl-pending',
        'Введите сумму оплаты от Матав (гмлат сиуд) за последний месяц.');
      var btnP = el('button', 'btn btn-light', '✓ Указать сумму от Матав');
      btnP.addEventListener('click', openHoursModal);
      cardP.appendChild(btnP);
      content.appendChild(cardP);
    }
  }

  function openHoursModal() {
    var bl = settings.bl || {};
    $('#hours-input').value = bl.matavAmount || 0;
    $('#hours-revert').style.display = bl.approved ? '' : 'none';
    updateHoursEffect();
    $('#modal-hours').classList.add('open');
    updateScrollLock();
  }

  function stepHours(delta) {
    var v = parseFloat($('#hours-input').value);
    if (isNaN(v)) v = 0;
    v = clampAmount(v + delta * 100); // шаг ±100 ₪
    $('#hours-input').value = v;
    updateHoursEffect();
  }

  function updateHoursEffect() {
    var amt = clampAmount(parseFloat($('#hours-input').value));
    var net = (settings.types && settings.types.salary) ? settings.types.salary.net : amt;
    var doplata = Math.max(0, C.round2(net - Math.min(amt, net)));
    $('#hours-effect').textContent = 'Матав платит ≈ ' + C.fmtMoney(amt) +
      ' в месяц → ваша доплата зарплаты ≈ ' + C.fmtMoney(doplata) + ' (плюс субботы).';
  }

  function saveHours() {
    if (!actionGuard()) return;
    var raw = parseFloat($('#hours-input').value);
    if (isNaN(raw) || raw < 0) { appAlert('Укажите сумму от Матав (₪ в месяц). 0 — если Матав не платит.'); return; }
    var amt = clampAmount(raw);
    settings.bl.matavAmount = amt;
    settings.bl.approved = amt > 0; // 0 — учёт суммы от Матав выключается
    S.saveSettings(settings);
    settings = S.loadSettings();
    closeModals();
    render();
    showToast(amt > 0 ? '✓ Сумма от Матав сохранена' : '✓ Учёт суммы от Матав отключён');
    runSync();
  }

  function revertHours() {
    if (!actionGuard()) return;
    settings.bl.approved = false;
    S.saveSettings(settings);
    settings = S.loadSettings();
    closeModals();
    render();
    showToast('✓ Отмечено: часы не утверждены');
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
    timesheets.slice().sort(function (a, b) { return a.month < b.month ? 1 : -1; }).forEach(function (t) {
      var st = C.timesheetStatus(t);
      var card = el('div', 'card paid-card');
      var head = el('div', 'card-head');
      var left = el('div', 'card-left');
      left.appendChild(el('div', 'card-title', '📋 Табель ' + esc(tsMonthSlash(t.month))));
      left.appendChild(el('div', 'card-due', 'загружен ' + C.fmtDate(t.uploadedDate)));
      head.appendChild(left);
      head.appendChild(el('div', 'ts-chip ts-' + st, TS_LABELS[st]));
      card.appendChild(head);

      var acts = el('div', 'ts-actions');
      if (st !== 'sent') {
        if (!t.caregiverSigned) {
          acts.appendChild(tsBtn('✍ Подписать Метапелет', 'btn-pay', function () { tsSign(t.id, 'caregiver'); }));
        }
        if (!t.familySigned) {
          acts.appendChild(tsBtn('✍ Подпись Григория (член семьи)', 'btn-give-gift', function () { tsSign(t.id, 'family'); }));
        }
      }
      if (t.caregiverSigned || t.familySigned) {
        acts.appendChild(tsBtn('⬇ Скачать подписанный PDF', 'btn-light', function () { tsDownload(t.id); }));
      }
      if (st === 'full') {
        acts.appendChild(tsBtn('📧 Отослать в Матав', 'btn-pay', function () { tsSend(t.id); }));
        acts.appendChild(tsBtn('✓ Отметить «Отослано»', 'btn-light', function () { tsMarkSent(t.id); }));
      }
      if (st === 'sent') {
        acts.appendChild(el('div', 'card-due', 'отослано ' + C.fmtDate(t.sentDate)));
        acts.appendChild(tsBtn('📧 Отослать повторно', 'btn-pay', function () { tsSend(t.id); }));
      }
      acts.appendChild(tsBtn('🗑 Удалить табель', 'btn-undo', function () { tsDelete(t.id); }));
      card.appendChild(acts);
      content.appendChild(card);
    });
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
  // ИСХОДНОГО бланка + ОБЕИХ сохранённых подписей. Поэтому второе/повторное
  // подписание не может потерять чужую подпись (раньше копили поверх скачанного
  // подписанного — сбой сети/кэша мог затереть подпись первого подписанта).
  function tsSign(id, signer) {
    if (!window.MetapelSync.isOn(settings)) { appAlert('Архив не настроен (нет токена) — подпись табеля недоступна. Введите токен в настройках.'); return; }
    var t = findTimesheet(id);
    if (!t) return;
    showToast('Загружаю бланк…');
    window.MetapelSync.fetchTimesheetFile(settings, t.id, '').then(function (obj) {
      var origU8 = window.MetapelTimesheet.u8FromDataUrl(obj.pdf);
      return window.MetapelTimesheet.parse(origU8).then(function (parsed) {
        if (!parsed.slots.length) { appAlert('В бланке не нашлось мест для подписи.'); return; }
        var title = signer === 'caregiver' ? '✍ Подпись Метапелет' : '✍ Подпись за Григория';
        var desc = signer === 'caregiver'
          ? 'Распишитесь <b>один раз</b> — синяя подпись Джамшида встанет в каждый рабочий день.'
          : 'Распишитесь <b>один раз</b> за Григория — чёрная недельная подпись встанет на каждую рабочую неделю.';
        openFingerSign(title, desc, '✓ Готово', 'Распишитесь пальцем в рамке и нажмите «Готово».', function (newSig) {
          // обе подписи: новая + уже сохранённая другого подписанта (хранится в записи)
          var careSig = signer === 'caregiver' ? newSig : t.caregiverSig;
          var famSig = signer === 'family' ? newSig : t.familySig;
          showToast('Расставляю подписи…');
          tsBuildSigned(origU8, parsed.slots, careSig, famSig).then(function (signedU8) {
            tsShowPreview(signedU8, function () { tsSaveSigned(t, signedU8, signer, newSig); });
          }).catch(function (e) { appAlert('Ошибка расстановки подписи: ' + (e && e.message || e)); });
        }, tsInkColor(signer));
      });
    }).catch(function (e) { appAlert('Не удалось загрузить/разобрать табель: ' + (e && e.message || e)); });
  }

  // собирает подписанный PDF из ИСХОДНОГО бланка: метапелет (care-day, синий) +
  // Григорий (family-week, чёрный). Любая отсутствующая подпись просто пропускается.
  function tsBuildSigned(origU8, slots, careSig, famSig) {
    var p = Promise.resolve(origU8);
    if (careSig) p = p.then(function (u8) { return window.MetapelTimesheet.stamp(u8, slots, ['care-day'], careSig, {}); });
    if (famSig) p = p.then(function (u8) { return window.MetapelTimesheet.stamp(u8, slots, ['family-week'], famSig, {}); });
    return p;
  }

  var tsPreviewSave = null;
  function tsShowPreview(signedU8, onSave) {
    tsPreviewSave = onSave;
    $('#modal-ts-preview').classList.add('open');
    updateScrollLock();
    window.MetapelTimesheet.render(signedU8, $('#ts-preview-canvas'), 1.5)
      .catch(function (e) { appAlert('Предпросмотр не отрисовался: ' + (e && e.message || e)); });
  }

  function tsSaveSigned(t, signedU8, signer, newSig) {
    var dataUrl = window.MetapelTimesheet.bytesToDataUrl(signedU8, 'application/pdf');
    showToast('Сохраняю подписанный табель…');
    window.MetapelSync.putTimesheetFile(settings, t.id, '-signed', { pdf: dataUrl, fileName: t.fileName, month: t.month }).then(function () {
      // СОХРАНЯЕМ саму подпись (PNG) в записи — чтобы при следующем подписании
      // другим человеком пересобрать PDF из исходного + обеих подписей.
      var patch = {};
      if (signer === 'caregiver') { patch.caregiverSigned = true; patch.caregiverSignedDate = today(); patch.caregiverSig = newSig; }
      else { patch.familySigned = true; patch.familySignedDate = today(); patch.familySig = newSig; }
      S.updateTimesheet(t.id, patch);
      reloadData();
      render();
      showToast('✓ Подпись сохранена');
      runSync();
    }).catch(function (e) { appAlert('Не удалось сохранить подписанный табель: ' + (e && e.message || e)); });
  }

  // ---------- скачивание / отправка (Этап 3) ----------

  function tsDownload(id) {
    var t = findTimesheet(id);
    if (!t) return;
    if (!window.MetapelSync.isOn(settings)) { appAlert('Архив не настроен (нет токена).'); return; }
    var suffix = (t.caregiverSigned || t.familySigned) ? '-signed' : '';
    showToast('Готовлю файл…');
    window.MetapelSync.fetchTimesheetFile(settings, id, suffix).then(function (obj) {
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

  function tsSend(id) {
    // авто-отправка через EmailJS (см. tsSendEmail); при отсутствии настроек —
    // подсказываем запасной путь (скачать + отметить вручную)
    tsSendEmail(id);
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

  function tsSendEmail(id) {
    var t = findTimesheet(id);
    if (!t) return;
    var ej = settings.emailjs || {};
    if (!ej.serviceId || !ej.templateId || !ej.publicKey || !ej.recipient) {
      appAlert('Авто-отправка (EmailJS) не настроена. Зайдите в Настройки → «Отправка в Матав (EmailJS)» и заполните поля. Либо нажмите «Скачать подписанный PDF», отправьте письмом вручную и отметьте «Отослано».');
      return;
    }
    if (!window.MetapelSync.isOn(settings)) { appAlert('Архив не настроен (нет токена).'); return; }
    // получателей может быть несколько (через запятую/точку с запятой) — нормализуем
    var toList = tsParseRecipients(ej.recipient);
    if (!toList.length) { appAlert('Не указан e-mail получателя (Матав) в настройках.'); return; }
    var badEmails = toList.filter(function (a) { return !tsIsEmail(a); });
    if (badEmails.length) {
      appAlert('Похоже, эти адреса записаны с ошибкой:\n' + badEmails.join('\n') +
        '\n\nПроверьте список получателей в Настройках (адреса через запятую или точку с запятой).');
      return;
    }
    var toStr = toList.join(', '); // EmailJS «To Email» принимает список через запятую
    var already = !!t.sentMarked;
    var confirmMsg = (already ? 'Отправить табель ПОВТОРНО' : 'Отправить подписанный табель') +
      ' письмом в Матав?\n\nКому: ' + toList.join(', ');
    appConfirm(confirmMsg, already ? '📧 Отослать повторно' : '📧 Отправить', function () {
      showToast('Готовлю и отправляю…');
      var suffix = (t.caregiverSigned || t.familySigned) ? '-signed' : '';
      window.MetapelSync.fetchTimesheetFile(settings, id, suffix).then(function (obj) {
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
        var subject = 'יומן עבודה חתום — ' + monthSlash;
        var messageHtml =
          '<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.7;color:#1f2937;">' +
            '<p>לכבוד מטב,</p>' +
            '<p>מצורף בזאת <b>יומן עבודה חתום</b> עבור המטופל <b>גריגורי רזומובסקי</b> לתקופה <b>' + monthSlash + '</b>.</p>' +
            '<p>היומן חתום על ידי המטפל ועל ידי בן המשפחה.</p>' +
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
        S.updateTimesheet(id, { sentMarked: true, sentDate: today() });
        reloadData();
        render();
        showToast('✓ Отослано в Матав');
        runSync();
      }).catch(function (e) {
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
      C.fmtMoney(sumAmounts(unpaid)) + '</b>'));
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
        ? '<div class="sync-badge">☁ Сохранена в архиве GitHub</div>'
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
      // подпись есть локально (это устройство расписывалось) — показываем сразу
      var img = el('img', 'sig-img');
      img.src = e.signature;
      img.alt = 'Подпись метапеля';
      div.appendChild(img);
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
    payMethod = settings.types[o.type].defaultMethod || 'transfer';
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
    var hint = $('#sign-hint'); if (hint) hint.textContent = hintText || 'Распишитесь пальцем в рамке выше и нажмите кнопку.';
    $('#modal-sign').classList.add('open');
    updateScrollLock();
    setupSignCanvas(true, signColor);
  }

  // Обрезает подпись до рамки чернил (+поля) — чтобы в маленькой ячейке бланка
  // подпись заполняла место и была видна, а не превращалась в точку.
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
      var out = document.createElement('canvas'); out.width = cw; out.height = ch;
      out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
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

  function runSync() {
    if (syncInFlight) return;
    if (!window.MetapelSync.isOn(settings)) return;
    syncInFlight = true;
    // 1) Автоподтягивание свежей облачной копии — только если включено для среды.
    //    На проде autoSync=false → сразу null, поведение прежнее (ручное «Восстановить»).
    var pullStep = (window.MetapelEnv && window.MetapelEnv.autoSync)
      ? window.MetapelSync.pullIfNewer(settings, S, C.hashString)
      : Promise.resolve(null);
    pullStep.then(function (pulled) {
      if (pulled) {
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
      return window.MetapelSync.processQueue(settings, S, null).then(function (sent) {
        return window.MetapelSync.backupIfChanged(settings, S, C.hashString).then(function (backedUp) {
          syncInFlight = false;
          if (sent > 0 || backedUp) {
            reloadData();
            backgroundRender();
          }
        });
      });
    }).catch(function () {
      syncInFlight = false;
    });
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
        hint: 'Матав платит работнику часть зарплаты (за счёт пособия по уходу от ' +
          'Битуах Леуми), остальное доплачиваете вы. Укажите сумму, которую Матав ' +
          'платит в месяц — её удобнее задавать на главном экране кнопкой «Указать ' +
          'сумму от Матав» (меняется месяц к месяцу). Галочка слева — учитывать эту ' +
          'сумму. Сейчас учтено: ' + C.fmtMoney(C.blMonthlyOffset(settings)) + ' в месяц.',
        fields: [
        { path: 'bl.matavAmount', label: 'Матав платит, ₪ в месяц', type: 'number', min: 0 },
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
          placeholder: 'mail1@matav.co.il, mail2@matav.co.il' }
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
            data.settings = data.settings || {};
            data.settings.sync = settings.sync; // токен этого устройства сохраняем
            S.saveSettings(data.settings);
            S.replaceData({
              log: data.log || {},
              extras: data.extras || [],
              returns: data.returns || []
            });
            // «усыновляем» версию облака: устройство теперь актуально и может
            // дописывать бэкап, не считаясь устаревшим; чужую историю не затрёт
            S.setMeta('backupGeneration', (typeof data.generation === 'number') ? data.generation : 0);
            // сбрасываем хэш последней заливки: иначе guard «контент не менялся»
            // мог бы ложно заглушить первую заливку после восстановления, если
            // данные позже вернутся к прежнему снимку этого устройства
            S.setMeta('lastBackupHash', null);
            settings = S.loadSettings();
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
    // approved привязан к сумме от Матав: галочка раздела «Гмлат сиуд» без
    // введённой суммы не должна включать учёт (иначе занижение доплаты семьи)
    if (draft.bl) draft.bl.approved = (typeof draft.bl.matavAmount === 'number' && draft.bl.matavAmount > 0);
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
    showSystemNotification('Выплаты метапелю — ' + settings.workerName, {
      body: 'Требуют внимания: ' + due.length + ' ' +
        C.plural(due.length, 'платёж', 'платежа', 'платежей') +
        ' на ' + C.fmtMoney(due.reduce(function (s, o) { return s + o.amount; }, 0)),
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
    var SHELL = ['index.html', 'css/styles.css', 'js/env.js', 'js/calc.js',
      'js/storage.js', 'js/sync.js', 'js/app.js', 'manifest.json'];
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
    settings.bl.approved = (typeof settings.bl.matavAmount === 'number' && settings.bl.matavAmount > 0);
    if (settings.types) {
      if (settings.types.visa) settings.types.visa.enabled = false;
      if (settings.types.permit) settings.types.permit.enabled = false;
      if (settings.types.pikadon) settings.types.pikadon.severancePercent = 8.33;
    }
    S.saveSettings(settings);
    settings = S.loadSettings();
  }

  function init() {
    migrateV6(); // привести старые установки к v6.0 до первого render
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
    $('#sign-later').addEventListener('click', closeModals);
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

    // часы Битуах Леуми (главный экран)
    $('#hours-minus').addEventListener('click', function () { stepHours(-1); });
    $('#hours-plus').addEventListener('click', function () { stepHours(1); });
    $('#hours-input').addEventListener('input', updateHoursEffect);
    $('#hours-save').addEventListener('click', saveHours);
    $('#hours-revert').addEventListener('click', revertHours);

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
        window.MetapelTimesheet.parseMonth(window.MetapelTimesheet.u8FromDataUrl(dataUrl))
          .catch(function () { return null; })
          .then(function (parsedMonth) {
            var month = parsedMonth || fallbackMonth;
            var id = 'ts-' + Date.now();
            var rec = { id: id, month: month, fileName: file.name, uploadedDate: today(),
              caregiverSigned: false, caregiverSignedDate: null, familySigned: false,
              familySignedDate: null, sentMarked: false, sentDate: null };
            S.addTimesheet(rec);
            reloadData();
            render();
            showToast('Загружаю табель в архив…');
            window.MetapelSync.putTimesheetFile(settings, id, '', {
              pdf: dataUrl, fileName: file.name, month: month
            }).then(function () {
              showToast('✓ Табель загружен (' + month + ')');
              runSync();
            }).catch(function (err) {
              // PDF не попал в архив — убираем «битую» карточку, чтобы подпись потом не падала
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
