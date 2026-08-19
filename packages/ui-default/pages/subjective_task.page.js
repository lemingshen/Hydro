import $ from 'jquery';
import Notification from 'vj/components/notification';
import { aiMarkdown } from 'vj/components/ai-report/pdf';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, request } from 'vj/utils';

/**
 * Subjective (project-level, teacher-graded) tasks — pid starting with 'S'.
 * Students: upload files + write a markdown report (autosaved on demand).
 * Teachers (problem owner / domain root): list every submission, read the
 * rendered report, download the files. No judge, no scratchpad, no records.
 */

const PROBLEM_PAGES = ['problem_detail', 'contest_detail_problem', 'homework_detail_problem'];

const STYLE = [
  '.sbt { border: 1px solid #e3e8f4; border-radius: 10px; margin: 14px 0; background: #fff; overflow: hidden; }',
  '.sbt__head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; background: linear-gradient(90deg, #845ef7, #b197fc); color: #fff; font-weight: bold; font-size: 13.5px; }',
  '.sbt__head .sbt__hint { font-weight: normal; font-size: 11.5px; opacity: .9; margin-left: auto; }',
  '.sbt__body { padding: 12px 14px; font-size: 13px; }',
  '.sbt__report { width: 100%; min-height: 180px; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; border: 1px solid #d5dbe7; border-radius: 6px; padding: 8px 10px; resize: vertical; box-sizing: border-box; }',
  '.sbt__preview { border: 1px dashed #cdb6f6; border-radius: 6px; padding: 10px 12px; background: #faf8ff; }',
  '.sbt__btns { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; align-items: center; }',
  '.sbt__btn { border: none; border-radius: 14px; padding: 5px 16px; font-size: 12.5px; color: #fff; cursor: pointer; background: linear-gradient(90deg, #845ef7, #9775fa); }',
  '.sbt__btn:hover { filter: brightness(1.07); }',
  '.sbt__btn:disabled { opacity: .6; cursor: default; }',
  '.sbt__btn--ghost { background: #fff; color: #845ef7; border: 1px solid #b197fc; }',
  '.sbt__files { margin-top: 12px; border-top: 1px solid #eef0f6; padding-top: 10px; }',
  '.sbt__file { display: flex; align-items: center; gap: 10px; padding: 5px 2px; border-bottom: 1px dashed #eef0f6; }',
  '.sbt__file a { color: #4c6ef5; text-decoration: none; }',
  '.sbt__file a:hover { text-decoration: underline; }',
  '.sbt__fmeta { color: #889; font-size: 11.5px; flex: 1 1 auto; text-align: right; }',
  '.sbt__del { border: none; background: transparent; color: #c2255c; cursor: pointer; font-size: 14px; padding: 0 4px; }',
  '.sbt__empty { color: #98a2ac; padding: 6px 2px; }',
  '.sbt__table { width: 100%; border-collapse: collapse; }',
  '.sbt__table th, .sbt__table td { border-bottom: 1px solid #eef0f6; text-align: left; padding: 6px 8px; font-size: 12.5px; }',
  '.sbt__view { background: #faf8ff; border: 1px solid #e6ddf7; border-radius: 8px; margin: 6px 0 12px; padding: 10px 12px; }',
  '.sbt__ts { color: #889; font-size: 11.5px; }',
  // dark theme
  '.pta-dark .sbt { background: #23272c; border-color: #333a41; }',
  '.pta-dark .sbt__body { color: #d5dade; }',
  '.pta-dark .sbt__report { background: #1e2227; border-color: #3a424b; color: #d5dade; }',
  '.pta-dark .sbt__preview { background: #262130; border-color: #5c4a8a; }',
  '.pta-dark .sbt__btn--ghost { background: #23272c; color: #b197fc; border-color: #6f5bb5; }',
  '.pta-dark .sbt__files { border-top-color: #333a41; }',
  '.pta-dark .sbt__file { border-bottom-color: #333a41; }',
  '.pta-dark .sbt__file a { color: #74a9f7; }',
  '.pta-dark .sbt__table th, .pta-dark .sbt__table td { border-bottom-color: #333a41; }',
  '.pta-dark .sbt__view { background: #262130; border-color: #4a3d6b; }',
].join('\n');

function esc(text) {
  return $('<i>').text(String(text ?? '')).html();
}

