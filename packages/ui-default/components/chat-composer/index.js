/*
 * PTA fork: the CHAT COMPOSER — the box in which a person talks to the AI
 * (the session editor's task advisor, the AI Studio's brief / notes /
 * refine boxes, the tutor's answer card).
 *
 * WHAT IT IS. A rich editor in the spirit of Claude's composer: Markdown is
 * rendered IN the box as it is typed, with no preview pane. Type `- ` and
 * you are in a bullet list; `1. ` a numbered one; `# ` a heading; `> ` a
 * quote; ``` a code block; close a `code` span, a **bold** or *italic* run
 * or a ~~strike~~ and the markers disappear into the formatting; a pasted
 * URL becomes a link. Paste a whole Markdown document (a problem
 * statement, say) and it lands rendered. Backspace right after a
 * conversion undoes it; Backspace at the start of a list item, heading or
 * quote lifts it back to plain text.
 *
 * HOW IT FITS THE PAGES. Each page still owns a plain <textarea>: it reads
 * `value` (or jQuery .val()), writes it to clear or restore, binds keydown
 * for Enter-to-send, focuses it, disables it while the AI works, changes
 * its placeholder. That textarea stays — hidden — as the VALUE CARRIER,
 * and the editor is bridged to it both ways:
 *   editor → textarea   every edit serializes the editor to Markdown into
 *                       the textarea (then fires `input` there);
 *   textarea → editor   the element's own `value` setter is routed through
 *                       the editor, so .val('') clears it and .val(text)
 *                       renders text;
 *   keys                every keydown is re-dispatched on the textarea
 *                       FIRST; if the page's handler prevents it (Enter =
 *                       send), the editor does nothing with it; otherwise
 *                       the editor handles it (Enter = new paragraph /
 *                       list item / code line);
 *   focus / disabled / placeholder follow the textarea.
 * So the pages keep their code and their API, and what they send is
 * Markdown — the same text the AI would have received from a plain box.
 *
 * mountComposer(textarea, { i18n }) returns { refresh, destroy, editor }.
 * Idempotent per element; safe to call on every re-render of a page that
 * rebuilds its DOM.
 */
import MarkdownIt from 'markdown-it';

const STYLE_ID = 'pta-composer-style';
const ZWSP = '\u200B';
const FONT = "'Inter var', Inter, 'Segoe UI', system-ui, -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";
const CODE_FONT = "var(--code-font-family, ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace)";

