/* eslint-disable max-len */
/**
 * PTA fork — ONE rule for "may this student see their own verdict?".
 *
 * A record made inside a test or a homework carries `rdoc.contest = tid`.
 * The activity pages mask such records through contest.applyProjection, but
 * the fork added side channels that read records directly and so bypassed
 * it: the problem UI's trajectory endpoint, the assistant's `my_submission`
 * tool, and anything else that queries RecordModel for "my submissions".
 * Each of those would happily hand a student the verdict of a submission
 * their own test is still hiding.
 *
 * maskOwnRecords() is the shared gate. It answers per record, from the
 * container that owns it:
 *
 *   staff (owner, maintainer, PERM_EDIT_CONTEST, root)  → untouched
 *   activity still running / not released                → masked
 *   activity finished AND its results published          → untouched
 *
 * "Published" is contest.resultsPublished: for a homework that contains a
 * subjective task, the deadline alone is not enough — the teacher's
 * "Evaluate" publishes it (handler/contest.ts). Masking mirrors
 * applyProjection exactly, so a masked record looks the same here as on the
 * activity page: Waiting, no score, no cases, no judge or compiler text.
 */
import type { ObjectId } from 'mongodb';
import type { RecordDoc, Tdoc } from '../interface';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import type { User } from '../model/user';

export interface MaskContext {
    user: User;
}

const key = (tid: ObjectId | string) => String(tid);

/** Staff of THIS activity see everything, as they do on every other surface. */
function isStaff(h: MaskContext, tdoc: Tdoc): boolean {
    const u = h.user;
    if (!u) return false;
    if (u.hasPriv?.(PRIV.PRIV_EDIT_SYSTEM) || u.hasPerm?.(PERM.PERM_EDIT_CONTEST) || u.hasPerm?.(PERM.PERM_EDIT_HOMEWORK)) return true;
    return tdoc.owner === u._id || (tdoc.maintainer || []).includes(u._id);
}

/**
 * May the requester see the RESULT of their own record from outside the
 * activity page? False while the activity runs, and false for a finished
 * activity whose results the teacher has not published yet.
 */
export function resultVisibleToOwner(h: MaskContext, tdoc: Tdoc | null | undefined): boolean {
    if (!tdoc) return true; // a plain problem-set submission: nothing to withhold
    if (isStaff(h, tdoc)) return true;
    if (!contest.isDone(tdoc)) return false;
    return contest.resultsPublished(tdoc);
}

/** The same fields applyProjection strips, so a masked record reads identically everywhere. */
export function maskRecord<T extends Partial<RecordDoc>>(rdoc: T): T {
    const r: any = rdoc;
    r.status = 0; // STATUS_WAITING
    delete r.score;
    delete r.time;
    delete r.memory;
    delete r.progress;
    delete r.subtasks;
    r.testCases = [];
    r.judgeTexts = ['Results are withheld until this assessment ends.'];
    r.compilerTexts = [];
    return rdoc;
}

/**
 * Mask every record whose owning activity has not released its results.
 * Loads each activity once. Records without `contest` pass through.
 * Mutates and returns the array it is given.
 */
export async function maskOwnRecords<T extends Partial<RecordDoc>>(h: MaskContext, domainId: string, rdocs: T[]): Promise<T[]> {
    const tids = [...new Set(rdocs.map((r) => (r as any).contest).filter((t) => t).map(key))];
    if (!tids.length) return rdocs;
    const visible = new Map<string, boolean>();
    for (const tid of tids) {
        // eslint-disable-next-line no-await-in-loop
        const tdoc = await contest.get(domainId, tid as any).catch(() => null);
        // An activity that cannot be loaded is treated as hiding: fail closed.
        visible.set(tid, tdoc ? resultVisibleToOwner(h, tdoc) : false);
    }
    for (const rdoc of rdocs) {
        const tid = (rdoc as any).contest;
        if (!tid) continue;
        if (!visible.get(key(tid))) maskRecord(rdoc);
    }
    return rdocs;
}

/** True when the record's result is withheld (for callers that want to say so rather than mask silently). */
export async function ownRecordWithheld(h: MaskContext, domainId: string, rdoc: Partial<RecordDoc>): Promise<boolean> {
    const tid = (rdoc as any)?.contest;
    if (!tid) return false;
    const tdoc = await contest.get(domainId, tid).catch(() => null);
    return !(tdoc ? resultVisibleToOwner(h, tdoc) : false);
}

/**
 * Activities that own `pid` and are NOT finished-and-published right now.
 * A task in one of them must not be reachable from the problem set: the
 * question itself is live somewhere. Staff are exempt.
 */
export async function liveActivitiesOwning(h: MaskContext, domainId: string, pid: number): Promise<Tdoc[]> {
    const out: Tdoc[] = [];
    const tdocs = await contest.getMulti(domainId, { pids: pid } as any)
        .project({
            docId: 1, owner: 1, maintainer: 1, title: 1, rule: 1, beginAt: 1, endAt: 1, penaltySince: 1, extensionDays: 1, manualEval: 1, evaluatedAt: 1, pids: 1,
        }).limit(200).toArray();
    for (const tdoc of tdocs as any[]) {
        if (isStaff(h, tdoc)) continue;
        if (!resultVisibleToOwner(h, tdoc)) out.push(tdoc);
    }
    return out;
}