const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function baseUrl() {
  return `${window.location.pathname.split('?')[0]}/subjective`;
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('csrfToken', (window.UiContext || {}).csrfToken || '');
  fd.append('operation', 'upload');
  fd.append('file', file);
  const resp = await fetch(baseUrl(), { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((body.error && body.error.message) || `Upload failed (HTTP ${resp.status})`);
  return body;
}

function fileRows(files, { deletable, uid } = {}) {
  if (!files || !files.length) return `<div class="sbt__empty">${esc(i18n('No files uploaded yet.'))}</div>`;
  const uidQ = uid ? `&uid=${uid}` : '';
  return files.map((f) => '<div class="sbt__file">'
    + `<a href="${baseUrl()}/file?name=${encodeURIComponent(f.name)}${uidQ}" target="_blank" rel="noopener">📎 ${esc(f.name)}</a>`
    + `<span class="sbt__fmeta">${fmtSize(f.size)} · ${esc(fmtTs(f.uploadAt))}</span>`
    + (deletable ? `<button type="button" class="sbt__del" data-name="${esc(f.name)}" title="${esc(i18n('Delete'))}">×</button>` : '')
    + '</div>').join('');
}

function hideJudgeAffordances() {
  // Best-effort: subjective tasks have no code submission.
  $('[name="problem-sidebar__open-scratchpad"], [name="problem-sidebar__show-category"]').closest('li').hide();
  $('a[href$="/submit"]').closest('li').hide();
}

function anchorPoint() {
  const $stmt = $('[name="problem-description"]').closest('.section');
  if ($stmt.length) return $stmt;
  const $first = $('.medium-9 .section').first();
  if ($first.length) return $first;
  return $('.main').first();
}

function studentPanel($mount) {
  const $panel = $('<div class="sbt">'
    + `<div class="sbt__head">📁 ${esc(i18n('Project Submission'))}`
    + `<span class="sbt__hint">${esc(i18n('Graded by your teacher — no automatic judging.'))}</span></div>`
    + '<div class="sbt__body">'
    + `<textarea class="sbt__report" placeholder="${esc(i18n('Write your project report here (Markdown supported)...'))}"></textarea>`
    + '<div class="sbt__preview" style="display:none"></div>'
    + '<div class="sbt__btns">'
    + `<button type="button" class="sbt__btn sbt__save">💾 ${esc(i18n('Save Report'))}</button>`
    + `<button type="button" class="sbt__btn sbt__btn--ghost sbt__toggle">👁 ${esc(i18n('Preview'))}</button>`
    + '<span class="sbt__ts"></span></div>'
    + '<div class="sbt__files"><b>📎 ' + esc(i18n('Files')) + '</b>'
    + '<div class="sbt__list"></div>'
    + '<div class="sbt__btns"><input type="file" class="sbt__pick">'
    + `<button type="button" class="sbt__btn sbt__upload">⬆ ${esc(i18n('Upload'))}</button></div></div>`
    + '</div></div>');
  $mount.after($panel);
  const $report = $panel.find('.sbt__report');
  const $preview = $panel.find('.sbt__preview');
  const $ts = $panel.find('.sbt__ts');
  const $list = $panel.find('.sbt__list');

  const bindDeletes = () => $list.find('.sbt__del').on('click', async function onDel() {
    try {
      const res = await request.post(baseUrl(), { operation: 'delete', name: $(this).data('name') });
      $list.html(fileRows(res.files, { deletable: true }));
      bindDeletes();
    } catch (e) {
      Notification.error(e.message);
    }
  });

  request.get(baseUrl()).then((res) => {
    $report.val(res.report || '');
    $ts.text(res.updateAt ? `${i18n('Saved')}: ${fmtTs(res.updateAt)}` : '');
    $list.html(fileRows(res.files, { deletable: true }));
    bindDeletes();
  }).catch((e) => Notification.error(e.message));

  $panel.find('.sbt__save').on('click', async function onSave() {
    const $b = $(this).prop('disabled', true);
    try {
      const res = await request.post(baseUrl(), { operation: 'report', report: $report.val() });
      $ts.text(`${i18n('Saved')}: ${fmtTs(res.updateAt)}`);
      Notification.success(i18n('Report saved.'));
    } catch (e) {
      Notification.error(e.message);
    } finally {
      $b.prop('disabled', false);
    }
  });

  $panel.find('.sbt__toggle').on('click', () => {
    if ($preview.is(':visible')) {
      $preview.hide();
      $report.show();
      $panel.find('.sbt__toggle').html(`👁 ${esc(i18n('Preview'))}`);
    } else {
      $preview.html(aiMarkdown.render(String($report.val() || ''))).show();
      $report.hide();
      $panel.find('.sbt__toggle').html(`✏️ ${esc(i18n('Edit'))}`);
    }
  });

  $panel.find('.sbt__upload').on('click', async function onUp() {
    const input = $panel.find('.sbt__pick')[0];
    if (!input.files || !input.files.length) {
      Notification.error(i18n('Choose a file first.'));
      return;
    }
    const $b = $(this).prop('disabled', true).text(i18n('Uploading...'));
    try {
      const res = await uploadFile(input.files[0]);
      $list.html(fileRows(res.files, { deletable: true }));
      bindDeletes();
      input.value = '';
      Notification.success(i18n('File uploaded.'));
    } catch (e) {
      Notification.error(e.message);
    } finally {
      $b.prop('disabled', false).html(`⬆ ${esc(i18n('Upload'))}`);
    }
  });
  return $panel;
}

function teacherPanel($mount) {
  const $panel = $('<div class="sbt">'
    + `<div class="sbt__head">🧑‍🏫 ${esc(i18n('Submissions'))}<span class="sbt__hint sbt__count"></span></div>`
    + `<div class="sbt__body"><div class="sbt__tbl">${esc(i18n('Loading...'))}</div></div></div>`);
  $mount.after($panel);
  const $tbl = $panel.find('.sbt__tbl');
  request.get(`${baseUrl()}?list=1`).then((res) => {
    const subs = res.submissions || [];
    $panel.find('.sbt__count').text(`${subs.length}`);
    if (!subs.length) {
      $tbl.html(`<div class="sbt__empty">${esc(i18n('No submissions yet.'))}</div>`);
      return;
    }
    let html = `<table class="sbt__table"><tr><th>${esc(i18n('User'))}</th><th>${esc(i18n('Files'))}</th>`
      + `<th>${esc(i18n('Report'))}</th><th>${esc(i18n('Updated'))}</th><th></th></tr>`;
    for (const sub of subs) {
      html += `<tr><td>${esc(sub.uname)}</td><td>${sub.files}</td><td>${sub.hasReport ? '✓' : '—'}</td>`
        + `<td class="sbt__ts">${esc(fmtTs(sub.updateAt))}</td>`
        + `<td><button type="button" class="sbt__btn sbt__btn--ghost sbt__open" data-uid="${sub.uid}" data-uname="${esc(sub.uname)}">${esc(i18n('View'))}</button></td></tr>`;
    }
    html += '</table><div class="sbt__detail"></div>';
    $tbl.html(html);
    $tbl.find('.sbt__open').on('click', async function onOpen() {
      const uid = $(this).data('uid');
      const uname = $(this).data('uname');
      const $detail = $tbl.find('.sbt__detail');
      $detail.html(`<div class="sbt__view">${esc(i18n('Loading...'))}</div>`);
      try {
        const res2 = await request.get(`${baseUrl()}?uid=${uid}`);
        $detail.html('<div class="sbt__view">'
          + `<b>${esc(uname)}</b> <span class="sbt__ts">${esc(fmtTs(res2.updateAt))}</span>`
          + `<div class="sbt__list">${fileRows(res2.files, { uid })}</div>`
          + `<hr><div class="typo">${res2.report ? aiMarkdown.render(res2.report) : `<span class="sbt__empty">${esc(i18n('No report written.'))}</span>`}</div>`
          + '</div>');
        $detail[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) {
        Notification.error(e.message);
      }
    });
  }).catch((e) => $tbl.html(`<div class="sbt__empty">⚠ ${esc(e.message)}</div>`));
  return $panel;
}

export default new NamedPage(PROBLEM_PAGES, () => {
  const uc = window.UiContext || {};
  const pdoc = uc.pdoc || {};
  if (!/^s/i.test(String(pdoc.pid || ''))) return;
  if (getTheme() === 'dark') document.documentElement.classList.add('pta-dark');
  if (!document.getElementById('sbt-style')) {
    $('<style>').attr('id', 'sbt-style').text(STYLE).appendTo(document.head);
  }
  hideJudgeAffordances();
  const me = (window.UserContext || {})._id;
  const teacher = !!uc.isDomainRoot || (me != null && pdoc.owner === me);
  const $anchor = anchorPoint();
  console.info('[pta-ui] subjective task UI ready (%s)', teacher ? 'teacher' : 'student');
  // Teachers see the submissions list first; the own-submission editor is
  // still available below it (useful for posting a sample).
  if (teacher) {
    const $t = teacherPanel($anchor);
    studentPanel($t);
  } else {
    studentPanel($anchor);
  }
});