const CSS = `
.pta-composer { position: relative; display: block; flex: 1 1 auto; min-width: 0; --pc-ink: var(--pta-ink, #2b3a55); --pc-accent: var(--pta-violet, #7048e8); --pc-link: var(--pta-primary, #1c7ed6); --pc-code-bg: rgba(112, 72, 232, .10); --pc-code-line: rgba(112, 72, 232, .22); --pc-code-fg: #5f3dc4; --pc-quote: var(--pta-ink-soft, #5b6b85); --pc-pre-bg: var(--pta-card-3, #eef1f6); --pc-line: var(--pta-line, rgba(15, 23, 42, .1)); }
.pta-dark .pta-composer, .theme--dark .pta-composer { --pc-code-bg: rgba(177, 151, 252, .16); --pc-code-line: rgba(177, 151, 252, .35); --pc-code-fg: #d0bdfb; --pc-pre-bg: var(--pta-card-3, #262b31); }
/* The page's textarea: kept in the DOM as the value carrier, never shown. */
.pta-composer > .pta-composer__input { display: none !important; }
/* The editor. Its box (border, radius, padding, colors, size limits) is
   copied from the textarea it replaces, so every page keeps its look. */
.pta-composer__editor { position: relative; box-sizing: border-box; width: 100%; min-height: 1.5em; outline: none; white-space: pre-wrap; overflow-wrap: break-word; word-break: normal; font-family: ${FONT}; color: var(--pc-ink); cursor: text; tab-size: 4; -moz-tab-size: 4; transition: border-color .15s ease, box-shadow .15s ease; }
.pta-composer__editor[data-bordered="1"]:focus { border-color: var(--pc-accent) !important; box-shadow: 0 0 0 3px var(--pta-violet-soft, rgba(112, 72, 232, .16)); }
.pta-composer.is-empty > .pta-composer__editor::before { content: attr(data-placeholder); position: absolute; left: var(--pc-pad-l, 0); top: var(--pc-pad-t, 0); right: var(--pc-pad-r, 0); color: var(--pc-placeholder, var(--pta-ink-faint, #98a2ac)); pointer-events: none; white-space: pre-wrap; overflow: hidden; }
.pta-composer.is-disabled > .pta-composer__editor { opacity: .55; cursor: default; }
.pta-composer__editor > * { margin: 0; }
.pta-composer__editor > * + * { margin-top: 3px; }
.pta-composer__editor p { margin: 0; min-height: 1.5em; }
.pta-composer__editor h1, .pta-composer__editor h2, .pta-composer__editor h3 { font-weight: 700; line-height: 1.3; margin: 4px 0 2px; color: var(--pc-ink); }
.pta-composer__editor > h1:first-child, .pta-composer__editor > h2:first-child, .pta-composer__editor > h3:first-child { margin-top: 0; }
.pta-composer__editor h1 { font-size: 1.3em; } .pta-composer__editor h2 { font-size: 1.16em; } .pta-composer__editor h3 { font-size: 1.06em; }
/* Lists. The site's reset (typography.styl: ul, ol { list-style: none })
   strips every marker outside .typo — restored here explicitly, with
   list-style-position: outside so wrapped lines align under the text. */
.pta-composer .pta-composer__editor ul, .pta-composer .pta-composer__editor ol { margin: 1px 0 1px 0; padding: 0 0 0 24px; list-style-position: outside; }
.pta-composer .pta-composer__editor ul { list-style-type: disc; }
.pta-composer .pta-composer__editor ul ul { list-style-type: circle; }
.pta-composer .pta-composer__editor ul ul ul { list-style-type: square; }
.pta-composer .pta-composer__editor ol { list-style-type: decimal; }
.pta-composer .pta-composer__editor ol ol { list-style-type: lower-alpha; }
.pta-composer .pta-composer__editor li { display: list-item; margin: 1px 0; min-height: 1.5em; padding-left: 2px; }
.pta-composer .pta-composer__editor li::marker { color: var(--pc-accent); font-weight: 600; }
.pta-composer .pta-composer__editor li > ul, .pta-composer .pta-composer__editor li > ol { margin: 1px 0 0; }
.pta-composer__editor blockquote { margin: 2px 0; padding: 2px 10px; border-left: 3px solid var(--pc-accent); color: var(--pc-quote); background: color-mix(in srgb, var(--pc-accent) 6%, transparent); border-radius: 0 6px 6px 0; }
.pta-composer__editor blockquote > p { min-height: 1.5em; }
.pta-composer__editor code { font-family: ${CODE_FONT}; font-size: .92em; background: var(--pc-code-bg); color: var(--pc-code-fg); border: 1px solid var(--pc-code-line); border-radius: 5px; padding: 0 5px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.pta-composer__editor pre { margin: 3px 0; padding: 8px 10px 8px; border-radius: 8px; background: var(--pc-pre-bg); border: 1px solid var(--pc-line); font-family: ${CODE_FONT}; font-size: .92em; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--pc-ink); }
.pta-composer__editor pre[data-lang]:not([data-lang=""])::before { content: attr(data-lang); display: block; font-family: ${FONT}; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--pta-ink-faint, #98a2ac); margin-bottom: 3px; user-select: none; }
.pta-composer__editor a { color: var(--pc-link); text-decoration: underline; text-underline-offset: 2px; cursor: text; }
.pta-composer__editor s { opacity: .72; }
.pta-composer__editor .pc-math { color: #0b7285; background: rgba(11, 114, 133, .09); border-radius: 4px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.pta-dark .pta-composer__editor .pc-math, .theme--dark .pta-composer__editor .pc-math { color: #66d9e8; background: rgba(102, 217, 232, .12); }
.pta-composer__editor::selection, .pta-composer__editor *::selection { background: rgba(77, 171, 247, .30); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.appendChild(st);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------------------------------------------ */
/*  Markdown → DOM (paste, programmatic value)                          */
/* ------------------------------------------------------------------ */

/*
 * markdown-it would read the `_` of a subscript or the `*` of a product as
 * emphasis. This rule claims `$…$` / `$$…$$` first and keeps the formula
 * verbatim in a span, delimiters included, so it round-trips untouched.
 */
function mathPlugin(mdi) {
  mdi.inline.ruler.before('escape', 'pc_math', (state, silent) => {
    const { src } = state;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
    const dbl = src.charCodeAt(pos + 1) === 0x24;
    const open = dbl ? '$$' : '$';
    const start = pos + open.length;
    if (!dbl && /\s/.test(src[start] || '')) return false;
    const end = src.indexOf(open, start);
    if (end < 0) return false;
    if (!dbl && (end === start || /\s/.test(src[end - 1]) || src.slice(start, end).includes('\n'))) return false;
    if (!silent) {
      const token = state.push('pc_math', '', 0);
      token.content = src.slice(start, end);
      token.markup = open;
    }
    state.pos = end + open.length;
    return true;
  });
  mdi.renderer.rules.pc_math = (tokens, idx) => {
    const tk = tokens[idx];
    return `<span class="pc-math">${esc(tk.markup)}${esc(tk.content)}${esc(tk.markup)}</span>`;
  };
}

let mdInstance = null;
function md() {
  if (!mdInstance) {
    mdInstance = new MarkdownIt({ html: false, linkify: true, breaks: true });
    mdInstance.use(mathPlugin);
  }
  return mdInstance;
}

const INLINE_KEEP = new Set(['STRONG', 'B', 'EM', 'I', 'CODE', 'S', 'DEL', 'STRIKE', 'A', 'BR']);

/** Reduce arbitrary inline HTML to the editor's inline vocabulary. */
function normalizeInline(src, out, doc) {
  for (const n of [...src.childNodes]) {
    if (n.nodeType === 3) {
      out.appendChild(doc.createTextNode(n.nodeValue));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (tag === 'BR') {
      out.appendChild(doc.createElement('br'));
    } else if (tag === 'SPAN' && n.classList.contains('pc-math')) {
      const s = doc.createElement('span');
      s.className = 'pc-math';
      s.textContent = n.textContent;
      out.appendChild(s);
    } else if (INLINE_KEEP.has(tag)) {
      const map = { B: 'strong', I: 'em', DEL: 's', STRIKE: 's' };
      const e = doc.createElement(map[tag] || tag.toLowerCase());
      if (tag === 'A') e.setAttribute('href', n.getAttribute('href') || '');
      if (tag === 'CODE') e.textContent = n.textContent;
      else normalizeInline(n, e, doc);
      out.appendChild(e);
    } else {
      normalizeInline(n, out, doc); // unwrap anything else (mark, sub, …)
    }
  }
}

/** One rendered block element → an editor block (or several). */
function normalizeBlock(n, doc) {
  const tag = n.tagName;
  const p = () => {
    const e = doc.createElement('p');
    normalizeInline(n, e, doc);
    return [e];
  };
  if (tag === 'P') return p();
  if (/^H[1-6]$/.test(tag)) {
    const lvl = Math.min(3, Number(tag[1]));
    const e = doc.createElement(`h${lvl}`);
    normalizeInline(n, e, doc);
    return [e];
  }
  if (tag === 'UL' || tag === 'OL') {
    const list = doc.createElement(tag.toLowerCase());
    if (tag === 'OL' && n.getAttribute('start')) list.setAttribute('start', n.getAttribute('start'));
    for (const li of [...n.children]) {
      if (li.tagName !== 'LI') continue;
      const item = doc.createElement('li');
      // Loose lists wrap the text in <p>; nested lists follow the text.
      for (const c of [...li.childNodes]) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) {
          for (const b of normalizeBlock(c, doc)) item.appendChild(b);
        } else if (c.nodeType === 1 && c.tagName === 'P') {
          normalizeInline(c, item, doc);
        } else if (c.nodeType === 3) {
          item.appendChild(doc.createTextNode(c.nodeValue));
        } else if (c.nodeType === 1) {
          normalizeInline(c, item, doc);
        }
      }
      list.appendChild(item);
    }
    return [list];
  }
  if (tag === 'BLOCKQUOTE') {
    const q = doc.createElement('blockquote');
    for (const c of [...n.children]) for (const b of normalizeBlock(c, doc)) q.appendChild(b);
    if (!q.children.length) q.appendChild(doc.createElement('p'));
    return [q];
  }
  if (tag === 'PRE') {
    const code = n.querySelector('code');
    const pre = doc.createElement('pre');
    const lang = ((code && code.className.match(/language-([\w+-]+)/)) || [])[1] || '';
    pre.setAttribute('data-lang', lang);
    pre.textContent = (code ? code.textContent : n.textContent).replace(/\n$/, '');
    return [pre];
  }
  if (tag === 'HR') {
    const e = doc.createElement('p');
    e.textContent = '---';
    return [e];
  }
  // Tables and anything else: keep the words, drop the structure.
  const e = doc.createElement('p');
  e.textContent = n.textContent.replace(/\s+\n/g, '\n').trim();
  return e.textContent ? [e] : [];
}

/** Markdown text → an array of editor block elements. */
export function markdownToBlocks(text, doc = document) {
  const tpl = doc.createElement('template');
  tpl.innerHTML = md().render(String(text || ''));
  const blocks = [];
  for (const n of [...tpl.content.childNodes]) {
    if (n.nodeType === 1) blocks.push(...normalizeBlock(n, doc));
    else if (n.nodeType === 3 && n.nodeValue.trim()) {
      const e = doc.createElement('p');
      e.textContent = n.nodeValue.trim();
      blocks.push(e);
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/*  DOM → Markdown (what the page reads and sends)                      */
/* ------------------------------------------------------------------ */

function serializeInline(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) {
      out += n.nodeValue.split(ZWSP).join('');
      continue;
    }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    const inner = () => serializeInline(n);
    if (tag === 'BR') {
      // A trailing <br> is the browser's caret placeholder, not a line break.
      if (n.nextSibling) out += '\n';
    } else if (tag === 'STRONG' || tag === 'B') out += `**${inner()}**`;
    else if (tag === 'EM' || tag === 'I') out += `*${inner()}*`;
    else if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') out += `~~${inner()}~~`;
    else if (tag === 'CODE') out += `\`${n.textContent.split(ZWSP).join('')}\``;
    else if (tag === 'A') {
      const href = n.getAttribute('href') || '';
      const text = inner();
      out += (!href || text === href || text === href.replace(/^https?:\/\//, '') || text === href.replace(/^mailto:/, '')) ? text : `[${text}](${href})`;
    } else out += inner(); // spans (math), anything unknown
  }
  return out;
}

