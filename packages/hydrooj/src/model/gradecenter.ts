import db from '../service/db';

/**
 * PTA fork — GRADE CENTER settings, one document per domain: the
 * PERCENTAGE the teacher gives each activity (self-learning session,
 * homework, test) in the course grade, keyed `session:<id>`, `homework:<id>`,
 * `test:<id>`. Activities without an entry share the remaining weight
 * equally (the default is an equal split); a weight of 0 leaves the
 * activity out of the final grade while it stays on the board.
 */
export interface GradeCenterDoc {
    _id: string; // domainId
    domainId: string;
    weights: Record<string, number>;
    updatedAt: Date;
    by: number;
}

declare module '../service/db' {
    interface Collections {
        'grade.center': GradeCenterDoc;
    }
}

const coll = db.collection('grade.center');

export async function getGradeWeights(domainId: string): Promise<Record<string, number>> {
    const doc = await coll.findOne({ _id: domainId as any });
    return doc?.weights || {};
}

export async function setGradeWeights(domainId: string, weights: Record<string, number>, by: number): Promise<void> {
    await coll.updateOne(
        { _id: domainId as any },
        { $set: { domainId, weights, updatedAt: new Date(), by } },
        { upsert: true },
    );
}

export async function clearGradeWeights(domainId: string): Promise<void> {
    await coll.deleteOne({ _id: domainId as any });
}

const GradeCenterModel = { getGradeWeights, setGradeWeights, clearGradeWeights };
export default GradeCenterModel;
