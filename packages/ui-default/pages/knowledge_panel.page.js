/*
 * PTA fork: behaviors of the KNOWLEDGE POINTS panel (partials/category.html)
 * on the problem set (filter mode) and the problem editor (pick mode).
 *
 * The problem the script solves: a domain's catalog can hold hundreds of
 * points, and a chip cloud that long turns the sidebar into the tallest
 * thing on the page. The server already sorts each group by usage; this
 * script keeps the cloud BOUNDED and quick to search without hiding
 * anything for good:
 *
 *   search     the box at the top narrows the chips as you type (matching
 *              names highlighted, groups without matches folded away);
 *   collapse   by default only the most-used dozen chips show, with a
 *              "Show all N" that opens a scrolling area capped to the
 *              viewport ("Show less" folds it back);
 *   unused     in filter mode, chips with 0 tasks on the current tab can
 *              filter nothing, so they hide behind "+N unused" (pick mode
 *              always shows them — a new point is unused until it is used);
 *   groups     each catalog category folds on its own header;
 *   sort       usage (default) or A–Z, per group;
 *   sticky     the panel's viewport offset follows the fixed navbar.
 *
 * Every choice — expanded, unused, sort, folded groups — is remembered in
 * localStorage. Active chips (the current filter) are never hidden by any
 * of these, and a search shows everything it matches.
 */
import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';

const LIMIT = 12; // chips shown while collapsed
const KEY = 'pta.kpp';

function readState() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch (e) {
    return {};
  }
}
function writeState(patch) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readState(), ...patch }));
  } catch (e) { /* private mode */ }
}

const esc = (t) => $('<i>').text(String(t ?? '')).html();

