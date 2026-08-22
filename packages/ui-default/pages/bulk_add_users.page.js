import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, request } from 'vj/utils';

/**
 * Root-only homepage feature: the "Add Users" button (which replaces the
 * Hitokoto card for root) opens a modal that
 *  1. accepts a CSV / XLS / XLSX file whose first four header columns are
 *     fixed: Last Name, First Name, Username, Availability;
 *  2. previews the parsed users;
 *  3. lets root pick one or MORE (domain, role) assignments;
 *  4. on OK, bulk-creates the accounts server-side — password
 *     `Username_LastName_FirstName` — and joins every user (new or existing)
 *     into every chosen domain with the chosen role.
 *
 * CSV parses natively (works offline). XLS/XLSX loads SheetJS from cdnjs on
 * demand; if the CDN is unreachable, the modal says so and suggests CSV.
 */

const EXPECTED_HEADERS = ['last name', 'first name', 'username', 'last access', 'availability'];
const FALSY_AVAILABILITY = ['', '0', 'false', 'no', 'n', 'unavailable', 'inactive', 'off'];

const STYLE = [
  '.bau-mask { position: fixed; inset: 0; z-index: 3300; background: rgba(10,14,22,.5); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; padding: 20px; animation: ptaFadeIn .2s ease-out; }',
  '.bau { background: var(--pta-card); color: var(--pta-ink); border-radius: var(--pta-radius-lg); width: 760px; max-width: 96vw; max-height: 92vh; display: flex; flex-direction: column; box-shadow: var(--pta-shadow-pop); overflow: hidden; animation: ptaPopIn .3s var(--pta-ease); }',
  '.bau-mask--closing { transition: opacity .18s ease; opacity: 0; pointer-events: none; }',
  '.bau-mask--closing .bau { transition: transform .18s ease, opacity .18s ease; transform: translateY(12px) scale(.97); opacity: 0; }',
  '.bau__head { display: flex; align-items: center; justify-content: space-between; padding: 13px 20px; border-bottom: 2px solid var(--pta-line); flex: 0 0 auto; }',
  '.bau__title { color: var(--pta-blue-text); font-size: 17px; font-weight: bold; }',
  '.bau__close { border: none; background: transparent; font-size: 20px; color: var(--pta-ink-faint); cursor: pointer; padding: 2px 8px; border-radius: 6px; line-height: 1; transition: background .15s ease, color .15s ease; }',
  '.bau__close:hover { background: var(--pta-card-3); color: var(--pta-ink); }',
  '.bau__body { padding: 16px 20px; overflow-y: auto; font-size: 13.5px; scrollbar-width: thin; }',
  '.bau__sect { border: 1px solid var(--pta-line); border-radius: 12px; margin-bottom: 14px; overflow: hidden; animation: ptaFadeUp .26s var(--pta-ease) backwards; }',
  '.bau__sect:nth-of-type(2) { animation-delay: .05s; }',
  '.bau__sect:nth-of-type(3) { animation-delay: .1s; }',
  '.bau__secthead { background: linear-gradient(180deg, var(--pta-card-2), var(--pta-card-3)); padding: 8px 14px; font-weight: bold; font-size: 13.5px; color: var(--pta-ink); border-bottom: 1px solid var(--pta-line); }',
  '.bau__sectbody { padding: 12px 14px; }',
  '.bau__hint { color: var(--pta-ink-faint); font-size: 12.5px; margin: 6px 0 0; }',
  '.bau__error { color: var(--pta-bad-text); font-weight: bold; margin: 6px 0 0; }',
  '.bau__table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }',
  '.bau__table th { color: var(--pta-ink-faint); font-weight: normal; text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--pta-line); }',
  '.bau__table td { padding: 5px 8px; border-bottom: 1px solid var(--pta-line-soft); color: var(--pta-ink); }',
  '.bau__table tbody tr { transition: background .12s ease; }',
  '.bau__table tbody tr:hover { background: var(--pta-blue-soft); }',
  '.bau__badge { display: inline-block; border-radius: 999px; padding: 0 8px; font-size: 11px; background: var(--pta-ok-soft); color: var(--pta-ok-text); }',
  '.bau__badge.off { background: var(--pta-card-3); color: var(--pta-ink-faint); }',
  '.bau__assign { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }',
  '.bau__assign select { flex: 1 1 auto; min-width: 0; padding: 5px 8px; border: 1px solid var(--pta-line); border-radius: 8px; background: var(--pta-card); color: var(--pta-ink); font-size: 13px; transition: border-color .15s ease, box-shadow .15s ease; }',
  '.bau__assign select:focus { outline: none; border-color: var(--pta-primary); box-shadow: var(--pta-ring); }',
  '.bau__assign button { border: 1px solid var(--pta-bad-line); background: var(--pta-card); color: var(--pta-bad-text); border-radius: 8px; cursor: pointer; padding: 4px 10px; transition: background .15s ease; }',
  '.bau__assign button:hover { background: var(--pta-bad-soft); }',
  '.bau__add { border: 1px dashed var(--pta-blue-line); background: var(--pta-blue-soft); color: var(--pta-blue-text); border-radius: 8px; cursor: pointer; padding: 5px 12px; font-size: 12.5px; transition: filter .15s ease, transform .15s var(--pta-ease); }',
  '.bau__add:hover { filter: brightness(1.04); transform: translateY(-1px); }',
  '.bau__foot { padding: 12px 20px; border-top: 1px solid var(--pta-line); display: flex; justify-content: flex-end; gap: 10px; flex: 0 0 auto; background: linear-gradient(180deg, var(--pta-card), var(--pta-card-2)); }',
  '.bau__result h3 { font-size: 14px; margin: 10px 0 4px; }',
  '.bau__names { color: var(--pta-ink-soft); word-break: break-word; }',
  '.bau__pw { background: var(--pta-gold-soft); border: 1px solid var(--pta-gold-line); border-radius: 8px; padding: 8px 10px; margin-top: 10px; font-size: 12.5px; color: var(--pta-gold-text); }',
].join('\n');

