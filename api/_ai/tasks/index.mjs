/** Browser-safe task preparation. Only the same whitelisted summaries accepted by the hosted API leave the device. */

import {
    sanitize as adviceData,
    SYSTEM_PROMPT as advicePrompt,
    responseSchema as adviceSchema,
    groundingProblem,
} from './advise.mjs';
import { SYSTEM_PROMPT as auditPrompt, schema as auditSchema, cleanAudit, formatAuditReview } from './audit-review.mjs';
import { sanitize as chatData, SYSTEM_PROMPT as chatPrompt } from './chat.mjs';
import {
    sanitize as recommendationData,
    SYSTEM_PROMPT as recommendationPrompt,
    responseSchema as recommendationSchema,
    safeString,
} from './recommend.mjs';

export function preparePersonalTask(path, body) {
    const limits = { chat: 20000, advise: 30000, recommend: 45000, 'audit-review': 26000 };
    if (!limits[path] || JSON.stringify(body ?? {}).length > limits[path])
        throw new Error('This AI request is unsupported or too large.');
    if (path === 'chat') {
        const data = chatData(body);
        if (!data) throw new Error('Say something first.');
        return {
            task: path,
            system: chatPrompt,
            user: JSON.stringify(data),
            maxTokens: 900,
            temperature: 0.4,
            containsStudentData: !!data.academic || data.memory.length > 0,
            validate: out => (out.text.trim() ? null : 'Empty answer.'),
            format: out => ({ answer: out.text.slice(0, 4000).trim() }),
        };
    }
    if (path === 'advise') {
        const data = adviceData(body);
        if (!data) throw new Error('Ask a question first.');
        return {
            task: path,
            system: advicePrompt,
            user: JSON.stringify(data),
            schema: adviceSchema,
            schemaName: 'fastlane_advice',
            maxTokens: 1400,
            temperature: 0.2,
            containsStudentData: true,
            validate: out => groundingProblem(out.json?.answer, data.facts),
            format: out => ({ answer: out.json.answer.slice(0, 2400).trim() }),
        };
    }
    if (path === 'audit-review') {
        const data = cleanAudit(body);
        if (!data?.requirements.length) throw new Error('No requirements to review.');
        return {
            task: path,
            system: auditPrompt,
            user: JSON.stringify(data),
            schema: auditSchema,
            schemaName: 'fastlane_audit_review',
            maxTokens: 2200,
            temperature: 0.1,
            containsStudentData: true,
            validate: out => (Array.isArray(out.json?.suggestions) ? null : 'Missing suggestions.'),
            format: out => formatAuditReview(out.json ?? {}, data),
        };
    }
    const data = recommendationData(body);
    if (!data?.candidates.length) throw new Error('Provide verified UT course sections to analyze.');
    const candidates = new Set(data.candidates.map(c => c.id));
    return {
        task: path,
        system: recommendationPrompt,
        user: JSON.stringify(data),
        schema: recommendationSchema,
        schemaName: 'fastlane_recommendations',
        maxTokens: 1800,
        temperature: 0.1,
        containsStudentData: true,
        validate: out => {
            const recs = out.json?.recommendations;
            if (!Array.isArray(recs)) return 'Missing recommendations.';
            return recs.length && recs.filter(r => !candidates.has(r?.id)).length > recs.length / 2
                ? 'Unverified sections.'
                : null;
        },
        format: out => {
            const used = new Set();
            return {
                recommendations: (out.json?.recommendations ?? [])
                    .filter(
                        r =>
                            r && Number.isSafeInteger(r.id) && candidates.has(r.id) && !used.has(r.id) && used.add(r.id)
                    )
                    .slice(0, 12)
                    .map(r => ({
                        id: r.id,
                        reason: safeString(r.reason, 250),
                        requirement: safeString(r.requirement, 110),
                        confidence: ['high', 'possible', 'unlikely'].includes(r.confidence) ? r.confidence : 'possible',
                        warning: safeString(r.warning, 200),
                    })),
                summary: safeString(out.json?.summary, 350),
                source: 'Verified locally cached UT sections; degree applicability is advisory',
            };
        },
    };
}
