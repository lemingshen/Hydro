/*
 * Draft-status stamps for the Homework / Test problem tables.
 *
 * Two kinds, two truths:
 *  - OBJECTIVE answers live in the browser: the combined paper stores them
 *    in localStorage under `paper/<uid>/<containerId>`. Server-rendered
 *    tables cannot know about them, so this script stamps client-side.
 *  - SUBJECTIVE reports live on the SERVER: the dedicated module
 *    (subjective_task.page.js) saves through POST operation:'report' and
 *    loads via GET /p/<docId>/subjective — so the stamp asks that endpoint
 *    and is therefore cross-device, unlike the objective drafts.
 *
 * Deliberately conservative: a row is only stamped when its status cell
 * holds no real content (no record link, no verdict icon/text) — a real
 * submission or verdict always wins over a draft note.
 */
import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

export default new NamedPage(['homework_detail', 'contest_problemlist'], async () => {
  const m = window.location.pathname.match(/\/(?:homework|contest)\/([0-9a-f]{24})/i);
  if (!m) return;
  const tid = m[1];
  const domainPrefix = (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
  const uid = window.UserContext._id;

  // --- the paper's objective answers -------------------------------------
  let paperDraft = {};
  try {
    paperDraft = JSON.parse(localStorage.getItem(`paper/${uid}/${tid}`) || '{}');
  } catch (e) { /* unreadable store: stamp nothing rather than guess */ }
  const answeredObjective = new Set(
    Object.entries(paperDraft)
      .filter(([, qs]) => Object.values(qs || {})
        .some((v) => (Array.isArray(v) ? v.length : String(v ?? '').length)))
      .map(([docId]) => String(docId)),
  );

  const stamp = ($st) => $st.html(
    `<span class="paper-draft-chip" title="${i18n('Answers are saved on this device as you type — close the page and pick up where you left off.')}">✎ ${i18n('Saved')}</span>`,
  );
  const cellIsFree = ($st) => $st.length && !$st.find('a, .record-status--icon, .record-status--text').length;

  const subjectiveRows = [];
  $('table tr').each((i, tr) => {
    const $tr = $(tr);
    const href = $tr.find('a[href*="/p/"]').attr('href') || '';
    const pm = href.match(/\/p\/([OoSs])(\d+)[A-Za-z]?(?:[/?#]|$)/);
    if (!pm) return;
    const [, kindChar, docId] = pm;
    const $st = $tr.find('.col--status');
    if (!cellIsFree($st)) return;
    if (/o/i.test(kindChar)) {
      if (answeredObjective.has(docId)) stamp($st);
    } else {
      subjectiveRows.push({ $st, docId });
    }
  });

  // --- subjective: ask the server for the student's own report -----------
  await Promise.all(subjectiveRows.map(async ({ $st, docId }) => {
    try {
      const res = await request.get(`${domainPrefix}/p/${docId}/subjective`);
      const hasReport = String(res.report || '').trim().length > 0;
      const hasFiles = Array.isArray(res.files) && res.files.length > 0;
      if (hasReport || hasFiles) {
        stamp($st);
        // the server knows exactly when — surface it as the tooltip
        if (res.updateAt) {
          $st.find('.paper-draft-chip').attr('title', `${i18n('Saved')}: ${new Date(res.updateAt).toLocaleString()}`);
        }
      }
    } catch (e) { /* endpoint unavailable: leave the row as the server rendered it */ }
  }));
});
