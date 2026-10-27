/** Fetch UT course pages with the existing session, without following SAML sign-in redirects. */
export class UtLoginRequiredError extends Error {
    constructor() {
        super('Sign in to UT in a normal browser tab, then try again.');
        this.name = 'UtLoginRequiredError';
    }
}

export function isUtCoursePage(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            url.origin === 'https://utdirect.utexas.edu' && url.pathname.startsWith('/apps/registrar/course_schedule/')
        );
    } catch {
        return false;
    }
}

export async function fetchUtRegistrar(url: string): Promise<Response> {
    if (!isUtCoursePage(url)) throw new Error('Expected a UT course-schedule URL.');
    const response = await fetch(url, { credentials: 'include', redirect: 'manual' });
    if (
        response.type === 'opaqueredirect' ||
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        response.status === 401 ||
        response.status === 403
    ) {
        throw new UtLoginRequiredError();
    }
    if (!response.ok) throw new Error('UT course details are temporarily unavailable.');
    return response;
}
