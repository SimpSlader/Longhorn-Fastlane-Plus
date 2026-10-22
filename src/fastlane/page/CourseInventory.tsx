/**
 * The shared course inventory on the Fastlane page: one loader for Browse classes, recommendations, AI and the
 * schedule builder; the import panel for UT's official course-offerings document; and per-section evidence
 * that keeps "listed by the Registrar" separate from "confirmed on UT" and from seat availability.
 */
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { registrarPrintUrl } from '../catalog/offerings';
import type { SectionRecord } from '../core/sections';
import { availabilityDisplay, formatObservedTime, isConfirmedSection, semesterKey, subjectOf } from '../core/sections';
import type { OfferingsMeta } from '../data/sectionStore';
import type { Subject } from '../data/subjects';
import { availableSubjects } from '../data/subjects';
import { confirmSectionOnUt, importOfferingsFile, loadOfferingsMeta } from '../services/inventoryService';
import { loadCachedSections } from '../services/recommendationService';

const CHANGED = 'fastlane-inventory-changed';

export function notifyInventoryChanged(): void {
    window.dispatchEvent(new Event(CHANGED));
}

export interface Inventory {
    sections: SectionRecord[];
    metas: OfferingsMeta[];
    loaded: boolean;
}

const InventoryContext = createContext<Inventory | null>(null);

function useLoadedInventory(enabled: boolean): Inventory {
    const [state, setState] = useState<Inventory>({ sections: [], metas: [], loaded: false });
    useEffect(() => {
        if (!enabled) return;
        let alive = true;
        const load = () =>
            void Promise.all([loadCachedSections(null), loadOfferingsMeta()]).then(([sections, metas]) => {
                if (alive) setState({ sections, metas, loaded: true });
            });
        load();
        window.addEventListener(CHANGED, load);
        return () => {
            alive = false;
            window.removeEventListener(CHANGED, load);
        };
    }, [enabled]);
    return state;
}

/** Loads the inventory once for every feature rendered inside it. */
export function InventoryProvider({ children }: { children: ReactNode }) {
    return <InventoryContext.Provider value={useLoadedInventory(true)}>{children}</InventoryContext.Provider>;
}

/** All sections in this browser (official listings + UT pages viewed), reloaded after an import or confirmation. */
export function useInventory(): Inventory {
    const shared = useContext(InventoryContext);
    const own = useLoadedInventory(shared === null);
    return shared ?? own;
}

/** Every official subject plus any code seen in real sections, named from the Registrar's own legend. */
export function inventorySubjects(inventory: Inventory): Subject[] {
    const names = Object.assign({}, ...inventory.metas.map(m => m.subjectNames)) as Record<string, string>;
    return availableSubjects(inventory.sections.map(s => subjectOf(s.courseCode))).map(s =>
        s.name === s.code && names[s.code] ? { code: s.code, name: names[s.code] as string } : s
    );
}

/** Upcoming term used for the Registrar link when nothing is imported yet. */
function upcomingTermCode(now = new Date()): string {
    const y = now.getFullYear();
    const m = now.getMonth();
    return m >= 9 ? `${y + 1}2` : m >= 2 ? `${y}9` : `${y}2`;
}

