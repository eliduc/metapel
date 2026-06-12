/*
 * MetapelApp — UI: вкладки, карточки платежей, отметка «оплачено»,
 * настройки за паролем, браузерные уведомления.
 * Для отладки дату «сегодня» можно подменить: index.html?today=2026-12-09
 */
(function () {
  'use strict';

  var C = window.MetapelCalc;
  var S = window.MetapelStore;

  // ---------- «сегодня» ----------

  var params = new URLSearchParams(location.search);
  var simToday = params.get('today');
  if (simToday && !/^\d{4}-\d{2}-\d{2}$/.test(simToday)) simToday = null;

  function realToday() { return C.toISO(new Date()); }
  function today() { return simToday || realToday(); }

  // ---------- состояние ----------

  var settings = S.loadSettings();
  var log = S.loadLog();
  var activeTab = 'due';
  var settingsUnlocked = false;
  var currentPay = null; // вхождение в диалоге оплаты

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
    for (var i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
  }

  function occurrences() {
    return C.generateOccurrences(settings, today(), HORIZON_DAYS);
  }

  function withStatus(list) {
    return list.map(function (o) {
      o.status = C.getStatus(o, log, today(), settings);
      return o;
    });
  }

  // ---------- рендер ----------

  function render() {
    var occ = withStatus(occurrences());
    renderHeader();
    renderNav(occ);
    var content = $('#content');
    content.innerHTML = '';
    if (activeTab === 'due') renderDue(occ, content);
    else if (activeTab === 'upcoming') renderUpcoming(occ, content);
    else if (activeTab === 'history') renderHistory(content);
    else if (activeTab === 'settings') renderSettings(content);
    maybeNotify(occ);
  }

  function renderHeader() {
    $('#hdr-title').textContent = 'Выплаты метапелю · ' + settings.workerName;
    $('#hdr-sub').textContent = 'Работодатель: ' + settings.employerName +
      ' · работает с ' + C.fmtDate(settings.startDate);
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
      var btn = el('button', 'btn btn-pay', '✓ Я ЗАПЛАТИЛ');
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

  function renderHistory(content) {
    var ids = Object.keys(log);
    if (!ids.length) {
      content.appendChild(el('div', 'empty', 'Оплаченных платежей пока нет.'));
      return;
    }
    var entries = ids.map(function (id) {
      var r = log[id];
      return { id: id, title: r.title, dueDate: r.dueDate, paidDate: r.paidDate, amount: r.paidAmount };
    }).sort(function (a, b) {
      return a.paidDate < b.paidDate ? 1 : a.paidDate > b.paidDate ? -1 :
        (a.dueDate < b.dueDate ? 1 : -1);
    });
    content.appendChild(el('div', 'summary',
      'Всего выплачено: <b>' + C.fmtMoney(entries.reduce(function (s, e) { return s + e.amount; }, 0)) +
      '</b> · записей: ' + entries.length));
    entries.forEach(function (e) {
      var div = el('div', 'card paid-card');
      var head = el('div', 'card-head');
      var left = el('div', 'card-left');
      left.appendChild(el('div', 'card-title', esc(e.title)));
      left.appendChild(el('div', 'card-due',
        'оплачено ' + C.fmtDate(e.paidDate) + (e.dueDate ? ' · срок был ' + C.fmtDate(e.dueDate) : '')));
      head.appendChild(left);
      head.appendChild(el('div', 'card-amount', C.fmtMoney(e.amount)));
      div.appendChild(head);
      var actions = el('div', 'card-actions');
      var btn = el('button', 'btn btn-undo', '↩ Отменить (нажали по ошибке)');
      btn.addEventListener('click', function () {
        if (confirm('Убрать отметку об оплате «' + e.title + '»? Платёж вернётся в напоминания.')) {
          S.unmarkPaid(e.id);
          log = S.loadLog();
          render();
        }
      });
      actions.appendChild(btn);
      div.appendChild(actions);
      content.appendChild(div);
    });
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
    updatePayBig();
    $('#modal-pay').classList.add('open');
  }

  function updatePayBig() {
    var v = parseFloat($('#pay-amount').value);
    $('#pay-amount-big').textContent = C.fmtMoney(isNaN(v) ? 0 : v);
  }

  function recalcSalaryAmount() {
    if (!currentPay || currentPay.type !== 'salary') return;
    var sats = parseInt($('#pay-sats').value, 10);
    if (isNaN(sats) || sats < 0) sats = 0;
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
    var amount = parseFloat($('#pay-amount').value);
    var paidDate = $('#pay-date').value;
    if (isNaN(amount) || amount < 0) { alert('Укажите сумму.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) { alert('Укажите дату оплаты.'); return; }
    S.markPaid(currentPay.id, {
      title: currentPay.title,
      dueDate: currentPay.dueDate,
      amount: currentPay.amount,
      paidAmount: C.round2(amount),
      paidDate: paidDate
    });
    log = S.loadLog();
    closeModals();
    render();
  }

  // ---------- настройки ----------

  var WEEKDAY_OPTIONS = C.WEEKDAYS.map(function (w, i) { return [i, w]; });

  function settingsForm() {
    return [
      { section: 'Общие', fields: [
        { path: 'workerName', label: 'Имя работника', type: 'text' },
        { path: 'employerName', label: 'Имя работодателя', type: 'text' },
        { path: 'startDate', label: 'Дата начала работы', type: 'date' }
      ] },
      { section: 'Зарплата', enable: 'types.salary.enabled', fields: [
        { path: 'types.salary.net', label: 'Нетто в месяц, ₪', type: 'number' },
        { path: 'types.salary.shabbatRate', label: 'За субботу (шабат), ₪', type: 'number' },
        { path: 'types.salary.dayOfMonth', label: 'День выплаты (числа следующего месяца)', type: 'number' },
        { path: 'types.salary.noticeDays', label: 'Первое напоминание за, дней', type: 'number' }
      ] },
      { section: 'Карманные (дмей кис)', enable: 'types.pocket.enabled', fields: [
        { path: 'types.pocket.amount', label: 'Сумма в неделю, ₪', type: 'number' },
        { path: 'types.pocket.weekday', label: 'День недели', type: 'select', options: WEEKDAY_OPTIONS },
        { path: 'types.pocket.noticeDays', label: 'Первое напоминание за, дней', type: 'number' }
      ] },
      { section: 'Мед. страховка', enable: 'types.insurance.enabled', fields: [
        { path: 'types.insurance.amount', label: 'Сумма в месяц, ₪', type: 'number' },
        { path: 'types.insurance.dayOfMonth', label: 'День оплаты (число месяца)', type: 'number' },
        { path: 'types.insurance.noticeDays', label: 'Первое напоминание за, дней', type: 'number' }
      ] },
      { section: 'Битуах Леуми', enable: 'types.bituach.enabled', fields: [
        { path: 'types.bituach.ratePercent', label: 'Ставка, % от брутто', type: 'number' },
        { path: 'types.bituach.grossBase', label: 'Брутто-база, ₪', type: 'number' },
        { path: 'types.bituach.frequency', label: 'Частота оплаты', type: 'select',
          options: [['monthly', 'ежемесячно'], ['quarterly', 'раз в квартал']] },
        { path: 'types.bituach.dayOfMonth', label: 'День оплаты при ежемесячной (числа след. месяца)', type: 'number' },
        { path: 'types.bituach.quarterDay', label: 'День оплаты при квартальной (числа месяца после квартала)', type: 'number' },
        { path: 'types.bituach.noticeDays', label: 'Первое напоминание за, дней', type: 'number' }
      ] },
      { section: 'Пикадон (пенсия + компенсация)', enable: 'types.pikadon.enabled', fields: [
        { path: 'types.pikadon.pensionPercent', label: 'Пенсия, %', type: 'number' },
        { path: 'types.pikadon.severancePercent', label: 'Компенсация, %', type: 'number' },
        { path: 'types.pikadon.grossBase', label: 'Брутто-база, ₪', type: 'number' },
        { path: 'types.pikadon.fromMonth', label: 'Платится начиная с месяца работы №', type: 'number' },
        { path: 'types.pikadon.dayOfMonth', label: 'День оплаты (числа след. месяца)', type: 'number' },
        { path: 'types.pikadon.noticeDays', label: 'Первое напоминание за, дней', type: 'number' }
      ] },
      { section: 'Дмей хавраа (оздоровительные)', enable: 'types.havraa.enabled', fields: [
        { path: 'types.havraa.dayRate', label: 'Ставка за день, ₪', type: 'number' },
        { path: 'types.havraa.tiers.0.days', label: 'Дней за 1-й год', type: 'number' },
        { path: 'types.havraa.tiers.1.days', label: 'Дней за 2–3-й годы', type: 'number' },
        { path: 'types.havraa.tiers.2.days', label: 'Дней за 4–10-й годы', type: 'number' },
        { path: 'types.havraa.noticeDays', label: 'Первое напоминание за, дней', type: 'number' }
      ] },
      { section: 'Продление визы', enable: 'types.visa.enabled', fields: [
        { path: 'types.visa.amount', label: 'Сумма, ₪ (раз в год)', type: 'number' },
        { path: 'types.visa.noticeDays', label: 'Первое напоминание за, дней', type: 'number' }
      ] },
      { section: 'Корпорация (тагид)', enable: 'types.tagid.enabled', fields: [
        { path: 'types.tagid.amount', label: 'Сумма, ₪ (раз в год)', type: 'number' },
        { path: 'types.tagid.noticeDays', label: 'Первое напоминание за, дней', type: 'number' }
      ] },
      { section: 'Продление разрешения', enable: 'types.permit.enabled', fields: [
        { path: 'types.permit.amount', label: 'Сумма, ₪', type: 'number' },
        { path: 'types.permit.intervalYears', label: 'Раз во сколько лет', type: 'number' },
        { path: 'types.permit.noticeDays', label: 'Первое напоминание за, дней', type: 'number' }
      ] }
    ];
  }

  function renderSettings(content) {
    if (!settingsUnlocked) {
      content.appendChild(el('div', 'empty', 'Настройки защищены паролем.'));
      openPasswordModal();
      return;
    }
    var form = el('div', 'settings-form');
    settingsForm().forEach(function (sec) {
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
        row.appendChild(el('label', null, esc(f.label)));
        var input;
        if (f.type === 'select') {
          input = el('select');
          f.options.forEach(function (opt) {
            var o = el('option', null, esc(opt[1]));
            o.value = opt[0];
            input.appendChild(o);
          });
          input.value = getPath(settings, f.path);
        } else {
          input = el('input');
          input.type = f.type;
          if (f.type === 'number') input.step = 'any';
          input.value = getPath(settings, f.path);
        }
        input.dataset.path = f.path;
        input.dataset.kind = f.type;
        row.appendChild(input);
        fs.appendChild(row);
      });
      form.appendChild(fs);
    });

    // смена пароля
    var fsP = el('fieldset');
    fsP.appendChild(el('legend', null, 'Пароль настроек'));
    var rowP1 = el('div', 'form-row');
    rowP1.appendChild(el('label', null, 'Новый пароль (пусто — не менять)'));
    var p1 = el('input'); p1.type = 'password'; p1.id = 'set-pass1';
    rowP1.appendChild(p1);
    fsP.appendChild(rowP1);
    var rowP2 = el('div', 'form-row');
    rowP2.appendChild(el('label', null, 'Повторите новый пароль'));
    var p2 = el('input'); p2.type = 'password'; p2.id = 'set-pass2';
    rowP2.appendChild(p2);
    fsP.appendChild(rowP2);
    fsP.appendChild(el('div', 'hint',
      'Пароль — защита от случайного входа, данные хранятся локально в этом браузере.'));
    form.appendChild(fsP);

    var actions = el('div', 'settings-actions');
    var btnSave = el('button', 'btn btn-pay', 'Сохранить настройки');
    btnSave.addEventListener('click', function () { saveSettingsForm(form); });
    var btnReset = el('button', 'btn btn-undo', 'Сбросить к значениям по умолчанию');
    btnReset.addEventListener('click', function () {
      if (confirm('Вернуть все настройки к значениям по умолчанию? История оплат сохранится.')) {
        S.resetSettings();
        settings = S.loadSettings();
        render();
      }
    });
    actions.appendChild(btnSave);
    actions.appendChild(btnReset);
    form.appendChild(actions);
    content.appendChild(form);
  }

  function saveSettingsForm(form) {
    var inputs = form.querySelectorAll('[data-path]');
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var kind = inp.dataset.kind;
      var value;
      if (kind === 'checkbox') value = inp.checked;
      else if (kind === 'number') {
        value = parseFloat(inp.value);
        if (isNaN(value)) {
          alert('Проверьте числовые поля: «' + inp.previousSibling.textContent + '» не число.');
          return;
        }
      } else if (kind === 'select') {
        value = inp.value;
        if (/^\d+$/.test(value)) value = parseInt(value, 10);
      } else {
        value = inp.value;
      }
      setPath(settings, inp.dataset.path, value);
    }
    var p1 = $('#set-pass1').value, p2 = $('#set-pass2').value;
    if (p1 || p2) {
      if (p1 !== p2) { alert('Пароли не совпадают.'); return; }
      if (p1.length < 4) { alert('Пароль должен быть не короче 4 символов.'); return; }
      settings.passwordHash = C.hashString(p1);
    }
    S.saveSettings(settings);
    settings = S.loadSettings();
    alert('Настройки сохранены.');
    render();
  }

  // ---------- пароль ----------

  function openPasswordModal() {
    $('#pass-input').value = '';
    $('#pass-error').style.display = 'none';
    $('#pass-hint').style.display =
      settings.passwordHash === C.hashString('1234') ? '' : 'none';
    $('#modal-pass').classList.add('open');
    setTimeout(function () { $('#pass-input').focus(); }, 50);
  }

  function checkPassword() {
    var v = $('#pass-input').value;
    if (C.hashString(v) === settings.passwordHash) {
      settingsUnlocked = true;
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
    try {
      new Notification('Выплаты метапелю — ' + settings.workerName, {
        body: 'Требуют внимания: ' + due.length + ' ' +
          C.plural(due.length, 'платёж', 'платежа', 'платежей') +
          ' на ' + C.fmtMoney(due.reduce(function (s, o) { return s + o.amount; }, 0)),
        tag: 'metapel-daily'
      });
      S.setMeta('lastNotify', t);
    } catch (e) { /* file:// или браузер без поддержки — игнорируем */ }
  }

  // ---------- модальные окна и события ----------

  function closeModals() {
    document.querySelectorAll('.modal').forEach(function (m) { m.classList.remove('open'); });
    currentPay = null;
  }

  function init() {
    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () {
        activeTab = b.dataset.tab;
        settingsUnlocked = false; // выходим из настроек — снова под паролем
        render();
      });
    });
    $('#btn-settings').addEventListener('click', function () {
      activeTab = 'settings';
      render();
    });
    $('#btn-notify').addEventListener('click', function () {
      Notification.requestPermission().then(function (perm) {
        if (perm === 'granted') {
          try {
            new Notification('Напоминания включены ✓', {
              body: 'Когда подойдёт срок платежа, появится такое уведомление.'
            });
          } catch (e) { /* некоторые браузеры требуют Service Worker — не критично */ }
        } else if (perm === 'denied') {
          alert('Уведомления запрещены в браузере.\nРазрешите их в настройках сайта (значок замка возле адреса).');
        }
        render();
      });
    });
    $('#pay-sats').addEventListener('input', recalcSalaryAmount);
    $('#pay-sats-minus').addEventListener('click', function () { stepSats(-1); });
    $('#pay-sats-plus').addEventListener('click', function () { stepSats(1); });
    $('#pay-amount').addEventListener('input', updatePayBig);
    $('#pay-confirm').addEventListener('click', confirmPay);
    $('#pass-confirm').addEventListener('click', checkPassword);
    $('#pass-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') checkPassword();
    });
    document.querySelectorAll('.modal-close').forEach(function (b) {
      b.addEventListener('click', closeModals);
    });
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target === m) closeModals();
      });
    });
    // если страница остаётся открытой — перерисовка при смене даты
    var lastDay = realToday();
    setInterval(function () {
      if (realToday() !== lastDay) {
        lastDay = realToday();
        render();
      }
    }, 60 * 1000);
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
