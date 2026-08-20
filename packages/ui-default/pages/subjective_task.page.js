import $ from 'jquery';
import Notification from 'vj/components/notification';
import { aiMarkdown } from 'vj/components/ai-report/pdf';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n, request } from 'vj/utils';

/**
 * Subjective (project-level, teacher-graded) tasks — pid starting with 'S'.
 *
 * Students get a focused, full-width submission card BELOW the task
 * description: the site-wide double-column markdown editor for the report
 * (with unsaved-changes tracking and Ctrl/Cmd+S), plus a drag-and-drop
 * multi-file upload zone. The judge-oriented right sidebar is removed for
 * students; teachers keep it (Edit / Files live there) and see the
 * submissions list above their own sample panel. No judge, no scratchpad.
 */

const PROBLEM_PAGES = ['problem_detail', 'contest_detail_problem', 'homework_detail_problem'];
const MAX_FILES = 10;
const MAX_FILE_MB = 25;

const STYLE = [
  /* ------------------------------ card shell ------------------------------ */
  '.sbt { border: 1px solid #e9e2f9; border-radius: 14px; margin: 16px 0; background: #fff; overflow: hidden; box-shadow: 0 8px 28px rgba(95,61,196,.08); }',
  '.sbt__head { display: flex; align-items: center; gap: 10px; padding: 12px 18px; background: linear-gradient(100deg, #7048e8 0%, #845ef7 55%, #b197fc 100%); color: #fff; }',
  '.sbt__title { font-weight: bold; font-size: 14.5px; letter-spacing: .02em; }',
  '.sbt__hint { margin-left: auto; font-size: 11.5px; opacity: .92; text-align: right; }',
  '.sbt__body { padding: 16px 18px 18px; font-size: 13px; }',
  '.sbt__label { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: bold; letter-spacing: .08em; text-transform: uppercase; color: #8a80b3; margin: 20px 0 8px; }',
  '.sbt__label:first-child { margin-top: 0; }',
  '.sbt__badge { background: #f1ecff; color: #7048e8; border-radius: 10px; padding: 1px 9px; font-size: 11px; letter-spacing: 0; text-transform: none; }',
  '.sbt__badge:empty { display: none; }',
  /* ------------------------------ report area ----------------------------- */
  // Pre-upgrade fallback textarea; the editor hides it once mounted.
  '.sbt__report { width: 100%; min-height: 180px; font: 12.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; border: 1px solid #d5dbe7; border-radius: 10px; padding: 8px 10px; resize: vertical; box-sizing: border-box; }',
  // The site-wide double-column markdown editor (md-editor-rt).
  '.sbt .md-editor { height: 460px; border-radius: 10px; overflow: hidden; }',
  '.sbt__saverow { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }',
  '@keyframes sbtPulse { 50% { opacity: .45; } }',
  '.sbt__dirty { display: none; color: #e8590c; font-size: 12px; animation: sbtPulse 1.6s ease-in-out infinite; }',
  '.sbt__ts { color: #8a94a6; font-size: 11.5px; background: #f6f7fb; border: 1px solid #e8ebf4; padding: 3px 10px; border-radius: 10px; }',
  '.sbt__ts:empty { display: none; }',
  '.sbt__deadline { color: #7a6fae; font-size: 12px; }',
  '.sbt__deadline--past { color: #e8590c; }',
  '.sbt__deadline:empty { display: none; }',
  /* -------------------------------- buttons ------------------------------- */
  '.sbt__btn { border: none; border-radius: 18px; padding: 8px 22px; font-size: 13px; color: #fff; cursor: pointer; background: linear-gradient(90deg, #7048e8, #9775fa); box-shadow: 0 3px 12px rgba(112,72,232,.35); transition: filter .12s ease, transform .12s ease; }',
  '.sbt__btn:hover { filter: brightness(1.08); transform: translateY(-1px); }',
  '.sbt__btn:disabled { opacity: .55; cursor: default; transform: none; }',
  '.sbt__btn--ghost { background: #fff; color: #7048e8; border: 1px solid #c7b8f5; box-shadow: none; }',
  '.sbt__btn--ghost:hover { background: #f6f2ff; filter: none; }',
  '.sbt__btn--sm { padding: 4px 14px; font-size: 12px; }',
  /* ------------------------------- drop zone ------------------------------ */
  '.sbt__drop { border: 2px dashed #cdb9f7; border-radius: 12px; padding: 20px 16px; text-align: center; color: #7a6fae; cursor: pointer; background: #fcfbff; transition: background .15s, border-color .15s, box-shadow .15s; user-select: none; }',
  '.sbt__drop:hover, .sbt__drop--over { background: #f6f1ff; border-color: #9775fa; box-shadow: inset 0 0 0 3px rgba(151,117,250,.12); }',
  '.sbt__drop--busy { opacity: .65; pointer-events: none; }',
  '.sbt__drop-ic { font-size: 26px; display: block; margin-bottom: 6px; }',
  '.sbt__drop-main { font-weight: bold; font-size: 13px; }',
  '.sbt__drop-sub { font-size: 11.5px; color: #a49ac9; margin-top: 4px; }',
  '.sbt__pick { display: none; }',
  /* ------------------------------- file rows ------------------------------ */
  '.sbt__list { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }',
  '.sbt__file { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid #ece7f8; border-radius: 10px; background: #fff; transition: box-shadow .12s, border-color .12s; }',
  '.sbt__file:hover { border-color: #d7cbf7; box-shadow: 0 3px 12px rgba(95,61,196,.10); }',
  '.sbt__fic { font-size: 16px; flex: 0 0 auto; }',
  '.sbt__file a { color: #5f3dc4; text-decoration: none; font-weight: 600; word-break: break-all; }',
  '.sbt__file a:hover { text-decoration: underline; }',
  '.sbt__fmeta { margin-left: auto; color: #9aa0b5; font-size: 11.5px; white-space: nowrap; flex: 0 0 auto; }',
  '.sbt__del { border: 1px solid transparent; background: transparent; color: #c2255c; cursor: pointer; font-size: 14px; line-height: 1; padding: 4px 7px; border-radius: 8px; flex: 0 0 auto; }',
  '.sbt__del:hover { background: #fff0f4; border-color: #f3c1d3; }',
  '.sbt__empty { color: #98a2ac; padding: 10px 2px; font-size: 12.5px; }',
  /* --------------------------- teacher list view -------------------------- */
  '.sbt__table { width: 100%; border-collapse: separate; border-spacing: 0; }',
  '.sbt__table th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: #8a80b3; padding: 8px 10px; border-bottom: 1px solid #ece7f8; background: #faf9ff; }',
  '.sbt__table td { padding: 9px 10px; border-bottom: 1px solid #f1eefb; font-size: 12.5px; }',
  '.sbt__table tr:hover td { background: #faf8ff; }',
  '.sbt__view { background: #faf8ff; border: 1px solid #e6ddf7; border-radius: 12px; margin: 10px 0 4px; padding: 12px 14px; }',
  /* ---------------------- last-submission modal ---------------------- */
  '@keyframes sbtmIn { from { opacity: 0; } }',
  '@keyframes sbtmPop { from { opacity: 0; transform: translateY(16px) scale(.96); } to { opacity: 1; transform: none; } }',
  '.sbtm-mask { position: fixed; inset: 0; z-index: 3300; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; padding: 20px; animation: sbtmIn .2s ease-out; }',
  '.sbtm { width: 860px; max-width: 94vw; max-height: 90vh; display: flex; flex-direction: column; margin: 0; animation: sbtmPop .25s cubic-bezier(.2,.8,.3,1); }',
  '.sbtm .sbt__body { overflow-y: auto; }',
  '.sbtm__close { border: none; background: transparent; color: rgba(255,255,255,.9); font-size: 20px; cursor: pointer; padding: 0 4px; line-height: 1; flex: 0 0 auto; }',
  '.sbtm__close:hover { color: #fff; }',
  '.sbtm-mask--closing { transition: opacity .18s ease; opacity: 0; pointer-events: none; }',
  '.sbtm-mask--closing .sbtm { transition: transform .18s ease, opacity .18s ease; transform: translateY(10px) scale(.97); opacity: 0; }',
  /* ------------------------- full-width student page ----------------------- */
  '.sbt-wide { width: 100% !important; }',
  '@media (max-width: 780px) { .sbt__hint { display: none; } }',
  /* -------------------------------- dark theme ----------------------------- */
  '.pta-dark .sbt { background: #23272c; border-color: #37313f; box-shadow: 0 8px 28px rgba(0,0,0,.4); }',
  '.pta-dark .sbt__body { color: #d5dade; }',
  '.pta-dark .sbt__label { color: #9d93c9; }',
  '.pta-dark .sbt__badge { background: #322a48; color: #cdbdfb; }',
  '.pta-dark .sbt__report { background: #1e2227; border-color: #3a424b; color: #d5dade; }',
  '.pta-dark .sbt__ts { background: #262b31; border-color: #333a41; color: #98a2ac; }',
  '.pta-dark .sbt__deadline { color: #a99ed0; }',
  '.pta-dark .sbt__btn--ghost { background: #23272c; color: #b197fc; border-color: #5c4a8a; }',
  '.pta-dark .sbt__btn--ghost:hover { background: #2c2440; }',
  '.pta-dark .sbt__drop { background: #221f2c; border-color: #4d4070; color: #a99ed0; }',
  '.pta-dark .sbt__drop:hover, .pta-dark .sbt__drop--over { background: #292339; border-color: #7a5fd0; box-shadow: inset 0 0 0 3px rgba(122,95,208,.18); }',
  '.pta-dark .sbt__drop-sub { color: #7f75a8; }',
  '.pta-dark .sbt__file { background: #262b31; border-color: #37313f; }',
  '.pta-dark .sbt__file:hover { border-color: #4d4070; box-shadow: 0 3px 12px rgba(0,0,0,.35); }',
  '.pta-dark .sbt__file a { color: #b197fc; }',
  '.pta-dark .sbt__fmeta { color: #7f8b97; }',
  '.pta-dark .sbt__del:hover { background: #3a2230; border-color: #6b3450; }',
  '.pta-dark .sbt__empty { color: #7f8b97; }',
  '.pta-dark .sbt__table th { background: #262b31; color: #9d93c9; border-bottom-color: #37313f; }',
  '.pta-dark .sbt__table td { border-bottom-color: #2c3238; }',
  '.pta-dark .sbt__table tr:hover td { background: #2a2536; }',
  '.pta-dark .sbt__view { background: #2a2536; border-color: #4d4070; }',
].join('\n');

