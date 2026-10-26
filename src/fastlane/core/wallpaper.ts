/**
 * Phone wallpaper layout. Pure geometry: the UI paints it on a <canvas> locally.
 */
import type { DayCode, Meeting } from './meetings';
import { formatMinutes } from './meetings';

export interface WallpaperPreset {
    id: 'iphone' | 'android' | 'portrait';
    label: string;
    width: number;
    height: number;
    /** keep the clock / notch area clear */
    safeTop: number;
    safeBottom: number;
}

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
    { id: 'iphone', label: 'iPhone (1179 × 2556)', width: 1179, height: 2556, safeTop: 780, safeBottom: 260 },
    { id: 'android', label: 'Android (1080 × 2400)', width: 1080, height: 2400, safeTop: 640, safeBottom: 220 },
    {
        id: 'portrait',
        label: 'Generic portrait (1080 × 1920)',
        width: 1080,
        height: 1920,
        safeTop: 420,
        safeBottom: 160,
    },
];

export type WallpaperStyle = 'minimal' | 'aesthetic' | 'map' | 'hybrid';

export interface WallpaperOptions {
    style: WallpaperStyle;
    theme: 'light' | 'dark';
    showProfessor: boolean;
    showRoom: boolean;
    colorByCourse: boolean;
}

export interface WallpaperClass {
    uniqueId: number;
    courseCode: string;
    title: string;
    instructor?: string;
    meetings: Meeting[];
    asynchronous: boolean;
    color: string;
}

export interface WallpaperEntry {
    courseCode: string;
    title: string;
    time: string;
    start: number;
    location?: string;
    instructor?: string;
    color: string;
}

export interface WallpaperDay {
    day: DayCode;
    label: string;
    entries: WallpaperEntry[];
}

const WEEKDAYS: Array<[DayCode, string]> = [
    ['M', 'MON'],
    ['T', 'TUE'],
    ['W', 'WED'],
    ['TH', 'THU'],
    ['F', 'FRI'],
    ['S', 'SAT'],
];

/** Groups meetings by weekday in time order; async classes are returned separately. */
export function groupByDay(classes: WallpaperClass[], options: Pick<WallpaperOptions, 'showProfessor' | 'showRoom'>) {
    const days: WallpaperDay[] = [];
    for (const [day, label] of WEEKDAYS) {
        const entries: WallpaperEntry[] = [];
        for (const c of classes) {
            for (const m of c.meetings) {
                if (!m.days.includes(day)) continue;
                entries.push({
                    courseCode: c.courseCode,
                    title: c.title,
                    time: `${formatMinutes(m.start)}–${formatMinutes(m.end)}`,
                    start: m.start,
                    location: options.showRoom ? m.location : m.location?.split(' ')[0],
                    instructor: options.showProfessor ? c.instructor : undefined,
                    color: c.color,
                });
            }
        }
        entries.sort((a, b) => a.start - b.start || a.courseCode.localeCompare(b.courseCode));
        if (entries.length || day !== 'S') days.push({ day, label, entries });
    }
    const asynchronous = classes.filter(c => c.asynchronous || c.meetings.length === 0);
    return { days: days.filter(d => d.entries.length > 0), asynchronous };
}

/** Vivid but refined course colors (coral, blue, purple, teal, green, orange, indigo, pink), UTRP-style. */
export const COURSE_PALETTE = ['#E5484D', '#0B84D6', '#8E4EC6', '#12A594', '#30A46C', '#E5741A', '#5B5BD6', '#D6409F'];

export function courseColor(index: number, colorByCourse: boolean, theme: 'light' | 'dark'): string {
    if (!colorByCourse) return theme === 'dark' ? '#F5F5F4' : '#1C1917';
    return COURSE_PALETTE[index % COURSE_PALETTE.length]!;
}
