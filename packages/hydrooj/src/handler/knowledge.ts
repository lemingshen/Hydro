/**
 * PTA fork: the DOMAIN KNOWLEDGE-POINT CATALOG — the teacher-facing side of
 * model/knowledge.ts. One page per domain (/knowledge-points) where course
 * staff search, add, describe, rename, merge and delete the knowledge points
 * their tasks are labeled with, see which tasks carry each point, and
 * attach / detach points on any task of the domain.
 *
 * Tags ARE knowledge points: the problem edit page picks a task's tags from
 * this catalog (registering anything new), and the AI Studio labels
 * programming tasks against it — so the catalog is always the complete
 * vocabulary of the domain's tasks. The JSON view is readable by anyone
 * who can view problems (the problem set and the pickers show the same
 * names); the page and every mutation are for task authors.
 *
 * Route naming: /knowledge-points sits beside /ai-studio on purpose —
 * /ai-studio/:id would swallow any fixed segment registered after it.
 */
import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { BadRequestError, ForbiddenError, NotFoundError } from '../error';
import { Logger } from '../logger';
import { PERM, PRIV, STATUS } from '../model/builtin';
import * as aiTutor from '../lib/ai_tutor';
import { assistantEnabled, postureOf, runTurn } from '../lib/assistant';
import { cancelScheduledMastery, computeMastery, scheduleMastery } from '../lib/knowledge_map';
import { seesEveryProblem } from './problem';
import domain from '../model/domain';
import KnowledgeModel, { KNOWLEDGE_MAX_DEPTH, KnowledgeTreeNode, PATH_SEP } from '../model/knowledge';
import {
    getMap, getMapsIn, getProfile, getThread, mapFresh, mapStale, markDirty, resetThread, saveMap, saveProfile,
} from '../model/knowledgemap';
import problem from '../model/problem';
import system from '../model/system';
import user from '../model/user';
import { Handler, param, Types } from '../service/server';

const logger = new Logger('knowledge');

/** Site convention: the pid prefix marks the task kind. */
function kindOfPid(pid: any): 'programming' | 'objective' | 'subjective' {
    const p = String(pid || '');
    if (/^o/i.test(p)) return 'objective';
    if (/^s/i.test(p)) return 'subjective';
    return 'programming';
}

/** Client shape of a catalog entry (usage folded in; `rollup` counts the subtree's distinct tasks). */
function viewOf(doc: any, count = 0, extra: { rollup?: number, childCount?: number } = {}) {
    const path: string[] = doc.path || [];
    return {
        _id: doc._id,
        name: doc.name,
        description: doc.description || '',
        aliases: doc.aliases || [],
        parent: doc.parent ? String(doc.parent) : '',
        parentName: path.length ? path[path.length - 1] : '',
        path,
        pathText: path.join(PATH_SEP),
        depth: doc.depth || 0,
        // `category` stays in the JSON as the parent's name for older clients.
        category: path.length ? path[path.length - 1] : '',
        source: doc.source || 'teacher',
        owner: doc.owner || 0,
        updateAt: doc.updateAt,
        count,
        rollup: extra.rollup ?? count,
        childCount: extra.childCount ?? 0,
    };
}

/** id → { rollup, childCount } over a tree. */
function indexTree(nodes: KnowledgeTreeNode[], into = new Map<string, { rollup: number, childCount: number }>()) {
    for (const n of nodes) {
        into.set(n.id, { rollup: n.rollup, childCount: n.children.length });
        indexTree(n.children, into);
    }
    return into;
}

class KnowledgePointsHandler extends Handler {
    async prepare() {
        // The catalog PAGE is for task authors (same gate as the AI Studio);
        // the JSON view feeds pickers and suggestion boxes, so anyone who
        // can view problems may read it. Every mutation checks again.
        if (this.request.json) this.checkPerm(PERM.PERM_VIEW_PROBLEM);
        else this.checkPerm(PERM.PERM_CREATE_PROBLEM);
        // HTML for navigation, JSON for the page's own XHR at the same URL —
        // keep caches from replaying one as the other (see AiStudioBaseHandler).
        this.response.addHeader('Vary', 'Accept');
        this.response.addHeader('Cache-Control', 'no-store, must-revalidate');
    }

    /** Any change to the catalog itself needs authoring rights in the domain. */
    checkCatalogEdit() {
        this.checkPerm(PERM.PERM_CREATE_PROBLEM);
    }

    /** Mutations that rewrite tasks' tags need the right to edit any problem of the domain. */
    checkProblemEdit() {
        this.checkPerm(PERM.PERM_CREATE_PROBLEM);
        this.checkPerm(PERM.PERM_EDIT_PROBLEM);
    }

    /** Counts and task lists only ever include what THIS viewer may see. */
    get visible() {
        return KnowledgeModel.visibilityFilter(this.user, PERM.PERM_VIEW_PROBLEM_HIDDEN);
    }

