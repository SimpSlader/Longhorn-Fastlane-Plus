/**
 * Header cell for the injected column: lets the student change the grade threshold right on the
 * listing (the same global setting as in Fastlane settings).
 */
import type { ScrapedRow } from '@shared/types/Course';
import { useEffect } from 'react';

import { analyzeRow, sectionFromCourse } from '../adapters/utrp';
import type { GradeThreshold } from '../core/grades';
import { GRADE_THRESHOLDS, isGradeThreshold } from '../core/grades';
import { sendFastlane } from '../services/runtime';
import { FastlaneSettingsStore } from '../storage/stores';

export function CatalogHeader() {
    const threshold = FastlaneSettingsStore.useStore(s => s.gradeThreshold);
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <span>Plus</span>
            <label style={{ fontWeight: 400, fontSize: 11 }}>
                <span style={{ position: 'absolute', left: -9999 }}>Grade threshold</span>
                <select
                    aria-label='Show percentage of students at or above this grade'
                    title='Percentage of letter grades at or above this grade (historical data)'
                    value={threshold}
                    onChange={e => {
                        if (isGradeThreshold(e.target.value))
                            void FastlaneSettingsStore.set('gradeThreshold', e.target.value as GradeThreshold);
                    }}
                    style={{ fontSize: 11, padding: '1px 2px', borderRadius: 4 }}
                >
                    {GRADE_THRESHOLDS.map(t => (
                        <option key={t} value={t}>
                            % {t} or better
                        </option>
                    ))}
                </select>
            </label>
        </span>
    );
}

/**
 * Remembers the sections shown on the public course schedule page the student is viewing, so
 * recommendations can work offline later. Debounced, batched, and stored only in this browser.
 */
export function useCacheVisibleSections(rows: ScrapedRow[]) {
    useEffect(() => {
        if (!rows.length) return;
        const timer = setTimeout(() => {
            const sections = rows
                .filter(r => r.course)
                .map(r => {
                    try {
                        return sectionFromCourse(r.course!, analyzeRow(r.element));
                    } catch {
                        return null;
                    }
                })
                .filter(Boolean);
            if (sections.length) {
                void sendFastlane({ type: 'cacheSections', sections: sections as never }).catch(() => {
                    /* background asleep or extension reloaded; caching is best-effort */
                });
            }
        }, 1500);
        return () => clearTimeout(timer);
    }, [rows]);
}
