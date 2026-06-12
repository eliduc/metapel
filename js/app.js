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
  var extras = S.loadExtras();   // доп. платежи: подарки / под отчёт
  var returns = S.loadReturns(); // возвраты по отчёту (чеки, сдача)
  var activeTab = 'due';
  var settingsUnlocked = false;
  var currentPay = null;       // вхождение в диалоге оплаты
  var payMethod = 'transfer';  // выбранный способ в диалоге оплаты
  var currentSign = null;      // {type:'log'|'extra', id} — чья подпись ставится
  var extraKind = 'gift';      // тип в диалоге доп. платежа
  var extraMethod = 'cash';    // способ в диалоге доп. платежа

  function reloadData() {
    log = S.loadLog();
    extras = S.loadExtras();
    returns = S.loadReturns();
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
    if (activeTab === 'due') { renderDue(occ, content); extrasBlock(content); }
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

  // блок «выдать деньги» + баланс «под отчёт» (на вкладке «Платить»)
  function advanceBalance() {
    var given = extras.reduce(function (s, e) {
      return e.kind === 'advance' ? s + e.amount : s;
    }, 0);
    var back = returns.reduce(function (s, r) { return s + r.amount; }, 0);
    return C.round2(given - back);
  }

  function extrasBlock(content) {
    var bal = advanceBalance();
    if (bal !== 0) {
      var cardB = el('div', 'balance-card',
        '🧾 На руках у метапеля под отчёт: <b>' + C.fmtMoney(bal) + '</b>' +
        '<div class="hint">Выдано под отчёт минус возвраты (чеки, сдача)</div>');
      var rbtn = el('button', 'btn btn-return', '➖ ПРИНЯТЬ ОТЧЁТ (чеки / сдача)');
      rbtn.addEventListener('click', openReturnModal);
      cardB.appendChild(rbtn);
      content.appendChild(cardB);
    }
    var btn = el('button', 'btn btn-extra', '➕ ВЫДАТЬ ДЕНЬГИ — подарок или под отчёт');
    btn.addEventListener('click', openExtraModal);
    content.appendChild(btn);
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
    var line;
    if ((rec.method || 'transfer') === 'cash') {
      line = rec.signature
        ? '💵 Наличные · ✍ Расписка получена ✓'
        : (rec.kind === 'gift'
          ? '💵 Наличные · без расписки (для подарка не обязательна)'
          : '💵 Наличные · <span class="no-receipt">⚠ Нет расписки</span>');
    } else {
      line = '🏦 Перевод';
    }
    if (rec.signature && window.MetapelSync.isOn(settings)) {
      line += rec.synced
        ? '<div class="sync-badge">☁ Сохранена в архиве GitHub</div>'
        : '<div class="sync-badge">⏳ Ждёт отправки в архив</div>';
    }
    return line;
  }

  function renderHistory(content) {
    var items = [];
    Object.keys(log).forEach(function (id) {
      var r = log[id];
      items.push({ kind: 'scheduled', id: id, rec: r, date: r.paidDate });
    });
    extras.forEach(function (e) {
      items.push({ kind: 'extra', id: e.id, rec: e, date: e.date });
    });
    returns.forEach(function (r) {
      items.push({ kind: 'return', id: r.id, rec: r, date: r.date });
    });
    if (!items.length) {
      content.appendChild(el('div', 'empty', 'Оплаченных платежей пока нет.'));
      return;
    }
    items.sort(function (a, b) { return a.date < b.date ? 1 : -1; });

    var paidTotal = items.reduce(function (s, it) {
      if (it.kind === 'scheduled') return s + it.rec.paidAmount;
      if (it.kind === 'extra') return s + it.rec.amount;
      return s;
    }, 0);
    var returnedTotal = returns.reduce(function (s, r) { return s + r.amount; }, 0);
    content.appendChild(el('div', 'summary',
      'Всего выплачено: <b>' + C.fmtMoney(paidTotal) + '</b>' +
      (returnedTotal ? ' · возвращено по отчётам: <b>' + C.fmtMoney(returnedTotal) + '</b>' : '') +
      ' · записей: ' + items.length));

    items.forEach(function (it) {
      if (it.kind === 'return') {
        content.appendChild(returnCard(it.rec));
      } else {
        content.appendChild(historyCard(it));
      }
    });
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
    var btn = el('button', 'btn btn-undo', '↩ Отменить (нажали по ошибке)');
    btn.addEventListener('click', function () {
      if (confirm('Удалить возврат на ' + C.fmtMoney(r.amount) + '? Сумма вернётся в баланс «под отчёт».')) {
        S.deleteReturn(r.id);
        reloadData();
        render();
      }
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
      var img = el('img', 'sig-img');
      img.src = e.signature;
      img.alt = 'Подпись метапеля';
      div.appendChild(img);
    }
    var actions = el('div', 'card-actions');
    if ((e.method || 'transfer') === 'cash' && !e.signature) {
      var signLabel = e.kind === 'gift'
        ? '✍ Расписаться (по желанию)'
        : '✍ МЕТАПЕЛЬ ПОЛУЧИЛ — РАСПИСАТЬСЯ';
      var btnSign = el('button', 'btn btn-sign', signLabel);
      btnSign.addEventListener('click', function () {
        openSignModal(it.kind === 'scheduled' ? 'log' : 'extra', it.id);
      });
      actions.appendChild(btnSign);
    }
    var btn = el('button', 'btn btn-undo', '↩ Отменить (нажали по ошибке)');
    btn.addEventListener('click', function () {
      var q = it.kind === 'scheduled'
        ? 'Убрать отметку об оплате «' + e.title + '»? Платёж вернётся в напоминания.'
        : 'Удалить запись «' + e.title + '» на ' + C.fmtMoney(amount) + '?';
      if (confirm(q)) {
        if (it.kind === 'scheduled') S.unmarkPaid(it.id);
        else S.deleteExtra(it.id);
        reloadData();
        render();
      }
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
    payMethod = settings.types[o.type].defaultMethod || 'transfer';
    updateMethodButtons();
    updatePayBig();
    $('#modal-pay').classList.add('open');
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

  function openSignModal(targetType, id) {
    var target = { type: targetType, id: id };
    var r = signRecord(target);
    if (!r) return;
    currentSign = target;
    var what = 'наличными'; // обычный платёж
    if (r.kind === 'gift') what = 'в подарок';
    if (r.kind === 'advance') what = 'под отчёт';
    $('#sign-text').innerHTML = 'Я, <b>' + esc(settings.workerFullName || settings.workerName) +
      '</b>, получил ' + what + ' <b>' + C.fmtMoney(r.paidAmount != null ? r.paidAmount : r.amount) +
      '</b><br>' + esc(r.title) + (r.note ? ' (' + esc(r.note) + ')' : '') +
      ' · от: ' + esc(settings.employerFullName || settings.employerName) +
      ' · дата: ' + C.fmtDate(r.paidDate || r.date);
    $('#modal-sign').classList.add('open');
    setupSignCanvas();
  }

  function setupSignCanvas() {
    var canvas = $('#sign-canvas');
    // внутреннее разрешение по фактическому размеру на экране
    var rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(300, Math.round(rect.width));
    canvas.height = 240;
    signCtx = canvas.getContext('2d');
    signCtx.fillStyle = '#ffffff';
    signCtx.fillRect(0, 0, canvas.width, canvas.height);
    signCtx.strokeStyle = '#1e293b';
    signCtx.lineWidth = 3.5;
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
    if (!signInk) { alert('Сначала распишитесь пальцем в рамке.'); return; }
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
    runSync();
  }

  // Ставит в очередь все подписанные, но ещё не отправленные расписки
  // (в т.ч. подписанные до включения архива) и отправляет очередь.
  function runSync() {
    if (!window.MetapelSync.isOn(settings)) return;
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
    window.MetapelSync.processQueue(settings, S, null).then(function (sent) {
      if (sent > 0) {
        reloadData();
        render();
      }
    });
  }

  // ---------- дополнительные платежи (подарок / под отчёт) ----------

  function openExtraModal() {
    extraKind = 'gift';
    extraMethod = 'cash'; // доп. платежи по умолчанию наличными
    $('#extra-amount').value = '';
    $('#extra-date').value = today();
    $('#extra-note').value = '';
    updateExtraButtons();
    $('#modal-extra').classList.add('open');
  }

  function updateExtraButtons() {
    $('#extra-kind-gift').classList.toggle('active', extraKind === 'gift');
    $('#extra-kind-advance').classList.toggle('active', extraKind === 'advance');
    $('#extra-method-transfer').classList.toggle('active', extraMethod === 'transfer');
    $('#extra-method-cash').classList.toggle('active', extraMethod === 'cash');
    $('#extra-kind-hint').textContent = extraKind === 'gift'
      ? 'Подарок: отчёт не нужен, расписка по желанию (кнопка будет в «Оплачено»).'
      : 'Под отчёт: метапель отчитывается чеками или сдачей, сумма попадает в баланс.';
  }

  function confirmExtra() {
    var amount = parseFloat($('#extra-amount').value);
    var date = $('#extra-date').value;
    if (isNaN(amount) || amount <= 0) { alert('Укажите сумму.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('Укажите дату.'); return; }
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
    // под отчёт наличными — сразу расписка; подарок — по желанию
    if (extraMethod === 'cash' && rec.kind === 'advance') openSignModal('extra', rec.id);
  }

  function openReturnModal() {
    $('#return-amount').value = '';
    $('#return-date').value = today();
    $('#return-note').value = '';
    $('#modal-return').classList.add('open');
  }

  function confirmReturn() {
    var amount = parseFloat($('#return-amount').value);
    var date = $('#return-date').value;
    if (isNaN(amount) || amount <= 0) { alert('Укажите сумму.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { alert('Укажите дату.'); return; }
    S.addReturn({
      id: 'return-' + Date.now(),
      amount: C.round2(amount),
      date: date,
      note: $('#return-note').value.trim()
    });
    reloadData();
    closeModals();
    render();
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
        { path: 'startDate', label: 'Дата начала работы', type: 'date' }
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
        { path: 'types.insurance.amount', label: 'Сумма в месяц, ₪', type: 'number' },
        { path: 'types.insurance.dayOfMonth', label: 'День оплаты (число месяца)', type: 'number' },
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
        } else {
          input = el('input');
          input.type = f.type;
          if (f.type === 'number') input.step = 'any';
          input.value = getPath(settings, f.path);
        }
        input.id = fieldId;
        input.dataset.path = f.path;
        input.dataset.kind = f.type;
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
        // лишние пробелы при вставке (особенно токена) ломают доступ
        value = inp.value.trim();
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
    runSync(); // если включили архив — дослать накопившиеся расписки
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
    currentSign = null;
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
    $('#sign-clear').addEventListener('click', setupSignCanvas);
    $('#sign-later').addEventListener('click', closeModals);

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
    runSync(); // дослать расписки, не отправленные в прошлый раз
  }

  document.addEventListener('DOMContentLoaded', init);
})();