    /**
     * GET: the whole catalog (optionally filtered by ?q=) with per-point
     * usage, plus the tags in use on programming tasks that are NOT catalog
     * entries yet (import candidates). ?id= adds one point's task list.
     */
    @param('q', Types.String, true)
    @param('id', Types.ObjectId, true)
    @param('limit', Types.PositiveInt, true)
    async get({ domainId }, q = '', id?: ObjectId, limit = 500) {
        const [points, usage] = await Promise.all([
            KnowledgeModel.list(domainId, q, limit),
            KnowledgeModel.tagUsage(domainId, this.visible),
        ]);
        const usageLower = new Map<string, number>();
        for (const [tag, n] of usage) usageLower.set(tag.toLowerCase(), (usageLower.get(tag.toLowerCase()) || 0) + n);
        const known = new Set<string>();
        const all = q ? await KnowledgeModel.getMulti(domainId).project({ nameLower: 1, aliasesLower: 1 }).toArray() : points;
        for (const p of all as any[]) {
            known.add(p.nameLower);
            for (const a of p.aliasesLower || []) known.add(a);
        }
        // Tags on tasks that have no catalog entry yet (older data, imported
        // problem packages): the teacher can import them.
        const untracked = [...usage.entries()]
            .filter(([tag]) => !known.has(tag.toLowerCase()))
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
            .slice(0, 200);
        // 🌳 The tree (with distinct roll-ups) is what the page draws; the
        // flat `points` list still serves search and the pickers.
        const tree = await KnowledgeModel.tree(domainId, usage, this.visible);
        const meta = indexTree(tree);
        const body: any = {
            q,
            points: points.map((p) => viewOf(p, usageLower.get(p.nameLower) || 0, meta.get(p._id.toHexString()))),
            tree,
            maxDepth: KNOWLEDGE_MAX_DEPTH,
            total: await KnowledgeModel.count(domainId),
            untracked,
            canEditProblems: this.user.hasPerm(PERM.PERM_EDIT_PROBLEM),
            aiAvailable: aiTutor.tutorEnabled() && aiTutor.tutorConfigured(),
        };
        if (id) {
            const doc = await KnowledgeModel.get(domainId, id);
            if (!doc) throw new NotFoundError(id);
            // The point's own tasks, then — for a topic — the tasks of
            // everything beneath it, each labeled with the point it carries.
            const pdocs = await KnowledgeModel.problemsWith(domainId, doc.name, 500, this.visible);
            const below = await KnowledgeModel.descendants(domainId, doc._id).toArray();
            const seen = new Set(pdocs.map((p) => p.docId));
            const under: any[] = [];
            for (const d of below) {
                const ps = await KnowledgeModel.problemsWith(domainId, d.name, 200, this.visible);
                for (const p of ps) {
                    if (seen.has(p.docId)) continue;
                    seen.add(p.docId);
                    under.push({ docId: p.docId, pid: p.pid || String(p.docId), title: p.title, hidden: !!p.hidden, kind: kindOfPid(p.pid), via: d.name });
                }
            }
            body.point = viewOf(doc, pdocs.length, meta.get(doc._id.toHexString()));
            body.problems = pdocs.map((p) => ({
                docId: p.docId, pid: p.pid || String(p.docId), title: p.title, hidden: !!p.hidden, kind: kindOfPid(p.pid),
            }));
            body.problemsBelow = under;
            body.children = below.filter((d) => d.parent && d.parent.equals(doc._id)).map((d) => viewOf(d, usageLower.get(d.nameLower) || 0, meta.get(d._id.toHexString())));
        }
        this.response.template = 'knowledge_points.html';
        this.response.body = body;
    }

    /** `parent`: a point's id or name (empty = top level); `category` is the retired spelling of the same. */
    @param('name', Types.String)
    @param('description', Types.String, true)
    @param('aliases', Types.String, true)
    @param('parent', Types.String, true)
    @param('category', Types.String, true)
    async postCreate({ domainId }, name: string, description = '', aliases = '', parent = '', category = '') {
        this.checkCatalogEdit();
        let doc;
        try {
            doc = await KnowledgeModel.add(domainId, {
                name, description, aliases, parent: parent || category || null, source: 'teacher', owner: this.user._id,
            });
        } catch (e) {
            throw new BadRequestError(e.message);
        }
        this.response.body = { point: viewOf(doc, 0) };
    }

    /** Edit any field; a changed name renames the point and rewrites the tasks' tags. */
    @param('id', Types.ObjectId)
    @param('name', Types.String, true)
    @param('description', Types.String, true)
    @param('aliases', Types.String, true)
    @param('parent', Types.String, true)
    @param('category', Types.String, true)
    async postUpdate({ domainId }, id: ObjectId, name?: string, description?: string, aliases?: string, parent?: string, category?: string) {
        this.checkCatalogEdit();
        const doc = await KnowledgeModel.get(domainId, id);
        if (!doc) throw new NotFoundError(id);
        let touched = 0;
        try {
            if (name !== undefined && KnowledgeModel.normalizeName(name) !== doc.name) {
                this.checkProblemEdit();
                touched = (await KnowledgeModel.rename(domainId, id, name)).touched;
            }
            await KnowledgeModel.edit(domainId, id, {
                ...(description !== undefined ? { description } : {}),
                ...(aliases !== undefined ? { aliases } : {}),
            });
            // 🌳 A changed parent moves the point — and its subtree — in the tree.
            const wantParent = parent !== undefined ? parent : category;
            if (wantParent !== undefined) await KnowledgeModel.move(domainId, id, wantParent || null);
        } catch (e) {
            if (e instanceof Error && !(e as any).code) throw new BadRequestError(e.message);
            throw e;
        }
        const fresh = await KnowledgeModel.get(domainId, id);
        const pdocs = await KnowledgeModel.problemsWith(domainId, fresh!.name, 500, this.visible);
        this.response.body = { point: viewOf(fresh, pdocs.length), touched };
    }

