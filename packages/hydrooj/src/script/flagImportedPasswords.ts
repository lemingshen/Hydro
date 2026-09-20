import Schema from 'schemastery';
import { isInitialImportPassword } from '../handler/first_login';
import user from '../model/user';

/**
 * PTA fork — flag the accounts that are STILL on the password the roster
 * importer gave them, so they are asked to set their own at next login
 * (handler/first_login.ts).
 *
 * The login path already detects this on its own: when the password typed
 * is the one the roster implies, the account is flagged right there. This
 * script does the same sweep up front, which is useful for two things:
 *
 *   - seeing how many accounts in a domain are still on a password their
 *     teacher can derive (a straight answer to "is this a problem?");
 *   - flagging them immediately, so an account that is never logged into
 *     is nevertheless locked.
 *
 * It cannot read passwords — nobody can, they are hashed — so it verifies
 * each candidate by asking the account itself whether the derived string
 * is its password (udoc.checkPassword), exactly as a login would.
 *
 *   hydrooj cli script run flagImportedPasswords '{}'
 *   hydrooj cli script run flagImportedPasswords '{"apply":true}'
 *   hydrooj cli script run flagImportedPasswords '{"apply":true,"domainId":"pf"}'
 */
export const apply = (ctx) => ctx.addScript(
    'flagImportedPasswords',
    'Flag imported accounts still using their initial password (dry-run by default).',
    Schema.object({
        domainId: Schema.string(),
        apply: Schema.boolean().default(false),
        /** Only accounts whose mail ends with this (the importer uses @bulk-import.invalid). */
        mailSuffix: Schema.string(),
    }),
    async (arg, report) => {
        const q: any = {};
        if (arg.mailSuffix) q.mailLower = { $regex: `${arg.mailSuffix.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` };
        const udocs = await user.getMulti(q).project({
            _id: 1, uname: 1, mail: 1, firstName: 1, lastName: 1, forcePasswordChange: 1,
        }).limit(5000).toArray();
        report({ message: `${udocs.length} account(s) to check` });
        let already = 0;
        let stale = 0;
        let flagged = 0;
        for (const u of udocs as any[]) {
            if (u.forcePasswordChange) {
                already += 1;
                continue;
            }
            const derived = `${u.uname}_${String(u.lastName || '').trim()}_${String(u.firstName || '').trim()}`;
            if (!isInitialImportPassword(u, derived)) continue;
            // eslint-disable-next-line no-await-in-loop
            const full = await user.getById(arg.domainId || 'system', u._id);
            if (!full) continue;
            let matches = false;
            try {
                // eslint-disable-next-line no-await-in-loop
                await full.checkPassword(derived);
                matches = true;
            } catch (e) {
                matches = false; // the student already changed it
            }
            if (!matches) continue;
            stale += 1;
            report({ message: `  ${u.uname} (uid ${u._id}) is still on its initial password` });
            if (arg.apply) {
                // eslint-disable-next-line no-await-in-loop
                await user.setById(u._id, { forcePasswordChange: true });
                flagged += 1;
            }
        }
        report({
            message: arg.apply
                ? `${flagged} account(s) flagged; ${already} were already flagged.`
                : `${stale} account(s) are still on their initial password (${already} already flagged). Re-run with apply: true to flag them.`,
        });
        return true;
    },
);