function esc(text) {
  return $('<i>').text(String(text ?? '')).html();
}

/* --------------------------- spreadsheet parsing --------------------------- */

/** Small RFC-ish delimited-text parser: quotes, escaped quotes, CR/LF. */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      rows.push(row); row = [];
    } else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/**
 * Blackboard-style exports are often TAB-separated even when named .csv or
 * .xls — sniff the first line and pick whichever delimiter dominates.
 */
function parseCsv(text) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return parseDelimited(text, tabs > commas ? '\t' : ',');
}

let sheetJsPromise = null;
function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetJsPromise) {
    sheetJsPromise = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      el.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('SheetJS failed to initialize')));
      el.onerror = () => reject(new Error('Could not load the spreadsheet library (no internet access?). Please convert the file to CSV.'));
      document.head.appendChild(el);
    });
  }
  return sheetJsPromise;
}

async function parseFile(file) {
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
    return parseCsv(await file.text());
  }
  if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
    const XLSX = await loadSheetJs();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
      .filter((r) => (r || []).some((c) => String(c).trim() !== ''));
  }
  throw new Error(i18n('Unsupported file type. Please upload a .csv, .xls, or .xlsx file.'));
}

/** Header check + row mapping. Returns { users } or throws with a message. */
function mapRows(rows) {
  if (!rows.length) throw new Error(i18n('The file is empty.'));
  const head = (rows[0] || []).slice(0, 5).map((h) => String(h || '').trim().toLowerCase());
  for (let i = 0; i < 5; i++) {
    if (head[i] !== EXPECTED_HEADERS[i]) {
      throw new Error(`${i18n('Unexpected header row.')} ${i18n('The first five columns must be:')} `
        + `Last Name, First Name, Username, Last Access, Availability — ${i18n('found:')} ${(rows[0] || []).slice(0, 5).join(', ') || '(none)'}`);
    }
  }
  const users = rows.slice(1).map((r) => ({
    lastName: String(r[0] ?? '').trim(),
    firstName: String(r[1] ?? '').trim(),
    uname: String(r[2] ?? '').trim(),
    lastAccess: String(r[3] ?? '').trim(), // informational only; the server ignores it
    availability: String(r[4] ?? '').trim(),
  })).filter((u) => u.uname || u.lastName || u.firstName);
  if (!users.length) throw new Error(i18n('No user rows found under the header.'));
  return users;
}

const isAvailable = (v) => !FALSY_AVAILABILITY.includes(String(v ?? '').trim().toLowerCase());

