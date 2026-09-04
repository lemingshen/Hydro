import { PermissionError, ValidationError } from '../error';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import { clearGradeWeights, getGradeWeights, setGradeWeights } from '../model/gradecenter';
import SelfLearningModel from '../model/selflearning';
import user from '../model/user';
import { Handler, param, Types } from '../service/server';

/**
 * PTA fork — GRADE CENTER (teachers and root): every student's FINAL
 * score (out of 100) in every self-learning session, homework and test of
 * the domain, side by side, plus the COURSE GRADE (out of 100): the
 * weighted mean of those scores by the percentages the teacher assigns to
 * the activities (equal weights by default).
 *
 * Only final scores appear here — per task detail lives on each
 * activity's own page:
 *   session   → the evaluated total (results.rows[].total, /maxTotal);
 *               "not evaluated" until the teacher (or the deadline) runs
 *               the evaluation;
 *   homework  → the scoreboard's penalized, weighted points
 *               (tsdoc.penaltyScore, teacher adjustments included) mapped
 *               onto 100 by the paper's full score;
 *   test      → the scoreboard score (tsdoc.score) mapped the same way.
 * A missing score counts 0 in the course grade (the student simply did
 * not earn it); an activity with weight 0 stays visible but does not
 * count. Staff are never rows: activity owners/maintainers and anyone
 * holding the homework edit/create permissions are left out, exactly as
 * the session evaluation does.
 */

const MAX_ACTIVITIES = 80;
const MAX_STUDENTS = 2000;
const round1 = (x: number) => Math.round(x * 10) / 10;

export interface GradeActivity {
    key: string;
    kind: 'session' | 'homework' | 'test';
    id: string;
    title: string;
    beginAt: Date | null;
    endAt: Date | null;
    ended: boolean;
    /** False = nothing to show yet (session not evaluated / no participant). */
    hasResults: boolean;
    participants: number;
    full: number;
    weight: number;
    scores: Map<number, number | null>;
}

function fullScoreOf(tdoc: any): number {
    const weights = Object.values(tdoc.score || {}) as any[];
    const sum = weights.reduce((a: number, b: any) => a + (+b || 0), 0);
    return sum > 0 ? sum : Math.max(1, (tdoc.pids || []).length * 100);
}

