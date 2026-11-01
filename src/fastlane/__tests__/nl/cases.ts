/**
 * Natural-language benchmark cases. Each turn pairs a realistic student message with the tool call a correct
 * interpreter would make ("gold") and the declarative outcome the schedule must have. The unit run feeds the
 * gold calls through the real tools, solver and validator (it measures the scheduling engine and follow-up
 * semantics). scripts/fastlane/nl-benchmark.mjs asks a live model for its calls and scores them against the gold
 * (it measures interpretation) — that needs a real AI access code and is NOT part of the unit run.
 */
export interface Expect {
    plan?: boolean;
    incomplete?: boolean;
    credits?: [number, number];
    include?: string[];
    exclude?: string[];
    includeAny?: string[];
    /** every in-person meeting is on these days */
    days?: string[];
    async?: [number, number];
    subjectCount?: Record<string, number>;
    error?: string;
    unchanged?: boolean;
    keep?: string[];
    startAtLeast?: { day: string; minutes: number };
    noMeetingBefore?: number;
    noMeetingAfter?: number;
    instructor?: { code: string; who: string };
    coreAll?: boolean;
    maxGap?: number;
    allRulesMet?: boolean;
    /** a different set of sections than the previous plan */
    different?: boolean;
    /** either a valid schedule or an honest explanation that leaves the calendar unchanged is acceptable */
    optional?: boolean;
    /** the student did not mention electives: a draft that only asks permission to use them is acceptable */
    electivesDraftOk?: boolean;
    /** this course is taught by an asynchronous online section */
    asyncCourse?: string;
}
export interface Turn {
    say: string;
    tool: 'build_schedule' | 'modify_schedule';
    args: Record<string, unknown>;
    expect: Expect;
}
export interface Case {
    id: string;
    category: 'natural' | 'follow-up' | 'conflict' | 'vague' | 'impossible' | 'phrasing' | 'multi-turn';
    turns: Turn[];
}

const TTH = ['T', 'TH'];
const build = (say: string, args: Record<string, unknown>, expect: Expect): Turn => ({
    say,
    tool: 'build_schedule',
    args,
    expect,
});
const change = (say: string, args: Record<string, unknown>, expect: Expect): Turn => ({
    say,
    tool: 'modify_schedule',
    args,
    expect,
});
const base15 = (say: string): Turn =>
    build(
        say,
        {
            minCredits: 15,
            maxCredits: 15,
            onlyDays: TTH,
            coreOnly: false,
            onlineMax: 2,
            backToBack: true,
        },
        { credits: [15, 15], days: TTH, async: [0, 2] }
    );
const ecoBase = (say: string): Turn =>
    build(
        say,
        {
            minCredits: 12,
            maxCredits: 12,
            onlyDays: TTH,
            requiredCourses: ['ECO 304L'],
            onlineMax: 2,
            latestEnd: '12:30 pm',
        },
        { credits: [12, 12], include: ['ECO 304L'] }
    );
const core15 = (say: string): Turn =>
    build(
        say,
        { minCredits: 15, maxCredits: 15, onlyDays: TTH, coreOnly: true, onlineMax: 2, backToBack: true },
        { credits: [15, 15], days: TTH, coreAll: true, async: [0, 2] }
    );

