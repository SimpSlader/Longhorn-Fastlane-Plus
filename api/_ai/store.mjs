/**
 * Where the router keeps quota counters, cooldowns, measured quality and recent routing decisions. With
 * KV_REST_API_URL/KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL/_TOKEN) set, they persist across restarts and
 * are shared by every server instance; without them they live in this instance's memory and the status page
 * says so. Values are small JSON documents; nothing about a student is stored here.
 */
const memory = new Map();

function remote(env = process.env) {
    const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
    const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
    return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

export const storeKind = () => (remote() ? 'persistent' : 'memory');

export async function getJSON(key) {
    const r = remote();
    if (!r) {
        const hit = memory.get(key);
        if (!hit) return null;
        if (hit.expires && hit.expires < Date.now()) {
            memory.delete(key);
            return null;
        }
        return hit.value;
    }
    try {
        const res = await fetch(`${r.url}/get/${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${r.token}` },
        });
        const body = await res.json();
        return body?.result ? JSON.parse(body.result) : null;
    } catch {
        return memory.get(key)?.value ?? null;
    }
}

export async function setJSON(key, value, ttlSeconds) {
    const expires = ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0;
    memory.set(key, { value, expires });
    const r = remote();
    if (!r) return;
    try {
        await fetch(`${r.url}/set/${encodeURIComponent(key)}${ttlSeconds ? `?EX=${Math.ceil(ttlSeconds)}` : ''}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${r.token}` },
            body: JSON.stringify(value),
        });
    } catch {
        // the in-memory copy still protects this instance
    }
}

/** Test helper: forget everything kept in memory. */
export function resetMemoryStore() {
    memory.clear();
}
