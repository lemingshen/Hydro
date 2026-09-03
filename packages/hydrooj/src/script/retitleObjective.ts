import Schema from 'schemastery';
import { escapeOptionLine } from '../lib/objective_markdown';
import { isObjectivePid, objectiveTitleOf } from '../lib/objective_title';
import * as document from '../model/document';
import problem from '../model/problem';

/**
 * PTA fork — normalize the objective tasks that already exist.
 *
 * Two rules now apply on save (manual builder and AI Studio alike):
 *   1. an objective task is titled by its question text (lib/objective_title);
 *   2. option lines under a select / multiselect marker are escaped so that
 *      an option such as `>>` renders verbatim instead of as a blockquote
 *      (lib/objective_markdown).
 * Tasks created before those rules keep their old title and content until
 * this script runs. Dry-run by default: it reports what would change; pass
 * `apply: true` to write. Scoped to one domain when `domainId` is set; the
 * two fixes can be switched off individually.
 */

/** Escape the option lists of a task body, leaving everything else verbatim. */
function escapeOptionLists(body: string): string {
    const lines = String(body || '').replace(/\r/g, '').split('\n');
    let fence = false;
    let inList = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(?:```|~~~)/.test(line)) {
            fence = !fence;
            inList = false;
            continue;
        }
        if (fence) continue;
        if (/\{\{\s*(?:select|multiselect)\(\d+(?:-\d+)?\)\s*\}\}/.test(line)) {
            inList = true;
            continue;
        }
        if (!inList) continue;
        if (!line.trim()) continue;
        if (!/^\s*[-*+]\s/.test(line)) {
            inList = false;
            continue;
        }
        lines[i] = escapeOptionLine(line);
    }
    return lines.join('\n');
}

export const apply = (ctx) => ctx.addScript(
    'retitleObjective', 'Normalize objective tasks (pid O…): title = question text, option lines escaped.',
    Schema.object({
        domainId: Schema.string(),
        apply: Schema.boolean().default(false),
        retitle: Schema.boolean().default(true),
        fixOptions: Schema.boolean().default(true),
    }),
    async (arg, report) => {
        const filter: any = { docType: document.TYPE_PROBLEM };
        if (arg.domainId) filter.domainId = arg.domainId;
        let seen = 0;
        let changed = 0;
        for await (const pdoc of document.coll.find(filter, { projection: { domainId: 1, docId: 1, pid: 1, title: 1, content: 1 } })) {
            if (!isObjectivePid(pdoc.pid)) continue;
            seen++;
            const update: Record<string, any> = {};
            const notes: string[] = [];
            const content = typeof pdoc.content === 'string' ? pdoc.content : '';
            if (arg.fixOptions !== false && content && !/^\s*\{/.test(content)) {
                const fixed = escapeOptionLists(content);
                if (fixed !== content) {
                    update.content = fixed;
                    notes.push('options escaped');
                }
            }
            if (arg.retitle !== false) {
                const draft = /^\[AI Draft\] /.test(String(pdoc.title || ''));
                const derived = objectiveTitleOf(update.content ?? content, String(pdoc.title || '').replace(/^\[AI Draft\] /, ''));
                const next = draft ? `[AI Draft] ${derived}` : derived;
                if (next && next !== pdoc.title) {
                    update.title = next;
                    notes.push(`title "${pdoc.title}" -> "${next}"`);
                }
            }
            if (!notes.length) continue;
            changed++;
            report({ message: `${pdoc.domainId}/${pdoc.pid}: ${notes.join('; ')}` });
            if (arg.apply) await problem.edit(pdoc.domainId, pdoc.docId, update);
        }
        const verb = arg.apply ? 'updated' : 'would be updated (run with apply: true to write)';
        report({ message: `${seen} objective task(s) scanned, ${changed} ${verb}` });
        return true;
    },
);
