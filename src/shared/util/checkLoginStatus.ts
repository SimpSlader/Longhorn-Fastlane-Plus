import { UTRP_LOGIN_URL } from '@shared/util/appUrls';
import { fetchUtRegistrar } from '@shared/util/fetchUtRegistrar';

/**
 * Checks whether the user is logged in to the UT Registrar.
 * Performs a cookie-only auth check and returns a pure boolean; callers own any UI affordance.
 *
 * @returns A promise that resolves to `true` if the user is logged in, otherwise `false`.
 */
export async function validateLoginStatus(): Promise<boolean> {
    try {
        await fetchUtRegistrar(UTRP_LOGIN_URL);
        return true;
    } catch {
        return false;
    }
}
