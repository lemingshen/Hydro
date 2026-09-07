import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { createReadStream } from 'fs';
import { PassThrough, Readable, Writable } from 'stream';
import { Entry, ZipReader } from '@zip.js/zip.js';
import { readFile } from 'fs-extra';
import {
    escapeRegExp, flattenDeep, intersection, pick,
} from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import { nanoid } from 'nanoid';
import sanitize from 'sanitize-filename';
import Schema from 'schemastery';
import parser from '@hydrooj/utils/lib/search';
import { randomstring, sortFiles, streamToBuffer } from '@hydrooj/utils/lib/utils';
import type { Context } from '../context';
import {
    BadRequestError, ContestNotAttendedError, ContestNotEndedError, ContestNotFoundError, ContestNotLiveError,
    FileLimitExceededError, FileTooLargeError, HackFailedError, NoProblemError, NotFoundError,
    PermissionError, ProblemAlreadyExistError, ProblemAlreadyUsedByContestError, ProblemConfigError,
    ProblemIsReferencedError, ProblemNotAllowCopyError, ProblemNotAllowLanguageError, ProblemNotAllowPretestError,
    ProblemNotFoundError, RecordNotFoundError, SolutionNotFoundError, ValidationError,
} from '../error';
import {
    ProblemDoc, ProblemSearchOptions, ProblemStatusDoc, RecordDoc, User,
} from '../interface';
import { objectiveSubKindOf } from '../lib/objective_markdown';
import { readRawProblemConfig } from '../lib/problem_config';
import { isObjectivePid, objectiveTitleOf } from '../lib/objective_title';
import { activityOwners, activityPids, applyActivityPidsCache, entitledToActivityTask } from '../lib/activity_pids';
import { PERM, PRIV, STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import domain from '../model/domain';
import * as oplog from '../model/oplog';
import KnowledgeModel from '../model/knowledge';
import problem from '../model/problem';
import record, { harnessFor } from '../model/record';
import * as setting from '../model/setting';
import solution from '../model/solution';
import storage from '../model/storage';
import system from '../model/system';
import user from '../model/user';
import {
    Handler, param, post, Query, query, route, Types,
} from '../service/server';
import { ContestDetailBaseHandler } from './contest';

export const parseCategory = (value: string) => value.replace(/，/g, ',').split(',').map((e) => e.trim());

/**
 * PTA fork — a task that belongs to a homework / test / self-learning
 * session is that activity's material: students never see it in the
 * problem set, and cannot open or submit to it there. Staff (problem
 * authors and editors, teachers who assemble the activities, domain roots)
 * keep the full view, and the task stays fully reachable INSIDE its
 * activity for everyone entitled to it.
 */
export function seesEveryProblem(handler: { user: User }): boolean {
    const u = handler.user;
    return u.role === 'root'
        || u.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
        || u.hasPerm(PERM.PERM_EDIT_PROBLEM)
        || u.hasPerm(PERM.PERM_CREATE_PROBLEM)
        || u.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || u.hasPerm(PERM.PERM_CREATE_HOMEWORK);
}

/** The pids a STUDENT must not meet in the problem set (empty for staff). */
export async function hiddenActivityPids(handler: { user: User }, domainId: string): Promise<number[]> {
    if (seesEveryProblem(handler)) return [];
    return [...await activityPids(domainId)];
}

function buildQuery(udoc: User) {
    const q: Filter<ProblemDoc> = {};
    if (!udoc.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) {
        q.$or = [
            { hidden: false },
            { owner: udoc._id },
            { maintainer: udoc._id },
        ];
    }
    return q;
}

const defaultSearch = async (domainId: string, q: string, options?: ProblemSearchOptions) => {
    const escaped = escapeRegExp(q.toLowerCase());
    const projection: (keyof ProblemDoc)[] = ['domainId', 'docId', 'pid'];
    const $regex = new RegExp(q.length >= 2 ? escaped : `\\A${escaped}`, 'gim');
    const filter = { $or: [{ pid: { $regex } }, { title: { $regex } }, { tag: q }] };
    const pdocs = await problem.getMulti(domainId, filter, projection)
        .skip(options.skip || 0).limit(options.limit || system.get('pagination.problem')).toArray();
    if (!options.skip) {
        let pdoc = await problem.get(domainId, Number.isSafeInteger(+q) ? +q : q, projection);
        if (pdoc) pdocs.unshift(pdoc);
        else if (/^P\d+$/.test(q)) {
            pdoc = await problem.get(domainId, +q.substring(1), projection);
            if (pdoc) pdocs.unshift(pdoc);
        }
    }
    return {
        hits: Array.from(new Set(pdocs.map((i) => `${i.domainId}/${i.docId}`))),
        total: Math.max(pdocs.length, await problem.count(domainId, filter)),
        countRelation: 'eq',
    };
};

export interface QueryContext {
    query: Filter<ProblemDoc>;
    sort: string[];
    pcountRelation: string;
    parsed: ReturnType<typeof parser.parse>;
    category: string[];
    text: string;
    total: number;
    fail: boolean;
    hint: string;
}

/**
 * PTA UI: the problem set is presented as three tabs. Classification
 * mirrors resolveKinds() in handler/self_learning.ts — the display pid's
 * first letter is authoritative (P=programming, O=objective, S=subjective),
 * with the problem config as the fallback for legacy problems. `config` is
 * stored in the database as the raw config.yaml STRING (it is only parsed
 * into an object at read time), hence the regex matching here.
 */
const KIND_OBJECTIVE_RE = /^\s*type:\s*['"]?objective/im;
/**
 * Four kinds now. F = FUNCTION TASK (PTA 函数题): the student submits one
 * function and the server splices it into the teacher's judge program
 * (model/record.ts wrapFunctionCode). Its letter is authoritative like the
 * other three; it never falls out of the legacy config fallback, because a
 * function task cannot exist without a pid — the harness is keyed by it.
 */
export const PROBLEM_KIND_FILTERS: Record<string, any> = {
    subjective: { pid: /^s/i },
    function: { pid: /^f/i },
    objective: {
        $or: [
            { pid: /^o/i },
            { pid: { $not: /^[spf]/i }, config: KIND_OBJECTIVE_RE },
        ],
    },
    programming: {
        $and: [
            { pid: { $not: /^[sof]/i } },
            { $or: [{ pid: /^p/i }, { config: { $not: KIND_OBJECTIVE_RE } }] },
        ],
    },
};

/*
 * `code` is not a fifth kind but a PICKER FILTER: programming ∪ function,
 * for the surfaces that accept anything solved in the scratchpad (the
 * self-learning session editor). The tabs never use it.
 */
PROBLEM_KIND_FILTERS.code = { $or: [PROBLEM_KIND_FILTERS.programming, PROBLEM_KIND_FILTERS.function] };

export type ProblemKind = 'programming' | 'function' | 'objective' | 'subjective';
export const PROBLEM_KINDS: ProblemKind[] = ['programming', 'function', 'objective', 'subjective'];

/**
 * Kinds that are SOLVED BY CODE — everything that enters the scratchpad,
 * is judged by compiling, and is graded by the programming rubric. Function
 * tasks are programming tasks with a narrower answer, so every place that
 * used to ask "is this programming?" now asks this instead.
 */
export const CODE_KINDS = new Set<ProblemKind>(['programming', 'function']);
export const isCodeKind = (k: string) => CODE_KINDS.has(k as ProblemKind);

/**
 * Single-document twin of PROBLEM_KIND_FILTERS above: same precedence (pid
 * letter first, config only as the legacy fallback) applied in JS instead of
 * as a mongo query. Used by the `quick` picker payload and by the statement
 * preview so the kind badge a teacher sees always agrees with the tab the
 * problem is listed under.
 */
export function problemKindOf(pdoc: Pick<ProblemDoc, 'pid' | 'config'>): ProblemKind {
    const pid = String(pdoc.pid || '');
    if (/^s/i.test(pid)) return 'subjective';
    if (/^o/i.test(pid)) return 'objective';
    if (/^f/i.test(pid)) return 'function';
    if (/^p/i.test(pid)) return 'programming';
    return typeof pdoc.config === 'string' && KIND_OBJECTIVE_RE.test(pdoc.config) ? 'objective' : 'programming';
}

/**
 * Fields the autocomplete picker (`quick=true`) needs. Upstream projected
 * title/pid/docId only, which left the dropdown showing two nearly identical
 * lines per row — unreadable once a course has a few hundred tasks. The
 * extra fields drive the kind badge, the difficulty chip and the AC ratio.
 *
 * `config` is fetched ONLY to classify the problem and is stripped again
 * before the response is written, so the judge configuration never reaches
 * the picker.
 */
const QUICK_PROJECTION: (keyof ProblemDoc)[] = ['title', 'pid', 'domainId', 'docId', 'tag', 'difficulty', 'nSubmit', 'nAccept', 'config'];

/** Statements are stored either as markdown or as JSON of { lang: markdown }. */
function resolveStatement(content: any, preferLang?: string): string {
    let c: any = content || '';
    if (typeof c === 'string' && c.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(c);
            if (parsed && typeof parsed === 'object') c = parsed;
        } catch (e) { /* a statement that merely starts with a brace */ }
    }
    if (c && typeof c === 'object') {
        c = c[preferLang] || c[String(preferLang || '').split('_')[0]] || c.zh || c.en || Object.values(c)[0] || '';
    }
    return String(c || '');
}

/**
 * PTA UI: the problem set lists AT MOST this many problems per page — the
 * table then fits one screen beside the knowledge panel and the pager does
 * the navigating (the same 10-row rhythm as the rest of the course pages).
 * The `pagination.problem` system setting keeps two jobs: it stays the
 * ceiling for the autocomplete picker (`quick=true`, which sends its own
 * `limit`), and a smaller admin value is still honoured for the page itself.
 */
export const PROBLEM_LIST_PAGE_SIZE = 10;

export class ProblemMainHandler extends Handler {
    queryContext: QueryContext = {
        query: {},
        sort: [],
        pcountRelation: 'eq',
        parsed: null,
        category: [],
        text: '',
        total: 0,
        fail: false,
        hint: 'sort',
    };

    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('limit', Types.PositiveInt, true)
    @param('pjax', Types.Boolean)
    @param('quick', Types.Boolean)
    @param('sort', Types.Range(['default', 'recent']), true)
    @param('kind', Types.Range(['programming', 'function', 'objective', 'subjective', 'code']), true)
    @param('tags', Types.Content, true)
    @param('difficultyMin', Types.UnsignedInt, true)
    @param('difficultyMax', Types.UnsignedInt, true)
    @param('sub', Types.Range(['tf', 'choice', 'blank']), true)
    async get(
        domainId: string, page = 1, q = '', limit: number, pjax = false, quick = false, sortStrategy = 'default',
        kind?: string, tags = '', difficultyMin = 0, difficultyMax = 0, sub?: string,
    ) {
        this.response.template = 'problem_main.html';
        const maxLimit = +this.ctx.setting.get('pagination.problem') || PROBLEM_LIST_PAGE_SIZE;
        if (quick) {
            // Picker rows: upstream behaviour, bounded by the system setting.
            if (!limit || limit > maxLimit || page > 1) limit = maxLimit;
        } else {
            // The page (HTML and its pjax fragments): a fixed, short page.
            limit = Math.min(PROBLEM_LIST_PAGE_SIZE, maxLimit);
        }
        this.queryContext.query = buildQuery(this.user);
        /*
         * PTA fork: tasks owned by a homework / test / session are not
         * problem-set material — students never see them here (staff do).
         * This runs BEFORE the tag / difficulty filters and the per-tab
         * counts, so every number on the page agrees with the list.
         */
        const hiddenPids = await hiddenActivityPids(this, domainId);
        if (hiddenPids.length) this.queryContext.query.docId = { $nin: hiddenPids };
        if (sortStrategy === 'recent') this.queryContext.hint = 'basic';
        // eslint-disable-next-line ts/no-shadow
        const query = this.queryContext.query;
        const psdict = {};
        const search = Object.values(global.Hydro.module.problemSearch)[0] || defaultSearch;
        const parsed = parser.parse(q, {
            keywords: ['category', 'difficulty', 'namespace'],
            offsets: false,
            alwaysArray: true,
            tokenize: true,
        });
        const category = parsed.category || [];
        const text = (parsed.text || []).join(' ');
        if (parsed.difficulty?.every((i) => Number.isSafeInteger(+i))) {
            query.difficulty = { $in: parsed.difficulty.flatMap((i) => +i === 0 ? [0, undefined] : [+i]) };
        }
        if (category.length) query.$and = category.map((tag) => ({ tag }));
        if (parsed.namespace?.length) {
            const mappedPrefix = this.domain.namespaces?.[parsed.namespace[0]];
            query.$and ||= [];
            if (mappedPrefix) query.$and.push({ sort: new RegExp(`^${mappedPrefix}-`) });
            else query.$and.push({ tag: parsed.namespace[0] });
        }
        if (text) category.push(text);
        if (category.length) this.UiContext.extraTitleContent = category.join(',');
        let total = 0;
        if (text) {
            const result = await search(domainId, q, { skip: (page - 1) * limit, limit });
            total = result.total;
            this.queryContext.pcountRelation = result.countRelation;
            if (!result.hits.length) this.queryContext.fail = true;
            const hitIds = result.hits.map((t) => +t.split('/')[1]);
            // Keep the activity exclusion when a text search narrows the set.
            query.docId = hiddenPids.length
                ? { $in: hitIds.filter((id) => !hiddenPids.includes(id)) }
                : { $in: hitIds };
            this.queryContext.hint = 'basic';
            this.queryContext.sort = result.hits;
        }
        /*
         * PTA UI: explicit picker filters (Test / Homework / Self-Learning
         * problem selector). These are deliberately SEPARATE params rather
         * than `category:`/`difficulty:` tokens folded into `q` — a tag may
         * contain a space, a comma or a colon, and round-tripping such a tag
         * through the search-string grammar silently mangles it. They append
         * to $and, so they compose with the tag/difficulty/namespace tokens a
         * teacher may also have typed, and are in place BEFORE the per-tab counts below snapshot $and, so the
         * tab badges keep agreeing with the list they label.
         */
        const tagList = [...new Set(parseCategory(tags).filter((i) => i))].slice(0, 16);
        // AND semantics: each added tag narrows the result, which is what a
        // teacher assembling a topic-specific activity expects. 🌳 A tag
        // that is a TOPIC in the catalog matches every point beneath it
        // (tasks carry their most specific points), so filtering by
        // "Loops" finds a task tagged "For loop reading n values".
        if (tagList.length) {
            const expanded = await KnowledgeModel.expandTags(domainId, tagList);
            query.$and = [...(query.$and || []), ...tagList.map((tag) => {
                const names = expanded.get(tag) || [tag];
                return names.length > 1 ? { tag: { $in: names } } : { tag: names[0] };
            })];
        }
        // Difficulty is 1..10; 0 means "unset" on the problem AND "no bound"
        // as a filter parameter, so an unrated problem is only excluded once
        // a real lower bound is asked for.
        const dMin = Math.min(Math.max(difficultyMin, 0), 10);
        const dMax = Math.min(Math.max(difficultyMax, 0), 10);
        if (dMin || dMax) {
            const range: any = {};
            if (dMin) range.$gte = dMin;
            if (dMax) range.$lte = dMax;
            query.$and = [...(query.$and || []), { difficulty: range }];
        }
        // PTA UI tabs: the plain HTML view always lands on one of the three
        // tabs (Programming by default). pjax refreshes carry the active tab
        // in their query string themselves; quick (autocomplete) and other
        // programmatic callers stay unfiltered unless they ask for a kind.
        if (!kind && !pjax && !quick) kind = 'programming';
        const kindFilter = kind ? PROBLEM_KIND_FILTERS[kind] : null;
        let kindCounts: Record<string, number> | null = null;
        if (kindFilter && !quick && !pjax && !this.queryContext.fail && !text) {
            // Per-tab totals from the SAME base query (visibility, category,
            // difficulty, namespace) so the badges always agree with the
            // list. Text search narrows to a paginated hit window, so counts
            // are hidden there instead of shown wrong.
            const baseAnd = query.$and ? [...query.$and] : [];
            const countOf = (f: any) => problem.count(domainId, { ...query, $and: [...baseAnd, f] });
            const [pc, fc, oc, sc] = await Promise.all([
                countOf(PROBLEM_KIND_FILTERS.programming),
                countOf(PROBLEM_KIND_FILTERS.function),
                countOf(PROBLEM_KIND_FILTERS.objective),
                countOf(PROBLEM_KIND_FILTERS.subjective),
            ]);
            kindCounts = {
                programming: pc, function: fc, objective: oc, subjective: sc,
            };
        }
        if (kindFilter) query.$and = [...(query.$and || []), kindFilter];
        const sort = this.queryContext.sort;
        await this.ctx.parallel('problem/list', query, this, sort);
        const sortKey = ({
            default: { sort: 1, docId: 1 },
            recent: { docId: -1 },
        } as const)[sortStrategy];
        let [pdocs, ppcount, pcount] = this.queryContext.fail
            ? [[], 0, 0]
            : await this.paginate(
                problem.getMulti(domainId, query, quick ? (sub ? [...QUICK_PROJECTION, 'content'] : QUICK_PROJECTION) : undefined)
                    .sort(sortKey).hint(this.queryContext.hint),
                sort.length ? 1 : page, limit,
            );
        if (total) {
            pcount = total;
            ppcount = Math.ceil(total / limit);
        }
        if (sort.length) pdocs = pdocs.sort((a, b) => sort.indexOf(`${a.domainId}/${a.docId}`) - sort.indexOf(`${b.domainId}/${b.docId}`));
        if (text && pcount > pdocs.length) pcount = pdocs.length;
        // See QUICK_PROJECTION: resolve the kind badge here, then drop the raw
        // config so it never leaves the server for a mere picker row.
        if (quick) {
            for (const pdoc of pdocs) {
                (pdoc as any).kind = problemKindOf(pdoc);
                delete (pdoc as any).config;
            }
            // Test editor sections: keep only the objective question type asked
            // for (true/false, choice, fill-in). Content was fetched for the
            // classification alone and never leaves the server.
            if (sub) {
                pdocs = pdocs.filter((pdoc) => (pdoc as any).kind === 'objective' && objectiveSubKindOf(pdoc.content) === sub);
                for (const pdoc of pdocs) delete (pdoc as any).content;
            }
        }
        if (this.user.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            Object.assign(psdict, await problem.getListStatus(
                domainId, this.user._id,
                pdocs.map((i) => i.docId),
            ));
        }
        /*
         * PTA fork: a task picked into a homework / test / session is
         * invisible to students (hiddenActivityPids above). On the STAFF
         * list every such row says so — which activity holds it — so a
         * teacher can see at a glance what the problem set no longer
         * offers, exactly like the built-in (Hidden) flag.
         */
        const inActivity: Record<number, any[]> = {};
        if (seesEveryProblem(this) && pdocs.length) {
            const owners = await activityOwners(domainId);
            for (const pdoc of pdocs) {
                const list = owners.get(pdoc.docId);
                if (list?.length) inActivity[pdoc.docId] = list;
            }
        }
        if (pjax) {
            this.response.body = {
                title: this.renderTitle(this.translate('problem_main')),
                fragments: (await Promise.all([
                    this.renderHTML('partials/problem_list.html', {
                        page, ppcount, pcount, pdocs, psdict, qs: q, sort: sortStrategy, kind, inActivity,
                        pageSize: limit, pcountRelation: this.queryContext.pcountRelation,
                    }),
                    this.renderHTML('partials/problem_stat.html', { pcount, pcountRelation: this.queryContext.pcountRelation }),
                    this.renderHTML('partials/problem_lucky.html', { qs: q }),
                ])).map((i) => ({ html: i })),
            };
        } else {
            this.response.body = {
                page,
                pcount,
                ppcount,
                inActivity,
                pageSize: limit,
                pcountRelation: this.queryContext.pcountRelation,
                pdocs,
                psdict,
                qs: q,
                sort: sortStrategy,
                kind,
                kindCounts,
                // The tags= filter as typed, so the search form and the panel
                // links can carry it along; the panel marks these as active.
                tags: tagList.join(','),
                activeTags: tagList,
                knowledgePanel: await this.buildKnowledgePanel(domainId, { q, sort: sortStrategy, kind, tagList }),
            };
        }
    }

    /**
     * PTA UI: the sidebar's "Knowledge points" panel — the domain's whole
     * catalog (see model/knowledge.ts) instead of Hydro's site-wide
     * category setting. Entries are grouped by their catalog category when
     * they have one; usage counts only include the tasks THIS viewer may
     * see, on the CURRENT tab (a quiz's knowledge points count on the
     * Objective tab). Each chip is a plain link on the tags= filter, which
     * is comma-separated and therefore safe for multi-word names — the
     * category: search grammar is not.
     */
    async buildKnowledgePanel(domainId: string, cur: { q: string, sort: string, kind?: string, tagList: string[] }) {
        // Toggle links: clicking a chip adds it to (or removes it from) the
        // tags= filter while keeping the text search, sort and tab.
        const href = (tags: string[]) => this.url('problem_main', {
            query: {
                ...(cur.kind ? { kind: cur.kind } : {}),
                ...(cur.q ? { q: cur.q } : {}),
                ...(cur.sort && cur.sort !== 'default' ? { sort: cur.sort } : {}),
                ...(tags.length ? { tags: tags.join(',') } : {}),
            },
        });
        const activeLower = new Set(cur.tagList.map((t) => t.toLowerCase()));
        const toggleHref = (name: string) => {
            const active = activeLower.has(name.toLowerCase());
            return href(active ? cur.tagList.filter((t) => t.toLowerCase() !== name.toLowerCase()) : [...cur.tagList, name]);
        };
        try {
            const kindFilter = cur.kind ? PROBLEM_KIND_FILTERS[cur.kind] : null;
            const match = kindFilter ? { $and: [buildQuery(this.user), kindFilter] } : buildQuery(this.user);
            const usage = await KnowledgeModel.tagUsage(domainId, match);
            const tree = await KnowledgeModel.tree(domainId, usage, match);
            /*
             * 🌳 The tree flattened into SECTIONS the partial can draw in
             * order: a topic becomes a header (indented by depth, carrying
             * the distinct roll-up and a filter link for the whole
             * subtree), followed by its childless points as chips, then
             * its sub-topics. Top-level childless points come first with
             * no header when nothing is grouped, under "Other" otherwise.
             */
            const sections: any[] = [];
            let total = 0;
            let unused = 0;
            const chipOf = (n: any) => {
                total += 1;
                if (!n.count) unused += 1;
                return { name: n.name, count: n.count, active: activeLower.has(n.name.toLowerCase()), href: toggleHref(n.name), path: n.path };
            };
            const walk = (node: any, parents: string[]) => {
                const leaves = node.children.filter((c: any) => !c.children.length);
                const topics = node.children.filter((c: any) => c.children.length);
                sections.push({
                    id: node.id,
                    parents,
                    header: {
                        name: node.name, depth: node.depth, rollup: node.rollup, count: node.count, size: node.children.length,
                        active: activeLower.has(node.name.toLowerCase()), href: toggleHref(node.name),
                    },
                    points: leaves.map(chipOf),
                });
                for (const t of topics) walk(t, [...parents, node.id]);
            };
            const looseTop = tree.filter((n) => !n.children.length);
            const topTopics = tree.filter((n) => n.children.length);
            if (looseTop.length) {
                sections.push({ id: '', parents: [], header: topTopics.length ? { name: 'Other', depth: 0, rollup: 0, count: 0, size: looseTop.length, active: false, href: '' } : null, points: looseTop.map(chipOf) });
            }
            for (const t of topTopics) walk(t, []);
            // "Other" last, as before.
            if (looseTop.length && topTopics.length) sections.push(sections.shift());
            return {
                mode: 'filter',
                total,
                unused,
                sections,
                clearHref: href([]),
                canManage: this.user.hasPerm(PERM.PERM_CREATE_PROBLEM),
            };
        } catch (e) {
            return { mode: 'filter', total: 0, unused: 0, sections: [], clearHref: href([]), canManage: this.user.hasPerm(PERM.PERM_CREATE_PROBLEM) };
        }
    }

    @param('pids', Types.NumericArray)
    @param('target', Types.String)
    @param('hidden', Types.Boolean)
    @param('redirect', Types.Boolean)
    async postCopy(domainId: string, pids: number[], target: string, hidden?: boolean, redirect = false) {
        let t = `,${this.domain.share || ''},`;
        if (t !== ',*,' && !t.includes(`,${target},`)) throw new ProblemNotAllowCopyError(this.domain._id, target);
        const ddoc = await domain.get(target);
        if (!ddoc) throw new NotFoundError(target);
        const dudoc = await user.getById(target, this.user._id);
        if (!dudoc.hasPerm(PERM.PERM_CREATE_PROBLEM)) throw new PermissionError(PERM.PERM_CREATE_PROBLEM);
        if (!pids.length) throw new ValidationError('pids');
        // Check if user can access all those problems
        const pdict = await problem.getList(
            domainId, pids, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id,
            true, ['domainId', 'docId', 'reference'], true,
        );
        const ids = [];
        for (const pid of pids) {
            let pdoc = pdict[pid];
            if (pdoc.reference) {
                // eslint-disable-next-line no-await-in-loop
                const [sourcePdoc, sourceDdoc] = await Promise.all([
                    problem.get(pdoc.reference.domainId, pdoc.reference.pid),
                    domain.get(pdoc.reference.domainId),
                ]);
                if (!sourcePdoc) throw new ProblemNotFoundError(pdoc.reference.domainId, pdoc.reference.pid);
                else pdoc = sourcePdoc;
                t = `,${sourceDdoc.share || ''},`;
                if (t !== ',*,' && !t.includes(`,${target},`)) throw new ProblemNotAllowCopyError(sourceDdoc._id, target);
            }
            // eslint-disable-next-line no-await-in-loop
            ids.push(await problem.copy(pdoc.domainId, pdoc.docId, target, undefined, hidden));
        }
        if (redirect) this.response.redirect = this.url('problem_detail', { domainId: target, pid: ids[0] });
        else this.response.body = ids;
    }

    @param('pids', Types.NumericArray)
    async postDelete(domainId: string, pids: number[]) {
        let i = 0;
        for (const pid of pids) {
            // eslint-disable-next-line no-await-in-loop
            const pdoc = await problem.get(domainId, pid);
            if (!pdoc) continue;
            if (!this.user.own(pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
            // eslint-disable-next-line no-await-in-loop
            await problem.del(domainId, pid);
            i++;
            this.progress('Deleting: ({0}/{1})', [i, pids.length]);
        }
        this.back();
    }

    @param('pids', Types.NumericArray)
    async postHide(domainId: string, pids: number[]) {
        for (const pid of pids) {
            // eslint-disable-next-line no-await-in-loop
            const pdoc = await problem.get(domainId, pid);
            if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
            if (!this.user.own(pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
            // eslint-disable-next-line no-await-in-loop
            await problem.edit(domainId, pid, { hidden: true });
        }
        this.back();
    }

    @param('pids', Types.NumericArray)
    async postUnhide(domainId: string, pids: number[]) {
        for (const pid of pids) {
            // eslint-disable-next-line no-await-in-loop
            const pdoc = await problem.get(domainId, pid);
            if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
            if (!this.user.own(pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
            // eslint-disable-next-line no-await-in-loop
            await problem.edit(domainId, pid, { hidden: false });
        }
        this.back();
    }
}

export class ProblemRandomHandler extends Handler {
    @param('q', Types.Content, true)
    async get(domainId: string, qs = '') {
        const category = flattenDeep(qs.split(' ')
            .filter((i) => i.startsWith('category:'))
            .map((i) => i.split('category:')[1]?.split(',')));
        const q = buildQuery(this.user);
        if (category.length) q.$and = category.map((tag) => ({ tag }));
        await this.ctx.parallel('problem/list', q, this);
        const pid = await problem.random(domainId, q);
        if (!pid) throw new NoProblemError();
        this.response.body = { pid };
        this.response.redirect = this.url('problem_detail', { pid });
    }
}

export class ProblemDetailHandler extends ContestDetailBaseHandler {
    pdoc: ProblemDoc;
    udoc: User;
    psdoc: ProblemStatusDoc;

    @route('pid', Types.ProblemId, true)
    @query('tid', Types.ObjectId, true)
    async _prepare(domainId: string, pid: number | string, tid?: ObjectId) {
        this.pdoc = await problem.get(domainId, pid);
        if (!this.pdoc) throw new ProblemNotFoundError(domainId, pid);
        if (tid) {
            if (!this.tdoc?.pids?.includes(this.pdoc.docId)) throw new ContestNotFoundError(domainId, tid);
            /*
             * Managers were previously held to the same claim-and-start rule
             * as students, so the TEACHER clicking a task inside their own
             * homework got ContestNotAttendedError — and, downstream, never
             * reached the objective-paper redirect that students get. The
             * bypass mirrors ObjectivePaperHandler's owner-or-root rule, so
             * every role now travels the identical tid path.
             */
            const canManageTdoc = this.user.own(this.tdoc)
                || this.user.hasPerm(PERM.PERM_EDIT_CONTEST)
                || this.user.role === 'root';
            if (!canManageTdoc) {
                if (contest.isNotStarted(this.tdoc)) throw new ContestNotLiveError(tid);
                if (!contest.isDone(this.tdoc, this.tsdoc) && (!this.tsdoc?.attend || !this.tsdoc.startAt)) throw new ContestNotAttendedError(tid);
            }
            // Delete problem-related info in contest mode
            if (this.pdoc.tag) this.pdoc.tag.length = 0;
            delete this.pdoc.nAccept;
            delete this.pdoc.nSubmit;
            delete this.pdoc.difficulty;
            delete this.pdoc.stats;
        } else if (!problem.canViewBy(this.pdoc, this.user)) {
            throw new PermissionError(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        } else if (!seesEveryProblem(this) && (await activityPids(domainId)).has(this.pdoc.docId)) {
            /*
             * PTA fork: opened from the PROBLEM SET (no tid) but the task
             * belongs to a homework / test / session — a student must meet
             * it there, so it does not exist here. Two exceptions keep the
             * rest of the fork working: inside its activity (tid present)
             * nothing changes, and a student who TOOK an activity that owns
             * the task may still reach it once that activity is over — the
             * correction / practice path, whose submissions no longer count.
             */
            if (!await entitledToActivityTask(domainId, this.user._id, this.pdoc.docId)) {
                throw new ProblemNotFoundError(domainId, pid);
            }
        }
        let ddoc = this.domain;
        if (this.pdoc.reference) {
            ddoc = await domain.get(this.pdoc.reference.domainId);
            const pdoc = await problem.get(this.pdoc.reference.domainId, this.pdoc.reference.pid);
            if (!ddoc || !pdoc) throw new ProblemNotFoundError(this.pdoc.reference.domainId, this.pdoc.reference.pid);
            this.pdoc.config = pdoc.config;
            this.pdoc.additional_file = pdoc.additional_file;
        }
        if (typeof this.pdoc.config !== 'string') {
            let baseLangs;
            const t = [];
            if (this.pdoc.config.langs) t.push(this.pdoc.config.langs);
            if (ddoc.langs) t.push(ddoc.langs.split(',').map((i) => i.trim()).filter((i) => i));
            if (this.domain.langs) t.push(this.domain.langs.split(',').map((i) => i.trim()).filter((i) => i));
            if (this.tdoc?.langs?.length) t.push(this.tdoc.langs);
            if (this.pdoc.config.type === 'remote_judge') {
                const p = this.pdoc.config.subType;
                const dl = Object.keys(setting.langs).filter((i) => i.startsWith(`${p}.`) || setting.langs[i].validAs[p]);
                if (setting.langs[p]) dl.push(p);
                baseLangs = dl;
            } else {
                const needHiddenLangs = flattenDeep(t).length;
                baseLangs = Object.keys(setting.langs).filter((i) =>
                    (needHiddenLangs ? !setting.langs[i].remote : !setting.langs[i].remote && !setting.langs[i].hidden));
            }
            /*
             * PTA fork — FUNCTION TASKS: a harness exists per language
             * FAMILY (`cc` covers cc.cc11, cc.cc17o2, …), so offer exactly
             * the variants that can be judged and nothing else. Done here,
             * by family, rather than through `config.langs`, which is
             * intersected by exact id and would have dropped every variant.
             */
            if (typeof this.pdoc.config === 'object' && this.pdoc.config.template && problemKindOf(this.pdoc) === 'function') {
                const { template } = this.pdoc.config;
                baseLangs = baseLangs.filter((l) => !!harnessFor(template, l));
            }
            this.pdoc.config.langs = ['objective', 'submit_answer'].includes(this.pdoc.config.type) ? ['_'] : intersection(baseLangs, ...t);
        }
        await this.ctx.parallel('problem/get', this.pdoc, this);
        [this.psdoc, this.udoc] = await Promise.all([
            problem.getStatus(domainId, this.pdoc.docId, this.user._id),
            user.getById(domainId, this.pdoc.owner),
        ]);
        const [scnt, dcnt] = await Promise.all([
            solution.count(domainId, { parentId: this.pdoc.docId }),
            discussion.count(domainId, { parentId: this.pdoc.docId }),
        ]);
        this.response.body = {
            pdoc: this.pdoc,
            udoc: this.udoc,
            psdoc: tid ? null : this.psdoc,
            title: this.pdoc.title,
            solutionCount: scnt,
            discussionCount: dcnt,
            tdoc: this.tdoc,
            owner_udoc: (tid && this.tdoc.owner !== this.pdoc.owner) ? await user.getById(domainId, this.tdoc.owner) : null,
            mode: !tid ? 'normal'
                : !this.tsdoc?.attend ? 'view'
                    : !contest.isDone(this.tdoc) ? 'contest'
                        : problem.canViewBy(this.pdoc, this.user) ? 'correction' : 'none',
        };
        /*
         * PTA fork: an OBJECTIVE task of a container that has ended is
         * read-only — the submit handler refuses a late tid'd submission and
         * a correction record would be meaningless for a quiz. Programming
         * tasks stay open (the scratchpad submits through the correction
         * path); the flag only reaches the objective renderer.
         */
        if (tid && contest.isDone(this.tdoc, this.tsdoc)) {
            this.UiContext.objectiveLocked = true;
            // …and the left rail keeps the status the deadline froze, whatever
            // a later correction submission is judged (auto_scratchpad).
            this.UiContext.railFrozen = true;
        }
        if (this.tdoc && this.tsdoc) {
            const fields = ['attend', 'startAt', 'endAt'];
            if (contest.canShowSelfRecord.call(this, this.tdoc, true)) fields.push('detail');
            this.tsdoc = pick(this.tsdoc, fields) as typeof this.tsdoc;
            this.response.body.tsdoc = this.tsdoc;
        }
        this.response.template = 'problem_detail.html';
        this.UiContext.extraTitleContent = this.pdoc.title;
    }

    @query('tid', Types.ObjectId, true)
    @query('pjax', Types.Boolean)
    async get(...args: any[]) {
        // PTA fork: students cannot select / copy the statement (staff can).
        this.UiContext.noCopy = !(this.user.hasPerm(PERM.PERM_EDIT_PROBLEM) || this.user.hasPerm(PERM.PERM_CREATE_PROBLEM));
        /*
         * Objective tasks inside a Test or Homework are answered on the
         * COMBINED PAPER: its sidebar lists the container's own tasks and
         * every question sits on one page. So a document navigation that
         * carries a tid forwards there, anchored at this very question,
         * instead of rendering the task alone with the problem-set-wide
         * sidebar. XHR/json callers are untouched, and without a tid the
         * plain problem page keeps working — that is where browsing, Edit
         * and Judge Config live.
         */
        if (this.tdoc && !this.request.json && /^o/i.test(String(this.pdoc?.pid || ''))) {
            const paper = this.tdoc.rule === 'homework' ? 'homework_paper' : 'contest_paper';
            this.response.redirect = `${this.url(paper, { tid: this.tdoc.docId })}#q-${this.pdoc.docId}`;
            return;
        }
        // Navigate to current additional file download
        // e.g. ![img](file://a.jpg) will navigate to ![img](./pid/file/a.jpg)
        if (!this.request.json || args[2]) {
            this.response.body.pdoc.content = this.response.body.pdoc.content
                .replace(/file:\/\/([^ \n)\\"]+)/g, (str: string) => {
                    const info = str.match(/file:\/\/([^ \n)\\"]+)/);
                    const fileinfo = info[1];
                    let filename = fileinfo.split('?')[0]; // remove querystring
                    try {
                        filename = decodeURIComponent(filename);
                    } catch (e) { }
                    if (!this.pdoc.additional_file?.find((i) => i.name === filename)) return str;
                    if (!args[1]) return `./${this.pdoc.docId}/file/${fileinfo}`;
                    return `./${this.pdoc.docId}/file/${fileinfo}${fileinfo.includes('?') ? '&' : '?'}tid=${args[1]}`;
                });
        }
        this.response.body.page_name = this.tdoc
            ? this.tdoc.rule === 'homework'
                ? 'homework_detail_problem'
                : 'contest_detail_problem'
            : 'problem_detail';
        if (args[2]) {
            const data = { pdoc: this.pdoc, tdoc: this.tdoc };
            this.response.body = {
                title: this.renderTitle(this.response.body.page_name),
                fragments: [
                    { html: await this.renderHTML('partials/problem_description.html', data) },
                ],
                raw: data,
            };
        }
        if (!this.response.body.tdoc) {
            if (this.psdoc?.rid) {
                this.response.body.rdoc = await record.get(this.args.domainId, this.psdoc.rid);
            }
            [this.response.body.ctdocs, this.response.body.htdocs] = (await Promise.all([
                contest.getRelated(this.args.domainId, this.pdoc.docId),
                contest.getRelated(this.args.domainId, this.pdoc.docId, 'homework'),
            ])).map((tdocs) => tdocs.filter((tdoc) =>
                this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST) || !tdoc.assign?.length
                || new Set(tdoc.assign).intersection(new Set(this.user.group)).size,
            ));
        }
    }

    @param('pid', Types.UnsignedInt)
    async postRejudge(domainId: string, pid: number) {
        this.checkPerm(PERM.PERM_REJUDGE_PROBLEM);
        if (!this.pdoc.config || typeof this.pdoc.config === 'string') throw new ProblemConfigError();
        const rdocs = await record.getMulti(domainId, {
            pid,
            contest: { $nin: [record.RECORD_GENERATE, record.RECORD_PRETEST] },
            status: { $ne: STATUS.STATUS_CANCELED },
            'files.hack': { $exists: false },
        }).project({ _id: 1, contest: 1 }).toArray();
        if (rdocs.length) {
            const priority = await record.submissionPriority(this.user._id, -10000 - rdocs.length * 5 - 50);
            await record.reset(domainId, rdocs.map((rdoc) => rdoc._id), true);
            await Promise.all([
                record.judge(domainId, rdocs.filter((i) => i.contest).map((i) => i._id), priority, { detail: false }, { rejudge: true }),
                record.judge(domainId, rdocs.filter((i) => !i.contest).map((i) => i._id), priority, {}, { rejudge: true }),
            ]);
        }
        this.back();
    }

    async postDelete() {
        if (!this.user.own(this.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
        const tdocs = await contest.getRelated(this.args.domainId, this.pdoc.docId);
        if (tdocs.length) throw new ProblemAlreadyUsedByContestError(this.pdoc.docId, tdocs[0]._id);
        await problem.del(this.pdoc.domainId, this.pdoc.docId);
        this.response.redirect = this.url('problem_main');
    }

    @param('star', Types.Boolean)
    async postStar(domainId: string, star: boolean) {
        await problem.setStar(domainId, this.pdoc.docId, this.user._id, star);
        this.back({ star });
    }
}

export class ProblemSubmitHandler extends ProblemDetailHandler {
    @param('tid', Types.ObjectId, true)
    async prepare(domainId: string, tid?: ObjectId) {
        if (tid && !contest.isOngoing(this.tdoc, this.tsdoc)) throw new ContestNotLiveError(this.tdoc.docId);
        if (typeof this.pdoc.config === 'string') throw new ProblemConfigError();
        if (this.pdoc.config.langs && !this.pdoc.config.langs.length) throw new ProblemConfigError();
    }

    async get() {
        this.response.template = 'problem_submit.html';
        const langRange = (typeof this.pdoc.config === 'object' && this.pdoc.config.langs)
            ? Object.fromEntries(this.pdoc.config.langs.map((i) => [i, setting.langs[i]?.display || i]))
            : setting.SETTINGS_BY_KEY.codeLang.range;
        this.response.body.langRange = langRange;
        this.response.body.page_name = this.tdoc
            ? this.tdoc.rule === 'homework'
                ? 'homework_detail_problem_submit'
                : 'contest_detail_problem_submit'
            : 'problem_submit';
    }

    @param('lang', Types.Name)
    @param('code', Types.String, true)
    @param('pretest', Types.Boolean)
    @param('input', Types.ArrayOf(Types.String, true), true)
    @param('tid', Types.ObjectId, true)
    async post(domainId: string, lang: string, code: string, pretest = false, input: string[] = [], tid?: ObjectId) {
        const config = this.pdoc.config;
        if (typeof config === 'string' || config === null) throw new ProblemConfigError();
        if (['submit_answer', 'objective'].includes(config.type)) {
            lang = '_';
        } else if ((config.langs && !config.langs.includes(lang)) || !setting.langs[lang] || setting.langs[lang].disabled) {
            throw new ProblemNotAllowLanguageError();
        }
        if (pretest) {
            if (setting.langs[lang]?.pretest) lang = setting.langs[lang].pretest as string;
            if (!['default', 'remote_judge'].includes(this.response.body.pdoc.config?.type)) {
                throw new ProblemNotAllowPretestError('type');
            }
            if (!input.length) throw new ValidationError('input');
            input = input.map((i) => i || '');
        }
        await this.limitRate('add_record', 60, system.get('limit.submission_user'), '{{user}}');
        await this.limitRate('add_record', 60, pretest ? system.get('limit.pretest') : system.get('limit.submission'));
        const files: Record<string, string> = {};
        const lengthLimit = system.get('limit.codelength') || 128 * 1024;
        if (!code) {
            const file = this.request.files?.file;
            if (!file || file.size === 0) throw new ValidationError('code');
            const sizeLimit = config.type === 'submit_answer' ? 128 * 1024 * 1024 : lengthLimit;
            if (file.size > sizeLimit) throw new FileTooLargeError('file');
            const shouldReadFile = () => {
                if (config.type === 'objective') return true;
                if (lang === '_') return false;
                return file.size < lengthLimit && !file.filepath.endsWith('.zip') && !setting.langs[lang].isBinary;
            };
            if (shouldReadFile()) code = await readFile(file.filepath, 'utf-8');
            else {
                const id = nanoid();
                await storage.put(`submission/${this.user._id}/${id}`, file.filepath, this.user._id);
                files.code = `${this.user._id}/${id}#${file.originalFilename}`;
            }
        } else {
            code = code.replace(/\r\n/g, '\n');
            if (code.length > lengthLimit) throw new ValidationError('code');
        }
        const rid = await record.add(
            domainId, this.pdoc.docId, this.user._id, lang, code, true,
            pretest ? { input, type: 'pretest' } : { contest: tid, files, type: 'judge' },
        );
        if (!pretest) {
            await Promise.all([
                problem.inc(domainId, this.pdoc.docId, 'nSubmit', 1),
                domain.incUserInDomain(domainId, this.user._id, 'nSubmit'),
                tid && contest.updateStatus(domainId, tid, this.user._id, rid, this.pdoc.docId),
            ]);
        }
        if (tid && !pretest && !contest.canShowSelfRecord.call(this, this.tdoc)) {
            this.response.body = { tid };
            this.response.redirect = this.url(this.tdoc.rule === 'homework' ? 'homework_detail' : 'contest_problemlist', { tid });
        } else {
            this.response.body = { rid };
            this.response.redirect = this.url('record_detail', { rid });
        }
    }
}

export class ProblemHackHandler extends ProblemDetailHandler {
    rdoc: RecordDoc;

    @param('rid', Types.ObjectId)
    @param('tid', Types.ObjectId, true)
    async prepare(domainId: string, rid: ObjectId, tid?: ObjectId) {
        if (typeof this.pdoc.config !== 'object' || !this.pdoc.config.hackable) throw new HackFailedError('This problem is not hackable.');
        this.rdoc = await record.get(domainId, rid);
        if (!this.rdoc || this.rdoc.pid !== this.pdoc.docId
            || this.rdoc.contest?.toString() !== tid?.toString()) throw new RecordNotFoundError(domainId, rid);
        if (tid) {
            if (this.tdoc.rule !== 'codeforces') throw new HackFailedError('This contest is not hackable.');
            if (!contest.isOngoing(this.tdoc, this.tsdoc)) throw new ContestNotLiveError(this.tdoc.docId);
        }
        if (this.rdoc.uid === this.user._id) throw new HackFailedError('You cannot hack your own submission');
        if (this.psdoc?.status !== STATUS.STATUS_ACCEPTED) throw new HackFailedError('You must accept this problem before hacking.');
        if (this.rdoc.status !== STATUS.STATUS_ACCEPTED) throw new HackFailedError('You cannot hack a unsuccessful submission.');
    }

    async get() {
        this.response.template = 'problem_hack.html';
        this.response.body = {
            pdoc: this.pdoc,
            udoc: this.udoc,
            rid: this.rdoc._id,
            title: this.pdoc.title,
            page_name: this.tdoc ? 'contest_detail_problem_hack' : 'problem_hack',
        };
    }

    @param('input', Types.String, true)
    @param('autoOrganizeInput', Types.Boolean, true)
    @param('tid', Types.ObjectId, true)
    async post(domainId: string, input = '', autoOrganizeInput = false, tid?: ObjectId) {
        await this.limitRate('add_record', 60, system.get('limit.submission_user'), '{{user}}');
        await this.limitRate('add_record', 60, system.get('limit.submission'));
        const id = `${this.user._id}/${nanoid()}`;
        if (this.request.files?.file?.size > 0) {
            const file = this.request.files.file;
            if (!file || file.size > 2 * 1024 * 1024) throw new ValidationError('input');
            await storage.put(`submission/${id}`, file.filepath, this.user._id);
        } else if (input) {
            if (autoOrganizeInput) input = input.replace(/\s+\n/g, '\n').replace(/\s+ /g, ' ');
            await storage.put(`submission/${id}`, Buffer.from(input), this.user._id);
        }
        const rid = await record.add(
            domainId, this.pdoc.docId, this.user._id,
            this.rdoc.lang, this.rdoc.code, true,
            {
                contest: tid,
                type: 'hack',
                hackTarget: this.rdoc._id,
                files: { hack: `${id}#input.txt` },
            },
        );
        this.response.body = { rid };
        this.response.redirect = this.url('record_detail', { rid });
    }
}

export class ProblemManageHandler extends ProblemDetailHandler {
    async prepare() {
        if (!this.user.own(this.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
    }
}



/**
 * Apply the teacher's allowed-language whitelist to config.yaml via
 * read-modify-write (time/memory/cases and any other keys survive).
 * CRITICAL: when the list is empty the key is DELETED, never written as
 * [] — an empty langs array intersects to ZERO allowed languages in
 * Hydro's resolution chain.
 */
async function applyAllowLangs(pdoc: ProblemDoc, owner: number, raw: string) {
    const langs = [...new Set(raw.split(',').map((i) => i.trim()).filter((i) => i && setting.langs[i]))].slice(0, 64);
    const cfg = await readRawProblemConfig(pdoc);
    const had = Array.isArray(cfg.langs) && cfg.langs.length;
    if (!langs.length && !had) return; // nothing to change, don't create a file
    if (langs.length) cfg.langs = langs; else delete cfg.langs;
    await problem.addTestdata(pdoc.domainId, pdoc.docId, 'config.yaml', Buffer.from(yamlDump(cfg)), owner);
}

/**
 * PTA UI: the objective question builder (pages/objective_builder.page.js)
 * posts the answer key it generated as `objectiveConfig` (YAML). Validate it
 * the way the judge reads it (hydrojudge objective: `answers[id] = [answer,
 * score]`, answer = option letter(s) or an exact string) and write it into
 * config.yaml, keeping whatever else the file holds. Empty = leave the key
 * alone (the teacher edited the Markdown by hand or kept the old key).
 */
/**
 * PTA fork — FUNCTION TASKS, manual authoring. The create/edit form posts
 * the judge program and the stub as `functionConfig` (JSON:
 * {language, harness, stub}); they land in config.yaml as `template` /
 * `stub` keyed by the language FAMILY — exactly what the AI Studio writes,
 * so a hand-made F task and a generated one are indistinguishable to the
 * judge path (model/record.ts) and to the problem page. Everything else in
 * config.yaml (cases, limits) is kept. Empty = leave the keys alone.
 */
const isFunctionPid = (pid: any) => /^f/i.test(String(pid || ''));

async function applyFunctionConfig(pdoc: ProblemDoc, owner: number, raw: string) {
    if (!raw || !raw.trim()) return;
    let j: any;
    try {
        j = JSON.parse(raw);
    } catch {
        throw new ValidationError('functionConfig');
    }
    const language = String(j?.language || '').trim();
    const family = language.split('.')[0];
    const harness = String(j?.harness ?? '');
    const stub = String(j?.stub ?? '');
    if (!family || !setting.langs[language]) throw new ValidationError('functionConfig', null, 'Pick the judge program\'s language.');
    if (!harness.trim()) throw new ValidationError('functionConfig', null, 'The judge program cannot be empty.');
    if (harness.length > 60000 || stub.length > 8000) throw new ValidationError('functionConfig', null, 'The judge program or stub is too long.');
    const cfg = await readRawProblemConfig(pdoc);
    // One family per save; other families the teacher wrote by hand in
    // config.yaml survive untouched.
    cfg.template = { ...(cfg.template && typeof cfg.template === 'object' ? cfg.template : {}), [family]: harness };
    if (stub.trim()) cfg.stub = { ...(cfg.stub && typeof cfg.stub === 'object' ? cfg.stub : {}), [family]: stub };
    if (!cfg.type) cfg.type = 'default';
    await problem.addTestdata(pdoc.domainId, pdoc.docId, 'config.yaml', Buffer.from(yamlDump(cfg)), owner);
}

async function applyObjectiveConfig(pdoc: ProblemDoc, owner: number, raw: string) {
    if (!raw || !raw.trim()) return;
    let parsed: any;
    try {
        parsed = yamlLoad(raw);
    } catch {
        throw new ValidationError('objectiveConfig');
    }
    const answers = parsed?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new ValidationError('objectiveConfig');
    const okScore = (x: any) => {
        const score = Math.round(+x);
        if (!(score > 0) || score > 1000) throw new ValidationError('objectiveConfig');
        return score;
    };
    const okText = (x: any) => {
        const text = String(x ?? '').trim();
        if (!text || text.length > 200) throw new ValidationError('objectiveConfig');
        return text;
    };
    const clean: Record<string, [string | string[], number] | Record<string, number>> = {};
    for (const [id, v] of Object.entries(answers)) {
        if (!/^\d+(?:-\d+)?$/.test(id)) throw new ValidationError('objectiveConfig');
        if (Array.isArray(v)) {
            if (v.length < 2) throw new ValidationError('objectiveConfig');
            const score = okScore(v[1]);
            const ans = v[0];
            if (Array.isArray(ans)) {
                const letters = ans.map((x) => String(x).trim().toUpperCase());
                if (!letters.length || !letters.every((x) => /^[A-Z]$/.test(x))) throw new ValidationError('objectiveConfig');
                clean[id] = [letters, score];
            } else clean[id] = [okText(ans), score];
        } else if (v && typeof v === 'object') {
            // Several accepted answers for one blank: the judge's map form
            // `{ answer: score }` — any key that matches scores.
            const map: Record<string, number> = {};
            for (const [text, score] of Object.entries(v as Record<string, any>)) map[okText(text)] = okScore(score);
            if (!Object.keys(map).length || Object.keys(map).length > 10) throw new ValidationError('objectiveConfig');
            clean[id] = map;
        } else throw new ValidationError('objectiveConfig');
    }
    if (!Object.keys(clean).length) throw new ValidationError('objectiveConfig');
    // Task-level comparison flags for fill-in blanks (hydrojudge objective).
    const matching: Record<string, true> = {};
    if (parsed.matching && typeof parsed.matching === 'object') {
        for (const flag of ['ignoreCase', 'ignoreSpaces']) if (parsed.matching[flag] === true) matching[flag] = true;
    }
    const cfg = await readRawProblemConfig(pdoc);
    cfg.type = 'objective';
    cfg.answers = clean;
    if (Object.keys(matching).length) cfg.matching = matching; else delete cfg.matching;
    await problem.addTestdata(pdoc.domainId, pdoc.docId, 'config.yaml', Buffer.from(yamlDump(cfg)), owner);
}

/**
 * PTA UI: the edit page's sidebar lists the domain catalog for click-to-add
 * (mode 'pick' of partials/category.html); the JS toggles chips into the
 * tag input. Counts cover the tasks this viewer may see, all kinds.
 */
async function buildKnowledgePickPanel(h: Handler, domainId: string) {
    try {
        const usage = await KnowledgeModel.tagUsage(domainId, buildQuery(h.user));
        const tree = await KnowledgeModel.tree(domainId, usage, buildQuery(h.user));
        const sections: any[] = [];
        let total = 0;
        const chipOf = (n: any) => {
            total += 1;
            return { name: n.name, count: n.count, description: n.description, path: n.path };
        };
        const walk = (node: any, parents: string[]) => {
            const leaves = node.children.filter((c: any) => !c.children.length);
            const topics = node.children.filter((c: any) => c.children.length);
            sections.push({
                id: node.id,
                parents,
                header: { name: node.name, depth: node.depth, rollup: node.rollup, count: node.count, size: node.children.length, active: false, href: '' },
                // A topic can label a task too (a broad task), so the topic
                // itself is offered as the first chip of its own section.
                points: [{ name: node.name, count: node.count, description: node.description, path: node.path, topic: true }, ...leaves.map(chipOf)],
            });
            for (const t of topics) walk(t, [...parents, node.id]);
        };
        const looseTop = tree.filter((n) => !n.children.length);
        const topTopics = tree.filter((n) => n.children.length);
        if (looseTop.length) sections.push({ id: '', parents: [], header: topTopics.length ? { name: 'Other', depth: 0, rollup: 0, count: 0, size: looseTop.length, active: false, href: '' } : null, points: looseTop.map(chipOf) });
        for (const t of topTopics) walk(t, []);
        if (looseTop.length && topTopics.length) sections.push(sections.shift());
        return { mode: 'pick', total, unused: 0, sections, canManage: h.user.hasPerm(PERM.PERM_CREATE_PROBLEM) };
    } catch (e) {
        return { mode: 'pick', total: 0, unused: 0, sections: [], canManage: h.user.hasPerm(PERM.PERM_CREATE_PROBLEM) };
    }
}

/**
 * Tags ARE knowledge points: whatever a teacher types on the edit page is
 * registered in the domain catalog (new names created as teacher entries,
 * known names and aliases mapped to their canonical spelling), so the
 * catalog and the tasks never drift apart.
 */
async function registerTags(domainId: string, tags: string[], owner: number): Promise<string[]> {
    const names = (tags || []).map((t) => String(t).trim()).filter((t) => t);
    if (!names.length) return [];
    try {
        return await KnowledgeModel.ensure(domainId, names.map((name) => ({ name })), { source: 'teacher', owner });
    } catch (e) {
        return names; // the catalog is a convenience; never block saving the problem
    }
}

export class ProblemEditHandler extends ProblemManageHandler {
    async get() {
        this.response.body.additional_file = sortFiles(this.pdoc.additional_file || []);
        this.response.body.statementLangs = this.ctx.i18n.langs(false);
        const rawCfg = await readRawProblemConfig(this.pdoc);
        this.response.body.allowLangs = rawCfg.langs || [];
        // The objective question builder prefills its correct answers from here.
        if (isObjectivePid(this.pdoc.pid) && rawCfg.answers && typeof rawCfg.answers === 'object') {
            this.UiContext.objectiveAnswers = rawCfg.answers;
            if (rawCfg.matching && typeof rawCfg.matching === 'object') this.UiContext.objectiveMatching = rawCfg.matching;
        }
        // The function-task editor prefills the judge program / stub from here.
        if (rawCfg.template && typeof rawCfg.template === 'object') {
            this.UiContext.functionConfig = { template: rawCfg.template, stub: (rawCfg.stub && typeof rawCfg.stub === 'object') ? rawCfg.stub : {} };
        }
        this.response.body.knowledgePanel = await buildKnowledgePickPanel(this, this.args.domainId);
        this.response.template = 'problem_edit.html';
    }

    @route('pid', Types.ProblemId)
    @post('title', Types.Title)
    @post('content', Types.Content)
    @post('pid', Types.ProblemId, true, (i) => /^(?:[a-z0-9]{1,10}-)?[a-z][a-z0-9]*$/i.test(i))
    @post('hidden', Types.Boolean)
    @post('tag', Types.Content, true, null, parseCategory)
    @post('difficulty', Types.PositiveInt, (i) => +i <= 10, true)
    @post('allowLangs', Types.String, true)
    @post('objectiveConfig', Types.Content, true)
    @post('functionConfig', Types.Content, true)
    async post(
        domainId: string, pid: string | number, title: string, content: string,
        newPid: string | number = '', hidden = false, tag: string[] = [], difficulty = 0, allowLangs = '', objectiveConfig = '', functionConfig = '',
    ) {
        if (typeof newPid !== 'string') newPid = `P${newPid}`;
        if (newPid !== this.pdoc.pid && await problem.get(domainId, newPid)) throw new ProblemAlreadyExistError(newPid);
        tag = await registerTags(domainId, tag ?? [], this.user._id);
        // Objective tasks are titled by their question text; the form's title
        // box is filled by the same rule client-side (lib/objective_title).
        if (isObjectivePid(newPid || this.pdoc.pid)) title = objectiveTitleOf(content, title);
        const $update: Partial<ProblemDoc> = {
            title, content, pid: newPid, hidden, tag: tag ?? [], difficulty, html: false,
        };
        const pdoc = await problem.edit(domainId, this.pdoc.docId, $update);
        await applyAllowLangs(this.pdoc, this.user._id, allowLangs);
        if (isObjectivePid(newPid || this.pdoc.pid)) await applyObjectiveConfig(await problem.get(domainId, this.pdoc.docId), this.user._id, objectiveConfig);
        if (isFunctionPid(newPid || this.pdoc.pid)) await applyFunctionConfig(await problem.get(domainId, this.pdoc.docId), this.user._id, functionConfig);
        this.response.redirect = this.url('problem_detail', { pid: newPid || pdoc.docId });
    }
}

export class ProblemConfigHandler extends ProblemManageHandler {
    async get() {
        if (this.pdoc.reference) throw new ProblemIsReferencedError('edit config');
        this.response.body.testdata = sortFiles(this.pdoc.data || []);
        const configFile = (this.pdoc.data || []).filter((i) => i.name.toLowerCase() === 'config.yaml');
        this.response.body.config = '';
        if (configFile.length > 0) {
            try {
                this.response.body.config = (await streamToBuffer(
                    await storage.get(`problem/${this.pdoc.domainId}/${this.pdoc.docId}/testdata/${configFile[0].name}`),
                )).toString();
            } catch (e) { /* ignore */ }
        }
        this.response.template = 'problem_config.html';
    }
}

export class ProblemFilesHandler extends ProblemDetailHandler {
    notUsage = true;

    @param('d', Types.CommaSeperatedArray, true)
    @param('sidebar', Types.Boolean)
    async get({ }, d = ['testdata', 'additional_file'], sidebar = false) {
        if (this.tdoc) throw new ContestNotEndedError();
        this.response.body.testdata = sortFiles(this.pdoc.data || []);
        this.response.body.additional_file = sortFiles(this.pdoc.additional_file || []);
        this.response.body.reference = this.pdoc.reference;
        this.response.pjax = d.map((i) => ['partials/problem_files.html', { filetype: i, sidebar, can_edit: true }]);
        if (!sidebar) this.response.pjax.push(['partials/problem-sidebar-information.html', {}]);
        this.response.template = 'problem_files.html';
    }

    async post() {
        if (this.args.operation === 'get_links') return;
        if (this.pdoc.reference) throw new ProblemIsReferencedError('edit files');
        if (!this.user.own(this.pdoc, PERM.PERM_EDIT_PROBLEM_SELF)) this.checkPerm(PERM.PERM_EDIT_PROBLEM);
    }

    @post('files', Types.Set)
    @post('type', Types.Range(['testdata', 'additional_file']), true)
    async postGetLinks(domainId: string, files: Set<string>, type = 'testdata') {
        if (type === 'testdata' && !this.user.own(this.pdoc)) {
            if (this.pdoc.reference) throw new ProblemIsReferencedError('download testdata.');
            if (!this.user.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)) this.checkPerm(PERM.PERM_READ_PROBLEM_DATA);
            if (this.tdoc && !contest.isDone(this.tdoc)) throw new ContestNotEndedError(this.tdoc.domainId, this.tdoc.docId);
        }
        if (this.pdoc.reference) this.pdoc = await problem.get(this.pdoc.reference.domainId, this.pdoc.reference.pid);
        const links = {};
        const size = Math.sum(
            this.pdoc[type === 'testdata' ? 'data' : 'additional_file']
                ?.filter((i) => files.has(i.name))
                ?.map((i) => i.size),
        ) || 0;
        await oplog.log(this, 'download.problem.bulk', {
            target: Array.from(files).map((file) => `problem/${this.pdoc.domainId}/${this.pdoc.docId}/${type}/${file}`),
            size,
        });
        for (const file of files) {
            // eslint-disable-next-line no-await-in-loop
            links[file] = await storage.signDownloadLink(
                `problem/${this.pdoc.domainId}/${this.pdoc.docId}/${type}/${file}`,
                file, false, 'user',
            );
        }
        this.response.body.links = links;
    }

    @post('filename', Types.Filename, true)
    @post('type', Types.Range(['testdata', 'additional_file']), true)
    async postUploadFile(domainId: string, filename: string, type = 'testdata') {
        const file = this.request.files.file;
        if (!file) throw new ValidationError('file');
        filename ||= file.originalFilename || randomstring(16);
        const files = [];
        if (filename.endsWith('.zip') && type === 'testdata') {
            const zip = new ZipReader(Readable.toWeb(createReadStream(file.filepath)));
            let entries: Entry[];
            try {
                entries = await zip.getEntries();
            } catch (e) {
                throw new ValidationError('zip', null, e.message);
            }
            for (const entry of entries) {
                if (!entry.filename || entry.directory === true) continue;
                files.push({
                    type,
                    name: sanitize(entry.filename),
                    size: entry.uncompressedSize,
                    data: () => {
                        const pass = new PassThrough();
                        entry.getData(Writable.toWeb(pass));
                        return pass;
                    },
                });
            }
        } else {
            files.push({
                type,
                name: filename,
                size: file.size,
                data: () => file.filepath,
            });
        }
        if (!this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            if ((this.pdoc.data?.length || 0)
                + (this.pdoc.additional_file?.length || 0)
                + files.length
                >= this.ctx.setting.get('limit.problem_files_max')) {
                throw new FileLimitExceededError('count');
            }
            const size = Math.sum(
                (this.pdoc.data || []).map((i) => i.size),
                (this.pdoc.additional_file || []).map((i) => i.size),
                files.map((i) => i.size),
            );
            if (size >= this.ctx.setting.get('limit.problem_files_max_size')) {
                throw new FileLimitExceededError('size');
            }
        }
        for (const entry of files) {
            const method = entry.type === 'testdata' ? 'addTestdata' : 'addAdditionalFile';
            // eslint-disable-next-line no-await-in-loop
            await problem[method](domainId, this.pdoc.docId, entry.name, entry.data(), this.user._id);
        }
        this.back();
    }

    @post('files', Types.ArrayOf(Types.Filename))
    @post('newNames', Types.ArrayOf(Types.Filename))
    @post('type', Types.Range(['testdata', 'additional_file']), true)
    async postRenameFiles(domainId: string, files: string[], newNames: string[], type = 'testdata') {
        if (files.length !== newNames.length) throw new ValidationError('files', 'newNames');
        await Promise.all(files.map(async (file, index) => {
            const newName = newNames[index];
            if (type === 'testdata') await problem.renameTestdata(domainId, this.pdoc.docId, file, newName, this.user._id);
            else await problem.renameAdditionalFile(domainId, this.pdoc.docId, file, newName, this.user._id);
        }));
        this.back();
    }

    @post('files', Types.ArrayOf(Types.Filename))
    @post('type', Types.Range(['testdata', 'additional_file']), true)
    async postDeleteFiles(domainId: string, files: string[], type = 'testdata') {
        if (type === 'testdata') await problem.delTestdata(domainId, this.pdoc.docId, files, this.user._id);
        else await problem.delAdditionalFile(domainId, this.pdoc.docId, files, this.user._id);
        this.back();
    }

    @post('std', Types.Filename)
    @post('gen', Types.Filename)
    async postGenerateTestdata(domainId: string, std: string, gen: string) {
        if (!this.pdoc.data?.find((i) => i.name === std)) throw new BadRequestError();
        if (!this.pdoc.data?.find((i) => i.name === gen)) throw new BadRequestError();
        const rid = await record.add(domainId, this.pdoc.docId, this.user._id, '_', `${gen}\n${std}`, true, {
            type: 'generate',
        });
        this.response.redirect = this.url('record_detail', { rid });
    }
}

export class ProblemFileDownloadHandler extends ProblemDetailHandler {
    @query('type', Types.Range(['additional_file', 'testdata']), true)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    @query('tid', Types.ObjectId, true)
    async get({ }, type = 'additional_file', filename: string, noDisposition = false, tid: ObjectId) {
        if (!tid) this.checkPerm(PERM.PERM_VIEW_PROBLEM);
        if (this.pdoc.reference) {
            if (type === 'testdata') throw new ProblemIsReferencedError('download testdata');
            this.pdoc = await problem.get(this.pdoc.reference.domainId, this.pdoc.reference.pid);
            if (!this.pdoc) throw new ProblemNotFoundError();
        }
        if (type === 'testdata' && !this.user.own(this.pdoc)) {
            if (!this.user.hasPriv(PRIV.PRIV_READ_PROBLEM_DATA)) this.checkPerm(PERM.PERM_READ_PROBLEM_DATA);
            if (this.tdoc && !contest.isDone(this.tdoc)) throw new ContestNotEndedError(this.tdoc.domainId, this.tdoc.docId);
        }
        const target = `problem/${this.pdoc.domainId}/${this.pdoc.docId}/${type}/${filename}`;
        const file = await storage.getMeta(target);
        await oplog.log(this, 'download.problem.single', {
            target,
            size: file?.size || 0,
        });
        this.response.redirect = await storage.signDownloadLink(
            target, noDisposition ? undefined : filename, false, 'user',
        );
    }
}

export class ProblemSolutionHandler extends ProblemDetailHandler {
    @param('page', Types.PositiveInt, true)
    @param('tid', Types.ObjectId, true)
    @param('sid', Types.ObjectId, true)
    async get(domainId: string, page = 1, tid?: ObjectId, sid?: ObjectId) {
        if (tid) throw new PermissionError(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        this.response.template = 'problem_solution.html';
        const accepted = this.psdoc?.status === STATUS.STATUS_ACCEPTED;
        if (!accepted || !this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION_ACCEPT)) {
            this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        }

        let [psdocs, pcount, pscount] = await this.paginate(
            solution.getMulti(domainId, this.pdoc.docId),
            page,
            'solution',
        );
        if (sid) {
            psdocs = [await solution.get(domainId, sid)];
            if (!psdocs[0]) throw new SolutionNotFoundError(domainId, sid);
        }
        const uids = [this.pdoc.owner];
        const docids = [];
        for (const psdoc of psdocs) {
            docids.push(psdoc.docId);
            uids.push(psdoc.owner);
            if (psdoc.reply.length) {
                for (const psrdoc of psdoc.reply) uids.push(psrdoc.owner);
            }
        }
        const udict = await user.getList(domainId, uids);
        const pssdict = await solution.getListStatus(domainId, docids, this.user._id);
        this.response.body = {
            psdocs, page, pcount, pscount, udict, pssdict, pdoc: this.pdoc, sid,
        };
    }

    @param('content', Types.Content)
    async postSubmit(domainId: string, content: string) {
        this.checkPerm(PERM.PERM_CREATE_PROBLEM_SOLUTION);
        const psid = await solution.add(domainId, this.pdoc.docId, this.user._id, content);
        this.back({ psid });
    }

    @param('content', Types.Content)
    @param('psid', Types.ObjectId)
    async postEditSolution(domainId: string, content: string, psid: ObjectId) {
        let psdoc = await solution.get(domainId, psid);
        if (!this.user.own(psdoc)) this.checkPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION);
        else this.checkPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_SELF);
        psdoc = await solution.edit(domainId, psdoc.docId, content);
        this.back({ psdoc });
    }

    @param('psid', Types.ObjectId)
    async postDeleteSolution(domainId: string, psid: ObjectId) {
        const psdoc = await solution.get(domainId, psid);
        if (!this.user.own(psdoc)) this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION);
        else this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_SELF);
        await solution.del(domainId, psdoc.docId);
        this.back();
    }

    @param('psid', Types.ObjectId)
    @param('content', Types.Content)
    async postReply(domainId: string, psid: ObjectId, content: string) {
        this.checkPerm(PERM.PERM_REPLY_PROBLEM_SOLUTION);
        const psdoc = await solution.get(domainId, psid);
        await solution.reply(domainId, psdoc.docId, this.user._id, content);
        this.back();
    }

    @param('psid', Types.ObjectId)
    @param('psrid', Types.ObjectId)
    @param('content', Types.Content)
    async postEditReply(domainId: string, psid: ObjectId, psrid: ObjectId, content: string) {
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if (!psdoc || psdoc.parentId !== this.pdoc.docId) throw new SolutionNotFoundError(domainId, psid);
        if (!this.user.own(psrdoc) || !this.user.hasPerm(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF)) {
            throw new PermissionError(PERM.PERM_EDIT_PROBLEM_SOLUTION_REPLY_SELF);
        }
        await solution.editReply(domainId, psid, psrid, content);
        this.back();
    }

    @param('psid', Types.ObjectId)
    @param('psrid', Types.ObjectId)
    async postDeleteReply(domainId: string, psid: ObjectId, psrid: ObjectId) {
        const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
        if (!psdoc || psdoc.parentId !== this.pdoc.docId) throw new SolutionNotFoundError(domainId, psid);
        if (!this.user.own(psrdoc) || !this.user.hasPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY_SELF)) {
            this.checkPerm(PERM.PERM_DELETE_PROBLEM_SOLUTION_REPLY);
        }
        await solution.delReply(domainId, psid, psrid);
        this.back();
    }

    @param('psid', Types.ObjectId)
    async postUpvote(domainId: string, psid: ObjectId) {
        this.checkPerm(PERM.PERM_VOTE_PROBLEM_SOLUTION);
        const psdoc = await solution.vote(domainId, psid, this.user._id, 1);
        this.back({ vote: psdoc.vote, user_vote: 1 });
    }

    @param('psid', Types.ObjectId)
    async postDownvote(domainId: string, psid: ObjectId) {
        this.checkPerm(PERM.PERM_VOTE_PROBLEM_SOLUTION);
        const psdoc = await solution.vote(domainId, psid, this.user._id, -1);
        this.back({ vote: psdoc.vote, user_vote: -1 });
    }
}

export class ProblemSolutionRawHandler extends ProblemDetailHandler {
    @param('psid', Types.ObjectId)
    @route('psrid', Types.ObjectId, true)
    @param('tid', Types.ObjectId, true)
    async get(domainId: string, psid: ObjectId, psrid?: ObjectId, tid?: ObjectId) {
        if (tid) throw new PermissionError(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        const accepted = this.psdoc?.status === STATUS.STATUS_ACCEPTED;
        if (!accepted || !this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION_ACCEPT)) {
            this.checkPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION);
        }
        if (psrid) {
            const [psdoc, psrdoc] = await solution.getReply(domainId, psid, psrid);
            if ((!psdoc) || psdoc.parentId !== this.pdoc.docId) throw new SolutionNotFoundError(psid, psrid);
            this.response.body = psrdoc.content;
        } else {
            const psdoc = await solution.get(domainId, psid);
            this.response.body = psdoc.content;
        }
        this.response.type = 'text/markdown';
    }
}

export class ProblemStatisticsHandler extends ProblemDetailHandler {
    @param('sort', Types.Range(Object.keys(record.STAT_QUERY)), true)
    @param('direction', Types.Range([-1, 1]), true)
    @param('lang', Types.String, true)
    @param('page', Types.PositiveInt, true)
    async get(domainId: string, sort = 'time', direction: 1 | -1 = 1, lang?: string, page = 1) {
        if (this.tdoc) throw new ContestNotEndedError();
        // PTA fork: submission history is private — for everyone but root
        // the per-problem statistics table only lists the viewer's own
        // submissions (same rule as /record).
        const selfOnly = !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM);
        const [rsdocs, pcount, rscount] = await this.paginate(
            record.getMultiStat(domainId, {
                pid: this.pdoc.docId,
                ...selfOnly ? { uid: this.user._id } : {},
                ...lang ? { lang } : {},
            }, record.STAT_QUERY[sort][Math.max(direction, 0)]),
            page,
            'record',
        );
        const [udict, udoc] = await Promise.all([
            user.getListForRender(domainId, rsdocs.map((i) => i.uid), this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO)),
            user.getById(domainId, this.pdoc.owner),
        ]);
        this.response.template = 'problem_statistics.html';
        this.response.body = {
            rsdocs, page, pcount, rscount, sort, direction, pdoc: this.pdoc, udict, types: Object.keys(record.STAT_QUERY), udoc, selfOnly,
        };
    }
}

/**
 * PTA UI: the tag vocabulary offered by the picker's filter bar.
 *
 * Deliberately NOT the `problem.categories` setting: that is a curated,
 * site-wide taxonomy, while a course's problems are tagged with whatever the
 * teacher actually typed ("loops", "while", "Lab 3"). Filtering by a tag that
 * matches nothing is useless, so the facet is derived from the problems
 * themselves and carries a count per tag.
 *
 * Scoped by buildQuery, so tags that exist only on hidden problems are not
 * disclosed to users without PERM_VIEW_PROBLEM_HIDDEN.
 */
const TAG_FACET_TTL = 60 * 1000;
const TAG_FACET_SCAN_LIMIT = 5000;
/**
 * Per-process memo. Unlike a correctness guard, a cache may safely be
 * process-local: with several workers the worst case is each one computing
 * the same facet once per TTL, and a tag added in the meantime shows up a
 * minute later.
 */
const tagFacetCache = new Map<string, { at: number, tags: { name: string, count: number }[] }>();

export class ProblemTagsHandler extends Handler {
    async get({ domainId }) {
        const key = `${domainId}/${this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) ? 'all' : this.user._id}`;
        const cached = tagFacetCache.get(key);
        if (cached && Date.now() - cached.at < TAG_FACET_TTL) {
            this.response.body = { tags: cached.tags };
            return;
        }
        const counts = new Map<string, number>();
        // Bounded scan: a projection of one field over an indexed sort
        // streams cheaply, but the cap keeps a pathologically large domain
        // from turning a filter-bar render into a full collection walk.
        const cursor = problem.getMulti(domainId, buildQuery(this.user), ['tag']).limit(TAG_FACET_SCAN_LIMIT);
        for await (const pdoc of cursor) {
            for (const tag of pdoc.tag || []) {
                const name = String(tag).trim();
                if (name) counts.set(name, (counts.get(name) || 0) + 1);
            }
        }
        const tags = [...counts.entries()]
            .map(([name, count]) => ({ name, count }))
            // Most-used first so the chips a teacher wants are within reach;
            // ties alphabetical so the list is stable between requests.
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
            .slice(0, 200);
        tagFacetCache.set(key, { at: Date.now(), tags });
        this.response.body = { tags };
    }
}

/** How much statement the hover preview is allowed to pull down per problem. */
const PREVIEW_STATEMENT_LIMIT = 2500;

/**
 * PTA UI: statement preview for the problem picker in the Test / Homework /
 * Self-Learning editors.
 *
 * A teacher assembling an activity has to recognise a task from a one-line
 * dropdown row; this endpoint backs the panel that opens beside the row so
 * they can read the actual statement without leaving the form.
 *
 * Deliberately NOT the problem_detail JSON: that handler also loads the
 * owner, the personal status document, the discussion counters and fires the
 * problem/detail hooks — far too much for something that runs on hover. This
 * is one problem.get plus a truncation, and it returns JSON only (no
 * template), so there is no HTML representation for a cache to confuse it
 * with.
 */
export class ProblemPreviewHandler extends Handler {
    @route('pid', Types.ProblemId)
    async get(domainId: string, pid: number | string) {
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
        // Same visibility rule as the problem page: hidden problems stay
        // invisible to anyone without PERM_VIEW_PROBLEM_HIDDEN, so the picker
        // cannot be used to read a draft statement.
        if (!problem.canViewBy(pdoc, this.user)) throw new PermissionError(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        // Same resolution order (and the same optional chaining) the core's
        // own translate() uses: `session` is not guaranteed to be populated
        // on every request path.
        const preferLang = this.user?.viewLang || this.session?.viewLang || system.get('server.language') || 'en';
        const statement = resolveStatement(pdoc.content, preferLang);
        const truncated = statement.length > PREVIEW_STATEMENT_LIMIT;
        this.response.body = {
            docId: pdoc.docId,
            pid: pdoc.pid || '',
            title: pdoc.title,
            kind: problemKindOf(pdoc),
            tag: pdoc.tag || [],
            difficulty: pdoc.difficulty || 0,
            nSubmit: pdoc.nSubmit || 0,
            nAccept: pdoc.nAccept || 0,
            hidden: !!pdoc.hidden,
            statement: truncated ? statement.slice(0, PREVIEW_STATEMENT_LIMIT) : statement,
            truncated,
        };
    }
}

export class ProblemCreateHandler extends Handler {
    async get() {
        this.response.body.statementLangs = this.ctx.i18n.langs(false);
        this.response.template = 'problem_edit.html';
        this.response.body = {
            page_name: 'problem_create',
            additional_file: [],
            knowledgePanel: await buildKnowledgePickPanel(this, this.args.domainId),
        };
    }

    @post('title', Types.Title)
    @post('content', Types.Content)
    @post('pid', Types.ProblemId, true, (i) => /^(?:[a-z0-9]{1,10}-)?[a-z][a-z0-9]*$/i.test(i))
    @post('hidden', Types.Boolean)
    @post('difficulty', Types.PositiveInt, (i) => +i <= 10, true)
    @post('tag', Types.Content, true, null, parseCategory)
    @post('allowLangs', Types.String, true)
    @post('objectiveConfig', Types.Content, true)
    @post('functionConfig', Types.Content, true)
    async post(
        domainId: string, title: string, content: string, pid: string | number = '',
        hidden = false, difficulty = 0, tag: string[] = [], allowLangs = '', objectiveConfig = '', functionConfig = '',
    ) {
        if (typeof pid !== 'string') pid = `P${pid}`;
        if (pid && await problem.get(domainId, pid)) throw new ProblemAlreadyExistError(pid);
        tag = await registerTags(domainId, tag ?? [], this.user._id);
        // Objective tasks are titled by their question text (lib/objective_title).
        if (isObjectivePid(pid)) title = objectiveTitleOf(content, title);
        const docId = await problem.add(domainId, pid, title, content, this.user._id, tag ?? [], { hidden, difficulty });
        const cleanLangs = [...new Set(allowLangs.split(',').map((i) => i.trim()).filter((i) => i && setting.langs[i]))].slice(0, 64);
        if (cleanLangs.length) await problem.addTestdata(domainId, docId, 'config.yaml', Buffer.from(yamlDump({ langs: cleanLangs })), this.user._id);
        // The objective question builder's answer key → config.yaml.
        if (isObjectivePid(pid)) await applyObjectiveConfig(await problem.get(domainId, docId), this.user._id, objectiveConfig);
        // The function-task editor's judge program + stub → config.yaml.
        if (isFunctionPid(pid)) await applyFunctionConfig(await problem.get(domainId, docId), this.user._id, functionConfig);
        const files = new Set(Array.from(content.matchAll(/file:\/\/([\w-]+\.[a-zA-Z0-9]+)/g)).map((i) => i[1]));
        const tasks = [];
        for (const file of files) {
            if (this.user._files.find((i) => i.name === file)) {
                tasks.push(
                    storage.rename(`user/${this.user._id}/${file}`, `problem/${domainId}/${docId}/additional_file/${file}`, this.user._id)
                        .then(() => problem.addAdditionalFile(domainId, docId, file, '', this.user._id, true)),
                    user.setById(this.user._id, { _files: this.user._files.filter((i) => i.name !== file) }),
                );
            }
        }
        await Promise.all(tasks);
        this.response.body = { pid: pid || docId };
        this.response.redirect = this.url('problem_files', { pid: pid || docId });
    }
}

export const ProblemApi = {
    problem: Query(
        Schema.object({
            id: Schema.union([Schema.number().step(1), Schema.string()]).required(),
            domainId: Schema.string().required(),
        }),
        async (ctx, args) => {
            const pdoc = await problem.get(args.domainId, args.id);
            if (!pdoc) return null;
            if (pdoc.hidden) ctx.checkPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN);
            return pdoc;
        },
    ),
    problems: Query(
        Schema.object({
            ids: Schema.array(Schema.number().step(1)).required(),
            domainId: Schema.string().required(),
        }),
        async (ctx, args) => {
            const pdocs = await problem.getList(args.domainId, args.ids, ctx.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || ctx.user._id,
                undefined, undefined, true);
            return args.ids.map((id) => pdocs[+id]).filter((i) => i);
        },
    ),
} as const;

declare module '@hydrooj/framework' {
    interface Apis {
        problem: typeof ProblemApi;
    }
}

export async function apply(ctx: Context) {
    // PTA fork: keep the activity-owned pid cache fresh (lib/activity_pids).
    applyActivityPidsCache(ctx);
    ctx.Route('problem_main', '/p', ProblemMainHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_random', '/problem/random', ProblemRandomHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_detail', '/p/:pid', ProblemDetailHandler);
    ctx.Route('problem_submit', '/p/:pid/submit', ProblemSubmitHandler, PERM.PERM_SUBMIT_PROBLEM);
    ctx.Route('problem_hack', '/p/:pid/hack/:rid', ProblemHackHandler, PERM.PERM_SUBMIT_PROBLEM);
    ctx.Route('problem_edit', '/p/:pid/edit', ProblemEditHandler);
    ctx.Route('problem_config', '/p/:pid/config', ProblemConfigHandler);
    ctx.Route('problem_files', '/p/:pid/files', ProblemFilesHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_file_download', '/p/:pid/file/:filename', ProblemFileDownloadHandler);
    ctx.Route('problem_solution', '/p/:pid/solution', ProblemSolutionHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_solution_detail', '/p/:pid/solution/:sid', ProblemSolutionHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_solution_raw', '/p/:pid/solution/:psid/raw', ProblemSolutionRawHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_solution_reply_raw', '/p/:pid/solution/:psid/:psrid/raw', ProblemSolutionRawHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_statistics', '/p/:pid/stat', ProblemStatisticsHandler, PERM.PERM_VIEW_PROBLEM);
    // Hover preview for the problem picker (contest / homework / self-learning editors).
    ctx.Route('problem_preview', '/p/:pid/preview', ProblemPreviewHandler, PERM.PERM_VIEW_PROBLEM);
    // Tag vocabulary for the picker's filter bar. Registered under /problem/
    // rather than /p/ so it cannot ever be swallowed by the /p/:pid route.
    ctx.Route('problem_tags', '/problem/tags', ProblemTagsHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('problem_create', '/problem/create', ProblemCreateHandler, PERM.PERM_CREATE_PROBLEM);
    await ctx.inject(['api'], ({ api }) => {
        api.provide(ProblemApi);
    });
}
