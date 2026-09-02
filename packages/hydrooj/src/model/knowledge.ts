import { escapeRegExp } from 'lodash';
import { ObjectId } from 'mongodb';
import type { ProblemDoc } from '../interface';
import db from '../service/db';
import * as document from './document';
import problem from './problem';

/*
 * PTA fork: the DOMAIN KNOWLEDGE-POINT CATALOG.
 *
 * Every domain (course) keeps one shared vocabulary of knowledge points —
 * the detailed skills, techniques and pitfalls its programming tasks
 * exercise ("Off-by-one in loop bounds", "Prefix-sum array for range
 * sums"). The AI Studio labels tasks against this catalog (reusing entries,
 * adding new ones when a task needs something the catalog lacks) and the
 * teacher curates it: add, rename, describe, merge, delete, search, and
 * attach / detach points on any programming task of the domain.
 *
 * TAGS AND KNOWLEDGE POINTS ARE ONE CONCEPT. A task's tags (pdoc.tag) are
 * its knowledge points, whatever its kind: the problem edit page picks them
 * from this catalog (registering anything new), the AI Studio labels
 * programming tasks against it, and every surface that used to say "tags"
 * — the problem set, the picker, the problem page — now shows knowledge
 * points. There is no second membership table: the catalog is the
 * authority for SPELLING (canonical names, aliases, descriptions), the
 * tags are the authority for MEMBERSHIP. Renaming or deleting a point
 * therefore rewrites the tags of every task that carries it, of any kind.
 *
 * THE CATALOG IS A TREE. A point may sit under a parent point — topic →
 * subtopic → point → detail, four levels at most — and membership rolls
 * UP: a task tagged "For loop reading n values" is, for every filter,
 * count and AI target, also a task under "Loops" and under "Control flow".
 * Tasks themselves keep carrying only their most specific points; the
 * tree lives on the catalog documents (parent / ancestors / path), and
 * the model keeps those three in step on every add, move, rename, merge
 * and delete.
 */

export interface KnowledgePointDoc {
    _id: ObjectId;
    domainId: string;
    /** Canonical label, unique per domain (case-insensitive); the tag written on tasks. */
    name: string;
    nameLower: string;
    /** One or two sentences: what the skill is and how to recognise a task that needs it. */
    description: string;
    /** Alternative spellings the AI (or a teacher) may use; resolved to `name`. */
    aliases: string[];
    aliasesLower: string[];
    /**
     * RETIRED — the free-text grouping the tree replaced. Kept only so old
     * documents deserialize; migrateCategories() turns each category into
     * a top-level node and clears this field.
     */
    category?: string;
    /**
     * 🌳 THE TREE. A point may sit under another point (its parent); the
     * parent under another; up to KNOWLEDGE_MAX_DEPTH levels. Tasks keep
     * carrying their most specific points as tags — membership rolls UP:
     * filtering by, counting, or targeting a parent covers every point
     * beneath it. Names stay unique per domain (a tag must resolve to one
     * node), so a topic and a point never share a name.
     */
    parent: ObjectId | null;
    /** Ancestor ids, root first — the query key for "everything under X". Maintained by the model. */
    ancestors: ObjectId[];
    /** Ancestor NAMES, root first — for display ("Control flow › Loops"). Maintained by the model. */
    path: string[];
    /** 0 = top level. */
    depth: number;
    source: 'ai' | 'teacher' | 'import';
    owner: number;
    createdAt: Date;
    updateAt: Date;
}

declare module '../service/db' {
    interface Collections {
        'knowledge.point': KnowledgePointDoc;
    }
}

export const coll = db.collection('knowledge.point');

export const KNOWLEDGE_NAME_MAX = 40;
export const KNOWLEDGE_DESC_MAX = 400;
export const KNOWLEDGE_ALIAS_MAX = 12;
/** Topic → subtopic → point → detail is as deep as a course vocabulary sensibly goes. */
export const KNOWLEDGE_MAX_DEPTH = 4;
export const PATH_SEP = ' › ';

/** A tree node as the pages consume it (see KnowledgeModel.tree). */
export interface KnowledgeTreeNode {
    id: string;
    name: string;
    description: string;
    depth: number;
    path: string[];
    /** Tasks carrying THIS point (from tagUsage). */
    count: number;
    /** Distinct tasks carrying this point or any descendant. */
    rollup: number;
    children: KnowledgeTreeNode[];
}
/** Tasks scanned per propagation / usage query; a course has hundreds, not millions. */
const SCAN_LIMIT = 5000;

function uniqCaseInsensitive(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list) {
        const v = String(raw || '').trim();
        const k = v.toLowerCase();
        if (!v || seen.has(k)) continue;
        seen.add(k);
        out.push(v);
    }
    return out;
}

