import $ from 'jquery';
import { AutoloadPage } from 'vj/misc/Page';

/**
 * PTA fork: no selecting / copying of protected text for students.
 *
 * The server sets UiContext.noCopy on pages where a student reads a task
 * statement (problem page, the Scratchpad IDE, the objective paper, the
 * subjective task page, self-learning tasks). Protected regions are the
 * statement itself and everything the AI tutor writes — the question cards
 * and the launcher panel's history. Students keep full use of inputs and
 * the editor. This is a deterrent against casual copy-paste, not a
 * security boundary: the text is still in the page for those who dig.
 */
const PROTECTED = [
  '.problem-content', // statement: problem page + Scratchpad (same node) + self-learning
  '.paper-q__content', // objective paper questions
  '.sl-anno__log', // tutor question cards (dialogue)
  '.sl-anno__note',
  '#sl-chat', // launcher panel history
  '.sl-chat',
].join(', ');
const EDITABLE = 'input, textarea, select, [contenteditable="true"], .monaco-editor, .CodeMirror';

export default new AutoloadPage('no_copy', () => {
  if (!window.UiContext || !UiContext.noCopy) return;
  if (!document.getElementById('pta-nocopy-style')) {
    $('<style>').attr('id', 'pta-nocopy-style').text([
      `${PROTECTED} { -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none; }`,
      `${PROTECTED.split(', ').map((s) => `${s} *`).join(', ')} { -webkit-user-select: none !important; user-select: none !important; }`,
      `${PROTECTED.split(', ').map((s) => `${s} ${EDITABLE}`).join(', ')} { -webkit-user-select: text !important; user-select: text !important; }`,
      `${PROTECTED.split(', ').map((s) => `${s} img`).join(', ')} { -webkit-user-drag: none; pointer-events: none; }`,
    ].join('\n')).appendTo(document.head);
  }
  const inProtected = (el) => !!(el && el.nodeType === 1 ? $(el).closest(PROTECTED).length : el && el.parentElement && $(el.parentElement).closest(PROTECTED).length);
  const isEditable = (el) => !!(el && el.nodeType === 1 && $(el).closest(EDITABLE).length);
  const selectionTouchesProtected = () => {
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const nodes = $(PROTECTED).get();
    return nodes.some((n) => { try { return sel.containsNode(n, true); } catch (e) { return false; } });
  };
  // Clipboard: block copy/cut/drag that originate in — or whose selection
  // reaches into — a protected region, unless the student is working in a
  // real input (their own text).
  const guard = (ev) => {
    const t = ev.target;
    if (isEditable(t) && !inProtected(t)) return;
    if (isEditable(t)) return; // an input inside a card: their own answer
    if (inProtected(t) || selectionTouchesProtected()) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  document.addEventListener('copy', guard, true);
  document.addEventListener('cut', guard, true);
  document.addEventListener('dragstart', guard, true);
  document.addEventListener('contextmenu', (ev) => {
    if (inProtected(ev.target) && !isEditable(ev.target)) ev.preventDefault();
  }, true);
  // Ctrl/Cmd+A followed by copy: the copy guard above handles it via the
  // selection check; also prevent select-all from starting inside a region.
  document.addEventListener('selectstart', (ev) => {
    if (inProtected(ev.target) && !isEditable(ev.target)) ev.preventDefault();
  }, true);
});