function esc(text) {
  return $('<i>').text(String(text ?? '')).html();
}

const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function baseUrl() {
  // The page URL carries the DISPLAY pid (e.g. /p/S1000), but the backend
  // routes validate :pid — use the canonical numeric docId like the
  // trajectory endpoint does, keeping the /d/<domain> prefix when present.
  const docId = window.UiContext && UiContext.pdoc && UiContext.pdoc.docId;
  if (docId != null) {
    const domainPrefix = (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
    return `${domainPrefix}/p/${docId}/subjective`;
  }
  return `${window.location.pathname.split('?')[0]}/subjective`; // fallback
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
    + '<span class="sbt__fic">📄</span>'
    + `<a href="${baseUrl()}/file?name=${encodeURIComponent(f.name)}${uidQ}" target="_blank" rel="noopener">${esc(f.name)}</a>`
    + `<span class="sbt__fmeta">${fmtSize(f.size)} · ${esc(fmtTs(f.uploadAt))}</span>`
    + (deletable ? `<button type="button" class="sbt__del" data-name="${esc(f.name)}" title="${esc(i18n('Delete'))}">×</button>` : '')
    + '</div>').join('');
}

/**
 * Page layout for subjective tasks: hide the judge-oriented affordances, and
 * for STUDENTS drop the whole right sidebar (Discussions / Files / Statistics
 * are judge-world noise here) so the submission card gets the full width.
 * Teachers keep the sidebar — Edit and Files management live there.
 */
