import type { DegreeEvaluation } from '../core/degreeRules';

const LABELS = {
    advances: 'Advances an unmet requirement',
    elective: 'Verified elective',
    redundant: 'Redundant for this requirement',
    'duplicate-credit': 'Already completed / overlapping credit',
    'duplicate-enrollment': 'Duplicate enrollment',
    'in-progress': 'Already in progress',
    unverified: 'Applicability unverified',
    excluded: 'Excluded from degree hours',
};
export default function DegreeFitList({ degree }: { degree: DegreeEvaluation }) {
    return (
        <section className='card stack' aria-label='Degree fit for this plan'>
            <h3>Degree fit for this plan</h3>
            <p className='small muted'>
                {degree.plannedDegreeCredits} planned degree-applicable hours identified. These are conditional on
                successful completion, not earned credit. An unverified elective is not counted.
            </p>
            <ul className='stack' style={{ listStyle: 'none', padding: 0 }}>
                {degree.courses.map(course => (
                    <li
                        key={`${course.uniqueId}:${course.courseCode}:${course.status}`}
                        className='stack'
                        aria-label={`Degree fit for ${course.courseCode}`}
                    >
                        <div className='row between'>
                            <strong>{course.courseCode}</strong>
                            <span className='badge'>{LABELS[course.status]}</span>
                        </div>
                        <span className='small'>{course.explanation}</span>
                        <span className='small muted'>
                            {course.degreeCredits} planned degree-applicable hours
                            {course.contributions.length ? ` · ${course.contributions.map(c => c.tag).join(', ')}` : ''}
                        </span>
                        {course.warnings.map(w => (
                            <span key={w} className='small warn'>
                                {w}
                            </span>
                        ))}
                    </li>
                ))}
            </ul>
        </section>
    );
}
