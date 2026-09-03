/**
 * PTA fork — Markdown helpers for objective tasks (server side).
 *
 * An option of a choice question is one Markdown list item under the
 * `{{ select(n) }}` / `{{ multiselect(n) }}` marker. Option text that STARTS
 * with a block-level construct changes the structure instead of being shown:
 * `- >>` becomes a blockquote inside the item (the option renders as an empty
 * quoted box), `- # x` a heading, `- - x` / `- 1. x` a nested list, and with
 * HTML enabled `- <vector>` is a tag that vanishes. A backslash before the
 * first such character (CommonMark escapes any ASCII punctuation) keeps the
 * option verbatim; `<` before a letter is escaped anywhere for the same
 * reason. A whole-option code span (`like this`) is left alone.
 *
 * Mirrors ui-default/components/problem/objectiveBuilder.js (the manual
 * builder); used here for the option lines the AI Studio splits into tasks.
 */
export function escapeOptionText(text: string): string {
    let t = String(text || '').replace(/\r?\n/g, ' ').trim();
    if (!t) return t;
    const codeSpan = /^`[^`]+`$/.test(t);
    if (/^\d+[.)](?:\s|$)/.test(t)) t = t.replace(/^(\d+)([.)])/, '$1\\$2');
    else if (!codeSpan && /^[>#\-+*~=|[`!]/.test(t)) t = `\\${t}`;
    if (codeSpan) return t;
    return t.replace(/<(?=[a-zA-Z/!?])/g, '\\<');
}

/** `- option` list line → the same line with the option text escaped. */
export function escapeOptionLine(line: string): string {
    const m = /^(\s*[-*+]\s)(.*)$/.exec(line);
    if (!m) return line;
    return m[1] + escapeOptionText(m[2]);
}

/**
 * The question type of an objective task, from its content: the marker and,
 * for a select, whether its two options are a true/false pair.
 *   tf      true / false            select + exactly two true/false options
 *   choice  single / multiple choice select or multiselect
 *   blank   fill-in-the-blank        input, textarea or dropdown
 * Used by the test editor (sections) and the picker's `sub` filter.
 */
export type ObjectiveSubKind = 'tf' | 'choice' | 'blank';

const SUB_MARKER_RE = /\{\{\s*(input|select|multiselect|textarea|dropdown)\(\d+(?:-\d+)?\)(?:\[[^\]]*\])?\s*\}\}/;
const TRUE_WORDS = ['true', 't', 'yes', 'correct', 'right', '对', '對', '正确', '正確', '是', '真'];
const FALSE_WORDS = ['false', 'f', 'no', 'incorrect', 'wrong', '错', '錯', '错误', '錯誤', '否', '假'];

export function objectiveSubKindOf(content: string): ObjectiveSubKind | null {
    let md = String(content || '');
    if (/^\s*\{/.test(md)) {
        try {
            const j = JSON.parse(md);
            if (j && typeof j === 'object' && !Array.isArray(j)) md = String(j.en || j.zh || Object.values(j)[0] || '');
        } catch { /* plain markdown */ }
    }
    md = md.replace(/\r/g, '');
    const m = SUB_MARKER_RE.exec(md);
    if (!m) return null;
    const tag = m[1];
    if (tag === 'input' || tag === 'textarea' || tag === 'dropdown') return 'blank';
    if (tag === 'multiselect') return 'choice';
    const options: string[] = [];
    let started = false;
    for (const line of md.slice(m.index + m[0].length).split('\n')) {
        const t = line.trim();
        if (!t) {
            if (started) break;
            continue;
        }
        const om = /^[-*+]\s(.*)$/.exec(t);
        if (!om) break;
        started = true;
        options.push(om[1].trim().replace(/^\\/, '').toLowerCase().replace(/[.。!]$/, ''));
    }
    if (options.length === 2 && TRUE_WORDS.includes(options[0]) && FALSE_WORDS.includes(options[1])) return 'tf';
    return 'choice';
}