    /** Re-parent a point (and its subtree); `parent` empty = top level. */
    @param('id', Types.ObjectId)
    @param('parent', Types.String, true)
    async postMove({ domainId }, id: ObjectId, parent = '') {
        this.checkCatalogEdit();
        try {
            const doc = await KnowledgeModel.move(domainId, id, parent || null);
            this.response.body = { point: viewOf(doc, 0) };
        } catch (e) {
            throw new BadRequestError(e.message);
        }
    }

    /**
     * 🔁 REORGANIZE WITH AI — a proposal, never a change. The model reads
     * the WHOLE catalog (every point with its present place) and proposes
     * the best tree for it: every point may move, topics may gain
     * sub-topics, new topics may appear, a topic the proposal does not
     * mention is not kept (its points go elsewhere). The teacher reviews
     * the proposal on the page — renaming topics, pulling points out —
     * and applies it (postApplyOrganize), which also reports the topics
     * the moves left empty.
     */
    async postOrganize({ domainId }) {
        this.checkCatalogEdit();
        if (!(aiTutor.tutorEnabled() && aiTutor.tutorConfigured())) throw new BadRequestError('The AI assistant is not configured.');
        await this.limitRate('ai_tutor', 60, 5, '{{user}}');
        const all = await KnowledgeModel.getMulti(domainId).limit(2000).toArray();
        if (all.length < 2) throw new BadRequestError('Add a few knowledge points first.');
        const byId = new Map(all.map((d) => [d._id.toHexString(), d]));
        const hasChild = new Set(all.filter((d) => d.parent).map((d) => d.parent!.toHexString()));
        const isTopic = (d: any) => hasChild.has(d._id.toHexString());
        const leaves = all.filter((d) => !isTopic(d));
        const mode = 'all' as const;
        const parentName = (d: any) => (d.parent && byId.get(d.parent.toHexString())?.name) || '';

        const tree = await KnowledgeModel.promptCatalog(domainId, { title: 'CURRENT CATALOG', budget: 12000, descriptions: true });
        const prompt = [
            'You re-organize a programming course\'s KNOWLEDGE-POINT CATALOG into a clear tree. The CURRENT CATALOG below shows every point with its present place (indented points sit under the topic above them). Some of it may already be good; some points may sit in the wrong place, some topics may be too broad, too narrow or redundant.',
            `Propose the BEST structure for the whole catalog: at most ${KNOWLEDGE_MAX_DEPTH - 2} levels of topics (TOPIC → optional SUB-TOPIC) with the points beneath. Rules: every LEAF point (a point with nothing under it) must be placed under exactly one topic or sub-topic; keep an existing topic name EXACTLY when you keep the topic (its description may stay empty); a NEW topic or sub-topic needs a one-sentence description; a topic that should no longer exist is simply not mentioned (its points go elsewhere); never rename a point, never invent points, never put a point in two places. Prefer 4-10 top-level topics of comparable size, named by what they teach (2-4 words, capitalize the first word).`,
            'Reply with ONLY JSON: {"topics": [{"name": string, "isNew": boolean, "description": string, "points": [string], "subtopics": [{"name": string, "isNew": boolean, "description": string, "points": [string]}]}], "unplaced": [string]}',
            '"points": exact names of leaf points placed DIRECTLY under this topic / sub-topic. "unplaced": leaf points that genuinely fit nowhere.',
            tree,
        ].join('\n\n');
        const raw = await aiTutor.callProvider('You are a careful curriculum designer. You reply with JSON only.', [{ role: 'user', content: prompt }], { temperature: 0.2 });
        let j: any;
        try {
            j = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
        } catch (e) {
            const m = raw.match(/\{[\s\S]*\}/);
            if (!m) throw new BadRequestError('The AI did not return a usable proposal. Please try again.');
            j = JSON.parse(m[0]);
        }

        // Validate: only placeable points may be placed (loose ones in
        // loose mode, any leaf in all mode), each at most once; names are
        // normalized; an "existing" topic must exist. Every placed point
        // carries where it comes FROM so the review shows the moves.
        const placeable = new Map(leaves.map((d) => [d.nameLower, d]));
        const known = new Map(all.map((d) => [d.nameLower, d]));
        const placed = new Set<string>();
        const takePoints = (list: any, topicLower: string) => {
            const out: { name: string, from: string, moves: boolean }[] = [];
            for (const raw2 of (Array.isArray(list) ? list : []).slice(0, 300)) {
                const key = KnowledgeModel.normalizeName(raw2).toLowerCase();
                const d = placeable.get(key);
                if (!d || placed.has(key) || key === topicLower) continue;
                placed.add(key);
                const from = parentName(d);
                out.push({ name: d.name, from, moves: from.toLowerCase() !== topicLower });
            }
            return out;
        };
        const topicOf = (t: any, parentLower: string) => {
            const tname = KnowledgeModel.normalizeName(t?.name);
            if (!tname) return null;
            const existing = known.get(tname.toLowerCase()) || null;
            return {
                name: existing ? existing.name : tname,
                id: existing ? existing._id.toHexString() : '',
                isNew: !existing,
                description: existing ? (existing.description || '') : String(t?.description || '').slice(0, 300),
                currentParent: existing ? parentName(existing) : '',
                movesTopic: !!existing && parentName(existing).toLowerCase() !== parentLower,
                points: takePoints(t?.points, tname.toLowerCase()),
                subtopics: [] as any[],
            };
        };
        const proposal: any[] = [];
        for (const t of (Array.isArray(j?.topics) ? j.topics : []).slice(0, 60)) {
            const top = topicOf(t, '');
            if (!top) continue;
            for (const st of (Array.isArray(t?.subtopics) ? t.subtopics : []).slice(0, 30)) {
                const sub = topicOf(st, top.name.toLowerCase());
                if (sub && (sub.points.length || !sub.isNew)) top.subtopics.push(sub);
            }
            if (top.points.length || top.subtopics.length) proposal.push(top);
        }
        // A LEAF the proposal promotes to a topic (kept, with something
        // beneath it) counts as placed and may not also appear as a point.
        const promoted = new Set<string>();
        for (const t of proposal) {
            for (const g of [t, ...t.subtopics]) if (g.id && placeable.has(g.name.toLowerCase())) promoted.add(g.name.toLowerCase());
        }
        for (const t of proposal) {
            for (const g of [t, ...t.subtopics]) g.points = g.points.filter((pt: any) => !promoted.has(pt.name.toLowerCase()));
            for (const n of promoted) placed.add(n);
        }
        const unplaced = [...placeable.values()].filter((d) => !placed.has(d.nameLower)).map((d) => d.name);
        this.response.body = {
            mode,
            proposal,
            unplaced,
            placeable: placeable.size,
            moves: proposal.reduce((n, t) => n + t.points.filter((p: any) => p.moves).length + t.subtopics.reduce((m: number, st: any) => m + st.points.filter((p: any) => p.moves).length, 0), 0),
        };
    }

