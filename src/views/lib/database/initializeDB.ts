import DB_FILE_URL from '@assets/database/grade_distributions.db?url';
import initSqlJs from 'sql.js/dist/sql-wasm';
import WASM_FILE_URL from 'sql.js/dist/sql-wasm.wasm?url';
import { setActiveGradeDataset } from 'src/fastlane/data/activeGradeDataset';
import { loadGradesOverride } from 'src/fastlane/services/dataConfig';
// import WASM_FILE_URL from '../../../../public/database/sql-wasm.wasm?url';

/**
 * A utility type for the SQL.js Database type
 */
export type Database = initSqlJs.Database;

/**
 * We only want to load the database into memory once, so we store a reference to the database here.
 */
let db: Database;

/**
 * This function loads the database into memory and returns a reference to the sql.js Database object.
 * @returns a reference to the sql.js Database object
 */
export async function initializeDB(): Promise<Database> {
    if (db) {
        return db;
    }

    if (!WASM_FILE_URL || !DB_FILE_URL) {
        throw new Error('WASM_FILE_URL or DB_FILE_URL is undefined');
    }

    const [{ Database }, override] = await Promise.all([
        initSqlJs({
            locateFile: () => WASM_FILE_URL,
        }),
        // Fastlane: a verified downloaded dataset (SHA-256 checked) replaces the bundled one when present
        loadGradesOverride(),
    ]);

    if (override) {
        try {
            const candidate = new Database(new Uint8Array(override.buffer));
            candidate.exec('SELECT 1 FROM grade_distributions LIMIT 1');
            indexForCourseLookups(candidate);
            db = candidate;
            setActiveGradeDataset({
                version: override.descriptor.version,
                updated: override.descriptor.publishedAt.slice(0, 10),
                source: override.descriptor.source,
                origin: 'downloaded',
            });
            return db;
        } catch (e) {
            console.warn('[Fastlane] downloaded grade dataset unusable, using bundled data', e);
        }
    }

    const dbBuffer = await fetch(DB_FILE_URL).then(res => res.arrayBuffer());
    db = new Database(new Uint8Array(dbBuffer));
    indexForCourseLookups(db);

    return db;
}

/**
 * Fastlane: an in-memory index so per-course lookups do not scan every row (Browse classes can show hundreds of
 * sections at once). Only the in-memory copy is changed, never the bundled file.
 */
function indexForCourseLookups(database: Database): void {
    try {
        database.exec(
            'CREATE INDEX IF NOT EXISTS fastlane_course ON grade_distributions (Department_Code, Course_Number)'
        );
    } catch (e) {
        console.warn('[Fastlane] could not index grade data', e);
    }
}
