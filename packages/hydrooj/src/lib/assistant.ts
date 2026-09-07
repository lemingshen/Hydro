/**
 * PTA fork — the STUDENT ASSISTANT: one personal agent per student.
 *
 * A chat button on every page (except the self-learning rooms, which belong
 * to the Socratic tutor) that answers course questions, explores the
 * student's weaknesses, explains concepts and verdicts, and plans around
 * deadlines — knowing THIS student: their knowledge map with its evidence,
 * their reasoning profile from the tutor threads, their own submissions,
 * what is open and when it closes, and what they told it about themselves.
 *
 * ── DESIGN RULES ────────────────────────────────────────────────────────
 *  • An ORCHESTRATOR WITH TOOLS, not one big prompt. The model decides what
 *    to look up; the code decides what is true. Every tool reads only the
 *    signed-in student's own data.
 *  • POSTURE IS DECIDED IN CODE (postureOf): OFF during a running test the
 *    student is sitting — no AI feature in a test, full stop — and in the
 *    self-learning rooms; TUTOR on a task of an open homework (concepts,
 *    the statement, errors, their approach — never the solution); DIRECT
 *    everywhere else. The posture picks the system prompt; the prompt
 *    cannot argue itself out of it.
 *  • PERSONALISATION FROM WHAT THE PLATFORM KNOWS: explanations are
 *    grounded in the student's own surfaced misconceptions and code; the
 *    reasoning profile changes how the assistant coaches; declared
 *    preferences and goals are literal directives. Nothing the student
 *    declares ever touches judged evidence.
 *  • COST: a per-student daily turn cap, a small context block, at most a
 *    few tool rounds per turn, and pure-lookup answers that need no second
 *    generation.
 */
import { ObjectId } from 'mongodb';
import { STATUS, STATUS_TEXTS } from '@hydrooj/common';
import { Logger } from '../logger';
import * as contest from '../model/contest';
import domain from '../model/domain';
import KnowledgeModel from '../model/knowledge';
import {
    appendThread, AssistantMessage, getMap, getProfile, getThread, saveProfile, setThreadSummary,
} from '../model/knowledgemap';
import problem from '../model/problem';
import RecordModel from '../model/record';
import SelfLearningModel, { collTutor, getClassReportMapCache } from '../model/selflearning';
import system from '../model/system';
import {
    AgentMessage, callProvider, callProviderWithTools, ToolCall, ToolSpec, tutorConfigured,
} from './ai_tutor';

const logger = new Logger('assistant');

export interface PageContext {
    /** The page name (html[data-page]) — e.g. problem_detail, homework_detail. */
    name?: string;
    /** The problem on screen, if any (docId). */
    pid?: number;
    /** The contest / homework on screen, if any. */
    tid?: string;
}

export type Posture = 'off' | 'tutor' | 'direct';

export function assistantEnabled(): boolean {
    return tutorConfigured() && system.get('assistant.enabled') !== false;
}

