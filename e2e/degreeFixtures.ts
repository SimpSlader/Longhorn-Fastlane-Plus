import type { Page } from '@playwright/test';
import { audit, rule, section } from '../src/fastlane/__tests__/fixtures/spring2027-degree';
/** Explicit synthetic unmet balances for scheduling interaction tests; the real imported audit remains tested separately. */
export async function unmetPlanningFixture(page: Page, moreScience = false) {
    const a = audit(['050', '030', '090', '040'].map(c => rule(`CORE ${c}`, c === '030' && moreScience ? 6 : 3)));
    a.program = 'Synthetic scheduling test degree';
    a.parsedAt = Date.now();
    const humanities = section(90009, 'E 316L', {
        modality: moreScience ? 'in-person' : 'async-online',
        meetings: moreScience ? [{ days: ['M', 'W', 'F'], start: 480, end: 540, location: 'GEA 105' }] : [],
        capturedAt: Date.now(),
        core: ['CORE 040'],
        requirementTags: ['COURSE E 316L', 'CORE 040'],
        course: {
            uniqueId: 90009,
            department: 'E',
            number: '316L',
            courseName: 'Synthetic test section: British Literature',
            fullName: 'E 316L Synthetic test section',
            creditHours: 3,
            instructors: [],
            semester: { season: 'Spring', year: 2027, code: '20272' },
            schedule: { meetings: [] },
            flags: [],
            isReserved: false,
        },
    });
    const biology = section(90010, 'BIO 301E', {
        capturedAt: Date.now(),
        core: ['CORE 030'],
        requirementTags: ['COURSE BIO 301E', 'CORE 030'],
        modality: 'in-person',
        meetings: [{ days: ['M', 'W', 'F'], start: 720, end: 780, location: 'GEA 105' }],
        course: {
            uniqueId: 90010,
            department: 'BIO',
            number: '301E',
            courseName: 'Synthetic test section: Biology',
            fullName: 'BIO 301E Synthetic test section',
            creditHours: 3,
            instructors: [],
            semester: { season: 'Spring', year: 2027, code: '20272' },
            schedule: { meetings: [] },
            flags: [],
            isReserved: false,
        },
    });
    await page.evaluate(
        async data => {
            await chrome.storage.local.set({ 'FastlaneAudit:audit': data.audit });
            await new Promise<void>((done, fail) => {
                const request = indexedDB.open('fastlane');
                request.onerror = () => fail(request.error);
                request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction('sections', 'readwrite');
                    const read = tx.objectStore('sections').getAll();
                    read.onsuccess = () => {
                        for (const row of read.result) tx.objectStore('sections').put({ ...row, prerequisites: '' });
                    };
                    tx.objectStore('sections').put({
                        ...data.section,
                        prerequisites: '',
                        key: '20272:90009',
                        semesterLabel: 'Spring 2027',
                    });
                    if (data.moreScience)
                        tx.objectStore('sections').put({
                            ...data.biology,
                            prerequisites: '',
                            key: '20272:90010',
                            semesterLabel: 'Spring 2027',
                        });
                    tx.oncomplete = () => {
                        db.close();
                        done();
                    };
                    tx.onerror = () => fail(tx.error);
                };
            });
        },
        { audit: a, section: humanities, biology, moreScience }
    );
}
export async function unmetArtsFixture(page: Page) {
    const a = audit();
    a.parsedAt = Date.now();
    a.program = 'Synthetic recommendation test degree';
    await page.evaluate(async data => {
        const saved = await chrome.storage.local.get('schedules');
        const schedules = saved.schedules ?? [];
        const empty = {
            id: 'test-empty-degree-plan',
            name: 'Synthetic empty plan',
            courses: [],
            hours: 0,
            updatedAt: Date.now(),
        };
        await chrome.storage.local.set({
            'FastlaneAudit:audit': data,
            schedules: [...schedules, empty],
            activeIndex: schedules.length,
        });
    }, a);
}
