# BTL Timesheets — Stage 1 Implementation Plan (section + upload + sync + statuses + badge)

> **For agentic workers:** implement task-by-task; steps use checkbox (`- [ ]`) syntax for tracking. This is Stage 1 of 3 (see spec `docs/specs/2026-06-20-btl-timesheet-signing-design.md`). Stages 2 (signing) and 3 (download/sent/polish) are deferred to their own plans after Stage 1 ships + a PDF-parsing spike.

**Goal:** Add a «Табели» tab where the family uploads a Matav PDF timesheet; the file is stored in the `metapel-data` repo, its lightweight metadata syncs across all devices, the list shows a status per file, and a red badge counts fully-signed-but-unsent timesheets. No signing yet (Stage 2).

**Architecture:** Reuse the existing patterns exactly. Timesheet metadata lives in a new `timesheets[]` array inside the synced `backup/data.json` (alongside `log`/`extras`/`returns`). The PDF bytes live as `timesheets/<id>.json` files in `metapel-data` (same mechanism as `receipts/<id>.json`), fetched on demand — never kept in `localStorage`. Status is a pure function of boolean flags. A new tab renders the list.

**Tech Stack:** Vanilla ES5 (no build), GitHub Pages, GitHub Contents API, existing service worker + sync. Tests: `tests/test.html` (pure `eq()` assertions, run by opening in browser) + browser-mock checks via DevTools `evaluate_script` for storage/sync/UI.

**Environment notes (read once):**
- Two environments share one repo: prod at `/metapel/`, stage at `/metapel/stage/`. `js/env.js` (`window.MetapelEnv`) detects which by path. **Edit root files, then copy to `stage/`.** `MetapelEnv.dataPrefix` is `''` (prod) / `'stage/'` (stage) — all repo paths must use it.
- Deploy = `git push` (deploys both folders). Bump `APP_VERSION` (js/app.js) and `CACHE` (sw.js) every deploy.
- Commit author: `git -c user.name="eliduc" -c user.email="levrlg@gmail.com" commit`. Co-author line: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Run tests: open `file:///C:/work/Sandbox/PaymentToMetapel/tests/test.html`; the page `<title>` shows `PASS N/N`. Current baseline: **121/121**.

---

## File structure (what changes)

- `js/calc.js` — add pure `timesheetStatus(rec)` (engine, unit-tested). One responsibility: derive status key from flags.
- `js/storage.js` — add timesheet CRUD (`loadTimesheets`/`addTimesheet`/`updateTimesheet`/`deleteTimesheet`); include `timesheets` in `replaceData`.
- `js/sync.js` — include `timesheets` in `buildBackupObject` and `localSupersedesCloud`; add `putTimesheetFile`/`fetchTimesheetFile`; include `timesheets` in `pullIfNewer`'s `replaceData`.
- `tests/test.html` — add `timesheetStatus` + `localSupersedesCloud`(timesheets) cases.
- `index.html` — add 5th `nav` tab + hidden `<input type=file>` for upload.
- `css/styles.css` — status-chip styles.
- `js/app.js` — render routing, `renderTimesheets`, upload handler, badge in `renderNav`, `reloadData` includes timesheets, `APP_VERSION` bump.
- `sw.js` — `CACHE` bump.
- `stage/*` — copy of the above.

---

## Task 1: Pure status function `timesheetStatus`

**Files:**
- Modify: `js/calc.js` (add function + export in the returned object)
- Test: `tests/test.html`

- [ ] **Step 1: Write failing tests** — add to `tests/test.html` just before the `// ---------- вывод ----------` block:

```javascript
    // ---------- табели: статус из флагов ----------
    function tss(rec) { return C.timesheetStatus(rec); }
    eq('timesheetStatus: пусто → unsigned', tss({}), 'unsigned');
    eq('timesheetStatus: подписал метапель → caregiver', tss({ caregiverSigned: true }), 'caregiver');
    eq('timesheetStatus: подписала семья → family', tss({ familySigned: true }), 'family');
    eq('timesheetStatus: оба → full', tss({ caregiverSigned: true, familySigned: true }), 'full');
    eq('timesheetStatus: отослано перекрывает → sent', tss({ caregiverSigned: true, familySigned: true, sentMarked: true }), 'sent');
    eq('timesheetStatus: sent даже без подписей (защитно) → sent', tss({ sentMarked: true }), 'sent');
```