const DAY_MS = 86400000;
const fmtLeft = (d: Date) => {
    const ms = d.getTime() - Date.now();
    if (ms <= 0) return 'closed';
    const h = Math.floor(ms / 3600000);
    if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min`;
    if (h < 48) return `${h} h`;
    return `${Math.round(ms / DAY_MS)} days`;
};

/* ------------------------------------------------------------------ */
/*  Posture                                                            */
/* ------------------------------------------------------------------ */

/**
 * Why the assistant is where it is. `off` carries a reason for the panel.
 */
export async function postureOf(domainId: string, uid: number, page: PageContext): Promise<{ posture: Posture, reason?: string, activity?: string }> {
    if (!assistantEnabled()) return { posture: 'off', reason: 'The AI assistant is not enabled.' };
    if (/^self_learning/.test(String(page.name || ''))) return { posture: 'off', reason: 'Self-learning sessions have their own tutor.' };
    const now = new Date();
    // 1. A running TEST the student is sitting → off everywhere, not just on its pages.
    const running = await contest.getMulti(domainId, { rule: { $ne: 'homework' }, beginAt: { $lte: now }, endAt: { $gt: now } })
        .project({ docId: 1, title: 1 }).limit(20).toArray();
    for (const t of running as any[]) {
        // eslint-disable-next-line no-await-in-loop
        const st = await contest.getStatus(domainId, t.docId, uid);
        if (st?.attend) return { posture: 'off', reason: 'The AI assistant is unavailable while a test is running.', activity: t.title };
    }
    // 2. On a task page: which activities hold this task, and are any open?
    let pid = page.pid;
    let tdoc: any = null;
    if (page.tid) {
        try { tdoc = await contest.get(domainId, new ObjectId(page.tid)); } catch { tdoc = null; }
    }
    if (tdoc) {
        const isTest = tdoc.rule !== 'homework';
        const open = tdoc.beginAt <= now && tdoc.endAt > now;
        if (isTest && open) return { posture: 'off', reason: 'The AI assistant is unavailable while a test is running.', activity: tdoc.title };
        if (!isTest && open) return { posture: 'tutor', activity: tdoc.title };
    } else if (pid) {
        const holders = await contest.getMulti(domainId, { pids: pid, beginAt: { $lte: now }, endAt: { $gt: now } })
            .project({ rule: 1, title: 1 }).limit(10).toArray();
        for (const h of holders as any[]) if (h.rule !== 'homework') return { posture: 'off', reason: 'The AI assistant is unavailable while a test is running.', activity: h.title };
        const hw = (holders as any[]).find((h) => h.rule === 'homework');
        if (hw) return { posture: 'tutor', activity: hw.title };
    }
    return { posture: 'direct' };
}

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

interface Ctx {
    domainId: string;
    uid: number;
    page: PageContext;
    posture: Posture;
    activity?: string;
}

const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/**
 * The COURSE the assistant is inside: its name and the shape of its
 * knowledge catalog (the top-level areas and how many points sit under
 * each). This is what keeps the assistant coherent across the domain —
 * it speaks in the course's own vocabulary and knows what the course
 * covers, so "what should I study for pointers?" resolves against THIS
 * catalog, not the model's idea of a generic C course. Cheap and shared,
 * so cached per domain.
 */
const courseCache = new Map<string, { at: number, text: string }>();
async function courseCard(domainId: string): Promise<string> {
    const hit = courseCache.get(domainId);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.text;
    const lines: string[] = [];
    try {
        const ddoc = await domain.get(domainId);
        lines.push(`Course: ${ddoc?.name || domainId}${ddoc?.bulletin ? ` — ${String(ddoc.bulletin).replace(/\s+/g, ' ').slice(0, 200)}` : ''}.`);
        const points = await KnowledgeModel.getMulti(domainId).project({ name: 1, depth: 1, parent: 1, path: 1 }).limit(2000).toArray() as any[];
        const roots = points.filter((p) => !p.depth);
        const under = (root: any) => points.filter((p) => p.depth && p.path?.[0] === root.name).length;
        if (roots.length) lines.push(`Knowledge areas (${points.length} points): ${roots.map((r) => `${r.name} (${under(r)})`).join('; ')}.`);
        const nTasks = await problem.count(domainId, { hidden: { $ne: true } });
        lines.push(`Problem set: ${nTasks} visible tasks. Task ids: P… programming, F… function (student writes one function), O… objective, S… subjective.`);
    } catch (e: any) {
        logger.warn('[assistant] course card failed for %s: %s', domainId, e.message);
    }
    const text = lines.join('\n');
    courseCache.set(domainId, { at: Date.now(), text });
    return text;
}

/** The compact student card every turn opens with (≈ a few hundred tokens). */
async function studentCard(c: Ctx): Promise<string> {
    const lines: string[] = [];
    const map = await getMap(c.domainId, c.uid);
    if (map) {
        const s = map.stats;
        lines.push(`Knowledge map (${new Date(map.computedAt).toISOString().slice(0, 10)}): ${s.mastered} mastered, ${s.resolving} resolving, ${s.exposed} exposed, ${s.shaky} need work, ${s.untouched} not started.`);
        const shaky = map.points.filter((p) => p.state === 'shaky').sort((a, b) => b.confidence - a.confidence).slice(0, 5);
        if (shaky.length) lines.push(`Needs work: ${shaky.map((p) => `${p.name} (confidence ${Math.round(p.confidence * 100)}%)`).join('; ')}.`);
        if (map.next?.length) lines.push(`Practise next: ${map.next.slice(0, 4).map((n) => `${n.name} → ${n.tasks.map((t) => t.pid).join('/')}`).join('; ')}.`);
    } else lines.push('Knowledge map: not built yet (the student can open /knowledge-map to build it).');
    // Reasoning profile from the tutor threads.
    const threads = await collTutor.find({ domainId: c.domainId, uid: c.uid }).project({ ownership: 1, reasoning: 1, initiative: 1, integrity: 1 }).limit(60).toArray();
    const own = mean(threads.flatMap((t: any) => (t.integrity?.own ? [] : (t.ownership?.questions || []).flatMap((q: any) => q.levels || []))));
    const rea = mean(threads.flatMap((t: any) => (t.integrity?.rea ? [] : (t.reasoning?.levels || []))));
    const ini = mean(threads.map((t: any) => t.initiative?.level).filter((x: any) => typeof x === 'number'));
    if (own !== null || rea !== null || ini !== null) {
        const tag = (v: number | null, lo: number, hi: number) => (v === null ? 'no data' : v <= lo ? 'LOW' : v >= hi ? 'high' : 'mid');
        lines.push(`Reasoning profile (0-4 scale from tutoring): ownership ${own ?? '—'} (${tag(own, 1.5, 3)}), debugging reasoning ${rea ?? '—'} (${tag(rea, 1.5, 3)}), initiative ${ini ?? '—'} (${tag(ini, 1.5, 3)}).`);
    }
    // Behaviour: thrash in the last week.
    const since = new Date(Date.now() - 7 * DAY_MS);
    const recent = await RecordModel.coll.find({ domainId: c.domainId, uid: c.uid, _id: { $gt: ObjectId.createFromTime(Math.floor(since.getTime() / 1000)) } })
        .project({ pid: 1, status: 1 }).limit(400).toArray();
    if (recent.length) {
        const byPid = new Map<number, number>();
        for (const r of recent as any[]) byPid.set(r.pid, (byPid.get(r.pid) || 0) + 1);
        const thrash = [...byPid.entries()].filter(([, n]) => n >= 8).length;
        lines.push(`Last 7 days: ${recent.length} submissions on ${byPid.size} tasks${thrash ? `, ${thrash} task(s) with 8+ attempts (possible trial-and-error)` : ''}.`);
    }
    const prof = await getProfile(c.domainId, c.uid);
    const d = prof.declared || {};
    const prefs = [d.style && `explanations: ${d.style} first`, d.length && `length: ${d.length}`, d.tone && `tone: ${d.tone}`].filter(Boolean);
    if (prefs.length) lines.push(`Student's stated preferences: ${prefs.join(', ')}.`);
    if (prof.goals?.length) lines.push(`Goals: ${prof.goals.slice(-3).map((g) => `${g.text}${g.by ? ` (by ${new Date(g.by).toISOString().slice(0, 10)})` : ''}`).join('; ')}.`);
    if (prof.learned?.length) lines.push(`Things learned in earlier chats: ${prof.learned.slice(-5).map((l) => l.fact).join('; ')}.`);
    return lines.join('\n');
}

