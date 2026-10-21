/**
 * Classifies how a section is delivered, using only what the UT listing actually says.
 *
 * Blue "asynchronous" highlighting is reserved for sections where the listing shows an
 * internet instruction mode AND no scheduled meeting days/times AND no physical room.
 * A "WB" room alone is never treated as asynchronous: many WB sections meet live online.
 */
import type { RawMeeting } from './meetings';
import { isVirtualRoom, meetingsFromRaw } from './meetings';

export type Modality = 'async-online' | 'live-online' | 'hybrid' | 'in-person' | 'unknown';

export interface ModalityResult {
    modality: Modality;
    /** Plain-language evidence used for tooltips */
    reasons: string[];
}

export interface ModalityInput {
    /** Raw text of the "Instruction Mode" column, e.g. "Internet", "Face-to-face", "Hybrid/Blended" */
    instructionModeText: string;
    meetings: RawMeeting[];
}

export const MODALITY_LABELS: Record<Modality, string> = {
    'async-online': 'Asynchronous online',
    'live-online': 'Live online',
    hybrid: 'Hybrid',
    'in-person': 'In person',
    unknown: 'Delivery unclear',
};

export function classifyModality({ instructionModeText, meetings }: ModalityInput): ModalityResult {
    const mode = instructionModeText.trim().toLowerCase();
    const isHybrid = /hybrid|blended/.test(mode);
    const isInternet = !isHybrid && /internet|online|web[\s-]?based|distance/.test(mode);
    const isFaceToFace = /face[\s-]?to[\s-]?face|in[\s-]?person|classroom/.test(mode);

    const timedLines = meetings.filter(m => m.daysText.trim() || m.hoursText.trim());
    const { meetings: parsed, complete } = meetingsFromRaw(meetings);
    const rooms = meetings.map(m => m.roomText.trim()).filter(Boolean);
    const physicalRooms = rooms.filter(r => !isVirtualRoom(r) && !/^(tba|tbd)$/i.test(r));
    const hasTba = meetings.some(m => /\b(tba|tbd|arr)/i.test(`${m.daysText} ${m.hoursText}`));

    if (isHybrid) {
        return { modality: 'hybrid', reasons: [`Instruction mode listed as "${instructionModeText.trim()}"`] };
    }

    if (isInternet) {
        const reasons = [`Instruction mode listed as "${instructionModeText.trim()}"`];
        if (physicalRooms.length) {
            reasons.push(
                `Listing also shows a physical room (${physicalRooms.join(', ')}), so attendance may be required`
            );
            return { modality: 'unknown', reasons };
        }
        if (timedLines.length === 0 && !hasTba) {
            reasons.push('No scheduled meeting days or times are listed');
            return { modality: 'async-online', reasons };
        }
        if (parsed.length > 0 && complete) {
            reasons.push(
                `Scheduled online meetings: ${timedLines.map(l => `${l.daysText.trim()} ${l.hoursText.trim()}`).join('; ')}`
            );
            return { modality: 'live-online', reasons };
        }
        reasons.push('Meeting times are incomplete or TBA, so live sessions cannot be ruled out');
        return { modality: 'unknown', reasons };
    }

    if (isFaceToFace || physicalRooms.length) {
        return {
            modality: 'in-person',
            reasons: [
                mode
                    ? `Instruction mode listed as "${instructionModeText.trim()}"`
                    : `Physical room listed (${physicalRooms.join(', ')})`,
            ],
        };
    }

    // No usable instruction mode. Do not guess from a WB room.
    if (rooms.some(isVirtualRoom) && parsed.length > 0 && complete) {
        return {
            modality: 'live-online',
            reasons: ['Room listed as web-based with scheduled meeting times', 'Instruction mode not listed'],
        };
    }
    return { modality: 'unknown', reasons: ['Instruction mode not listed on this page'] };
}

/** Whether a section has no scheduled meetings that could ever conflict */
export function isAsynchronous(result: ModalityResult): boolean {
    return result.modality === 'async-online';
}
