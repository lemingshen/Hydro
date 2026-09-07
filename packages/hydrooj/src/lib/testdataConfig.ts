import { load } from 'js-yaml';
import { normalizeSubtasks, ProblemConfigFile, readSubtasksFromFiles } from '@hydrooj/common';
import { readYamlCases } from '@hydrooj/common/cases';
import { parseMemoryMB, parseTimeMS } from '@hydrooj/utils';
import type { ProblemConfig } from '../interface';

export async function parseConfig(config: string | ProblemConfigFile = {}, files: string[]) {
    const cfg: ProblemConfigFile = typeof config === 'string'
        ? await readYamlCases(load(config || '{}') as Record<string, any>)
        : await readYamlCases(config);
    const result: ProblemConfig = {
        count: Object.keys(cfg.answers || {}).length || Math.sum((cfg.subtasks || []).map((s) => s.cases.length)),
        memoryMin: Number.MAX_SAFE_INTEGER,
        memoryMax: 0,
        timeMin: Number.MAX_SAFE_INTEGER,
        timeMax: 0,
        type: cfg.type || 'default',
        hackable: cfg.validator && cfg.checker && !['default', 'strict'].includes(cfg.checker_type),
    };
    if (cfg.subType) result.subType = cfg.subType;
    if (cfg.target) result.target = cfg.target;
    result.count ||= Math.sum(readSubtasksFromFiles(files, cfg).map((i) => i.cases.length));
    if (cfg.subtasks?.length) {
        for (const subtask of normalizeSubtasks(cfg.subtasks as any || [], (i) => i, cfg.time, cfg.memory)) {
            result.memoryMax = Math.max(result.memoryMax, ...subtask.cases.map((i) => parseMemoryMB(i.memory)));
            result.memoryMin = Math.min(result.memoryMin, ...subtask.cases.map((i) => parseMemoryMB(i.memory)));
            result.timeMax = Math.max(result.timeMax, ...subtask.cases.map((i) => parseTimeMS(i.time)));
            result.timeMin = Math.min(result.timeMin, ...subtask.cases.map((i) => parseTimeMS(i.time)));
        }
    } else {
        if (cfg.time) result.timeMax = result.timeMin = cfg.time as unknown as number;
        if (cfg.memory) result.memoryMax = result.memoryMin = cfg.memory as unknown as number;
    }
    if (result.memoryMax < result.memoryMin) result.memoryMax = result.memoryMin = 256;
    if (result.timeMax < result.timeMin) result.timeMax = result.timeMin = 1000;
    if (cfg.langs) result.langs = cfg.langs;
    if (cfg.redirect) result.redirect = cfg.redirect.split('/', 2) as any;
    if (cfg.filename && result.type === 'default') result.subType = cfg.filename;
    /*
     * PTA fork — function tasks. This function is a WHITELIST: any key not
     * copied here is dropped from pdoc.config, and the server-side wrap
     * (model/record.ts) reads the harness from pdoc.config. So these two
     * must be carried through explicitly, or a function task silently
     * judges the bare fragment and fails to compile.
     */
    const asStringMap = (v: any): Record<string, string> | null => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(v)) if (typeof val === 'string' && val.trim()) out[k] = val;
        return Object.keys(out).length ? out : null;
    };
    const template = asStringMap((cfg as any).template);
    const stub = asStringMap((cfg as any).stub);
    // The language list is NOT derived here: `langs` is intersected by exact
    // id, and harness keys are families (`cc`), which would drop `cc.cc11`.
    // ProblemDetailHandler filters by family instead (handler/problem.ts).
    if (template) result.template = template;
    if (stub) result.stub = stub;
    return result;
}