function prepareLayout(teacher) {
  $('[name="problem-sidebar__open-scratchpad"], [name="problem-sidebar__show-category"]').closest('li').hide();
  $('a[href$="/submit"]').closest('li').hide();
  // The template's judge-oriented warnings ("No testdata at current.",
  // config-parse errors) are noise here: nothing is ever judged. Only the
  // DIRECT children of the description fragment are template-generated;
  // author-written blockquotes inside the statement markdown stay visible.
  $('[data-fragment-id="problem-description"] > blockquote.warn').hide();
  if (!teacher) {
    const $row = $('.row[data-sticky-parent]').first();
    $row.children('.medium-3.columns').hide();
    $row.children('.medium-9.columns').addClass('sbt-wide');
  }
}

/**
 * Insert AFTER the task description so students read the task first. The
 * statement lives in the section holding [data-fragment-id=problem-description]
 * (older builds used name=problem-description — kept as a fallback).
 */
function anchorPoint() {
  const $frag = $('[data-fragment-id="problem-description"], [name="problem-description"]').first();
  const $stmt = $frag.closest('.section');
  if ($stmt.length) return $stmt;
  const $first = $('.medium-9 .section').first();
  if ($first.length) return $first;
  return $('.main').first();
}

/* ---------------------- "View Last Submission" modal ---------------------- */

