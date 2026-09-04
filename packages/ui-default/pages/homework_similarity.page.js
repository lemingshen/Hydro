import $ from 'jquery';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request, tpl } from 'vj/utils';

/**
 * PTA fork — the homework CODE SIMILARITY report (teacher page).
 *
 * The report itself is server-rendered (homework_similarity.html from the
 * stored Dolos report); this script adds what needs a browser:
 *   - "Run the check" posts { operation: 'run' } and polls
 *     { operation: 'status' } until the background run ends, then reloads;
 *     a page opened while a run is in flight polls too;
 *   - the threshold slider filters the pair rows client-side (the stored
 *     report keeps every pair at or above the storage floor, so lowering
 *     the slider reveals context without another run);
 *   - "Compare" opens the two submissions side by side. Dolos' CSV report
 *     carries no fragment positions, so lines that are verbatim identical
 *     in both files are shaded as a rough visual cue — the similarity
 *     figure itself is token-based and also counts renamed/re-ordered
 *     code.
 */

const PRISM_LANG = {
  py: 'python', cc: 'cpp', c: 'c', pas: 'pascal', java: 'java', kt: 'kotlin', js: 'javascript', ts: 'typescript', go: 'go', rs: 'rust', rb: 'ruby', cs: 'csharp', php: 'php', bash: 'bash',
};
const prismLang = (lang) => PRISM_LANG[String(lang || '').split('.')[0]] || 'none';
const esc = (t) => $('<i>').text(String(t ?? '')).html();
const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString() : '-');

