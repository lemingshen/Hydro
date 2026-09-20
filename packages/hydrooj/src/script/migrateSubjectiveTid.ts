/* eslint-disable max-len */
import Schema from 'schemastery';
import * as contest from '../model/contest';
import { assignSubjectiveTid, listSubjectiveAll, SUBJECTIVE_NO_TID } from '../model/selflearning';
import db from '../service/db';

/** Domains that have any subjective submission at all. */
async function allSubjectiveDomains(): Promise<string[]> {
    return await db.collection('subjective.submission' as any).distinct('domainId') as any;
}

/**
 * PTA fork — move subjective hand-ins to the PER-HOMEWORK key.
 *
 * Submissions used to be stored as `${domainId}/${pid}/${uid}`: one per
 * student per TASK. A task reused by two homeworks (two sections, two
 * terms) therefore shared one hand-in, and the second homework's grading
 * read the first one's PDF. The key is now
 * `${domainId}/${tid}/${pid}/${uid}`.
 *
 * Reads still fall back to the old key, so nothing breaks before this runs.
 * This script gives each legacy document its homework:
 *
 *   - exactly one homework owns the task and the student attended it →
 *     assigned;
 *   - several candidates → reported, not touched (a human decides);
 *   - no homework owns the task → assigned to '-' (handed in outside any
 *     activity), which is where the task page will look for it.
 *
 * Dry-run by default:
 *   hydrooj cli script run migrateSubjectiveTid '{}'
 *   hydrooj cli script run migrateSubjectiveTid '{"apply":true}'
 */
export const apply = (ctx) => ctx.addScript(
    'migrateSubjectiveTid',
    'Assign legacy subjective submissions to their homework (dry-run by default).',
    Schema.object({
        domainId: Schema.string(),
        apply: Schema.boolean().default(false),
    }),
    async (arg, report) => {
        const domains: string[] = arg.domainId
            ? [arg.domainId]
            : [...new Set((await allSubjectiveDomains()).filter((d) => d))];
        let scanned = 0;
        let moved = 0;
        let ambiguous = 0;
        let orphan = 0;
        for (const domainId of domains) {
            // eslint-disable-next-line no-await-in-loop
            const docs = await listSubjectiveAll(domainId);
            const legacy = docs.filter((d) => !d.tid);
            report({ message: `${domainId}: ${docs.length} submission(s), ${legacy.length} on the old key` });
            for (const doc of legacy) {
                scanned += 1;
                // eslint-disable-next-line no-await-in-loop
                const tdocs = await contest.getMulti(domainId, { rule: 'homework', pids: doc.pid } as any)
                    .project({ docId: 1, title: 1, endAt: 1 }).limit(50).toArray() as any[];
                if (!tdocs.length) {
                    orphan += 1;
                    if (arg.apply) await assignSubjectiveTid(doc, SUBJECTIVE_NO_TID); // eslint-disable-line no-await-in-loop
                    continue;
                }
                const attended: any[] = [];
                for (const t of tdocs) {
                    // eslint-disable-next-line no-await-in-loop
                    const tsdoc = await contest.getStatus(domainId, t.docId, doc.uid).catch(() => null);
                    if (tsdoc?.attend) attended.push(t);
                }
                const candidates = attended.length ? attended : tdocs;
                if (candidates.length > 1) {
                    ambiguous += 1;
                    report({ message: `  ? uid ${doc.uid} pid ${doc.pid}: ${candidates.length} candidate homeworks (${candidates.map((t) => t.title).join(', ')}) — left alone` });
                    continue;
                }
                const tid = candidates[0].docId.toHexString();
                moved += 1;
                report({ message: `  → uid ${doc.uid} pid ${doc.pid} → "${candidates[0].title}"` });
                if (arg.apply) await assignSubjectiveTid(doc, tid); // eslint-disable-line no-await-in-loop
            }
        }
        report({
            message: arg.apply
                ? `Done: ${moved} moved, ${orphan} marked as outside any homework, ${ambiguous} left for a human, of ${scanned} legacy submission(s).`
                : `${moved} would move, ${orphan} would be marked as outside any homework, ${ambiguous} need a decision, of ${scanned} legacy submission(s). Re-run with apply: true.`,
        });
        return true;
    },
);