export class KnowledgeModel {
    /** The raw knowledge-point collection (read-only external use). */
    static coll = coll;

    /**
     * Collapse whitespace, drop trailing punctuation, cap the length. Commas
     * become spaces: the problem set's tags= filter is comma-separated, so
     * a name containing one could never be filtered on.
     */
    static normalizeName(raw: any): string {
        return String(raw ?? '')
            .replace(/[,，]/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/[.;:,\s]+$/g, '')
            .trim()
            .slice(0, KNOWLEDGE_NAME_MAX)
            .trim();
    }

    static normalizeAliases(raw: any, exceptLower?: string): string[] {
        const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,\n;，；]/);
        return uniqCaseInsensitive(list.map((a) => KnowledgeModel.normalizeName(a)))
            .filter((a) => a.toLowerCase() !== exceptLower)
            .slice(0, KNOWLEDGE_ALIAS_MAX);
    }

    /**
     * The tasks a user may see (mirrors handler/problem.ts buildQuery):
     * everything for PERM_VIEW_PROBLEM_HIDDEN holders, otherwise public
     * tasks plus the user's own. Use as `match` for tagUsage / problemsWith.
     */
    static visibilityFilter(udoc: { _id: number, hasPerm: (p: bigint) => boolean }, viewHiddenPerm: bigint): any {
        if (udoc.hasPerm(viewHiddenPerm)) return {};
        return { $or: [{ hidden: false }, { owner: udoc._id }, { maintainer: udoc._id }] };
    }

    static get(domainId: string, id: ObjectId) {
        return coll.findOne({ _id: id, domainId });
    }

    /** A parent given as an id, an id string, or a name (or alias) — null for top level. */
    static async resolveParent(domainId: string, parent: any): Promise<KnowledgePointDoc | null> {
        if (parent === undefined || parent === null || parent === '') return null;
        if (parent instanceof ObjectId) return await KnowledgeModel.get(domainId, parent);
        const str = String(parent).trim();
        if (!str) return null;
        if (ObjectId.isValid(str) && str.length === 24) {
            const byId = await KnowledgeModel.get(domainId, new ObjectId(str));
            if (byId) return byId;
        }
        return await KnowledgeModel.getByName(domainId, str);
    }

    /** The display path of a point: its ancestors and itself, joined. */
    static describe(doc: Pick<KnowledgePointDoc, 'name' | 'path'>): string {
        return [...(doc.path || []), doc.name].join(PATH_SEP);
    }

    /** Direct children, by name. */
    static children(domainId: string, id: ObjectId | null) {
        return coll.find({ domainId, parent: id }).sort({ nameLower: 1 });
    }

    /** Every point beneath `id`, any depth. */
    static descendants(domainId: string, id: ObjectId) {
        return coll.find({ domainId, ancestors: id }).sort({ depth: 1, nameLower: 1 });
    }

    /**
     * The tag names a filter on `name` should match: the point itself and,
     * when it is a topic, every point beneath it. Unknown names pass
     * through unchanged (a tag with no catalog entry still filters).
     */
    static async expandTags(domainId: string, names: string[]): Promise<Map<string, string[]>> {
        const out = new Map<string, string[]>();
        for (const raw of names) {
            const doc = await KnowledgeModel.getByName(domainId, raw);
            if (!doc) {
                out.set(raw, [raw]);
                continue;
            }
            const below = await KnowledgeModel.descendants(domainId, doc._id).project<{ name: string }>({ name: 1 }).toArray();
            out.set(raw, [doc.name, ...below.map((d) => d.name)]);
        }
        return out;
    }

    /** Exact (case-insensitive) match on the canonical name or any alias. */
    static getByName(domainId: string, name: string) {
        const lower = KnowledgeModel.normalizeName(name).toLowerCase();
        if (!lower) return Promise.resolve(null);
        return coll.findOne({ domainId, $or: [{ nameLower: lower }, { aliasesLower: lower }] });
    }

    /** The canonical name for `name` if the catalog knows it (by name or alias), else null. */
    static async resolve(domainId: string, name: string): Promise<string | null> {
        const doc = await KnowledgeModel.getByName(domainId, name);
        return doc ? doc.name : null;
    }

    static getMulti(domainId: string, query: any = {}) {
        return coll.find({ domainId, ...query }).sort({ nameLower: 1 });
    }

    /** Text search over name, aliases and description (prefix-anchored for one-letter queries). */
    static async list(domainId: string, q = '', limit = 500): Promise<KnowledgePointDoc[]> {
        const query: any = {};
        const needle = String(q || '').trim();
        if (needle) {
            const re = new RegExp(needle.length >= 2 ? escapeRegExp(needle) : `^${escapeRegExp(needle)}`, 'i');
            query.$or = [{ name: re }, { aliases: re }, { description: re }, { category: re }];
        }
        return await KnowledgeModel.getMulti(domainId, query).limit(Math.max(1, Math.min(limit, 2000))).toArray();
    }

    static count(domainId: string) {
        return coll.countDocuments({ domainId });
    }

    static async add(domainId: string, data: {
        name: string, description?: string, aliases?: string[] | string,
        /** Parent by id or name; absent / empty = top level. `category` is the retired spelling of the same thing. */
        parent?: ObjectId | string | null, category?: string,
        source?: KnowledgePointDoc['source'], owner?: number,
    }): Promise<KnowledgePointDoc> {
        const name = KnowledgeModel.normalizeName(data.name);
        if (!name) throw new Error('A knowledge point needs a name.');
        const nameLower = name.toLowerCase();
        const existing = await KnowledgeModel.getByName(domainId, name);
        if (existing) throw new Error(`Knowledge point "${existing.name}" already exists${existing.nameLower !== nameLower ? ` (as an alias of it)` : ''}.`);
        const parentDoc = await KnowledgeModel.resolveParent(domainId, data.parent ?? data.category ?? null);
        if ((data.parent || data.category) && !parentDoc && data.parent instanceof ObjectId) throw new Error('Parent knowledge point not found.');
        if (parentDoc && parentDoc.depth + 1 >= KNOWLEDGE_MAX_DEPTH) throw new Error(`"${parentDoc.name}" is already ${KNOWLEDGE_MAX_DEPTH} levels deep; the tree stops there.`);
        const now = new Date();
        const aliases = KnowledgeModel.normalizeAliases(data.aliases || [], nameLower);
        const doc: KnowledgePointDoc = {
            _id: new ObjectId(),
            domainId,
            name,
            nameLower,
            description: String(data.description || '').trim().slice(0, KNOWLEDGE_DESC_MAX),
            aliases,
            aliasesLower: aliases.map((a) => a.toLowerCase()),
            parent: parentDoc ? parentDoc._id : null,
            ancestors: parentDoc ? [...(parentDoc.ancestors || []), parentDoc._id] : [],
            path: parentDoc ? [...(parentDoc.path || []), parentDoc.name] : [],
            depth: parentDoc ? (parentDoc.depth || 0) + 1 : 0,
            source: data.source || 'teacher',
            owner: data.owner || 0,
            createdAt: now,
            updateAt: now,
        };
        await coll.insertOne(doc);
        return doc;
    }

    /**
     * Re-parent a point (and, with it, everything beneath it). Refuses a
     * cycle — a point cannot move under itself or under its own descendant
     * — and the depth cap. Rewrites `ancestors` / `path` / `depth` of the
     * whole subtree.
     */
    static async move(domainId: string, id: ObjectId, parent: ObjectId | string | null): Promise<KnowledgePointDoc> {
        const doc = await KnowledgeModel.get(domainId, id);
        if (!doc) throw new Error('Knowledge point not found.');
        const parentDoc = await KnowledgeModel.resolveParent(domainId, parent);
        if (parent !== null && parent !== '' && parent !== undefined && !parentDoc) throw new Error('Parent knowledge point not found.');
        if (parentDoc) {
            if (parentDoc._id.equals(id)) throw new Error('A knowledge point cannot be its own parent.');
            if ((parentDoc.ancestors || []).some((a) => a.equals(id))) throw new Error(`"${parentDoc.name}" is beneath "${doc.name}" — move it out first.`);
        }
        const subtree = await KnowledgeModel.descendants(domainId, id).toArray();
        const deepest = subtree.reduce((m, d) => Math.max(m, d.depth - doc.depth), 0);
        const newDepth = parentDoc ? parentDoc.depth + 1 : 0;
        if (newDepth + deepest >= KNOWLEDGE_MAX_DEPTH) throw new Error(`That would nest "${doc.name}" deeper than ${KNOWLEDGE_MAX_DEPTH} levels.`);
        if ((doc.parent && parentDoc && doc.parent.equals(parentDoc._id)) || (!doc.parent && !parentDoc)) return doc;
        const ancestors = parentDoc ? [...(parentDoc.ancestors || []), parentDoc._id] : [];
        const path = parentDoc ? [...(parentDoc.path || []), parentDoc.name] : [];
        await coll.updateOne({ _id: id }, { $set: { parent: parentDoc ? parentDoc._id : null, ancestors, path, depth: newDepth, updateAt: new Date() } });
        await KnowledgeModel.rebuildSubtree(domainId, id);
        return (await KnowledgeModel.get(domainId, id))!;
    }

    /** Recompute ancestors / path / depth of everything beneath `id` from the (already correct) node itself. */
    static async rebuildSubtree(domainId: string, id: ObjectId) {
        const root = await KnowledgeModel.get(domainId, id);
        if (!root) return;
        const kids = await KnowledgeModel.children(domainId, id).toArray();
        for (const k of kids) {
            // eslint-disable-next-line no-await-in-loop
            await coll.updateOne({ _id: k._id }, {
                $set: { ancestors: [...root.ancestors, root._id], path: [...root.path, root.name], depth: root.depth + 1 },
            });
            // eslint-disable-next-line no-await-in-loop
            await KnowledgeModel.rebuildSubtree(domainId, k._id);
        }
    }

    /** Edit description / aliases (never the name — see rename; never the parent — see move). */
    static async edit(domainId: string, id: ObjectId, data: { description?: string, aliases?: string[] | string, category?: string }) {
        const doc = await KnowledgeModel.get(domainId, id);
        if (!doc) return null;
        const $set: any = { updateAt: new Date() };
        if (data.description !== undefined) $set.description = String(data.description || '').trim().slice(0, KNOWLEDGE_DESC_MAX);
        if (data.aliases !== undefined) {
            const aliases = KnowledgeModel.normalizeAliases(data.aliases, doc.nameLower);
            // An alias may not shadow another point's canonical name.
            for (const a of aliases) {
                const clash = await coll.findOne({ domainId, _id: { $ne: id }, $or: [{ nameLower: a.toLowerCase() }, { aliasesLower: a.toLowerCase() }] });
                if (clash) throw new Error(`"${a}" already belongs to knowledge point "${clash.name}".`);
            }
            $set.aliases = aliases;
            $set.aliasesLower = aliases.map((a) => a.toLowerCase());
        }
        await coll.updateOne({ _id: id }, { $set });
        return await KnowledgeModel.get(domainId, id);
    }

    /* ------------------- membership: the tasks' tags ------------------- */

    /**
     * Tasks of the domain (any kind) carrying `name` as a tag. `match`
     * narrows the set — callers pass the viewer's visibility filter and,
     * where relevant, a kind filter.
     */
    static async problemsWith(domainId: string, name: string, limit = 500, match: any = {}): Promise<Pick<ProblemDoc, 'docId' | 'pid' | 'title' | 'hidden' | 'tag'>[]> {
        if (!name) return [];
        return await problem.getMulti(domainId, { tag: name, ...match }, ['docId', 'pid', 'title', 'hidden', 'tag'] as any)
            .limit(Math.max(1, Math.min(limit, SCAN_LIMIT))).toArray() as any;
    }

    /**
     * Usage per tag over the domain's tasks: how many carry each tag. One
     * aggregation over the document collection; the result also covers
     * tags NOT in the catalog, which the catalog page offers to import.
     * `match` narrows the tasks counted — the viewer's visibility filter
     * (so hidden tasks never leak into what students see) and, on the
     * problem set, the current tab's kind.
     */
    static async tagUsage(domainId: string, match: any = {}): Promise<Map<string, number>> {
        const rows = await document.coll.aggregate([
            { $match: { domainId, docType: document.TYPE_PROBLEM, tag: { $exists: true, $ne: [] }, ...match } },
            { $limit: SCAN_LIMIT },
            { $unwind: '$tag' },
            { $group: { _id: '$tag', count: { $sum: 1 } } },
        ]).toArray();
        const map = new Map<string, number>();
        for (const r of rows as any[]) if (typeof r._id === 'string' && r._id.trim()) map.set(r._id, r.count);
        return map;
    }

    /** Add `name` to the task's tags (no-op when present). Returns the new tag list. */
    static async attach(domainId: string, docId: number, name: string): Promise<string[]> {
        const pdoc = await problem.get(domainId, docId, ['docId', 'tag'] as any);
        if (!pdoc) throw new Error(`Problem ${docId} not found.`);
        const tags = uniqCaseInsensitive([...(pdoc.tag || []), name]);
        if (tags.length !== (pdoc.tag || []).length) await problem.edit(domainId, docId, { tag: tags });
        return tags;
    }

    /** Remove `name` (case-insensitive) from the task's tags. */
    static async detach(domainId: string, docId: number, name: string): Promise<string[]> {
        const pdoc = await problem.get(domainId, docId, ['docId', 'tag'] as any);
        if (!pdoc) throw new Error(`Problem ${docId} not found.`);
        const lower = name.toLowerCase();
        const tags = (pdoc.tag || []).filter((t) => String(t).toLowerCase() !== lower);
        if (tags.length !== (pdoc.tag || []).length) await problem.edit(domainId, docId, { tag: tags });
        return tags;
    }

    /**
     * Rewrite one tag across ALL of the domain's tasks: `from` becomes `to`
     * (deduplicated), or is dropped when `to` is empty. Per-problem edits
     * rather than one updateMany, so every problem/edit hook (search
     * indexers and the like) still fires. Returns the number of tasks touched.
     */
    static async retag(domainId: string, from: string, to: string): Promise<number> {
        const fromLower = from.toLowerCase();
        const pdocs = await problem.getMulti(domainId, { tag: from }, ['docId', 'tag'] as any)
            .limit(SCAN_LIMIT).toArray();
        let touched = 0;
        for (const pdoc of pdocs as any[]) {
            const rest = (pdoc.tag || []).filter((t: string) => String(t).toLowerCase() !== fromLower);
            const tags = to ? uniqCaseInsensitive([...rest, to]) : rest;
            // eslint-disable-next-line no-await-in-loop
            await problem.edit(domainId, pdoc.docId, { tag: tags });
            touched++;
        }
        return touched;
    }

    /** Rename a point; the old name becomes an alias and every task's tag follows. */
    static async rename(domainId: string, id: ObjectId, newName: string): Promise<{ doc: KnowledgePointDoc, touched: number }> {
        const doc = await KnowledgeModel.get(domainId, id);
        if (!doc) throw new Error('Knowledge point not found.');
        const name = KnowledgeModel.normalizeName(newName);
        if (!name) throw new Error('A knowledge point needs a name.');
        const nameLower = name.toLowerCase();
        if (nameLower === doc.nameLower) {
            if (name === doc.name) return { doc, touched: 0 };
            // Case-only change: keep the tags in step, no alias needed.
            const touched = await KnowledgeModel.retag(domainId, doc.name, name);
            await coll.updateOne({ _id: id }, { $set: { name, updateAt: new Date() } });
            await KnowledgeModel.rebuildSubtree(domainId, id);
            return { doc: (await KnowledgeModel.get(domainId, id))!, touched };
        }
        const clash = await coll.findOne({ domainId, _id: { $ne: id }, $or: [{ nameLower }, { aliasesLower: nameLower }] });
        if (clash) throw new Error(`"${name}" already belongs to knowledge point "${clash.name}" — merge into it instead.`);
        const touched = await KnowledgeModel.retag(domainId, doc.name, name);
        const aliases = uniqCaseInsensitive([...doc.aliases, doc.name]).filter((a) => a.toLowerCase() !== nameLower).slice(0, KNOWLEDGE_ALIAS_MAX);
        await coll.updateOne({ _id: id }, {
            $set: {
                name, nameLower, aliases, aliasesLower: aliases.map((a) => a.toLowerCase()), updateAt: new Date(),
            },
        });
        // The name is part of every descendant's display path.
        await KnowledgeModel.rebuildSubtree(domainId, id);
        return { doc: (await KnowledgeModel.get(domainId, id))!, touched };
    }

    /** Fold `id` into `into`: tasks move over, the old name becomes an alias, the old point is deleted. */
    static async merge(domainId: string, id: ObjectId, into: ObjectId): Promise<{ target: KnowledgePointDoc, touched: number }> {
        if (id.equals(into)) throw new Error('Pick a different knowledge point to merge into.');
        const [src, dst] = await Promise.all([KnowledgeModel.get(domainId, id), KnowledgeModel.get(domainId, into)]);
        if (!src || !dst) throw new Error('Knowledge point not found.');
        if ((dst.ancestors || []).some((a) => a.equals(id))) throw new Error(`"${dst.name}" is beneath "${src.name}" — merge the other way round.`);
        const touched = await KnowledgeModel.retag(domainId, src.name, dst.name);
        const aliases = uniqCaseInsensitive([...dst.aliases, src.name, ...src.aliases])
            .filter((a) => a.toLowerCase() !== dst.nameLower).slice(0, KNOWLEDGE_ALIAS_MAX);
        await coll.updateOne({ _id: into }, { $set: { aliases, aliasesLower: aliases.map((a) => a.toLowerCase()), updateAt: new Date() } });
        // Whatever sat under the merged point now sits under the target.
        for (const k of await KnowledgeModel.children(domainId, id).toArray()) {
            // eslint-disable-next-line no-await-in-loop
            await KnowledgeModel.move(domainId, k._id, into).catch(async () => {
                // Too deep under the target: lift it to the target's level instead.
                await KnowledgeModel.move(domainId, k._id, dst.parent);
            });
        }
        await coll.deleteOne({ _id: id });
        return { target: (await KnowledgeModel.get(domainId, into))!, touched };
    }

    /** Delete a point and drop its tag from every task that carried it. */
    static async del(domainId: string, id: ObjectId): Promise<{ touched: number }> {
        const doc = await KnowledgeModel.get(domainId, id);
        if (!doc) return { touched: 0 };
        const touched = await KnowledgeModel.retag(domainId, doc.name, '');
        // Its children move up one level; nothing beneath it is lost.
        for (const k of await KnowledgeModel.children(domainId, id).toArray()) {
            // eslint-disable-next-line no-await-in-loop
            await KnowledgeModel.move(domainId, k._id, doc.parent);
        }
        await coll.deleteOne({ _id: id });
        return { touched };
    }

    /**
     * Remove a tag from every task of the domain, whether or not the catalog
     * knows it (a catalog entry of that name is deleted too). This is the
     * escape hatch for organizational leftovers such as the old `ai-draft`
     * marker; also reachable from the CLI:
     *   hydrooj cli knowledge removeTag <domainId> <tag>
     */
    static async removeTag(domainId: string, name: string): Promise<{ touched: number, catalogEntryDeleted: boolean }> {
        const clean = String(name || '').trim();
        if (!clean) return { touched: 0, catalogEntryDeleted: false };
        const touched = await KnowledgeModel.retag(domainId, clean, '');
        const doc = await KnowledgeModel.getByName(domainId, clean);
        if (doc && doc.nameLower === clean.toLowerCase()) {
            for (const k of await KnowledgeModel.children(domainId, doc._id).toArray()) {
                // eslint-disable-next-line no-await-in-loop
                await KnowledgeModel.move(domainId, k._id, doc.parent);
            }
            await coll.deleteOne({ _id: doc._id });
            return { touched, catalogEntryDeleted: true };
        }
        return { touched, catalogEntryDeleted: false };
    }

    /**
     * 🌳 The parent a new point should sit under: an existing topic by
     * name, or — when the caller says so explicitly (`parentIsNew`) — a
     * topic created on the spot, itself placed under `parentUnder` if that
     * exists. A parent name the catalog lacks WITHOUT the flag is ignored
     * (top level): a model's slip must never mint a stray topic. Several
     * new points naming the same new topic in one reply share it — the
     * second lookup finds what the first created.
     */
    static async ensureParent(
        domainId: string,
        p: { parent?: string, parentIsNew?: boolean, parentDescription?: string, parentUnder?: string },
        meta: { source: KnowledgePointDoc['source'], owner: number },
    ): Promise<KnowledgePointDoc | null> {
        const pname = KnowledgeModel.normalizeName(p.parent || '');
        if (!pname) return null;
        const found = await KnowledgeModel.getByName(domainId, pname);
        if (found) return found;
        if (!p.parentIsNew) return null;
        const under = p.parentUnder ? await KnowledgeModel.getByName(domainId, p.parentUnder) : null;
        // A new topic needs room for at least one level of points beneath it.
        const grand = under && under.depth + 2 < KNOWLEDGE_MAX_DEPTH ? under._id : null;
        try {
            return await KnowledgeModel.add(domainId, {
                name: pname, description: p.parentDescription || '', source: meta.source, owner: meta.owner, parent: grand,
            });
        } catch (e) {
            // Lost a race with a concurrent insert: read it back.
            return await KnowledgeModel.getByName(domainId, pname);
        }
    }

    /**
     * Resolve a list of names to canonical catalog names, creating the ones
     * the catalog lacks — and, when a new point names a NEW topic, that
     * topic as well. This is how the AI Studio keeps the catalog complete:
     * every point used by any task exists in it, in its place in the tree.
     * Returns canonical names in the input order (de-duplicated).
     */
    static async ensure(
        domainId: string,
        points: {
            name: string, description?: string,
            /** The topic the point belongs under, by name. */
            parent?: string,
            /** 🌳 True when `parent` is a topic the catalog does not have yet — it is created too. */
            parentIsNew?: boolean,
            /** One sentence for a new topic. */
            parentDescription?: string,
            /** For a NEW topic: the EXISTING topic it sits under ('' = top level). */
            parentUnder?: string,
        }[],
        meta: { source: KnowledgePointDoc['source'], owner: number },
    ): Promise<string[]> {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const p of points) {
            const name = KnowledgeModel.normalizeName(p?.name);
            if (!name) continue;
            // eslint-disable-next-line no-await-in-loop
            let canonical = await KnowledgeModel.resolve(domainId, name);
            if (!canonical) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const parentDoc = await KnowledgeModel.ensureParent(domainId, p, meta);
                    // eslint-disable-next-line no-await-in-loop
                    canonical = (await KnowledgeModel.add(domainId, {
                        name, description: p.description || '', source: meta.source, owner: meta.owner,
                        parent: parentDoc && parentDoc.depth + 1 < KNOWLEDGE_MAX_DEPTH ? parentDoc._id : null,
                    })).name;
                } catch (e) {
                    // Lost a race with a concurrent insert of the same name: read it back.
                    // eslint-disable-next-line no-await-in-loop
                    canonical = (await KnowledgeModel.resolve(domainId, name)) || name;
                }
            }
            const k = canonical.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(canonical);
        }
        return out;
    }

    /* ---------------------------- the tree ---------------------------- */

    /**
     * The whole catalog as a forest, with usage folded in: `count` is the
     * tasks carrying the point itself (from `usage`, a tagUsage map), and
     * `rollup` the DISTINCT tasks carrying it or anything beneath it. The
     * roll-up needs task identities, not counts, so it re-reads the tagged
     * tasks once (one projected scan) rather than summing children — a
     * task tagged with two siblings counts once under their parent.
     * Children are ordered most-used first, then by name.
     */
    static async tree(domainId: string, usage: Map<string, number>, match: any = {}): Promise<KnowledgeTreeNode[]> {
        const docs = await KnowledgeModel.getMulti(domainId).limit(5000).toArray();
        if (!docs.length) return [];
        const usageLower = new Map<string, number>();
        for (const [tag, n] of usage) usageLower.set(tag.toLowerCase(), (usageLower.get(tag.toLowerCase()) || 0) + n);
        // Task sets per tag, for the distinct roll-up.
        const tasksByTag = new Map<string, Set<number>>();
        const rows = await document.coll.aggregate([
            { $match: { domainId, docType: document.TYPE_PROBLEM, tag: { $exists: true, $ne: [] }, ...match } },
            { $limit: SCAN_LIMIT },
            { $project: { docId: 1, tag: 1 } },
        ]).toArray();
        for (const r of rows as any[]) {
            for (const t of r.tag || []) {
                const k = String(t).toLowerCase();
                if (!tasksByTag.has(k)) tasksByTag.set(k, new Set());
                tasksByTag.get(k)!.add(r.docId);
            }
        }
        const nodes = new Map<string, KnowledgeTreeNode & { _tasks: Set<number>, _parent: string | null }>();
        for (const d of docs) {
            nodes.set(d._id.toHexString(), {
                id: d._id.toHexString(),
                name: d.name,
                description: d.description || '',
                depth: d.depth || 0,
                path: d.path || [],
                count: usageLower.get(d.nameLower) || 0,
                rollup: 0,
                children: [],
                _tasks: new Set(tasksByTag.get(d.nameLower) || []),
                _parent: d.parent ? d.parent.toHexString() : null,
            });
        }
        const roots: (KnowledgeTreeNode & { _tasks: Set<number>, _parent: string | null })[] = [];
        for (const n of nodes.values()) {
            const parent = n._parent ? nodes.get(n._parent) : null;
            if (parent) parent.children.push(n);
            else roots.push(n);
        }
        // Roll up bottom-up: each node's task set absorbs its children's.
        const fold = (n: KnowledgeTreeNode & { _tasks: Set<number>, _parent: string | null }) => {
            for (const c of n.children as any[]) {
                fold(c);
                for (const t of c._tasks) n._tasks.add(t);
            }
            n.rollup = n._tasks.size;
            n.children.sort((a, b) => b.rollup - a.rollup || a.name.localeCompare(b.name));
        };
        for (const r of roots) fold(r);
        roots.sort((a, b) => b.rollup - a.rollup || a.name.localeCompare(b.name));
        const strip = (n: any): KnowledgeTreeNode => ({
            id: n.id, name: n.name, description: n.description, depth: n.depth, path: n.path, count: n.count, rollup: n.rollup, children: n.children.map(strip),
        });
        return roots.map(strip);
    }

    /**
     * The catalog as prompt context, INDENTED BY LEVEL, so a model sees the
     * topics and where each point sits ("- Loops" / "  - For loop reading n
     * values — …"). Capped in size; a very large catalog is truncated with
     * a note. Shared by the Studio labeler, the session advisor and the
     * bonus diagnosis so every model reads the same vocabulary.
     */
    static async promptCatalog(domainId: string, opts: { title?: string, budget?: number, descriptions?: boolean } = {}): Promise<string> {
        const title = opts.title || 'DOMAIN KNOWLEDGE-POINT CATALOG';
        const budget = opts.budget || 7000;
        const docs = await KnowledgeModel.getMulti(domainId).limit(5000).toArray();
        if (!docs.length) return `=== ${title} ===\n(empty — every point you output becomes its first entry)\n=== END CATALOG ===`;
        const byParent = new Map<string, KnowledgePointDoc[]>();
        for (const d of docs) {
            const k = d.parent ? d.parent.toHexString() : '';
            if (!byParent.has(k)) byParent.set(k, []);
            byParent.get(k)!.push(d);
        }
        const lines: string[] = [];
        let total = 0;
        let truncated = 0;
        const walk = (parentKey: string, indent: string) => {
            const kids = (byParent.get(parentKey) || []).sort((a, b) => a.nameLower.localeCompare(b.nameLower));
            for (const d of kids) {
                const line = `${indent}- ${d.name}${opts.descriptions !== false && d.description ? ` — ${d.description.slice(0, 110)}` : ''}${d.aliases?.length ? ` (aliases: ${d.aliases.slice(0, 4).join(', ')})` : ''}`;
                if (total + line.length > budget) {
                    truncated += 1;
                    continue;
                }
                lines.push(line);
                total += line.length + 1;
                walk(d._id.toHexString(), `${indent}  `);
            }
        };
        walk('', '');
        if (truncated) lines.push(`... (${truncated} more entries omitted)`);
        return `=== ${title} (${docs.length} entries; a tree — indented points sit under the topic above them; reuse names EXACTLY when they fit) ===\n${lines.join('\n')}\n=== END CATALOG ===`;
    }

    /** "Topic › Point" for a list of task tags, for prompts and tooltips; unknown tags pass through. */
    static async describeTags(domainId: string, tags: string[]): Promise<string[]> {
        const out: string[] = [];
        for (const t of tags) {
            // eslint-disable-next-line no-await-in-loop
            const doc = await KnowledgeModel.getByName(domainId, t);
            out.push(doc ? KnowledgeModel.describe(doc) : t);
        }
        return out;
    }

    /* --------------------------- migration --------------------------- */

    /**
     * The free-text `category` the tree replaced: every distinct category
     * becomes a top-level point (created if the catalog has no point of
     * that name yet) and the points that carried it move underneath.
     * Idempotent — a migrated document has no `category` left — so it is
     * safe on every boot and on several workers at once. Documents from
     * before the tree that carry NO category just get the tree fields.
     */
    static async migrateCategories(): Promise<{ domains: number, moved: number }> {
        // Tree fields on every pre-tree document.
        await coll.updateMany({ parent: { $exists: false } }, { $set: { parent: null, ancestors: [], path: [], depth: 0 } });
        const pending = await coll.find({ category: { $exists: true, $nin: ['', null] } }).limit(SCAN_LIMIT).toArray();
        const domains = new Set<string>();
        let moved = 0;
        for (const d of pending) {
            domains.add(d.domainId);
            const cat = KnowledgeModel.normalizeName(d.category);
            if (!cat || cat.toLowerCase() === d.nameLower) {
                // eslint-disable-next-line no-await-in-loop
                await coll.updateOne({ _id: d._id }, { $unset: { category: '' } });
                continue;
            }
            // eslint-disable-next-line no-await-in-loop
            let top = await KnowledgeModel.getByName(d.domainId, cat);
            if (!top) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    top = await KnowledgeModel.add(d.domainId, { name: cat, source: 'import', owner: d.owner, parent: null });
                } catch (e) {
                    // eslint-disable-next-line no-await-in-loop
                    top = await KnowledgeModel.getByName(d.domainId, cat);
                }
            }
            // eslint-disable-next-line no-await-in-loop
            await coll.updateOne({ _id: d._id }, { $unset: { category: '' } });
            if (top && !top._id.equals(d._id) && !d.parent) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await KnowledgeModel.move(d.domainId, d._id, top._id);
                    moved += 1;
                } catch (e) { /* a cycle or the depth cap: leave it at the top level */ }
            }
        }
        return { domains: domains.size, moved };
    }

    static async apply() {
        await db.ensureIndexes(
            coll,
            { name: 'domain_name', key: { domainId: 1, nameLower: 1 }, unique: true },
            { name: 'domain_alias', key: { domainId: 1, aliasesLower: 1 } },
            { name: 'domain_parent', key: { domainId: 1, parent: 1, nameLower: 1 } },
            { name: 'domain_ancestors', key: { domainId: 1, ancestors: 1 } },
        );
        // The category → tree migration, once per boot; a no-op after the first.
        try {
            const r = await KnowledgeModel.migrateCategories();
            if (r.moved) console.log(`[knowledge] tree migration: ${r.moved} point(s) moved under their former category in ${r.domains} domain(s)`);
        } catch (e) {
            console.warn(`[knowledge] tree migration failed: ${(e as Error).message}`);
        }
    }
}

declare module '../interface' {
    interface Model {
        knowledge: typeof KnowledgeModel;
    }
}
// Exposed like the other models so `hydrooj cli knowledge <fn> ...` works.
global.Hydro.model.knowledge = KnowledgeModel;

export default KnowledgeModel;
