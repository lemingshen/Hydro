/**
 * PTA fork — objective question builder (logic, no DOM).
 *
 * One objective task holds ONE question. Instead of typing Hydro's marker
 * grammar by hand ( `{{ select(1) }}` + an option list, `{{ input(1) }}` … )
 * and a config.yaml answer key, the teacher fills a small form; this module
 * turns the form state into the Markdown the judge understands and into the
 * `answers` map of config.yaml, and parses an existing task back into the
 * form so it can be edited. pages/objective_builder.page.js owns the DOM.
 *
 * Four question types:
 *   blank     fill-in-the-blank   {{ input(n) }} per blank, exact-match answers
 *   single    single choice       {{ select(1) }} + "- option" list, one letter
 *   multiple  multiple choice     {{ multiselect(1) }} + list, letters array
 *   tf        true / false        {{ select(1) }} + two fixed options
 *
 * Grading (hydrojudge/src/judge/objective.ts): a choice answer is the option
 * LETTER (A, B, …) — students submit letters; a blank is compared as a
 * trimmed string. A blank may accept SEVERAL answers ("iostream" and
 * "<iostream>"): those use the judge's map form `{ answer: score, … }` — any
 * key that matches scores. The task-level `matching` flags (ignoreCase,
 * ignoreSpaces) relax the comparison; the judge applies them, an older judge
 * ignores them and compares exactly. Every task is worth TASK_SCORE, split
 * evenly over blanks.
 */

export const TASK_SCORE = 100;
export const MAX_OPTIONS = 10;
export const MAX_BLANKS = 10;

export const TYPES = ['blank', 'single', 'multiple', 'tf'];
export const MAX_ANSWERS_PER_BLANK = 10;
export const MATCHING_FLAGS = ['ignoreCase', 'ignoreSpaces'];

/** Distinct, non-empty, trimmed accepted answers of one blank. */
export function cleanAnswers(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : [list]) {
    const t = String(a ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Only the flags that are on, or null when matching is exact. */
export function cleanMatching(matching) {
  const out = {};
  for (const f of MATCHING_FLAGS) if (matching && matching[f]) out[f] = true;
  return Object.keys(out).length ? out : null;
}

const MARKER_RE = /\{\{\s*(input|select|multiselect|textarea|dropdown)\(\d+(?:-\d+)?\)(?:\[[^\]]*\])?\s*\}\}/;
const MARKER_RE_G = new RegExp(MARKER_RE.source, 'g');
/** In the stem of a fill-in question, a run of 3+ underscores is also a blank. */
const BLANK_TOKEN_RE = /\{\{\s*input\(\d+(?:-\d+)?\)\s*\}\}|_{3,}/g;

const TRUE_WORDS = ['true', 't', 'yes', 'correct', 'right', '对', '對', '正确', '正確', '是', '真'];
const FALSE_WORDS = ['false', 'f', 'no', 'incorrect', 'wrong', '错', '錯', '错误', '錯誤', '否', '假'];

/**
 * An option is one Markdown list item. Text that STARTS with a block-level
 * construct would change the structure instead of being shown: `- >>` is a
 * blockquote inside the item (the option renders as an empty quoted box),
 * `- # x` a heading, `- - x` / `- 1. x` a nested list, `- <vector>` an HTML
 * tag that vanishes (html is enabled). A backslash before the first such
 * character (CommonMark escapes any ASCII punctuation) keeps the option
 * verbatim while inline Markdown the teacher wants — `code`, **bold** — still
 * works. `<` before a letter is escaped anywhere for the same reason.
 * Mirrored by hydrooj/src/lib/objective_markdown.ts.
 */
export function escapeOptionText(text) {
  let t = String(text || '').replace(/\r?\n/g, ' ').trim();
  if (!t) return t;
  const codeSpan = /^`[^`]+`$/.test(t); // a whole-option code span stays code
  if (/^\d+[.)](?:\s|$)/.test(t)) t = t.replace(/^(\d+)([.)])/, '$1\\$2');
  else if (!codeSpan && /^[>#\-+*~=|[`!]/.test(t)) t = `\\${t}`;
  if (codeSpan) return t;
  t = t.replace(/<(?=[a-zA-Z/!?])/g, '\\<');
  return t;
}

