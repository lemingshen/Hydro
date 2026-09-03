import { load as yamlLoad } from 'js-yaml';
import { streamToBuffer } from '@hydrooj/utils/lib/utils';
import storage from '../model/storage';

/**
 * PTA fork — read a problem's raw config.yaml (verbatim fields, {} when
 * absent). Shared by the problem handler (allowed languages, objective
 * answer keys) and the contest handler (end-of-container evaluation grades
 * objective answers against the key); it lives here so the two handlers do
 * not import each other.
 */
export async function readRawProblemConfig(pdoc: { domainId: string, docId: number, data?: any[] }): Promise<any> {
    const f = (pdoc.data || []).find((i) => i.name.toLowerCase() === 'config.yaml');
    if (!f) return {};
    try {
        const buf = await streamToBuffer(await storage.get(`problem/${pdoc.domainId}/${pdoc.docId}/testdata/${f.name}`));
        return (yamlLoad(buf.toString()) as any) || {};
    } catch (e) {
        return {};
    }
}
