import { useEffect, useState } from 'react';
import type { ParsedAudit, RequirementStatus } from '../audit/types';
import { describeRequirement } from '../core/requirements';
import { requestAi } from '../services/aiClient';
import { FastlaneAiAccessStore, FastlanePersonalAiStore } from '../storage/stores';

interface Suggestion {
    id: string;
    suggestedStatus: 'unchanged' | RequirementStatus;
    suggestedTags: string[];
    explanation: string;
    evidence: string;
    uncertainty: string;
}
interface Response {
    summary?: string;
    suggestions?: Suggestion[];
    error?: string;
}

/** AI never replaces a saved IDA. Only an explicit selection can change a reviewed requirement. */
export function applyAiAuditSuggestion(audit: ParsedAudit, s: Suggestion): ParsedAudit {
    const target = audit.requirements.find(r => r.id === s.id);
    if (!target || target.reviewed) return audit;
    const nextStatus = s.suggestedStatus === 'unchanged' ? target.status : s.suggestedStatus;
    // Pending transfer credit is never treated as an awarded completed requirement.
    const pending = audit.transfer.pending.length > 0 && nextStatus === 'completed';
    const safeStatus =
        pending || ((target.remaining?.value ?? 0) > 0 && nextStatus === 'completed') ? target.status : nextStatus;
    const proposedTags = s.suggestedTags.filter(t =>
        /^(CORE 0\d{2}|COURSE [A-Z][A-Z ]{0,5}\s+[0-9][A-Z0-9]{2,6}|DEPT [A-Z][A-Z ]{0,5})$/.test(t)
    );
    return {
        ...audit,
        requirements: audit.requirements.map(r =>
            r.id !== s.id
                ? r
                : {
                      ...r,
                      status: safeStatus,
                      tags: [...new Set([...r.tags, ...proposedTags])],
                      reviewed: true,
                      // A review is not an official UT evaluation; do not upgrade confidence to high.
                      issues: [...r.issues, 'AI suggestion reviewed by student; confirm credit applicability with UT.'],
                  }
        ),
    };
}

