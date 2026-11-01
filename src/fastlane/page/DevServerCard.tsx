/**
 * Developer test server (local builds only). Lets the installed candidate extension talk to this project's protected
 * Vercel PREVIEW instead of production, so the new AI prompt, tools and scheduling engine are tested together.
 *
 * Safety: only this project's own preview hosts are accepted; access to that host is an optional permission the
 * browser asks you to approve; the preview's Vercel login is your own browser cookie (open the preview once);
 * the test access code is stored locally, never synced, never shown again; deployment protection stays on.
 */
import { useState } from 'react';
import { aiFetch, isPreviewOrigin } from '../services/aiClient';
import { FastlaneDevServerStore } from '../storage/stores';

export const isLocalBuild = import.meta.env.VITE_FASTLANE_DEV_AUTORELOAD === 'true';

const SUGGESTED = 'https://longhorn-fastlane-plus-git-feat-nl-fc50bc-simpsladers-projects.vercel.app';

export default function DevServerCard() {
    const saved = FastlaneDevServerStore.useStore(s => s.base);
    const hasCode = FastlaneDevServerStore.useStore(s => !!s.code);
    const [base, setBase] = useState(saved || SUGGESTED);
    const [code, setCode] = useState('');
    const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);

    const origin = () => {
        try {
            const o = new URL(base).origin;
            return isPreviewOrigin(o) ? o : null;
        } catch {
            return null;
        }
    };

    const connect = async () => {
        const o = origin();
        if (!o) return setMessage({ text: 'Only this project’s own Vercel preview URLs are allowed.', tone: 'bad' });
        const granted = await chrome.permissions.request({ origins: [`${o}/*`] });
        if (!granted) return setMessage({ text: 'Chrome permission was not granted.', tone: 'bad' });
        await FastlaneDevServerStore.set({ base: o, ...(code.trim() ? { code: code.trim() } : {}) });
        setCode('');
        setMessage({
            text: `The AI now uses ${new URL(o).host}. Open it once to sign in, then check the connection.`,
            tone: 'ok',
        });
    };

    const check = async () => {
        const state = await FastlaneDevServerStore.all();
        if (!state.base) return setMessage({ text: 'Production is in use. Nothing to check here.', tone: 'ok' });
        try {
            const res = await aiFetch('ai-status', { accessCode: state.code });
            const body = (await res.json().catch(() => ({}))) as { error?: unknown };
            if (res.ok) setMessage({ text: 'Connected: the test server accepted the request.', tone: 'ok' });
            else
                setMessage({
                    text:
                        res.status === 401
                            ? 'The preview is protected: open it once in a tab and sign in to Vercel, then check again.'
                            : `The test server answered HTTP ${res.status}${typeof body.error === 'string' ? `: ${body.error}` : ''}.`,
                    tone: 'bad',
                });
        } catch (e) {
            setMessage({ text: e instanceof Error ? e.message : 'Could not reach the test server.', tone: 'bad' });
        }
    };

    return (
        <section className='card stack' aria-label='Developer test server'>
            <h2>Developer: AI test server</h2>
            <p className='small muted'>
                Currently using: <b>{saved ? new URL(saved).host : 'production'}</b>
                {saved && (hasCode ? ' · test code saved' : ' · no test code (uses your saved access code)')}
            </p>
            <label className='field'>
                Preview URL (this project’s own Vercel preview only)
                <input value={base} onChange={e => setBase(e.target.value)} spellCheck={false} />
            </label>
            <label className='field'>
                Test access code for that preview (kept only in this browser)
                <input type='password' value={code} onChange={e => setCode(e.target.value)} autoComplete='off' />
            </label>
            <div className='row'>
                <button type='button' className='btn primary' onClick={() => void connect()}>
                    Connect
                </button>
                <button
                    type='button'
                    className='btn'
                    onClick={() => {
                        const o = origin();
                        if (o) window.open(o, '_blank', 'noopener');
                    }}
                >
                    Open preview to sign in
                </button>
                <button type='button' className='btn' onClick={() => void check()}>
                    Check connection
                </button>
                <button
                    type='button'
                    className='btn'
                    onClick={async () => {
                        await FastlaneDevServerStore.set({ base: '', code: '' });
                        setMessage({ text: 'Back on production.', tone: 'ok' });
                    }}
                >
                    Use production
                </button>
            </div>
            {message && <div className={`notice small ${message.tone}`}>{message.text}</div>}
        </section>
    );
}
