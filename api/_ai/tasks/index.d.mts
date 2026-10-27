export interface ModelOutput {
    text: string;
    json?: Record<string, unknown>;
    usage: { input: number; output: number };
}
export interface PersonalTask {
    task: string;
    system: string;
    user: string;
    maxTokens: number;
    temperature?: number;
    schema?: object;
    schemaName?: string;
    containsStudentData: boolean;
    validate(out: ModelOutput): string | null;
    format(out: ModelOutput): Record<string, unknown>;
}
export function preparePersonalTask(path: string, body: Record<string, unknown>): PersonalTask;
