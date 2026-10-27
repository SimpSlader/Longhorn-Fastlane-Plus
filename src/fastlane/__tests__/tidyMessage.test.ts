import { describe, expect, it } from 'vitest';
import { tidyMessage } from '../core/tidyMessage';

describe('local message clean-up', () => {
    it('spells out abbreviations without adding preferences', () => {
        expect(tidyMessage('15 easy creds no fri, 1-2 async, no gov')).toBe(
            '15 easy credits no Friday, 1-2 fully online (asynchronous), no government.'
        );
        expect(tidyMessage('only tth pls')).toBe('Only Tuesday and Thursday please.');
        expect(tidyMessage('how many hrs do i have')).toBe('How many hours do I have?');
    });
});
