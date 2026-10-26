import { switchSchedule, useActiveSchedule, useAllSchedules } from '@views/hooks/useSchedules';
import { useEffect, useMemo, useRef, useState } from 'react';

import { sectionFromCourse } from '../adapters/utrp';
import type { WallpaperClass, WallpaperOptions } from '../core/wallpaper';
import { courseColor, WALLPAPER_PRESETS } from '../core/wallpaper';
import { PageHead } from './common';
import { loadImage, renderWallpaper } from './renderWallpaper';

const MAP_URL = new URL('/src/assets/UT-Map.svg', import.meta.url).href;

export default function WallpaperTab() {
    const schedule = useActiveSchedule();
    const schedules = useAllSchedules();
    const [presetId, setPresetId] = useState<(typeof WALLPAPER_PRESETS)[number]['id']>('iphone');
    const [options, setOptions] = useState<WallpaperOptions>({
        style: 'aesthetic',
        theme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        showProfessor: false,
        showRoom: true,
        colorByCourse: true,
    });
    const [map, setMap] = useState<HTMLImageElement | null>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const preset = WALLPAPER_PRESETS.find(p => p.id === presetId)!;

    const classes: WallpaperClass[] = useMemo(
        () =>
            (schedule?.courses ?? []).map((c, i) => {
                const s = sectionFromCourse(c);
                return {
                    uniqueId: s.uniqueId,
                    courseCode: s.courseCode,
                    title: s.title,
                    instructor: c.instructors[0]?.toString({ format: 'first_last' }),
                    meetings: s.meetings,
                    asynchronous: s.modality === 'async-online',
                    color: courseColor(i, options.colorByCourse, options.theme),
                };
            }),
        [schedule, options.colorByCourse, options.theme]
    );
    const semester = schedule?.courses[0]
        ? `${schedule.courses[0].semester.season} ${schedule.courses[0].semester.year}`
        : 'My schedule';

    useEffect(() => {
        if ((options.style === 'map' || options.style === 'hybrid') && !map)
            void loadImage(MAP_URL)
                .then(setMap)
                .catch(() => setMap(null));
    }, [options.style, map]);

    useEffect(() => {
        if (canvas.current) renderWallpaper(canvas.current, preset, options, classes, semester, map);
    }, [preset, options, classes, semester, map]);

    const set = <K extends keyof WallpaperOptions>(k: K, v: WallpaperOptions[K]) => setOptions(o => ({ ...o, [k]: v }));

    return (
        <div className='stack'>
            <PageHead
                title='Phone wallpaper'
                subtitle='A lock-screen image of your active schedule, drawn in this browser. Nothing is uploaded.'
                actions={
                    <button
                        type='button'
                        className='btn primary'
                        disabled={!classes.length}
                        onClick={() =>
                            canvas.current?.toBlob(blob => {
                                if (!blob) return;
                                const a = document.createElement('a');
                                a.href = URL.createObjectURL(blob);
                                a.download = `schedule-wallpaper-${preset.id}.png`;
                                a.click();
                                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
                            }, 'image/png')
                        }
                    >
                        Download PNG
                    </button>
                }
            />
            <div className='grid2' style={{ gridTemplateColumns: 'minmax(260px, 1fr) minmax(0, 1fr)' }}>
                <div className='card stack'>
                    <label className='field'>
                        Schedule for wallpaper
                        <select
                            aria-label='Schedule for wallpaper'
                            value={schedule.id}
                            onChange={e => void switchSchedule(e.target.value)}
                        >
                            {schedules.map(s => (
                                <option key={s.id} value={s.id}>
                                    {s.name} ({s.courses.length} classes)
                                </option>
                            ))}
                        </select>
                    </label>
                    <a className='btn' href={chrome.runtime.getURL('calendar.html')} target='_blank' rel='noopener'>
                        Open calendar to add or review classes
                    </a>
                    <label className='field'>
                        Size
                        <select value={presetId} onChange={e => setPresetId(e.target.value as typeof presetId)}>
                            {WALLPAPER_PRESETS.map(p => (
                                <option key={p.id} value={p.id}>
                                    {p.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='field'>
                        Style
                        <select
                            value={options.style}
                            onChange={e => set('style', e.target.value as WallpaperOptions['style'])}
                        >
                            <option value='minimal'>Minimal schedule</option>
                            <option value='aesthetic'>Aesthetic schedule</option>
                            <option value='map'>Campus map</option>
                            <option value='hybrid'>Schedule + map</option>
                        </select>
                    </label>
                    <fieldset className='tabs' aria-label='Theme'>
                        <button
                            type='button'
                            aria-pressed={options.theme === 'light'}
                            onClick={() => set('theme', 'light')}
                        >
                            Light
                        </button>
                        <button
                            type='button'
                            aria-pressed={options.theme === 'dark'}
                            onClick={() => set('theme', 'dark')}
                        >
                            Dark
                        </button>
                    </fieldset>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={options.showRoom}
                            onChange={e => set('showRoom', e.target.checked)}
                        />
                        Room numbers (otherwise building only)
                    </label>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={options.showProfessor}
                            onChange={e => set('showProfessor', e.target.checked)}
                        />
                        Professor names
                    </label>
                    <label className='check'>
                        <input
                            type='checkbox'
                            checked={options.colorByCourse}
                            onChange={e => set('colorByCourse', e.target.checked)}
                        />
                        Color by course
                    </label>
                    {!classes.length && (
                        <div className='notice small'>
                            This schedule has no courses yet. Choose another saved schedule above, or select “Open
                            calendar” to add classes. Only classes in the selected schedule appear in the wallpaper.
                        </div>
                    )}
                    <div className='small muted'>The top of the image is left clear for your phone’s clock.</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <canvas
                        ref={canvas}
                        aria-label='Wallpaper preview'
                        style={{
                            width: 300,
                            height: (300 * preset.height) / preset.width,
                            borderRadius: 28,
                            border: '1px solid var(--border)',
                            boxShadow: 'var(--shadow)',
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
