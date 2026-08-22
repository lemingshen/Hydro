/* eslint-disable no-await-in-loop */
import '../lib/index';

import path from 'path';
import fs from 'fs-extra';
import * as yaml from 'js-yaml';
import { Context } from '../context';
import { Logger } from '../logger';
import { PRIV } from '../model/builtin';
import { isClass, unwrapExports } from '../utils';

const logger = new Logger('common');

function locateFile(basePath: string, filenames: string[]) {
    for (const i of filenames) {
        const p = path.resolve(basePath, i);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

type LoadTask = 'model' | 'addon' | 'service';
const getLoader = (type: LoadTask, filename: string) => async function loader(pending: Record<string, string>, fail: string[], ctx: Context) {
    for (const [name, i] of Object.entries(pending)) {
        const p = locateFile(i, [`${filename}.ts`, `${filename}.js`]);
        if (p && !fail.includes(i)) {
            const loadType = type.replace(/^(.)/, (t) => t.toUpperCase());
            try {
                const m = unwrapExports(require(p));
                if (m.apply) ctx.loader.reloadPlugin(p, name);
                else logger.info(`${loadType} init: %s`, i);
            } catch (e) {
                fail.push(i);
                app.injectUI(
                    'Notification', `${loadType} load fail: {0}`,
                    { args: [i], type: 'warn' }, PRIV.PRIV_VIEW_SYSTEM_NOTIFICATION,
                );
                logger.info(`${loadType} load fail: %s`, i);
                logger.error(e);
            }
        }
    }
};

export const addon = getLoader('addon', 'index');
export const model = getLoader('model', 'model');
export const service = getLoader('service', 'service');

export async function builtinModel(ctx: Context) {
    const modelDir = path.resolve(__dirname, '..', 'model');
    const models = await fs.readdir(modelDir);
    for (const t of models.filter((i) => i.endsWith('.ts'))) {
        const q = path.resolve(modelDir, t);
        const module = require(q);
        if ('apply' in module) ctx.loader.reloadPlugin(q, '');
        const exports = unwrapExports(module);
        if (isClass(exports) && !(Symbol.for('hydro.initialize') in exports)) ctx.loader.reloadPlugin(q, '');
    }
}

export async function locale(pending: Record<string, string>, fail: string[]) {
    for (const i of Object.values(pending)) {
        const p = locateFile(i, ['locale', 'locales']);
        if (p && (await fs.stat(p)).isDirectory() && !fail.includes(i)) {
            try {
                const files = await fs.readdir(p);
                for (const file of files) {
                    // PTA fork: locale problems are contained per FILE and are
                    // never fatal. Upstream pushed the addon into `fail` here,
                    // which excluded its models, handlers and TEMPLATES from
                    // every later boot stage — one duplicated yaml key turned
                    // every page on the site into a raw JSON dump.
                    try {
                        const content = await fs.readFile(path.resolve(p, file), 'utf-8');
                        let dict: any;
                        try {
                            dict = yaml.load(content);
                        } catch (e) {
                            // js-yaml's default schema hard-fails on duplicated
                            // mapping keys; the JSON schema resolves them
                            // last-wins, which is the right behavior for a
                            // human-edited string table.
                            dict = yaml.load(content, { json: true } as any);
                            logger.warn('Locale %s/%s: %s (loaded leniently)', i, file, String((e as any)?.message || e).split('\n')[0]);
                        }
                        if (typeof dict !== 'object' || !dict) throw new Error('Invalid locale file');
                        app.i18n.load(file.split('.')[0], dict as any);
                    } catch (e) {
                        app.injectUI('Notification', 'Locale load fail: {0}', { args: [`${i}/${file}`], type: 'warn' }, PRIV.PRIV_VIEW_SYSTEM_NOTIFICATION);
                        logger.error('Locale file load fail: %s/%s', i, file);
                        logger.error(e);
                    }
                }
                logger.info('Locale init: %s', i);
            } catch (e) {
                logger.error('Locale Load Fail: %s', i);
                logger.error(e);
            }
        }
    }
}
