/**
 * Compact glass card for one class section: name, code, meeting times, historical A rate and a grade
 * distribution chart on demand. Grade numbers come only from UTRP's grade database; nothing is estimated.
 */
import type { Serialized } from '@chrome-extension-toolkit';
import { Course } from '@shared/types/Course';
import { extendedColors } from '@shared/types/ThemeColors';
import GradeBarChart from '@views/components/injected/CourseCatalogInjectedPopup/GradeBarChart';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { lookupGrades } from '../adapters/utrp';
import type { GradeCounts, GradeStat } from '../core/grades';
import { formatMeeting } from '../core/meetings';
import type { SectionRecord } from '../core/sections';
import { SectionEvidence } from './CourseInventory';

const g = extendedColors.gradeDistribution;
const BARS: Array<[keyof GradeCounts, string]> = [
    ['A', g.a],
    ['A-', g.aminus],
    ['B+', g.bplus],
    ['B', g.b],
    ['B-', g.bminus],
    ['C+', g.cplus],
    ['C', g.c],
    ['C-', g.cminus],
    ['D+', g.dplus],
    ['D', g.d],
    ['D-', g.dminus],
    ['F', g.f],
    ['Other', g.other],
];

function meetingText(s: SectionRecord): string {
    if (s.meetings.length) return s.meetings.map(formatMeeting).join(' · ');
    return s.modality === 'async-online' ? 'Work on your own schedule, no class meetings' : 'Meeting times not listed';
}

export function ClassCard({
    section,
    grade,
    badge,
    children,
    className = '',
}: {
    section: SectionRecord;
    grade: GradeStat | null | undefined;
    /** short warning such as an unmet prerequisite */
    badge?: string;
    /** extra state classes, e.g. "in-plan" */
    className?: string;
    /** actions, e.g. the Add button */
    children?: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const [seats, setSeats] = useState(false);
    const [counts, setCounts] = useState<GradeCounts | null | undefined>(undefined);
    useEffect(() => {
        if (!open || counts !== undefined) return;
        if (!section.course) {
            setCounts(null);
            return;
        }
        let live = true;
        // cached per course and professor, so this reuses the lookup that produced `grade`
        void lookupGrades(new Course(section.course as Serialized<Course>)).then(raw => {
            if (live) setCounts(raw?.counts ?? null);
        });
        return () => {
            live = false;
        };
    }, [open, counts, section.course]);

    const r = grade?.result;
    const aOnly = r && r.graded ? ((counts?.A ?? NaN) / r.graded) * 100 : NaN;
    return (
        <article
            className={`class-card ${section.modality === 'async-online' ? 'online async' : section.modality === 'live-online' ? 'online live' : ''} ${className}`}
        >
            <div className='class-card-main'>
                <div className='class-card-text'>
                    <h4 className='class-title' title={section.title}>
                        {/[a-z]/.test(section.title) ? section.title : section.title.toLowerCase()}
                    </h4>
                    <p className='class-code'>
                        {section.courseCode} <span>· {String(section.uniqueId).padStart(5, '0')}</span>
                    </p>
                    {section.modality === 'async-online' && (
                        <span className='online-badge' title='Fully online with no scheduled meeting times'>
                            Online · Asynchronous
                        </span>
                    )}
                    {section.modality === 'live-online' && (
                        <span className='online-badge' title='Online class that meets live at the listed times'>
                            Online · Live at set times
                        </span>
                    )}
                    <p className='class-time'>{meetingText(section)}</p>
                    {badge && <span className='class-badge'>{badge}</span>}
                </div>
                <div
                    className='class-grade'
                    title={
                        r
                            ? `${r.graded} historical letter grades · ${grade?.scope === 'instructor' ? 'this professor' : 'all professors'}`
                            : undefined
                    }
                >
                    {r ? (
                        <>
                            <b>{r.percent.toFixed(0)}%</b>
                            <span>{r.threshold === 'A' ? 'A' : 'A or A−'}</span>
                        </>
                    ) : (
                        <span>No grade data</span>
                    )}
                </div>
            </div>
            {open && (
                <div className='class-chart'>
                    {counts === undefined ? (
                        <p className='small muted'>Loading grades…</p>
                    ) : counts ? (
                        <>
                            <GradeBarChart
                                bars={BARS.map(([label, color]) => ({ label, value: counts[label] ?? 0, color }))}
                                reducedMotion
                                height={190}
                            />
                            <p className='small muted'>
                                {Number.isFinite(aOnly) && `${aOnly.toFixed(0)}% A · `}
                                {r?.graded} grades ·{' '}
                                {grade?.scope === 'instructor' ? 'this professor' : 'all professors'}
                                {grade?.semesters.length
                                    ? ` · ${grade.semesters[0]}–${grade.semesters[grade.semesters.length - 1]}`
                                    : ''}
                            </p>
                        </>
                    ) : (
                        <p className='small muted'>No historical grade data for this class.</p>
                    )}
                </div>
            )}
            {seats && <SectionEvidence s={section} />}
            <div className='class-actions'>
                <button
                    type='button'
                    className='btn ghost sm'
                    aria-expanded={open}
                    onClick={() => setOpen(o => !o)}
                    disabled={!grade}
                >
                    {open ? 'Hide grades' : 'Grade distribution'}
                </button>
                <button type='button' className='btn ghost sm' aria-expanded={seats} onClick={() => setSeats(o => !o)}>
                    Seats
                </button>
                {children}
            </div>
        </article>
    );
}
