/**
 * Rate My Professors lookup for UT Austin professors. Only a professor's public name is sent to RMP;
 * no student data. A rating is shown only when exactly one UT Austin professor matches the name, so a
 * wrong professor's rating is never shown.
 */

/** RMP's id for "University of Texas at Austin" (School-1255) */
export const RMP_UT_SCHOOL_ID = 'U2Nob29sLTEyNTU=';
export const RMP_GRAPHQL = 'https://www.ratemyprofessors.com/graphql';

export interface RmpRating {
    legacyId: number;
    name: string;
    department: string;
    avgRating: number;
    avgDifficulty: number;
    numRatings: number;
    /** -1 when RMP has no data */
    wouldTakeAgainPercent: number;
}

export interface RmpTeacher {
    legacyId: number;
    firstName: string;
    lastName: string;
    department: string;
    avgRating: number;
    avgDifficulty: number;
    numRatings: number;
    wouldTakeAgainPercent: number;
    school: { id: string };
}

export const RMP_QUERY = `query TeacherSearch($text: String!, $schoolID: ID!) {
  newSearch {
    teachers(query: { text: $text, schoolID: $schoolID }, first: 20) {
      edges { node { legacyId firstName lastName department avgRating avgDifficulty numRatings wouldTakeAgainPercent school { id } } }
    }
  }
}`;

export function rmpProfessorUrl(legacyId: number): string {
    return `https://www.ratemyprofessors.com/professor/${legacyId}`;
}

const norm = (s: string) =>
    s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[’`]/g, "'")
        .replace(/[^a-z' -]/g, '')
        .trim();

/** Splits UT's "LAST, FIRST M" or "First Last" into names. */
export function splitProfessorName(
    first: string | undefined,
    last: string | undefined,
    full: string
): { first: string; last: string } | null {
    if (last) return { first: norm(first ?? ''), last: norm(last) };
    if (full.includes(',')) {
        const [l, f] = full.split(',');
        return { first: norm(f ?? ''), last: norm(l ?? '') };
    }
    const parts = full.trim().split(/\s+/);
    if (parts.length < 2) return parts[0] ? { first: '', last: norm(parts[0]) } : null;
    return { first: norm(parts[0]!), last: norm(parts.at(-1)!) };
}

/** The single UT Austin teacher matching the name, or null when none or several could match. */
export function pickTeacher(teachers: RmpTeacher[], name: { first: string; last: string }): RmpRating | null {
    const firstWord = name.first.split(/\s+/)[0] ?? '';
    const sameLast = teachers.filter(t => t.school.id === RMP_UT_SCHOOL_ID && norm(t.lastName) === name.last);
    const byFirst = firstWord
        ? sameLast.filter(t => {
              const f = norm(t.firstName).split(/\s+/)[0] ?? '';
              // "J" matches "John"; "John" matches "John" or "Johnny"
              return firstWord.length === 1
                  ? f.startsWith(firstWord)
                  : f.startsWith(firstWord) || firstWord.startsWith(f);
          })
        : sameLast;
    const rated = byFirst.filter(t => t.numRatings > 0);
    const pick = rated.length === 1 ? rated[0] : byFirst.length === 1 ? byFirst[0] : undefined;
    if (!pick) return null;
    return {
        legacyId: pick.legacyId,
        name: `${pick.firstName} ${pick.lastName}`,
        department: pick.department,
        avgRating: pick.avgRating,
        avgDifficulty: pick.avgDifficulty,
        numRatings: pick.numRatings,
        wouldTakeAgainPercent: pick.wouldTakeAgainPercent,
    };
}
