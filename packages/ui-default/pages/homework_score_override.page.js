import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

/**
 * PTA fork — TEACHER SCORE ADJUSTMENT on the homework scoreboard.
 *
 * For the homework's owner / editors (the server sets UiContext.scoreOverride)
 * every task cell and every total cell becomes clickable: a dialog shows the
 * student, the task, the judged score and any adjustment already in place,
 * and takes a new score plus a reason (shown to the student). Saving posts
 * to /homework/:tid/score-override (operation set / clear) and reloads the
 * board, where adjusted cells carry a ✎. A subjective task is graded the
 * same way — its cell is simply empty until then.
 */

const STYLE = `
.hso-hint { margin: 0 0 10px; padding: 8px 12px; border-radius: 10px; background: var(--pta-violet-soft, #f3f0ff); border: 1px solid var(--pta-violet-line, #e5dbff); color: var(--pta-violet-text, #5f3dc4); font-size: 12.5px; }
.scoreboard--homework td.col--problem, .scoreboard--homework td.col--total_score { cursor: pointer; position: relative; }
.scoreboard--homework td.col--problem:hover, .scoreboard--homework td.col--total_score:hover { background: var(--pta-violet-soft, #f3f0ff); }
.scoreboard--homework td.col--problem:hover::after, .scoreboard--homework td.col--total_score:hover::after { content: '✎'; position: absolute; right: 4px; top: 2px; font-size: 11px; color: var(--pta-violet-text, #5f3dc4); }
.hso-mask { position: fixed; inset: 0; z-index: 3200; background: rgba(10,14,22,.45); display: flex; align-items: center; justify-content: center; padding: 16px; }
.hso { width: 460px; max-width: 96vw; background: var(--pta-card, #fff); color: var(--pta-ink, #222); border-radius: 14px; box-shadow: 0 24px 60px -20px rgba(0,0,0,.5); padding: 16px 18px; font-size: 13px; }
.hso h3 { margin: 0 0 6px; font-size: 15px; color: var(--pta-violet-text, #5f3dc4); }
.hso__meta { color: var(--pta-ink-faint, #888); font-size: 12px; margin-bottom: 10px; }
.hso__cur { padding: 8px 10px; border-radius: 9px; background: var(--pta-card-2, #f7f7fa); border: 1px solid var(--pta-line, #e6e8ee); margin-bottom: 10px; font-size: 12.5px; }
.hso label { display: block; font-size: 12px; color: var(--pta-ink-soft, #555); margin-top: 8px; }
.hso input, .hso textarea { font-family: var(--font-family); width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 9px; border: 1px solid var(--pta-line, #d9dbe2); border-radius: 8px; background: var(--pta-card, #fff); color: var(--pta-ink, #222); font-size: 13px; }
.hso textarea { min-height: 64px; resize: vertical; }
.hso__row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.hso button { border: none; border-radius: 999px; padding: 7px 16px; font-size: 13px; cursor: pointer; background: var(--pta-violet, #7048e8); color: #fff; }
.hso button.is-secondary { background: transparent; color: var(--pta-ink-soft, #555); border: 1px solid var(--pta-line, #d9dbe2); }
.hso button.is-danger { background: transparent; color: var(--pta-bad-text, #c0392b); border: 1px solid var(--pta-bad-line, #f1c0c0); }
.hso button:disabled { opacity: .55; cursor: default; }
`;

const esc = (t) => $('<i>').text(String(t ?? '')).html();
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? (Math.round(x * 10) / 10).toString() : '—');

