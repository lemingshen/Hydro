/* eslint-disable max-len */
/**
 * PTA fork — SUBJECTIVE TASKS: submission type and grading RUBRIC.
 *
 * A subjective task (pid S…) is one of two kinds, chosen on the create/edit
 * page (pages/problem_type_select.page.js → `subjectiveConfig` →
 * handler/problem.ts applySubjectiveConfig → config.yaml):
 *
 *   report   the student hands in ONE PDF report. Once the homework ends,
 *            the AI grader (lib/subjective_grader.ts) reads the PDF, scores
 *            every criterion of the rubric below, and writes page-anchored
 *            comments back into an annotated copy of the PDF.
 *   project  a project packed in a zip (like a repository). Submitted the
 *            way subjective tasks always were; automatic grading of
 *            projects is not implemented yet.
 *
 * The rubric lives in config.yaml next to the objective answer keys and the
 * function-task harness (`rubric:`), so it travels with the problem and is
 * available on the task page as pdoc.config.rubric (lib/testdataConfig.ts
 * carries it through the whitelist). This module is the single place that
 * decides what a VALID rubric is: normalizeRubric() is used by the save
 * path, the task page and the grader alike.
 */
import { createHash } from 'crypto';
import type { RubricCriterion, RubricLevel, SubjectiveRubric, SubjectiveTaskType } from '@hydrooj/common/types';

export type { RubricCriterion, RubricLevel, SubjectiveRubric, SubjectiveTaskType };

export const SUBJECTIVE_TYPES: SubjectiveTaskType[] = ['report', 'project'];
export const RUBRIC_MAX_CRITERIA = 12;
export const RUBRIC_MAX_LEVELS = 6;
export const RUBRIC_MAX_TEXT = 1200;
export const RUBRIC_MAX_POINTS = 1000;

export interface SubjectiveConfig {
    type: SubjectiveTaskType;
    rubric: SubjectiveRubric | null;
}

const clip = (v: any, n: number) => String(v ?? '').replace(/\r/g, '').trim().slice(0, n);
const num = (v: any) => (Number.isFinite(+v) ? Math.round(+v * 100) / 100 : Number.NaN);

/**
 * Validate a rubric as the builder posts it (or as config.yaml holds it).
 * Returns null for "no rubric" (absent / empty criteria) and throws an
 * Error with a teacher-readable message for anything malformed, so the
 * save path can surface it as a ValidationError.
 */
export function normalizeRubric(raw: any): SubjectiveRubric | null {
    if (!raw || typeof raw !== 'object') return null;
    const list = Array.isArray(raw.criteria) ? raw.criteria : [];
    if (!list.length) return null;
    if (list.length > RUBRIC_MAX_CRITERIA) throw new Error(`A rubric can have at most ${RUBRIC_MAX_CRITERIA} criteria.`);
    const criteria: RubricCriterion[] = [];
    const ids = new Set<string>();
    list.forEach((c: any, i: number) => {
        if (!c || typeof c !== 'object') throw new Error(`Criterion ${i + 1} is malformed.`);
        let id = clip(c.id, 24).replace(/[^\w-]/g, '');
        if (!id || ids.has(id)) id = `c${i + 1}`;
        while (ids.has(id)) id += '_';
        ids.add(id);
        const title = clip(c.title, 120);
        if (!title) throw new Error(`Criterion ${i + 1} needs a title.`);
        const maxPoints = num(c.maxPoints);
        if (!(maxPoints > 0) || maxPoints > RUBRIC_MAX_POINTS) throw new Error(`Criterion "${title}" needs a positive maximum of points (at most ${RUBRIC_MAX_POINTS}).`);
        const out: RubricCriterion = { id, title, maxPoints };
        const description = clip(c.description, RUBRIC_MAX_TEXT);
        if (description) out.description = description;
        const levelsRaw = Array.isArray(c.levels) ? c.levels : [];
        if (levelsRaw.length) {
            if (levelsRaw.length > RUBRIC_MAX_LEVELS) throw new Error(`Criterion "${title}" has more than ${RUBRIC_MAX_LEVELS} levels.`);
            const levels: RubricLevel[] = levelsRaw.map((l: any, k: number) => {
                const points = num(l?.points);
                if (!(points >= 0) || points > maxPoints) throw new Error(`Level ${k + 1} of "${title}" must be worth between 0 and ${maxPoints} points.`);
                const label = clip(l?.label, 60) || `Level ${k + 1}`;
                const lv: RubricLevel = { points, label };
                const descriptor = clip(l?.descriptor, RUBRIC_MAX_TEXT);
                if (descriptor) lv.descriptor = descriptor;
                return lv;
            }).sort((a: RubricLevel, b: RubricLevel) => b.points - a.points);
            out.levels = levels;
        }
        criteria.push(out);
    });
    const total = Math.round(criteria.reduce((a, c) => a + c.maxPoints, 0) * 100) / 100;
    const rubric: SubjectiveRubric = { version: 1, total, criteria };
    const graderNotes = clip(raw.graderNotes, 4000);
    if (graderNotes) rubric.graderNotes = graderNotes;
    const maxPages = Math.floor(+raw.maxPages);
    if (Number.isFinite(maxPages) && maxPages > 0) rubric.maxPages = Math.min(maxPages, 500);
    return rubric;
}

