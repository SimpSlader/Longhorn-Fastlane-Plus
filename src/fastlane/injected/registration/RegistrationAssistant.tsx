/**
 * Floating manual registration assistant shown on UT's add/drop screen.
 *
 * Safety: this component never clicks UT buttons, submits forms, presses Enter, refreshes the page,
 * or sends requests to UT. Optional autofill only types a unique number into the add field; the
 * student always submits. Optional result reading only suggests an outcome for the student to confirm.
 */
import { useActiveSchedule } from '@views/hooks/useSchedules';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AutofillDecision } from '../../core/autofill';
import { AUTOFILL_SKIP_MESSAGES, decideAutofill, fillInput, findUniqueAddInput } from '../../core/autofill';
import type { DetectedKind } from '../../core/detect';
import { suggestOutcome } from '../../core/detect';
import type { Outcome, QueueState } from '../../core/queue';
import {
    addItem,
    currentItem,
    exhaustedGroups,
    nextFallback,
    OUTCOME_LABELS,
    recordAutofill,
    recordCopy,
    recordOutcome,
    undo,
} from '../../core/queue';
import type { Recommendation } from '../../core/recommend';
import { describeRequirement } from '../../core/requirements';
import { formatUnique } from '../../core/sections';
import { buildRecommendations } from '../../services/recommendationService';
import { fastlanePageUrl } from '../../services/runtime';
import { FastlaneAuditStore, FastlanePlanStore, FastlaneQueueStore, FastlaneSettingsStore } from '../../storage/stores';
import { assistantAction, contextAlive, expireAssistant } from './contextLifetime';
import { MESSAGE_SELECTORS } from './messageSelectors';

function visibleMessages(host: HTMLElement): string[] {
    const out = new Set<string>();
    for (const node of document.querySelectorAll<HTMLElement>(MESSAGE_SELECTORS)) {
        if (host.contains(node)) continue;
        const t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 400) out.add(t);
        if (out.size > 150) break;
    }
    return [...out];
}

async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const t = document.createElement('textarea');
        t.value = text;
        t.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.append(t);
        t.select();
        const ok = document.execCommand('copy');
        t.remove();
        return ok;
    }
}

function readCollapsed(): boolean {
    try {
        return sessionStorage.getItem('fastlane-assistant-collapsed') === '1';
    } catch {
        return false;
    }
}