/** Set by studentPanel so the modal can flag unsaved editor changes. */
let isReportDirty = () => false;

/**
 * The rail's 🕘 button opens judge records elsewhere; a subjective task has
 * none, so here it shows the student's LAST SAVED submission instead: the
 * rendered report plus the uploaded files, fetched fresh from the server.
 */
function openSubmissionModal() {
  if (document.querySelector('.sbtm-mask')) return; // one at a time
  const $mask = $('<div class="sbtm-mask"></div>').appendTo(document.body);
  const $modal = $(`<div class="sbt sbtm" role="dialog" aria-label="${esc(i18n('My Last Submission'))}">`
    + `<div class="sbt__head">🕘 <span class="sbt__title">${esc(i18n('My Last Submission'))}</span>`
    + '<span class="sbt__hint sbtm__meta"></span>'
    + `<button type="button" class="sbtm__close" title="${esc(i18n('Close'))}">×</button></div>`
    + `<div class="sbt__body sbtm__body"><div class="sbt__empty">${esc(i18n('Loading...'))}</div></div>`
    + '</div>').appendTo($mask);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    $(document).off('keydown.sbtm');
    $mask.addClass('sbtm-mask--closing');
    setTimeout(() => $mask.remove(), 190);
  };
  $modal.find('.sbtm__close').on('click', close);
  $mask.on('mousedown', (ev) => {
    if (ev.target === $mask[0]) close(); // click on the backdrop closes
  });
  $(document).on('keydown.sbtm', (ev) => {
    if (ev.key === 'Escape') close();
  });
  request.get(baseUrl()).then((res) => {
    if (closed) return;
    const files = res.files || [];
    const report = String(res.report || '');
    const $meta = $modal.find('.sbtm__meta');
    if (res.updateAt) $meta.text(`${i18n('Saved')}: ${fmtTs(res.updateAt)}`);
    if (isReportDirty()) {
      $meta.append(` <span class="sbt__dirty" style="display:inline">● ${esc(i18n('Unsaved changes'))}</span>`);
    }
    if (!report.trim() && !files.length) {
      $modal.find('.sbtm__body').html(`<div class="sbt__empty">${esc(i18n('No submissions yet.'))}</div>`);
      return;
    }
    $modal.find('.sbtm__body').html(
      `<div class="sbt__label">📝 ${esc(i18n('Report'))}</div>`
      + (report.trim()
        ? `<div class="typo">${aiMarkdown.render(report)}</div>`
        : `<div class="sbt__empty">${esc(i18n('No report written.'))}</div>`)
      + `<div class="sbt__label">📎 ${esc(i18n('Files'))} <span class="sbt__badge">${files.length || ''}</span></div>`
      + `<div class="sbt__list">${fileRows(files)}</div>`,
    );
  }).catch((e) => {
    if (closed) return;
    $modal.find('.sbtm__body').html(`<div class="sbt__empty">⚠ ${esc(e.message)}</div>`);
  });
}

