import assert from 'assert';
import { STATUS } from '@hydrooj/common';
import { fs, yaml } from '@hydrooj/utils';
import { FormatError } from '../error';
import { Context } from './interface';

export async function judge({
    next, end, config, code,
}: Context) {
    next({ status: STATUS.STATUS_JUDGING, progress: 0 });
    const answer = ('src' in code)
        ? await fs.readFile(code.src, 'utf-8')
        : ('content' in code)
            ? code.content.toString().replace(/\r/g, '')
            : '';
    let answers: { [x: string]: string | string[] } = {};
    try {
        answers = yaml.load(answer) as any;
        assert(typeof answers === 'object');
    } catch (e) {
        end({
            status: STATUS.STATUS_WRONG_ANSWER,
            score: 0,
            message: 'Unable to parse answer.',
            time: 0,
            memory: 0,
        });
        return null;
    }
    let totalScore = 0;
    let totalStatus = 0;
    const subtasks = {};
    if (!Object.keys(config.answers).length) throw new FormatError('Invalid standard answer.');
    /*
     * PTA fork: task-level comparison flags for fill-in blanks, written by
     * the objective question builder as `matching: { ignoreCase, ignoreSpaces }`
     * in config.yaml. They relax the string comparison (single answer and the
     * `{ answer: score }` map form alike); choice letters are unaffected.
     */
    const matching = (config as any).matching || {};
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
    for (const key in config.answers) {
        const ansInfo = config.answers[key] as [string | string[], number] | Record<string, number>;
        // eslint-disable-next-line ts/no-loop-func
        const report = (status: STATUS, score: number, message: string) => {
            const [subtaskId, caseId] = key.split('-').map(Number);
            totalScore += score;
            totalStatus = Math.max(totalStatus, status);
            subtasks[subtaskId] ||= { score, status };
            if (subtasks[subtaskId].status && caseId) {
                subtasks[subtaskId].score += score;
                subtasks[subtaskId].status = Math.max(subtasks[subtaskId].status, status);
            }
            next({
                case: {
                    subtaskId,
                    id: caseId,
                    time: 0,
                    memory: 0,
                    status,
                    score,
                    message,
                },
            });
        };
        if (!answers[key]) {
            report(STATUS.STATUS_WRONG_ANSWER, 0, 'No answer');
            continue;
        }
        const usrAns = answers[key].toString().trim();
        if (ansInfo instanceof Array) {
            const fullScore = (+ansInfo[1]) || 0;
            const stdAns = ansInfo[0];
            if (stdAns instanceof Array) {
                const stdSet = new Set(stdAns);
                const ans = new Set(answers[key] instanceof Array ? answers[key] : [answers[key]]);
                if (stdAns.length === ans.size && stdSet.isSupersetOf(ans)) report(STATUS.STATUS_ACCEPTED, fullScore, 'Correct');
                else if (ans.size && stdSet.isSupersetOf(ans)) report(STATUS.STATUS_WRONG_ANSWER, Math.floor(fullScore / 2), 'Partially Correct');
                else report(STATUS.STATUS_WRONG_ANSWER, 0, 'Incorrect');
            } else if (norm(stdAns.toString()) === norm(usrAns)) report(STATUS.STATUS_ACCEPTED, fullScore, 'Correct');
            else report(STATUS.STATUS_WRONG_ANSWER, 0, 'Incorrect');
        } else {
            const hit = findMapKey(ansInfo, usrAns);
            if (hit === undefined || !ansInfo[hit]) report(STATUS.STATUS_WRONG_ANSWER, 0, 'Incorrect');
            else report(STATUS.STATUS_ACCEPTED, +ansInfo[hit] || 0, 'Correct');
        }
    }
    end({
        status: totalStatus, score: totalScore, time: 0, memory: 0, subtasks,
    });
    return null;
}
