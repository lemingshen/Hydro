import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

/**
 * Site-wide policy: programming problems open directly in Scratchpad mode —
 * and the IDE gains a PTA-style problem rail on the left.
 *
 * Every surface views problems through the problem page (the problem set,
 * contests, homework, and training all route through `problem_detail`; the
 * contest/homework variants set UiContext.tdoc), so auto-entering there
 * covers all domains. The standalone submit page is retired for programming
 * problems and bounces back to the problem page.
 *
 * The rail lists all tasks of the current activity:
 * - Self-learning sessions expose UiContext.slProblems (title, kind, status),
 *   rendering numbered chips with a check for accepted, red for tried, a
 *   dashed border for quiz problems, and the current one outlined.
 * - Contests and homework expose tdoc.pids, rendering the classic A/B/C grid
 *   with contest-scoped links.
 * Gating is inherited from the page's own "Open Scratchpad" control, so
 * problem types, permissions, and contest rules are respected for free.
 */

const SCRATCHPAD_TYPES = ['default', 'remote_judge'];
const RAIL_W = 190;
const RAIL_COLLAPSED_KEY = 'hydro:sl-rail-collapsed';

const RAIL_STYLE = [
  '.sl-rail { position: fixed; left: 0; top: 0; bottom: 0; width: 190px; z-index: 260; background: #fff; border-right: 1px solid #e3e3e3; display: flex; flex-direction: column; font-size: 13px; box-shadow: 2px 0 8px rgba(0,0,0,.06); }',
  '.sl-rail__head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #eee; font-weight: bold; color: #333; flex: 0 0 auto; }',
  '.sl-rail__head button { border: none; background: transparent; cursor: pointer; font-size: 14px; color: #666; padding: 2px 6px; border-radius: 4px; }',
  '.sl-rail__head button:hover { background: #f0f0f0; }',
  '.sl-rail__grid { padding: 12px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; overflow-y: auto; align-content: start; }',
  '.sl-rail__chip { display: flex; align-items: center; justify-content: center; height: 34px; border: 1px solid #d0d0d0; border-radius: 6px; color: #555; text-decoration: none; background: #fff; font-size: 13px; }',
  '.sl-rail__chip:hover { border-color: #339af0; color: #339af0; }',
  '.sl-rail__chip.ac { border-color: #2f9e44; color: #2f9e44; background: #f0faf2; }',
  '.sl-rail__chip.tried { border-color: #e03131; color: #e03131; background: #fff5f5; }',
  '.sl-rail__chip.quiz { border-style: dashed; }',
  '.sl-rail__chip.current { outline: 2px solid #339af0; outline-offset: 1px; }',
  '.sl-rail__expander { position: fixed; left: 0; top: 50%; transform: translateY(-50%); z-index: 260; width: 26px; height: 60px; border: 1px solid #d0d0d0; border-left: none; border-radius: 0 8px 8px 0; background: #fff; cursor: pointer; color: #666; font-size: 15px; box-shadow: 2px 0 8px rgba(0,0,0,.12); }',
  '.sl-rail__expander:hover { color: #339af0; }',
].join('\n');

function problemType() {
  try {
    return (window.UiContext && UiContext.pdoc && UiContext.pdoc.config && UiContext.pdoc.config.type) || '';
  } catch (e) {
    return '';
  }
}

function alphaLabel(i) {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

function esc(text) {
  return $('<i>').text(String(text)).html();
}

/** Items for the current activity, or null when the page has no activity context. */
function buildRailItems() {
  const uc = window.UiContext || {};
  if (Array.isArray(uc.slProblems) && uc.slProblems.length) {
    const prefix = window.location.pathname.split('/self-learning/')[0];
    return uc.slProblems.map((p, i) => ({
      label: p.status === 1 ? '✓' : String(i + 1),
      cls: `${p.status === 1 ? ' ac' : (p.status ? ' tried' : '')}${p.kind === 'objective' ? ' quiz' : ''}`
        + (String(p.pid) === String(uc.slPid) ? ' current' : ''),
      title: `${i + 1}. ${p.title || p.pid}${p.kind === 'objective' ? ` (${i18n('Quiz')})` : ''}`,
      href: `${prefix}/self-learning/${uc.slSsid}/p/${p.pid}`,
    }));
  }
  if (uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) {
    const prefix = window.location.pathname.split('/p/')[0];
    const current = uc.pdoc && uc.pdoc.docId;
    return uc.tdoc.pids.map((pid, i) => ({
      label: alphaLabel(i),
      cls: String(pid) === String(current) ? ' current' : '',
      title: alphaLabel(i),
      href: `${prefix}/p/${pid}?tid=${uc.tdoc.docId}`,
    }));
  }
  return null;
}

function squeezeScratchpad(width) {
  $('.scratchpad-container').css({ left: `${width}px`, width: `calc(100% - ${width}px)` });
  window.dispatchEvent(new Event('resize')); // let Monaco and the split panes relayout
}

export function removeRail() {
  $('#sl-rail, #sl-rail-expander').remove();
  $('.scratchpad-container').css({ left: '0px', width: '100%' });
}

function setCollapsed(collapsed) {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '');
  } catch (e) { /* best-effort */ }
  $('#sl-rail').toggle(!collapsed);
  $('#sl-rail-expander').toggle(collapsed);
  squeezeScratchpad(collapsed ? 0 : RAIL_W);
}