function studentPanel($mount) {
  const $panel = $('<div class="sbt">'
    + `<div class="sbt__head">📁 <span class="sbt__title">${esc(i18n('Project Submission'))}</span>`
    + `<span class="sbt__hint">${esc(i18n('Graded by your teacher — no automatic judging.'))}</span></div>`
    + '<div class="sbt__body">'
    + `<div class="sbt__label">📝 ${esc(i18n('Report'))}</div>`
    // Wrapper: Hydro's Editor mounts by APPENDING to the textarea's PARENT,
    // so without this host the editor would land at the END of the card body
    // (below the Files section) instead of right under the Report label.
    + '<div class="sbt__reporthost">'
    + `<textarea class="sbt__report" data-markdown placeholder="${esc(i18n('Write your project report here (Markdown supported)...'))}"></textarea>`
    + '</div>'
    + '<div class="sbt__saverow">'
    + `<button type="button" class="sbt__btn sbt__save">💾 ${esc(i18n('Save and Submit'))}</button>`
    + '<span class="sbt__deadline"></span>'
    + `<span class="sbt__dirty">● ${esc(i18n('Unsaved changes'))}</span>`
    + '<span class="sbt__ts"></span></div>'
    + `<div class="sbt__label">📎 ${esc(i18n('Files'))} <span class="sbt__badge sbt__count"></span></div>`
    + '<div class="sbt__drop">'
    + '<span class="sbt__drop-ic">⬆️</span>'
    + `<div class="sbt__drop-main">${esc(i18n('Drag & drop files here, or click to browse'))}</div>`
    + `<div class="sbt__drop-sub">${esc(i18n('Up to 10 files · 25 MB each'))}</div>`
    + '</div>'
    + '<input type="file" class="sbt__pick" multiple>'
    + '<div class="sbt__list"></div>'
    + '</div></div>');
  $mount.after($panel);
  const $report = $panel.find('.sbt__report');
  const $ts = $panel.find('.sbt__ts');
  const $list = $panel.find('.sbt__list');
  const $dirty = $panel.find('.sbt__dirty');
  const $drop = $panel.find('.sbt__drop');
  const $dropMain = $panel.find('.sbt__drop-main');
  const $pick = $panel.find('.sbt__pick');
  const dropDefaultText = $dropMain.text();
  let dirty = false;
  let fileCount = 0;
  isReportDirty = () => dirty; // the last-submission modal flags unsaved edits

  // Deadline hint: inside a contest or homework, UiContext carries the
  // activity doc — tsdoc.endAt is a per-student extension and wins over the
  // activity-wide tdoc.endAt. Trainings and self-learning sessions have no
  // deadline field, so the hint simply stays hidden there.
  (() => {
    const ucx = window.UiContext || {};
    const raw = (ucx.tsdoc && ucx.tsdoc.endAt) || (ucx.tdoc && ucx.tdoc.endAt);
    if (!raw) return;
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return;
    const $deadline = $panel.find('.sbt__deadline');
    if (d.getTime() > Date.now()) {
      $deadline.text(`${i18n('You can modify it any time before')} ${fmtTs(d)}`);
    } else {
      $deadline.addClass('sbt__deadline--past').text(`${i18n('Deadline passed:')} ${fmtTs(d)}`);
    }
  })();

  const markDirty = () => {
    dirty = true;
    $dirty.css('display', 'inline');
  };
  const markClean = () => {
    dirty = false;
    $dirty.hide();
  };
  window.addEventListener('beforeunload', (ev) => {
    if (!dirty) return;
    ev.preventDefault();
    ev.returnValue = ''; // the browser shows its own generic prompt
  });

  const renderList = (files) => {
    fileCount = (files || []).length;
    $panel.find('.sbt__count').text(fileCount ? `${fileCount} / ${MAX_FILES}` : '');
    $list.html(fileRows(files, { deletable: true }));
  };

  // Delegated once: rows are re-rendered after every upload/delete.
  $list.on('click', '.sbt__del', async function onDel() {
    try {
      const res = await request.post(baseUrl(), { operation: 'delete', name: $(this).data('name') });
      renderList(res.files);
    } catch (e) {
      Notification.error(e.message);
    }
  });

  /**
   * Upgrade the plain textarea to the site-wide double-column markdown
   * editor (the same md-editor-rt editor used for problem statements and
   * discussions; Monaco for users who prefer it). It reads the textarea's
   * value at mount and mirrors every keystroke back into it, so the Save
   * handler keeps reading $report.val() unchanged. Mounted AFTER the saved
   * report arrives so the initial value is already in the textarea; if the
   * editor chunk fails to load, the plain textarea keeps working.
   */
  const mountReportEditor = async () => {
    try {
      const { default: Editor } = await import('vj/components/editor');
      Editor.getOrConstruct($report, { language: 'markdown', onChange: markDirty });
    } catch (e) {
      console.warn('[pta-ui] markdown editor unavailable, keeping the plain textarea:', (e && e.message) || e);
      $report.on('input', markDirty); // fallback dirty tracking
    }
  };

  request.get(baseUrl()).then((res) => {
    $report.val(res.report || '');
    $ts.text(res.updateAt ? `${i18n('Saved')}: ${fmtTs(res.updateAt)}` : '');
    renderList(res.files);
  }).catch((e) => Notification.error(e.message)).then(mountReportEditor);

  const doSave = async () => {
    const $b = $panel.find('.sbt__save').prop('disabled', true);
    try {
      const res = await request.post(baseUrl(), { operation: 'report', report: $report.val() });
      $ts.text(`${i18n('Saved')}: ${fmtTs(res.updateAt)}`);
      markClean();
      Notification.success(i18n('Report saved.'));
    } catch (e) {
      Notification.error(e.message);
    } finally {
      $b.prop('disabled', false);
    }
  };
  $panel.find('.sbt__save').on('click', doSave);
  // Ctrl/Cmd+S anywhere inside the panel saves. Capture phase, so the
  // editor's own keymap cannot swallow it first.
  document.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || String(ev.key).toLowerCase() !== 's') return;
    if (!$panel[0].contains(ev.target)) return;
    ev.preventDefault();
    doSave();
  }, true);

  /* --------------------------- file uploads --------------------------- */

  const uploadMany = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const fit = [];
    for (const f of files) {
      if (f.size > MAX_FILE_MB * 1024 * 1024) {
        Notification.error(`${f.name}: ${i18n('The file exceeds the 25 MB limit.')}`);
      } else fit.push(f);
    }
    if (fileCount + fit.length > MAX_FILES) {
      Notification.warn(i18n('At most 10 files.'));
      fit.length = Math.max(0, MAX_FILES - fileCount);
    }
    if (!fit.length) return;
    $drop.addClass('sbt__drop--busy');
    let ok = 0;
    try {
      for (let k = 0; k < fit.length; k++) {
        $dropMain.text(`${i18n('Uploading')} ${k + 1}/${fit.length}: ${fit[k].name}`);
        try {
          const res = await uploadFile(fit[k]); // eslint-disable-line no-await-in-loop
          renderList(res.files); // each response returns the full list
          ok++;
        } catch (e) {
          Notification.error(`${fit[k].name}: ${e.message}`);
        }
      }
    } finally {
      $drop.removeClass('sbt__drop--busy');
      $dropMain.text(dropDefaultText);
      $pick.val('');
    }
    if (ok) Notification.success(`${ok} ${i18n('file(s) uploaded.')}`);
  };

  $drop.on('click', () => $pick.trigger('click'));
  $pick.on('change', function onPick() {
    uploadMany(this.files);
  });
  $drop.on('dragenter dragover', (ev) => {
    ev.preventDefault();
    $drop.addClass('sbt__drop--over');
  });
  $drop.on('dragleave drop', (ev) => {
    ev.preventDefault();
    $drop.removeClass('sbt__drop--over');
  });
  $drop.on('drop', (ev) => {
    const dt = ev.originalEvent && ev.originalEvent.dataTransfer;
    if (dt && dt.files && dt.files.length) uploadMany(dt.files);
  });

  return $panel;
}

