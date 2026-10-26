import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import GradeBarChart, { niceScale } from './GradeBarChart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('GradeBarChart (Highcharts replacement)', () => {
    it('chooses readable axis steps', () => {
        expect(niceScale(47)).toEqual({ top: 60, step: 20 });
        expect(niceScale(5)).toEqual({ top: 6, step: 2 });
        expect(niceScale(0)).toEqual({ top: 4, step: 1 });
        expect(niceScale(1234)).toEqual({ top: 1500, step: 500 });
    });

    it('renders one colored column per grade with accessible labels and data table', () => {
        const host = document.createElement('div');
        const bars = [
            { label: 'A', value: 45, color: '#22C55E' },
            { label: 'A-', value: 16, color: '#A3E635' },
            { label: 'Other', value: 2, color: '#D6D3D1' },
        ];
        act(() =>
            createRoot(host).render(<GradeBarChart bars={bars} reducedMotion otherTooltip='non-letter grades' />)
        );
        const columns = [...host.querySelectorAll('rect[fill="#22C55E"], rect[fill="#A3E635"], rect[fill="#D6D3D1"]')];
        expect(columns).toHaveLength(3);
        expect(Number(columns[0]!.getAttribute('height'))).toBeGreaterThan(Number(columns[1]!.getAttribute('height')));
        expect(host.querySelector('table tr th')?.textContent).toBe('A');
        expect(host.querySelector('table tr td')?.textContent).toBe('45');
        expect(host.textContent).toContain('Students');
        expect(host.textContent).toContain('Grades');
        expect(host.querySelector('title')?.textContent).toBe('non-letter grades');
        expect(host.querySelectorAll('table tr')).toHaveLength(3);
    });
});
