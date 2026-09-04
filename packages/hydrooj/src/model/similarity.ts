import { ObjectId } from 'mongodb';
import db from '../service/db';

/*
 * PTA fork: CODE-SIMILARITY REPORTS for homework.
 *
 * When a homework's "Check Code Similarity" box is ticked, the students'
 * submissions to its programming tasks are compared with each other once
 * the homework ends (handler/similarity.ts runs Dolos through
 * lib/dolos.ts). ONE report per homework lives here, keyed
 * `${domainId}/${tid}`; a re-run replaces it. The report keeps the pairs
 * worth a teacher's attention (similarity at or above the configured
 * storage floor, capped per task and language) plus enough context — every
 * compared file with its record id and k-gram count — for the teacher page
 * to render names, verdicts and the side-by-side code view.
 */

export interface SimilarityFile {
    uid: number;
    rid: ObjectId;
    /** Hydro judge language key of the record (e.g. `cc.cc14o2`). */
    lang: string;
    /** Number of k-grams Dolos extracted; 0 means the file was too short to fingerprint. */
    kgrams: number;
    /** Judge status of the record at check time. */
    status: number;
    score: number;
    /** Highest similarity this file has with any other file of its group (0..1). */
    maxSimilarity: number;
}

export interface SimilarityPair {
    /** uid of the left / right student. */
    left: number;
    right: number;
    leftRid: ObjectId;
    rightRid: ObjectId;
    /** 0..1 — fraction of shared fingerprints (Dolos `similarity`). */
    similarity: number;
    /** Shared k-grams (Dolos `totalOverlap`). */
    overlap: number;
    /** Longest run of consecutive shared k-grams (Dolos `longestFragment`). */
    longest: number;
    leftCovered: number;
    rightCovered: number;
}

/** One Dolos run: the submissions of one task written in one (Dolos) language. */
export interface SimilarityGroup {
    /** Dolos language id the group was analyzed with (`cpp`, `python`, `char`, ...). */
    dolosLang: string;
    /** Hydro base language key(s) in the group, for display. */
    langs: string[];
    /** Display names of those languages. */
    langNames: string[];
    /** True when Dolos had no parser and compared characters. */
    charFallback: boolean;
    files: SimilarityFile[];
    /** Pairs at or above the storage floor, highest similarity first (capped). */
    pairs: SimilarityPair[];
    /** All pairs Dolos produced for the group (before the floor / cap). */
    totalPairs: number;
    /** Pairs at or above the flag threshold. */
    flagged: number;
    /** Set when this run failed; the other groups of the report still stand. */
    error?: string;
    /** Last lines of the Dolos console output. */
    log?: string;
    startedAt?: Date;
    finishedAt?: Date;
}

export interface SimilarityTask {
    pid: number;
    /** Display pid (`P1001`) and title at check time. */
    pidLabel: string;
    title: string;
    /** Students whose counted submission was compared. */
    submissions: number;
    /** Submissions left out: no code (answer / file uploads), or alone in their language. */
    skipped: number;
    groups: SimilarityGroup[];
}

export type SimilarityStatus = 'running' | 'done' | 'failed';

export interface SimilarityReportDoc {
    /** `${domainId}/${tid}` — one report per homework. */
    _id: string;
    domainId: string;
    tid: ObjectId;
    status: SimilarityStatus;
    /** Who / what started this run. */
    trigger: 'deadline' | 'manual';
    /** uid of the teacher who pressed "run", for manual runs. */
    by?: number;
    startedAt: Date;
    finishedAt?: Date;
    /** Whole-run failure (no groups could be evaluated). */
    error?: string;
    /** Live progress while running. */
    progress?: { done: number, total: number, label: string };
    engine: 'dolos';
    engineVersion?: string;
    /** The thresholds the run was stored with. */
    threshold: number;
    minStore: number;
    maxPairs: number;
    /** The check's scope. */
    students: number;
    tasks: SimilarityTask[];
    summary: {
        submissions: number;
        compared: number;
        groups: number;
        flagged: number;
        maxSimilarity: number;
    };
    /** The homework's title / pids at check time (edits after the run make the report stale). */
    snapshot: { title: string, pids: number[], endAt: Date };
}

declare module '../service/db' {
    interface Collections {
        'similarity.report': SimilarityReportDoc;
    }
}

export const coll = db.collection('similarity.report');

export function reportId(domainId: string, tid: ObjectId | string): string {
    return `${domainId}/${tid}`;
}

export class SimilarityModel {
    static get(domainId: string, tid: ObjectId | string): Promise<SimilarityReportDoc | null> {
        return coll.findOne({ _id: reportId(domainId, tid) });
    }

    /** Status, progress and the summary only — no pairs (polled while a run is in flight; shown on the homework page). */
    static getStatus(domainId: string, tid: ObjectId | string) {
        return coll.findOne({ _id: reportId(domainId, tid) }, {
            projection: {
                status: 1, trigger: 1, by: 1, startedAt: 1, finishedAt: 1, error: 1, progress: 1, summary: 1, threshold: 1, students: 1,
            },
        });
    }

    /** Replace the whole report (a new run always starts from a fresh document). */
    static async set(doc: SimilarityReportDoc): Promise<void> {
        await coll.replaceOne({ _id: doc._id }, doc, { upsert: true });
    }

    static async patch(domainId: string, tid: ObjectId | string, $set: Partial<SimilarityReportDoc>): Promise<void> {
        await coll.updateOne({ _id: reportId(domainId, tid) }, { $set });
    }

    static async del(domainId: string, tid: ObjectId | string): Promise<void> {
        await coll.deleteOne({ _id: reportId(domainId, tid) });
    }

    static async delByDomain(domainId: string): Promise<void> {
        await coll.deleteMany({ domainId });
    }

    /**
     * Atomically claim the report for a new run: succeeds when there is no
     * report, the last run finished, or a 'running' run went stale (the
     * process died mid-way). Returns false when a live run holds it.
     */
    static async claim(domainId: string, tid: ObjectId, seed: SimilarityReportDoc, staleMs: number): Promise<boolean> {
        const staleBefore = new Date(Date.now() - staleMs);
        const _id = reportId(domainId, tid);
        const { _id: _ignored, ...fields } = seed; // _id is immutable: match on it, never $set it
        const res = await coll.updateOne(
            {
                _id,
                $or: [
                    { status: { $ne: 'running' } },
                    { status: 'running', startedAt: { $lt: staleBefore } },
                ],
            },
            { $set: fields, $unset: { error: '', finishedAt: '', progress: '' } },
        );
        if (res.matchedCount) return true;
        // No document yet: create it, tolerating a concurrent creator.
        try {
            await coll.insertOne({ ...seed, _id });
            return true;
        } catch (e) {
            if (e?.code === 11000) return false;
            throw e;
        }
    }

    static async apply() {
        await db.ensureIndexes(coll, { key: { domainId: 1, tid: 1 }, name: 'domain_tid' });
    }
}

export default SimilarityModel;
