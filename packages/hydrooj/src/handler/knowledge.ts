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
import { BadRequestError, NotFoundError } from '../error';
import { PERM } from '../model/builtin';
import KnowledgeModel from '../model/knowledge';
import problem from '../model/problem';
import { Handler, param, Types } from '../service/server';

/** Site convention: the pid prefix marks the task kind. */
function kindOfPid(pid: any): 'programming' | 'objective' | 'subjective' {
    const p = String(pid || '');
    if (/^o/i.test(p)) return 'objective';
    if (/^s/i.test(p)) return 'subjective';
    return 'programming';
}

/** Client shape of a catalog entry (usage count folded in). */
function viewOf(doc: any, count = 0) {
    return {
        _id: doc._id,
        name: doc.name,
        description: doc.description || '',
        aliases: doc.aliases || [],
        category: doc.category || '',
        source: doc.source || 'teacher',
        owner: doc.owner || 0,
        updateAt: doc.updateAt,
        count,
    };
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
        const body: any = {
            q,
            points: points.map((p) => viewOf(p, usageLower.get(p.nameLower) || 0)),
            total: await KnowledgeModel.count(domainId),
            untracked,
            canEditProblems: this.user.hasPerm(PERM.PERM_EDIT_PROBLEM),
        };
        if (id) {
            const doc = await KnowledgeModel.get(domainId, id);
            if (!doc) throw new NotFoundError(id);
            const pdocs = await KnowledgeModel.problemsWith(domainId, doc.name, 500, this.visible);
            body.point = viewOf(doc, pdocs.length);
            body.problems = pdocs.map((p) => ({
                docId: p.docId, pid: p.pid || String(p.docId), title: p.title, hidden: !!p.hidden, kind: kindOfPid(p.pid),
            }));
        }
        this.response.template = 'knowledge_points.html';
        this.response.body = body;
    }

    @param('name', Types.String)
    @param('description', Types.String, true)
    @param('aliases', Types.String, true)
    @param('category', Types.String, true)
    async postCreate({ domainId }, name: string, description = '', aliases = '', category = '') {
        this.checkCatalogEdit();
        let doc;
        try {
            doc = await KnowledgeModel.add(domainId, {
                name, description, aliases, category, source: 'teacher', owner: this.user._id,
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
    @param('category', Types.String, true)
    async postUpdate({ domainId }, id: ObjectId, name?: string, description?: string, aliases?: string, category?: string) {
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
                ...(category !== undefined ? { category } : {}),
            });
        } catch (e) {
            if (e instanceof Error && !(e as any).code) throw new BadRequestError(e.message);
            throw e;
        }
        const fresh = await KnowledgeModel.get(domainId, id);
        const pdocs = await KnowledgeModel.problemsWith(domainId, fresh!.name, 500, this.visible);
        this.response.body = { point: viewOf(fresh, pdocs.length), touched };
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

const TPL_SHELL = `{% extends "layout/basic.html" %}
{% block content %}
<div class="row">
  <div class="medium-12 columns" id="kp-root">
    <div class="section"><div class="section__body">{{ _('Loading...') }}</div></div>
  </div>
</div>
{% endblock %}
`;

export async function apply(ctx: Context) {
    (ctx as any).inject(['template'], (c: any) => {
        c.template.registry['knowledge_points.html'] = TPL_SHELL;
    });
    // Route-level gate is the JSON reader's; prepare() raises it for the page.
    ctx.Route('knowledge_points', '/knowledge-points', KnowledgePointsHandler, PERM.PERM_VIEW_PROBLEM);
}
