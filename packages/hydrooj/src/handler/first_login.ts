/**
 * PTA fork — FORCED PASSWORD CHANGE ON FIRST LOGIN.
 *
 * Accounts created by the roster importer (handler/self_learning.ts
 * BulkAddUsersHandler) start with a password the teacher can derive from
 * the roster — the same string is known to whoever prepared the import and
 * is often printed on a handout. Such an account must not stay reachable
 * with that password, so the importer marks it `forcePasswordChange` and
 * this module keeps the account useless until the student picks their own
 * password:
 *
 *   - `handler/before` runs on EVERY request. While the flag is set, a
 *     flagged user is redirected to /user/first-login and nothing else on
 *     the site answers: not the problem set, not a submission, not the AI
 *     endpoints, not the websockets. Only the change page itself, logging
 *     out, and the login page stay reachable.
 *   - POSTing a new password clears the flag, and the student lands where
 *     they were going.
 *
 * The flag is a plain boolean on the user document, so it is also the
 * mechanism for "reset this account's password" later: set it with
 * requirePasswordChange(uid) after any administrative reset.
 */
import { Context } from '../context';
import { ForbiddenError, UserNotFoundError, ValidationError, VerifyPasswordError } from '../error';
import { Logger } from '../logger';
import { PRIV } from '../model/builtin';
import token from '../model/token';
import user from '../model/user';
import { Handler, param, Types } from '../service/server';

const logger = new Logger('first-login');

/** Paths that must keep working while the account is locked to the change page. */
const ALLOWED = [
    '/user/first-login',
    '/login',
    '/logout',
    '/resource',
    '/manifest.json',
    '/favicon.ico',
];

/** Mark an account as needing a new password before it can be used again. */
export async function requirePasswordChange(uid: number): Promise<void> {
    await user.setById(uid, { forcePasswordChange: true });
}

/**
 * Does this password look like the one the roster importer generated for
 * this very account? The importer builds it as `${uname}_${lastName}_${firstName}`
 * from the roster row and stores those names on the account, so the string
 * can be rebuilt at login and compared with what was just typed.
 *
 * This is the retroactive half of the feature. The flag above only exists
 * on accounts imported AFTER it was added, and only through the importer
 * that sets it; this catches every account that is still on its initial
 * password whatever created it and whenever. Once the student picks their
 * own password the comparison stops matching, so it never fires again.
 */
export function isInitialImportPassword(udoc: any, password: string): boolean {
    if (!udoc || !password) return false;
    const uname = String(udoc.uname || '').trim();
    if (!uname) return false;
    const raw = udoc._udoc || udoc;
    const first = String(udoc.firstName ?? raw.firstName ?? '').trim();
    const last = String(udoc.lastName ?? raw.lastName ?? '').trim();
    // Both name orders and the no-name form, since a roster row may carry
    // only one half (or neither) and the importer still builds the string.
    const candidates = new Set([
        `${uname}_${last}_${first}`,
        `${uname}_${first}_${last}`,
        `${uname}__`,
        uname,
    ]);
    return candidates.has(password);
}

/** True when this user must change their password before doing anything else. */
export function mustChangePassword(u: any): boolean {
    if (!u || u._id <= 1) return false;
    if (!u.hasPriv?.(PRIV.PRIV_USER_PROFILE)) return false;
    return !!(u.forcePasswordChange ?? u._udoc?.forcePasswordChange);
}

class ForcedPasswordChangeHandler extends Handler {
    async prepare() {
        if (!mustChangePassword(this.user)) {
            // Nothing to do — send them on rather than showing a puzzling form.
            this.response.redirect = this.url('homepage');
            throw new ForbiddenError('Your password does not need changing.');
        }
    }

    async get() {
        this.response.template = 'user_first_login.html';
        this.response.body = { uname: this.user.uname };
    }

    @param('password', Types.Password)
    @param('verifyPassword', Types.Password)
    @param('redirect', Types.String, true)
    async post({ }, password: string, verify: string, redirect = '') {
        if (password !== verify) throw new VerifyPasswordError();
        const udoc = await user.getById(this.args.domainId, this.user._id);
        if (!udoc) throw new UserNotFoundError(this.user._id);
        /*
         * The initial password is the one thing we know is compromised, so
         * "changing" to it again is refused. checkPassword throws when the
         * password is WRONG, which is what we want here: no throw means the
         * student re-entered the password they were given.
         */
        let same = false;
        try {
            await udoc.checkPassword(password);
            same = true;
        } catch (e) {
            same = false;
        }
        if (same) throw new ValidationError('password', null, 'Please choose a password different from the one you were given.');
        await user.setPassword(this.user._id, password);
        await user.setById(this.user._id, { forcePasswordChange: false });
        /*
         * Same ending as the site's own change-password form: every session
         * of this account is dropped and they sign in again with the new
         * password. That also kills any session someone else may have
         * opened with the shared initial password.
         */
        await token.delByUid(this.user._id, token.TYPE_SESSION);
        logger.info('uid %d set their own password on first login', this.user._id);
        this.response.redirect = this.url('user_login', { query: redirect && redirect.startsWith('/') ? { redirect } : {} });
    }
}

export function registerFirstLoginRoutes(ctx: Context) {
    if ((global as any).__ptaFirstLoginRoutes) return;
    (global as any).__ptaFirstLoginRoutes = true;
    ctx.Route('user_first_login', '/user/first-login', ForcedPasswordChangeHandler, PRIV.PRIV_USER_PROFILE);
    /*
     * THE gate. Every handler passes through here before it runs, so a
     * flagged account cannot reach anything — including endpoints added by
     * the fork — until it has a password of the student's own.
     */
    ctx.on('handler/before' as any, (h: any) => {
        if (!h?.request || !h?.response) return;
        if (!mustChangePassword(h.user)) return;
        // Compare without the optional /d/<domain> prefix, so the gate
        // behaves the same inside a domain as outside one.
        const raw = String(h.request.path || '');
        const path = raw.replace(/^\/d\/[^/]+/, '') || '/';
        if (ALLOWED.some((p) => path === p || path.startsWith(`${p}/`))) return;
        /*
         * Throwing is what stops the handler from running. A browser still
         * gets the redirect rather than an error page, because the
         * framework's response pipeline checks `response.redirect` before
         * the rendered error (framework/base.ts). A JSON / XHR caller has
         * no redirect set and receives the 403 with this message, which is
         * the right answer for the fork's many fetch() endpoints.
         */
        if (!h.request.json) h.response.redirect = `/user/first-login?redirect=${encodeURIComponent(raw)}`;
        throw new ForbiddenError('Please set your own password before using the site.');
    });
    ctx.effect(() => () => { (global as any).__ptaFirstLoginRoutes = false; });
}

export async function apply(ctx: Context) {
    registerFirstLoginRoutes(ctx);
}
