import { describe, expect, it } from 'vitest';
import type { ParsedAudit } from '../audit/types';
import { applyAiAuditSuggestion } from '../page/AiAuditReview';

const audit: ParsedAudit = {
    source: 'html',
    parsedAt: 1,
    requirements: [
        {
            id: 'a',
            section: 'Major',
            text: 'ECO electives, three hours remaining',
            category: 'major',
            status: 'not-started',
            tags: [],
            courses: [],
            confidence: 'low',
            issues: ['Needs review'],
        },
    ],
    courses: [],
    transfer: { accepted: [], pending: [] },
    creditHours: { confidence: 'low' },
    restrictions: [],
    warnings: [],
};
describe('AI audit suggestions are reviewed, never applied automatically', () => {
    it('adds a cautious department match only after explicit application', () => {
        const suggestion = {
            id: 'a',
            suggestedStatus: 'unchanged' as const,
            suggestedTags: ['DEPT ECO'],
            explanation: 'Possible ECO elective',
            evidence: 'ECO electives',
            uncertainty: 'Check degree requirements',
        };
        const next = applyAiAuditSuggestion(audit, suggestion);
        expect(audit.requirements[0]?.tags).toEqual([]);
        expect(next.requirements[0]?.tags).toEqual(['DEPT ECO']);
        expect(next.requirements[0]?.status).toBe('not-started');
        expect(next.requirements[0]?.confidence).toBe('low');
        expect(next.requirements[0]?.reviewed).toBe(true);
        expect(applyAiAuditSuggestion(next, suggestion)).toBe(next);
    });
    it('never marks a requirement completed based on pending transfer credit', () => {
        const pendingAudit: ParsedAudit = {
            ...audit,
            transfer: {
                accepted: [],
                pending: [
                    {
                        code: 'ECO 304L',
                        name: 'Macroeconomics',
                        grade: '',
                        unique: '',
                        type: 'Pending',
                        hours: 3,
                        semester: 'Spring 2027',
                        status: 'pending-transfer',
                    },
                ],
            },
        };
        const next = applyAiAuditSuggestion(pendingAudit, {
            id: 'a',
            suggestedStatus: 'completed',
            suggestedTags: [],
            explanation: 'AI thought this was completed',
            evidence: 'ECO electives',
            uncertainty: '',
        });
        expect(next.requirements[0]?.status).toBe('not-started');
    });
});
