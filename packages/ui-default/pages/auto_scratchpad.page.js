import $ from 'jquery';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

/**
 * Site-wide policy: programming problems open directly in Scratchpad mode —
 * and a PTA-style problem rail on the left follows the learner around.
 *
 * Every surface views problems through the problem page (the problem set,
 * contests, homework, and training all route through `problem_detail`; the
 * contest/homework variants set UiContext.tdoc), so auto-entering there
 * covers all domains. The standalone submit page is retired for programming
 * problems and bounces back to the problem page.
 *
 * The rail lists all tasks of the current activity:
 * - Self-learning sessions expose UiContext.slProblems (title, kind, status).
 *   Like a PTA exam paper, problems are grouped by kind — quiz-style tasks
 *   first, programming tasks second — each group numbered independently,
 *   with a check for accepted, red for tried, a dashed border for quiz
 *   problems, and the current one outlined.
 * - Contests and homework expose tdoc.pids, rendering the classic A/B/C grid
 *   with contest-scoped links (a single unlabeled group).
 *
 * The rail attaches in one of two modes:
 * - 'scratchpad': inside the full-screen IDE. Spans the whole viewport height
 *   and squeezes .scratchpad-container to make room.
 * - 'page': on a normal document page — used by quiz / answer-submission
 *   problems, which have no IDE. Starts below the fixed navbar and squeezes
 *   .main / .footer instead, so learners can hop between problems there too.
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
  '.sl-rail__body { flex: 1 1 auto; overflow-y: auto; padding-bottom: 10px; }',
  '.sl-rail__cat { padding: 12px 12px 0; font-size: 11.5px; font-weight: bold; color: #8a8a8a; letter-spacing: .05em; text-transform: uppercase; }',
  '.sl-rail__grid { padding: 8px 12px 2px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; align-content: start; }',
  '.sl-rail__chip { display: flex; align-items: center; justify-content: center; height: 34px; border: 1px solid #d0d0d0; border-radius: 6px; color: #555; text-decoration: none; background: #fff; font-size: 13px; }',
  '.sl-rail__chip:hover { border-color: #339af0; color: #339af0; }',
  '.sl-rail__chip.ac { border-color: #2f9e44; color: #2f9e44; background: #f0faf2; }',
  '.sl-rail__chip.tried { border-color: #e03131; color: #e03131; background: #fff5f5; }',
  '.sl-rail__chip.quiz { border-style: dashed; }',
  '.sl-rail__chip.current { outline: 2px solid #339af0; outline-offset: 1px; }',
  '.sl-rail__expander { position: fixed; left: 0; top: 50%; transform: translateY(-50%); z-index: 260; width: 26px; height: 60px; border: 1px solid #d0d0d0; border-left: none; border-radius: 0 8px 8px 0; background: #fff; cursor: pointer; color: #666; font-size: 15px; box-shadow: 2px 0 8px rgba(0,0,0,.12); }',
  '.sl-rail__expander:hover { color: #339af0; }',
].join('\n');

/** 'scratchpad' | 'page' | null — which surface the rail is currently attached to. */
let railMode = null;

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

function navHeight() {
  const nav = document.querySelector('.nav');
  return nav ? Math.round(nav.getBoundingClientRect().height) : 0;
}

/**
 * Chip groups for the current activity, or null when the page has no
 * activity context. Self-learning problems split into quiz-style vs
 * programming groups with independent 1..n numbering; contests keep the
 * single classic grid as one unlabeled group.
 */
function buildRailGroups() {
  const uc = window.UiContext || {};
  if (Array.isArray(uc.slProblems) && uc.slProblems.length) {
    const prefix = window.location.pathname.split('/self-learning/')[0];
    const quizzes = [];
    const programming = [];
    for (const p of uc.slProblems) {
      const item = {
        accepted: p.status === 1,
        cls: `${p.status === 1 ? ' ac' : (p.status ? ' tried' : '')}${p.kind === 'objective' ? ' quiz' : ''}`
          + (String(p.pid) === String(uc.slPid) ? ' current' : ''),
        name: p.title || String(p.pid),
        href: `${prefix}/self-learning/${uc.slSsid}/p/${p.pid}`,
      };
      (p.kind === 'programming' ? programming : quizzes).push(item);
    }
    const groups = [];
    if (quizzes.length) groups.push({ header: i18n('Quizzes'), items: quizzes });
    if (programming.length) groups.push({ header: i18n('Programming'), items: programming });
    for (const g of groups) {
      g.items.forEach((it, i) => {
        it.label = it.accepted ? '✓' : String(i + 1);
        it.title = `${i + 1}. ${it.name}`;
      });
    }
    return groups;
  }
  if (uc.tdoc && Array.isArray(uc.tdoc.pids) && uc.tdoc.pids.length > 1) {
    const prefix = window.location.pathname.split('/p/')[0];
    const current = uc.pdoc && uc.pdoc.docId;
    return [{
      header: null,
      items: uc.tdoc.pids.map((pid, i) => ({
        label: alphaLabel(i),
        cls: String(pid) === String(current) ? ' current' : '',
        title: alphaLabel(i),
        href: `${prefix}/p/${pid}?tid=${uc.tdoc.docId}`,
      })),
    }];
  }
  return null;
}