/** The template the builder opens with for a new report task. */
export function starterRubric(): SubjectiveRubric {
    const levels = (max: number, texts: [string, string, string, string]): RubricLevel[] => [
        { points: max, label: 'Excellent', descriptor: texts[0] },
        { points: Math.round(max * 0.7 * 100) / 100, label: 'Good', descriptor: texts[1] },
        { points: Math.round(max * 0.4 * 100) / 100, label: 'Partial', descriptor: texts[2] },
        { points: 0, label: 'Missing', descriptor: texts[3] },
    ];
    return {
        version: 1,
        total: 100,
        criteria: [
            {
                id: 'c1',
                title: 'Problem understanding',
                description: 'The report states the problem, its scope and its constraints precisely, and explains why it matters.',
                maxPoints: 20,
                levels: levels(20, [
                    'Problem, scope and constraints are stated precisely and motivated.',
                    'Problem is stated clearly; scope or motivation is thin.',
                    'Problem is only vaguely described.',
                    'The problem is not identified.',
                ]),
            },
            {
                id: 'c2',
                title: 'Method and correctness',
                description: 'The approach is appropriate, described in enough detail to reproduce, and technically correct.',
                maxPoints: 30,
                levels: levels(30, [
                    'Appropriate, correct and reproducible method with justified design choices.',
                    'Sound method with minor gaps in detail or justification.',
                    'Method is described but has notable errors or omissions.',
                    'No usable description of the method.',
                ]),
            },
            {
                id: 'c3',
                title: 'Results and analysis',
                description: 'Results are presented clearly (tables/figures), interpreted honestly, and limitations are discussed.',
                maxPoints: 30,
                levels: levels(30, [
                    'Clear results, insightful analysis, limitations discussed.',
                    'Results are clear; analysis is descriptive rather than insightful.',
                    'Results are incomplete or the analysis is superficial.',
                    'No results or no analysis.',
                ]),
            },
            {
                id: 'c4',
                title: 'Presentation',
                description: 'Structure, clarity of writing, figures and references; length within the limit.',
                maxPoints: 20,
                levels: levels(20, [
                    'Well structured, clearly written, professional figures and references.',
                    'Readable with minor structural or formatting issues.',
                    'Hard to follow; figures or references are inadequate.',
                    'Disorganized and unclear.',
                ]),
            },
        ],
        graderNotes: '',
    };
}

/** Canonical hash of a rubric: a grade is stale when the task's rubric hash differs. */
export function rubricHash(rubric: SubjectiveRubric | null | undefined): string {
    if (!rubric) return '';
    const canon = JSON.stringify({
        total: rubric.total,
        criteria: rubric.criteria.map((c) => ({
            id: c.id, title: c.title, description: c.description || '', maxPoints: c.maxPoints,
            levels: (c.levels || []).map((l) => ({ points: l.points, label: l.label, descriptor: l.descriptor || '' })),
        })),
        graderNotes: rubric.graderNotes || '',
        maxPages: rubric.maxPages || 0,
    });
    return createHash('sha1').update(canon).digest('hex').slice(0, 16);
}

/** Type + validated rubric from a raw config.yaml object (readRawProblemConfig) or a parsed pdoc.config. */
export function subjectiveConfigOf(cfg: any): SubjectiveConfig {
    const typeRaw = String(cfg?.subjective?.type || '');
    const type: SubjectiveTaskType = SUBJECTIVE_TYPES.includes(typeRaw as SubjectiveTaskType) ? typeRaw as SubjectiveTaskType : 'project';
    let rubric: SubjectiveRubric | null = null;
    try {
        rubric = normalizeRubric(cfg?.rubric);
    } catch (e) {
        rubric = null; // a hand-edited config.yaml with a broken rubric: the task simply has none
    }
    return { type, rubric };
}

/** Points earned → the 0..100 task score the homework scoreboard works in. */
export function rubricScore100(rubric: SubjectiveRubric, points: number): number {
    if (!(rubric.total > 0)) return 0;
    return Math.max(0, Math.min(100, Math.round((points / rubric.total) * 10000) / 100));
}

/** The rubric as the grader reads it — numbered criteria with their levels. */
export function rubricToPromptText(rubric: SubjectiveRubric): string {
    const lines: string[] = [`TOTAL: ${rubric.total} points across ${rubric.criteria.length} criteria.`];
    rubric.criteria.forEach((c, i) => {
        lines.push(`\n${i + 1}. [${c.id}] ${c.title} — max ${c.maxPoints} points`);
        if (c.description) lines.push(`   What is assessed: ${c.description}`);
        if (c.levels?.length) {
            lines.push('   Levels (pick the one that fits best; intermediate points are allowed only between adjacent levels):');
            for (const l of c.levels) lines.push(`     - ${l.points} pts "${l.label}"${l.descriptor ? `: ${l.descriptor}` : ''}`);
        } else {
            lines.push(`   Score continuously from 0 to ${c.maxPoints}.`);
        }
    });
    if (rubric.graderNotes) lines.push(`\nTEACHER'S NOTES FOR THE GRADER:\n${rubric.graderNotes}`);
    return lines.join('\n');
}