/** What is on screen, resolved server-side from the client's {name,pid,tid}. */
async function pageCard(c: Ctx): Promise<string> {
    const lines: string[] = [`Page: ${c.page.name || 'unknown'}.`];
    if (c.activity) lines.push(`Activity on screen: "${c.activity}" (${c.posture === 'tutor' ? 'OPEN homework — tutor posture' : c.posture}).`);
    if (c.page.pid) {
        const pdoc = await problem.get(c.domainId, c.page.pid, ['docId', 'pid', 'title', 'tag'] as any).catch(() => null);
        if (pdoc) {
            lines.push(`Task on screen: ${pdoc.pid || pdoc.docId} "${pdoc.title}"${pdoc.tag?.length ? ` — knowledge points: ${pdoc.tag.slice(0, 6).join(', ')}` : ''}.`);
            const recs = await RecordModel.coll.find({ domainId: c.domainId, uid: c.uid, pid: c.page.pid, contest: { $nin: [RecordModel.RECORD_PRETEST, RecordModel.RECORD_GENERATE] } })
                .sort({ _id: -1 }).project({ _id: 1, status: 1, lang: 1 }).limit(3).toArray();
            if (recs.length) lines.push(`Their last submissions here: ${(recs as any[]).map((r) => `${STATUS_TEXTS[r.status] || r.status} (${r.lang}, id ${r._id})`).join('; ')}.`);
            else lines.push('They have not submitted to this task yet.');
        }
    }
    return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Tools                                                              */
/* ------------------------------------------------------------------ */

const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required });