    /**
     * Apply a (possibly edited) organize proposal: create the new topics
     * and sub-topics, move the points — and report the topics the moves
     * left EMPTY (no children, no tasks), so the page can offer to delete
     * them.
     */
    @param('proposal', Types.String)
    async postApplyOrganize({ domainId }, proposal: string) {
        this.checkCatalogEdit();
        let groups: any[];
        try {
            groups = JSON.parse(proposal);
        } catch (e) {
            throw new BadRequestError('Malformed proposal.');
        }
        if (!Array.isArray(groups)) throw new BadRequestError('Malformed proposal.');
        const before = await KnowledgeModel.getMulti(domainId).limit(2000).toArray();
        const wasTopic = new Set(before.filter((d) => d.parent).map((d) => d.parent!.toHexString()));
        let created = 0;
        let moved = 0;
        const errors: string[] = [];
        const ensureTopic = async (g: any, parent: any) => {
            const tname = KnowledgeModel.normalizeName(g?.name);
            if (!tname) return null;
            let topic = await KnowledgeModel.getByName(domainId, tname);
            if (!topic) {
                try {
                    topic = await KnowledgeModel.add(domainId, { name: tname, description: String(g.description || ''), source: 'ai', owner: this.user._id, parent: parent ? parent._id : null });
                    created += 1;
                } catch (e) {
                    errors.push(`${tname}: ${e.message}`);
                    return null;
                }
            } else if ((parent && !(topic.parent && topic.parent.equals(parent._id))) || (!parent && topic.parent)) {
                // An existing topic placed elsewhere in the proposal moves there.
                try {
                    topic = await KnowledgeModel.move(domainId, topic._id, parent ? parent._id : null);
                    moved += 1;
                } catch (e) {
                    errors.push(`${topic.name}: ${e.message}`);
                }
            }
            return topic;
        };
        const placeUnder = async (topic: any, names: any) => {
            for (const pname of (Array.isArray(names) ? names : []).slice(0, 300)) {
                const pt = await KnowledgeModel.getByName(domainId, String(typeof pname === 'object' ? pname?.name : pname));
                if (!pt || pt._id.equals(topic._id)) continue;
                if (pt.parent && pt.parent.equals(topic._id)) continue; // already there
                try {
                    await KnowledgeModel.move(domainId, pt._id, topic._id);
                    moved += 1;
                } catch (e) {
                    errors.push(`${pt.name}: ${e.message}`);
                }
            }
        };
        for (const g of groups.slice(0, 60)) {
            const topic = await ensureTopic(g, null);
            if (!topic) continue;
            await placeUnder(topic, g.points);
            for (const sg of (Array.isArray(g.subtopics) ? g.subtopics : []).slice(0, 30)) {
                const sub = await ensureTopic(sg, topic);
                if (sub) await placeUnder(sub, sg.points);
            }
        }
        // Topics that held points before and hold nothing now — and label
        // no task themselves — are leftovers of the re-organization.
        const after = await KnowledgeModel.getMulti(domainId).limit(2000).toArray();
        const stillTopic = new Set(after.filter((d) => d.parent).map((d) => d.parent!.toHexString()));
        const usage = await KnowledgeModel.tagUsage(domainId, this.visible);
        const usageLower = new Map<string, number>();
        for (const [tag, n] of usage) usageLower.set(tag.toLowerCase(), (usageLower.get(tag.toLowerCase()) || 0) + n);
        const emptied = after
            .filter((d) => wasTopic.has(d._id.toHexString()) && !stillTopic.has(d._id.toHexString()) && !(usageLower.get(d.nameLower) || 0))
            .map((d) => ({ id: d._id.toHexString(), name: d.name }));
        this.response.body = { created, moved, errors: errors.slice(0, 20), emptied };
    }

