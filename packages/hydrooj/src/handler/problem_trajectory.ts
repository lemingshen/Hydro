/**
 * MERGED into handler/self_learning.ts — intentionally empty.
 *
 * Everything that lived here (the /p/:pid/trajectory endpoint, the
 * /activity/:tid/problem-kinds endpoint, and the ProblemDetail rail-kinds
 * hooks) now registers from handler/self_learning.ts instead.
 *
 * Reason: some dev-mode watchers hot-reload MODIFIED handler files but never
 * discover files CREATED after boot, so code that existed only in this
 * brand-new file was unreachable on such deployments — the missing
 * "Submitted code" panel and the flat (ungrouped) contest/homework rail were
 * both symptoms of exactly that. self_learning.ts is proven to reach the
 * runtime, so the whole backend now lives there.
 *
 * This stub remains only so extracting the zip over an older tree cleanly
 * disables the previous version and no route is ever registered twice.
 */
export async function apply() { /* intentionally empty */ }