export default function AiAuditReview({
    audit,
    onChange,
}: {
    audit: ParsedAudit;
    onChange: (next: ParsedAudit) => Promise<unknown>;
}) {
    const [open, setOpen] = useState(false);
    const [consent, setConsent] = useState(false);
    const [invite, setInvite] = useState('');
    const savedCode = FastlaneAiAccessStore.useStore(s => s.accessCode);
    const personalEnabled = FastlanePersonalAiStore.useStore(s => s.enabled);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [summary, setSummary] = useState('');
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: clear stale AI suggestions whenever a different audit is imported
    useEffect(() => {
        setSuggestions([]);
        setSummary('');
        setError('');
    }, [audit.parsedAt]);

    const analyze = async () => {
        if (!consent || busy) return;
        const code = savedCode || invite.trim();
        if (!code && !personalEnabled) {
            setError('Enter the beta invite code once. Fastlane will remember it on this device.');
            return;
        }
        setBusy(true);
        setError('');
        setSummary('');
        setSuggestions([]);
        try {
            const requests = audit.requirements.filter(r => !r.reviewed && r.status !== 'completed').slice(0, 25);
            if (!requests.length) throw new Error('There are no remaining unreviewed requirements to analyze.');
            const result = await requestAi('audit-review', {
                accessCode: code,
                requirements: requests.map(r => ({
                    id: r.id,
                    text: r.text,
                    section: r.section,
                    status: r.status,
                    tags: r.tags,
                    remaining: r.remaining?.value ?? null,
                    applied: r.applied?.value ?? null,
                    issues: r.issues,
                    reviewed: r.reviewed === true,
                })),
                completedCodes: audit.courses
                    .filter(c => c.status === 'completed' || c.status === 'in-progress')
                    .map(c => c.code),
                pendingTransferCodes: audit.transfer.pending.map(c => c.code),
            });
            const payload = (await result.json()) as Response;
            if (result.status === 401 && savedCode && !personalEnabled) {
                await FastlaneAiAccessStore.set('accessCode', '');
                setInvite('');
            }
            if (!result.ok) throw new Error(payload.error ?? 'AI audit review is unavailable.');
            if (!savedCode && code) await FastlaneAiAccessStore.set('accessCode', code);
            setSummary(payload.summary ?? '');
            setSuggestions(
                (payload.suggestions ?? []).filter(s => audit.requirements.some(r => r.id === s.id && !r.reviewed))
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : 'AI audit review failed.');
        } finally {
            setBusy(false);
        }
    };

    const apply = async (suggestion: Suggestion) => {
        try {
            const next = applyAiAuditSuggestion(audit, suggestion);
            if (next === audit) throw new Error('This requirement has already been reviewed.');
            await onChange(next);
            setSuggestions(all => all.filter(s => s.id !== suggestion.id));
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not accept the suggestion.');
        }
    };

    return (
        <section className='card planner-glass ai-advisor'>
            <div className='row between'>
                <div>
                    <span className='eyebrow'>OPTIONAL · AI ASSISTED</span>
                    <h2>Review my IDA with AI</h2>
                    <p className='small muted'>
                        Flag unclear requirements and possible missed course matches. Your existing audit stays
                        unchanged until you approve a suggestion.
                    </p>
                </div>
                <button type='button' className='btn sm' aria-expanded={open} onClick={() => setOpen(v => !v)}>
                    {open ? 'Hide review' : 'Review with AI'}
                </button>
            </div>
            {open && (
                <div className='ai-advisor-body'>
                    <p className='small muted'>
                        The local parser remains the source of your saved IDA. Only unfinished requirement descriptions,
                        existing tags, course codes and review warnings are shared. No raw IDA file, name, EID or grades
                        are sent.
                    </p>
                    {personalEnabled ? (
                        <p className='small muted'>Using your own API key from Settings.</p>
                    ) : savedCode ? (
                        <p className='small muted'>
                            AI access saved on this device.{' '}
                            <button
                                type='button'
                                className='btn sm'
                                onClick={() => {
                                    setInvite('');
                                    void FastlaneAiAccessStore.set('accessCode', '');
                                }}
                            >
                                Forget code
                            </button>
                        </p>
                    ) : (
                        <label className='field'>
                            One-time beta invite code (not your Groq API key)
                            <input
                                type='password'
                                autoComplete='off'
                                value={invite}
                                onChange={e => setInvite(e.target.value)}
                                placeholder='Enter once to enable AI'
                            />
                        </label>
                    )}
                    <label className='check'>
                        <input type='checkbox' checked={consent} onChange={e => setConsent(e.target.checked)} />
                        <span className='small'>
                            I agree to send selected degree requirement text, course codes and parsing details to
                            {personalEnabled
                                ? 'my selected AI provider directly'
                                : 'FastLane’s server and its AI provider'}{' '}
                            for this review.
                        </span>
                    </label>
                    <button
                        type='button'
                        className='btn primary'
                        disabled={!consent || busy}
                        onClick={() => void analyze()}
                    >
                        {busy ? 'Reviewing…' : 'Check requirements with AI'}
                    </button>
                    {error && (
                        <div className='notice warn' role='alert'>
                            {error}
                        </div>
                    )}
                    {summary && <p className='small muted'>{summary}</p>}
                    {summary && suggestions.length === 0 && (
                        <p className='small muted'>
                            No evidence-backed changes were suggested. You can still review your requirements manually
                            below.
                        </p>
                    )}
                    {suggestions.map(s => {
                        const original = audit.requirements.find(r => r.id === s.id);
                        if (!original) return null;
                        return (
                            <div className='ai-result' key={s.id}>
                                <b>{original.text}</b>
                                <p className='small'>{s.explanation}</p>
                                {s.suggestedStatus !== 'unchanged' && (
                                    <p className='small'>
                                        <b>Suggested status:</b> {original.status} → {s.suggestedStatus}
                                    </p>
                                )}
                                {s.suggestedTags.length > 0 && (
                                    <p className='small'>
                                        <b>Possible matches:</b> {s.suggestedTags.map(describeRequirement).join(', ')}
                                    </p>
                                )}
                                <p className='small muted'>
                                    <b>Evidence:</b> “{s.evidence}”
                                </p>
                                {s.uncertainty && (
                                    <p className='small muted'>
                                        <b>Check:</b> {s.uncertainty}
                                    </p>
                                )}
                                <div className='row'>
                                    <button type='button' className='btn sm primary' onClick={() => void apply(s)}>
                                        Accept this change
                                    </button>
                                    <button
                                        type='button'
                                        className='btn sm'
                                        onClick={() => setSuggestions(all => all.filter(v => v.id !== s.id))}
                                    >
                                        Dismiss
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                    <p className='small muted'>
                        Accepted tags may improve course matching and suggested schedules. A possible departmental match
                        does not prove credit applicability; confirm it in UT's official IDA.
                    </p>
                </div>
            )}
        </section>
    );
}