    /** Fold one point into another: tasks move over, the old name becomes an alias. */
    @param('id', Types.ObjectId)
    @param('into', Types.ObjectId)
    async postMerge({ domainId }, id: ObjectId, into: ObjectId) {
        this.checkProblemEdit();
        try {
            const { target, touched } = await KnowledgeModel.merge(domainId, id, into);
            const pdocs = await KnowledgeModel.problemsWith(domainId, target.name, 500, this.visible);
            this.response.body = { point: viewOf(target, pdocs.length), touched };
        } catch (e) {
            throw new BadRequestError(e.message);
        }
    }

    @param('id', Types.ObjectId)
    async postDelete({ domainId }, id: ObjectId) {
        this.checkProblemEdit();
        const doc = await KnowledgeModel.get(domainId, id);
        if (!doc) throw new NotFoundError(id);
        const { touched } = await KnowledgeModel.del(domainId, id);
        this.response.body = { ok: 1, touched };
    }

    /** Label a task (any kind) with a point — by id, or by name, creating the name if new. */
    @param('pid', Types.ProblemId)
    @param('id', Types.ObjectId, true)
    @param('name', Types.String, true)
    async postAttach({ domainId }, pid: number | string, id?: ObjectId, name?: string) {
        this.checkProblemEdit();
        const pdoc = await problem.get(domainId, pid, ['docId', 'pid', 'title', 'tag'] as any);
        if (!pdoc) throw new NotFoundError(pid);
        let canonical: string | null = null;
        if (id) canonical = (await KnowledgeModel.get(domainId, id))?.name || null;
        else if (name) [canonical] = await KnowledgeModel.ensure(domainId, [{ name }], { source: 'teacher', owner: this.user._id });
        if (!canonical) throw new NotFoundError(id || name);
        const tags = await KnowledgeModel.attach(domainId, pdoc.docId, canonical);
        this.response.body = { docId: pdoc.docId, pid: pdoc.pid || String(pdoc.docId), title: pdoc.title, name: canonical, tags };
    }

    @param('pid', Types.ProblemId)
    @param('id', Types.ObjectId)
    async postDetach({ domainId }, pid: number | string, id: ObjectId) {
        this.checkProblemEdit();
        const doc = await KnowledgeModel.get(domainId, id);
        if (!doc) throw new NotFoundError(id);
        const pdoc = await problem.get(domainId, pid, ['docId', 'tag'] as any);
        if (!pdoc) throw new NotFoundError(pid);
        const tags = await KnowledgeModel.detach(domainId, pdoc.docId, doc.name);
        this.response.body = { docId: pdoc.docId, tags };
    }

    /** Drop a tag from every task (and any catalog entry of that name) — for leftovers like `ai-draft`. */
    @param('name', Types.String)
    async postRemoveTag({ domainId }, name: string) {
        this.checkProblemEdit();
        const clean = String(name || '').trim();
        if (!clean) throw new BadRequestError('Nothing to remove.');
        const res = await KnowledgeModel.removeTag(domainId, clean);
        this.response.body = { ok: 1, ...res };
    }

    /** Register existing tags (comma / newline separated) as catalog entries. */
    @param('names', Types.String)
    async postImport({ domainId }, names: string) {
        this.checkCatalogEdit();
        const list = String(names || '').split(/[\n,;，；]/).map((x) => x.trim()).filter((x) => x).slice(0, 200);
        if (!list.length) throw new BadRequestError('Nothing to import.');
        const created = await KnowledgeModel.ensure(domainId, list.map((name) => ({ name })), { source: 'import', owner: this.user._id });
        this.response.body = { imported: created };
    }
}

/* ------------------------------------------------------------------ */
/*  🗺 Personal knowledge map                                          */
/* ------------------------------------------------------------------ */

/**
 * How long a stored map is served without recomputing. Short enough that a
 * student who just solved something sees it move, long enough that opening
 * the page twice does not pay for the derivation twice.
 */
const MAP_TTL_MS = 20 * 60 * 1000;

/** Students the class rebuild will derive in ONE request — see postRebuild. */
const CLASS_REBUILD_BATCH = 25;
/** Upper bound on a class roster we will even list. */
const CLASS_ROSTER_MAX = 400;

/**
 * 🗺 ONE STUDENT'S MAP — their own by default.
 *
 * Course staff may pass ?uid= to read a student's map (the class view links
 * here). Students can only ever reach their own: the map is derived from
 * their submissions and tutor dialogue, which this fork deliberately keeps
 * private (PERM_VIEW_RECORD is not in the default role — see
 * packages/common/permission.ts).
 */
class KnowledgeMapHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_VIEW_PROBLEM);
        this.response.addHeader('Vary', 'Accept');
        this.response.addHeader('Cache-Control', 'no-store, must-revalidate');
    }

    /**
     * Course staff — the fork's ONE definition, shared with the problem set
     * (handler/problem.ts seesEveryProblem).
     *
     * This used to be a local list of three permissions, which disagreed
     * with that predicate in domains configured differently from the
     * default: a domain root, or a teacher holding PERM_EDIT_PROBLEM but
     * not PERM_CREATE_PROBLEM, saw every activity task in the problem set
     * yet was refused a student's map. One predicate, one answer, in every
     * domain.
     */
    get isStaff() {
        return seesEveryProblem(this);
    }

    @param('uid', Types.Int, true)
    @param('refresh', Types.Boolean, true)
    @param('brief', Types.Boolean, true)
    async get({ domainId }, uid = 0, refresh = false, brief = false) {
        /*
         * 🎯 BRIEF MODE — the problem set's "Practise next" panel.
         *
         * Reads the CACHED map only and never derives one. The problem list
         * is the most-visited page on the site; a miss here must cost one
         * indexed lookup, not a full derivation (which may call the model).
         * With no map yet the panel simply invites the student to build one.
         */
        if (brief) {
            const doc = await getMap(domainId, this.user._id);
            let next = (doc?.next || []).slice(0, 4);
            /*
             * The panel serves the CACHED map and never derives one, so
             * after a submission it can still be carrying a task the student
             * has just solved. Rather than rebuild on the site's hottest
             * page, drop anything already solved using current problem
             * status — one indexed lookup over at most ~16 pids, which is
             * cheap enough here and keeps the panel from ever recommending
             * something the student has finished.
             */
            const pids = [...new Set(next.flatMap((n) => (n.tasks || []).map((t) => t.docId)))];
            if (pids.length) {
                const psdocs = await problem.getMultiStatus(domainId, { uid: this.user._id, docId: { $in: pids } })
                    .project({ docId: 1, status: 1 }).toArray();
                const solved = new Set(psdocs
                    .filter((p: any) => p.status === STATUS.STATUS_ACCEPTED)
                    .map((p: any) => p.docId));
                if (solved.size) {
                    next = next
                        .map((n) => ({ ...n, tasks: (n.tasks || []).filter((t) => !solved.has(t.docId)) }))
                        // A point whose every suggested task is solved is no
                        // longer actionable advice, so it goes too.
                        .filter((n) => n.tasks.length);
                }
            }
            this.response.body = {
                built: !!doc,
                stale: mapStale(doc, MAP_TTL_MS),
                computedAt: doc?.computedAt,
                next,
            };
            return;
        }
        const target = uid && uid !== this.user._id ? uid : this.user._id;
        if (target !== this.user._id && !this.isStaff) throw new ForbiddenError('You may only view your own knowledge map.');
        let doc = await getMap(domainId, target);
        /*
         * Rebuild when stale, when asked, or when the stored map is PARTIAL
         * — a cheap background build after a submission (lib/knowledge_map
         * scheduleMastery) skips attribution and stamps a fresh timestamp,
         * so freshness alone would let those maps sit un-attributed forever.
         * Rebuilding is the expensive path, so it stays rate-limited.
         */
        if (refresh || mapStale(doc, MAP_TTL_MS)) {
            await this.limitRate('knowledge_map', 60, 6, '{{user}}');
            const fresh = await computeMastery(domainId, target);
            await saveMap(fresh);
            doc = { ...fresh, _id: doc?._id } as any;
        }
        const udoc = await user.getById(domainId, target);
        this.response.template = 'knowledge_map.html';
        this.response.body = {
            uid: target,
            self: target === this.user._id,
            isStaff: this.isStaff,
            uname: udoc?.uname || `user#${target}`,
            map: doc,
        };
    }
}

/**
 * 🗺 CLASS VIEW — the same states, for a whole roster.
 *
 * Reads CACHED maps only. Deriving a map may call the model, and a 200-seat
 * course would otherwise fire thousands of provider requests from one page
 * load; students whose map has never been built simply show as "not built"
 * and the teacher rebuilds them in batches with the button.
 *
 * Roster: the participants of ?tid= (a contest, homework or self-learning
 * session) when given, otherwise the domain's members.
 */
class KnowledgeMapClassHandler extends Handler {
    async prepare() {
        // Same staff test as the per-student view and the problem set, so a
        // teacher who can open one student's map can open the class board.
        if (!seesEveryProblem(this)) throw new ForbiddenError('Course staff only.');
        this.response.addHeader('Vary', 'Accept');
        this.response.addHeader('Cache-Control', 'no-store, must-revalidate');
    }

    async roster(domainId: string): Promise<number[]> {
        const dudocs = await domain.getMultiUserInDomain(domainId, { uid: { $gt: 1 } })
            .project({ uid: 1 }).limit(CLASS_ROSTER_MAX).toArray();
        return [...new Set(dudocs.map((d: any) => d.uid).filter((u: any) => typeof u === 'number'))];
    }