- [ ] **Step 2: Run to verify it fails** — open `tests/test.html` in the browser. Expected: title shows `FAIL` and a red row "C.timesheetStatus is not a function" (or the new rows fail). Total count attempted = 127.

- [ ] **Step 3: Implement** — in `js/calc.js`, add this function near the other small helpers (e.g. right after `hashString`):

```javascript
  // статус табеля Битуах Леуми из флагов (чистая функция)
  function timesheetStatus(rec) {
    if (rec && rec.sentMarked) return 'sent';
    if (rec && rec.caregiverSigned && rec.familySigned) return 'full';
    if (rec && rec.caregiverSigned) return 'caregiver';
    if (rec && rec.familySigned) return 'family';
    return 'unsigned';
  }
```

  Then add `timesheetStatus: timesheetStatus,` to the object returned by the `MetapelCalc` IIFE (next to `hashString`).

- [ ] **Step 4: Run to verify pass** — reload `tests/test.html`. Expected: title `PASS 127/127`.

- [ ] **Step 5: Commit**

```bash
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" add js/calc.js tests/test.html
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" commit -m "Add timesheetStatus pure function + tests" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Storage CRUD for timesheets

**Files:**
- Modify: `js/storage.js` (add functions, export them, include in `replaceData`)
- Test: browser-mock via DevTools (storage.js touches `localStorage`, not loaded by test.html)

- [ ] **Step 1: Implement CRUD** — in `js/storage.js`, add after the returns block (`deleteReturn`):

```javascript
  // ---------- табели Битуах Леуми (метаданные; сами PDF — в репо) ----------

  function loadTimesheets() {
    return loadRaw().timesheets || [];
  }

  function addTimesheet(rec) {
    var raw = loadRaw();
    raw.timesheets = (raw.timesheets || []).concat([rec]);
    saveRaw(raw);
  }

  function updateTimesheet(id, patch) {
    var raw = loadRaw();
    (raw.timesheets || []).forEach(function (t) {
      if (t.id === id) { for (var k in patch) if (patch.hasOwnProperty(k)) t[k] = patch[k]; }
    });
    saveRaw(raw);
  }

  function deleteTimesheet(id) {
    var raw = loadRaw();
    raw.timesheets = (raw.timesheets || []).filter(function (t) { return t.id !== id; });
    raw.syncQueue = (raw.syncQueue || []).filter(function (q) { return q.id !== id; });
    saveRaw(raw);
  }
```

- [ ] **Step 2: Export + include in replaceData** — in `js/storage.js`:
  1. Add `if (parts.timesheets) raw.timesheets = parts.timesheets;` inside `replaceData` (after the `returns` line).
  2. Add to the returned object: `loadTimesheets: loadTimesheets, addTimesheet: addTimesheet, updateTimesheet: updateTimesheet, deleteTimesheet: deleteTimesheet,`

- [ ] **Step 3: Browser-mock test** — open `file:///C:/work/Sandbox/PaymentToMetapel/index.html`, then via DevTools `evaluate_script` run:

```javascript
() => {
  const S = window.MetapelStore;
  localStorage.removeItem('metapel-app-v1');
  S.addTimesheet({ id: 'ts-1', month: '2026-06', caregiverSigned: false, familySigned: false, sentMarked: false });
  S.updateTimesheet('ts-1', { caregiverSigned: true });
  const a = S.loadTimesheets();
  S.replaceData({ timesheets: [{ id: 'ts-9', month: '2026-07' }] });
  const b = S.loadTimesheets();
  S.deleteTimesheet('ts-9');
  const c = S.loadTimesheets();
  localStorage.removeItem('metapel-app-v1');
  return { added: a.length === 1 && a[0].caregiverSigned === true, replaced: b.length === 1 && b[0].id === 'ts-9', deleted: c.length === 0 };
}
```

  Expected: `{ added: true, replaced: true, deleted: true }`.