/* --------------------------------- modal --------------------------------- */

function openModal() {
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
  if (!document.getElementById('bau-style')) {
    $('<style>').attr('id', 'bau-style').text(STYLE).appendTo(document.head);
  }
  let users = null; // parsed rows
  let domains = []; // [{_id, name, roles:[]}] from the backend
  const assignments = []; // [{domainId, role}]

  const $mask = $('<div class="bau-mask"></div>').appendTo(document.body);
  const $modal = $(`<div class="bau" role="dialog" aria-label="${esc(i18n('Add Users'))}">`
    + `<div class="bau__head"><span class="bau__title">${esc(i18n('Add Users'))}</span>`
    + `<button type="button" class="bau__close" title="${esc(i18n('Close'))}">×</button></div>`
    + '<div class="bau__body">'
    + `<div class="bau__sect"><div class="bau__secthead">1. ${esc(i18n('Upload the user list'))}</div>`
    + '<div class="bau__sectbody">'
    + '<input type="file" id="bau-file" accept=".csv,.tsv,.txt,.xls,.xlsx" />'
    + `<p class="bau__hint">${esc(i18n('The first five columns of the header row must be exactly:'))} `
    + '<code>Last Name</code>, <code>First Name</code>, <code>Username</code>, <code>Last Access</code>, <code>Availability</code>.</p>'
    + '<div id="bau-parse-out"></div>'
    + '</div></div>'
    + `<div class="bau__sect"><div class="bau__secthead">2. ${esc(i18n('Domain access and role'))}</div>`
    + '<div class="bau__sectbody">'
    + `<p class="bau__hint" style="margin:0 0 8px">${esc(i18n('Every listed user will be added to every domain below with the chosen role. Add more rows for multi-domain access.'))}</p>`
    + '<div id="bau-assigns"></div>'
    + `<button type="button" class="bau__add" id="bau-add-assign">+ ${esc(i18n('Add domain'))}</button>`
    + '</div></div>'
    + '<div id="bau-result"></div>'
    + '</div>'
    + `<div class="bau__foot"><button type="button" class="rounded button bau__cancel">${esc(i18n('Cancel'))}</button>`
    + `<button type="button" class="rounded primary button bau__ok" disabled>${esc(i18n('OK'))}</button></div>`
    + '</div>').appendTo($mask);

  const $ok = $modal.find('.bau__ok');
  const $parseOut = $modal.find('#bau-parse-out');
  const $assigns = $modal.find('#bau-assigns');

  const close = () => {
    $(document).off('keydown.bau');
    $mask.addClass('bau-mask--closing');
    setTimeout(() => $mask.remove(), 190);
  };
  $modal.find('.bau__close, .bau__cancel').on('click', close);
  $(document).on('keydown.bau', (ev) => {
    if (ev.key === 'Escape') close();
  });

  const refreshOk = () => {
    $ok.prop('disabled', !(users && users.length && assignments.length));
  };

  const renderAssignments = () => {
    $assigns.empty();
    assignments.forEach((a, idx) => {
      const $row = $('<div class="bau__assign"></div>');
      const $dom = $('<select></select>');
      for (const d of domains) {
        $dom.append(`<option value="${esc(d._id)}"${d._id === a.domainId ? ' selected' : ''}>${esc(d.name)} (${esc(d._id)})</option>`);
      }
      const roles = (domains.find((d) => d._id === a.domainId) || { roles: ['default'] }).roles;
      const $role = $('<select></select>');
      for (const r of roles) $role.append(`<option value="${esc(r)}"${r === a.role ? ' selected' : ''}>${esc(r)}</option>`);
      $dom.on('change', () => {
        a.domainId = $dom.val();
        a.role = 'default';
        renderAssignments();
      });
      $role.on('change', () => { a.role = $role.val(); });
      const $rm = $(`<button type="button" title="${esc(i18n('Remove'))}">×</button>`).on('click', () => {
        assignments.splice(idx, 1);
        renderAssignments();
        refreshOk();
      });
      $row.append($dom, $role, $rm).appendTo($assigns);
    });
    refreshOk();
  };

  // Domain list for the pickers.
  request.get('/bulk-add-users').then((res) => {
    domains = (res && res.domains) || [];
    if (!domains.length) {
      $assigns.html(`<p class="bau__error">${esc(i18n('No domains found.'))}</p>`);
      return;
    }
    const current = domains.find((d) => d._id === (window.UiContext && UiContext.domainId)) || domains[0];
    assignments.push({ domainId: current._id, role: 'default' });
    renderAssignments();
  }).catch((e) => {
    $assigns.html(`<p class="bau__error">${esc(e.message)}</p>`);
  });

  $modal.find('#bau-add-assign').on('click', () => {
    if (!domains.length) return;
    assignments.push({ domainId: domains[0]._id, role: 'default' });
    renderAssignments();
  });

  $modal.find('#bau-file').on('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    users = null;
    $parseOut.html(`<p class="bau__hint">${esc(i18n('Parsing...'))}</p>`);
    refreshOk();
    if (!file) { $parseOut.empty(); return; }
    try {
      users = mapRows(await parseFile(file));
      const avail = users.filter((u) => isAvailable(u.availability)).length;
      let html = `<p class="bau__hint" style="color:#25ad40;font-weight:bold">${esc(i18n('Parsed'))} ${users.length} `
        + `${esc(i18n('user(s)'))} — ${avail} ${esc(i18n('available'))}, ${users.length - avail} ${esc(i18n('will be skipped'))}.</p>`;
      html += `<table class="bau__table"><thead><tr><th>${esc(i18n('Username'))}</th><th>Last Name</th><th>First Name</th><th>Last Access</th><th>Availability</th></tr></thead><tbody>`;
      for (const u of users.slice(0, 8)) {
        html += `<tr><td>${esc(u.uname)}</td><td>${esc(u.lastName)}</td><td>${esc(u.firstName)}</td><td>${esc(u.lastAccess || '—')}</td>`
          + `<td><span class="bau__badge${isAvailable(u.availability) ? '' : ' off'}">${esc(u.availability || '—')}</span></td></tr>`;
      }
      html += '</tbody></table>';
      if (users.length > 8) html += `<p class="bau__hint">… ${users.length - 8} ${esc(i18n('more row(s)'))}</p>`;
      $parseOut.html(html);
    } catch (e) {
      users = null;
      $parseOut.html(`<p class="bau__error">${esc(e.message)}</p>`);
    }
    refreshOk();
  });

  $ok.on('click', async () => {
    if (!users || !users.length || !assignments.length) return;
    $ok.prop('disabled', true).text(i18n('Working...'));
    try {
      const res = await request.post('/bulk-add-users', {
        users: JSON.stringify(users),
        assignments: JSON.stringify(assignments),
      });
      const block = (title, arr) => (arr && arr.length
        ? `<h3>${esc(i18n(title))} (${arr.length})</h3><p class="bau__names">${arr.map(esc).join(', ')}</p>` : '');
      let html = `<div class="bau__sect bau__result"><div class="bau__secthead">3. ${esc(i18n('Result'))}</div><div class="bau__sectbody">`;
      html += block('Created', res.created);
      html += block('Already existed (added to domains)', res.existed);
      html += block('Skipped (unavailable)', res.skipped);
      if (res.errors && res.errors.length) {
        html += `<h3 style="color:#d9480f">${esc(i18n('Errors'))} (${res.errors.length})</h3>`
          + `<p class="bau__names">${res.errors.map((x) => `${esc(x.uname)}: ${esc(x.error)}`).join('<br>')}</p>`;
      }
      html += `<div class="bau__pw">🔑 ${esc(i18n('New accounts use the password format'))} `
        + '<code>Username_LastName_FirstName</code> — '
        + `${esc(i18n('e.g.'))} <code>22040929r_SHEN_Leming</code>. `
        + `${esc(i18n('Please ask users to change their password after the first login.'))}</div>`;
      html += '</div></div>';
      $modal.find('#bau-result').html(html);
      $ok.hide();
      $modal.find('.bau__cancel').text(i18n('Close'));
      Notification.success(i18n('Bulk user import finished.'));
    } catch (e) {
      Notification.error(e.message);
      $ok.prop('disabled', false).text(i18n('OK'));
    }
  });
}

export default new NamedPage('homepage', () => {
  const $btn = $('#bulk-add-users-btn');
  if (!$btn.length) return; // not root: the template rendered Hitokoto instead
  console.info('[pta-ui] bulk Add Users ready (root)');
  $btn.on('click', openModal);
});