export async function buildGradeBook(domainId: string) {
    const weights = await getGradeWeights(domainId);
    const activities: GradeActivity[] = [];
    const staff = new Set<number>();
    const uids = new Set<number>();

    // ---- self-learning sessions: the evaluated totals ----
    const sdocs = await SelfLearningModel.getMulti(domainId, {}).limit(MAX_ACTIVITIES).toArray() as any[];
    for (const sdoc of sdocs) {
        staff.add(sdoc.owner);
        const rows: any[] = sdoc.results?.rows || [];
        const scores = new Map<number, number | null>();
        const max = sdoc.results?.maxTotal || 100;
        for (const r of rows) {
            scores.set(r.uid, typeof r.total === 'number' ? round1((r.total * 100) / max) : null);
            uids.add(r.uid);
        }
        activities.push({
            key: `session:${sdoc.docId.toHexString()}`,
            kind: 'session',
            id: sdoc.docId.toHexString(),
            title: sdoc.title,
            beginAt: sdoc.beginAt || null,
            endAt: sdoc.endAt || null,
            ended: !sdoc.endAt || sdoc.endAt <= new Date(),
            hasResults: !!sdoc.results,
            participants: rows.length,
            full: max,
            weight: 0,
            scores,
        });
    }

    // ---- homework and tests: the scoreboard scores, mapped onto 100 ----
    const tdocs = await contest.getMulti(domainId, { rule: { $in: ['homework', 'test'] } }).limit(MAX_ACTIVITIES).toArray() as any[];
    for (const tdoc of tdocs) {
        staff.add(tdoc.owner);
        for (const m of tdoc.maintainer || []) staff.add(m);
        const full = fullScoreOf(tdoc);
        const tsdocs = await contest.getMultiStatus(domainId, { docId: tdoc.docId }).limit(MAX_STUDENTS + 50).toArray() as any[];
        const scores = new Map<number, number | null>();
        let participants = 0;
        for (const ts of tsdocs) {
            if (!ts.attend && !ts.journal?.length && !ts.override) continue;
            const raw = tdoc.rule === 'homework'
                ? (typeof ts.penaltyScore === 'number' ? ts.penaltyScore : (typeof ts.score === 'number' ? ts.score : null))
                : (typeof ts.score === 'number' ? ts.score : null);
            scores.set(ts.uid, raw === null ? null : round1((raw * 100) / full));
            uids.add(ts.uid);
            participants += 1;
        }
        activities.push({
            key: `${tdoc.rule}:${tdoc.docId.toHexString()}`,
            kind: tdoc.rule,
            id: tdoc.docId.toHexString(),
            title: tdoc.title,
            beginAt: tdoc.beginAt || null,
            endAt: tdoc.endAt || null,
            ended: contest.isDone(tdoc),
            hasResults: participants > 0,
            participants,
            full,
            weight: 0,
            scores,
        });
    }
    // Clustered by kind — homework, then tests, then self-learning sessions
    // — and chronological within a cluster, the way a grade book reads.
    const KIND_ORDER: Record<string, number> = { homework: 0, test: 1, session: 2 };
    activities.sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || ((a.beginAt?.getTime() || 0) - (b.beginAt?.getTime() || 0)));

    // ---- weights: stored, or an equal split over the activities that
    // have results (an unevaluated session or an empty test stays at 0
    // until it has scores, so it cannot pull every grade down by default) ----
    const hasStored = Object.keys(weights).length > 0;
    const countable = activities.filter((a) => a.hasResults);
    if (hasStored) {
        for (const a of activities) a.weight = Math.max(0, +weights[a.key] || 0);
    } else {
        // An equal split that adds up to exactly 100: two decimals each,
        // the rounding remainder on the last countable activity.
        const each = Math.floor((100 / Math.max(1, countable.length)) * 100) / 100;
        let left = 100;
        for (const a of activities) a.weight = 0;
        countable.forEach((a, i) => {
            a.weight = i === countable.length - 1 ? Math.round(left * 100) / 100 : each;
            left = Math.round((left - a.weight) * 100) / 100;
        });
    }
    const weightSum = Math.round(activities.reduce((s, a) => s + a.weight, 0) * 100) / 100;
    const groups = (['homework', 'test', 'session'] as const)
        .map((kind) => ({
            kind,
            count: activities.filter((a) => a.kind === kind).length,
            weight: Math.round(activities.filter((a) => a.kind === kind).reduce((s, a) => s + a.weight, 0) * 100) / 100,
        }))
        .filter((g) => g.count > 0);

    // ---- students: everyone who took part, minus staff ----
    const list = [...uids].filter((u) => !staff.has(u)).slice(0, MAX_STUDENTS);
    const udict: any = list.length ? await user.getList(domainId, list) : {};
    const students = [];
    for (const uid of list) {
        const udoc: any = udict[uid];
        try {
            if (udoc && typeof udoc.hasPerm === 'function' && (udoc.hasPerm(PERM.PERM_EDIT_HOMEWORK) || udoc.hasPerm(PERM.PERM_CREATE_HOMEWORK))) continue;
        } catch (e) { /* keep the row */ }
        const scores: Record<string, number | null> = {};
        let weighted = 0;
        for (const a of activities) {
            const s = a.scores.has(uid) ? a.scores.get(uid)! : null;
            scores[a.key] = s;
            if (a.weight > 0) weighted += a.weight * (s || 0);
        }
        students.push({
            uid,
            uname: udoc?.uname || String(uid),
            name: `${udoc?.firstName || ''} ${udoc?.lastName || ''}`.trim() || udoc?.displayName || '',
            scores,
            final: weightSum > 0 ? round1(weighted / weightSum) : null,
        });
    }
    students.sort((a, b) => a.uname.localeCompare(b.uname, undefined, { numeric: true, sensitivity: 'base' }));
    // Class means per column (over the students who have a score) and of the final grade.
    const means: Record<string, number | null> = {};
    for (const a of activities) {
        const xs = students.map((st) => st.scores[a.key]).filter((x): x is number => typeof x === 'number');
        means[a.key] = xs.length ? round1(xs.reduce((p, q) => p + q, 0) / xs.length) : null;
    }
    const finals = students.map((st) => st.final).filter((x): x is number => typeof x === 'number');
    means.final = finals.length ? round1(finals.reduce((p, q) => p + q, 0) / finals.length) : null;
    return {
        activities: activities.map((a) => ({ ...a, scores: undefined })),
        groups,
        students,
        means,
        weightSum,
        stored: hasStored,
    };
}

