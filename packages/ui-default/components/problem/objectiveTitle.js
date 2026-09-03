/**
 * PTA fork — client mirror of hydrooj/src/lib/objective_title.ts.
 *
 * Objective tasks are titled by their question text: the content with the
 * option lines and the answer markers removed, Markdown flattened to plain
 * text, capped at OBJECTIVE_TITLE_MAX characters. The server applies this
 * rule when a task is saved; the edit form uses this copy to show the title
 * live while the teacher types. Keep the two in sync.
 */

export const OBJECTIVE_TITLE_MAX = 200;

const MARKER_RE = /\{\{\s*(input|select|multiselect|textarea|dropdown)\(\d+(?:-\d+)?\)(?:\[[^\]]*\])?\s*\}\}/g;
const BLANK = '\u0000';

function firstStatement(content) {
  const raw = String(content ?? '');
  if (!/^\s*\{/.test(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const body = parsed.en || parsed.zh || parsed.zh_TW || Object.values(parsed)[0];
      return typeof body === 'string' ? body : raw;
    }
  } catch (e) { /* plain markdown that happens to start with a brace */ }
  return raw;
}

export function objectiveTitleOf(content, fallback = '', max = OBJECTIVE_TITLE_MAX) {
  let text = firstStatement(content).replace(/\r/g, '');
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, '');
  text = text.replace(MARKER_RE, (_, tag) => (tag === 'select' || tag === 'multiselect' ? ' ' : ` ${BLANK} `));
  const lines = text.split('\n')
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>\s?/, ''))
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^[-*+]\s+/.test(t)) return false;
      if (/^\(?[A-Ha-h][.、)]\s+/.test(t)) return false;
      if (/^\[[ xX]\]/.test(t)) return false;
      if (/^(?:---|\*\*\*|___)\s*$/.test(t)) return false;
      return true;
    });
  text = lines.join(' ');
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
  text = text.replace(/^\d+\s*[.、)]\s*/, '').trim();
  if (text.length > max) text = `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return text || String(fallback || '').trim();
}