function teacherPanel($mount) {
  const $panel = $('<div class="sbt">'
    + `<div class="sbt__head">🧑‍🏫 <span class="sbt__title">${esc(i18n('Submissions'))}</span> <span class="sbt__badge sbt__count"></span>`
    + `<span class="sbt__hint">${esc(i18n('Click View to read the report and download files.'))}</span></div>`
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
        + `<td class="sbt__ts-cell">${esc(fmtTs(sub.updateAt))}</td>`
        + `<td><button type="button" class="sbt__btn sbt__btn--ghost sbt__btn--sm sbt__open" data-uid="${sub.uid}" data-uname="${esc(sub.uname)}">${esc(i18n('View'))}</button></td></tr>`;
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
          + `<b>${esc(uname)}</b> <span class="sbt__fmeta">${esc(fmtTs(res2.updateAt))}</span>`
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
  const me = (window.UserContext || {})._id;
  const teacher = !!uc.isDomainRoot || (me != null && pdoc.owner === me);
  prepareLayout(teacher);
  // The rail's "View Last Submission" button opens judge records elsewhere;
  // a subjective task has none. Capture-phase, so this fires BEFORE the
  // rail's own bubble-phase handler (bound whenever the rail injects) and
  // replaces it with the saved report + files modal.
  document.addEventListener('click', (ev) => {
    const hit = ev.target && ev.target.closest ? ev.target.closest('#sl-rail-lastsub') : null;
    if (!hit) return;
    ev.preventDefault();
    ev.stopPropagation();
    openSubmissionModal();
  }, true);
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