/** Teachers (homework editors / creators) and root see the Grade Center. */
export function canUseGradeCenter(handler: any): boolean {
    const u = handler?.user;
    if (!u) return false;
    return u.role === 'root' || u.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
        || u.hasPerm(PERM.PERM_EDIT_HOMEWORK) || u.hasPerm(PERM.PERM_CREATE_HOMEWORK);
}

class GradeCenterHandler extends Handler {
    async prepare() {
        if (!canUseGradeCenter(this)) throw new PermissionError(PERM.PERM_EDIT_HOMEWORK);
    }

    @param('export', Types.String, true)
    async get({ domainId }, exportAs = '') {
        const book = await buildGradeBook(domainId);
        if (exportAs === 'csv') {
            const csvEsc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
            const head = ['Student ID', 'Name', ...book.activities.map((a) => `${a.title} [${a.kind}] (${a.weight}%)`), 'Final (/100)'];
            const lines = [head.map(csvEsc).join(',')];
            for (const st of book.students) {
                lines.push([st.uname, st.name, ...book.activities.map((a) => (st.scores[a.key] === null ? '' : st.scores[a.key])), st.final ?? ''].map(csvEsc).join(','));
            }
            this.response.type = 'text/csv';
            this.response.disposition = `attachment; filename="grade-center-${domainId}.csv"`;
            this.response.body = `\uFEFF${lines.join('\r\n')}\r\n`;
            return;
        }
        this.response.template = 'grade_center.html';
        this.response.body = { book };
        this.UiContext.gradeCenter = {
            url: this.url('grade_center'),
            activities: book.activities.map((a) => ({ key: a.key, weight: a.weight })),
        };
    }

    /** Save the percentages: { "<activity key>": percent, … }; unknown keys are ignored. */
    @param('weights', Types.Content)
    async postWeights({ domainId }, weightsJson: string) {
        let parsed: any;
        try {
            parsed = JSON.parse(weightsJson);
        } catch (e) {
            throw new ValidationError('weights');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ValidationError('weights');
        const book = await buildGradeBook(domainId);
        const known = new Set(book.activities.map((a) => a.key));
        const weights: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (!known.has(k)) continue;
            const n = +(v as any);
            if (!Number.isFinite(n) || n < 0 || n > 1000) throw new ValidationError('weights');
            weights[k] = Math.round(n * 100) / 100;
        }
        await setGradeWeights(domainId, weights, this.user._id);
        const fresh = await buildGradeBook(domainId);
        this.response.body = { ok: true, weightSum: fresh.weightSum, activities: fresh.activities.map((a) => ({ key: a.key, weight: a.weight })), students: fresh.students.map((s) => ({ uid: s.uid, final: s.final })) };
    }

    /** Back to the equal split. */
    async postReset({ domainId }) {
        await clearGradeWeights(domainId);
        const fresh = await buildGradeBook(domainId);
        this.response.body = { ok: true, weightSum: fresh.weightSum, activities: fresh.activities.map((a) => ({ key: a.key, weight: a.weight })), students: fresh.students.map((s) => ({ uid: s.uid, final: s.final })) };
    }
}

export async function apply(ctx) {
    ctx.Route('grade_center', '/grade-center', GradeCenterHandler);
    /*
     * The nav entry is registered HERE rather than in lib/ui.ts: handler
     * files are (re)loaded by the dev server's hot reload, lib/ui.ts only
     * at process start — so dropping this file in is enough for the item
     * to appear. ctx.injectUI is disposable, so a reload never duplicates
     * it. `before: 'discussion_main'` puts it right after Self-Learning.
     */
    ctx.injectUI('Nav', 'grade_center', { prefix: 'grade_center', before: 'discussion_main' }, canUseGradeCenter);
}