const TOOLS: ToolSpec[] = [
    { name: 'my_map', description: "The student's full knowledge map: every point with state, confidence and task counts. Use for 'what am I weak at' style questions.", parameters: obj({}) },
    { name: 'evidence', description: "Why the map says what it says about ONE knowledge point: the evidence lines (which tasks, what the tutor found). Use before explaining a weakness.", parameters: obj({ point: { type: 'string', description: 'knowledge point name' } }, ['point']) },
    { name: 'explain_point', description: "Course material for a knowledge point: its catalog description, its place in the tree, and THIS student's own recorded misconceptions on it. Use it to ground an explanation in their own mistakes.", parameters: obj({ point: { type: 'string' } }, ['point']) },
    { name: 'my_submission', description: "The student's latest submission to a task (code + verdict + compiler text), or a specific record id. Only their own code.", parameters: obj({ pid: { type: 'number', description: 'task docId' }, rid: { type: 'string', description: 'record id (optional)' } }) },
    { name: 'deadlines', description: 'Open homework, tests and sessions with time left and how many of their tasks the student has not solved yet.', parameters: obj({}) },
    { name: 'plan', description: "A practice plan: 'practise next' from the map, weighed against deadlines and a time budget in minutes per day.", parameters: obj({ days: { type: 'number' }, minutesPerDay: { type: 'number' } }) },
    { name: 'debrief', description: 'What the AI class report found about THIS student in a finished activity (by activity id).', parameters: obj({ tid: { type: 'string' } }, ['tid']) },
    { name: 'set_goal', description: 'Remember a goal the student stated, optionally with a date (ISO).', parameters: obj({ text: { type: 'string' }, by: { type: 'string' } }, ['text']) },
    { name: 'set_pref', description: "Remember a stated preference: style 'examples'|'theory', length 'short'|'thorough', tone 'encouraging'|'direct'.", parameters: obj({ style: { type: 'string' }, length: { type: 'string' }, tone: { type: 'string' } }) },
    { name: 'remember', description: 'Remember a durable fact the student told you about how they learn or what confuses them (one sentence).', parameters: obj({ fact: { type: 'string' } }, ['fact']) },
];