- [ ] **Step 4: Commit**

```bash
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" add js/storage.js
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" commit -m "Add timesheet CRUD to storage + replaceData support" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Include timesheets in sync (backup + supersede + pull)

**Files:**
- Modify: `js/sync.js`
- Test: `tests/test.html` (localSupersedesCloud is pure + exported)

- [ ] **Step 1: Write failing tests** — add to `tests/test.html` after the existing `localSupersedesCloud` cases. Note the new 5th argument `localTimesheets`:

```javascript
    eq('superset: облачный табель есть локально → true',
      ls({ timesheets: [{ id: 't1' }] }, {}, [], [], [{ id: 't1' }]), true);
    eq('superset: облачного табеля нет локально → false',
      ls({ timesheets: [{ id: 't1' }] }, {}, [], [], []), false);
    eq('superset: лишний локальный табель (удалён в облаке) → false',
      ls({ timesheets: [] }, {}, [], [], [{ id: 't1' }]), false);
```

  And update the helper `ls` at the top of that block to pass the 5th arg through:

```javascript
    function ls(cloud, log, extras, returns, timesheets) { return Sync.localSupersedesCloud(cloud, log, extras, returns, timesheets || []); }
```

- [ ] **Step 2: Run to verify fail** — reload `tests/test.html`. Expected: title `FAIL`; new timesheet superset rows fail (function ignores 5th arg / `cloud.timesheets` undefined handling).

- [ ] **Step 3: Implement** — three edits in `js/sync.js`:

  3a. `buildBackupObject` (add the field to the returned object, after `returns`):

```javascript
      returns: store.loadReturns(),
      timesheets: store.loadTimesheets()
