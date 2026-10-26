/**
 * Dependency-free SVG column chart for grade distributions.
 *
 * Fastlane replaced Highcharts (free for non-commercial use only) with this component so the
 * extension ships only permissively licensed code. It keeps the original look: colored columns,
 * "Grades"/"Students" axis titles, tick marks, an "Other" explainer, and a hover tooltip.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

export interface GradeBar {
    label: string;
    value: number;
    color: string;
}

interface Props {
    bars: GradeBar[];
    /** shown centered above the plot (e.g. "no data" message) */
    title?: string;
    reducedMotion?: boolean;
    /** explanation shown when hovering the "Other" label */
    otherTooltip?: string;
    height?: number;
}

const WIDTH = 640;
const AXIS = '#9CADB7';
const INK = '#333F48';

/** "Nice" axis maximum and step, e.g. 47 → (60, 20) */
export function niceScale(max: number): { top: number; step: number } {
    if (max <= 0) return { top: 4, step: 1 };
    const rough = max / 3;
    const pow = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(s => s >= rough) ?? 10 * pow;
    return { top: Math.ceil(max / step) * step, step };
}

export default function GradeBarChart({
    bars,
    title,
    reducedMotion = false,
    otherTooltip,
    height = 250,
}: Props): JSX.Element {
    const [hover, setHover] = useState<number | null>(null);
    const [grown, setGrown] = useState(reducedMotion);
    // biome-ignore lint/correctness/useExhaustiveDependencies: replay the grow animation whenever the data changes
    useEffect(() => {
        if (reducedMotion) return;
        setGrown(false);
        const id = requestAnimationFrame(() => setGrown(true));
        return () => cancelAnimationFrame(id);
    }, [bars, reducedMotion]);

    const pad = { top: title ? 44 : 22, right: 8, bottom: 52, left: 56 };
    const plotW = WIDTH - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const { top, step } = niceScale(Math.max(0, ...bars.map(b => b.value)));
    const slot = plotW / Math.max(1, bars.length);
    const barW = slot * 0.46;
    const y = (v: number) => pad.top + plotH - (v / top) * plotH;
    const ticks: number[] = [];
    for (let t = 0; t <= top + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
    const hovered = hover !== null ? bars[hover] : undefined;
    const total = bars.reduce((sum, bar) => sum + bar.value, 0);
    const percent = (value: number) => `${total ? ((value / total) * 100).toFixed(1) : '0.0'}%`;

    return (
        <div
            className='relative w-full'
            // explicit aspect ratio so the dialog reserves the chart's height (an auto-height SVG can collapse to 0)
            style={{ fontFamily: 'Roboto Flex, Roboto Flex Local', aspectRatio: `${WIDTH} / ${height}` }}
        >
            <svg
                viewBox={`0 0 ${WIDTH} ${height}`}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
                role='img'
                aria-label={title ?? 'Grade distribution chart'}
            >
                {title && (
                    <text x={WIDTH / 2} y={20} textAnchor='middle' fontSize={14} fontWeight={600} fill={INK}>
                        {title}
                    </text>
                )}
                {ticks.map(t => (
                    <g key={t}>
                        <line x1={pad.left} x2={WIDTH - pad.right} y1={y(t)} y2={y(t)} stroke='#E6E6E6' />
                        <text x={pad.left - 8} y={y(t) + 4} textAnchor='end' fontSize={12.8} fill={INK}>
                            {t}
                        </text>
                    </g>
                ))}
                <text
                    transform={`translate(16 ${pad.top + plotH / 2}) rotate(-90)`}
                    textAnchor='middle'
                    fontSize={12.8}
                    fill={INK}
                >
                    Students
                </text>
                <line x1={pad.left} x2={WIDTH - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} stroke={AXIS} />
                {hover !== null && (
                    <rect
                        x={pad.left + hover * slot}
                        y={pad.top}
                        width={slot}
                        height={plotH}
                        fill='#D6D3D133'
                        pointerEvents='none'
                    />
                )}
                {bars.map((b, i) => {
                    const cx = pad.left + i * slot + slot / 2;
                    const h = (b.value / top) * plotH;
                    return (
                        <g key={b.label}>
                            <line
                                x1={pad.left + (i + 1) * slot}
                                x2={pad.left + (i + 1) * slot}
                                y1={pad.top + plotH}
                                y2={pad.top + plotH + 10}
                                stroke={AXIS}
                            />
                            <rect
                                x={cx - barW / 2}
                                y={pad.top + plotH - h}
                                width={barW}
                                height={Math.max(0, h)}
                                rx={2}
                                fill={b.color}
                                style={{
                                    transformOrigin: `${cx}px ${pad.top + plotH}px`,
                                    transform: `scaleY(${grown ? 1 : 0})`,
                                    transition: reducedMotion ? undefined : 'transform 700ms cubic-bezier(.19,1,.22,1)',
                                }}
                            />
                            <text
                                x={cx}
                                y={pad.top + plotH + 24}
                                textAnchor='middle'
                                fontSize={11}
                                fontWeight={500}
                                fill={INK}
                                textDecoration={b.label === 'Other' && otherTooltip ? 'underline' : undefined}
                            >
                                {b.label === 'Other' && otherTooltip && <title>{otherTooltip}</title>}
                                {b.label}
                            </text>
                            {/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only visual tooltip; the same values are in the accessible data table below */}
                            <rect
                                x={pad.left + i * slot}
                                y={pad.top}
                                width={slot}
                                height={plotH + 30}
                                data-grade={b.label}
                                fill='transparent'
                                onMouseEnter={() => setHover(i)}
                                onMouseLeave={() => setHover(null)}
                            />
                        </g>
                    );
                })}
                <text x={pad.left + plotW / 2} y={height - 6} textAnchor='middle' fontSize={12.8} fill={INK}>
                    Grades
                </text>
            </svg>
            {hovered && hover !== null && (
                <div
                    role='tooltip'
                    className='pointer-events-none absolute rounded bg-white px-3 py-1.5 text-center text-sm'
                    style={{
                        left: `${((pad.left + hover * slot + slot / 2) / WIDTH) * 100}%`,
                        top: `${(Math.max(pad.top, y(hovered.value) - 46) / height) * 100}%`,
                        transform: 'translateX(-50%)',
                        boxShadow: '0 1px 3px rgba(51, 63, 72, 0.30)',
                        color: '#000',
                        zIndex: 2,
                        background: 'rgba(255,255,255,.97)',
                        padding: '8px 12px',
                        borderRadius: 9,
                        minWidth: 160,
                        whiteSpace: 'nowrap',
                    }}
                >
                    <span style={{ display: 'block', position: 'static', color: '#000', fontWeight: 700 }}>
                        {hovered.label}
                    </span>
                    <span style={{ display: 'block', position: 'static', color: '#000', fontWeight: 500 }}>
                        {hovered.value} students · {percent(hovered.value)}
                    </span>
                </div>
            )}
            <table className='sr-only' style={{ position: 'absolute', left: -9999 }}>
                <caption>{title ?? 'Grade distribution'}</caption>
                <tbody>
                    {bars.map(b => (
                        <tr key={b.label}>
                            <th scope='row'>{b.label}</th>
                            <td>{b.value}</td>
                            <td>{percent(b.value)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