function longDate(iso: string | null): string {
    if (!iso) return 'date not printed';
    return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function InventoryPanel({ term }: { term?: string }) {
    const inventory = useInventory();
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState('');
    const [message, setMessage] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);
    const metas = inventory.metas
        .filter(m => !term || m.term === term)
        .sort((a, b) => b.termCode.localeCompare(a.termCode));
    const counts = useMemo(() => {
        const byTerm = new Map<string, { confirmed: number; listed: number }>();
        for (const s of inventory.sections) {
            const key = semesterKey(s.semester);
            const c = byTerm.get(key) ?? { confirmed: 0, listed: 0 };
            if (isConfirmedSection(s)) c.confirmed++;
            else c.listed++;
            byTerm.set(key, c);
        }
        return byTerm;
    }, [inventory.sections]);
    const onFile = useCallback(async (file: File | undefined) => {
        if (!file) return;
        setBusy(true);
        setMessage('');
        try {
            const summary = await importOfferingsFile(file, (page, total) =>
                setProgress(`Reading page ${page} of ${total}…`)
            );
            setMessage(
                `Imported ${summary.meta.term}: ${summary.meta.sections.toLocaleString()} sections in ${summary.meta.courses.toLocaleString()} courses across ${summary.meta.subjects} subjects (UT list as of ${longDate(summary.meta.asOf)}). ${summary.confirmedKept} sections you already viewed on UT kept their confirmed details.`
            );
            notifyInventoryChanged();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : 'Could not read that file.');
        } finally {
            setBusy(false);
            setProgress('');
            if (fileRef.current) fileRef.current.value = '';
        }
    }, []);
    const printUrl = registrarPrintUrl(metas[0]?.termCode ?? upcomingTermCode());
    return (
        <section className='card inventory-panel' aria-label='Course inventory'>
            <h2>All UT classes for the semester</h2>
            {metas.length ? (
                metas.map(m => {
                    const c = counts.get(m.term);
                    return (
                        <p key={m.termCode}>
                            <b>{m.term}</b>: {m.sections.toLocaleString()} sections in {m.courses.toLocaleString()}{' '}
                            courses across {m.subjects} subjects, from the Registrar's course list as of{' '}
                            {longDate(m.asOf)}.
                            <br />
                            <span className='small muted'>
                                {c?.confirmed ?? 0} confirmed on UT pages you viewed · {c?.listed ?? 0} listed only.
                                Listed sections are official offerings; seat availability is only shown after you
                                confirm a section on UT. Source: {m.document}, imported{' '}
                                {formatObservedTime(m.importedAt)}.
                            </span>
                        </p>
                    );
                })
            ) : (
                <p>
                    Fastlane can load every subject's classes at once from UT's official course list, so you do not have
                    to open each department. Download the Registrar's “PDF of courses offered”, then choose it here. It
                    is read in this browser only.
                </p>
            )}
            <div className='planner-actions'>
                <a className='btn' href={printUrl} target='_blank' rel='noopener noreferrer'>
                    Get UT's course list (Registrar)
                </a>
                <label className={`btn${metas.length ? '' : ' primary'}`} aria-disabled={busy}>
                    {metas.length ? 'Update from a newer PDF' : 'Import the course list PDF'}
                    <input
                        ref={fileRef}
                        type='file'
                        accept='application/pdf,.pdf'
                        hidden
                        disabled={busy}
                        onChange={e => void onFile(e.target.files?.[0])}
                    />
                </label>
            </div>
            <p role='status' className='small'>
                {progress || message}
            </p>
        </section>
    );
}

/** Keeps the three kinds of evidence apart: official listing, confirmed section details, seat availability. */
export function SectionEvidence({ s }: { s: SectionRecord }) {
    const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
    const confirmed = isConfirmedSection(s);
    const confirm = async () => {
        setState('busy');
        const result = await confirmSectionOnUt(s).catch(() => null);
        if (result) {
            setState('idle');
            notifyInventoryChanged();
        } else setState('failed');
    };
    return (
        <div className='section-evidence small'>
            {s.listing && (
                <span className='chip' title={`${s.listing.document} · ${s.listing.sourceUrl}`}>
                    Listed by UT Registrar · as of {longDate(s.listing.asOf)}
                </span>
            )}
            {confirmed ? (
                <span className='chip ok'>Confirmed on UT · {formatObservedTime(s.capturedAt)}</span>
            ) : (
                <span className='chip warn'>Section details not yet confirmed on UT</span>
            )}
            <span className='muted'>
                {confirmed ? availabilityDisplay(s.status).text : 'Seat availability: confirm on UT'}
            </span>
            {!confirmed && s.url && (
                <>
                    {' '}
                    <button
                        type='button'
                        className='btn small'
                        disabled={state === 'busy'}
                        onClick={() => void confirm()}
                    >
                        {state === 'busy' ? 'Checking UT…' : 'Confirm on UT'}
                    </button>
                    {state === 'failed' && (
                        <span role='status'>
                            {' '}
                            UT did not return this section. Sign in to UT, or{' '}
                            <a href={s.url} target='_blank' rel='noopener noreferrer'>
                                open it on UT
                            </a>
                            .
                        </span>
                    )}
                </>
            )}
        </div>
    );
}