async function runTool(c: Ctx, call: ToolCall): Promise<string> {
    const a = call.args || {};
    switch (call.name) {
        case 'my_map': {
            const map = await getMap(c.domainId, c.uid);
            if (!map) return 'No knowledge map yet. The student can build one at /knowledge-map.';
            return JSON.stringify({
                computedAt: map.computedAt,
                stats: map.stats,
                points: map.points.filter((p) => p.state !== 'untouched').map((p) => ({ name: p.name, path: p.path.join(' › '), state: p.state, confidence: p.confidence, solved: `${p.tasks.solved}/${p.tasks.total}` })),
                next: map.next.map((n) => ({ point: n.name, reason: n.reason, tasks: n.tasks.map((t) => `${t.pid} ${t.title}`) })),
            });
        }
        case 'evidence': {
            const map = await getMap(c.domainId, c.uid);
            const p = map?.points.find((x) => x.name.toLowerCase() === String(a.point || '').toLowerCase());
            if (!p) return 'No such point on the map (check the exact name in my_map).';
            return JSON.stringify({ point: p.name, state: p.state, confidence: p.confidence, evidence: p.evidence.map((e) => `${e.polarity > 0 ? '+' : '−'} ${e.note || e.kind}${e.label ? ` (${e.label})` : ''}`) });
        }
        case 'explain_point': {
            const name = String(a.point || '');
            const canonical = await KnowledgeModel.resolve(c.domainId, name);
            const doc = canonical ? await KnowledgeModel.getByName(c.domainId, canonical) : null;
            // The threads where the tutor traced this student's errors to THIS
            // point (surfacedKp) — and the tutor's own line-anchored notes on
            // their code there ('anno' cards), which are the concrete pattern.
            const threads = await collTutor.find({ domainId: c.domainId, uid: c.uid, 'surfacedKp.names': { $in: [canonical || name] } })
                .project({ pid: 1, messages: 1 }).limit(4).toArray();
            const own: string[] = [];
            for (const t of threads as any[]) {
                const notes = (t.messages || []).filter((m: any) => m.role === 'assistant' && m.kind === 'anno' && m.content).slice(0, 2);
                for (const m of notes) own.push(`task ${t.pid}: ${String(m.content).slice(0, 400)}`);
                if (!notes.length) own.push(`task ${t.pid}: the tutor traced errors here to this point`);
            }
            return JSON.stringify({
                point: canonical || name, inCatalog: !!canonical,
                description: doc?.description || '(no description in the catalog)',
                path: doc?.path?.join(' › ') || '',
                studentsOwnMistakes: own.length ? own : 'none recorded for this point',
            });
        }
        case 'my_submission': {
            const q: any = { domainId: c.domainId, uid: c.uid };
            if (a.rid) { try { q._id = new ObjectId(String(a.rid)); } catch { return 'Bad record id.'; } } else if (a.pid) q.pid = Number(a.pid);
            else return 'Give a pid or a rid.';
            const r = await RecordModel.coll.find(q).sort({ _id: -1 }).limit(1).next() as any;
            if (!r) return 'No submission found.';
            return JSON.stringify({
                rid: String(r._id), pid: r.pid, lang: r.lang, verdict: STATUS_TEXTS[r.status] || r.status, score: r.score,
                compilerText: (r.compilerTexts || []).join('\n').slice(0, 1500), code: String(r.code || '').slice(0, 6000),
            });
        }
        case 'deadlines': return JSON.stringify(await deadlinesOf(c.domainId, c.uid));
        case 'plan': {
            const map = await getMap(c.domainId, c.uid);
            const dl = await deadlinesOf(c.domainId, c.uid);
            return JSON.stringify({
                days: Number(a.days) || 7, minutesPerDay: Number(a.minutesPerDay) || 30,
                deadlines: dl, practiseNext: map?.next?.slice(0, 6).map((n) => ({ point: n.name, reason: n.reason, tasks: n.tasks.map((t) => t.pid) })) || [],
                note: 'Order: open deadlines with unsolved tasks first (soonest first), then practise-next points. Suggest ~1-2 tasks per 30 minutes.',
            });
        }
        case 'debrief': {
            const cache = await getClassReportMapCache(c.domainId, String(a.tid || ''), [c.uid]);
            const f = cache.get(c.uid)?.findings;
            return f ? JSON.stringify(f).slice(0, 4000) : 'No class-report findings for this student on that activity.';
        }
        case 'set_goal': {
            const prof = await getProfile(c.domainId, c.uid);
            const by = a.by ? new Date(String(a.by)) : undefined;
            const goals = [...(prof.goals || []), { text: String(a.text || '').slice(0, 200), ...(by && !Number.isNaN(by.getTime()) ? { by } : {}), at: new Date() }].slice(-10);
            await saveProfile(c.domainId, c.uid, { goals });
            return 'Goal saved.';
        }
        case 'set_pref': {
            const prof = await getProfile(c.domainId, c.uid);
            const d: any = { ...(prof.declared || {}) };
            if (['examples', 'theory'].includes(a.style)) d.style = a.style;
            if (['short', 'thorough'].includes(a.length)) d.length = a.length;
            if (['encouraging', 'direct'].includes(a.tone)) d.tone = a.tone;
            await saveProfile(c.domainId, c.uid, { declared: d });
            return `Preferences saved: ${JSON.stringify(d)}.`;
        }
        case 'remember': {
            const prof = await getProfile(c.domainId, c.uid);
            const learned = [...(prof.learned || []), { fact: String(a.fact || '').slice(0, 200), source: 'chat' as const, at: new Date() }].slice(-20);
            await saveProfile(c.domainId, c.uid, { learned });
            return 'Noted.';
        }
        default: return `Unknown tool ${call.name}.`;
    }
}