```

  3b. `localSupersedesCloud` — change signature and add the timesheets block. Replace the function signature line and add the block before `return true;`:

```javascript
  function localSupersedesCloud(cloud, localLog, localExtras, localReturns, localTimesheets) {
```

  and just before `return true;`:

```javascript
    var ct = (cloud && cloud.timesheets) || [];
    if (ct.length !== (localTimesheets || []).length) return false;
    for (var p = 0; p < ct.length; p++) {
      var okt = false;
      for (var q = 0; q < localTimesheets.length; q++) if (localTimesheets[q].id === ct[p].id) { okt = true; break; }
      if (!okt) return false;
    }
```

  3c. Update the call site in `backupIfChanged` to pass timesheets:

```javascript
      if (cloud && cloudGen > localGen &&
          !localSupersedesCloud(cloud, store.loadLog(), store.loadExtras(), store.loadReturns(), store.loadTimesheets())) {
```

  3d. `pullIfNewer` — include timesheets in the `replaceData` call:

```javascript
      store.replaceData({ log: cloud.log || {}, extras: cloud.extras || [], returns: cloud.returns || [], timesheets: cloud.timesheets || [] });
```

- [ ] **Step 4: Run to verify pass** — reload `tests/test.html`. Expected: title `PASS 130/130`.

- [ ] **Step 5: Commit**

```bash
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" add js/sync.js tests/test.html
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" commit -m "Sync timesheets[]: backup + localSupersedesCloud + pull (with tests)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Timesheet PDF file upload/fetch in sync.js

**Files:**
- Modify: `js/sync.js` (add `putTimesheetFile`, `fetchTimesheetFile`, export them)
- Test: browser-mock (mocked `fetch`)

- [ ] **Step 1: Implement** — in `js/sync.js`, add after `fetchReceipt`:

```javascript
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
```

  `putFile` (legacy mode, `casSha` undefined) re-fetches the sha and overwrites — correct for these per-file writes. Add to the returned object: `putTimesheetFile: putTimesheetFile, fetchTimesheetFile: fetchTimesheetFile,`.

- [ ] **Step 2: Browser-mock test** — open `index.html`, via `evaluate_script`:

```javascript
async () => {
  const Sync = window.MetapelSync, C = window.MetapelCalc;
  const settings = C.defaultSettings();
  settings.sync = { enabled: true, repo: 'eliduc/metapel-data', token: 'FAKE' };
  let putUrl = null, putBody = null;
  const realFetch = window.fetch;
  window.fetch = (url, opts) => {
    const u = String(url), method = (opts && opts.method) || 'GET';
    if (u.indexOf('timesheets/ts-1.json') !== -1) {
      if (method === 'GET' && (!opts || opts.method === undefined)) {
        const obj = { pdf: 'data:application/pdf;base64,AAAA', fileName: 'f.pdf', month: '2026-06' };
        const content = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ content, sha: 'S' }) });
      }
      if (method === 'PUT') { putUrl = u; putBody = JSON.parse(opts.body); return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) }); }
    }
    return realFetch(url, opts);
  };
  const got = await Sync.fetchTimesheetFile(settings, 'ts-1', '');
  await Sync.putTimesheetFile(settings, 'ts-1', '', { pdf: 'data:application/pdf;base64,BBBB', fileName: 'f.pdf', month: '2026-06' });
  window.fetch = realFetch;
  return { fetched: got && got.month === '2026-06', putHitPath: /timesheets\/ts-1\.json/.test(putUrl || ''), putContentB64: !!(putBody && putBody.content) };
}
```

  Expected: `{ fetched: true, putHitPath: true, putContentB64: true }`.

- [ ] **Step 3: Commit**

```bash
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" add js/sync.js
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" commit -m "Add putTimesheetFile/fetchTimesheetFile (repo storage for timesheet PDFs)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: «Табели» tab, render routing, reloadData, status chips CSS

**Files:**
- Modify: `index.html` (nav), `js/app.js` (routing, `reloadData`, render stub, badge), `css/styles.css` (chips)

- [ ] **Step 1: Add the 5th nav tab** — in `index.html`, inside `<nav>`, after the «Под отчёт» button:

```html
      <button class="tab" data-tab="timesheets">📋 Табели<span id="badge-timesheets" style="display:none">0</span></button>
```

- [ ] **Step 2: Routing + reloadData + module var** — in `js/app.js`:
  1. Find the module data vars (`var log = ...; var extras = ...; var returns = ...`). Add `var timesheets = [];` alongside.
  2. In `reloadData()`, add `timesheets = S.loadTimesheets();`.
  3. In `render()`, add the branch: `else if (activeTab === 'timesheets') renderTimesheets(content);`

- [ ] **Step 3: Badge in renderNav** — in `js/app.js` `renderNav`, after the existing `#badge-advance` block, add:

```javascript
    // бейдж табелей: полностью подписанные, но не отмеченные «Отослано»
    var tsCount = timesheets.filter(function (t) {
      return C.timesheetStatus(t) === 'full';
    }).length;
    var badgeT = $('#badge-timesheets');
    if (badgeT) { badgeT.textContent = tsCount; badgeT.style.display = tsCount ? '' : 'none'; }
```

  (Style `#badge-timesheets` like `#badge-due`: add `#badge-timesheets` to the existing `#badge-due { ... }` selector in `css/styles.css`.)

- [ ] **Step 4: Status-chip CSS** — in `css/styles.css`, add:

```css
.ts-chip { display:inline-block; border-radius: 8px; padding: 3px 10px; font-size: 16px; font-weight: 600; }
.ts-unsigned { background: #f1f5f9; color: var(--muted); }
.ts-caregiver, .ts-family { background: #fef3c7; color: var(--amber); }
.ts-full { background: #dcfce7; color: var(--green); }
.ts-sent { background: #dbeafe; color: var(--accent); }
```

- [ ] **Step 5: Render stub** — in `js/app.js`, add a minimal `renderTimesheets` (full list comes in Step 6, but commit a working stub first so routing is testable):

```javascript
  function renderTimesheets(content) {
    content.appendChild(el('div', 'summary', 'Табели Битуах Леуми: ' + timesheets.length));
  }
```

- [ ] **Step 6: Browser check** — open `index.html`; click the «Табели» tab; expect the summary line and no console errors. Verify `document.querySelector('.tab[data-tab="timesheets"]')` exists.

- [ ] **Step 7: Commit**

```bash
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" add index.html js/app.js css/styles.css
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" commit -m "Add Табели tab + routing + badge + status-chip CSS (stub render)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Upload + full list render

**Files:**
- Modify: `index.html` (hidden file input), `js/app.js` (`renderTimesheets` full, upload handler, label map)

- [ ] **Step 1: Hidden file input** — in `index.html`, just before the closing `</div>` of `.wrap` (or near other inputs), add:

```html
  <input type="file" id="ts-file-input" accept="application/pdf" style="display:none">
```

- [ ] **Step 2: Status label/class maps** — in `js/app.js`, near `renderTimesheets`, add:

```javascript
  var TS_LABELS = { unsigned: 'не подписан', caregiver: 'подписан метапелем', family: 'подписан Григорием', full: 'полностью подписан', sent: 'отослано' };
```

- [ ] **Step 3: Full renderTimesheets** — replace the stub with:

```javascript
  function renderTimesheets(content) {
    var btnUp = el('button', 'btn btn-extra', '⬆ Загрузить табель (PDF)');
    btnUp.addEventListener('click', function () { $('#ts-file-input').click(); });
    content.appendChild(btnUp);

    if (!timesheets.length) {
      content.appendChild(el('div', 'empty', 'Табелей пока нет. Загрузите присланный Матав PDF.'));
      return;
    }
    timesheets.slice().sort(function (a, b) { return a.month < b.month ? 1 : -1; }).forEach(function (t) {
      var card = el('div', 'card paid-card');
      var head = el('div', 'card-head');
      var left = el('div', 'card-left');
      left.appendChild(el('div', 'card-title', '📋 Табель ' + esc(t.month)));
      left.appendChild(el('div', 'card-due', 'загружен ' + C.fmtDate(t.uploadedDate)));
      head.appendChild(left);
      var st = C.timesheetStatus(t);
      head.appendChild(el('div', 'ts-chip ts-' + st, TS_LABELS[st]));
      card.appendChild(head);
      content.appendChild(card);
    });
  }
```

  (Signing buttons / download / «Отослано» come in Stage 2–3.)

- [ ] **Step 4: Upload handler** — in `js/app.js` `init()`, add:

```javascript
    $('#ts-file-input').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = ''; // позволить повторный выбор того же файла
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var id = 'ts-' + Date.now();
        var month = C.parseISO(today()).getFullYear() + '-' +
          ('0' + (C.parseISO(today()).getMonth() + 1)).slice(-2);
        var rec = { id: id, month: month, fileName: file.name, uploadedDate: today(),
          caregiverSigned: false, caregiverSignedDate: null, familySigned: false,
          familySignedDate: null, sentMarked: false, sentDate: null };
        S.addTimesheet(rec);
        reloadData();
        render();
        showToast('✓ Табель загружен');
        if (window.MetapelSync.isOn(settings)) {
          window.MetapelSync.putTimesheetFile(settings, id, '', {
            pdf: reader.result, fileName: file.name, month: month
          }).then(function () { runSync(); }).catch(function (err) {
            appAlert('Файл сохранён локально, но не залился в архив: ' + (err && err.message || err));
          });
        }
      };
      reader.readAsDataURL(file);
    });