/** Inverse of escapeOptionText for the builder's editable fields. */
export function unescapeOptionText(text) {
  return String(text || '')
    .replace(/^(\d+)\\([.)])/, '$1$2')
    .replace(/^\\([>#\-+*~=|[`!])/, '$1')
    .replace(/\\</g, '<');
}

export const letterOf = (i) => String.fromCharCode(65 + i);
export const indexOfLetter = (l) => String(l || '').trim().toUpperCase().charCodeAt(0) - 65;

/** Number of blanks in a fill-in stem (markers and ____ runs, in order). */
export function countBlanks(stem) {
  return (String(stem || '').match(BLANK_TOKEN_RE) || []).length;
}

/** Fill-in stem → Markdown: every blank becomes {{ input(k) }}, numbered 1..n. */
export function blankStemToMarkdown(stem) {
  let n = 0;
  return String(stem || '').replace(BLANK_TOKEN_RE, () => `{{ input(${++n}) }}`).trim();
}

/** Split TASK_SCORE over n parts as positive integers (remainder to the first). */
export function splitScore(n, total = TASK_SCORE) {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const out = Array.from({ length: n }, () => base);
  out[0] += total - base * n;
  return out;
}

/**
 * Form state → { markdown, answers, matching, issues }.
 * state: { type, stem, options: [{ text, correct }], blankAnswers: [[string]], matching: { ignoreCase, ignoreSpaces }, tf: 'A'|'B', tfLabels: [T, F] }
 * `issues` lists what still blocks saving (empty = valid).
 */
export function build(state) {
  const type = TYPES.includes(state.type) ? state.type : 'single';
  const stem = String(state.stem || '').replace(/\r/g, '');
  const issues = [];
  let markdown = '';
  const answers = {};
  let matching = null;
  if (type === 'blank') {
    const n = countBlanks(stem);
    if (!stem.trim()) issues.push('Write the question text.');
    if (!n) issues.push('Insert at least one blank (click "Insert blank" or type ____ in the question).');
    if (n > MAX_BLANKS) issues.push(`At most ${MAX_BLANKS} blanks per task.`);
    markdown = blankStemToMarkdown(stem);
    const scores = splitScore(n);
    for (let k = 0; k < n; k++) {
      const list = cleanAnswers((state.blankAnswers || [])[k] || []);
      if (!list.length) issues.push(`Blank ${k + 1} has no expected answer.`);
      if (list.length > MAX_ANSWERS_PER_BLANK) issues.push(`At most ${MAX_ANSWERS_PER_BLANK} accepted answers per blank.`);
      if (list.some((a) => a.length > 200)) issues.push(`Blank ${k + 1}: keep each accepted answer under 200 characters.`);
      // One answer keeps the classic [answer, score] form; several use the
      // judge's map form, every accepted answer worth the blank's score.
      if (list.length <= 1) answers[String(k + 1)] = [list[0] || '', scores[k]];
      else answers[String(k + 1)] = Object.fromEntries(list.map((a) => [a, scores[k]]));
    }
    matching = cleanMatching(state.matching);
  } else if (type === 'tf') {
    if (!stem.trim()) issues.push('Write the statement to be judged.');
    const [t, f] = state.tfLabels || ['True', 'False'];
    markdown = `${stem.trim()} {{ select(1) }}\n- ${escapeOptionText(t)}\n- ${escapeOptionText(f)}`;
    const tf = state.tf === 'B' ? 'B' : (state.tf === 'A' ? 'A' : '');
    if (!tf) issues.push('Pick whether the statement is true or false.');
    answers['1'] = [tf || 'A', TASK_SCORE];
  } else {
    const options = (state.options || []).map((o) => ({ text: String(o.text || '').replace(/\r?\n/g, ' ').trim(), correct: !!o.correct }));
    if (!stem.trim()) issues.push('Write the question text.');
    if (options.length < 2) issues.push('A choice question needs at least two options.');
    if (options.length > MAX_OPTIONS) issues.push(`At most ${MAX_OPTIONS} options per question.`);
    options.forEach((o, i) => { if (!o.text) issues.push(`Option ${letterOf(i)} is empty.`); });
    const correct = options.map((o, i) => (o.correct ? letterOf(i) : null)).filter((x) => x);
    if (type === 'single') {
      if (correct.length !== 1) issues.push('Tick exactly one correct option.');
      answers['1'] = [correct[0] || 'A', TASK_SCORE];
    } else {
      if (!correct.length) issues.push('Tick at least one correct option.');
      answers['1'] = [correct.length ? correct : ['A'], TASK_SCORE];
    }
    const tag = type === 'single' ? 'select' : 'multiselect';
    markdown = `${stem.trim()}\n\n{{ ${tag}(1) }}\n${options.map((o) => `- ${escapeOptionText(o.text)}`).join('\n')}`;
  }
  return { type, markdown, answers, matching, issues };
}

/** The config.yaml fragment the server merges (JSON is valid YAML). */
export function answersYaml(answers, matching = null) {
  const m = cleanMatching(matching);
  return `type: objective\nanswers: ${JSON.stringify(answers)}\n${m ? `matching: ${JSON.stringify(m)}\n` : ''}`;
}

/** Accepted answers of one blank from either config form. */
export function acceptedAnswersOf(entry) {
  if (entry === undefined || entry === null) return [];
  if (Array.isArray(entry)) {
    const a = entry[0];
    if (Array.isArray(a)) return cleanAnswers(a);
    return cleanAnswers([a]);
  }
  if (typeof entry === 'object') return cleanAnswers(Object.keys(entry));
  return cleanAnswers([entry]);
}

const isTfPair = (options) => options.length === 2
  && TRUE_WORDS.includes(options[0].toLowerCase().replace(/[.。!]$/, ''))
  && FALSE_WORDS.includes(options[1].toLowerCase().replace(/[.。!]$/, ''));

/**
 * Existing task → form state, or null when the content is not something the
 * builder can represent (no marker, or a textarea/dropdown marker, or more
 * than one choice marker). `answers` is the config.yaml map, if any.
 */
export function parse(content, answers, matching) {
  const md = String(content || '').replace(/\r/g, '');
  const ans = answers && typeof answers === 'object' ? answers : {};
  const m = MARKER_RE.exec(md);
  if (!m) return null;
  const [full, tag] = m;
  if (tag === 'input') {
    const markers = md.match(MARKER_RE_G) || [];
    if (markers.some((x) => !/^\{\{\s*input\(/.test(x))) return null;
    const ids = markers.map((x) => /\((\d+(?:-\d+)?)\)/.exec(x)[1]);
    const blankAnswers = ids.map((id) => acceptedAnswersOf(ans[id]));
    return {
      type: 'blank', stem: md.trim(), blankAnswers, matching: cleanMatching(matching) || {}, options: [], tf: '',
    };
  }
  if (tag !== 'select' && tag !== 'multiselect') return null;
  const rest = md.slice(m.index + full.length);
  if (MARKER_RE.test(rest)) return null; // several questions in one task
  const stem = md.slice(0, m.index).replace(/\s+$/, '');
  const lines = rest.split('\n');
  const options = [];
  let started = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (started) break;
      continue;
    }
    const om = /^[-*+]\s(.*)$/.exec(t);
    if (!om) {
      if (started) break;
      return null;
    }
    started = true;
    options.push(unescapeOptionText(om[1].trim()));
  }
  if (options.length < 2) return null;
  const v = ans['1'];
  const raw = Array.isArray(v) ? v[0] : v;
  const letters = new Set((Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/))
    .map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z]$/.test(x)));
  if (tag === 'select' && isTfPair(options)) {
    return { type: 'tf', stem: stem.trim(), tf: letters.has('B') ? 'B' : (letters.has('A') ? 'A' : ''), tfLabels: options, options: [], blankAnswers: [] };
  }
  return {
    type: tag === 'select' ? 'single' : 'multiple',
    stem: stem.trim(),
    options: options.map((text, i) => ({ text, correct: letters.has(letterOf(i)) })),
    blankAnswers: [],
    tf: '',
  };
}