function serializeList(list, indent) {
  const lines = [];
  const ordered = list.tagName === 'OL';
  let num = Number(list.getAttribute('start')) || 1;
  for (const li of list.children) {
    if (li.tagName !== 'LI') continue;
    // The item's own text, then its nested lists.
    const own = document.createDocumentFragment();
    const nested = [];
    for (const c of li.childNodes) {
      if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c);
      else own.appendChild(c.cloneNode(true));
    }
    const marker = ordered ? `${num}. ` : '- ';
    num += 1;
    const text = serializeInline(own).replace(/\n/g, `\n${indent}${' '.repeat(marker.length)}`);
    lines.push(`${indent}${marker}${text}`);
    for (const nl of nested) lines.push(serializeList(nl, `${indent}  `));
  }
  return lines.join('\n');
}

function serializeBlock(el) {
  const tag = el.tagName;
  if (tag === 'P') return serializeInline(el);
  if (/^H[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${serializeInline(el)}`;
  if (tag === 'UL' || tag === 'OL') return serializeList(el, '');
  if (tag === 'BLOCKQUOTE') {
    return [...el.children].map(serializeBlock).join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  }
  if (tag === 'PRE') {
    const lang = el.getAttribute('data-lang') || '';
    const body = el.textContent.split(ZWSP).join('').replace(/\n$/, '');
    // A fence one backtick longer than any run inside the block.
    const longest = Math.max(2, ...(body.match(/`+/g) || []).map((r) => r.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}${lang}\n${body}\n${fence}`;
  }
  return serializeInline(el);
}

/** The editor's content as Markdown. */
export function serialize(root) {
  const parts = [];
  for (const n of root.childNodes) {
    if (n.nodeType === 1) parts.push(serializeBlock(n));
    else if (n.nodeType === 3 && n.nodeValue.split(ZWSP).join('').trim()) parts.push(n.nodeValue.split(ZWSP).join(''));
  }
  // Blocks are separated by a blank line, as Markdown wants; a run of
  // empty paragraphs collapses (they were Shift+Enter spacers).
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

/* ------------------------------------------------------------------ */
/*  Selection helpers                                                   */
/* ------------------------------------------------------------------ */

const BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'LI', 'PRE']);

function getSel() {
  const s = window.getSelection();
  return s && s.rangeCount ? s : null;
}

function within(root, node) {
  return !!node && (node === root || root.contains(node));
}

/** The editable block (p / h / li / pre) containing the caret. */
function caretBlock(root) {
  const s = getSel();
  if (!s || !within(root, s.anchorNode)) return null;
  let n = s.anchorNode;
  while (n && n !== root) {
    if (n.nodeType === 1 && BLOCKS.has(n.tagName)) return n;
    n = n.parentNode;
  }
  return null;
}

function placeCaret(node, offset) {
  const s = window.getSelection();
  if (!s) return;
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  s.removeAllRanges();
  s.addRange(r);
}

/** Caret at the end of an element's content. */
function caretToEnd(el) {
  const s = window.getSelection();
  if (!s) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  s.removeAllRanges();
  s.addRange(r);
}

/** Put the caret right AFTER `node`, on a zero-width text node so typing continues outside it. */
function caretAfter(node) {
  let next = node.nextSibling;
  if (!next || next.nodeType !== 3) {
    next = document.createTextNode(ZWSP);
    node.parentNode.insertBefore(next, node.nextSibling);
    placeCaret(next, 1);
  } else if (next.nodeValue.startsWith(ZWSP)) {
    placeCaret(next, 1);
  } else {
    next.nodeValue = ZWSP + next.nodeValue;
    placeCaret(next, 1);
  }
}

/** Text of `block` from its start to the caret. */
function textBeforeCaret(block) {
  const s = getSel();
  if (!s) return '';
  const r = document.createRange();
  r.setStart(block, 0);
  r.setEnd(s.anchorNode, s.anchorOffset);
  return r.toString().split(ZWSP).join('');
}

function lastText(el) {
  const w = document.createTreeWalker(el, 4 /* SHOW_TEXT */);
  let last = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) last = n;
  return last;
}

function prevText(text) {
  // Previous text node within the same block, in document order.
  let n = text;
  while (n) {
    if (n.previousSibling) {
      n = n.previousSibling;
      while (n.nodeType === 1 && n.lastChild) n = n.lastChild;
      if (n.nodeType === 3) return n;
    } else {
      n = n.parentNode;
      if (!n || BLOCKS.has(n.tagName)) return null;
    }
  }
  return null;
}

/** A collapsed-at-caret range extended `count` characters backwards (across text nodes). */
function rangeBack(count) {
  const s = getSel();
  if (!s) return null;
  const r = document.createRange();
  r.setEnd(s.anchorNode, s.anchorOffset);
  let node = s.anchorNode;
  let offset = s.anchorOffset;
  let left = count;
  if (node.nodeType !== 3) {
    // Caret between elements: step into the previous text.
    const walker = node.childNodes[offset - 1];
    node = walker || node;
    if (node.nodeType === 3) offset = node.nodeValue.length;
    else {
      const t = lastText(node);
      if (!t) return null;
      node = t;
      offset = t.nodeValue.length;
    }
  }
  for (;;) {
    const take = Math.min(left, offset);
    offset -= take;
    left -= take;
    if (left === 0) break;
    const prev = prevText(node);
    if (!prev) return null;
    node = prev;
    offset = prev.nodeValue.length;
  }
  r.setStart(node, offset);
  return r;
}

function isInside(node, tags) {
  let n = node;
  while (n && n.nodeType !== 9) {
    if (n.nodeType === 1 && tags.includes(n.tagName)) return true;
    n = n.parentNode;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  The editor                                                          */
/* ------------------------------------------------------------------ */

const BLOCK_RULES = [
  { re: /^([-*+])\s$/, kind: 'ul' },
  { re: /^(\d{1,3})[.)]\s$/, kind: 'ol' },
  { re: /^(#{1,3})\s$/, kind: 'h' },
  { re: /^>\s$/, kind: 'quote' },
  { re: /^`{3}([\w+-]*)\s$/, kind: 'pre' },
];

