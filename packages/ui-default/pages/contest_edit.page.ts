import $ from 'jquery';
import moment from 'moment';
import AssignSelectAutoComplete from 'vj/components/autocomplete/AssignSelectAutoComplete';
import LanguageSelectAutoComplete from 'vj/components/autocomplete/LanguageSelectAutoComplete';
import ProblemSelectAutoComplete from 'vj/components/autocomplete/ProblemSelectAutoComplete';
import UserSelectAutoComplete from 'vj/components/autocomplete/UserSelectAutoComplete';
import { confirm } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

/**
 * PTA test editor: the paper as sections (contest_edit.html,
 * homework_edit.html). Three objective sections (true/false, choice,
 * fill-in), each with a total split evenly over its tasks, and the
 * "scored" sections whose tasks carry their own points: programming, and —
 * on the homework editor only — subjective (project-level, teacher-graded)
 * tasks. Everything is folded into the hidden `paper` JSON field the server
 * turns into the problem order and per-problem weights; `pids` is kept in
 * sync for the clone button and older API clients.
 */
function initPaperEditor() {
  const $obj = $('#tep-objective');
  if (!$obj.length) return;
  const OBJ = ['tf', 'choice', 'blank'];
  /**
   * Per-task-points sections and their UI. `fn` (function tasks, pid F…)
   * is scored exactly like `prog` but picked in its own section, so the
   * editor mirrors the rail and the paper; `subj` only exists on the
   * homework editor. A section is live only if its input is on the page.
   */
  const SCORED_META: Record<string, { box: string, lockKind: string, head: string, empty: string }> = {
    prog: {
      box: '#tep-prog-scores', lockKind: 'programming', head: 'Points per programming task', empty: 'Pick programming tasks above, then give each its points.',
    },
    fn: {
      box: '#tep-fn-scores', lockKind: 'function', head: 'Points per function task', empty: 'Pick function tasks above, then give each its points.',
    },
    subj: {
      box: '#tep-subj-scores', lockKind: 'subjective', head: 'Points per subjective task', empty: 'Pick subjective tasks above, then give each its points.',
    },
  };
  const SCORED = Object.keys(SCORED_META).filter((sec) => $(`[data-pids-for="${sec}"]`).length > 0);
  const paper = (window as any).UiContext?.paper || {};
  const pickers: Record<string, any> = {};
  const scores: Record<string, Record<string, number>> = {};
  for (const sec of SCORED) scores[sec] = { ...(paper[sec]?.scores || {}) };
  const esc = (t: any) => $('<i>').text(String(t ?? '')).html();
  const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

  for (const sec of [...OBJ, ...SCORED]) {
    const $in = $(`[data-pids-for="${sec}"]`);
    const ids = (paper[sec]?.pids || []).map((x: any) => String(x));
    $in.val(ids.join(','));
    pickers[sec] = ProblemSelectAutoComplete.getOrConstruct($in, {
      multi: true,
      clearDefaultValue: false,
      lockKind: SCORED_META[sec] ? SCORED_META[sec].lockKind : 'objective',
      ...(!SCORED_META[sec] ? { lockSub: sec } : {}),
    });
    if (!SCORED_META[sec]) $(`[data-total-for="${sec}"]`).val(paper[sec]?.total ? fmt(+paper[sec].total) : '');
  }

  const idsOf = (sec: string) => String($(`[data-pids-for="${sec}"]`).val() || '').split(',').map((x) => x.trim()).filter((x) => x);
  const totalOf = (sec: string) => Math.max(0, +($(`[data-total-for="${sec}"]`).val() || 0) || 0);

  /** Scored rows: one points box per selected task (titles from the picker cache). */
  const renderScored = (sec: string) => {
    const meta = SCORED_META[sec];
    const ids = idsOf(sec);
    const items = (pickers[sec]?.ref?.getSelectedItems?.() || []) as any[];
    const titleOf = (id: string) => {
      const it = items.find((x) => String(x?.docId) === id);
      return it ? `${it.pid ? `${it.pid} ` : ''}${it.title || ''}` : `#${id}`;
    };
    const $box = $(meta.box);
    if (!ids.length) {
      $box.html(`<p class="help-text">${esc(i18n(meta.empty))}</p>`);
      return;
    }
    $box.html(`<div class="tep__scores-head">${esc(i18n(meta.head))}</div>${ids.map((id, i) => `<div class="tep__prow">`
      + `<span class="tep__prow-idx">${sec === 'subj' ? `S${i + 1}` : sec === 'fn' ? `F${i + 1}` : String.fromCharCode(65 + (i % 26))}</span>`
      + `<span class="tep__prow-title" title="${esc(titleOf(id))}">${esc(titleOf(id))}</span>`
      + `<input type="number" min="0" step="0.5" class="textbox tep__pscore" data-score-sec="${sec}" data-score-for="${id}" value="${scores[sec][id] !== undefined ? fmt(+scores[sec][id]) : ''}" placeholder="0">`
      + `<span class="tep__prow-unit">${esc(i18n('pts'))}</span></div>`).join('')}`);
  };
  const renderAllScored = () => { for (const sec of SCORED) renderScored(sec); };

  /** The running sum and the per-section "n tasks × x pts" lines. */
  const refresh = () => {
    let sum = 0;
    for (const sec of OBJ) {
      const n = idsOf(sec).length;
      const total = totalOf(sec);
      sum += n ? total : 0;
      const each = n ? total / n : 0;
      $(`[data-stat="${sec}"]`).text(n ? `${n} ${i18n('task(s)')} · ${fmt(total)} ${i18n('pts')}` : i18n('No task yet'));
      $(`[data-each="${sec}"]`).text(n
        ? `${i18n('Each task is worth')} ${fmt(each)} ${i18n('pts')} (${fmt(total)} ÷ ${n})`
        : i18n('Points per task are assigned automatically.'));
    }
    for (const sec of SCORED) for (const id of idsOf(sec)) sum += +scores[sec][id] || 0;
    const $sum = $('#tep-sum');
    const ok = Math.abs(sum - 100) < 0.005;
    $sum.text(`${i18n('Total')}: ${fmt(sum)} / 100`).toggleClass('is-ok', ok).toggleClass('is-off', !ok);
    $sum.attr('title', ok ? i18n('The test adds up to 100 points.') : i18n('The points of every task should add up to 100.'));
    const scoredJson: Record<string, any> = {};
    for (const sec of SCORED) scoredJson[sec] = { pids: idsOf(sec), scores: Object.fromEntries(idsOf(sec).map((id) => [id, +scores[sec][id] || 0])) };
    $('[name="paper"]').val(JSON.stringify({
      tf: { total: totalOf('tf'), pids: idsOf('tf') },
      choice: { total: totalOf('choice'), pids: idsOf('choice') },
      blank: { total: totalOf('blank'), pids: idsOf('blank') },
      ...scoredJson,
    }));
    $('[name="pids"]').val([...OBJ.flatMap(idsOf), ...SCORED.flatMap(idsOf)].join(','));
    return sum;
  };

  for (const sec of [...OBJ, ...SCORED]) {
    pickers[sec].onChange(() => {
      if (SCORED_META[sec]) renderScored(sec);
      refresh();
    });
  }
  $obj.on('input change', '.tep__total', refresh);
  $(document).on('input change', '.tep__pscore', function onScore() {
    const sec = String($(this).data('score-sec') || 'prog');
    if (!scores[sec]) scores[sec] = {};
    scores[sec][String($(this).data('score-for'))] = +($(this).val() || 0) || 0;
    refresh();
  });
  renderAllScored();
  refresh();
  // Titles arrive asynchronously for prefilled ids; redraw once they are in.
  setTimeout(renderAllScored, 800);
  setTimeout(renderAllScored, 2500);

  $obj.closest('form').on('submit', (ev) => {
    const sum = refresh();
    const count = [...OBJ, ...SCORED].reduce((a, sec) => a + idsOf(sec).length, 0);
    if (!count) {
      ev.preventDefault();
      Notification.error(i18n('Pick at least one task for the test.'));
      return;
    }
    if (Math.abs(sum - 100) >= 0.005 && !(ev.originalEvent as any)?.__tepConfirmed) {
      ev.preventDefault();
      confirm(`${i18n('The points of every task should add up to 100.')} ${i18n('Current total')}: ${fmt(sum)}. ${i18n('Save anyway?')}`).then((yes) => {
        if (!yes) return;
        const $form = $obj.closest('form');
        $form.append('<input type="hidden" name="operation" value="update">');
        (($form[0] as HTMLFormElement)).submit();
      });
    }
  });
}

