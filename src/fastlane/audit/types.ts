export type RequirementStatus = 'completed' | 'in-progress' | 'not-started';
export type Confidence = 'high' | 'medium' | 'low';
export type RequirementCategory = 'core' | 'general' | 'major' | 'minor' | 'hours' | 'gpa' | 'other';

export interface Progress {
    value: number;
    unit: 'hours' | 'courses';
}

export interface AuditRequirement {
    id: string;
    section: string;
    text: string;
    category: RequirementCategory;
    status: RequirementStatus;
    required?: Progress;
    applied?: Progress;
    remaining?: Progress;
    /** normalized requirement tags, e.g. "CORE 050" */
    tags: string[];
    /** course codes listed as applied to this requirement */
    courses: string[];
    confidence: Confidence;
    /** why the parser is unsure; shown on the review screen */
    issues: string[];
    /** set once the student corrected or confirmed this item */
    reviewed?: boolean;
}

export type AuditCourseStatus = 'completed' | 'in-progress' | 'planned' | 'pending-transfer';

export interface AuditCourse {
    code: string;
    name: string;
    grade: string;
    unique: string;
    /** "In-Residence" | "Transfer" | "Credit By Exam" | other text as listed */
    type: string;
    hours: number;
    semester: string;
    status: AuditCourseStatus;
    /** an equivalent or cross-listed course the IDA shows under a real enrollment (unique 00000); never extra hours */
    equivalent?: boolean;
    /** shown with a dash ("- 3"): excluded from the degree's hours */
    excluded?: boolean;
}

export interface ParsedAudit {
    source: 'html' | 'pdf';
    fileName?: string;
    parsedAt: number;
    program?: string;
    requirements: AuditRequirement[];
    /** Only present when the imported IDA explicitly labels a completion percentage. Never inferred from rule counts. */
    officialProgress?: { percent: number; source: 'ida-html' | 'ida-pdf' };
    courses: AuditCourse[];
    transfer: { accepted: AuditCourse[]; pending: AuditCourse[] };
    /** total degree hours if a rule states them */
    creditHours: { required?: number; applied?: number; remaining?: number; confidence: Confidence };
    /** totals the IDA prints under its course list ("Total Hours Taken" includes planned courses) */
    hourTotals?: { taken?: number; excluded?: number };
    /** prerequisite / restriction sentences found in the audit */
    restrictions: string[];
    warnings: string[];
}