// Each: the pattern at the END of the text before the caret; `tag` wraps
// group `g`; `lead` chars of the match stay as they were.
const INLINE_RULES = [
  { re: /`([^`\s][^`]*)`$/, tag: 'code', g: 1 },
  { re: /\*\*([^*\s][^*]*)\*\*$/, tag: 'strong', g: 1 },
  { re: /__([^_\s][^_]*)__$/, tag: 'strong', g: 1 },
  { re: /~~([^~\s][^~]*)~~$/, tag: 's', g: 1 },
  { re: /(^|[^*])\*([^*\s][^*]*)\*$/, tag: 'em', g: 2, lead: 1 },
  { re: /(^|\W)_([^_\s][^_]*)_$/, tag: 'em', g: 2, lead: 1 },
];
const URL_RULE = /(^|\s)((?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"])\s$/;

const COPY_BOX = [
  'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderRightWidth', 'borderRightStyle', 'borderRightColor',
  'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor', 'borderLeftWidth', 'borderLeftStyle', 'borderLeftColor',
  'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'backgroundColor', 'color',
  'fontSize', 'lineHeight', 'letterSpacing', 'maxHeight',
];

export function mountComposer(what, opts = {}) {
  const el = what && what.nodeType === 1 ? what : (what && what[0]);
  if (!el || el.tagName !== 'TEXTAREA') return null;
  if (el.__ptaComposer) return el.__ptaComposer;
  ensureStyle();

  /* ---- build ---- */
  const cs = getComputedStyle(el);
  let placeholderColor = '';
  try { placeholderColor = getComputedStyle(el, '::placeholder').color || ''; } catch (e) { /* older engines */ }
  const wrap = document.createElement('div');
  wrap.className = `pta-composer${opts.className ? ` ${opts.className}` : ''}`;
  const editor = document.createElement('div');
  editor.className = 'pta-composer__editor';
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('spellcheck', el.getAttribute('spellcheck') || 'true');
  // Wear the textarea's box so the page's design carries over.
  for (const k of COPY_BOX) editor.style[k] = cs[k];
  const bordered = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some((k) => Number.parseFloat(cs[k]) > 0);
  editor.setAttribute('data-bordered', bordered ? '1' : '0');
  if (cs.maxHeight && cs.maxHeight !== 'none') editor.style.overflowY = 'auto';
  const minH = Number.parseFloat(cs.height) || 0;
  if (minH) editor.style.minHeight = `${minH}px`;
  if (cs.backgroundColor === 'rgba(0, 0, 0, 0)' || cs.backgroundColor === 'transparent') editor.style.backgroundColor = 'transparent';
  editor.style.setProperty('--pc-pad-l', cs.paddingLeft);
  editor.style.setProperty('--pc-pad-t', cs.paddingTop);
  editor.style.setProperty('--pc-pad-r', cs.paddingRight);
  if (placeholderColor && !/rgba\(\s*0,\s*0,\s*0,\s*0\)/.test(placeholderColor)) wrap.style.setProperty('--pc-placeholder', placeholderColor);
  if (cs.color) wrap.style.setProperty('--pc-ink', cs.color);

  el.parentNode.insertBefore(wrap, el);
  wrap.appendChild(el);
  wrap.appendChild(editor);
  el.classList.add('pta-composer__input');

  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const rawGet = () => desc.get.call(el);
  const rawSet = (v) => desc.set.call(el, v);

  /* ---- state ---- */
  let composing = false;
  let syncing = false;
  let lastRule = null; // { html, block } to undo an autoformat with Backspace

  const ensureBlock = () => {
    // The editor always holds at least one paragraph, so the caret has a home.
    if (!editor.firstElementChild) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      editor.appendChild(p);
    }
  };
  const isEmpty = () => !serialize(editor).trim();
  const updateEmpty = () => wrap.classList.toggle('is-empty', isEmpty());
  const syncPlaceholder = () => editor.setAttribute('data-placeholder', el.getAttribute('placeholder') || '');
  const syncDisabled = () => {
    wrap.classList.toggle('is-disabled', el.disabled);
    editor.setAttribute('contenteditable', el.disabled ? 'false' : 'true');
  };

  /**
   * The zero-width spaces that carry the caret out of a freshly made
   * <code>/<strong>/<em> are only needed while the caret sits on them;
   * sweep the rest so they never pile up in the DOM (they never reach the
   * value: the serializer drops them).
   */
  const sweepZwsp = () => {
    const s = getSel();
    const keep = s ? s.anchorNode : null;
    const w = document.createTreeWalker(editor, 4 /* SHOW_TEXT */);
    const doomed = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n === keep || !n.nodeValue.includes(ZWSP)) continue;
      const clean = n.nodeValue.split(ZWSP).join('');
      if (clean) n.nodeValue = clean;
      else doomed.push(n);
    }
    for (const n of doomed) n.remove();
  };

  /** editor → textarea (and the page's own `input` listeners). */
  const push = () => {
    sweepZwsp();
    ensureBlock();
    const text = serialize(editor);
    if (rawGet() !== text) {
      syncing = true;
      rawSet(text);
      syncing = false;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    updateEmpty();
  };

  /** textarea → editor. */
  const setContent = (text) => {
    const blocks = markdownToBlocks(text);
    editor.innerHTML = '';
    for (const b of blocks) editor.appendChild(b);
    ensureBlock();
    updateEmpty();
    lastRule = null;
  };

  /* ---- autoformat ---- */
  const convertBlock = (block, kind, m) => {
    const html = block.outerHTML;
    // The marker is the block's whole content: empty it.
    block.textContent = '';
    let target;
    if (kind === 'ul' || kind === 'ol') {
      const list = document.createElement(kind);
      if (kind === 'ol' && Number(m[1]) > 1) list.setAttribute('start', m[1]);
      const li = document.createElement('li');
      list.appendChild(li);
      block.replaceWith(list);
      target = li;
    } else if (kind === 'h') {
      target = document.createElement(`h${m[1].length}`);
      block.replaceWith(target);
    } else if (kind === 'quote') {
      const q = document.createElement('blockquote');
      const p = document.createElement('p');
      q.appendChild(p);
      block.replaceWith(q);
      target = p;
    } else if (kind === 'pre') {
      target = document.createElement('pre');
      target.setAttribute('data-lang', m[1] || '');
      block.replaceWith(target);
    }
    if (!target.firstChild) target.appendChild(document.createElement('br'));
    placeCaret(target, 0);
    lastRule = { html, block: target };
  };

  const applyBlockRules = (block) => {
    if (block.tagName !== 'P' || isInside(block, ['BLOCKQUOTE', 'LI'])) return false;
    const text = block.textContent.split(ZWSP).join('');
    for (const rule of BLOCK_RULES) {
      const m = rule.re.exec(text);
      if (m && textBeforeCaret(block) === text) {
        convertBlock(block, rule.kind, m);
        return true;
      }
    }
    return false;
  };

  const applyInlineRules = (block) => {
    const s = getSel();
    if (!s || isInside(s.anchorNode, ['CODE', 'PRE', 'A'])) return false;
    const before = textBeforeCaret(block);
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(before);
      if (!m) continue;
      const lead = rule.lead ? m[1].length : 0;
      const len = m[0].length - lead;
      const r = rangeBack(len);
      if (!r) return false;
      const el2 = document.createElement(rule.tag);
      el2.textContent = m[rule.g];
      r.deleteContents();
      r.insertNode(el2);
      block.normalize();
      caretAfter(el2);
      lastRule = null; // inline conversions are undone by plain Backspace on the element
      return true;
    }
    const u = URL_RULE.exec(before);
    if (u) {
      const len = u[0].length - u[1].length; // url + trailing space
      const r = rangeBack(len);
      if (!r) return false;
      const a = document.createElement('a');
      const url = u[2];
      a.setAttribute('href', /^www\./.test(url) ? `https://${url}` : url);
      a.textContent = url;
      r.deleteContents();
      r.insertNode(a);
      const space = document.createTextNode(' ');
      a.parentNode.insertBefore(space, a.nextSibling);
      block.normalize();
      placeCaret(space, 1);
      return true;
    }
    return false;
  };

  /* ---- keys ---- */
  const bridgeKey = (e) => {
    // The page's handlers live on the textarea. Let them see the key first;
    // whatever they prevent (Enter = send) the editor leaves alone.
    let clone;
    try {
      clone = new KeyboardEvent(e.type, {
        key: e.key, code: e.code, keyCode: e.keyCode, which: e.which, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, repeat: e.repeat, bubbles: true, cancelable: true,
      });
    } catch (err) {
      return false;
    }
    el.dispatchEvent(clone);
    if (clone.cancelBubble) e.stopPropagation();
    if (clone.defaultPrevented) {
      e.preventDefault();
      return true;
    }
    return false;
  };

  const splitBlockAtCaret = (block) => {
    // Move everything after the caret into a new block of the given kind.
    const s = getSel();
    const r = document.createRange();
    r.setStart(s.anchorNode, s.anchorOffset);
    r.setEndAfter(block.lastChild || block);
    const tail = r.extractContents();
    return tail;
  };

  const handleEnter = () => {
    const block = caretBlock(editor);
    if (!block) {
      const p = document.createElement('p');
      p.appendChild(document.createElement('br'));
      editor.appendChild(p);
      placeCaret(p, 0);
      return;
    }
    if (block.tagName === 'PRE') {
      // A newline inside the block; an empty last line + Enter leaves it.
      const s = getSel();
      const t = block.textContent.split(ZWSP).join('');
      const atEnd = textBeforeCaret(block) === t;
      if (atEnd && t.endsWith('\n')) {
        block.textContent = t.replace(/\n$/, '');
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        block.after(p);
        placeCaret(p, 0);
        return;
      }
      const nl = document.createTextNode('\n');
      const r = document.createRange();
      r.setStart(s.anchorNode, s.anchorOffset);
      r.collapse(true);
      r.insertNode(nl);
      placeCaret(nl, 1);
      block.normalize();
      return;
    }
    if (block.tagName === 'LI') {
      const empty = !block.textContent.split(ZWSP).join('').trim() && !block.querySelector('ul, ol');
      if (empty) {
        // Leave the list.
        const list = block.parentNode;
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        if (block.nextElementSibling) {
          // Split the list around the exit.
          const rest = document.createElement(list.tagName.toLowerCase());
          while (block.nextSibling) rest.appendChild(block.nextSibling);
          list.after(rest);
          rest.before(p);
        } else list.after(p);
        block.remove();
        if (!list.children.length) list.remove();
        placeCaret(p, 0);
        return;
      }
      const li = document.createElement('li');
      li.appendChild(splitBlockAtCaret(block));
      if (!li.firstChild) li.appendChild(document.createElement('br'));
      if (!block.firstChild) block.appendChild(document.createElement('br'));
      block.after(li);
      placeCaret(li, 0);
      return;
    }
    // Paragraph / heading: a new PARAGRAPH after (headings do not repeat).
    const tail = splitBlockAtCaret(block);
    const p = document.createElement('p');
    p.appendChild(tail);
    if (!p.firstChild) p.appendChild(document.createElement('br'));
    if (!block.firstChild) block.appendChild(document.createElement('br'));
    if (block.parentNode.tagName === 'BLOCKQUOTE' && !block.textContent.split(ZWSP).join('').trim() && !p.textContent.trim()) {
      // Enter on an empty quoted line leaves the quote.
      const q = block.parentNode;
      block.remove();
      q.after(p);
      if (!q.children.length) q.remove();
    } else block.after(p);
    placeCaret(p, 0);
  };

  const handleBackspace = (e) => {
    const block = caretBlock(editor);
    if (!block) return;
    // Undo the last autoformat while nothing else was typed.
    if (lastRule && lastRule.block === block && !block.textContent.split(ZWSP).join('')) {
      e.preventDefault();
      const tpl = document.createElement('template');
      tpl.innerHTML = lastRule.html;
      const restored = tpl.content.firstElementChild;
      const outer = block.closest('ul, ol, blockquote') || block;
      outer.replaceWith(restored);
      caretToEnd(restored);
      lastRule = null;
      push();
      return;
    }
    if (textBeforeCaret(block) !== '') return; // not at the start: native delete
    const tag = block.tagName;
    if (tag === 'LI') {
      e.preventDefault();
      const list = block.parentNode;
      const p = document.createElement('p');
      while (block.firstChild) p.appendChild(block.firstChild);
      if (!p.firstChild) p.appendChild(document.createElement('br'));
      if (block.previousElementSibling && block.nextElementSibling) {
        const rest = document.createElement(list.tagName.toLowerCase());
        while (block.nextSibling) rest.appendChild(block.nextSibling);
        list.after(rest);
        rest.before(p);
      } else if (block.previousElementSibling) list.after(p);
      else list.before(p);
      block.remove();
      if (!list.children.length) list.remove();
      placeCaret(p, 0);
      push();
    } else if (/^H[1-3]$/.test(tag) || tag === 'PRE') {
      e.preventDefault();
      const p = document.createElement('p');
      if (tag === 'PRE') p.textContent = block.textContent;
      else while (block.firstChild) p.appendChild(block.firstChild);
      if (!p.firstChild) p.appendChild(document.createElement('br'));
      block.replaceWith(p);
      placeCaret(p, 0);
      push();
    } else if (tag === 'P' && block.parentNode.tagName === 'BLOCKQUOTE' && !block.previousElementSibling) {
      e.preventDefault();
      const q = block.parentNode;
      q.before(block);
      if (!q.children.length) q.remove();
      placeCaret(block, 0);
      push();
    }
  };

  const onKeydown = (e) => {
    if (composing || e.isComposing) return;
    if (bridgeKey(e)) return;
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      handleEnter();
      push();
    } else if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      handleBackspace(e);
    }
  };

  const onInput = (e) => {
    if (composing || (e && e.isComposing)) return;
    const block = caretBlock(editor);
    if (block && e && (e.inputType === 'insertText' || e.inputType === 'insertCompositionText' || !e.inputType)) {
      if (!applyBlockRules(block)) applyInlineRules(block);
    } else if (e && e.inputType && e.inputType.startsWith('delete')) {
      lastRule = null;
    }
    push();
  };

  const onPaste = (e) => {
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    const block = caretBlock(editor);
    if (block && block.tagName === 'PRE') {
      document.execCommand('insertText', false, text);
      push();
      return;
    }
    const blocks = markdownToBlocks(text);
    if (!blocks.length) return;
    const s = getSel();
    if (s && !s.isCollapsed) s.deleteFromDocument();
    const target = caretBlock(editor);
    const inlineOnly = blocks.length === 1 && blocks[0].tagName === 'P';
    if (inlineOnly && target) {
      const frag = document.createDocumentFragment();
      while (blocks[0].firstChild) frag.appendChild(blocks[0].firstChild);
      const last = frag.lastChild;
      const r = document.createRange();
      r.setStart(s.anchorNode, s.anchorOffset);
      r.collapse(true);
      r.insertNode(frag);
      if (last) {
        if (last.nodeType === 3) placeCaret(last, last.nodeValue.length);
        else caretAfter(last);
      }
      target.normalize();
    } else if (target) {
      // Split the current block; the pasted blocks go between the halves.
      const tail = splitBlockAtCaret(target);
      const tailP = document.createElement('p');
      tailP.appendChild(tail);
      const anchor = target.closest('ul, ol, blockquote') && !target.matches('p') ? target : target;
      let after = anchor.parentNode === editor ? anchor : anchor.closest('ul, ol, blockquote, pre') || anchor;
      for (const b of blocks) {
        after.after(b);
        after = b;
      }
      if (tailP.textContent.trim()) {
        after.after(tailP);
        caretToEnd(after);
      } else caretToEnd(after);
      if (!target.textContent.split(ZWSP).join('').trim() && target.parentNode === editor && target.tagName === 'P') target.remove();
      if (!target.firstChild && target.parentNode) target.appendChild(document.createElement('br'));
    } else {
      for (const b of blocks) editor.appendChild(b);
      caretToEnd(editor);
    }
    lastRule = null;
    push();
  };

  /* ---- wiring ---- */
  editor.addEventListener('keydown', onKeydown);
  editor.addEventListener('input', onInput);
  editor.addEventListener('paste', onPaste);
  editor.addEventListener('compositionstart', () => { composing = true; });
  editor.addEventListener('compositionend', () => {
    composing = false;
    onInput({ inputType: 'insertText' });
  });
  // A click on a link should place the caret, not navigate away mid-edit.
  editor.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a')) e.preventDefault(); });

  // Programmatic writes — jQuery's .val(''), the quick-reply buttons, a
  // restored draft — go through the element's own `value` setter.
  if (desc && desc.set && desc.get) {
    Object.defineProperty(el, 'value', {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return rawGet(); },
      set(v) {
        rawSet(v);
        if (!syncing && serialize(editor) !== String(v ?? '')) setContent(String(v ?? ''));
      },
    });
  }
  // focus() on the textarea means "put me in the box".
  const nativeFocus = el.focus;
  el.focus = (...args) => {
    editor.focus(...args);
    if (!getSel() || !within(editor, getSel().anchorNode)) caretToEnd(editor);
  };
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.attributeName === 'disabled') syncDisabled();
      if (m.attributeName === 'placeholder') syncPlaceholder();
    }
  });
  mo.observe(el, { attributes: true, attributeFilter: ['disabled', 'placeholder'] });
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    // Pages that size a container around the box (the tutor card's Monaco
    // view zone) listen for this and re-fit.
    ro = new ResizeObserver(() => {
      try { el.dispatchEvent(new CustomEvent('pta-composer-resize', { bubbles: true })); } catch (e) { /* old engines */ }
    });
    ro.observe(editor);
  }

  setContent(rawGet());
  syncPlaceholder();
  syncDisabled();

  const api = {
    editor,
    refresh: () => setContent(rawGet()),
    getMarkdown: () => serialize(editor),
    destroy() {
      mo.disconnect();
      if (ro) ro.disconnect();
      if (desc) delete el.value;
      el.focus = nativeFocus;
      el.classList.remove('pta-composer__input');
      wrap.parentNode.insertBefore(el, wrap);
      wrap.remove();
      delete el.__ptaComposer;
    },
  };
  el.__ptaComposer = api;
  return api;
}

/** Mount on every matching textarea under root (a DOM element or jQuery set). */
export function mountComposers(root, selector, opts) {
  const r = root && root.nodeType === 1 ? root : (root && root[0]) || document;
  const list = [];
  for (const el of r.querySelectorAll(selector)) {
    const api = mountComposer(el, opts);
    if (api) list.push(api);
  }
  return list;
}

export default mountComposer;
