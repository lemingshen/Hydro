/*
 * PTA fork — the STUDENT ASSISTANT panel: a chat button on every page.
 *
 * An AutoloadPage (runs everywhere), but it shows NOTHING until the server
 * says the assistant is available HERE: one small GET per page view returns
 * the posture for this page — `off` (a running test the student is sitting,
 * a self-learning room, or the feature disabled) draws no button at all,
 * because "no AI during a test" has to mean no button, not a disabled one.
 *
 * Page context — page name, the task on screen, the activity on screen —
 * travels with every message, so "why is this failing?" needs no follow-up
 * question. The conversation is one persistent thread per student, so it
 * continues across pages. The panel's open/closed state and width are kept
 * per tab.
 *
 * DESIGN NOTES. The drawer is an overlay, not a push: students read the
 * task while they chat. Assistant messages carry a small avatar and their
 * tool chips fold into one muted line; the student's messages sit right,
 * unadorned. The composer is a rounded field with the send button inside
 * it, Enter sends, Shift+Enter breaks a line, Esc closes. A wide mode
 * (⤢) exists for code-heavy answers. Everything uses the theme tokens so
 * light and dark both look intended.
 */
import $ from 'jquery';
import { aiMarkdown } from 'vj/components/ai-report/pdf';
import Notification from 'vj/components/notification';
import { AutoloadPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';

const esc = (t) => $('<i>').text(String(t == null ? '' : t)).html();
const domainPrefix = () => (window.location.pathname.match(/^\/d\/[^/]+/) || [''])[0];
const url = () => `${domainPrefix()}/assistant`;
const OPEN_KEY = 'pta:assistant:open';
const WIDE_KEY = 'pta:assistant:wide';

const STYLE = `
:root { --pa-grad: linear-gradient(135deg, #4dabf7 0%, #7048e8 100%); --pa-ink: var(--pta-ink, #33415c); --pa-soft: var(--pta-ink-soft, #5b6b85); --pa-faint: var(--pta-ink-faint, #93a0b5); --pa-line: var(--pta-line, #e8ecf4); --pa-card: var(--pta-card, #fff); --pa-card2: var(--pta-card-2, #f7f9fc); --pa-me: #eaf3fe; --pa-me-ink: #163a5f; }
.pta-dark, .theme--dark { --pa-me: #17293d; --pa-me-ink: #cfe4ff; }

/* ---- launcher ---- */
.pa-btn { position: fixed; right: 22px; bottom: 22px; z-index: 900; height: 50px; padding: 0 18px 0 14px; border-radius: 999px; border: none; cursor: pointer; color: #fff; font-weight: 700; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; background: var(--pa-grad); box-shadow: 0 12px 30px -12px rgba(112,72,232,.75), 0 2px 6px rgba(15,23,42,.12); transition: transform .15s ease, box-shadow .15s ease; }
.pa-btn:hover { transform: translateY(-2px); box-shadow: 0 16px 34px -12px rgba(112,72,232,.85), 0 3px 8px rgba(15,23,42,.14); }
.pa-btn__ico { font-size: 19px; line-height: 1; }
.pa-btn__dot { position: absolute; top: -2px; right: -2px; width: 12px; height: 12px; border-radius: 50%; background: #ff922b; border: 2px solid #fff; display: none; }
.pa-btn.has-new .pa-btn__dot { display: block; }
@media (max-width: 640px) { .pa-btn span.pa-btn__label { display: none; } .pa-btn { padding: 0 14px; } }

/* ---- drawer ---- */
.pa { position: fixed; top: 0; right: 0; bottom: 0; z-index: 950; width: min(460px, 100vw); display: flex; flex-direction: column; background: var(--pa-card); border-left: 1px solid var(--pa-line); box-shadow: -18px 0 48px -22px rgba(15,23,42,.45); transform: translateX(calc(100% + 24px)); transition: transform .24s cubic-bezier(.2,.8,.2,1), width .18s ease; }
.pa.is-open { transform: none; }
.pa.is-wide { width: min(700px, 100vw); }
.pa__head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; color: #fff; background: var(--pa-grad); flex: 0 0 auto; }
.pa__avatar { width: 32px; height: 32px; border-radius: 50%; background: rgba(255,255,255,.22); display: grid; place-items: center; font-size: 17px; flex: 0 0 auto; }
.pa__titles { flex: 1; min-width: 0; }
.pa__title { font-weight: 800; font-size: 15px; line-height: 1.15; }
.pa__sub { font-size: 11.5px; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa__chip { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,.22); white-space: nowrap; }
.pa__chip--tutor { background: #f08c00; }
.pa__ib { width: 30px; height: 30px; border-radius: 8px; border: none; background: transparent; color: #fff; cursor: pointer; font-size: 15px; display: grid; place-items: center; opacity: .85; transition: background .12s ease, opacity .12s ease; }
.pa__ib:hover { background: rgba(255,255,255,.18); opacity: 1; }
.pa__ib.is-on { background: rgba(255,255,255,.28); opacity: 1; }
.pa__ctx { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 14px; border-bottom: 1px solid var(--pa-line); background: var(--pa-card2); font-size: 11.5px; color: var(--pa-soft); flex: 0 0 auto; }
.pa__ctx-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--pa-line); background: var(--pa-card); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pa__ctx-pill--tutor { border-color: #ffd28a; background: #fff8ec; color: #b45309; }
.pta-dark .pa__ctx-pill--tutor, .theme--dark .pa__ctx-pill--tutor { background: #2b2214; border-color: #7a5316; color: #ffc078; }

/* ---- messages ---- */
.pa__body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pa__msgs { flex: 1; overflow-y: auto; padding: 14px 14px 6px; display: flex; flex-direction: column; gap: 12px; scroll-behavior: smooth; }
.pa__row { display: flex; gap: 8px; align-items: flex-end; }
.pa__row--me { justify-content: flex-end; }
.pa__mav { width: 26px; height: 26px; border-radius: 50%; background: var(--pa-grad); color: #fff; display: grid; place-items: center; font-size: 13px; flex: 0 0 auto; margin-bottom: 2px; }
.pa__m { max-width: 86%; padding: 10px 13px; border-radius: 16px; font-size: 13.5px; line-height: 1.6; word-break: break-word; }
.pa__m--me { background: var(--pa-me); color: var(--pa-me-ink); border-bottom-right-radius: 5px; white-space: pre-wrap; }
.pa__m--ai { background: var(--pa-card2); color: var(--pa-ink); border: 1px solid var(--pa-line); border-bottom-left-radius: 5px; }
.pa__m--ai > :first-child { margin-top: 0; } .pa__m--ai > :last-child { margin-bottom: 0; }
.pa__m--ai p { margin: 0 0 9px; }
.pa__m--ai ul, .pa__m--ai ol { margin: 4px 0 9px; padding-left: 20px; }
.pa__m--ai li { margin: 2px 0; }
.pa__m--ai h1, .pa__m--ai h2, .pa__m--ai h3 { font-size: 13.5px; font-weight: 800; margin: 10px 0 5px; color: var(--pa-ink); }
.pa__m--ai code { font-size: 12.5px; padding: 1px 5px; border-radius: 5px; background: rgba(112,72,232,.08); }
.pa__m--ai pre { margin: 6px 0 9px; padding: 10px 12px; border-radius: 10px; background: #1e1e2e; color: #e6e6e6; overflow-x: auto; font-size: 12px; line-height: 1.5; }
.pa__m--ai pre code { background: transparent; padding: 0; color: inherit; font-size: inherit; }
.pa__m--ai table { border-collapse: collapse; font-size: 12.5px; margin: 6px 0 9px; }
.pa__m--ai th, .pa__m--ai td { border: 1px solid var(--pa-line); padding: 4px 8px; }
.pa__m--ai blockquote { margin: 6px 0; padding: 4px 10px; border-left: 3px solid #a5d0f7; color: var(--pa-soft); }
.pa__tools { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--pa-line); font-size: 10.5px; color: var(--pa-faint); display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; }
.pa__tools b { font-weight: 600; }
.pa__tool { padding: 1px 7px; border-radius: 999px; background: rgba(112,72,232,.07); }
.pa__typing { display: inline-flex; gap: 4px; padding: 12px 14px; border-radius: 16px; border-bottom-left-radius: 5px; background: var(--pa-card2); border: 1px solid var(--pa-line); }
.pa__typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--pa-faint); animation: paDot 1.2s infinite ease-in-out; }
.pa__typing i:nth-child(2) { animation-delay: .15s; } .pa__typing i:nth-child(3) { animation-delay: .3s; }
@keyframes paDot { 0%, 80%, 100% { transform: translateY(0); opacity: .45; } 40% { transform: translateY(-4px); opacity: 1; } }

/* ---- empty state ---- */
.pa__hello { margin: 6px 2px 0; padding: 16px; border-radius: 16px; border: 1px solid var(--pa-line); background: var(--pa-card2); }
.pa__hello-ico { width: 40px; height: 40px; border-radius: 12px; background: var(--pa-grad); color: #fff; display: grid; place-items: center; font-size: 20px; margin-bottom: 10px; }
.pa__hello b { display: block; font-size: 14.5px; color: var(--pa-ink); margin-bottom: 4px; }
.pa__hello p { margin: 0 0 12px; font-size: 13px; line-height: 1.55; color: var(--pa-soft); }
.pa__sugg { display: flex; flex-direction: column; gap: 6px; }
.pa__sugg button { text-align: left; font-size: 12.5px; padding: 8px 11px; border-radius: 10px; border: 1px solid var(--pa-line); background: var(--pa-card); color: var(--pa-ink); cursor: pointer; transition: border-color .12s ease, transform .12s ease; }
.pa__sugg button:hover { border-color: #4dabf7; transform: translateX(2px); }

/* ---- composer ---- */
.pa__foot { padding: 10px 14px 12px; border-top: 1px solid var(--pa-line); background: var(--pa-card); flex: 0 0 auto; }
.pa__field { position: relative; display: flex; align-items: flex-end; border: 1.5px solid var(--pa-line); border-radius: 16px; background: var(--pa-card2); transition: border-color .12s ease, box-shadow .12s ease; }
.pa__field:focus-within { border-color: #4dabf7; box-shadow: 0 0 0 3px rgba(77,171,247,.18); }
.pa__in { flex: 1; resize: none; min-height: 42px; max-height: 160px; padding: 11px 48px 11px 14px; font-size: 13.5px; line-height: 1.45; border: none; background: transparent; color: var(--pa-ink); outline: none; }
.pa__send { position: absolute; right: 6px; bottom: 6px; width: 32px; height: 32px; border-radius: 10px; border: none; cursor: pointer; color: #fff; background: var(--pa-grad); display: grid; place-items: center; font-size: 14px; transition: transform .12s ease, opacity .12s ease; }
.pa__send:hover { transform: scale(1.06); }
.pa__send:disabled { opacity: .45; cursor: default; transform: none; }
.pa__meta { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 11px; color: var(--pa-faint); }
.pa__quota { display: inline-flex; align-items: center; gap: 6px; }
.pa__quota i { display: inline-block; width: 48px; height: 4px; border-radius: 999px; background: var(--pa-line); overflow: hidden; position: relative; }
.pa__quota i b { position: absolute; inset: 0 auto 0 0; background: var(--pa-grad); }

/* ---- prefs ---- */
.pa__prefs { flex: 1; overflow-y: auto; padding: 14px; font-size: 13px; }
.pa__prefs h4 { margin: 14px 0 8px; font-size: 11px; color: var(--pa-faint); text-transform: uppercase; letter-spacing: .06em; }
.pa__prefs h4:first-child { margin-top: 0; }
.pa__pref { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--pa-line); }
.pa__pref select { font-size: 13px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--pa-line); background: var(--pa-card); color: var(--pa-ink); }
.pa__fact { display: flex; gap: 8px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--pa-line); line-height: 1.45; }
.pa__fact span { flex: 1; }
.pa__fact button { font-size: 11px; border: 1px solid #ffc9c9; border-radius: 999px; padding: 1px 8px; background: #fff5f5; color: #c92a2a; cursor: pointer; }
.pa__note { font-size: 12px; color: var(--pa-faint); line-height: 1.5; }
`;

function ensureStyle() {
  if (document.getElementById('pa-style')) return;
  $('<style>').attr('id', 'pa-style').text(STYLE).appendTo(document.head);
}

function pageContext() {
  const uc = window.UiContext || {};
  const pid = uc.pdoc && uc.pdoc.docId;
  const tdoc = uc.tdoc;
  const tid = tdoc && (tdoc._id || tdoc.docId);
  return {
    name: document.documentElement.getAttribute('data-page') || '',
    ...(pid ? { pid } : {}),
    ...(tid ? { tid: String(tid) } : {}),
  };
}

function suggestionsFor(ctx, posture) {
  const s = [];
  if (ctx.pid) s.push(posture === 'tutor' ? i18n('Help me understand this task’s statement') : i18n('Why is my last submission failing?'));
  s.push(i18n('What am I weak at right now?'));
  s.push(i18n('What is due soon, and what should I do first?'));
  s.push(i18n('Plan my practice for this week'));
  return s;
}

const aiRow = (html, tools) => `<div class="pa__row"><div class="pa__mav">💬</div><div class="pa__m pa__m--ai">${html}${(tools || []).length ? `<div class="pa__tools"><b>${esc(i18n('Looked up'))}:</b> ${tools.map((t) => `<span class="pa__tool">${esc(t.replace(/_/g, ' '))}</span>`).join('')}</div>` : ''}</div></div>`;
const meRow = (text) => `<div class="pa__row pa__row--me"><div class="pa__m pa__m--me">${esc(text)}</div></div>`;

function renderMessages($msgs, messages, ctx, posture) {
  if (!messages.length) {
    $msgs.html(`<div class="pa__hello"><div class="pa__hello-ico">💬</div><b>${esc(i18n('Hi! I’m your course assistant.'))}</b>
      <p>${esc(i18n('I know your knowledge map, your submissions and what is due. Ask me about a concept, a verdict, what to practise, or how to plan your week.'))}</p>
      <div class="pa__sugg">${suggestionsFor(ctx, posture).map((t) => `<button type="button" data-q="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`);
    return;
  }
  $msgs.html(messages.map((m) => (m.role === 'user' ? meRow(m.content) : aiRow(aiMarkdown.render(String(m.content || '')), m.tools))).join(''));
  $msgs.scrollTop($msgs[0].scrollHeight);
}

function renderPrefs($box, profile, onSave) {
  const d = profile.declared || {};
  const sel = (name, opts, cur) => `<select data-pref="${name}"><option value="">${esc(i18n('no preference'))}</option>${opts.map(([v, l]) => `<option value="${v}"${cur === v ? ' selected' : ''}>${esc(i18n(l))}</option>`).join('')}</select>`;
  $box.html(`
    <h4>${esc(i18n('How I explain'))}</h4>
    <div class="pa__pref"><span>${esc(i18n('Style'))}</span>${sel('style', [['examples', 'examples first'], ['theory', 'theory first']], d.style)}</div>
    <div class="pa__pref"><span>${esc(i18n('Length'))}</span>${sel('length', [['short', 'short'], ['thorough', 'thorough']], d.length)}</div>
    <div class="pa__pref"><span>${esc(i18n('Tone'))}</span>${sel('tone', [['encouraging', 'encouraging'], ['direct', 'direct']], d.tone)}</div>
    <h4>${esc(i18n('Goals'))}</h4>
    ${(profile.goals || []).length ? profile.goals.map((g) => `<div class="pa__fact"><span>🎯 ${esc(g.text)}${g.by ? ` <small>(${esc(new Date(g.by).toLocaleDateString())})</small>` : ''}</span></div>`).join('') : `<div class="pa__note">${esc(i18n('None yet — tell me a goal in the chat.'))}</div>`}
    <h4>${esc(i18n('What I’ve learned about you'))}</h4>
    ${(profile.learned || []).length ? profile.learned.map((l, i) => `<div class="pa__fact"><span>${esc(l.fact)}</span><button type="button" data-forget="${i}">${esc(i18n('forget'))}</button></div>`).join('') : `<div class="pa__note">${esc(i18n('Nothing yet. I only remember what you tell me, and you can delete anything here.'))}</div>`}
  `);
  $box.find('select').on('change', () => onSave({
    style: $box.find('[data-pref="style"]').val(), length: $box.find('[data-pref="length"]').val(), tone: $box.find('[data-pref="tone"]').val(),
  }));
  $box.find('[data-forget]').on('click', function onForget() { onSave({ forget: +$(this).data('forget') }); });
}

export default new AutoloadPage('assistantPage', async () => {
  const uc = window.UserContext || {};
  if (!uc._id || uc._id <= 1) return; // guests have nothing personal to ask about
  const ctx = pageContext();
  if (/^self_learning/.test(ctx.name)) return; // the tutor's rooms
  ensureStyle();
  let state;
  try {
    state = await request.get(`${url()}?${$.param(ctx)}`);
  } catch (e) {
    return; // 403 / not configured: no button
  }
  if (!state.enabled || state.posture === 'off') return; // no AI here — no button, not a disabled one

  const tutor = state.posture === 'tutor';
  const $btn = $(`<button type="button" class="pa-btn" title="${esc(i18n('Ask your assistant'))}"><span class="pa-btn__ico">💬</span><span class="pa-btn__label">${esc(i18n('Assistant'))}</span><span class="pa-btn__dot"></span></button>`).appendTo(document.body);
  const $pa = $(`<div class="pa${sessionStorage.getItem(WIDE_KEY) ? ' is-wide' : ''}" role="dialog" aria-label="${esc(i18n('Your assistant'))}">
    <div class="pa__head">
      <div class="pa__avatar">💬</div>
      <div class="pa__titles"><div class="pa__title">${esc(i18n('Your assistant'))}</div><div class="pa__sub">${esc(tutor ? i18n('Open homework — I help you think, not solve.') : i18n('Ask about tasks, concepts, weak points or planning'))}</div></div>
      <span class="pa__chip${tutor ? ' pa__chip--tutor' : ''}">${esc(tutor ? i18n('tutor mode') : i18n('ready'))}</span>
      <button type="button" class="pa__ib pa__wide" title="${esc(i18n('Wider'))}">⤢</button>
      <button type="button" class="pa__ib pa__prefs-btn" title="${esc(i18n('What I know about you'))}">⚙</button>
      <button type="button" class="pa__ib pa__reset" title="${esc(i18n('Start over'))}">🗑</button>
      <button type="button" class="pa__ib pa__close" title="${esc(i18n('Close'))}">✕</button>
    </div>
    <div class="pa__ctx" hidden></div>
    <div class="pa__body">
      <div class="pa__msgs"></div>
      <div class="pa__prefs" hidden></div>
    </div>
    <div class="pa__foot">
      <div class="pa__field">
        <textarea class="pa__in" rows="1" placeholder="${esc(i18n('Ask about a task, a concept, your weak points, or what to do next…'))}"></textarea>
        <button type="button" class="pa__send" title="${esc(i18n('Send'))}">➤</button>
      </div>
      <div class="pa__meta"><span>${esc(i18n('Enter to send · Shift+Enter for a new line · Esc to close'))}</span><span class="pa__quota"></span></div>
    </div>
  </div>`).appendTo(document.body);

  const $msgs = $pa.find('.pa__msgs');
  const $in = $pa.find('.pa__in');
  const $send = $pa.find('.pa__send');
  const $prefs = $pa.find('.pa__prefs');
  let messages = state.messages || [];
  let profile = state.profile || { declared: {}, goals: [], learned: [] };
  let busy = false;

  // Page context strip: what the assistant can see right now.
  const pills = [];
  if (state.activity) pills.push(`<span class="pa__ctx-pill${tutor ? ' pa__ctx-pill--tutor' : ''}">${tutor ? '📘' : '📗'} ${esc(state.activity)}</span>`);
  if (ctx.pid && window.UiContext && UiContext.pdoc) pills.push(`<span class="pa__ctx-pill" title="${esc(UiContext.pdoc.title || '')}">📄 ${esc(UiContext.pdoc.pid || UiContext.pdoc.docId)} ${esc(UiContext.pdoc.title || '')}</span>`);
  if (pills.length) $pa.find('.pa__ctx').html(`<span>${esc(i18n('I can see'))}:</span>${pills.join('')}`).prop('hidden', false);

  const quota = () => {
    const used = state.turnsToday || 0; const cap = state.turnsCap || 60;
    $pa.find('.pa__quota').html(`<i><b style="width:${Math.min(100, Math.round((used / cap) * 100))}%"></b></i>${esc(`${used} / ${cap}`)}`).attr('title', i18n('messages today'));
  };
  const open = () => { $pa.addClass('is-open'); sessionStorage.setItem(OPEN_KEY, '1'); $btn.removeClass('has-new'); setTimeout(() => $in.trigger('focus'), 220); };
  const close = () => { $pa.removeClass('is-open'); sessionStorage.removeItem(OPEN_KEY); };
  const showPrefs = (on) => {
    $prefs.prop('hidden', !on); $msgs.toggle(!on); $pa.find('.pa__foot').toggle(!on); $pa.find('.pa__prefs-btn').toggleClass('is-on', on);
  };

  renderMessages($msgs, messages, ctx, state.posture);
  quota();
  if (sessionStorage.getItem(OPEN_KEY)) open();

  const send = async (text) => {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true; $send.prop('disabled', true);
    showPrefs(false);
    messages = [...messages, { role: 'user', content: text }];
    renderMessages($msgs, messages, ctx, state.posture);
    $in.val('').css('height', '');
    const $typing = $('<div class="pa__row"><div class="pa__mav">💬</div><div class="pa__typing"><i></i><i></i><i></i></div></div>').appendTo($msgs);
    $msgs.scrollTop($msgs[0].scrollHeight);
    try {
      const res = await request.post(url(), { operation: 'message', text, ...ctx });
      messages = [...messages, { role: 'assistant', content: res.reply, tools: res.tools || [] }];
      state.turnsToday = res.turnsToday; state.turnsCap = res.turnsCap;
      quota();
      if (!$pa.hasClass('is-open')) $btn.addClass('has-new');
    } catch (e) {
      messages = messages.slice(0, -1);
      $in.val(text);
      Notification.error(e.message);
    } finally {
      $typing.remove();
      busy = false; $send.prop('disabled', false);
      renderMessages($msgs, messages, ctx, state.posture);
      $in.trigger('focus');
    }
  };

  $btn.on('click', () => ($pa.hasClass('is-open') ? close() : open()));
  $pa.find('.pa__close').on('click', close);
  $pa.find('.pa__wide').on('click', () => {
    const wide = !$pa.hasClass('is-wide');
    $pa.toggleClass('is-wide', wide);
    if (wide) sessionStorage.setItem(WIDE_KEY, '1'); else sessionStorage.removeItem(WIDE_KEY);
  });
  $(document).on('keydown.paAssistant', (ev) => { if (ev.key === 'Escape' && $pa.hasClass('is-open')) close(); });
  $send.on('click', () => send($in.val()));
  $in.on('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send($in.val()); }
  }).on('input', function grow() { this.style.height = ''; this.style.height = `${Math.min(160, this.scrollHeight)}px`; });
  $msgs.on('click', '[data-q]', function ask() { send($(this).data('q')); });
  $pa.find('.pa__reset').on('click', async () => {
    try {
      await request.post(url(), { operation: 'reset' });
      messages = []; renderMessages($msgs, messages, ctx, state.posture);
      showPrefs(false);
    } catch (e) { Notification.error(e.message); }
  });
  $pa.find('.pa__prefs-btn').on('click', () => {
    const on = $prefs.prop('hidden');
    showPrefs(on);
    if (on) {
      // Named, not arguments.callee — modules are strict mode.
      const save = async (patch) => {
        try {
          const res = await request.post(url(), { operation: 'prefs', ...patch });
          profile = { ...profile, ...res.profile };
          renderPrefs($prefs, profile, save);
        } catch (e) { Notification.error(e.message); }
      };
      renderPrefs($prefs, profile, save);
    }
  });
});