function injectRail() {
  if (document.getElementById('sl-rail')) return;
  const items = buildRailItems();
  if (!items) {
    const uc = window.UiContext || {};
    console.info('[self-learning] problem rail skipped:', {
      slProblems: Array.isArray(uc.slProblems) ? uc.slProblems.length : 'absent (backend restarted?)',
      tdocPids: uc.tdoc && Array.isArray(uc.tdoc.pids) ? uc.tdoc.pids.length : 'absent',
    });
    return;
  }
  if (!document.getElementById('sl-rail-style')) {
    $('<style>').attr('id', 'sl-rail-style').text(RAIL_STYLE).appendTo(document.head);
  }
  console.info('[self-learning] rail: attaching with', items.length, 'problem(s)');
  const chips = items.map((it) => `<a class="sl-rail__chip${it.cls}" href="${it.href}" title="${esc(it.title)}">${esc(it.label)}</a>`).join('');
  $(`<div id="sl-rail" class="sl-rail">`
    + `<div class="sl-rail__head"><span>${esc(i18n('Problems'))}</span>`
    + `<button id="sl-rail-toggle" type="button" title="${esc(i18n('Collapse'))}">⟨</button></div>`
    + `<div class="sl-rail__grid">${chips}</div>`
    + '</div>').appendTo(document.body);
  $(`<button id="sl-rail-expander" class="sl-rail__expander" type="button" style="display:none" title="${esc(i18n('Problems'))}">≡</button>`).appendTo(document.body);
  $('#sl-rail-toggle').on('click', () => setCollapsed(true));
  $('#sl-rail-expander').on('click', () => setCollapsed(false));
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch (e) { /* default expanded */ }
  setCollapsed(collapsed);
}

/** Wait for scratchpad mode to be active, then attach the rail. */
export function injectRailWhenReady() {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if ($('body').hasClass('mode--scratchpad')) {
      clearInterval(timer);
      injectRail();
    } else if (tries > 50) clearInterval(timer);
  }, 100);
}

export default new NamedPage(['problem_detail', 'problem_submit', 'self_learning_solve'], (pagename) => {
  console.info('[self-learning] auto-scratchpad module active on', pagename);
  // The rail follows the IDE everywhere: any open control (core sidebar or the
  // self-learning button) attaches it; the quit control detaches it.
  $(document).on('click', '[name="problem-sidebar__open-scratchpad"], #sl-open-scratchpad', () => {
    console.info('[self-learning] rail: scratchpad opening, waiting to attach');
    injectRailWhenReady();
  });
  $(document).on('click', '[name="problem-sidebar__quit-scratchpad"]', () => removeRail());

  if (pagename === 'self_learning_solve') return; // auto-entry handled by the solve page itself

  if (!SCRATCHPAD_TYPES.includes(problemType())) return;
  if (pagename === 'problem_submit') {
    // The plain paste-code page is superseded by the IDE.
    const target = window.location.pathname.replace(/\/submit\/?$/, '') + window.location.search;
    window.location.replace(target);
    return;
  }
  // Auto-enter: the core page binds the open handler in its own module; poll
  // briefly so module ordering never matters, then enter exactly once.
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if ($('body').hasClass('mode--scratchpad')) {
      clearInterval(timer);
      injectRailWhenReady();
      return;
    }
    const $btn = $('[name="problem-sidebar__open-scratchpad"]');
    if ($btn.length) {
      clearInterval(timer);
      $btn.first().trigger('click'); // the click hook above attaches the rail
    } else if (tries > 30) {
      clearInterval(timer); // ~3s: no scratchpad affordance on this page
    }
  }, 100);
});