export default new NamedPage('homework_scoreboard', () => {
  const cfg = window.UiContext && UiContext.scoreOverride;
  if (!cfg || !cfg.url) return;
  $('<style>').text(STYLE).appendTo(document.head);
  $('.scoreboard--homework .data-table, .scoreboard--homework table').first().before(
    `<div class="hso-hint">✎ ${esc(i18n('Click a task score or a total to adjust it for that student (a reason is required and shown to the student); adjusted cells carry ✎. Grade a subjective task the same way. Ctrl/⌘-click opens the submission instead.'))}</div>`,
  );

  let $mask = null;
  const close = () => {
    if ($mask) $mask.remove();
    $mask = null;
    $(document).off('keydown.hso');
  };

  async function openDialog(uid, uname, pid) {
    close();
    let state = null;
    try {
      state = await request.get(`${cfg.url}?uid=${uid}`);
    } catch (e) {
      Notification.error(e.message || i18n('Could not load the student’s scores.'));
      return;
    }
    const isTotal = pid === null;
    const detail = (state && state.detail) || {};
    const cur = isTotal ? (state.override && state.override.total) : (state.override && state.override.tasks ? state.override.tasks[String(pid)] : null);
    const judged = isTotal ? null : detail[pid];
    const label = isTotal ? i18n('Final score') : (cfg.labels[pid] || `#${pid}`);
    const weight = isTotal ? null : (cfg.weights && typeof cfg.weights[pid] === 'number' ? cfg.weights[pid] : 100);
    let curHtml;
    if (cur) curHtml = `<b>${esc(i18n('Adjusted'))}</b>: ${esc(i18n('computed'))} ${esc(num(cur.computed))} → <b>${esc(num(cur.score))}</b> · ${esc(cur.reason || '')}`;
    else if (isTotal) curHtml = `${esc(i18n('Current final score'))}: <b>${esc(num(state.penaltyScore))}</b>${typeof state.computedPenaltyScore === 'number' ? ` (${esc(i18n('computed'))} ${esc(num(state.computedPenaltyScore))})` : ''}`;
    else if (judged) curHtml = `${esc(i18n('Judged'))}: <b>${esc(num(judged.score))}</b> / 100 → ${esc(num(judged.penaltyScore))} / ${esc(weight)} ${esc(i18n('pts'))}`;
    else curHtml = `<em>${esc(i18n('No submission — an adjustment grades the task by hand.'))}</em>`;
    $mask = $(`<div class="hso-mask"><div class="hso" role="dialog">
      <h3>✎ ${esc(i18n('Adjust score'))}</h3>
      <div class="hso__meta">${esc(uname)} · ${esc(label)}${weight !== null ? ` · ${esc(i18n('weight'))} ${esc(weight)} ${esc(i18n('pts'))}` : ''}</div>
      <div class="hso__cur">${curHtml}</div>
      <label>${esc(isTotal ? i18n('New final score (points)') : i18n('New task score (0–100, the judge’s scale; weighted and late-penalized like a judged score)'))}
        <input type="number" class="hso-score" min="0" ${isTotal ? '' : 'max="100"'} step="0.1" value="${cur ? esc(num(cur.score)) : ''}"></label>
      <label>${esc(i18n('Reason (shown to the student)'))}<textarea class="hso-reason">${cur ? esc(cur.reason || '') : ''}</textarea></label>
      <div class="hso__row">
        ${cur ? `<button type="button" class="is-danger hso-clear">${esc(i18n('Remove adjustment'))}</button>` : ''}
        <button type="button" class="is-secondary hso-cancel">${esc(i18n('Cancel'))}</button>
        <button type="button" class="hso-save">${esc(i18n('Save adjustment'))}</button>
      </div></div></div>`).appendTo(document.body);
    $mask.on('click', (ev) => { if (ev.target === $mask[0]) close(); });
    $mask.find('.hso-cancel').on('click', close);
    $(document).on('keydown.hso', (ev) => { if (ev.key === 'Escape') close(); });
    $mask.find('.hso-score').trigger('focus');
    const submit = async (clear) => {
      const payload = { operation: clear ? 'clear' : 'set', uid };
      if (!isTotal) payload.pid = pid;
      if (!clear) {
        const score = Number.parseFloat($mask.find('.hso-score').val());
        const reason = String($mask.find('.hso-reason').val() || '').trim();
        if (!Number.isFinite(score) || score < 0 || (!isTotal && score > 100)) {
          Notification.error(isTotal ? i18n('Enter a non-negative score.') : i18n('Enter a score between 0 and 100.'));
          return;
        }
        if (!reason) {
          Notification.error(i18n('Please give a reason — the student will see it.'));
          return;
        }
        payload.score = score;
        payload.reason = reason;
      }
      $mask.find('button').prop('disabled', true);
      try {
        await request.post(cfg.url, payload);
        Notification.success(clear ? i18n('Adjustment removed.') : i18n('Score adjusted.'));
        close();
        window.location.reload();
      } catch (e) {
        Notification.error(e.message || i18n('Could not save the adjustment.'));
        $mask.find('button').prop('disabled', false);
      }
    };
    $mask.find('.hso-save').on('click', () => submit(false));
    $mask.find('.hso-clear').on('click', () => submit(true));
  }

  $(document).on('click', '.scoreboard--homework td.col--problem, .scoreboard--homework td.col--total_score', function onCell(ev) {
    // Ctrl/⌘-click keeps the record link; a plain click adjusts (record pages are owner/root-only in this fork anyway).
    if ($(ev.target).closest('a').length && (ev.ctrlKey || ev.metaKey)) return;
    const $tr = $(this).closest('tr');
    const uid = +$tr.find('.star[data-uid]').attr('data-uid');
    if (!uid) return;
    const uname = $tr.find('td.col--user').text().replace(/\s+/g, ' ').trim();
    let pid = null;
    if ($(this).hasClass('col--problem')) {
      const idx = $tr.find('td.col--problem').index(this);
      pid = cfg.pids[idx];
      if (pid === undefined) return;
    }
    ev.preventDefault();
    openDialog(uid, uname, pid);
  });
});
