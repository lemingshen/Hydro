/**
 * RETIRED — intentionally empty.
 *
 * The AI explanation of objective answers ("🤖 Explain" on the homework
 * paper, once the homework has ended) lives in lib/objective_feedback.ts:
 * one explanation PER QUESTION (`?pid=`), registered from handler/homework.ts
 * through applyObjectiveFeedback(). This file used to hold an OLDER,
 * homework-wide version of the same feature (no `pid`).
 *
 * Why it must stay empty: Hydro loads every file in handler/ at boot, so
 * the old copy registered the very same route
 * (`homework_objective_feedback`, /homework/:tid/objective-feedback) — and
 * ALWAYS first, because homework.ts only wires the real handler after
 * `await ctx.inject(['scoreboard'])`. The router serves the first matching
 * layer, so every request reached the old handler, which ignored `pid` and
 * called the model with the wrong argument count: the job was stored under
 * a `.../[object Object]` key, the report under `.../<report text>`, and
 * the page — polling `.../<pid>` — never found either, ending in
 * "The explanation could not be generated." for every student.
 *
 * The model's boot-time sweep (purgeMalformedObjectiveFeedback) removes the
 * documents the old handler wrote. Deleting this file is equivalent to
 * keeping it empty; the stub only exists so that extracting an update over
 * an older tree disables the previous version.
 */
export async function apply() { /* intentionally empty */ }