export default function RegistrationAssistant({ host }: { host: HTMLElement }) {
    const settings = FastlaneSettingsStore.useStore(s => s);
    const { queue, lastFilled } = FastlaneQueueStore.useStore(s => s) as unknown as {
        queue: QueueState;
        lastFilled: string | null;
    };
    const audit = FastlaneAuditStore.useStore(s => s.audit);
    const plans = FastlanePlanStore.useStore(s => s.plans ?? {});
    const schedule = useActiveSchedule();
    const [collapsed, setCollapsed] = useState(readCollapsed);
    const [notice, setNotice] = useState<{ text: string; tone?: 'info' | 'warn' } | null>(null);
    const [suggestion, setSuggestion] = useState<{ kind: DetectedKind; message: string } | null>(null);
    const [recs, setRecs] = useState<Recommendation[] | null>(null);
    const baseline = useRef<Set<string>>(new Set());
    const lastAutoItem = useRef<string | null>(null);

    const current = currentItem(queue);
    const fallback = nextFallback(queue);
    const exhausted = exhaustedGroups(queue);
    const code = current ? formatUnique(current.uniqueId) : null;

    const save = useCallback(
        async (next: QueueState, filled?: string | null) => {
            await assistantAction(host, async () => {
                await FastlaneQueueStore.set('queue', next as never);
                if (filled !== undefined) await FastlaneQueueStore.set('lastFilled', filled);
            });
        },
        [host]
    );

    // ---------- autofill ----------
    const runAutofill = useCallback(
        async (manual: boolean): Promise<AutofillDecision> => {
            if (!contextAlive()) {
                expireAssistant(host);
                return { action: 'skip', reason: 'disabled' };
            }
            const field = findUniqueAddInput(document, host);
            const decision = decideAutofill({
                settings: settings.autofill,
                code,
                fieldValue: field ? field.value : null,
                lastFilled,
                manual,
            });
            if (decision.action === 'fill' && field && current) {
                baseline.current = new Set(visibleMessages(host).map(t => t.toLowerCase()));
                fillInput(field, decision.code);
                await save(recordAutofill(queue, current.id), decision.code);
                setNotice({
                    text: `Filled ${decision.code}. Review it, then press UT’s submit button yourself.`,
                    tone: 'info',
                });
            } else if (
                decision.action === 'skip' &&
                (manual || decision.reason === 'non-empty' || decision.reason === 'no-field')
            ) {
                if (!(decision.reason === 'no-field' && !manual))
                    setNotice({ text: AUTOFILL_SKIP_MESSAGES[decision.reason], tone: 'warn' });
            }
            return decision;
        },
        [code, current, host, lastFilled, queue, save, settings.autofill]
    );

    useEffect(() => {
        // fill automatically when a new item becomes current (after Success/Full/Conflict/Restriction or on page load)
        if (!current || !settings.autofill.enabled || settings.autofill.paused) return;
        if (lastAutoItem.current === current.id) return;
        lastAutoItem.current = current.id;
        void runAutofill(false);
    }, [current, settings.autofill.enabled, settings.autofill.paused, runAutofill]);

    // ---------- optional result reading (suggestions only) ----------
    useEffect(() => {
        if (!settings.passiveDetection || !queue.pending) {
            setSuggestion(null);
            return;
        }
        const pendingItem = queue.items.find(i => i.id === queue.pending?.itemId);
        if (!pendingItem) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const scan = () => {
            const s = suggestOutcome(visibleMessages(host), {
                uniqueId: pendingItem.uniqueId,
                baseline: baseline.current,
            });
            setSuggestion(s);
        };
        scan();
        // throttle (not debounce): a page that keeps changing must not postpone the scan forever
        const observer = new MutationObserver(records => {
            if (records.every(r => host.contains(r.target)) || timer !== undefined) return;
            timer = setTimeout(() => {
                timer = undefined;
                scan();
            }, 200);
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, [settings.passiveDetection, queue.pending, queue.items, host]);

    // ---------- recommendations when alternatives run out ----------
    const exhaustedKey = exhausted.map(e => e.group).join('|');
    // biome-ignore lint/correctness/useExhaustiveDependencies: recompute only when the set of exhausted groups or the schedule changes, not on every queue edit
    useEffect(() => {
        if (!exhausted.length) {
            setRecs(null);
            return;
        }
        let alive = true;
        void buildRecommendations({
            requirements: [...new Set(exhausted.map(e => e.requirement).filter(Boolean))],
            schedule,
            settings,
            audit,
            queue,
            plan: schedule ? (plans as never)[schedule.id] : undefined,
            limit: 4,
        }).then(r => {
            if (alive) setRecs(r);
        });
        return () => {
            alive = false;
        };
    }, [exhaustedKey, schedule?.id]);

    // ---------- actions ----------
    const onCopy = useCallback(async () => {
        if (!current || !code) return;
        // snapshot existing messages at click time, before any await, so a result that appears while the
        // clipboard write is in flight is not mistaken for an old message
        baseline.current = new Set(visibleMessages(host).map(t => t.toLowerCase()));
        const copied = await copyText(code);
        // record the attempt either way: if the clipboard is blocked the student copies the number by hand
        await save(recordCopy(queue, current.id));
        setNotice(
            copied
                ? { text: `Copied ${code}. Paste it at UT and submit it yourself.`, tone: 'info' }
                : { text: 'Clipboard blocked. Select the number above and copy it manually.', tone: 'warn' }
        );
    }, [code, current, host, queue, save]);

    const mark = async (outcome: Outcome, source: 'manual' | 'detected' = 'manual') => {
        if (!current) return;
        const next = recordOutcome(queue, current.id, outcome, Date.now(), source);
        setSuggestion(null);
        const upcoming = currentItem(next);
        // set before saving: saving re-renders and may trigger autofill, whose message must win
        setNotice({
            text: `${OUTCOME_LABELS[outcome]}: ${code}. ${upcoming ? `Next: ${formatUnique(upcoming.uniqueId)} (${upcoming.label}).` : 'No more planned codes.'}`,
        });
        await save(next);
    };

    const onUndo = async () => {
        await save(undo(queue));
        lastAutoItem.current = null;
        setNotice({ text: 'Undone.' });
    };

    const queueRecommendation = async (rec: Recommendation, group: string, requirement: string) => {
        const lastIndexInGroup = queue.items.map(i => i.group).lastIndexOf(group);
        try {
            const next = addItem(
                queue,
                {
                    uniqueId: rec.section.uniqueId,
                    label: rec.section.title,
                    courseCode: rec.section.courseCode,
                    group,
                    requirement,
                    note: 'Added from recommendations',
                },
                lastIndexInGroup + 1
            );
            await save(next);
            lastAutoItem.current = null;
            setNotice({
                text: `Queued ${formatUnique(rec.section.uniqueId)}. ${settings.autofill.enabled ? '' : 'Copy it to register.'}`,
            });
        } catch (e) {
            setNotice({ text: (e as Error).message, tone: 'warn' });
        }
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.repeat) return;
            if (e.code === 'KeyC') {
                e.preventDefault();
                void onCopy();
            } else if (e.code === 'KeyF') {
                e.preventDefault();
                void runAutofill(true);
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onCopy, runAutofill]);

    const toggleCollapsed = () => {
        setCollapsed(c => {
            try {
                sessionStorage.setItem('fastlane-assistant-collapsed', c ? '0' : '1');
            } catch {
                /* ignore */
            }
            return !c;
        });
    };

    if (!settings.showAssistant) return null;

    if (collapsed) {
        return (
            <div className='fl pill' data-theme={settings.themePreference} style={{ width: 'auto' }}>
                <span className='brand'>FastLane</span>
                {code && <span className='mono'>{code}</span>}
                <button type='button' className='mini' onClick={toggleCollapsed} aria-label='Expand Fastlane assistant'>
                    Expand
                </button>
            </div>
        );
    }

    return (
        <section className='fl' data-theme={settings.themePreference} aria-label='Fastlane registration assistant'>
            <div className='head'>
                <div className='brand'>
                    FastLane assistant
                    <small>You submit each request at UT</small>
                </div>
                <div className='row'>
                    <button
                        type='button'
                        className='mini'
                        onClick={() => {
                            const url = fastlanePageUrl('register');
                            if (url) window.open(url, '_blank', 'noopener');
                            else expireAssistant(host);
                        }}
                    >
                        Plan ↗
                    </button>
                    <button type='button' className='mini' onClick={toggleCollapsed} aria-label='Minimize'>
                        —
                    </button>
                </div>
            </div>
            <div className='body'>
                {current && code ? (
                    <>
                        <div>
                            <div className='eyebrow'>Class registration number</div>
                            <div className='code' aria-live='polite'>
                                {code}
                            </div>
                            <div className='course'>
                                {current.courseCode ? `${current.courseCode} · ` : ''}
                                {current.label}
                            </div>
                            <div className='req'>
                                {current.requirement ? describeRequirement(current.requirement) : 'No requirement set'}
                            </div>
                        </div>
                        <button type='button' className='primary' onClick={() => void onCopy()}>
                            Copy {code}
                        </button>
                        <label className='toggle'>
                            <span>Auto-fill code</span>
                            <input
                                type='checkbox'
                                role='switch'
                                aria-checked={settings.autofill.enabled && !settings.autofill.paused}
                                aria-label='Auto-fill code'
                                checked={settings.autofill.enabled && !settings.autofill.paused}
                                onChange={event => {
                                    lastAutoItem.current = null;
                                    void assistantAction(host, () =>
                                        FastlaneSettingsStore.set('autofill', {
                                            ...settings.autofill,
                                            enabled: event.target.checked,
                                            paused: false,
                                            preserveNonEmpty: true,
                                        })
                                    );
                                }}
                            />
                        </label>
                        <div className='grid'>
                            <button type='button' className='ok' onClick={() => void mark('success')}>
                                ✓ Success
                            </button>
                            <button type='button' className='full' onClick={() => void mark('full')}>
                                Full
                            </button>
                            <button type='button' className='warn' onClick={() => void mark('conflict')}>
                                Conflict
                            </button>
                            <button type='button' className='warn' onClick={() => void mark('restriction')}>
                                Restriction
                            </button>
                        </div>
                        <div className='row' style={{ justifyContent: 'space-between' }}>
                            <button type='button' className='mini' onClick={() => void mark('skipped')}>
                                Skip
                            </button>
                            <button
                                type='button'
                                className='mini'
                                onClick={() => void onUndo()}
                                disabled={!queue.undoStack.length}
                            >
                                ↶ Undo
                            </button>
                        </div>
                        {fallback && (
                            <div className='fallback'>
                                <span className='note'>{fallback.sameGroup ? 'Next fallback' : 'Then'}</span>
                                <span>
                                    <span className='mono'>{formatUnique(fallback.item.uniqueId)}</span>{' '}
                                    {fallback.item.label}
                                </span>
                            </div>
                        )}
                    </>
                ) : (
                    <div className='notice'>No planned codes remain in your queue.</div>
                )}

                {suggestion && (
                    <div className='notice info' role='status'>
                        UT’s page appears to say: “{suggestion.message}”
                        <div className='row' style={{ marginTop: 6 }}>
                            <button
                                type='button'
                                className='mini'
                                onClick={() => void mark(suggestion.kind, 'detected')}
                            >
                                Mark {OUTCOME_LABELS[suggestion.kind]}
                            </button>
                            <button type='button' className='mini ghost' onClick={() => setSuggestion(null)}>
                                Dismiss
                            </button>
                        </div>
                    </div>
                )}

                {notice && (
                    <div className={`notice ${notice.tone ?? ''}`} role='status'>
                        {notice.text}
                    </div>
                )}

                {exhausted.length > 0 && (
                    <div className='section'>
                        <div className='eyebrow'>All backups used · degree-relevant options</div>
                        {recs === null && <div className='note'>Finding options from your saved course data…</div>}
                        {recs?.length === 0 && (
                            <div className='note'>
                                No cached sections satisfy{' '}
                                {exhausted.map(e => describeRequirement(e.requirement)).join(', ')}. Browse that
                                requirement on UT’s course schedule once so Fastlane can suggest options.
                            </div>
                        )}
                        {recs?.map(rec => {
                            const group = exhausted.find(e => rec.satisfies.includes(e.requirement)) ?? exhausted[0]!;
                            return (
                                <div className='rec' key={rec.section.uniqueId}>
                                    <div className='top'>
                                        <span>
                                            <span className='mono'>{formatUnique(rec.section.uniqueId)}</span>{' '}
                                            {rec.section.courseCode}
                                        </span>
                                        <button
                                            type='button'
                                            className='mini'
                                            onClick={() =>
                                                void queueRecommendation(rec, group.group, group.requirement)
                                            }
                                        >
                                            Use
                                        </button>
                                    </div>
                                    <div className='note'>{rec.section.title}</div>
                                    <div className='row'>
                                        {rec.section.modality === 'async-online' && (
                                            <span className='badge async'>ASYNC</span>
                                        )}
                                        <span className={`badge ${rec.availability.tone === 'open' ? 'open' : ''}`}>
                                            {rec.availability.text}
                                        </span>
                                    </div>
                                    <div className='note'>{rec.reasons.slice(1, 3).join(' · ')}</div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </section>
    );
}
