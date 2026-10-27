import { useEffect, useState } from 'react';
import {
    PERSONAL_PROVIDER_IDS,
    PERSONAL_PROVIDERS,
    type PersonalCredential,
    type PersonalProvider,
} from '../core/personalAi';
import { sendFastlane } from '../services/runtime';
import { FastlanePersonalAiStore } from '../storage/stores';

const STEPS: Record<PersonalProvider, string[]> = {
    groq: [
        'Open GroqCloud and sign in.',
        'Click Create API Key. Give it a name, such as FastLane.',
        'Copy the new key, paste it below, then click Save & use.',
    ],
    gemini: [
        'Open Google AI Studio and sign in.',
        'Click Create API key and choose or create a project.',
        'Click Copy key, paste it below, then click Save & use. Keep billing off for that project.',
    ],
    cloudflare: [
        'Open Workers AI in your Cloudflare account.',
        'Click Use REST API, then Create a Workers AI API Token.',
        'Copy the API token and Account ID into the two fields below.',
        'Click Save & use. Use the Workers Free plan.',
    ],
};
function ProviderKey({ id }: { id: PersonalProvider }) {
    const provider = PERSONAL_PROVIDERS[id];
    const config = FastlanePersonalAiStore.useStore(s => s);
    const stored = config.providers[id];
    const [key, setKey] = useState('');
    const [accountId, setAccountId] = useState(stored.accountId);
    const [free, setFree] = useState(stored.freeConfirmed);
    const [academic, setAcademic] = useState(stored.allowAcademic);
    const [show, setShow] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [ok, setOk] = useState(false);
    useEffect(() => {
        setFree(stored.freeConfirmed);
        setAcademic(stored.allowAcademic);
        setAccountId(stored.accountId);
    }, [stored.freeConfirmed, stored.allowAcademic, stored.accountId]);
    const test = async () => {
        setBusy(true);
        setMessage('Checking connection…');
        setOk(false);
        try {
            const result = await sendFastlane<{
                status: number;
                payload: { ok?: boolean; message?: string; error?: string };
            }>({ type: 'personalAi', path: 'ai-status', body: { test: id }, requestId: crypto.randomUUID() });
            setOk(result.payload.ok === true);
            setMessage(result.payload.message ?? result.payload.error ?? 'Connection could not be verified.');
        } catch {
            setMessage('Connection could not be verified. Try again.');
        } finally {
            setBusy(false);
        }
    };
    const save = async () => {
        const next: PersonalCredential = {
            key: (key || stored.key).trim(),
            accountId: accountId.trim(),
            freeConfirmed: free,
            allowAcademic: academic,
        };
        if (next.key.length < 8 || next.key.length > 512 || /\s/.test(next.key)) {
            setOk(false);
            setMessage('Paste the complete key, without spaces or line breaks.');
            return;
        }
        if (id === 'cloudflare' && !/^[a-f\d]{32}$/i.test(next.accountId)) {
            setOk(false);
            setMessage('Paste the 32-character Account ID from Cloudflare.');
            return;
        }
        if (!free) {
            setOk(false);
            setMessage('Confirm your free plan and billing settings below first.');
            return;
        }
        setBusy(true);
        setMessage('');
        setOk(false);
        try {
            // Called directly from a user click, so Chrome can show its provider-permission prompt.
            const allowed = await chrome.permissions.request({ origins: [provider.origin] });
            if (!allowed) {
                setMessage('Chrome did not allow this provider. Click Save & use to try again.');
                return;
            }
            const providers = await FastlanePersonalAiStore.get('providers');
            await FastlanePersonalAiStore.set({ providers: { ...providers, [id]: next }, provider: id, enabled: true });
            setKey('');
            setShow(false);
            setOk(true);
            setMessage(`${provider.label} saved on this device. Click Test connection to check it.`);
        } catch {
            setMessage('The key could not be saved. Try again.');
        } finally {
            setBusy(false);
        }
    };
    const remove = async () => {
        setBusy(true);
        try {
            const providers = await FastlanePersonalAiStore.get('providers');
            await FastlanePersonalAiStore.set('providers', {
                ...providers,
                [id]: { key: '', accountId: '', freeConfirmed: false, allowAcademic: false },
            });
            await chrome.permissions.remove({ origins: [provider.origin] });
            setKey('');
            setMessage('Key removed from this device.');
            setOk(true);
        } catch {
            setMessage('The key could not be removed. Try again.');
            setOk(false);
        } finally {
            setBusy(false);
        }
    };
    return (
        <section className='ai-key-card stack' aria-label={`${provider.label} API key`}>
            <div className='row between'>
                <h3>{provider.label}</h3>
                {config.enabled && config.provider === id && stored.key && <span className='badge'>In use</span>}
            </div>
            <a className='fl-link' href={provider.url} target='_blank' rel='noreferrer'>
                Get a {provider.label} API key ↗
            </a>
            <details>
                <summary>How to get a key</summary>
                <ol>
                    {STEPS[id].map(step => (
                        <li key={step}>{step}</li>
                    ))}
                </ol>
                {id === 'cloudflare' && (
                    <p className='small'>
                        Use the Workers AI token template. A manually created token needs Workers AI Read and Edit
                        permissions for your account.
                    </p>
                )}
                <a href={provider.help} target='_blank' rel='noreferrer'>
                    Official setup guide ↗
                </a>
            </details>
            <label className='field'>
                {id === 'cloudflare' ? 'API token' : 'API key'}
                <input
                    type={show ? 'text' : 'password'}
                    value={key}
                    onChange={e => setKey(e.target.value)}
                    autoComplete='off'
                    spellCheck={false}
                    placeholder={stored.key ? 'Key saved — paste to replace' : 'Paste your key here'}
                    aria-label={`${provider.label} API key`}
                />
            </label>
            <label className='check small'>
                <input type='checkbox' checked={show} onChange={e => setShow(e.target.checked)} />
                Show the key I’m entering
            </label>
            {id === 'cloudflare' && (
                <label className='field'>
                    Cloudflare Account ID
                    <input
                        value={accountId}
                        onChange={e => setAccountId(e.target.value)}
                        autoComplete='off'
                        spellCheck={false}
                        placeholder='32-character Account ID'
                    />
                </label>
            )}
            <label className='check small'>
                <input type='checkbox' checked={free} onChange={e => setFree(e.target.checked)} />
                {id === 'gemini'
                    ? 'This Google project has billing off and uses the free tier.'
                    : id === 'cloudflare'
                      ? 'This account is on Workers Free.'
                      : 'This Groq account is on the free plan.'}
            </label>
            {id === 'gemini' && (
                <label className='check small'>
                    <input type='checkbox' checked={academic} onChange={e => setAcademic(e.target.checked)} />
                    Allow my course and degree summaries to be sent to Gemini. Google may use free-tier inputs to
                    improve its products.
                </label>
            )}
            <div className='row'>
                <button type='button' className='btn primary sm' disabled={busy} onClick={() => void save()}>
                    Save & use
                </button>
                <button type='button' className='btn sm' disabled={busy || !stored.key} onClick={() => void test()}>
                    Test connection
                </button>
                {stored.key && (
                    <button type='button' className='btn sm' disabled={busy} onClick={() => void remove()}>
                        Remove key
                    </button>
                )}
            </div>
            <p className='small muted'>{provider.labelModel} · Your provider controls its free quota.</p>
            {message && (
                <div role='status' className={`notice small ${ok ? 'ok' : 'warn'}`}>
                    {message}
                </div>
            )}
        </section>
    );
}
export default function PersonalAiSettings() {
    const config = FastlanePersonalAiStore.useStore(s => s);
    return (
        <section className='card stack' aria-label='Use your own API keys'>
            <h2>Use your own API keys</h2>
            <p className='small muted'>
                Optional. Connect one provider to use AI without a FastLane invite. Keys stay in this Chrome profile,
                are excluded from exports, and go only to the provider you choose. FastLane’s server never receives
                them.
            </p>
            <label className='check'>
                <input
                    type='checkbox'
                    checked={config.enabled}
                    disabled={!config.enabled && !config.providers[config.provider].key}
                    onChange={e => void FastlanePersonalAiStore.set('enabled', e.target.checked)}
                />
                Use my own key for AI
            </label>
            <p className='small muted'>
                {config.enabled
                    ? config.providers[config.provider].key
                        ? `Using your ${PERSONAL_PROVIDERS[config.provider].label} key. FastLane won’t switch to the shared account if this connection fails.`
                        : 'Add a key below to continue using AI, or turn off personal-key mode to use your FastLane access.'
                    : 'Your existing FastLane access stays in use until you connect a provider.'}
            </p>
            <div className='ai-key-grid'>
                {PERSONAL_PROVIDER_IDS.map(id => (
                    <ProviderKey key={id} id={id} />
                ))}
            </div>
        </section>
    );
}