const page = new NamedPage(['contest_edit', 'contest_create', 'homework_create', 'homework_edit'], (pagename) => {
  if ($('[name="pids"]').attr('type') !== 'hidden') ProblemSelectAutoComplete.getOrConstruct($('[name="pids"]'), { multi: true, clearDefaultValue: false });
  initPaperEditor();
  UserSelectAutoComplete.getOrConstruct<true>($('[name="maintainer"]'), { multi: true, clearDefaultValue: false });
  LanguageSelectAutoComplete.getOrConstruct($('[name=langs]'), { multi: true });
  AssignSelectAutoComplete.getOrConstruct($('[name="assign"]'), { multi: true });
  $('[name="rule"]').on('change', () => {
    const rule = $('[name="rule"]').val();
    $('.contest-rule-settings input').attr('disabled', 'disabled');
    $('.contest-rule-settings').hide();
    $(`.contest-rule--${rule} input`).removeAttr('disabled');
    $(`.contest-rule--${rule}`).show();
  }).trigger('change');
  /*
   * PTA: begin, duration and END are kept in sync BOTH ways.
   *  - begin or duration changed → the end date/time follow;
   *  - end date/time changed     → the duration follows (hours, 2 decimals);
   * an end at or before the begin shows a hint and is refused on submit.
   * On save the server takes the end fields as authoritative, so an end
   * typed as 17:45 is stored as exactly 17:45.
   */
  const $hint = $('#pta-endtime-hint');
  const beginMoment = () => moment(`${$('[name="beginAtDate"]').val()} ${$('[name="beginAtTime"]').val()}`, 'YYYY-M-D H:mm');
  const endMoment = () => moment(`${$('[name="endAtDate"]').val()} ${$('[name="endAtTime"]').val()}`, 'YYYY-M-D H:mm');
  const showEndHint = (bad: boolean) => {
    $hint.text(bad ? i18n('The end must be after the begin time.') : '').toggle(bad);
    $('[name="endAtDate"], [name="endAtTime"]').toggleClass('is-invalid', bad);
  };
  $('[name="beginAtDate"], [name="beginAtTime"], [name="duration"]').on('change', () => {
    const begin = beginMoment();
    const duration = +$('[name="duration"]').val();
    if (!begin.isValid() || !(duration > 0)) return;
    const endAt = begin.clone().add(duration, 'hours');
    $('[name="endAtDate"]').val(endAt.format('YYYY-MM-DD'));
    $('[name="endAtTime"]').val(endAt.format('HH:mm'));
    showEndHint(false);
  });
  $('[name="endAtDate"], [name="endAtTime"]').on('change', () => {
    const begin = beginMoment();
    const end = endMoment();
    if (!begin.isValid() || !end.isValid()) return;
    const hours = end.diff(begin, 'minutes', true) / 60;
    if (hours <= 0) {
      showEndHint(true);
      return;
    }
    $('[name="duration"]').val(String(Math.round(hours * 100) / 100));
    showEndHint(false);
  });
  $('form').on('submit', (ev) => {
    const begin = beginMoment();
    const end = endMoment();
    if (begin.isValid() && end.isValid() && !end.isAfter(begin)) {
      ev.preventDefault();
      showEndHint(true);
      Notification.error(i18n('The end must be after the begin time.'));
    }
  });
  $('[name="permission"]').removeAttr('disabled').on('change', () => {
    const type = $('[name="permission"]').val();
    $('[data-perm] input').attr('disabled', 'disabled');
    $('[data-perm]').hide();
    $(`[data-perm="${type}"] input`).removeAttr('disabled');
    $(`[data-perm="${type}"]`).show();
  }).trigger('change');
  if (pagename.endsWith('edit')) {
    let confirmed = false;
    $(document).on('click', '[value="delete"]', (ev) => {
      ev.preventDefault();
      if (confirmed) {
        return request.post('', { operation: 'delete' }).then((res) => {
          window.location.href = res.url;
        });
      }
      const message = `Confirm deleting this ${pagename.split('_')[0]}? Its files and status will be deleted as well.`;
      return confirm(i18n(message)).then((yes) => {
        if (yes) {
          confirmed = true;
          ev.target.click();
        }
      });
    });
    setInterval(() => {
      $('img').each(function () {
        if ($(this).attr('src').startsWith('file://')) {
          $(this).attr('src', $(this).attr('src').replace('file://', './file/'));
        }
      });
    }, 500);
  }
});

export default page;
