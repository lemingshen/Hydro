import { Context } from '../context';
import { Logger } from '../logger';
import * as contest from '../model/contest';
import SelfLearningModel from '../model/selflearning';

const logger = new Logger('activity-pids');

/**
 * PTA fork — TASKS THAT BELONG TO AN ACTIVITY ARE NOT PROBLEM-SET MATERIAL.
 *
 * A task picked into a homework, a test or a self-learning session is that
 * activity's material: a student must meet it there, under its clock and
 * its rules, and never stumble on it (or practise it in advance) through
 * the problem set. This module answers "is this problem owned by some
 * activity in this domain?" for the problem list, the problem page and the
 * problem-set rail, which hide such tasks from students.
 *
 * It is a VIEW-TIME rule, not a flag on the problem: nothing is written to
 * the problem document, so adding a task to a homework — or removing it —
 * takes effect at once and never clobbers a teacher's own `hidden` setting.
 * Staff (problem editors, activity owners, homework teachers, root) are
 * unaffected, and a task remains fully reachable INSIDE its activity, which
 * is what the correction path after a deadline uses.
 *
 * The set is cached per domain for a few seconds — the problem list is one
 * of the hottest pages, while contests change rarely — and dropped as soon
 * as any contest or session is written.
 */

const TTL = 15 * 1000;
/** Which activities own a task: the teacher's list shows them, students never see the task. */
export interface ActivityOwner { kind: 'homework' | 'test' | 'session', title: string, id: string }
const cache = new Map<string, { at: number, owners: Map<number, ActivityOwner[]> }>();

/** pid → the activities that own it (homework / test / self-learning session). */
export async function activityOwners(domainId: string): Promise<Map<number, ActivityOwner[]>> {
    const hit = cache.get(domainId);
    if (hit && Date.now() - hit.at < TTL) return hit.owners;
    const owners = new Map<number, ActivityOwner[]>();
    const add = (pid: number, o: ActivityOwner) => {
        if (typeof pid !== 'number') return;
        const list = owners.get(pid) || [];
        if (list.length < 6) list.push(o);
        owners.set(pid, list);
    };
    try {
        const [tdocs, sdocs] = await Promise.all([
            contest.getMulti(domainId, {}).project({ pids: 1, title: 1, rule: 1 }).limit(2000).toArray(),
            SelfLearningModel.getMulti(domainId, {}).project({ pids: 1, title: 1 }).limit(2000).toArray(),
        ]);
        for (const t of tdocs as any[]) {
            for (const pid of t.pids || []) add(pid, { kind: t.rule === 'homework' ? 'homework' : 'test', title: t.title || '', id: String(t.docId) });
        }
        for (const sd of sdocs as any[]) {
            for (const pid of sd.pids || []) add(pid, { kind: 'session', title: sd.title || '', id: String(sd.docId) });
        }
    } catch (e) {
        logger.warn('failed to collect activity pids for %s: %s', domainId, e.message);
        // On failure, hide nothing: the problem set stays as it was.
        return new Map();
    }
    cache.set(domainId, { at: Date.now(), owners });
    return owners;
}

/** Every pid used by a contest / homework / self-learning session of the domain. */
export async function activityPids(domainId: string): Promise<Set<number>> {
    return new Set((await activityOwners(domainId)).keys());
}

/**
 * May this student open an activity task from OUTSIDE its activity?
 * Only when they actually took part in an activity that owns it AND that
 * activity is over: this is the correction / practice path the fork opens
 * after a deadline (the in-activity page submits without a tid, so it
 * lands here). A student who never took the activity gets nothing.
 */
export async function entitledToActivityTask(domainId: string, uid: number, pid: number): Promise<boolean> {
    if (!uid || uid <= 1) return false;
    try {
        const tsdocs = await contest.getMultiStatus(domainId, { uid, attend: 1 }).project({ docId: 1 }).limit(500).toArray();
        for (const ts of tsdocs as any[]) {
            // eslint-disable-next-line no-await-in-loop
            const tdoc = await contest.get(domainId, ts.docId).catch(() => null);
            if (!tdoc || !(tdoc.pids || []).includes(pid)) continue;
            if (contest.isDone(tdoc)) return true;
        }
    } catch (e) {
        logger.warn('entitlement check failed for uid=%d pid=%d: %s', uid, pid, e.message);
    }
    return false;
}

/** Drop the cache of one domain (or all) — called whenever an activity changes. */
export function invalidateActivityPids(domainId?: string) {
    if (domainId) cache.delete(domainId);
    else cache.clear();
}

export function applyActivityPidsCache(ctx: Context) {
    /*
     * Deletions are the one change that must be seen at once (a task freed
     * by removing its activity should return to the problem set); everything
     * else is picked up by the short TTL, so editing a homework's task list
     * takes effect within seconds without any bookkeeping.
     */
    const drop = () => invalidateActivityPids();
    ctx.on('contest/del', drop);
    ctx.on('domain/delete', drop);
}
