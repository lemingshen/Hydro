/* eslint-disable max-len */
import { ObjectId } from 'mongodb';
import Schema from 'schemastery';
import { runSessionEvaluation } from '../handler/self_learning';
import * as document from '../model/document';
import { collTutor, TYPE_SELF_LEARNING } from '../model/selflearning';

/**
 * PTA fork — RE-EVALUATE self-learning sessions graded before the
 * 2026-09 grader fixes.
 *
 * Two bugs made the AI rubric dimensions come out empty:
 *
 *   1. `gradedSessionThreads` (handler/self_learning.ts) called ITSELF
 *      instead of the model's `getSessionThreads`. It is the first line of
 *      all six retroactive graders — 🎓 ownership, 🔧 fix-conversion,
 *      🧩 reasoning, 💡 initiative, 📈 trajectory, 🧠 transfer — so each
 *      one threw "Maximum call stack size exceeded" into its own
 *      try/catch and was logged as a warning. Evaluation still finished
 *      and still stored results, which is why nothing looked broken:
 *      the affected dimensions were simply absent or "—".
 *
 *   2. `completeAnnotateReply` computed the per-answer level as
 *      `accepted && typeof result.level === 'number'`, so a failing
 *      submission always produced `level === null` and the reasoning
 *      branch right below it was unreachable. 🧩 REASONING was therefore
 *      never recorded live either, even though the dialogue prompt grades
 *      every answer and the model returns the level.
 *
 * Both are fixed. This script re-runs THE evaluation entry point
 * (`runSessionEvaluation`, the same one behind the teacher's "Evaluate
 * all students now" button) over sessions that were evaluated while the
 * bugs were live, so the retroactive graders can now read the stored
 * tutor dialogues and fill in what is missing. Reasoning levels that the
 * live path dropped are recovered the same way: grader (2) in
 * lib/ai_tutor.ts re-reads the stored answers.
 *
 * Dry-run by default — it reports what it would do and touches nothing.
 *
 *   hydrooj cli script run regradeSelfLearning '{}'
 *   hydrooj cli script run regradeSelfLearning '{"apply":true}'
 *   hydrooj cli script run regradeSelfLearning '{"apply":true,"domainId":"pf"}'
 *
 * Cost warning: a full re-evaluation calls the AI provider per student
 * per dimension. Run it out of teaching hours, start with `limit` small,
 * and watch the AI status card. Sessions are processed one at a time on
 * purpose; the scheduler still applies its own fairness and caps.
 */

interface Candidate {
    domainId: string;
    docId: ObjectId;
    title: string;
    evaluatedAt: Date | null;
    students: number;
    missing: string[];
}

/** The rubric dimensions the broken graders were responsible for. */
const RETRO_DIMENSIONS: [string, (row: any) => boolean][] = [
    ['ownership', (r) => typeof r?.ownership === 'number'],
    ['fixconv', (r) => typeof r?.fixconv === 'number'],
    ['reasoning', (r) => typeof r?.reasoning === 'number'],
    ['initiative', (r) => typeof r?.initiative === 'number'],
    ['trajectory', (r) => typeof r?.trajectory === 'number'],
    ['transfer', (r) => typeof r?.transfer === 'number'],
];

/**
 * A session is a candidate when it has stored results whose rows carry
 * tutoring evidence (threads exist) but whose retroactive dimensions are
 * empty for every student — the signature of the swallowed recursion.
 */
async function inspect(sdoc: any): Promise<Candidate | null> {
    const rows: any[] = sdoc.results?.rows || [];
    if (!rows.length) return null;
    const threads = await collTutor.countDocuments({ domainId: sdoc.domainId, ssid: sdoc.docId });
    if (!threads) return null; // no dialogues: nothing for the graders to read
    const missing = RETRO_DIMENSIONS.filter(([, has]) => !rows.some((r) => has(r))).map(([name]) => name);
    if (!missing.length) return null;
    return {
        domainId: sdoc.domainId,
        docId: sdoc.docId,
        title: sdoc.title || String(sdoc.docId),
        evaluatedAt: sdoc.results?.at ? new Date(sdoc.results.at) : null,
        students: rows.length,
        missing,
    };
}

export const apply = (ctx) => ctx.addScript(
    'regradeSelfLearning',
    'Re-evaluate self-learning sessions graded before the 2026-09 grader fixes (dry-run by default).',
    Schema.object({
        domainId: Schema.string(),
        apply: Schema.boolean().default(false),
        /** Only sessions evaluated before this ISO date (default: all). */
        before: Schema.string(),
        /** Stop after this many sessions (0 = no limit). */
        limit: Schema.number().default(0),
    }),
    async (arg, report) => {
        const q: any = { docType: TYPE_SELF_LEARNING, 'results.rows': { $exists: true } };
        if (arg.domainId) q.domainId = arg.domainId;
        if (arg.before) {
            const cutoff = new Date(arg.before);
            if (Number.isNaN(cutoff.getTime())) throw new Error(`"before" is not a date: ${arg.before}`);
            q['results.at'] = { $lt: cutoff };
        }
        const sdocs = await document.coll.find(q).project({
            domainId: 1, docId: 1, title: 1, results: 1,
        }).toArray();
        report({ message: `${sdocs.length} evaluated session(s) to inspect${arg.domainId ? ` in ${arg.domainId}` : ''}` });

        const candidates: Candidate[] = [];
        for (const sdoc of sdocs as any[]) {
            // eslint-disable-next-line no-await-in-loop
            const c = await inspect(sdoc);
            if (c) candidates.push(c);
        }
        if (!candidates.length) {
            report({ message: 'No affected session found — every evaluated session already carries its retroactive dimensions.' });
            return true;
        }
        report({ message: `${candidates.length} session(s) affected:` });
        for (const c of candidates) {
            report({ message: `  ${c.domainId}/${c.docId} "${c.title}" — ${c.students} student(s), missing: ${c.missing.join(', ')}${c.evaluatedAt ? ` (evaluated ${c.evaluatedAt.toISOString().slice(0, 16).replace('T', ' ')})` : ''}` });
        }
        if (!arg.apply) {
            report({ message: 'Dry run. Re-run with apply: true to evaluate these sessions again (this calls the AI provider).' });
            return true;
        }

        const targets = arg.limit > 0 ? candidates.slice(0, arg.limit) : candidates;
        let ok = 0;
        let busy = 0;
        let failed = 0;
        for (const c of targets) {
            try {
                // force = true: stored results are final, so only a forced run re-grades them.
                // eslint-disable-next-line no-await-in-loop
                const outcome = await runSessionEvaluation(c.domainId, c.docId, true);
                if (outcome.ran) {
                    ok += 1;
                    const rows = outcome.results?.rows || [];
                    const filled = RETRO_DIMENSIONS.filter(([, has]) => rows.some((r: any) => has(r))).map(([n]) => n);
                    report({ message: `  OK ${c.domainId}/${c.docId} re-evaluated — dimensions now present: ${filled.join(', ') || '(none — check the AI provider)'}` });
                } else {
                    busy += 1;
                    report({ message: `  .. ${c.domainId}/${c.docId} skipped: another evaluation is already running` });
                }
            } catch (e) {
                failed += 1;
                report({ message: `  !! ${c.domainId}/${c.docId} failed: ${e.message}` });
            }
        }
        report({ message: `Done: ${ok} re-evaluated, ${busy} busy, ${failed} failed, of ${targets.length} attempted.` });
        return true;
    },
);
