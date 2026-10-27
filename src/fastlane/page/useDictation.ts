/**
 * Voice typing for the chat box, with Chrome's built-in speech recognition. Words appear in the box as you
 * speak and are never sent anywhere by Fastlane until you press send. When this Chrome supports on-device
 * recognition it is used; otherwise Chrome's own speech service (Google) turns the audio into text, and the
 * chat says so. No audio is recorded or stored by Fastlane.
 */
import { useEffect, useRef, useState } from 'react';

interface Recognition {
    lang: string;
    interimResults: boolean;
    continuous: boolean;
    processLocally?: boolean;
    start(): void;
    stop(): void;
    abort(): void;
    onresult:
        | ((e: {
              resultIndex: number;
              results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
          }) => void)
        | null;
    onerror: ((e: { error: string }) => void) | null;
    onend: (() => void) | null;
}
type RecognitionClass = (new () => Recognition) & {
    available?: (opts: { langs: string[]; processLocally: boolean }) => Promise<string>;
};

const recognitionClass = (): RecognitionClass | null => {
    const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const ERRORS: Record<string, string> = {
    'not-allowed':
        'Microphone access is blocked. Allow the microphone for Fastlane in Chrome (the icon in the address bar), then try again.',
    'service-not-allowed': 'Chrome’s speech service isn’t available here. You can still type your message.',
    'no-speech': 'I didn’t hear anything. Tap the microphone and try again.',
    'audio-capture': 'No microphone was found. Check that one is connected.',
    network: 'Voice typing needs a connection to Chrome’s speech service right now. You can still type.',
};

/**
 * @param text current box text; spoken words are added after it
 * @param setText updates the box
 */
export function useDictation(text: string, setText: (value: string) => void) {
    const supported = !!recognitionClass();
    const [listening, setListening] = useState(false);
    const [error, setError] = useState('');
    const [onDevice, setOnDevice] = useState<boolean | null>(null);
    const ref = useRef<Recognition | null>(null);
    const base = useRef('');
    useEffect(() => () => ref.current?.abort(), []);

    const start = async () => {
        // looked up on each start (the page can be reloaded into a newer Chrome API at any time)
        const Cls = recognitionClass();
        if (!Cls || listening) return;
        setError('');
        const rec = new Cls();
        rec.lang = navigator.language || 'en-US';
        rec.interimResults = true;
        rec.continuous = false;
        // prefer on-device recognition when this Chrome offers it for the language
        let local = false;
        try {
            if ('processLocally' in rec && Cls.available)
                local = (await Cls.available({ langs: [rec.lang], processLocally: true })) === 'available';
        } catch {
            local = false;
        }
        if (local) rec.processLocally = true;
        setOnDevice(local);
        base.current = text.trim() ? `${text.trim()} ` : '';
        rec.onresult = e => {
            let spoken = '';
            for (let i = 0; i < e.results.length; i++) spoken += e.results[i]![0]!.transcript;
            setText(`${base.current}${spoken.trim()}`);
        };
        rec.onerror = e => {
            if (e.error !== 'aborted') setError(ERRORS[e.error] ?? 'Voice typing stopped. You can try again or type.');
        };
        rec.onend = () => {
            setListening(false);
            ref.current = null;
        };
        ref.current = rec;
        try {
            rec.start();
            setListening(true);
        } catch {
            setError('Voice typing couldn’t start. You can still type.');
        }
    };
    const stop = () => ref.current?.stop();

    return { supported, listening, error, onDevice, start, stop, clearError: () => setError('') };
}
