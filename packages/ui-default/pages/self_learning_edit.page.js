import $ from 'jquery';
import LanguageSelectAutoComplete from 'vj/components/autocomplete/LanguageSelectAutoComplete';
import ProblemSelectAutoComplete from 'vj/components/autocomplete/ProblemSelectAutoComplete';
import { mountComposer } from 'vj/components/chat-composer';
import { ConfirmDialog } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request, tpl } from 'vj/utils';

const esc = (t) => $('<i>').text(String(t ?? '')).html();
const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];

/*
 * PTA fork: the AI TASK ADVISOR for self-learning sessions.
 *
 * A session exists to observe whether a mistake in one task recurs in the
 * next, so its tasks must interlock on knowledge points. The teacher
 * describes the goal ("train for-loops with sentinel input"); the advisor
 * answers with 3-8 of the domain's programming tasks, a reason for each,
 * the knowledge points they share, and notes on coverage. Follow-up
 * messages refine the set. The teacher adds tasks to the picker freely —
 * one at a time or all — and can keep editing the list by hand.
 *
 * Stateless on the server: this script keeps the short conversation
 * (teacher turns + the compact summaries the server returns) and sends it
 * back with every message.
 */
function initAdvisor(selection) {
  const $box = $('#sl-advisor');
  if (!$box.length) return;
  const available = $box.attr('data-available') === 'yes';
  const turns = []; // [{role:'user'|'assistant', content}]
  let busy = false;

  const selectedDocIds = () => new Set(selection.ids());
  const setSelected = (ids) => selection.set(ids);

  const QUICK = [
    i18n('For and while loops'),
    i18n('Arrays and indexing'),
    i18n('Functions and recursion'),
  ];
  const PLACEHOLDER_FIRST = i18n('What should this session train? e.g. for-loops: reading n values, accumulating, loop bounds');
  const PLACEHOLDER_NEXT = i18n('Refine: \u201cmake them harder\u201d, \u201cswap P7 for nested loops\u201d, \u201conly tasks without arrays\u201d\u2026');

  const shell = () => `
    <div class="sla">
      <div class="sla__head">🤖 <b>${esc(i18n('AI task advisor'))}</b>
        <span class="sla__hint">${esc(i18n('Tell the AI what the session should train; it suggests tasks that share knowledge points — so a mistake in one can be observed again in the next — and explains why. You choose what to add.'))}</span></div>
      ${available ? `
      <div class="sla__chat">
        <div class="sla__msg sla__msg--ai">
          <div class="sla__avatar">🤖</div>
          <div class="sla__bubble">
            <div>${esc(i18n('Hi! Describe what this session should train, or start from one of these:'))}</div>
            <div class="sla__quick">${QUICK.map((q) => `<button type="button" class="sla__quick-btn">${esc(q)}</button>`).join('')}</div>
          </div>
        </div>
      </div>
      <div class="sla__composer">
        <textarea class="sla__input" rows="1" placeholder="${esc(PLACEHOLDER_FIRST)}"></textarea>
        <button type="button" class="sla__send" title="${esc(i18n('Send'))}">➤</button>
      </div>
      <div class="sla__foot">
        <span>${esc(i18n('Enter to send · Shift+Enter for a new line'))}</span>
        <a href="javascript:;" class="sla__reset" hidden>↺ ${esc(i18n('Start over'))}</a>
      </div>` : `<div class="sla__na">${esc(i18n('The AI assistant is not configured (no API key). Pick tasks from the problem set below.'))}</div>`}
    </div>`;
  $box.html(shell());
  if (!available) return;

  const $chat = $box.find('.sla__chat');
  const $input = $box.find('.sla__input');
  // Proportional font + live Markdown rendering (the shared chat composer).
  mountComposer($input, { i18n });
  const $send = $box.find('.sla__send');
  const $reset = $box.find('.sla__reset');

  const scrollDown = () => {
    const el = $chat.get(0);
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };
  const autoGrow = () => {
    const el = $input.get(0);
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  };

  const diffText = (d) => (d ? `${i18n('Difficulty')} ${d}` : '');
  const LEVEL_LABEL = { basic: i18n('basic'), intermediate: i18n('intermediate'), advanced: i18n('advanced') };
  /*
   * One step of the learning path. The number is the position students
   * work through; the level chip, "builds on" and "new here" explain why
   * the task sits there, so the teacher can judge the progression, not
   * just the picks.
   */
  const cardHtml = (t, i, all) => {
    const goal = new Set((t.goalPoints || []).map((x) => x.toLowerCase()));
    const fresh = new Set((t.newPoints || []).map((x) => x.toLowerCase()));
    const last = i === all.length - 1;
    return `
      <div class="sla__step" style="animation-delay:${80 * i}ms">
        <div class="sla__rail"><span class="sla__num">${t.step || i + 1}</span>${last ? '' : '<i></i>'}</div>
        <div class="sla__card" data-doc="${esc(t.docId)}" data-pid="${esc(t.pid)}">
          <div class="sla__card-head">
            <a href="${domainPrefix()}/p/${esc(t.pid)}" target="_blank" rel="noopener"><b>${esc(t.pid)}</b> ${esc(t.title)}</a>
            ${t.level ? `<span class="sla__level sla__level--${esc(t.level)}">${esc(LEVEL_LABEL[t.level] || t.level)}</span>` : ''}
            ${t.hidden ? `<span class="sla__muted">(${esc(i18n('hidden'))})</span>` : ''}
            <span class="sla__muted">${esc(diffText(t.difficulty))}${t.nSubmit ? ` · ${t.nAccept}/${t.nSubmit} ${esc(i18n('accepted'))}` : ''}</span>
            <button type="button" class="sla__add" data-doc="${esc(t.docId)}"></button>
          </div>
          ${(t.buildsOn || (t.newPoints || []).length) ? `<div class="sla__prog">
            ${t.buildsOn ? `<span>↳ ${esc(i18n('builds on'))} <code>${esc(t.buildsOn)}</code></span>` : ''}
            ${(t.newPoints || []).length ? `<span>✦ ${esc(i18n('new here'))}: ${t.newPoints.map((p) => `<span class="sla__pt sla__pt--new">${esc(p)}</span>`).join('')}</span>` : `<span class="sla__muted">✦ ${esc(i18n('deepens the earlier points'))}</span>`}
          </div>` : ''}
          <div class="sla__points">${(t.points || []).map((p) => `<span class="sla__pt${fresh.has(p.toLowerCase()) ? ' sla__pt--new' : goal.has(p.toLowerCase()) ? ' sla__pt--goal' : ''}">${esc(p)}</span>`).join('')}</div>
          <div class="sla__reason">${esc(t.reason || '')}</div>
        </div>
      </div>`;
  };
  const aiMsg = (inner, extraClass = '') => `
    <div class="sla__msg sla__msg--ai ${extraClass}">
      <div class="sla__avatar">🤖</div>
      <div class="sla__bubble">${inner}</div>
    </div>`;
  const replyHtml = (res) => {
    // Every proposed task carries its pid, which is how the selection knows
    // which section to drop it into when the teacher clicks "add".
    selection.learnPids(res.tasks || []);
    return aiMsg(`
      ${res.points?.length ? `<div class="sla__row"><span class="sla__lbl">🎯 ${esc(i18n('Knowledge points for this goal'))}</span> ${res.points.map((p) => `<span class="sla__pt sla__pt--goal">${esc(p)}</span>`).join('')}</div>` : ''}
      ${res.tasks?.length ? `
      ${res.path ? `<div class="sla__path">📈 <b>${esc(i18n('Learning path'))}</b> — ${esc(res.path)}</div>` : ''}
      <div class="sla__cards">${res.tasks.map(cardHtml).join('')}</div>
      ${res.overlap?.length ? `<div class="sla__row sla__row--col"><span class="sla__lbl">🔗 ${esc(i18n('Shared knowledge points'))}</span>
        <ul class="sla__overlap">${res.overlap.map((o) => `<li><span class="sla__pt sla__pt--goal">${esc(o.point)}</span> → ${o.pids.map((p) => `<code>${esc(p)}</code>`).join(', ')}</li>`).join('')}</ul></div>` : ''}
      <div class="sla__row">
        <button type="button" class="rounded primary button sla__add-all" data-docs="${esc(res.tasks.map((t) => t.docId).join(','))}">➕ ${esc(i18n('Add all {0} tasks in this order').replace('{0}', res.tasks.length))}</button>
        <button type="button" class="rounded button sla__reorder" data-docs="${esc(res.tasks.map((t) => t.docId).join(','))}" title="${esc(i18n('Reorder the session\u2019s task list to follow this path (tasks not in the path stay at the end)'))}">↕ ${esc(i18n('Apply this order to my list'))}</button>
        <span class="sla__muted">${esc(i18n('Students work through the session\u2019s tasks in list order.'))}</span>
      </div>`
    : `<div>${esc(i18n('No suitable task was found among the domain\u2019s programming tasks.'))}</div>`}
      ${res.notes ? `<div class="sla__notes">${esc(res.notes)}</div>` : ''}
      <div class="sla__muted sla__meta">${esc(i18n('{0} candidate tasks considered ({1} with knowledge points).').replace('{0}', res.candidates).replace('{1}', res.labeled))}</div>`, 'sla__msg--in');
  };

  const refreshAddButtons = () => {
    const have = selectedDocIds();
    $chat.find('.sla__add').each(function mark() {
      const on = have.has(String($(this).attr('data-doc')));
      $(this).toggleClass('sla__add--on', on)
        .text(on ? `✓ ${i18n('Added')}` : `➕ ${i18n('Add')}`)
        .attr('title', on ? i18n('Click to remove from the session') : i18n('Add to the session'));
    });
  };
  selection.onChange(refreshAddButtons);

  $chat.on('click', '.sla__add', function onAdd() {
    const id = String($(this).attr('data-doc'));
    const cur = [...selectedDocIds()];
    const idx = cur.indexOf(id);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(id);
    setSelected(cur);
    refreshAddButtons();
    $(this).closest('.sla__card').addClass('sla__card--flash');
    setTimeout(() => $(this).closest('.sla__card').removeClass('sla__card--flash'), 600);
  });
  $chat.on('click', '.sla__add-all', function onAddAll() {
    // Appended in path order, so a fresh list IS the path; an existing
    // list keeps its own tasks first (use "Apply this order" to re-sort).
    const ids = String($(this).attr('data-docs') || '').split(',').filter((x) => x);
    setSelected([...selectedDocIds(), ...ids]);
    refreshAddButtons();
    Notification.success(i18n('Added in the suggested order. Review the list below and save.'));
  });
  $chat.on('click', '.sla__reorder', function onReorder() {
    // Path tasks first, in path order; anything else the teacher already
    // picked follows unchanged. Tasks of the path not yet added are added.
    const ids = String($(this).attr('data-docs') || '').split(',').filter((x) => x);
    const cur = [...selectedDocIds()];
    const rest = cur.filter((x) => !ids.includes(x));
    setSelected([...ids, ...rest]);
    refreshAddButtons();
    Notification.success(rest.length
      ? i18n('List reordered: the {0} path tasks come first, your other {1} task(s) follow.').replace('{0}', ids.length).replace('{1}', rest.length)
      : i18n('List reordered to follow the path.'));
  });
  $chat.on('click', '.sla__quick-btn', function onQuick() {
    $input.val(`${i18n('Train students on')} ${$(this).text().toLowerCase()}`).trigger('focus');
    autoGrow();
  });

  /*
   * Progress while the model works. The request is a single round trip,
   * so the stages are paced locally: the typing dots never stop, the bar
   * shimmers, and the status advances through what the server is doing.
   */
  const STAGES = [
    i18n('Reading the knowledge-point catalog\u2026'),
    i18n('Scanning the domain\u2019s programming tasks\u2026'),
    i18n('Finding tasks that share knowledge points\u2026'),
    i18n('Writing the reasons\u2026'),
    i18n('Almost there\u2026'),
  ];
  const typingHtml = () => aiMsg(`
      <div class="sla__typing"><span></span><span></span><span></span></div>
      <div class="sla__progress"><i></i></div>
      <div class="sla__stage">${esc(STAGES[0])}</div>`, 'sla__msg--typing');
  const startProgress = ($el) => {
    let k = 0;
    const timer = setInterval(() => {
      k = Math.min(k + 1, STAGES.length - 1);
      const $st = $el.find('.sla__stage');
      $st.addClass('sla__stage--swap');
      setTimeout(() => $st.text(STAGES[k]).removeClass('sla__stage--swap'), 180);
      if (k === STAGES.length - 1) clearInterval(timer);
    }, 3500);
    return () => clearInterval(timer);
  };

  const ask = async (text) => {
    const message = String(text ?? $input.val() ?? '').trim();
    if (!message || busy) return;
    busy = true;
    $input.val('');
    autoGrow();
    $send.prop('disabled', true);
    $chat.append(`<div class="sla__msg sla__msg--me sla__msg--in"><div class="sla__bubble">${esc(message)}</div></div>`);
    const $wait = $(typingHtml()).appendTo($chat);
    scrollDown();
    const stop = startProgress($wait);
    try {
      const res = await request.post(window.location.pathname, { operation: 'suggest', message, history: JSON.stringify(turns) });
      turns.push({ role: 'user', content: message }, { role: 'assistant', content: res.summary || '' });
      stop();
      $wait.replaceWith(replyHtml(res));
      refreshAddButtons();
      $input.attr('placeholder', PLACEHOLDER_NEXT);
      $reset.prop('hidden', false);
    } catch (e) {
      stop();
      $wait.replaceWith(aiMsg(`<div class="sla__err">⚠ ${esc(e.message)}</div>`, 'sla__msg--in'));
    } finally {
      busy = false;
      $send.prop('disabled', false);
      scrollDown();
      $input.trigger('focus');
    }
  };
  $send.on('click', () => ask());
  $input.on('input', autoGrow).on('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      ask();
    }
  });
  $reset.on('click', () => {
    turns.length = 0;
    $chat.find('.sla__msg').slice(1).remove(); // keep the welcome bubble
    $input.val('').attr('placeholder', PLACEHOLDER_FIRST);
    autoGrow();
    $reset.prop('hidden', true);
  });
  autoGrow();
}

