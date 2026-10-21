import { OptionsStore } from '@shared/storage/OptionsStore';
import type { Course } from '@shared/types/Course';
import type { Distribution, LetterGrade } from '@shared/types/Distribution';
import { extendedColors } from '@shared/types/ThemeColors';
import Link from '@views/components/common/Link';
import Text from '@views/components/common/Text/Text';
import {
    NoDataError,
    queryAggregateDistribution,
    querySemesterDistribution,
} from '@views/lib/database/queryDistribution';
import type { ChangeEvent, JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import Skeleton from 'react-loading-skeleton';

import GradeBarChart from './GradeBarChart';

const UT_GRADE_DISTRIBUTION_URL = 'https://reports.utexas.edu/spotlight-data/ut-course-grade-distributions';
const TOOLTIP_CONTENT =
    "The 'Other' grade category includes all non-standard letter grades, including: In Progress, Incomplete, Permanent Incomplete, Oblit, Q-Drop, Withdrawn, Credit, No Credit, Satisfactory, Unsatisfactory, and Registered on CR/F or CR/NC basis.";
interface GradeDistributionProps {
    course: Course;
}

const DataStatus = {
    LOADING: 'LOADING',
    FOUND: 'FOUND',
    NOT_FOUND: 'NOT_FOUND',
    ERROR: 'ERROR',
} as const satisfies Record<string, string>;

type DataStatusType = (typeof DataStatus)[keyof typeof DataStatus];

const GRADE_COLORS = {
    A: extendedColors.gradeDistribution.a,
    'A-': extendedColors.gradeDistribution.aminus,
    'B+': extendedColors.gradeDistribution.bplus,
    B: extendedColors.gradeDistribution.b,
    'B-': extendedColors.gradeDistribution.bminus,
    'C+': extendedColors.gradeDistribution.cplus,
    C: extendedColors.gradeDistribution.c,
    'C-': extendedColors.gradeDistribution.cminus,
    'D+': extendedColors.gradeDistribution.dplus,
    D: extendedColors.gradeDistribution.d,
    'D-': extendedColors.gradeDistribution.dminus,
    F: extendedColors.gradeDistribution.f,
    Other: extendedColors.gradeDistribution.other,
} as const satisfies Record<LetterGrade, string>;

const GRADE_ORDER: LetterGrade[] = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F', 'Other'];

const semesterOrdering = new Map([
    ['Fall', 0],
    ['Summer', 1],
    ['Spring', 2],
]);

/**
 * Renders the grade distribution chart for a specific course.
 *
 * @param course - The course for which to display the grade distribution.
 * @returns The grade distribution chart component.
 */
export default function GradeDistribution({ course }: GradeDistributionProps): JSX.Element {
    const reducedMotion = OptionsStore.useStore(store => store.enableReducedMotion);
    const [semester, setSemester] = useState('Aggregate');
    type Distributions = Record<string, { data: Distribution; instructorIncluded: boolean }>;
    const [distributions, setDistributions] = useState<Distributions>({});
    const [status, setStatus] = useState<DataStatusType>(DataStatus.LOADING);
    // Fastlane: column data for the dependency-free SVG chart (replaces Highcharts)
    const chartData = useMemo(() => {
        const data = status === DataStatus.FOUND ? distributions[semester]?.data : undefined;
        return GRADE_ORDER.map(grade => ({ label: grade, value: data?.[grade] ?? 0, color: GRADE_COLORS[grade] }));
    }, [distributions, semester, status]);

    useEffect(() => {
        const fetchInitialData = async () => {
            try {
                const [aggregateDist, semesters, instructorIncludedAggregate] =
                    await queryAggregateDistribution(course);
                const initialDistributions: Distributions = {
                    Aggregate: {
                        data: aggregateDist,
                        instructorIncluded: instructorIncludedAggregate,
                    },
                };
                const semesterPromises = semesters.map(semester => querySemesterDistribution(course, semester));
                const semesterDistributions = await Promise.allSettled(semesterPromises);
                semesters.forEach((semester, i) => {
                    const distributionResult = semesterDistributions[i];

                    if (!distributionResult) {
                        throw new Error('Distribution result is undefined');
                    }

                    if (distributionResult.status === 'fulfilled') {
                        const [distribution, instructorIncluded] = distributionResult.value;
                        initialDistributions[`${semester.season} ${semester.year}`] = {
                            data: distribution,
                            instructorIncluded,
                        };
                    }
                });
                setDistributions(initialDistributions);
                setStatus(DataStatus.FOUND);
            } catch (e) {
                console.error(e);
                if (e instanceof NoDataError) {
                    setStatus(DataStatus.NOT_FOUND);
                } else {
                    setStatus(DataStatus.ERROR);
                }
            }
        };

        fetchInitialData();
    }, [course]);

    const handleSelectSemester = (event: ChangeEvent<HTMLSelectElement>) => {
        setSemester(event.target.value);
    };

    return (
        <div className='pt-3'>
            {status === DataStatus.LOADING && <Skeleton height={300} enableAnimation={!reducedMotion} />}
            {status === DataStatus.NOT_FOUND && (
                <GradeBarChart
                    bars={chartData}
                    reducedMotion={reducedMotion}
                    title={`There is currently no grade distribution data for ${course.department} ${course.getNumberWithoutTerm()}`}
                />
            )}
            {status === DataStatus.ERROR && (
                <Text variant='p' className='pb-3'>
                    Error fetching grade distribution data
                </Text>
            )}
            {status === DataStatus.FOUND && (
                <>
                    <div className='flex flex-wrap content-center items-center self-stretch justify-center gap-3'>
                        <Text variant='small' className='text-ut-black'>
                            Grade Distribution for{' '}
                            <Text variant='small' className='font-extrabold!' as='strong'>
                                {course.department} {course.getNumberWithoutTerm()}
                            </Text>
                        </Text>
                        <select
                            className='border border rounded border-solid px-3 py-2'
                            onChange={handleSelectSemester}
                        >
                            {Object.keys(distributions)
                                .sort((k1, k2) => {
                                    if (k1 === 'Aggregate') {
                                        return -1;
                                    }
                                    if (k2 === 'Aggregate') {
                                        return 1;
                                    }

                                    const [season1, year1] = k1.split(' ');
                                    const [season2, year2] = k2.split(' ');

                                    if (year1 !== year2) {
                                        return parseInt(year2 as string, 10) - parseInt(year1 as string, 10);
                                    }

                                    return (
                                        (semesterOrdering.get(season1 ?? 'Fall') ?? 0) -
                                        (semesterOrdering.get(season2 ?? 'Fall') ?? 0)
                                    );
                                })
                                .map(semester => (
                                    <option key={semester} value={semester}>
                                        {semester}
                                    </option>
                                ))}
                        </select>
                        <Link variant='small' href={UT_GRADE_DISTRIBUTION_URL} className='link'>
                            Data Source
                        </Link>
                    </div>
                    {distributions[semester] && !distributions[semester]?.instructorIncluded && (
                        <div className='mt-3 flex flex-wrap content-center items-center self-stretch justify-center gap-3 text-center'>
                            <Text variant='small' className='text-theme-red'>
                                We couldn&apos;t find {semester !== 'Aggregate' && ` ${semester}`} grades for this
                                instructor, so here are the grades for all {course.department}{' '}
                                {course.getNumberWithoutTerm()} sections.
                            </Text>
                        </div>
                    )}
                    <GradeBarChart bars={chartData} reducedMotion={reducedMotion} otherTooltip={TOOLTIP_CONTENT} />
                </>
            )}
        </div>
    );
}