async function deadlinesOf(domainId: string, uid: number) {
    const now = new Date();
    const [tdocs, sdocs] = await Promise.all([
        contest.getMulti(domainId, { endAt: { $gt: now } }).project({ docId: 1, title: 1, rule: 1, beginAt: 1, endAt: 1, pids: 1 }).limit(30).toArray(),
        SelfLearningModel.getMulti(domainId, { endAt: { $gt: now } }).project({ docId: 1, title: 1, beginAt: 1, endAt: 1, extensionDays: 1, pids: 1 }).limit(30).toArray(),
    ]);
    const all = [
        ...(tdocs as any[]).map((t) => ({ kind: t.rule === 'homework' ? 'homework' : 'test', ...t })),
        ...(sdocs as any[]).map((s) => ({ kind: 'self-learning', ...s, endAt: new Date(new Date(s.endAt).getTime() + (s.extensionDays || 0) * DAY_MS) })),
    ].filter((x) => x.beginAt <= now || x.kind === 'self-learning');
    const pids = [...new Set(all.flatMap((x) => x.pids || []))];
    const solved = new Set<number>();
    if (pids.length) {
        const ps = await problem.getMultiStatus(domainId, { uid, docId: { $in: pids }, status: STATUS.STATUS_ACCEPTED }).project({ docId: 1 }).toArray();
        for (const p of ps as any[]) solved.add(p.docId);
    }
    return all.map((x) => ({
        id: String(x.docId), kind: x.kind, title: x.title, closesIn: fmtLeft(new Date(x.endAt)), endAt: x.endAt,
        tasks: (x.pids || []).length, unsolved: (x.pids || []).filter((p: number) => !solved.has(p)).length,
    })).sort((a, b) => new Date(a.endAt).getTime() - new Date(b.endAt).getTime());
}

/* ------------------------------------------------------------------ */
/*  Prompt + turn                                                      */
/* ------------------------------------------------------------------ */