/**
 * PTA fork — TWO SECTIONS, ONE ORDERED LIST.
 *
 * The editor picks PROGRAMMING and FUNCTION tasks in separate sections
 * (matching the rail, the paper and the test/homework editors), but a
 * session is one ordered `pids` list that students walk in sequence. So
 * the two pickers are merged into the hidden `pids` — programming first,
 * then function — on every change and on submit; the handler reads `pids`
 * exactly as before and still refuses quiz/subjective tasks.
 *
 * The AI advisor proposes from both kinds and never sees two pickers: it
 * talks to this facade, which routes each docId to its section by kind.
 * Kinds are learned from the server's prefill (progPids / fnPids), from
 * the advisor's own proposals (each carries its pid), and from whatever
 * a picker currently holds.
 */
function initSelection() {
  const $prog = $('[name="sl_pids_prog"]');
  const $fn = $('[name="sl_pids_fn"]');
  const $pids = $('[name="pids"]');
  const pickers = {
    programming: ProblemSelectAutoComplete.getOrConstruct($prog, { multi: true, clearDefaultValue: false, lockKind: 'programming' }),
    function: ProblemSelectAutoComplete.getOrConstruct($fn, { multi: true, clearDefaultValue: false, lockKind: 'function' }),
  };
  const kindByDoc = {};
  const learn = (docId, kind) => { if (docId && kind) kindByDoc[String(docId)] = kind; };
  const split = (val) => String(val || '').split(',').map((x) => x.trim()).filter((x) => x);
  for (const id of split($prog.val())) learn(id, 'programming');
  for (const id of split($fn.val())) learn(id, 'function');
  const kindOfPid = (pid) => (/^f/i.test(String(pid || '')) ? 'function' : 'programming');
  /*
   * Anything a picker holds tells us its kind. getSelectedItems() is
   * `selectedKeys.map((k) => valueCache[k])`, so a key whose item has not
   * been fetched yet — every prefilled key on the first onChange, before
   * the lookup returns — comes back as `undefined`. Skip those; the keys
   * themselves are learned right after from getSelectedItemKeys(), which
   * never depends on the cache.
   */
  const learnFromPicker = (kind) => {
    for (const it of (pickers[kind].ref?.getSelectedItems?.() || [])) {
      if (!it) continue;
      learn(it.docId ?? it._id ?? it.id, kind);
    }
  };
  const idsOf = (kind) => (pickers[kind].ref?.getSelectedItemKeys?.() || split(kind === 'programming' ? $prog.val() : $fn.val()))
    .map((k) => String(k).trim()).filter((k) => k);
  const merge = () => {
    learnFromPicker('programming'); learnFromPicker('function');
    for (const id of idsOf('programming')) learn(id, 'programming');
    for (const id of idsOf('function')) learn(id, 'function');
    $pids.val([...idsOf('programming'), ...idsOf('function')].join(','));
  };
  const listeners = [];
  const changed = () => { merge(); for (const cb of listeners) cb(); };
  pickers.programming.onChange?.(changed);
  pickers.function.onChange?.(changed);
  $prog.on('change', changed); $fn.on('change', changed);
  $pids.closest('form').on('submit', merge);
  merge();
  return {
    ids: () => [...idsOf('programming'), ...idsOf('function')],
    /** Route by known kind; a docId whose kind is unknown falls back to programming. */
    set: (ids) => {
      const clean = [...new Set(ids.map((x) => String(x).trim()).filter((x) => x))];
      const prog = clean.filter((id) => (kindByDoc[id] || 'programming') !== 'function');
      const fn = clean.filter((id) => kindByDoc[id] === 'function');
      pickers.programming.ref?.setSelectedKeys?.(prog); $prog.val(prog.join(','));
      pickers.function.ref?.setSelectedKeys?.(fn); $fn.val(fn.join(','));
      merge();
    },
    /** The advisor tells us the kind of every task it proposes. */
    learnPids: (tasks) => { for (const t of tasks || []) if (t) learn(t.docId, kindOfPid(t.pid)); },
    /** Fires after either section changes (the advisor re-marks its Add buttons). */
    onChange: (cb) => { listeners.push(cb); },
  };
}

export default new NamedPage(['self_learning_create', 'self_learning_edit'], () => {
  const selection = initSelection();
  // 🌐 Allowed submission languages — the contest editor's picker on the
  // same comma-joined `langs` field; empty = every judge language.
  LanguageSelectAutoComplete.getOrConstruct($('[name="langs"]'), { multi: true });
  initAdvisor(selection);
  $(document).on('click', '[value="delete"]', (ev) => {
    ev.preventDefault();
    new ConfirmDialog({
      $body: tpl.typoMsg(i18n('Confirm deleting this self-learning session? Tutoring conversations will be deleted as well.')),
    }).open().then((action) => {
      if (action !== 'yes') return;
      request.post('', { operation: 'delete' }).then((res) => {
        window.location.href = res.url;
      });
    });
  });
});