    async get({ domainId }) {
        const uids = await this.roster(domainId);
        const [maps, udict] = await Promise.all([
            getMapsIn(domainId, uids),
            user.getListForRender(domainId, uids),
        ]);
        /*
         * Class aggregate: for each point, how many students are in each
         * state. This is the teacher's actual question — "what does the
         * CLASS not get" — and it is a straight tally of already-derived
         * per-student states, so it costs one pass over the cached maps.
         */
        const agg = new Map<string, { name: string, path: string[], shaky: number, resolving: number, mastered: number, exposed: number, covered: number }>();
        for (const m of maps.values()) {
            for (const p of m.points) {
                if (p.state === 'untouched') continue;
                if (!agg.has(p.name)) agg.set(p.name, { name: p.name, path: p.path, shaky: 0, resolving: 0, mastered: 0, exposed: 0, covered: 0 });
                const e = agg.get(p.name)!;
                e.covered += 1;
                (e as any)[p.state] += 1;
            }
        }
        const points = [...agg.values()]
            .map((e) => ({ ...e, weakRate: e.covered ? Math.round((e.shaky / e.covered) * 100) : 0 }))
            .sort((a, b) => b.shaky - a.shaky || b.weakRate - a.weakRate)
            .slice(0, 60);
        this.response.template = 'knowledge_map_class.html';
        this.response.body = {
            students: uids.map((uid) => {
                const m = maps.get(uid);
                return {
                    uid,
                    uname: udict[uid]?.uname || `user#${uid}`,
                    built: !!m,
                    computedAt: m?.computedAt,
                    stats: m?.stats || null,
                    top: (m?.next || []).slice(0, 3).map((n) => n.name),
                };
            }),
            points,
            built: maps.size,
            total: uids.length,
        };
    }

    /**
     * Build the maps that do not exist yet, CLASS_REBUILD_BATCH at a time.
     *
     * Deliberately synchronous and bounded rather than a background job:
     * the teacher gets an exact "built N, M remaining" answer and presses
     * again, which needs no job document, no progress polling and no stale
     * -job recovery. Sequential on purpose — parallel derivation would
     * multiply provider load by the batch size.
     */
    async postRebuild({ domainId }) {
        await this.limitRate('knowledge_map_class', 60, 3, '{{user}}');
        const uids = await this.roster(domainId);
        const have = await getMapsIn(domainId, uids);
        const todo = uids.filter((u) => !mapFresh(have.get(u) || null, MAP_TTL_MS)).slice(0, CLASS_REBUILD_BATCH);
        let built = 0;
        for (const uid of todo) {
            try {
                /*
                 * `noLlm` is what keeps this button honest. Attribution is
                 * capped per student, not per request, so a batch of 25
                 * could fire hundreds of provider calls in one sequential
                 * HTTP request — expensive, and slow enough to time out
                 * before the teacher saw anything.
                 *
                 * The class board reads STATES, and states come from the
                 * record aggregation and the tutor evidence, none of which
                 * needs the model. The maps are stamped `partial`, so the
                 * moment the teacher clicks into a student — or the student
                 * opens their own map — the full build with attribution
                 * happens there, for one person, where it is worth paying.
                 */
                // eslint-disable-next-line no-await-in-loop
                const fresh = await computeMastery(domainId, uid, { noLlm: true });
                // eslint-disable-next-line no-await-in-loop
                await saveMap(fresh);
                built += 1;
            } catch (e: any) {
                logger.warn('class map build failed for uid=%d: %s', uid, e.message);
            }
        }
        const remaining = uids.filter((u) => !have.has(u)).length - built;
        this.response.body = { built, remaining: Math.max(0, remaining), total: uids.length };
    }
}

/* ------------------------------------------------------------------ */
/*  🤖 The student assistant                                           */
/* ------------------------------------------------------------------ */

/**
 * JSON endpoint behind the chat panel that lives on every page
 * (pages/assistant.page.js). No template: the panel is script-rendered.
 *
 *   GET  ?name=&pid=&tid=     → posture for that page + thread + profile
 *   POST operation=message    → one turn (page context travels with it)
 *   POST operation=prefs      → declared preferences / delete a learned fact
 *   POST operation=reset      → clear the conversation
 *
 * No generic post() here on purpose: the framework runs `post` before
 * `post<Operation>`, and a generic one would fire on every operation.
 */
class AssistantHandler extends Handler {
    async prepare() {
        this.response.addHeader('Vary', 'Accept');
        this.response.addHeader('Cache-Control', 'no-store, must-revalidate');
    }

    private pageOf(name = '', pid = 0, tid = '') {
        return { name: String(name || '').slice(0, 60), pid: pid || undefined, tid: tid && /^[0-9a-f]{24}$/i.test(tid) ? tid : undefined };
    }

    @param('name', Types.String, true)
    @param('pid', Types.Int, true)
    @param('tid', Types.String, true)
    async get({ domainId }, name = '', pid = 0, tid = '') {
        const page = this.pageOf(name, pid, tid);
        const posture = await postureOf(domainId, this.user._id, page);
        const [thread, profile] = await Promise.all([getThread(domainId, this.user._id), getProfile(domainId, this.user._id)]);
        const day = new Date().toISOString().slice(0, 10);
        this.response.body = {
            enabled: assistantEnabled(),
            ...posture,
            messages: (thread?.messages || []).slice(-40),
            profile: { declared: profile.declared || {}, goals: profile.goals || [], learned: profile.learned || [] },
            turnsToday: thread?.turns?.[day] || 0,
            turnsCap: +system.get('assistant.daily_turns') || 60,
        };
    }

    @param('text', Types.Content)
    @param('name', Types.String, true)
    @param('pid', Types.Int, true)
    @param('tid', Types.String, true)
    async postMessage({ domainId }, text: string, name = '', pid = 0, tid = '') {
        if (!text.trim()) throw new BadRequestError('Say something first.');
        await this.limitRate('assistant', 60, 12, '{{user}}');
        const res = await runTurn(domainId, this.user._id, this.pageOf(name, pid, tid), text.trim());
        this.response.body = res;
    }