function systemPrompt(c: Ctx, course: string, student: string, page: string, summary: string): string {
    const posture = c.posture === 'tutor'
        ? `POSTURE: TUTOR. The task on screen belongs to an OPEN homework. You may explain concepts, clarify the statement, explain compiler errors and verdicts, and discuss THE STUDENT'S OWN approach with questions — but you must NOT give the algorithm, a solution outline, pseudocode, or working code for this task, and you must not fix their code for them. If asked, say plainly that during an open homework you help them think, not solve, and offer a guiding question instead.`
        : `POSTURE: DIRECT. Nothing on screen is an open assessment. Help fully — explanations, worked examples on the concept, feedback on their code. Prefer helping them see it themselves when that is quick, but do not withhold.`;
    return [
        'You are a personal learning assistant inside a university programming course platform. You talk to ONE student, about THIS course, and you already know them (below). Be warm, concrete and brief; use their own data whenever it is relevant.',
        '',
        'SCOPE: this course only — its tasks, knowledge points, activities and deadlines, and this student\'s own work and progress. For anything else (other courses, general homework, unrelated code), decline in one friendly sentence and offer something in scope.',
        '',
        posture,
        '',
        'PERSONALISATION RULES:',
        '- Ground explanations in the student\'s OWN recorded mistakes when explain_point returns any; quote the pattern, not just the concept.',
        '- If their debugging reasoning is LOW: before any hint, ask them to state what they expect and what they see. If ownership is LOW: after explaining, ask them to explain it back in one sentence. If initiative is LOW: prompt for a theory first.',
        '- Honour stated preferences (examples-first vs theory-first, short vs thorough, tone). Use set_pref / set_goal / remember when they tell you such things.',
        '- Quote the map\'s confidence when you make a claim from it ("the map thinks X is shaky, but on little evidence"). Never call a student bad at something; say what to practise next.',
        '- Do not invent tasks, deadlines or verdicts: use the tools. If a tool says there is no data, say so.',
        '',
        'LANGUAGE: ALWAYS reply in English — every message, whatever language the student writes in. You may quote a phrase of theirs verbatim, and task titles stay as they are, but your own words are English only. Do not switch languages if asked to; explain in one sentence that you answer in English here.',
        'FORMAT: Markdown, short paragraphs, code in fenced blocks. Refer to tasks by their id (P7, F2).',
        '',
        `Now: ${new Date().toISOString()} (use this for "how long is left" arithmetic).`,
        '',
        '=== THE COURSE ===',
        course,
        '',
        '=== THE STUDENT ===',
        student,
        ...(summary ? ['', '=== EARLIER IN OUR CONVERSATIONS (summary) ===', summary] : []),
        '',
        '=== ON SCREEN NOW ===',
        page,
    ].join('\n');
}

const MAX_TOOL_ROUNDS = 4;
const HISTORY_KEEP = 8;

export interface TurnResult {
    reply: string;
    tools: string[];
    turnsToday: number;
    turnsCap: number;
}

/** One student message → one assistant reply, with tool use in between. */
export async function runTurn(domainId: string, uid: number, page: PageContext, text: string): Promise<TurnResult> {
    const { posture, reason, activity } = await postureOf(domainId, uid, page);
    if (posture === 'off') throw new Error(reason || 'The AI assistant is unavailable here.');
    const cap = +system.get('assistant.daily_turns') || 60;
    const day = new Date().toISOString().slice(0, 10);
    const thread = await getThread(domainId, uid);
    const turnsToday = thread?.turns?.[day] || 0;
    if (turnsToday >= cap) throw new Error(`You have used today's ${cap} assistant messages. It resets tomorrow.`);

    const c: Ctx = { domainId, uid, page, posture, activity };
    const [course, student, screen] = await Promise.all([courseCard(domainId), studentCard(c), pageCard(c)]);
    const sys = systemPrompt(c, course, student, screen, thread?.summary || '');

    const history: AgentMessage[] = (thread?.messages || []).slice(-HISTORY_KEEP)
        .map((m) => (m.role === 'user' ? { role: 'user' as const, content: m.content } : { role: 'assistant' as const, content: m.content }));
    const messages: AgentMessage[] = [...history, { role: 'user', content: text.slice(0, 4000) }];
    const used: string[] = [];
    let reply = '';
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        // eslint-disable-next-line no-await-in-loop
        const out = await callProviderWithTools(sys, messages, TOOLS);
        if (!out.toolCalls.length || round === MAX_TOOL_ROUNDS) { reply = out.text || reply; break; }
        messages.push({ role: 'assistant', content: out.text, toolCalls: out.toolCalls });
        for (const call of out.toolCalls) {
            used.push(call.name);
            let result: string;
            try {
                // eslint-disable-next-line no-await-in-loop
                result = await runTool(c, call);
            } catch (e: any) {
                result = `Tool error: ${e.message}`;
                logger.warn('[assistant] tool %s failed for %s/%d: %s', call.name, domainId, uid, e.message);
            }
            messages.push({ role: 'tool', callId: call.id, name: call.name, content: result.slice(0, 12000) });
        }
    }
    if (!reply.trim()) reply = 'Sorry — I could not put an answer together. Could you rephrase?';
    const now = new Date();
    const stored: AssistantMessage[] = [
        { role: 'user', content: text.slice(0, 4000), at: now, page: { name: page.name, pid: page.pid, tid: page.tid } },
        { role: 'assistant', content: reply.slice(0, 12000), at: now, tools: [...new Set(used)] },
    ];
    const updated = await appendThread(domainId, uid, stored, true);
    // Fire-and-forget: the student never waits on memory upkeep.
    distill(domainId, uid, updated).catch((e) => logger.warn('[assistant] distill failed for %s/%d: %s', domainId, uid, e.message));
    return { reply, tools: [...new Set(used)], turnsToday: turnsToday + 1, turnsCap: cap };
}

