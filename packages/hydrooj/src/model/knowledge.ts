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
    /** Optional coarse grouping for browsing ("Control flow", "Data structures"); free text. */
    category: string;
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
        name: string, description?: string, aliases?: string[] | string, category?: string,
        source?: KnowledgePointDoc['source'], owner?: number,
    }): Promise<KnowledgePointDoc> {
        const name = KnowledgeModel.normalizeName(data.name);
        if (!name) throw new Error('A knowledge point needs a name.');
        const nameLower = name.toLowerCase();
        const existing = await KnowledgeModel.getByName(domainId, name);
        if (existing) throw new Error(`Knowledge point "${existing.name}" already exists${existing.nameLower !== nameLower ? ` (as an alias of it)` : ''}.`);
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
            category: KnowledgeModel.normalizeName(data.category || '').slice(0, 40),
            source: data.source || 'teacher',
            owner: data.owner || 0,
            createdAt: now,
            updateAt: now,
        };
        await coll.insertOne(doc);
        return doc;
    }

    /** Edit description / aliases / category (never the name — see rename). */
    static async edit(domainId: string, id: ObjectId, data: { description?: string, aliases?: string[] | string, category?: string }) {
        const doc = await KnowledgeModel.get(domainId, id);
        if (!doc) return null;
        const $set: any = { updateAt: new Date() };
        if (data.description !== undefined) $set.description = String(data.description || '').trim().slice(0, KNOWLEDGE_DESC_MAX);
        if (data.category !== undefined) $set.category = KnowledgeModel.normalizeName(data.category || '').slice(0, 40);
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
        return { doc: (await KnowledgeModel.get(domainId, id))!, touched };
    }

    /** Fold `id` into `into`: tasks move over, the old name becomes an alias, the old point is deleted. */
    static async merge(domainId: string, id: ObjectId, into: ObjectId): Promise<{ target: KnowledgePointDoc, touched: number }> {
        if (id.equals(into)) throw new Error('Pick a different knowledge point to merge into.');
        const [src, dst] = await Promise.all([KnowledgeModel.get(domainId, id), KnowledgeModel.get(domainId, into)]);
        if (!src || !dst) throw new Error('Knowledge point not found.');
        const touched = await KnowledgeModel.retag(domainId, src.name, dst.name);
        const aliases = uniqCaseInsensitive([...dst.aliases, src.name, ...src.aliases])
            .filter((a) => a.toLowerCase() !== dst.nameLower).slice(0, KNOWLEDGE_ALIAS_MAX);
        await coll.updateOne({ _id: into }, { $set: { aliases, aliasesLower: aliases.map((a) => a.toLowerCase()), updateAt: new Date() } });
        await coll.deleteOne({ _id: id });
        return { target: (await KnowledgeModel.get(domainId, into))!, touched };
    }

    /** Delete a point and drop its tag from every task that carried it. */
    static async del(domainId: string, id: ObjectId): Promise<{ touched: number }> {
        const doc = await KnowledgeModel.get(domainId, id);
        if (!doc) return { touched: 0 };
        const touched = await KnowledgeModel.retag(domainId, doc.name, '');
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
            await coll.deleteOne({ _id: doc._id });
            return { touched, catalogEntryDeleted: true };
        }
        return { touched, catalogEntryDeleted: false };
    }

    /**
     * Resolve a list of names to canonical catalog names, creating the ones
     * the catalog lacks. This is how the AI Studio keeps the catalog complete:
     * every point used by any task exists in it. Returns canonical names in
     * the input order (de-duplicated).
     */
    static async ensure(
        domainId: string,
        points: { name: string, description?: string }[],
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
                    canonical = (await KnowledgeModel.add(domainId, {
                        name, description: p.description || '', source: meta.source, owner: meta.owner,
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

    static async apply() {
        await db.ensureIndexes(
            coll,
            { name: 'domain_name', key: { domainId: 1, nameLower: 1 }, unique: true },
            { name: 'domain_alias', key: { domainId: 1, aliasesLower: 1 } },
        );
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
