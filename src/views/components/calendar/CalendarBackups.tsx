import { useActiveSchedule } from '@views/hooks/useSchedules';
import { FastlanePlanStore } from 'src/fastlane/storage/stores';

/** Saved alternatives only; viewing this panel never adds a course to the calendar. */
export default function CalendarBackups() {
    const schedule = useActiveSchedule();
    const plan = FastlanePlanStore.useStore(store => store.plans[schedule.id]);
    const groups = (plan?.slots ?? [])
        .map(slot => ({
            id: slot.id,
            course: slot.candidates.find(candidate => candidate.uniqueId === slot.activeUniqueId)?.courseCode,
            alternatives: slot.candidates.filter(candidate => candidate.uniqueId !== slot.activeUniqueId),
        }))
        .filter(group => group.alternatives.length);

    return (
        <aside
            aria-label='Backups'
            className='screenshot:hidden'
            style={{
                width: 250,
                flexShrink: 0,
                padding: '24px 18px',
                overflowY: 'auto',
                borderLeft: '1px solid #eae8e1',
                background: '#fcfbf9',
                color: '#25211e',
            }}
        >
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>Backups</h2>
            <p style={{ fontSize: 12, color: '#6e655d', margin: '0 0 24px' }}>Saved alternatives for this schedule</p>
            {groups.length ? (
                groups.map(group => (
                    <section key={group.id} style={{ marginBottom: 24 }}>
                        <h3 style={{ fontSize: 12, fontWeight: 650, color: '#8e4615', marginBottom: 10 }}>
                            For {group.course || 'your planned course'}
                        </h3>
                        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {group.alternatives.map((course, index) => (
                                <li
                                    key={course.uniqueId}
                                    style={{ padding: '10px 0', borderBottom: '1px solid #eae8e1', fontSize: 13 }}
                                >
                                    <div style={{ fontWeight: 650 }}>
                                        {index + 1}. {course.courseCode}
                                    </div>
                                    <div style={{ margin: '4px 0', lineHeight: 1.4 }}>{course.title}</div>
                                    <div style={{ color: '#766c63', fontSize: 12 }}>
                                        {String(course.uniqueId).padStart(5, '0')} · {course.instructors.join(', ')}
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </section>
                ))
            ) : (
                <p style={{ fontSize: 13, lineHeight: 1.6, color: '#6e655d' }}>
                    No backups saved for this schedule yet. Use + Backup on a course listing to save an alternative.
                </p>
            )}
            <a
                href={chrome.runtime.getURL('fastlane.html#plan')}
                target='_blank'
                rel='noopener'
                style={{ color: '#a34900', fontSize: 12 }}
            >
                Manage backups ↗
            </a>
        </aside>
    );
}