    @param('style', Types.String, true)
    @param('length', Types.String, true)
    @param('tone', Types.String, true)
    @param('forget', Types.Int, true)
    async postPrefs({ domainId }, style = '', length = '', tone = '', forget = -1) {
        const prof = await getProfile(domainId, this.user._id);
        const d: any = { ...(prof.declared || {}) };
        if (['examples', 'theory', ''].includes(style)) { if (style) d.style = style; else delete d.style; }
        if (['short', 'thorough', ''].includes(length)) { if (length) d.length = length; else delete d.length; }
        if (['encouraging', 'direct', ''].includes(tone)) { if (tone) d.tone = tone; else delete d.tone; }
        const patch: any = { declared: d };
        if (forget >= 0) patch.learned = (prof.learned || []).filter((_, i) => i !== forget);
        await saveProfile(domainId, this.user._id, patch);
        this.response.body = { ok: true, profile: { ...patch, goals: prof.goals || [], learned: patch.learned || prof.learned || [] } };
    }

    async postReset({ domainId }) {
        await resetThread(domainId, this.user._id);
        this.response.body = { ok: true };
    }
}

const TPL_SHELL = `{% extends "layout/basic.html" %}
{% block content %}
<div class="row">
  <div class="medium-12 columns" id="kp-root">
    <div class="section"><div class="section__body">{{ _('Loading...') }}</div></div>
  </div>
</div>
{% endblock %}
`;

/** The map pages render entirely from their JSON twin, like the catalog above. */
const TPL_MAP = `{% extends "layout/basic.html" %}
{% block content %}
<div class="row">
  <div class="medium-12 columns" id="km-root" data-mode="student">
    <div class="section"><div class="section__body">{{ _('Loading...') }}</div></div>
  </div>
</div>
{% endblock %}
`;

const TPL_MAP_CLASS = `{% extends "layout/basic.html" %}
{% block content %}
<div class="row">
  <div class="medium-12 columns" id="km-root" data-mode="class">
    <div class="section"><div class="section__body">{{ _('Loading...') }}</div></div>
  </div>
</div>
{% endblock %}
`;

export async function apply(ctx: Context) {
    (ctx as any).inject(['template'], (c: any) => {
        c.template.registry['knowledge_points.html'] = TPL_SHELL;
        c.template.registry['knowledge_map.html'] = TPL_MAP;
        c.template.registry['knowledge_map_class.html'] = TPL_MAP_CLASS;
    });
    /*
     * ⏱ Every judged programming submission refreshes that student's map in
     * the background — accepted or not, since a failure is evidence too (it
     * is most of what `shaky` is built from).
     *
     * Hooked on `record/judge` rather than on submission: the map's outcome
     * evidence is solved / first-try / still-unsolved, none of which exists
     * until the judge has finished. postJudge already returns early for
     * pretest and generate records, so this only ever sees real attempts.
     * The event is dispatched in-process by the worker that handled the
     * judge callback, so it fires once — no instance guard, which would in
     * fact be wrong here since the callback can land on any worker.
     *
     * The call is debounced and never awaited: nothing about judging should
     * wait on, or fail because of, a knowledge map.
     */
    ctx.on('record/judge', async (rdoc: any, _updated: any, pdoc: any) => {
        try {
            if (!rdoc?.domainId || !rdoc.uid || rdoc.uid <= 1) return;
            // Code tasks only, by the pid prefix the whole fork keys off
            // (P programming / F function / O objective / S subjective).
            // Other kinds still reach the map — they are picked up by the
            // next rebuild.
            const pid = String(pdoc?.pid || '');
            if (pid && !/^[pf]/i.test(pid)) return;
            /*
             * Two steps, and the ORDER of importance is the reverse of the
             * order of cost. Marking the map dirty is what makes the next
             * page load correct — without it a student who solves a
             * recommended task and opens the map two seconds later is still
             * inside the 20-minute freshness window and gets served the old
             * map with that task still in "Practise next". The debounced
             * rebuild then does the real work for the student who does NOT
             * come to look.
             */
            markDirty(rdoc.domainId, rdoc.uid)
                .catch((e: any) => logger.warn('[knowledge-map] markDirty failed: %s', e.message));
            scheduleMastery(rdoc.domainId, rdoc.uid);
        } catch (e: any) {
            logger.warn('[knowledge-map] could not schedule rebuild: %s', e.message);
        }
    });
    ctx.on('dispose', () => cancelScheduledMastery());
    // Route-level gate is the JSON reader's; prepare() raises it for the page.
    ctx.Route('knowledge_points', '/knowledge-points', KnowledgePointsHandler, PERM.PERM_VIEW_PROBLEM);
    // Fixed segment BEFORE the bare route so neither can swallow the other
    // (the /ai-studio/:id lesson in this file's header).
    ctx.Route('knowledge_map_class', '/knowledge-map/class', KnowledgeMapClassHandler, PERM.PERM_VIEW_PROBLEM);
    ctx.Route('knowledge_map', '/knowledge-map', KnowledgeMapHandler, PRIV.PRIV_USER_PROFILE);
    // 🤖 The assistant is personal: signed-in users only.
    ctx.Route('assistant', '/assistant', AssistantHandler, PRIV.PRIV_USER_PROFILE);
}