export const cases: Case[] = [
    // ---- natural builds: the same kinds of request, phrased differently ----
    {
        id: 'N01',
        category: 'natural',
        turns: [
            core15(
                'I only want classes Tuesday and Thursday, preferably back-to-back, with two online classes, 15 hours, just core'
            ),
        ],
    },
    {
        id: 'N02',
        category: 'natural',
        turns: [
            build(
                'Can you set me up with 15 credits? I can only be on campus Tuesdays and Thursdays and I need a signature course.',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    includeSubjects: ['UGS'],
                    onlineMax: 2,
                },
                { credits: [15, 15], days: TTH, subjectCount: { UGS: 1 } }
            ),
        ],
    },
    {
        id: 'N03',
        category: 'natural',
        turns: [
            build(
                'Something around 12 hours, no history please, only stuff that counts for my core',
                { minCredits: 12, maxCredits: 12, coreOnly: true, excludeSubjects: ['HIS'] },
                { credits: [12, 12], exclude: ['HIS 315L', 'HIS 315K'], coreAll: true }
            ),
        ],
    },
    {
        id: 'N04',
        category: 'natural',
        turns: [
            build(
                "I don't care what electives I take as long as they're easy A's. 15 hours, Tuesday/Thursday.",
                { minCredits: 15, maxCredits: 15, onlyDays: TTH, objective: 'gpa', onlineMax: 2 },
                { credits: [15, 15], days: TTH, exclude: ['AMS 310'] }
            ),
        ],
    },
    {
        id: 'N05',
        category: 'natural',
        turns: [
            build(
                'I need ECO 304L and GOV 312L. Everything else can be whatever helps my GPA. 15 hours on Tue/Thu.',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    requiredCourses: ['ECO 304L', 'GOV 312L'],
                    objective: 'gpa',
                    onlineMax: 2,
                },
                { credits: [15, 15], days: TTH, include: ['ECO 304L', 'GOV 312L'] }
            ),
        ],
    },
    {
        id: 'N06',
        category: 'natural',
        turns: [
            build(
                'Monday Wednesday Friday only, 12 to 13 hours, nothing online',
                { minCredits: 12, maxCredits: 13, onlyDays: ['M', 'W', 'F'], onlineMax: 0 },
                { incomplete: true, allRulesMet: false }
            ),
        ],
    },
    {
        id: 'N07',
        category: 'natural',
        turns: [
            build(
                'I hate mornings, nothing before 11 please. 12 hours.',
                { minCredits: 12, maxCredits: 12, earliestStart: '11:00 am' },
                { credits: [12, 12], noMeetingBefore: 660 }
            ),
        ],
    },
    {
        id: 'N08',
        category: 'natural',
        turns: [
            build(
                'Done by 3:30 every day, 12 hours, I work afternoons',
                { minCredits: 12, maxCredits: 12, latestEnd: '3:30 pm' },
                { credits: [12, 12], noMeetingAfter: 930 }
            ),
        ],
    },
    {
        id: 'N09',
        category: 'natural',
        turns: [
            build(
                'Light semester, 9 hours, I am taking an ACC class too',
                { minCredits: 9, maxCredits: 9 },
                { credits: [9, 9] }
            ),
        ],
    },
    {
        id: 'N10',
        category: 'natural',
        turns: [
            build(
                'Mondays and Wednesdays are out for me. 15 hours, mostly core.',
                { minCredits: 15, maxCredits: 15, avoidDays: ['M', 'W'] },
                { credits: [15, 15] }
            ),
        ],
    },
    {
        id: 'N11',
        category: 'natural',
        turns: [
            build(
                'Highest A rates possible, 15 hours, Tue Thu only, core only, I need a UGS and I am fine with 1-2 online',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    coreOnly: true,
                    includeSubjects: ['UGS'],
                    objective: 'gpa',
                    onlineMin: 1,
                    onlineMax: 2,
                },
                { subjectCount: { UGS: 1 }, coreAll: true, days: TTH }
            ),
        ],
    },
    {
        id: 'N12',
        category: 'natural',
        turns: [
            build(
                'Put me in nutrition and some other easy online stuff, 12 credits',
                {
                    minCredits: 12,
                    maxCredits: 12,
                    requiredCourses: ['nutrition'],
                    objective: 'gpa',
                    onlineMin: 1,
                },
                { credits: [12, 12], include: ['NTR 306'] }
            ),
        ],
    },
    // ---- follow-ups: modify the existing schedule, keep every earlier rule ----
    {
        id: 'F01',
        category: 'follow-up',
        turns: [
            base15('15 hours Tuesday and Thursday, electives are fine, two online max, back to back'),
            change(
                'Actually, make my Tuesdays start later.',
                { dayWindows: { T: { from: '11:00 am' } } },
                { credits: [15, 15], days: TTH, startAtLeast: { day: 'T', minutes: 660 } }
            ),
        ],
    },
    {
        id: 'F02',
        category: 'follow-up',
        turns: [
            ecoBase('12 hours, Tue/Thu, I need economics but I have to be done by 12:30 for now'),
            change(
                'Find me an easier professor for economics — I can stay later.',
                { swapSectionFor: 'economics', sectionGoal: 'easier', latestEnd: '5:00 pm' },
                { credits: [12, 12], instructor: { code: 'ECO 304L', who: 'EASY, ALEX' } }
            ),
        ],
    },
    {
        id: 'F03',
        category: 'follow-up',
        turns: [
            build(
                '12 hours TTh please',
                { minCredits: 12, maxCredits: 12, onlyDays: TTH, onlineMax: 2 },
                { credits: [12, 12], days: TTH }
            ),
            change(
                'Keep everything else the same, but get me to 15 hours.',
                { changeCredits: { min: 15, max: 15 } },
                { credits: [15, 15], days: TTH }
            ),
        ],
    },
    {
        id: 'F04',
        category: 'follow-up',
        turns: [
            core15('15 hours TTh core only'),
            change(
                'Actually Wednesdays are fine too.',
                { changeOnlyDays: ['T', 'W', 'TH'] },
                { credits: [15, 15], coreAll: true }
            ),
        ],
    },
    {
        id: 'F05',
        category: 'follow-up',
        turns: [
            core15('15 hours TTh core only'),
            change(
                'Swap out the government class for something else.',
                { remove: ['GOV 312L'] },
                { exclude: ['GOV 312L'], optional: true }
            ),
        ],
    },
    {
        id: 'F06',
        category: 'follow-up',
        turns: [
            build(
                '15 hours TTh with UGS 302',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    requiredCourses: ['UGS 302'],
                    onlineMax: 2,
                },
                { include: ['UGS 302'] }
            ),
            change(
                'Can I take the other signature course instead?',
                { replaceCourse: 'UGS 302', addCourse: 'UGS 303' },
                { include: ['UGS 303'], exclude: ['UGS 302'] }
            ),
        ],
    },
    {
        id: 'F07',
        category: 'follow-up',
        turns: [
            base15('15 hours TTh electives ok'),
            change('Make it easier overall.', { objective: 'gpa' }, { credits: [15, 15], days: TTH }),
        ],
    },
    {
        id: 'F08',
        category: 'follow-up',
        turns: [
            base15('15 hours TTh electives ok'),
            change(
                'Give me another option.',
                { anotherOption: true },
                { credits: [15, 15], days: TTH, different: true }
            ),
        ],
    },
    {
        id: 'F09',
        category: 'follow-up',
        turns: [
            core15('15 hours TTh core'),
            change('Add a nutrition class.', { addCourse: 'nutrition' }, { include: ['NTR 306'] }),
        ],
    },
    {
        id: 'F10',
        category: 'follow-up',
        turns: [
            base15('15 hours TTh up to two online'),
            change(
                'Actually no online classes at all.',
                { onlineMax: 0 },
                { credits: [15, 15], async: [0, 0], days: TTH }
            ),
        ],
    },
    {
        id: 'F11',
        category: 'follow-up',
        turns: [
            base15('15 hours TTh electives ok'),
            change(
                'Never mind, I only want things that count for my degree core.',
                { coreOnly: true, allowElectives: false },
                { coreAll: true }
            ),
        ],
    },
    {
        id: 'F12',
        category: 'follow-up',
        turns: [
            build(
                '15 hours TTh with a signature course',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    includeSubjects: ['UGS'],
                    onlineMax: 2,
                },
                { subjectCount: { UGS: 1 } }
            ),
            change(
                'I changed my mind, drop the signature course.',
                { exactCounts: { UGS: 0 }, remove: ['UGS'] },
                { exclude: ['UGS 302', 'UGS 303'], credits: [15, 15] }
            ),
        ],
    },
    {
        id: 'F13',
        category: 'follow-up',
        turns: [
            ecoBase('12 hours TTh, I need ECO 304L, done by 12:30 for now'),
            change(
                'Find me a better rated professor for ECO 304L',
                { swapSectionFor: 'ECO 304L', sectionGoal: 'better rated', latestEnd: '5:00 pm' },
                { optional: true }
            ),
        ],
    },
    {
        id: 'F14',
        category: 'follow-up',
        turns: [
            core15('15 hours TTh core only'),
            change(
                'Nothing after 3:30 anymore.',
                { latestEnd: '3:30 pm' },
                { noMeetingAfter: 930, days: TTH, optional: true }
            ),
        ],
    },
    {
        id: 'F15',
        category: 'follow-up',
        turns: [
            ecoBase('12 hours TTh with economics, done by 12:30'),
            change(
                'Actually I want economics online instead.',
                { swapSectionFor: 'economics', sectionGoal: 'online', latestEnd: '5:00 pm' },
                { asyncCourse: 'ECO 304L', optional: true }
            ),
        ],
    },
    {
        id: 'F16',
        category: 'follow-up',
        turns: [
            build(
                '15 hours TTh with a signature course',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    includeSubjects: ['UGS'],
                    onlineMax: 2,
                },
                { subjectCount: { UGS: 1 } }
            ),
            change(
                'Drop the signature course, I already took it.',
                { remove: ['UGS 302'] },
                { exclude: ['UGS 302', 'UGS 303'], credits: [15, 15] }
            ),
        ],
    },
    // ---- multi-turn conversations ----
    {
        id: 'M01',
        category: 'multi-turn',
        turns: [
            build(
                'Build me a 15 hour TTh schedule, I need economics, electives are fine',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    requiredCourses: ['ECO 304L'],
                    onlineMax: 2,
                },
                { include: ['ECO 304L'] }
            ),
            change(
                'Make Tuesdays start later',
                { dayWindows: { T: { from: '11:00 am' } } },
                { startAtLeast: { day: 'T', minutes: 660 } }
            ),
            change(
                'Easier professor for economics',
                { swapSectionFor: 'economics', sectionGoal: 'easier' },
                { optional: true }
            ),
            change('Now another option please', { anotherOption: true }, { optional: true }),
        ],
    },
    {
        id: 'M02',
        category: 'multi-turn',
        turns: [
            build(
                '12 hours, TTh',
                { minCredits: 12, maxCredits: 12, onlyDays: TTH, onlineMax: 2 },
                { credits: [12, 12] }
            ),
            change(
                'Get me to 15 hours but keep the rest',
                { changeCredits: { min: 15, max: 15 } },
                { credits: [15, 15], days: TTH }
            ),
            change('No classes after 5', { latestEnd: '5:00 pm' }, { noMeetingAfter: 1020, days: TTH }),
        ],
    },
    {
        id: 'M03',
        category: 'multi-turn',
        turns: [
            core15('Core only, 15 hours TTh'),
            change('Add nutrition', { addCourse: 'nutrition' }, { include: ['NTR 306'], days: TTH }),
            change('Actually allow Wednesdays', { changeOnlyDays: ['T', 'W', 'TH'] }, { include: ['NTR 306'] }),
        ],
    },
    {
        id: 'M04',
        category: 'multi-turn',
        turns: [
            build(
                '15 hours TTh with economics',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    requiredCourses: ['ECO 304L'],
                    onlineMax: 2,
                },
                { include: ['ECO 304L'] }
            ),
            change(
                'Only online economics please',
                { swapSectionFor: 'ECO 304L', sectionGoal: 'online' },
                { optional: true }
            ),
        ],
    },
    {
        id: 'M05',
        category: 'multi-turn',
        turns: [
            base15('15 hours TTh electives ok'),
            change('Make it easier', { objective: 'gpa' }, { days: TTH }),
            change('And no more than one online class', { onlineMax: 1 }, { async: [0, 1], days: TTH }),
        ],
    },
    {
        id: 'M06',
        category: 'multi-turn',
        turns: [
            build(
                '15 hours TTh, I must take GOV 312L',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    requiredCourses: ['GOV 312L'],
                    onlineMax: 2,
                },
                { include: ['GOV 312L'] }
            ),
            change(
                'Swap that professor for a better rated one',
                { swapSectionFor: 'GOV 312L', sectionGoal: 'better rated' },
                { optional: true }
            ),
        ],
    },
    // ---- conflicting or ambiguous requirements ----
    {
        id: 'C01',
        category: 'conflict',
        turns: [
            base15('15 hours TTh electives ok'),
            change('Add M 408C', { addCourse: 'M 408C' }, { plan: false, error: 'only be added|can only|NOT' }),
        ],
    },
    {
        id: 'C02',
        category: 'conflict',
        turns: [
            build(
                'Tuesday and Thursday only but I need M 408C calculus, 15 hours',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    requiredCourses: ['M 408C'],
                    onlineMax: 2,
                },
                { incomplete: true, allRulesMet: false }
            ),
        ],
    },
    {
        id: 'C03',
        category: 'conflict',
        turns: [
            build(
                'I need AMS 310 and HIS 315L, both, 12 hours Tue/Thu',
                {
                    minCredits: 12,
                    maxCredits: 12,
                    onlyDays: TTH,
                    requiredCourses: ['AMS 310', 'HIS 315L'],
                    onlineMax: 2,
                },
                { incomplete: true, allRulesMet: false }
            ),
        ],
    },
    {
        id: 'C04',
        category: 'conflict',
        turns: [
            build(
                '15 hours online only, but no more than 2 online classes',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlineMax: 2,
                    avoidDays: ['M', 'T', 'W', 'TH', 'F'],
                },
                { plan: false, error: 'couldn’t build' }
            ),
        ],
    },
    {
        id: 'C05',
        category: 'conflict',
        turns: [
            build(
                'Core only, no history, 15 hours, Tue/Thu — and a UGS',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    coreOnly: true,
                    excludeSubjects: ['HIS'],
                    includeSubjects: ['UGS'],
                    onlineMax: 2,
                },
                { subjectCount: { UGS: 1 }, coreAll: true, days: TTH }
            ),
        ],
    },
    {
        id: 'C06',
        category: 'conflict',
        turns: [
            build(
                'Everything must end by 10 am and I need 15 hours',
                { minCredits: 15, maxCredits: 15, latestEnd: '10:00 am', onlineMax: 2 },
                { incomplete: true, allRulesMet: false }
            ),
        ],
    },
    // ---- vague requests ----
    {
        id: 'V01',
        category: 'vague',
        turns: [build('Build me a good schedule', {}, { credits: [12, 16] })],
    },
    {
        id: 'V02',
        category: 'vague',
        turns: [build('something easy', { objective: 'gpa' }, { credits: [12, 16] })],
    },
    {
        id: 'V03',
        category: 'vague',
        turns: [
            build(
                'I want to finish my core as fast as possible',
                { coreOnly: true, objective: 'degree', minCredits: 12, maxCredits: 16 },
                { coreAll: true }
            ),
        ],
    },
    {
        id: 'V04',
        category: 'vague',
        turns: [build('I work Fridays', { avoidDays: ['F'] }, { credits: [12, 16] })],
    },
    {
        id: 'V05',
        category: 'vague',
        turns: [build('a normal full load', { minCredits: 15, maxCredits: 15 }, { credits: [15, 15] })],
    },
    {
        id: 'V06',
        category: 'vague',
        turns: [
            build(
                'as few days on campus as possible, 15 hours',
                { minCredits: 15, maxCredits: 15, onlyDays: TTH, onlineMax: 3 },
                { credits: [15, 15], days: TTH }
            ),
        ],
    },
    // ---- impossible requests: explain and offer a labelled draft, never claim success ----
    {
        id: 'I01',
        category: 'impossible',
        turns: [
            build(
                '30 credit hours, Tuesday Thursday only',
                { minCredits: 30, maxCredits: 30, onlyDays: TTH },
                { incomplete: true, allRulesMet: false }
            ),
        ],
    },
    {
        id: 'I02',
        category: 'impossible',
        turns: [
            build(
                'I need a class called underwater basket weaving, 12 hours',
                {
                    minCredits: 12,
                    maxCredits: 12,
                    requiredCourses: ['underwater basket weaving'],
                },
                { incomplete: true, allRulesMet: false }
            ),
        ],
    },
    {
        id: 'I03',
        category: 'impossible',
        turns: [
            build(
                'In-person classes only between 7 and 8 am',
                {
                    minCredits: 12,
                    maxCredits: 12,
                    earliestStart: '7:00 am',
                    latestEnd: '8:00 am',
                    onlineMax: 0,
                },
                { plan: false, error: 'couldn’t build' }
            ),
        ],
    },
    {
        id: 'I04',
        category: 'impossible',
        turns: [
            base15('15 hours TTh electives ok'),
            change('Make it 24 hours', { changeCredits: { min: 24, max: 24 } }, { plan: false }),
        ],
    },
    {
        id: 'I05',
        category: 'impossible',
        turns: [
            build(
                'No online and no in-person classes',
                {
                    minCredits: 12,
                    maxCredits: 12,
                    onlineMax: 0,
                    avoidDays: ['M', 'T', 'W', 'TH', 'F'],
                },
                { plan: false, error: 'couldn’t build' }
            ),
        ],
    },
    // ---- phrasing that fools keyword matching (a model must read meaning, not words) ----
    {
        id: 'P01',
        category: 'phrasing',
        turns: [
            build(
                "Tuesday and Thursday are the only days I can't do. 12 hours.",
                { minCredits: 12, maxCredits: 12, avoidDays: TTH },
                { credits: [12, 12] }
            ),
        ],
    },
    {
        id: 'P02',
        category: 'phrasing',
        turns: [
            build(
                'I already finished my signature course, so no UGS. 12 hours, TTh.',
                {
                    minCredits: 12,
                    maxCredits: 12,
                    onlyDays: TTH,
                    excludeSubjects: ['UGS'],
                    onlineMax: 2,
                },
                { credits: [12, 12], exclude: ['UGS 302', 'UGS 303'] }
            ),
        ],
    },
    {
        id: 'P03',
        category: 'phrasing',
        turns: [
            build(
                "I'd rather not have only core classes — mix in some fun electives. 15 hours.",
                { minCredits: 15, maxCredits: 15, coreOnly: false },
                { credits: [15, 15] }
            ),
        ],
    },
    {
        id: 'P04',
        category: 'phrasing',
        turns: [
            build(
                'Skip the signature course, I took it in high school. 12 hours TTh.',
                {
                    minCredits: 12,
                    maxCredits: 12,
                    onlyDays: TTH,
                    excludeSubjects: ['UGS'],
                    onlineMax: 2,
                },
                { exclude: ['UGS 302', 'UGS 303'], days: TTH }
            ),
        ],
    },
    {
        id: 'P05',
        category: 'phrasing',
        turns: [
            build(
                'Anything but economics please',
                { minCredits: 12, maxCredits: 15, excludeSubjects: ['ECO'] },
                { exclude: ['ECO 304L'] }
            ),
        ],
    },
    {
        id: 'P06',
        category: 'phrasing',
        turns: [
            build(
                'Fridays off, and nothing before 10, 14 or 15 credits',
                { minCredits: 14, maxCredits: 15, avoidDays: ['F'], earliestStart: '10:00 am' },
                { credits: [14, 15], noMeetingBefore: 600 }
            ),
        ],
    },
    {
        id: 'P07',
        category: 'phrasing',
        turns: [
            build(
                'I can do two online classes at most',
                { minCredits: 12, maxCredits: 15, onlineMax: 2 },
                { async: [0, 2] }
            ),
        ],
    },
    {
        id: 'P08',
        category: 'phrasing',
        turns: [
            build(
                'Put my classes back to back, no gaps over 15 minutes, TTh, 12 hours',
                {
                    minCredits: 12,
                    maxCredits: 12,
                    onlyDays: TTH,
                    backToBack: true,
                    maxGapMinutes: 15,
                    onlineMax: 2,
                },
                { credits: [12, 12], days: TTH, maxGap: 15 }
            ),
        ],
    },
    {
        id: 'M07',
        category: 'multi-turn',
        turns: [
            build(
                '15 hours, Tuesday/Thursday only, up to two online, I need ECO 304L, easy classes for the rest, back to back',
                {
                    minCredits: 15,
                    maxCredits: 15,
                    onlyDays: TTH,
                    onlineMax: 2,
                    requiredCourses: ['ECO 304L'],
                    objective: 'gpa',
                    backToBack: true,
                },
                { credits: [15, 15], days: TTH, async: [0, 2], include: ['ECO 304L'] }
            ),
            change(
                'Make my Tuesdays start later.',
                { dayWindows: { T: { from: '11:00 am' } } },
                { credits: [15, 15], days: TTH, include: ['ECO 304L'], startAtLeast: { day: 'T', minutes: 660 } }
            ),
            change(
                'Actually I only need 12 hours.',
                { changeCredits: { min: 12, max: 12 } },
                { credits: [12, 12], days: TTH, include: ['ECO 304L'], startAtLeast: { day: 'T', minutes: 660 } }
            ),
            change(
                'Find me an easier professor for economics.',
                { swapSectionFor: 'economics', sectionGoal: 'easier' },
                { credits: [12, 12], include: ['ECO 304L'], optional: true }
            ),
            change(
                'Back to 15 hours please.',
                { changeCredits: { min: 15, max: 15 } },
                { credits: [15, 15], days: TTH, include: ['ECO 304L'], startAtLeast: { day: 'T', minutes: 660 } }
            ),
            change(
                'Give me a different option.',
                { anotherOption: true },
                {
                    credits: [15, 15],
                    days: TTH,
                    include: ['ECO 304L'],
                    optional: true,
                    startAtLeast: { day: 'T', minutes: 660 },
                }
            ),
        ],
    },
    {
        id: 'M08',
        category: 'multi-turn',
        turns: [
            build(
                '15 hours Tuesday and Thursday, no online classes',
                { minCredits: 15, maxCredits: 15, onlyDays: TTH, onlineMax: 0 },
                { credits: [15, 15], days: TTH, async: [0, 0], optional: true }
            ),
            change('Okay, one online class is fine.', { onlineMax: 1 }, { days: TTH, async: [0, 1], optional: true }),
            change('Wednesdays are fine too.', { changeOnlyDays: ['T', 'W', 'TH'] }, { async: [0, 1], optional: true }),
            change(
                'Actually no, back to just Tuesday and Thursday.',
                { changeOnlyDays: TTH },
                { days: TTH, async: [0, 1], optional: true }
            ),
            change(
                'And nothing after 4.',
                { latestEnd: '4:00 pm' },
                { days: TTH, async: [0, 1], noMeetingAfter: 960, optional: true }
            ),
        ],
    },
];
