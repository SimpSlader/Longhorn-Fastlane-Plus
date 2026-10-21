import type { Serialized } from '@chrome-extension-toolkit';
import { Course } from '@shared/types/Course';
import { useEffect, useMemo, useState } from 'react';

import { gradeStatFrom, lookupGrades } from '../adapters/utrp';
import type { GradeStat, GradeThreshold } from '../core/grades';
import type { SectionRecord } from '../core/sections';

/** Historical grade stats for a set of sections (async, cached per course+instructor). */
export function useGradeStats(sections: SectionRecord[], threshold: GradeThreshold): Map<number, GradeStat | null> {
    const key = sections.map(s => s.uniqueId).join(',');
    const [raw, setRaw] = useState<Map<number, Awaited<ReturnType<typeof lookupGrades>>>>(new Map());
    // biome-ignore lint/correctness/useExhaustiveDependencies: `key` (the joined unique numbers) stands in for the sections array
    useEffect(() => {
        let alive = true;
        void Promise.all(
            sections.map(async s => {
                if (!s.course) return [s.uniqueId, null] as const;
                try {
                    return [s.uniqueId, await lookupGrades(new Course(s.course as Serialized<Course>))] as const;
                } catch {
                    return [s.uniqueId, null] as const;
                }
            })
        ).then(entries => {
            if (alive) setRaw(new Map(entries));
        });
        return () => {
            alive = false;
        };
    }, [key]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands in for the sections array
    return useMemo(() => {
        const out = new Map<number, GradeStat | null>();
        for (const s of sections) {
            if (!raw.has(s.uniqueId)) continue;
            const r = raw.get(s.uniqueId) ?? null;
            out.set(
                s.uniqueId,
                s.course && r ? gradeStatFrom(new Course(s.course as Serialized<Course>), r, threshold) : null
            );
        }
        return out;
    }, [raw, threshold, key]);
}

function readHash() {
    const [tab = 'plan', query = ''] = window.location.hash.replace(/^#/, '').split('?');
    return { tab: tab || 'plan', params: new URLSearchParams(query) };
}

export function useHashRoute(): [string, URLSearchParams, (tab: string, params?: Record<string, string>) => void] {
    const read = readHash;
    const [route, setRoute] = useState(read);
    useEffect(() => {
        const on = () => setRoute(read());
        window.addEventListener('hashchange', on);
        return () => window.removeEventListener('hashchange', on);
    }, []);
    const go = (tab: string, params?: Record<string, string>) => {
        const q = params ? `?${new URLSearchParams(params).toString()}` : '';
        window.location.hash = `${tab}${q}`;
    };
    return [route.tab, route.params, go];
}

export function useOnline(): boolean {
    const [online, setOnline] = useState(navigator.onLine);
    useEffect(() => {
        const on = () => setOnline(navigator.onLine);
        window.addEventListener('online', on);
        window.addEventListener('offline', on);
        return () => {
            window.removeEventListener('online', on);
            window.removeEventListener('offline', on);
        };
    }, []);
    return online;
}
