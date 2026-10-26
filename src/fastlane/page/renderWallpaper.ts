/**
 * Paints a phone wallpaper on a <canvas>, entirely locally.
 */
import { graphNodes } from '@views/components/map/graphNodes';

import { DAY_COLORS, splitLocation } from '../core/campus';
import type { WallpaperClass, WallpaperOptions, WallpaperPreset } from '../core/wallpaper';
import { groupByDay } from '../core/wallpaper';

const MAP_W = 783;
const MAP_H = 753;

export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not load map image'));
        img.src = src;
    });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function truncate(ctx: CanvasRenderingContext2D, text: string, max: number): string {
    if (ctx.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
    return `${t}…`;
}

function drawMap(
    ctx: CanvasRenderingContext2D,
    map: HTMLImageElement,
    classes: WallpaperClass[],
    box: { x: number; y: number; w: number; h: number },
    dark: boolean,
    scale: number
) {
    ctx.save();
    roundRect(ctx, box.x, box.y, box.w, box.h, 28 * scale);
    ctx.clip();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    // cover-fit the campus image
    const s = Math.max(box.w / MAP_W, box.h / MAP_H);
    const ox = box.x + (box.w - MAP_W * s) / 2;
    const oy = box.y + (box.h - MAP_H * s) / 2;
    ctx.drawImage(map, ox, oy, MAP_W * s, MAP_H * s);
    if (dark) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(box.x, box.y, box.w, box.h);
    }
    const seen = new Set<string>();
    for (const c of classes) {
        for (const m of c.meetings) {
            const { building } = splitLocation(m.location);
            const node = building ? graphNodes[building] : undefined;
            if (!node || seen.has(building!)) continue;
            seen.add(building!);
            const px = ox + node.x * s;
            const py = oy + node.y * s;
            const day = m.days[0] ?? 'M';
            ctx.fillStyle = DAY_COLORS[day];
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 4 * scale;
            ctx.beginPath();
            ctx.arc(px, py, 14 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.font = `700 ${20 * scale}px system-ui, sans-serif`;
            const label = building!;
            const lw = ctx.measureText(label).width + 16 * scale;
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            roundRect(ctx, px + 18 * scale, py - 16 * scale, lw, 30 * scale, 8 * scale);
            ctx.fill();
            ctx.fillStyle = '#111';
            ctx.fillText(label, px + 26 * scale, py + 6 * scale);
        }
    }
    ctx.restore();
}

export function renderWallpaper(
    canvas: HTMLCanvasElement,
    preset: WallpaperPreset,
    options: WallpaperOptions,
    classes: WallpaperClass[],
    semesterLabel: string,
    map: HTMLImageElement | null
) {
    const { width, height } = preset;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const scale = width / 1080;
    const dark = options.theme === 'dark';
    const ink = dark ? '#F5F5F4' : '#1C1917';
    const muted = dark ? '#A8A29E' : '#57534E';

    // background
    if (options.style === 'aesthetic') {
        const g = ctx.createLinearGradient(0, 0, width, height);
        if (dark) {
            g.addColorStop(0, '#2a1305');
            g.addColorStop(0.55, '#121012');
            g.addColorStop(1, '#0a0a0c');
        } else {
            g.addColorStop(0, '#fde7d4');
            g.addColorStop(0.5, '#fff8f1');
            g.addColorStop(1, '#f1ece6');
        }
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = dark ? 'rgba(191,87,0,0.18)' : 'rgba(191,87,0,0.12)';
        ctx.beginPath();
        ctx.arc(width * 0.9, height * 0.22, width * 0.45, 0, Math.PI * 2);
        ctx.fill();
    } else {
        ctx.fillStyle = dark ? '#0B0B0D' : '#FAFAF9';
        ctx.fillRect(0, 0, width, height);
    }

    const margin = 64 * scale;
    let top = preset.safeTop;
    const bottom = height - preset.safeBottom;

    if (options.style === 'map' && map) {
        drawMap(ctx, map, classes, { x: margin, y: top, w: width - margin * 2, h: (bottom - top) * 0.55 }, dark, scale);
        top += (bottom - top) * 0.55 + 28 * scale;
    }
    let scheduleBottom = bottom;
    if (options.style === 'hybrid' && map) {
        const mapH = (bottom - top) * 0.38;
        drawMap(ctx, map, classes, { x: margin, y: bottom - mapH, w: width - margin * 2, h: mapH }, dark, scale);
        scheduleBottom = bottom - mapH - 28 * scale;
    }

    const { days, asynchronous } = groupByDay(classes, options);
    const entryCount = days.reduce((n, d) => n + d.entries.length, 0);
    const available = scheduleBottom - top - 60 * scale;
    // shrink to fit long schedules
    // base type is sized for legibility on a phone lock screen (≈1.5× desktop sizes)
    const TYPE = 1.5;
    const needed = (days.length * 62 + entryCount * 74 + (asynchronous.length ? 80 : 0)) * TYPE;
    const fit = Math.min(1, available / (needed * scale));
    const s = scale * TYPE * Math.max(0.45, fit);

    ctx.fillStyle = muted;
    ctx.font = `600 ${26 * s}px system-ui, sans-serif`;
    ctx.fillText(semesterLabel.toUpperCase(), margin, top + 26 * s);
    let y = top + 70 * s;

    for (const day of days) {
        ctx.fillStyle = options.colorByCourse ? DAY_COLORS[day.day] : ink;
        ctx.font = `800 ${30 * s}px system-ui, sans-serif`;
        ctx.fillText(day.label, margin, y);
        y += 16 * s;
        for (const e of day.entries) {
            const cardH = 64 * s;
            if (options.style !== 'minimal') {
                ctx.fillStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.75)';
                roundRect(ctx, margin, y, width - margin * 2, cardH, 14 * s);
                ctx.fill();
            }
            ctx.fillStyle = options.colorByCourse ? e.color : ink;
            ctx.fillRect(margin, y + 10 * s, 6 * s, cardH - 20 * s);
            ctx.fillStyle = ink;
            ctx.font = `700 ${28 * s}px system-ui, sans-serif`;
            ctx.fillText(e.courseCode, margin + 22 * s, y + 30 * s);
            const codeW = ctx.measureText(e.courseCode).width;
            ctx.font = `400 ${24 * s}px system-ui, sans-serif`;
            ctx.fillStyle = muted;
            ctx.fillText(
                truncate(ctx, e.title, width - margin * 2 - codeW - 300 * s),
                margin + 34 * s + codeW,
                y + 30 * s
            );
            ctx.textAlign = 'right';
            ctx.fillStyle = ink;
            ctx.font = `600 ${24 * s}px system-ui, sans-serif`;
            ctx.fillText(e.time, width - margin - 14 * s, y + 30 * s);
            ctx.textAlign = 'left';
            const detail = [e.location, e.instructor].filter(Boolean).join(' · ');
            if (detail) {
                ctx.fillStyle = muted;
                ctx.font = `400 ${21 * s}px system-ui, sans-serif`;
                ctx.fillText(truncate(ctx, detail, width - margin * 2 - 40 * s), margin + 22 * s, y + 55 * s);
            }
            y += cardH + 10 * s;
        }
        y += 36 * s;
    }
    if (asynchronous.length) {
        ctx.fillStyle = muted;
        ctx.font = `600 ${22 * s}px system-ui, sans-serif`;
        ctx.fillText(
            truncate(ctx, `ONLINE, ANYTIME: ${asynchronous.map(a => a.courseCode).join(' · ')}`, width - margin * 2),
            margin,
            y
        );
    }
}