function setupPanel(root) {
  const $root = $(root);
  const mode = $root.attr('data-mode') || 'filter';
  const state = readState();
  const $search = $root.find('.kpp__search');
  const $foot = $root.find('.kpp__foot');
  const $groups = $root.find('.kpp__group');
  const $heads = $root.find('.kpp__head');
  const chips = $root.find('.kpp__scroll .kpp__chip').get();
  const folded = new Set(state.folded || []);
  // 🌳 A section is hidden when its own topic or ANY ancestor topic is folded.
  const foldedAbove = (el) => {
    const own = el.getAttribute('data-group') || '';
    if (own && folded.has(own)) return true;
    for (const id of (el.getAttribute('data-parents') || '').split(' ')) if (id && folded.has(id)) return true;
    return false;
  };
  let expanded = !!state.expanded;
  let showUnused = mode === 'pick' ? true : !!state.unused;
  let sort = state.sort === 'az' ? 'az' : 'usage';
  let query = '';

  // The navbar is fixed: the sticky offset (and the expanded area's height
  // budget) start below it.
  const nav = document.querySelector('.nav');
  const r = nav ? nav.getBoundingClientRect() : null;
  const navBottom = r && r.height > 0 && r.bottom > 0 ? Math.round(r.bottom) : 62;
  root.style.setProperty('--kpp-top', `${navBottom + 14}px`);
  const section = root.closest('.section');
  if (section) section.style.setProperty('--kpp-top', `${navBottom + 14}px`);

  // ---- footer controls (only when there is something to control) ----
  const unusedTotal = Number($root.attr('data-unused')) || 0;
  const $more = $('<button type="button" class="kpp__more"></button>');
  const $unused = $('<button type="button" class="kpp__unused"></button>');
  const $sort = $('<button type="button" class="kpp__sort" title="' + esc(i18n('Sort by usage or by name')) + '"></button>');
  $foot.prepend($sort);
  if (mode !== 'pick' && unusedTotal) $foot.prepend($unused);
  if (chips.length > LIMIT) $foot.prepend($more);

  const labels = () => {
    $more.text(expanded ? `↑ ${i18n('Show less')}` : `↓ ${i18n('Show all')} (${chips.length})`);
    $unused.text(showUnused ? `− ${i18n('Hide unused')}` : `+ ${unusedTotal} ${i18n('unused on this tab')}`);
    $sort.text(sort === 'az' ? `⇅ ${i18n('Sort: A–Z')}` : `⇅ ${i18n('Sort: usage')}`);
  };

  const byName = (a, b) => (a.getAttribute('data-name') || '').localeCompare(b.getAttribute('data-name') || '');
  const byUsage = (a, b) => (Number(b.getAttribute('data-count')) || 0) - (Number(a.getAttribute('data-count')) || 0) || byName(a, b);
  const applySort = () => {
    const cmp = sort === 'az' ? byName : byUsage;
    for (const box of $root.find('.kpp__chips').get()) {
      const items = [...box.querySelectorAll('.kpp__chip')].sort(cmp);
      for (const it of items) box.appendChild(it);
    }
  };

  // Does any section list this topic among its ancestors? (A topic with
  // only sub-topics and no chips of its own still needs its header.)
  const hasTopicsBelow = (id) => $heads.get().some((h) => (h.getAttribute('data-parents') || '').split(' ').includes(id));

  // ---- the one function that decides what is visible ----
  const paint = () => {
    const q = query.trim().toLowerCase();
    $root.toggleClass('kpp--expanded', expanded || !!q);
    $root.toggleClass('kpp--searching', !!q);
    let budget = LIMIT;
    let visible = 0;
    for (const box of $root.find('.kpp__chips').get()) {
      const group = box.getAttribute('data-group') || '';
      const $head = $heads.filter((_, h) => (h.getAttribute('data-group') || '') === group);
      const $btn = $head.find('.kpp__group');
      const isFolded = !q && foldedAbove(box);
      const selfFolded = !q && !!group && folded.has(group);
      let shown = 0;
      for (const chip of box.querySelectorAll('.kpp__chip')) {
        const name = chip.getAttribute('data-name') || '';
        const count = Number(chip.getAttribute('data-count')) || 0;
        const active = chip.getAttribute('data-active') === '1' || chip.classList.contains('kpp__chip--on');
        const $t = $(chip).find('.kpp__t');
        let show;
        if (q) {
          const hit = name.toLowerCase().includes(q) || group.toLowerCase().includes(q);
          show = hit;
          // Highlight the match in the name.
          if (hit) {
            const i = name.toLowerCase().indexOf(q);
            $t.html(i >= 0 ? `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + q.length))}</mark>${esc(name.slice(i + q.length))}` : esc(name));
          }
        } else {
          $t.text(name);
          show = active || ((count > 0 || showUnused) && (expanded || budget > 0));
          if (show && !active && !expanded) budget -= 1;
        }
        if (show && isFolded && !active) show = false;
        chip.hidden = !show;
        if (show) shown += 1;
      }
      visible += shown;
      // A topic header stays when it has anything to show, or when it is
      // itself folded (so it can be unfolded) — unless an ancestor is
      // folded, in which case the whole section goes with it. Under a
      // search, a header shows only above matches.
      const under = (el) => (el.getAttribute('data-parents') || '').split(' ').filter((x) => x && folded.has(x)).length > 0 && !q;
      const keepHead = !under(box) && (shown > 0 || (selfFolded && !!box.querySelector('.kpp__chip')) || (!q && !!group && hasTopicsBelow(group)));
      $head.prop('hidden', !keepHead);
      $btn.attr('aria-expanded', selfFolded ? 'false' : 'true');
      box.hidden = shown === 0;
    }
    $root.toggleClass('kpp--nomatch', !!q && visible === 0);
    labels();
  };

  // ---- events ----
  $search.on('input', () => {
    query = $search.val() || '';
    paint();
  });
  $search.on('keydown', (ev) => {
    if (ev.key === 'Escape') {
      $search.val('');
      query = '';
      paint();
    } else if (ev.key === 'Enter') {
      // Enter opens the first visible match: a quick way to filter by name.
      ev.preventDefault();
      const first = chips.find((c) => !c.hidden);
      if (first) first.click();
    }
  });
  $more.on('click', () => {
    expanded = !expanded;
    writeState({ expanded });
    paint();
    if (!expanded) root.scrollIntoView({ block: 'nearest' });
  });
  $unused.on('click', () => {
    showUnused = !showUnused;
    writeState({ unused: showUnused });
    paint();
  });
  $sort.on('click', () => {
    sort = sort === 'az' ? 'usage' : 'az';
    writeState({ sort });
    applySort();
    paint();
  });
  $groups.on('click', function onGroup() {
    const g = this.getAttribute('data-group') || '';
    if (folded.has(g)) folded.delete(g);
    else folded.add(g);
    writeState({ folded: [...folded] });
    paint();
  });

  applySort();
  paint();
}

export default new AutoloadPage('knowledgePanelPage', () => {
  for (const root of document.querySelectorAll('.kpp[data-mode]')) setupPanel(root);
});
