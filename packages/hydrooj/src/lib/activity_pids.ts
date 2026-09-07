import { Context } from '../context';
import { Logger } from '../logger';
import * as contest from '../model/contest';
import * as document from '../model/document';
import problem from '../model/problem';
import SelfLearningModel, { TYPE_SELF_LEARNING } from '../model/selflearning';
import db from '../service/db';

const logger = new Logger('activity-pids');

/**
 * PTA fork — TASKS THAT BELONG TO AN ACTIVITY ARE NOT PROBLEM-SET MATERIAL.
 *
 * A task picked into a homework, a test or a self-learning session must not
 * be practised IN ADVANCE through the problem set. So the lock is a
 * START gate, not a membership gate:
 *
 *   before beginAt  → students never see the task in the problem set
 *   from beginAt on → the task is ordinary problem-set material again,
 *                     while the activity runs and forever after it ends
 *
 * The point is only to stop someone getting a head start. Once an activity
 * has begun, everyone in the domain has met it, and the task becomes
 * practice material for the whole class — which is also what lets the
 * knowledge map recommend it (lib/knowledge_map.ts only suggests tasks a
 * student can actually open).
 *
 * ⚠ The consequence is deliberate: while an activity is RUNNING its tasks
 * are visible in the problem set, so this is NOT a sealed-contest setup.
 * If a domain ever needs problems sealed for the duration of a live
 * contest, `pendingOnly` below is the single thing to change.
 *
 * This module answers "is this problem locked by an activity that has not
 * started yet?" for the problem list, the problem page and the problem-set
 * rail.
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

/*
 * Short TTL: it now also bounds how long after an activity's beginAt a
 * task can still look locked, so it must stay small.
 */
const TTL = 15 * 1000;
/**
 * Which activities own a task. The teacher's list shows them all; only the
 * ones that have NOT started (`pending`) actually hide the task.
 */
export interface ActivityOwner {
    kind: 'homework' | 'test' | 'session',
    title: string,
    id: string,
    /** Has not begun yet — this is what locks the task. */
    pending: boolean,
    /** Start time in epoch ms; 0 when the activity has no scheduled start. */
    beginAt: number,
}
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
        // A task locked by ANY not-yet-started activity stays locked, so the
        // pending ones are worth keeping even past the display cap.
        else if (o.pending && !list.some((x) => x.pending)) list[list.length - 1] = o;
        owners.set(pid, list);
    };
    const now = Date.now();
    /** An activity with no scheduled start has no "before", so it never locks. */
    const startOf = (d: any) => (d?.beginAt ? new Date(d.beginAt).getTime() : 0);
    try {
        const [tdocs, sdocs] = await Promise.all([
            contest.getMulti(domainId, {}).project({ pids: 1, title: 1, rule: 1, beginAt: 1 }).limit(2000).toArray(),
            SelfLearningModel.getMulti(domainId, {}).project({ pids: 1, title: 1, beginAt: 1 }).limit(2000).toArray(),
        ]);
        for (const t of tdocs as any[]) {
            const beginAt = startOf(t);
            const pending = beginAt > now;
            for (const pid of t.pids || []) {
                add(pid, {
                    kind: t.rule === 'homework' ? 'homework' : 'test', title: t.title || '', id: String(t.docId), pending, beginAt,
                });
            }
        }
        for (const sd of sdocs as any[]) {
            const beginAt = startOf(sd);
            const pending = beginAt > now;
            for (const pid of sd.pids || []) {
                add(pid, {
                    kind: 'session', title: sd.title || '', id: String(sd.docId), pending, beginAt,
                });
            }
        }
    } catch (e) {
        logger.warn('failed to collect activity pids for %s: %s', domainId, e.message);
        // On failure, hide nothing: the problem set stays as it was.
        return new Map();
    }
    cache.set(domainId, { at: Date.now(), owners });
    return owners;
}

/**
 * The pids students must not meet in the problem set: those held by at
 * least one activity that HAS NOT STARTED yet.
 *
 * A task whose activities have all begun is deliberately absent from this
 * set — it is ordinary problem-set material from that moment on.
 */