/** Lines worth shading when they appear verbatim in both files (after whitespace normalization). */
function sharedLineSet(a, b) {
  const norm = (line) => line.replace(/\s+/g, ' ').trim();
  const trivial = (line) => line.length < 12 || /^[{}();,[\]]*$/.test(line) || /^(?:#include|import|using|package)\b/.test(line);
  const setOf = (code) => new Set(String(code || '').split('\n').map(norm).filter((l) => !trivial(l)));
  const sa = setOf(a);
  const sb = setOf(b);
  const shared = new Set();
  for (const l of sa) if (sb.has(l)) shared.add(l);
  return { shared, norm };
}

/** Syntax-highlight one line (Prism's grammar for the language, or plain escaped text). */
function lineHighlighter(prism, lang) {
  const name = prismLang(lang);
  const grammar = prism && prism.Prism && prism.Prism.languages && prism.Prism.languages[name];
  if (!grammar) return esc;
  return (line) => {
    try {
      return prism.highlight(line, grammar, name);
    } catch (e) {
      return esc(line);
    }
  };
}

function paneHtml(side, shared, norm, hl) {
  const lines = String(side.code || '').split('\n');
  const width = String(lines.length).length;
  // Per-line highlighting keeps the line wrappers (Prism's block mode would
  // re-tokenize the whole element and drop them); a comment or string that
  // spans lines is only styled approximately, which is fine for a
  // side-by-side read.
  const body = lines.map((line, i) => {
    const cls = shared.has(norm(line)) ? ' sim-line--shared' : '';
    return `<span class="sim-line${cls}"><span class="sim-ln">${String(i + 1).padStart(width, ' ')}</span>${hl(line)}\n</span>`;
  }).join('');
  const verdict = side.accepted ? `<span class="pta-chip pta-chip--ok">${esc(i18n(side.statusText))}</span>` : `<span class="pta-chip">${esc(i18n(side.statusText))}</span>`;
  return `<div class="sim-pane">
    <div class="sim-pane__head">
      <b>${esc(side.name || side.uname)}</b><small class="text-gray">${esc(side.uname)}</small>
      ${verdict}<span class="pta-chip">${esc(i18n('Score'))} ${esc(side.score)}</span>
      <span class="pta-chip">${esc(side.langName || side.lang)}</span>
      <span class="text-gray">${esc(fmtTs(side.submitAt))}</span>
      ${side.recordUrl ? `<a href="${esc(side.recordUrl)}" target="_blank" rel="noopener">${esc(i18n('Open record'))} ↗</a>` : ''}
    </div>
    <div class="sim-pane__body"><pre class="sim-pre"><code class="language-${prismLang(side.lang)}">${body}</code></pre></div>
  </div>`;
}

async function openCompare(left, right, similarity) {
  let data;
  try {
    data = await request.get(`${window.location.pathname}?left=${left}&right=${right}`);
  } catch (e) {
    Notification.error(e.message || i18n('Could not load the submissions.'));
    return;
  }
  let prism = null;
  try {
    prism = (await import('vj/components/highlighter/prismjs')).default;
  } catch (e) { /* highlighting is optional */ }
  const { shared, norm } = sharedLineSet(data.left.code, data.right.code);
  const $modal = $(`<div class="sim-cmp" role="dialog">
    <div class="sim-cmp__box">
      <div class="sim-cmp__head">
        <b>${esc(i18n('Side by side'))}</b>
        ${similarity != null ? `<span class="pta-chip pta-chip--bad">${esc(i18n('Similarity'))} ${esc(Math.round(similarity * 1000) / 10)}%</span>` : ''}
        <span class="text-gray">${esc(i18n('Shaded lines are verbatim identical in both files; Dolos\u2019 similarity also counts renamed or re-ordered code.'))}</span>
        <button type="button" class="sim-cmp__close" title="${esc(i18n('Close'))}">×</button>
      </div>
      <div class="sim-cmp__panes">${paneHtml(data.left, shared, norm, lineHighlighter(prism, data.left.lang))}${paneHtml(data.right, shared, norm, lineHighlighter(prism, data.right.lang))}</div>
      <div class="sim-cmp__foot">${esc(i18n('Esc closes this view.'))}</div>
    </div>
  </div>`);
  $('body').append($modal);
  const close = () => {
    $modal.remove();
    $(document).off('keydown.simcmp');
  };
  $modal.on('click', (ev) => { if (ev.target === $modal[0]) close(); });
  $modal.find('.sim-cmp__close').on('click', close);
  $(document).on('keydown.simcmp', (ev) => { if (ev.key === 'Escape') close(); });
}

/**
 * Homework page (staff): the "Check code similarity now" button of the
 * Code Similarity card. Starts the background run through the report
 * route and moves to the report, which shows the progress and refreshes
 * itself when the run ends. A run already in flight when the page opens
 * is polled here so the card's status line stays current.
 */
function initHomeworkCard() {
  const $btn = $('#hw-sim-run');
  if (!$btn.length) return;
  const url = $btn.attr('data-url');
  const state = (window.UiContext && UiContext.hwSimilarity) || {};
  let polling = null;
  const pollCard = () => {
    if (polling) return;
    polling = setInterval(async () => {
      try {
        const st = await request.post(url, { operation: 'status' });
        if (st.status === 'running') {
          $('#hw-sim-status').html(`<span class="pta-chip pta-chip--blue">⏳ ${esc(i18n('A check is running'))}${st.progress ? ` · ${esc(st.progress.done)}/${esc(st.progress.total)} · ${esc(st.progress.label)}` : ''}</span>`);
          return;
        }
        clearInterval(polling);
        polling = null;
        window.location.reload(); // the card is server-rendered from the stored report
      } catch (e) {
        clearInterval(polling);
        polling = null;
      }
    }, 4000);
  };
  if (state.status === 'running') pollCard();
  $btn.on('click', async () => {
    const action = await new ConfirmDialog({
      $body: tpl.typoMsg(i18n('Compare every student\u2019s submissions to the programming tasks of this homework now? The check runs in the background and you will be taken to the report.')),
    }).open();
    if (action !== 'yes') return;
    $btn.prop('disabled', true);
    try {
      const res = await request.post(url, { operation: 'run' });
      if (res.outcome === 'started' || res.outcome === 'busy') {
        Notification.info(res.outcome === 'busy' ? i18n('A check is already running.') : i18n('The similarity check is running in the background; this page refreshes when it is done.'));
        window.location.href = url;
        return;
      }
      if (res.outcome === 'disabled') Notification.error(i18n('The code-similarity check is disabled in the system settings (similarity.enabled).'));
      $btn.prop('disabled', false);
    } catch (e) {
      Notification.error(e.message || i18n('Could not start the check.'));
      $btn.prop('disabled', false);
    }
  });
}

export default new NamedPage(['homework_similarity', 'homework_detail'], (pagename) => {
  if (pagename === 'homework_detail') {
    initHomeworkCard();
    return;
  }
  const view = (window.UiContext && UiContext.similarity) || {};

  /* ---------------- threshold filter ---------------- */
  const $slider = $('#sim-threshold');
  const $val = $('#sim-threshold-val');
  const $count = $('#sim-filter-count');
  function applyFilter() {
    if (!$slider.length) return;
    const min = (+$slider.val() || 0) / 100;
    $val.text(`${Math.round(min * 100)}%`);
    let shown = 0;
    let total = 0;
    $('.sim-row').each(function filterRow() {
      const sim = +$(this).attr('data-sim') || 0;
      const hide = sim < min;
      $(this).toggleClass('sim-row--hidden', hide);
      total += 1;
      if (!hide) shown += 1;
    });
    $('.sim-group').each(function groupState() {
      const $g = $(this);
      const visible = $g.find('.sim-row').not('.sim-row--hidden').length;
      $g.find('.sim-none-visible').toggle($g.find('.sim-row').length > 0 && visible === 0);
    });
    $count.text(total ? i18n('{0} of {1} stored pairs shown').replace('{0}', shown).replace('{1}', total) : '');
  }
  $slider.on('input change', applyFilter);
  applyFilter();

  /* ---------------- compare ---------------- */
  $(document).on('click', '.sim-compare', function onCompare() {
    const $row = $(this).closest('tr');
    openCompare($(this).attr('data-left'), $(this).attr('data-right'), $row.length ? +$row.attr('data-sim') : null);
  });

  /* ---------------- run + poll ---------------- */
  let polling = null;
  function poll() {
    if (polling) return;
    polling = setInterval(async () => {
      try {
        const st = await request.post(window.location.pathname, { operation: 'status' });
        if (st.status === 'running') {
          if (st.progress) $('#sim-progress').text(`${i18n('Comparing submissions…')} ${st.progress.done}/${st.progress.total} · ${st.progress.label}`);
          return;
        }
        clearInterval(polling);
        polling = null;
        window.location.reload();
      } catch (e) {
        clearInterval(polling);
        polling = null;
        Notification.error(e.message || i18n('Lost contact with the server.'));
      }
    }, 3000);
  }
  if (view.status === 'running') poll();

  $('#sim-run').on('click', async function onRun() {
    const $btn = $(this);
    $btn.prop('disabled', true);
    try {
      const res = await request.post(window.location.pathname, { operation: 'run' });
      if (res.outcome === 'started') {
        Notification.info(i18n('The similarity check is running in the background; this page refreshes when it is done.'));
        $('#sim-state').html(`<div class="sim-state__text"><span class="sim-spin"></span><span id="sim-progress">${esc(i18n('Comparing submissions…'))}</span></div>`);
        poll();
      } else if (res.outcome === 'busy') {
        Notification.warn(i18n('A check is already running.'));
        poll();
      } else if (res.outcome === 'disabled') {
        Notification.error(i18n('The code-similarity check is disabled in the system settings (similarity.enabled).'));
        $btn.prop('disabled', false);
      } else {
        $btn.prop('disabled', false);
      }
    } catch (e) {
      Notification.error(e.message || i18n('Could not start the check.'));
      $btn.prop('disabled', false);
    }
  });
});
