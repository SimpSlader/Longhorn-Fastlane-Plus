/** Public project links (configurable at build time). */
export const FASTLANE_REPO_URL: string =
    (import.meta.env.VITE_FASTLANE_REPO_URL as string | undefined) ||
    'https://github.com/SimpSlader/Longhorn-Fastlane-Plus';

/** Opens a prefilled public GitHub issue; the student reviews and submits it themselves. */
export function feedbackIssueUrl(feedback: string): string {
    const version = globalThis.chrome?.runtime?.getManifest?.().version ?? 'unknown';
    const body = `${feedback}\n\n---\nExtension version: ${version}\n(Please do not include your EID, grades or other personal information.)`;
    return `${FASTLANE_REPO_URL}/issues/new?title=${encodeURIComponent('Feedback')}&body=${encodeURIComponent(body)}`;
}
