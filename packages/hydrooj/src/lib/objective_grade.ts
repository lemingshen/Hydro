import { STATUS } from '@hydrooj/common';
import { load as yamlLoad } from 'js-yaml';

/**
 * PTA fork — in-process grading of an objective answer.
 *
 * A port of hydrojudge/src/judge/objective.ts (single answer, multi-select
 * letters, the `{ answer: score }` map form and the task-level `matching`
 * flags), used by the END-OF-CONTAINER EVALUATION (handler/contest.ts
 * evaluateContainerResults): when a Test / Homework ends, every objective
 * answer in it is (re)graded here against the task's answer key, so the
 * scoreboard never depends on a judge callback that may not have arrived.
 * The two graders must stay in sync.
 */
export interface ObjectiveGrade {
    status: STATUS;
    score: number;
    subtasks: Record<number, { status: STATUS, score: number }>;
    message?: string;
}

export function gradeObjectiveAnswer(config: any, answer: string): ObjectiveGrade {
    let answers: Record<string, any> = {};
    try {
        answers = yamlLoad(String(answer || '').replace(/\r/g, '')) as any;
        if (!answers || typeof answers !== 'object') throw new Error('not an object');
    } catch {
        return { status: STATUS.STATUS_WRONG_ANSWER, score: 0, subtasks: {}, message: 'Unable to parse answer.' };
    }
    const key = config?.answers && typeof config.answers === 'object' ? config.answers : {};
    if (!Object.keys(key).length) return { status: STATUS.STATUS_SYSTEM_ERROR, score: 0, subtasks: {}, message: 'Invalid standard answer.' };
    const matching = config.matching || {};
    const norm = (s: any) => {
        let t = String(s ?? '').trim();
        if (matching.ignoreCase) t = t.toLowerCase();
        if (matching.ignoreSpaces) t = t.replace(/\s+/g, '');
        return t;
    };
    const findMapKey = (map: Record<string, number>, ans: string) => {
        if (map[ans] !== undefined) return ans;
        const target = norm(ans);
        return Object.keys(map).find((k) => norm(k) === target);
    };
    let totalScore = 0;
    let totalStatus: STATUS = 0;
    const subtasks: Record<number, { status: STATUS, score: number }> = {};
    for (const id of Object.keys(key)) {
        const ansInfo = key[id] as [string | string[], number] | Record<string, number>;
        let status: STATUS = STATUS.STATUS_WRONG_ANSWER;
        let score = 0;
        const given = answers[id];
        if (given !== undefined && given !== null && given !== '') {
            const usrAns = given.toString().trim();
            if (Array.isArray(ansInfo)) {
                const fullScore = (+ansInfo[1]) || 0;
                const stdAns = ansInfo[0];
                if (Array.isArray(stdAns)) {
                    const stdSet = new Set(stdAns.map((x) => String(x)));
                    const ans = new Set((Array.isArray(given) ? given : [given]).map((x) => String(x)));
                    const subset = [...ans].every((x) => stdSet.has(x));
                    if (stdAns.length === ans.size && subset) [status, score] = [STATUS.STATUS_ACCEPTED, fullScore];
                    else if (ans.size && subset) [status, score] = [STATUS.STATUS_WRONG_ANSWER, Math.floor(fullScore / 2)];
                } else if (norm(String(stdAns)) === norm(usrAns)) [status, score] = [STATUS.STATUS_ACCEPTED, fullScore];
            } else if (ansInfo && typeof ansInfo === 'object') {
                const hit = findMapKey(ansInfo, usrAns);
                if (hit !== undefined && ansInfo[hit]) [status, score] = [STATUS.STATUS_ACCEPTED, +ansInfo[hit] || 0];
            }
        }
        const [subtaskId, caseId] = id.split('-').map(Number);
        totalScore += score;
        totalStatus = Math.max(totalStatus, status) as STATUS;
        subtasks[subtaskId] ||= { score, status };
        if (subtasks[subtaskId].status && caseId) {
            subtasks[subtaskId].score += score;
            subtasks[subtaskId].status = Math.max(subtasks[subtaskId].status, status) as STATUS;
        }
    }
    return { status: totalStatus, score: totalScore, subtasks };
}
