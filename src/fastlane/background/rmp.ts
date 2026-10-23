/**
 * Background fetch of Rate My Professors ratings. Runs in the service worker (host permission for
 * ratemyprofessors.com), sends no cookies, caches each name for 7 days, and limits parallel requests.
 */
import type { RmpRating, RmpTeacher } from '../core/rmp';
import { pickTeacher, RMP_GRAPHQL, RMP_QUERY, RMP_UT_SCHOOL_ID } from '../core/rmp';

const CACHE_KEY = 'fastlaneRmpCache';
const TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_PARALLEL = 3;

type Cache = Record<string, { at: number; rating: RmpRating | null }>;

let cache: Promise<Cache> | null = null;
const inflight = new Map<string, Promise<RmpRating | null>>();
let running = 0;
const waiting: Array<() => void> = [];

function loadCache(): Promise<Cache> {
    cache ??= chrome.storage.local.get(CACHE_KEY).then(r => (r[CACHE_KEY] as Cache | undefined) ?? {});
    return cache;
}

async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= MAX_PARALLEL) await new Promise<void>(ok => waiting.push(ok));
    running++;
    try {
        return await work();
    } finally {
        running--;
        waiting.shift()?.();
    }
}

async function search(last: string): Promise<RmpTeacher[]> {
    const res = await fetch(RMP_GRAPHQL, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic dGVzdDp0ZXN0' },
        body: JSON.stringify({ query: RMP_QUERY, variables: { text: last, schoolID: RMP_UT_SCHOOL_ID } }),
    });
    if (!res.ok) throw new Error(`Rate My Professors returned ${res.status}`);
    const json = (await res.json()) as {
        data?: { newSearch?: { teachers?: { edges?: Array<{ node: RmpTeacher }> } } };
    };
    return json.data?.newSearch?.teachers?.edges?.map(e => e.node) ?? [];
}

export async function professorRating(first: string, last: string): Promise<RmpRating | null> {
    const key = `${last}|${first}`;
    const store = await loadCache();
    const hit = store[key];
    if (hit && Date.now() - hit.at < TTL) return hit.rating;
    let pending = inflight.get(key);
    if (!pending) {
        pending = slot(() => search(last))
            .then(async teachers => {
                const rating = pickTeacher(teachers, { first, last });
                store[key] = { at: Date.now(), rating };
                await chrome.storage.local.set({ [CACHE_KEY]: store });
                return rating;
            })
            .finally(() => inflight.delete(key));
        inflight.set(key, pending);
    }
    return pending;
}