```

  Note: the `month` here defaults to the current month. Stage 2 will parse the real month from the PDF; for Stage 1 this is acceptable (user uploads the current month's form). If a different month is needed, it can be corrected in Stage 2.

- [ ] **Step 5: Browser check (mocked sync off)** — open `index.html`. Default settings have sync off, so upload stays local. Click «Табели» → «Загрузить табель», pick any PDF. Expect: a card appears with status chip «не подписан»; toast; no console error. Reload the page → the card persists (localStorage). Then via `evaluate_script` confirm `MetapelStore.loadTimesheets().length === 1`. Clean up: `localStorage.removeItem('metapel-app-v1')`.

- [ ] **Step 6: Commit**

```bash
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" add index.html js/app.js
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" commit -m "Табели: upload PDF + list render with status chips" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Version bump, copy to stage, deploy to staging, verify

**Files:**
- Modify: `js/app.js` (`APP_VERSION`), `sw.js` (`CACHE`), copy all changed files to `stage/`

- [ ] **Step 1: Bump version** — `js/app.js`: set `var APP_VERSION = '4.0 от <today> (Табели, этап 1)';`. `sw.js`: bump `'v23'` → `'v24'`.

- [ ] **Step 2: Run full test suite** — open `tests/test.html`. Expected `PASS 130/130`.

