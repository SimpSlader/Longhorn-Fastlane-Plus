/**
 * Benchmark: realistic messages and what the assistant must do with each. Runs locally with no AI calls; it
 * checks the deterministic routing that decides whether a message is answered from records, sent to the
 * advisor, treated as a schedule change, or handled as conversation.
 */
import { describe, expect, it } from 'vitest';
import { courseCodesIn } from '../core/chatPreferences';
import { classifyIntent, type Intent } from '../core/intent';

const SUBJECTS = new Set(['ECO', 'GOV', 'HIS', 'UGS', 'M', 'C S', 'RHE', 'SDS', 'PSY', 'ACC']);
const codes = (t: string) => courseCodesIn(t, SUBJECTS);

const CASES: Array<[string, Intent['kind'], { hasPlan?: boolean }?]> = [
    // academic facts (answered from the IDA, no AI)
    ['How many hours have I completed so far?', 'completed-hours'],
    ['hyow many jours do i have compleeted?', 'completed-hours'],
    ['how many credits have i earned', 'completed-hours'],
    ['How many credit hours am I currently taking?', 'in-progress-hours'],
    ['how many hours am i enrolled in right now', 'in-progress-hours'],
    ['How many total credits will I have after this semester?', 'total-hours'],
    ['how many hours do i have left to graduate', 'remaining-hours'],
    ['how many credits do I still need', 'remaining-hours'],
    ["What's my GPA?", 'gpa'],
    ['what is my gpa right now', 'gpa'],
    ['What classes am I taking this semester?', 'current-classes'],
    ["That's wrong. I've completed 9 credits, not 33.", 'correction'],
    ['actually I have 12 hours completed', 'correction'],
    // course data
    ['Show me available sections of ECO 304K.', 'course-sections'],
    ['who teaches GOV 310L', 'course-sections'],
    ['what times is UGS 303 offered', 'course-sections'],
    ["What's the easiest class on my schedule?", 'easiest-class', { hasPlan: true }],
    // degree planning (advisor)
    ['How do I graduate early?', 'degree-planning'],
    ['Plan my path to graduate early', 'degree-planning'],
    ['How many classes should I take through ACC?', 'degree-planning'],
    ['Am I on track for the McCombs internal transfer?', 'degree-planning'],
    ['how many semesters do i have left', 'graduation-plan'],
    ['Which UT classes would protect my GPA?', 'degree-planning'],
    // schedule building and changes
    ['Build a 15-credit schedule with no Friday classes', 'schedule'],
    ['Can you make me a schedule for spring?', 'schedule'],
    ['find 3-credit electives with good grade distributions', 'schedule'],
    ['Actually, Friday mornings are fine', 'schedule', { hasPlan: true }],
    ['Wednesdays are fine', 'schedule', { hasPlan: true }],
    ['remove history', 'schedule', { hasPlan: true }],
    ['add another UGS', 'schedule', { hasPlan: true }],
    ['make it easier', 'schedule', { hasPlan: true }],
    ['Give me 1 more online class', 'schedule', { hasPlan: true }],
    ['no classes before 10am', 'schedule'],
    ['keep everything but swap the government class', 'schedule', { hasPlan: true }],
    ['Suggest harder classes I could take at ACC', 'schedule', { hasPlan: true }],
    ['how many credit hours per semester would I need to graduate in 2029', 'graduation-plan'],
    ['How many credit hours do I need per semester to graduate in Spring 2029?', 'graduation-plan'],
    ['What if I take 12 summer credits?', 'graduation-plan'],
    ['what if i did 18 credits over the summers', 'graduation-plan'],
    [
        'Build me a schedule with at least 12 credits, 1-2 online classes. Also I want to graduate a year early in 2029: how many credit hours per semester would I need with only spring and fall, and with one summer? Any tips?',
        'schedule',
    ],
    ['which ECO 304K professor gives the most As?', 'chat'],
    // the reported failures: a question that doesn't start with a question word, and a follow-up
    [
        'Based off my current track of credits and the fact I want to graduate in 2029 how many credits would I need per semester And then if I did one summer and or two summers how many credits would I need including those two Um additionally how many credits can I take Max outside of UT Um while still meeting core requirements.',
        'graduation-plan',
    ],
    [
        'Well I just asked you how many credits would I need for the Summers and semesters and all that',
        'graduation-plan',
        { hasPlan: true },
    ],
    ['how many credits would I need for the summers and semesters', 'graduation-plan'],
    ['what is a signature course?', 'chat', { hasPlan: true }],
    ['How does GPA calculation work?', 'chat', { hasPlan: true }],
    ['is ECO 304K hard?', 'chat', { hasPlan: true }],
    ['can I take more than 17 hours?', 'chat'],
    // conversation
    ['hi! what can you do?', 'chat'],
    ['what does UGS stand for', 'chat', { hasPlan: true }],
    ['why did you pick that professor?', 'chat', { hasPlan: true }],
    ['thanks, that helps', 'chat'],
    // memory
    ['remember I want to internally transfer to McCombs', 'memory'],
];

describe('assistant benchmark', () => {
    it(`routes ${CASES.length} realistic requests correctly`, () => {
        const wrong = CASES.filter(
            ([text, kind, opts]) => classifyIntent(text, { courseCodes: codes, ...opts }).kind !== kind
        ).map(
            ([text, kind, opts]) =>
                `${text} → ${classifyIntent(text, { courseCodes: codes, ...opts }).kind} (expected ${kind})`
        );
        expect(wrong).toEqual([]);
        expect(CASES.length).toBeGreaterThanOrEqual(40);
    });
});
