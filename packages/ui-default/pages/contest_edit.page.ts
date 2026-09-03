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
 * PTA test editor: the paper as four sections (contest_edit.html). Three
 * objective sections (true/false, choice, fill-in), each with a total split
 * evenly over its tasks, and a programming section whose tasks carry their
 * own points. Everything is folded into the hidden `paper` JSON field the
 * server turns into the problem order and per-problem weights; `pids` is
 * kept in sync for the clone button and older API clients.
 */
function initPaperEditor() {
  const $obj = $('#tep-objective');
  if (!$obj.length) return;
  const OBJ = ['tf', 'choice', 'blank'];
  const paper = (window as any).UiContext?.paper || {};
  const pickers: Record<string, any> = {};
  const scores: Record<string, number> = { ...(paper.prog?.scores || {}) };
  const esc = (t: any) => $('<i>').text(String(t ?? '')).html();
  const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

  for (const sec of [...OBJ, 'prog']) {
    const $in = $(`[data-pids-for="${sec}"]`);
    const ids = (paper[sec]?.pids || []).map((x: any) => String(x));
    $in.val(ids.join(','));
    pickers[sec] = ProblemSelectAutoComplete.getOrConstruct($in, {
      multi: true,
      clearDefaultValue: false,
      lockKind: sec === 'prog' ? 'programming' : 'objective',
      ...(sec !== 'prog' ? { lockSub: sec } : {}),
    });
    if (sec !== 'prog') $(`[data-total-for="${sec}"]`).val(paper[sec]?.total ? fmt(+paper[sec].total) : '');
  }

  const idsOf = (sec: string) => String($(`[data-pids-for="${sec}"]`).val() || '').split(',').map((x) => x.trim()).filter((x) => x);
  const totalOf = (sec: string) => Math.max(0, +($(`[data-total-for="${sec}"]`).val() || 0) || 0);

  /** Programming rows: one points box per selected task (titles from the picker cache). */
  const renderProg = () => {
    const ids = idsOf('prog');
    const items = (pickers.prog?.ref?.getSelectedItems?.() || []) as any[];
    const titleOf = (id: string) => {
      const it = items.find((x) => String(x?.docId) === id);
      return it ? `${it.pid ? `${it.pid} ` : ''}${it.title || ''}` : `#${id}`;
    };
    const $box = $('#tep-prog-scores');
    if (!ids.length) {
      $box.html(`<p class="help-text">${esc(i18n('Pick programming tasks above, then give each its points.'))}</p>`);
      return;
    }
    $box.html(`<div class="tep__scores-head">${esc(i18n('Points per programming task'))}</div>${ids.map((id, i) => `<div class="tep__prow">`
      + `<span class="tep__prow-idx">${String.fromCharCode(65 + (i % 26))}</span>`
      + `<span class="tep__prow-title" title="${esc(titleOf(id))}">${esc(titleOf(id))}</span>`
      + `<input type="number" min="0" step="0.5" class="textbox tep__pscore" data-score-for="${id}" value="${scores[id] !== undefined ? fmt(+scores[id]) : ''}" placeholder="0">`
      + `<span class="tep__prow-unit">${esc(i18n('pts'))}</span></div>`).join('')}`);
  };

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
    for (const id of idsOf('prog')) sum += +scores[id] || 0;
    const $sum = $('#tep-sum');
    const ok = Math.abs(sum - 100) < 0.005;
    $sum.text(`${i18n('Total')}: ${fmt(sum)} / 100`).toggleClass('is-ok', ok).toggleClass('is-off', !ok);
    $sum.attr('title', ok ? i18n('The test adds up to 100 points.') : i18n('The points of every task should add up to 100.'));
    $('[name="paper"]').val(JSON.stringify({
      tf: { total: totalOf('tf'), pids: idsOf('tf') },
      choice: { total: totalOf('choice'), pids: idsOf('choice') },
      blank: { total: totalOf('blank'), pids: idsOf('blank') },
      prog: { pids: idsOf('prog'), scores: Object.fromEntries(idsOf('prog').map((id) => [id, +scores[id] || 0])) },
    }));
    $('[name="pids"]').val([...OBJ.flatMap(idsOf), ...idsOf('prog')].join(','));
    return sum;
  };

  for (const sec of [...OBJ, 'prog']) {
    pickers[sec].onChange(() => {
      if (sec === 'prog') renderProg();
      refresh();
    });
  }
  $obj.on('input change', '.tep__total', refresh);
  $(document).on('input change', '.tep__pscore', function onScore() {
    scores[String($(this).data('score-for'))] = +($(this).val() || 0) || 0;
    refresh();
  });
  renderProg();
  refresh();
  // Titles arrive asynchronously for prefilled ids; redraw once they are in.
  setTimeout(renderProg, 800);
  setTimeout(renderProg, 2500);

  $obj.closest('form').on('submit', (ev) => {
    const sum = refresh();
    const count = [...OBJ, 'prog'].reduce((a, sec) => a + idsOf(sec).length, 0);
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
  $('[name="beginAtDate"], [name="beginAtTime"], [name="duration"]').on('change', () => {
    const beginAtDate = $('[name="beginAtDate"]').val();
    const beginAtTime = $('[name="beginAtTime"]').val();
    const duration = $('[name="duration"]').val();
    const endAt = moment(`${beginAtDate} ${beginAtTime}`).add(+duration, 'hours').toDate();
    if (endAt) $('[name="endAt"]').val(moment(endAt).format('YYYY-MM-DD HH:mm'));
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
