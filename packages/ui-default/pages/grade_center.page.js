import $ from 'jquery';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

/**
 * PTA fork — GRADE CENTER (grade_center.html).
 *  - The percentages in the header are live: typing one re-computes every
 *    student's Final (weighted mean, normalized by the sum of the
 *    percentages; a missing score counts 0), the cluster sums, the Σ badge
 *    and the class-mean footer.
 *  - ≡ on a cluster heading asks for the cluster's total and splits it
 *    equally over the cluster's activities that have results.
 *  - Save posts the percentages (stored per domain, re-derived on the
 *    server); Reset returns to the equal split.
 *  - Any column heading sorts (student ID, an activity's score, Final);
 *    the search box filters rows by ID or name.
 */
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const lvlClass = (v) => (typeof v !== 'number' ? '' : v >= 80 ? 'gc-lvl-4' : v >= 60 ? 'gc-lvl-3' : v >= 40 ? 'gc-lvl-2' : 'gc-lvl-1');

export default new NamedPage('grade_center', () => {
  const $table = $('#gc-table');
  if (!$table.length) return;
  const cfg = (window.UiContext && UiContext.gradeCenter) || { url: window.location.pathname };

  /* ---------------- live recomputation ---------------- */
  const weights = () => {
    const w = {};
    $('.gc-weight').each(function read() {
      const v = Number.parseFloat($(this).val());
      w[$(this).attr('data-key')] = Number.isFinite(v) && v >= 0 ? v : 0;
    });
    return w;
  };
  const setFinal = ($tr, final) => {
    $tr.attr('data-final', final === null ? '' : final);
    $tr.find('.gc-final').removeClass('gc-lvl-1 gc-lvl-2 gc-lvl-3 gc-lvl-4').addClass(lvlClass(final)).find('b').text(final === null ? '—' : final);
  };
  const recompute = () => {
    const w = weights();
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    $('#gc-sum').text(`Σ ${round2(sum)}%`).toggleClass('is-off', Math.abs(sum - 100) > 0.05);
    const byKind = {};
    $('.gc-weight').each(function add() {
      const k = $(this).attr('data-kind');
      byKind[k] = (byKind[k] || 0) + (w[$(this).attr('data-key')] || 0);
      $(this).closest('.gc-w').toggleClass('is-zero', !(w[$(this).attr('data-key')] > 0));
    });
    $('th[data-group]').each(function setGroup() {
      $(this).find('.gc-group__w').text(round2(byKind[$(this).attr('data-group')] || 0));
    });
    const finals = [];
    $table.find('tbody tr').each(function row() {
      let weighted = 0;
      $(this).find('td[data-key]').each(function cell() {
        const key = $(this).attr('data-key');
        const s = Number.parseFloat($(this).attr('data-score'));
        if (w[key] > 0) weighted += w[key] * (Number.isFinite(s) ? s : 0);
      });
      const final = sum > 0 ? round1(weighted / sum) : null;
      setFinal($(this), final);
      if (final !== null) finals.push(final);
    });
    $('#gc-mean-final').text(finals.length ? round1(finals.reduce((a, b) => a + b, 0) / finals.length) : '—');
    let changed = false;
    $('.gc-weight').each(function mark() {
      const c = Number.parseFloat($(this).val()) !== Number.parseFloat($(this).attr('data-original'));
      $(this).closest('.gc-w').toggleClass('is-changed', c);
      changed = changed || c;
    });
    $('#gc-save').prop('disabled', !changed);
    $('#gc-mode').toggleClass('is-dirty', changed);
    if (changed) $('#gc-mode').text(i18n('unsaved changes'));
  };
  $(document).on('input change', '.gc-weight', recompute);

  /* ---------------- cluster split ---------------- */
  $(document).on('click', '.gc-group__set', function onSplit(ev) {
    ev.stopPropagation();
    const kind = $(this).attr('data-group');
    const $inputs = $(`.gc-weight[data-kind="${kind}"]`);
    const current = round2($inputs.get().reduce((a, el) => a + (Number.parseFloat($(el).val()) || 0), 0));
    const answer = window.prompt(i18n('Total percentage for this cluster (split equally over its activities with results):'), String(current)); // eslint-disable-line no-alert
    if (answer === null) return;
    const total = Number.parseFloat(answer);
    if (!Number.isFinite(total) || total < 0) {
      Notification.error(i18n('Enter a non-negative percentage.'));
      return;
    }
    // Activities without results keep 0 (they are not counted yet); if none has results, split over all.
    let $targets = $inputs.filter(function hasResults() { return !$(this).closest('th').find('.gc-head__state--none').length; });
    if (!$targets.length) $targets = $inputs;
    const each = Math.floor((total / $targets.length) * 100) / 100;
    let left = total;
    $inputs.val(0);
    $targets.each(function set(i) {
      const v = i === $targets.length - 1 ? round2(left) : each;
      left = round2(left - v);
      $(this).val(v);
    });
    recompute();
  });

  /* ---------------- save / reset ---------------- */
  const applyServer = (res, modeText) => {
    for (const a of res.activities || []) {
      const $in = $(`.gc-weight[data-key="${a.key}"]`);
      $in.val(a.weight).attr('data-original', a.weight);
    }
    for (const s of res.students || []) {
      const fin = s.final ?? null;
      setFinal($table.find(`tbody tr[data-uid="${s.uid}"]`), fin);
    }
    recompute();
    $('#gc-mode').text(modeText).removeClass('is-dirty');
  };
  $('#gc-save').on('click', async () => {
    $('#gc-save, #gc-reset').prop('disabled', true);
    try {
      const res = await request.post(cfg.url, { operation: 'weights', weights: JSON.stringify(weights()) });
      applyServer(res, i18n('custom percentages'));
      Notification.success(i18n('Percentages saved.'));
    } catch (e) {
      Notification.error(e.message || i18n('Could not save the percentages.'));
    } finally {
      $('#gc-reset').prop('disabled', false);
      recompute();
    }
  });
  $('#gc-reset').on('click', async () => {
    $('#gc-save, #gc-reset').prop('disabled', true);
    try {
      const res = await request.post(cfg.url, { operation: 'reset' });
      applyServer(res, i18n('equal percentages (default)'));
      Notification.success(i18n('Percentages reset to an equal split.'));
    } catch (e) {
      Notification.error(e.message || i18n('Could not reset the percentages.'));
    } finally {
      $('#gc-reset').prop('disabled', false);
      recompute();
    }
  });

  /* ---------------- sorting (student, any activity, final) ---------------- */
  let sortState = null;
  const valueOf = (tr, key) => {
    if (key === 'uname') return String(tr.getAttribute('data-uname') || '');
    if (key === 'final') return Number.parseFloat(tr.getAttribute('data-final'));
    const td = tr.querySelector(`td[data-key="${key}"]`);
    return td ? Number.parseFloat(td.getAttribute('data-score')) : Number.NaN;
  };
  const applySort = () => {
    $table.find('th[data-sort]').removeAttr('data-dir');
    if (!sortState) return;
    const { key, dir } = sortState;
    const sign = dir === 'asc' ? 1 : -1;
    const rows = $table.find('tbody tr').get();
    rows.sort((a, b) => {
      let c;
      if (key === 'uname') c = valueOf(a, key).localeCompare(valueOf(b, key), undefined, { numeric: true, sensitivity: 'base' });
      else {
        const x = valueOf(a, key);
        const y = valueOf(b, key);
        c = (Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y) ? y : -Infinity);
      }
      return c !== 0 ? sign * c : String(a.getAttribute('data-uname')).localeCompare(String(b.getAttribute('data-uname')), undefined, { numeric: true });
    });
    $table.find('tbody').append(rows);
    $table.find(`th[data-sort="${key}"]`).attr('data-dir', dir);
  };
  $table.on('click', 'th[data-sort]', function onSort(ev) {
    // The percentage box and the title link inside the heading keep their own behaviour.
    if ($(ev.target).closest('.gc-w, a, button').length) return;
    const key = this.getAttribute('data-sort');
    const first = key === 'uname' ? 'asc' : 'desc';
    const dir = sortState && sortState.key === key ? (sortState.dir === 'asc' ? 'desc' : 'asc') : first;
    sortState = { key, dir };
    applySort();
  });

  /* ---------------- filter ---------------- */
  $('#gc-filter').on('input', function onFilter() {
    const q = String($(this).val() || '').trim().toLowerCase();
    $table.find('tbody tr').each(function row() {
      $(this).toggleClass('is-hidden', !!q && !String($(this).attr('data-search') || '').includes(q));
    });
  });

  recompute();
});
