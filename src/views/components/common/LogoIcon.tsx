import clsx from 'clsx';
import type { JSX, SVGProps } from 'react';

interface LogoIconProps {
    className?: string;
}

/**
 * Renders the logo icon.
 *
 * @param props - The SVG props.
 * @returns The rendered logo icon.
 */
export function LogoIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
    return (
        // biome-ignore lint/a11y/noSvgWithoutTitle: TODO:
        <svg width='40' height='40' viewBox='0 0 128 128' fill='none' xmlns='http://www.w3.org/2000/svg' {...props}>
            {/* Fastlane mark (replaces the UT Registration Plus logo to avoid implying affiliation) */}
            <rect x='4' y='4' width='120' height='120' rx='28' fill='#333F48' />
            <path d='M30 98 L58 30 h14 L50 82 h22 L56 110 Z' fill='#E87722' />
            <path d='M76 98 L100 38' stroke='#FFFFFF' strokeWidth='9' strokeLinecap='round' opacity='0.9' />
            <path d='M90 104 L106 64' stroke='#FFFFFF' strokeWidth='7' strokeLinecap='round' opacity='0.45' />
        </svg>
    );
}

/**
 * Renders the small logo.
 *
 * @param className - The class name for the logo container.
 * @returns The rendered small logo.
 */
export function SmallLogo({ className }: LogoIconProps): JSX.Element {
    return <div className={clsx('text-lg font-semibold text-ut-burntorange', className)}>FastLane</div>;
}

export function LargeLogo({ className }: LogoIconProps): JSX.Element {
    return <div className={clsx('text-2xl font-semibold text-ut-burntorange', className)}>FastLane</div>;
}