export async function activityPids(domainId: string): Promise<Set<number>> {
    const out = new Set<number>();
    for (const [pid, list] of await activityOwners(domainId)) {
        if (list.some((o) => o.pending)) out.add(pid);
    }
    return out;
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

/* ------------------------------------------------------------------ */
/*  🩹 LEGACY hidden-FLAG REPAIR                                       */
/* ------------------------------------------------------------------ */
/**
 * Visibility of activity tasks is owned by lib/activity_pids.ts, which
 * applies a START GATE at view time and writes nothing to the problem
 * document. This sweep exists only to clean up after the mechanism that
 * came BEFORE it.
 *
 * Older builds hid activity tasks by setting `hidden: true` on the problem
 * itself (contest autoHide). That flag persists, and buildQuery in
 * handler/problem.ts filters on it, so such a task stays invisible to
 * students no matter what the start gate says — the task is locked by a
 * flag nothing clears any more. Here we clear it, once, for tasks whose
 * activities have all started.
 *
 * Strictly one-way: this NEVER sets `hidden`. Hiding is view-time now, and
 * writing the flag would clobber a teacher's own choice — the exact thing
 * activity_pids was built to avoid. The marker makes each repair happen
 * once, so a teacher who deliberately re-hides a task afterwards keeps it
 * hidden instead of fighting a timer every ten minutes.
 */
const collVisibility = db.collection('problem.restored' as any);

const visibilityId = (domainId: string, docId: number) => `${domainId}/${docId}`;

/**
 * Clear stale `hidden: true` flags on activity tasks that have started.
 * Returns how many were returned to the problem set.
 */
export async function repairLegacyHiddenFlags(now = new Date()): Promise<number> {
    const docs = await document.coll.find({
        docType: { $in: [document.TYPE_CONTEST, TYPE_SELF_LEARNING] },
    } as any).project({ domainId: 1, pids: 1, beginAt: 1 }).limit(5000).toArray();
    /** domainId -> pid -> latest start already elapsed */
    const started = new Map<string, Map<number, number>>();
    /** domainId -> pids still waiting to begin (never repaired) */
    const pending = new Map<string, Set<number>>();
    for (const d of docs as any[]) {
        if (!Array.isArray(d.pids) || !d.pids.length) continue;
        // No scheduled start means no "before", so it counts as started.
        const beginAt = d.beginAt ? new Date(d.beginAt).getTime() : 1;
        if (beginAt > now.getTime()) {
            if (!pending.has(d.domainId)) pending.set(d.domainId, new Set());
            for (const pid of d.pids) if (typeof pid === 'number') pending.get(d.domainId)!.add(pid);
            continue;
        }
        if (!started.has(d.domainId)) started.set(d.domainId, new Map());
        const m = started.get(d.domainId)!;
        for (const pid of d.pids) {
            if (typeof pid !== 'number') continue;
            m.set(pid, Math.max(m.get(pid) || 0, beginAt));
        }
    }
    let released = 0;
    for (const [domainId, pidStarts] of started) {
        const held = pending.get(domainId) || new Set<number>();
        // A task any un-started activity also holds keeps waiting.
        const candidates = [...pidStarts.keys()].filter((pid) => !held.has(pid));
        if (!candidates.length) continue;
        try {
            // eslint-disable-next-line no-await-in-loop
            const marks = await collVisibility.find({
                _id: { $in: candidates.map((pid) => visibilityId(domainId, pid)) },
            } as any).toArray();
            const markOf = new Map<string, number>();
            for (const m of marks as any[]) markOf.set(String(m._id), m.releasedFor || 0);
            // Recording WHICH start we repaired for is what makes reuse work:
            // an old task dropped into a new activity gets a newer start, so
            // it is repaired again if that activity's flag ever gets set.
            const todo = candidates.filter((pid) => (pidStarts.get(pid) || 0) > (markOf.get(visibilityId(domainId, pid)) || 0));
            if (!todo.length) continue;
            // eslint-disable-next-line no-await-in-loop
            const pdocs = await problem.getMulti(domainId, { docId: { $in: todo } }, ['docId', 'hidden'] as any).toArray();
            for (const pdoc of pdocs as any[]) {
                try {
                    if (pdoc.hidden) {
                        // eslint-disable-next-line no-await-in-loop
                        await problem.edit(domainId, pdoc.docId, { hidden: false });
                        released += 1;
                        logger.info('[visibility] %s/%d stale hidden flag cleared (its activity has started)', domainId, pdoc.docId);
                    }
                    // Recorded even when already visible, so a later manual
                    // hide is never undone by the next tick.
                    // eslint-disable-next-line no-await-in-loop
                    await collVisibility.updateOne(
                        { _id: visibilityId(domainId, pdoc.docId) } as any,
                        {
                            $set: {
                                _id: visibilityId(domainId, pdoc.docId),
                                domainId,
                                docId: pdoc.docId,
                                releasedFor: pidStarts.get(pdoc.docId) || 0,
                                at: new Date(),
                            },
                        },
                        { upsert: true },
                    );
                } catch (e: any) {
                    logger.warn('[visibility] repair %s/%d failed: %s', domainId, pdoc.docId, e.message);
                }
            }
        } catch (e: any) {
            logger.warn('[visibility] repair sweep failed for domain %s: %s', domainId, e.message);
        }
    }
    return released;
}