/* ------------------------------------------------------------------ */
/*  Memory upkeep — how the assistant keeps knowing the student        */
/* ------------------------------------------------------------------ */

const DISTILL_EVERY = 6;

const DISTILL_PROMPT = `You maintain a learning assistant's memory of ONE student. From the conversation below (and the previous summary, if any), produce strict JSON:
{"summary":"<2-3 sentences: what they have been working on, what was explained, what they found hard, any agreed next step — written so a later conversation can continue naturally>","facts":["<durable fact about HOW this student learns or WHAT tends to confuse them, one sentence, only if it is likely to still be true in a month>"]}
Rules: facts are optional (0-3) and must not restate the summary, must not be about a single task's answer, and must not judge the student. Write the summary and the facts in English. Reply with the JSON only.`;

/**
 * Every DISTILL_EVERY messages, fold the older part of the thread into a
 * rolling summary (kept in the prompt) and add durable facts to the
 * profile's "learned" layer. This — not the 8-message window — is what
 * makes the assistant KEEP knowing the student: the derived layers (map,
 * threads, records) already refresh themselves as the student works, and
 * this closes the loop on what happens in the chat itself.
 */
async function distill(domainId: string, uid: number, thread: any) {
    const msgs: AssistantMessage[] = thread?.messages || [];
    const since = thread?.summarizedAt || 0;
    if (msgs.length < DISTILL_EVERY || msgs.length - since < DISTILL_EVERY) return;
    const transcript = msgs.slice(-16).map((m) => `${m.role === 'user' ? 'Student' : 'Assistant'}: ${String(m.content).slice(0, 700)}`).join('\n');
    const prev = thread?.summary ? `Previous summary: ${thread.summary}\n\n` : '';
    const raw = await callProvider(DISTILL_PROMPT, [{ role: 'user', content: `${prev}Conversation:\n${transcript}` }], { temperature: 0 });
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return;
    let j: any;
    try { j = JSON.parse(m[0]); } catch { return; }
    if (typeof j.summary === 'string' && j.summary.trim()) await setThreadSummary(domainId, uid, j.summary.trim(), msgs.length);
    const facts: string[] = (Array.isArray(j.facts) ? j.facts : []).map(String).map((f) => f.trim()).filter((f) => f.length > 8).slice(0, 3);
    if (!facts.length) return;
    const prof = await getProfile(domainId, uid);
    const have = (prof.learned || []).map((l) => l.fact.toLowerCase());
    // Dedup on the first 40 characters so near-repeats do not pile up.
    const fresh = facts.filter((f) => !have.some((h) => h.slice(0, 40) === f.toLowerCase().slice(0, 40)));
    if (!fresh.length) return;
    const learned = [...(prof.learned || []), ...fresh.map((fact) => ({ fact: fact.slice(0, 200), source: 'chat' as const, at: new Date() }))].slice(-20);
    await saveProfile(domainId, uid, { learned });
}

export default { postureOf, runTurn, assistantEnabled };
