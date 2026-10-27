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

/** Listening stops after this long without any speech (or when the student taps the microphone). */
export const SILENCE_MS = 5000;

/** Errors after which listening must not restart by itself. */
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);

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
    // the box text before the current recognition session; each session adds after it
    const base = useRef('');
    const latest = useRef(text);
    latest.current = text;
    // true from the tap until 5 s of silence or a second tap; Chrome's own session ends restart quietly
    const wanted = useRef(false);
    const silence = useRef<ReturnType<typeof setTimeout> | null>(null);
    const local = useRef(false);

    const finish = () => {
        wanted.current = false;
        if (silence.current) clearTimeout(silence.current);
        silence.current = null;
        ref.current?.stop();
    };
    const armSilence = () => {
        if (silence.current) clearTimeout(silence.current);
        silence.current = setTimeout(finish, SILENCE_MS);
    };
    useEffect(
        () => () => {
            wanted.current = false;
            if (silence.current) clearTimeout(silence.current);
            ref.current?.abort();
        },
        []
    );

    const session = (Cls: RecognitionClass) => {
        const rec = new Cls();
        rec.lang = navigator.language || 'en-US';
        rec.interimResults = true;
        // keep listening through pauses; the silence timer decides when to stop
        rec.continuous = true;
        if (local.current) rec.processLocally = true;
        const now = latest.current.trim();
        base.current = now ? `${now} ` : '';
        rec.onresult = e => {
            let spoken = '';
            for (let i = 0; i < e.results.length; i++) spoken += e.results[i]![0]!.transcript;
            setText(`${base.current}${spoken.trim()}`);
            armSilence();
        };
        rec.onerror = e => {
            if (e.error === 'aborted' || e.error === 'no-speech') return;
            if (FATAL.has(e.error)) wanted.current = false;
            setError(ERRORS[e.error] ?? 'Voice typing stopped. You can try again or type.');
        };
        rec.onend = () => {
            ref.current = null;
            // Chrome ends sessions on its own (pauses, time limits): carry on until the student is done
            if (wanted.current) {
                try {
                    ref.current = session(Cls);
                    ref.current.start();
                    return;
                } catch {
                    wanted.current = false;
                }
            }
            if (silence.current) clearTimeout(silence.current);
            silence.current = null;
            setListening(false);
        };
        return rec;
    };

    const start = async () => {
        // looked up on each start (the page can be reloaded into a newer Chrome API at any time)
        const Cls = recognitionClass();
        if (!Cls || listening) return;
        setError('');
        // prefer on-device recognition when this Chrome offers it for the language
        local.current = false;
        try {
            const probe = new Cls();
            if ('processLocally' in probe && Cls.available)
                local.current =
                    (await Cls.available({ langs: [navigator.language || 'en-US'], processLocally: true })) ===
                    'available';
        } catch {
            local.current = false;
        }
        setOnDevice(local.current);
        wanted.current = true;
        try {
            ref.current = session(Cls);
            ref.current.start();
            setListening(true);
            armSilence();
        } catch {
            wanted.current = false;
            setError('Voice typing couldn’t start. You can still type.');
        }
    };

    return { supported, listening, error, onDevice, start, stop: finish, clearError: () => setError('') };
}