/** Squeeze whichever content surface the current rail mode owns. */
function squeezeContent(width) {
  if (railMode === 'page') {
    $('.main, .footer').css('margin-left', width ? `${width}px` : '');
  } else {
    $('.scratchpad-container').css({ left: `${width}px`, width: `calc(100% - ${width}px)` });
    window.dispatchEvent(new Event('resize')); // let Monaco and the split panes relayout
  }
}

export function removeRail() {
  $('#sl-rail, #sl-rail-expander').remove();
  $('.scratchpad-container').css({ left: '0px', width: '100%' });
  $('.main, .footer').css('margin-left', '');
  railMode = null;
}

function setCollapsed(collapsed) {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '');
  } catch (e) { /* best-effort */ }
  $('#sl-rail').toggle(!collapsed);
  $('#sl-rail-expander').toggle(collapsed);
  squeezeContent(collapsed ? 0 : RAIL_W);
}

/** In page mode the rail sits below the fixed navbar; keep that on resize. */
function syncRailTop() {
  if (railMode !== 'page') return;
  $('#sl-rail').css('top', `${navHeight()}px`);
}

function injectRail(mode) {
  if (document.getElementById('sl-rail')) {
    if (railMode === mode) return;
    removeRail(); // re-homing between the IDE and the page rebuilds cleanly
  }
  const groups = buildRailGroups();
  if (!groups) {
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
  railMode = mode;
  console.info('[self-learning] rail: attaching in', mode, 'mode with', groups.length, 'group(s)');
  const body = groups.map((g) => {
    const chips = g.items.map((it) => `<a class="sl-rail__chip${it.cls}" href="${it.href}" title="${esc(it.title)}">${esc(it.label)}</a>`).join('');
    return `${g.header ? `<div class="sl-rail__cat">${esc(g.header)}</div>` : ''}<div class="sl-rail__grid">${chips}</div>`;
  }).join('');
  $(`<div id="sl-rail" class="sl-rail" style="top:${mode === 'page' ? navHeight() : 0}px">`
    + `<div class="sl-rail__head"><span>${esc(i18n('Problems'))}</span>`
    + `<button id="sl-rail-toggle" type="button" title="${esc(i18n('Collapse'))}">⟨</button></div>`
    + `<div class="sl-rail__body">${body}</div>`
    + '</div>').appendTo(document.body);
  $(`<button id="sl-rail-expander" class="sl-rail__expander" type="button" style="display:none" title="${esc(i18n('Problems'))}">≡</button>`).appendTo(document.body);
  $('#sl-rail-toggle').on('click', () => setCollapsed(true));
  $('#sl-rail-expander').on('click', () => setCollapsed(false));
  let collapsed = false;
  try {
    const saved = localStorage.getItem(RAIL_COLLAPSED_KEY);
    if (saved === '1') collapsed = true;
    // First visit on a narrow page: content space beats the rail.
    else if (saved === null && mode === 'page' && window.matchMedia('(max-width: 600px)').matches) collapsed = true;
  } catch (e) { /* default expanded */ }
  setCollapsed(collapsed);
}

/** Wait for scratchpad mode to be active, then attach the rail inside the IDE. */
export function injectRailWhenReady() {
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if ($('body').hasClass('mode--scratchpad')) {
      clearInterval(timer);
      injectRail('scratchpad');
    } else if (tries > 50) clearInterval(timer);
  }, 100);
}

/** Attach the rail to a normal document page (quiz / answer-submission solve pages). */
export function injectRailForPage() {
  injectRail('page');
}

$(window).on('resize', syncRailTop);

export default new NamedPage(['problem_detail', 'problem_submit', 'self_learning_solve'], (pagename) => {
  console.info('[self-learning] auto-scratchpad module active on', pagename);
  // The rail follows the IDE everywhere: any open control (core sidebar or the
  // self-learning button) attaches it; the quit control detaches it.
  $(document).on('click', '[name="problem-sidebar__open-scratchpad"], #sl-open-scratchpad', () => {
    console.info('[self-learning] rail: scratchpad opening, waiting to attach');
    injectRailWhenReady();
  });
  // Only detach the IDE-mode rail here: on the self-learning solve page the
  // quit flow re-homes the rail into page mode, and that must survive
  // regardless of delegated-handler binding order.
  $(document).on('click', '[name="problem-sidebar__quit-scratchpad"]', () => {
    if (railMode === 'scratchpad') removeRail();
  });

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
