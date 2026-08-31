import $ from 'jquery';
import ProblemSelectAutoComplete from 'vj/components/autocomplete/ProblemSelectAutoComplete';
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
function initAdvisor(picker) {
  const $box = $('#sl-advisor');
  if (!$box.length) return;
  const available = $box.attr('data-available') === 'yes';
  const turns = []; // [{role:'user'|'assistant', content}]
  let busy = false;

  const selectedDocIds = () => new Set((picker.ref?.getSelectedItemKeys?.() || String($('[name="pids"]').val() || '').split(','))
    .map((k) => String(k).trim()).filter((k) => k));
  const setSelected = (ids) => {
    const clean = [...new Set(ids.map((x) => String(x).trim()).filter((x) => x))];
    picker.ref?.setSelectedKeys?.(clean);
    $('[name="pids"]').val(clean.join(','));
  };

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
        <div class="sla__card" data-doc="${esc(t.docId)}">
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
  const replyHtml = (res) => aiMsg(`
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

  const refreshAddButtons = () => {
    const have = selectedDocIds();
    $chat.find('.sla__add').each(function mark() {
      const on = have.has(String($(this).attr('data-doc')));
      $(this).toggleClass('sla__add--on', on)
        .text(on ? `✓ ${i18n('Added')}` : `➕ ${i18n('Add')}`)
        .attr('title', on ? i18n('Click to remove from the session') : i18n('Add to the session'));
    });
  };
  picker.onChange(refreshAddButtons);

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

export default new NamedPage(['self_learning_create', 'self_learning_edit'], () => {
  // Sessions are programming-only: the picker never lists quiz or
  // subjective tasks (the handler refuses them as well).
  const picker = ProblemSelectAutoComplete.getOrConstruct($('[name="pids"]'), { multi: true, clearDefaultValue: false, lockKind: 'programming' });
  initAdvisor(picker);
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