- [ ] **Step 3: Copy to stage** — PowerShell:

```powershell
$src = "C:\work\Sandbox\PaymentToMetapel"; $dst = "$src\stage"
Copy-Item "$src\index.html" $dst -Force
Copy-Item "$src\sw.js" $dst -Force
Copy-Item "$src\css\styles.css" "$dst\css\" -Force
Copy-Item "$src\js\*.js" "$dst\js\" -Force
```

- [ ] **Step 4: Commit + push**

```bash
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" add -A
git -c user.name="eliduc" -c user.email="levrlg@gmail.com" commit -m "Табели stage 1: upload+sync+statuses+badge. v4.0, sw v24." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 5: Verify live on STAGE** — wait for Pages, then in DevTools open `https://eliduc.github.io/metapel/stage/`. With the real token entered in stage settings, upload a test PDF on one browser, open stage on a second browser → the timesheet appears (synced). Confirm the «Табели» tab badge stays 0 (nothing fully-signed yet) and statuses show «не подписан». Confirm prod (`/metapel/`) also shows the new tab and behaves normally (sync of `timesheets[]` is backward-safe: old data has no `timesheets`, treated as `[]`).

---

## Self-review (done by plan author)

- **Spec coverage (Stage 1 portion):** tab + badge (Tasks 5,7) ✓; storage/sync of metadata (Tasks 2,3) ✓; PDF file in repo + on-demand fetch (Task 4) ✓; upload from iPad+laptop (Task 6) ✓; statuses (Tasks 1,6) ✓; multi-device visibility (Task 3 sync + Task 7 verify) ✓. Signing, download, «Отослано», preview, badge-of-unsent → Stages 2–3 (out of this plan, by design).
- **Placeholder scan:** every code step has complete ES5 code; test steps give exact assertions + expected `PASS N/N`. No TBD/TODO.
- **Type consistency:** record shape `{id, month, fileName, uploadedDate, caregiverSigned, caregiverSignedDate, familySigned, familySignedDate, sentMarked, sentDate}` is consistent across Tasks 1/2/6; `timesheetStatus` keys (`unsigned/caregiver/family/full/sent`) match `TS_LABELS` and the CSS `.ts-*` classes and the badge filter (`=== 'full'`); `localSupersedesCloud` 5-arg signature matches the updated call site and tests.
- **Known Stage-1 limitation (carried to Stage 2):** `month` is the current month on upload, not parsed from the PDF — acceptable for Stage 1, fixed in Stage 2.

## Next stages (separate plans, after Stage 1 ships)

- **Spike (before Stage 2):** load the real `2026.pdf` with pdf.js, dump text items + coordinates, identify anchors (`חתימת המטפלת`, `חתימה שבועית`, hours columns, bottom blocks). Output: a calibrated slot-extraction map. This unblocks writing Stage 2 with exact code.
- **Stage 2 plan:** vendor pdf.js + pdf-lib (`js/vendor/`, add to SW `SHELL`, lazy-load in section); slot extraction; «Подписать Метапелет»/«Подпись Григория» + «Все подписи» checkbox; auto-placement; preview; save signed PDF (`<id>-signed.json`); advance flags/status.
- **Stage 3 plan:** download signed PDF; «Отослано» checkbox; badge already counts `full` (extend to exclude `sent`); manual position-adjust fallback; polish.
