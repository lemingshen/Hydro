/**
 * PTA fork — objective tasks are titled by their question text.
 *
 * An objective task holds ONE question (AI Studio splits a quiz one question
 * per task; the manual form creates one at a time). A hand-typed title for
 * every question is busywork, and AI-split tasks used to share one title with
 * a "— Q3" suffix, which made the homework / test pickers unreadable.
 *
 * So the title IS the question: the task's content with the option lines
 * (the A/B/C/D list under a select) and the answer markers (`{{ select(1) }}`
 * and friends — the "ticks" a student fills in) removed, Markdown flattened
 * to plain text, whitespace collapsed, capped at OBJECTIVE_TITLE_MAX
 * characters. `objectiveTitleOf()` is the single rule; every writer of an
 * objective title calls it:
 *
 *   - handler/ai_author.ts    materialize + publish of objective drafts
 *   - handler/problem.ts      manual create / edit (pid prefixed `O`)
 *   - script/retitleObjective retitles the tasks that already exist
 *
 * components/problem/objectiveTitle.js in ui-default mirrors this function
 * so the edit form can show the derived title while the teacher types.
 * Keep the two in sync.
 */

export const OBJECTIVE_TITLE_MAX = 200;

const MARKER_RE = /\{\{\s*(input|select|multiselect|textarea|dropdown)\(\d+(?:-\d+)?\)(?:\[[^\]]*\])?\s*\}\}/g;
/** Placeholder for an inline blank while Markdown is being flattened. */
const BLANK = '\u0000';

/** Multi-language statements are stored as a JSON object of bodies. */
function firstStatement(content: string): string {
    const raw = String(content ?? '');
    if (!/^\s*\{/.test(raw)) return raw;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const body = parsed.en || parsed.zh || parsed.zh_TW || Object.values(parsed)[0];
            return typeof body === 'string' ? body : raw;
        }
    } catch { /* plain markdown that happens to start with a brace */ }
    return raw;
}

/**
 * The question text of an objective task's content, as plain text.
 * Returns `fallback` when nothing readable is left (e.g. an image-only stem).
 */
export function objectiveTitleOf(content: string, fallback = '', max = OBJECTIVE_TITLE_MAX): string {
    let text = firstStatement(content).replace(/\r/g, '');
    // Fenced code stays as text (a stem may ask "what does this print?");
    // only the fence lines go.
    text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, '');
    // The answer markers: a fill-in (input / textarea / dropdown) is a blank
    // inside the sentence and is kept as "____"; a select / multiselect
    // marker only positions the option list and is dropped.
    text = text.replace(MARKER_RE, (_, tag) => (tag === 'select' || tag === 'multiselect' ? ' ' : ` ${BLANK} `));
    // Line-level Markdown, then the option lines.
    const lines = text.split('\n')
        .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, ''))
        .filter((line) => {
            const t = line.trim();
            if (!t) return false;
            if (/^[-*+]\s+/.test(t)) return false; // "- option"
            if (/^\(?[A-Ha-h][.、)]\s+/.test(t)) return false; // "A. option" / "(B) option"
            if (/^\[[ xX]\]/.test(t)) return false; // "[x] option"
            if (/^(?:---|\*\*\*|___)\s*$/.test(t)) return false; // thematic break
            return true;
        });
    text = lines.join(' ');
    // Inline Markdown → plain text.
    text = text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/(\*\*|__)(.+?)\1/g, '$2')
        .replace(/(\*|_)(.+?)\1/g, '$2')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\$\$([^$]+)\$\$/g, '$1')
        .replace(/\$([^$\n]+)\$/g, '$1')
        .replace(/[✓✔☑☐]/g, ' ')
        .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(new RegExp(`\\s*${BLANK}\\s*`, 'g'), ' ____ ')
        .replace(/\s+/g, ' ')
        .replace(/\s+([.,;:?!])/g, '$1')
        .trim();
    // A leading "3." style ordinal is numbering, not the question.
    text = text.replace(/^\d+\s*[.、)]\s*/, '').trim();
    if (text.length > max) text = `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
    return text || String(fallback || '').trim();
}

/** Objective kind is the `O` pid prefix (handler/problem.ts problemKindOf). */
export function isObjectivePid(pid: unknown): boolean {
    return /^o/i.test(String(pid || ''));
}
