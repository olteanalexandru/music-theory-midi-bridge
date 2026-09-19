// The MIDI log: what a receiver would make of the bytes, said in words.
//
// Nothing here can change what reaches a port - the log only reads what the
// server already forwarded - so what these pin down is whether the log tells
// the truth. A log that says "MPE: OK" about a stream Ableton cannot use, or
// reads a bend at the wrong range, is worse than no log: it sends somebody
// debugging a real fault off to look somewhere else.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BASELINE_SETTLE_FRAMES,
    LeadBaseline,
    MidiDecoder,
    MidiLogger,
    WARNING_REPEAT_MS,
    bendToSemitones,
    describe as describeEvent,
    formatChannels,
    messageLength,
    noteName,
    type MidiLogLevel,
    type MidiLogMessage,
} from '../src/midiLog.js';

/** Feeds frames to a decoder the way the logger does, returning each event's description. */
function feed(decoder: MidiDecoder, ...frames: number[][]): string[] {
    const lines: string[] = [];
    for (const bytes of frames) {
        const count = decoder.beginFrame(bytes);
        for (let i = 0; i < count; i++) lines.push(describeEvent(decoder.decodeMessage(bytes, i), bytes));
    }
    return lines;
}

/** Every warning the decoder raised while fed these frames. */
function warningsFrom(decoder: MidiDecoder, ...frames: number[][]): string[] {
    const warnings: string[] = [];
    for (const bytes of frames) {
        const count = decoder.beginFrame(bytes);
        warnings.push(...decoder.frameWarnings);
        for (let i = 0; i < count; i++) {
            decoder.decodeMessage(bytes, i);
            warnings.push(...decoder.warnings);
        }
    }
    return warnings;
}

/** The app's own encoder, MidiSender.pitchBendOn, copied so the inverse is checked against it. */
function appBend(channel: number, semitones: number, range: number): number[] {
    const clamped = Math.max(-range, Math.min(range, semitones));
    const raw = Math.max(0, Math.min(16383, Math.round(8192 + (clamped / range) * 8191)));
    return [0xe0 | channel, raw & 0x7f, (raw >> 7) & 0x7f];
}

/** The app's MPE preamble for a lower zone: MCM, then RPN 0 on each member, then the master. */
function preamble(members = 15, memberRange = 48, masterRange = 2): number[][] {
    const frames: number[][] = [
        [0xb0, 101, 0],
        [0xb0, 100, 6],
        [0xb0, 6, members],
        [0xb0, 101, 127],
        [0xb0, 100, 127],
    ];
    const rpn0 = (channel: number, semitones: number) => [
        [0xb0 | channel, 101, 0],
        [0xb0 | channel, 100, 0],
        [0xb0 | channel, 6, semitones],
        [0xb0 | channel, 38, 0],
        [0xb0 | channel, 101, 127],
        [0xb0 | channel, 100, 127],
    ];
    for (let channel = 1; channel <= members; channel++) frames.push(...rpn0(channel, memberRange));
    frames.push(...rpn0(0, masterRange));
    return frames;
}

/** The fixture server.test.ts carries through a real socket. */
const HANDSHAKE = [
    [0xb0, 101, 0],
    [0xb0, 100, 6],
    [0xb0, 6, 15],
    [0xb1, 101, 0],
    [0xb1, 100, 0],
    [0xb1, 6, 48],
    [0x91, 60, 100],
    [0xe1, 0x00, 0x60],
    [0x81, 60, 64],
];

describe('the MPE handshake', () => {
    it('reads the MCM, the member range and the per-note bend the way a receiver would', () => {
        const decoder = new MidiDecoder('win32');
        const lines = feed(decoder, ...HANDSHAKE);

        expect(lines[2]).toBe('MCM: lower zone, 15 member channels (ch 2-16)');
        expect(lines[5]).toBe('RPN 0 pitch-bend range = 48 st');
        expect(lines[6]).toBe('NoteOn     C4 (60)  vel 100');
        // 0x60 << 7 = 12288: (12288 - 8192) / 8191 * 48.
        expect(lines[7]).toBe(`PitchBend  +${((4096 / 8191) * 48).toFixed(2)} st (raw 12288, range +/-48)`);
        expect(lines[8]).toBe('NoteOff    C4 (60)  vel 64');

        expect(decoder.zones()).toEqual([{ zone: 'lower', master: 0, members: Array.from({ length: 15 }, (_, i) => i + 1) }]);
        expect(decoder.bendRange(1)).toEqual({ range: 48, source: 'rpn' });
    });

    it('sums it up as MPE a receiver can use', () => {
        const decoder = new MidiDecoder('win32');
        feed(decoder, ...HANDSHAKE);
        const summary = decoder.summary();
        expect(summary.verdict).toBe('MPE: OK');
        expect(summary.ok).toBe(true);
        expect(summary.mcmCount).toBe(1);
        expect(summary.notesBeforeMcm).toBe(0);
        expect(summary.membersUsed).toEqual([1]);
        expect(summary.rpnRanges[1]).toBe(48);
        expect(summary.held).toEqual([]);
        expect(summary.warnings).toBe(0);
    });

    it('reads the full preamble the app sends, one range per channel', () => {
        const decoder = new MidiDecoder('linux');
        const warnings = warningsFrom(decoder, ...preamble(15, 48, 2));
        expect(warnings).toEqual([]);
        for (let channel = 1; channel <= 15; channel++) expect(decoder.bendRange(channel)).toEqual({ range: 48, source: 'rpn' });
        expect(decoder.bendRange(0)).toEqual({ range: 2, source: 'rpn' });
    });
});

describe('the MPE Configuration Message', () => {
    it('implies the spec defaults until RPN 0 says otherwise: 48 for members, 2 for the master', () => {
        const decoder = new MidiDecoder('win32');
        feed(decoder, [0xb0, 101, 0], [0xb0, 100, 6], [0xb0, 6, 8]);
        expect(decoder.bendRange(3)).toEqual({ range: 48, source: 'mcm' });
        expect(decoder.bendRange(0)).toEqual({ range: 2, source: 'mcm' });
        // Outside the eight members nothing was said, so General MIDI's 2.
        expect(decoder.bendRange(12)).toEqual({ range: 2, source: 'assumed' });

        const [line] = feed(decoder, appBend(3, 12, 48));
        expect(line).toBe('PitchBend  +12.00 st (raw 10240, range +/-48 MPE default)');
    });

    it('reads an upper zone off channel 16, counting down', () => {
        const decoder = new MidiDecoder('win32');
        const [, , line] = feed(decoder, [0xbf, 101, 0], [0xbf, 100, 6], [0xbf, 6, 3]);
        expect(line).toBe('MCM: upper zone, 3 member channels (ch 13-15)');
        expect(decoder.isMaster(15)).toBe(true);
        expect(decoder.isMember(12)).toBe(true);
        expect(decoder.isMember(11)).toBe(false);
    });

    it('shrinks the other zone rather than letting two overlap', () => {
        const decoder = new MidiDecoder('win32');
        feed(decoder, [0xb0, 101, 0], [0xb0, 100, 6], [0xb0, 6, 10]);
        feed(decoder, [0xbf, 101, 0], [0xbf, 100, 6], [0xbf, 6, 8]);
        const zones = decoder.zones();
        expect(zones.find((zone) => zone.zone === 'upper')?.members).toHaveLength(8);
        expect(zones.find((zone) => zone.zone === 'lower')?.members).toHaveLength(6);
    });

    it('says a zone was released', () => {
        const decoder = new MidiDecoder('win32');
        const lines = feed(decoder, [0xb0, 101, 0], [0xb0, 100, 6], [0xb0, 6, 15], [0xb0, 6, 0]);
        expect(lines[3]).toBe('MCM: lower zone released (0 member channels)');
        expect(decoder.zones()).toEqual([]);
    });

    it('is ignored, and says so, on a channel that cannot be a master', () => {
        const decoder = new MidiDecoder('win32');
        const warnings = warningsFrom(decoder, [0xb4, 101, 0], [0xb4, 100, 6], [0xb4, 6, 15]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('MCM (RPN 6) on ch 5 is ignored');
        expect(decoder.zones()).toEqual([]);
    });
});

describe('RPN handling', () => {
    it('takes the cents of RPN 0 from data entry LSB', () => {
        const decoder = new MidiDecoder('win32');
        feed(decoder, [0xb2, 101, 0], [0xb2, 100, 0], [0xb2, 6, 24], [0xb2, 38, 50]);
        expect(decoder.bendRange(2)).toEqual({ range: 24.5, source: 'rpn' });
    });

    it('does not take a data entry after RPN null as a new range', () => {
        // The reason the app sends RPN null after every RPN: a later CC 6 must
        // not silently retune the bend range.
        const decoder = new MidiDecoder('win32');
        const lines = feed(
            decoder,
            [0xb2, 101, 0],
            [0xb2, 100, 0],
            [0xb2, 6, 24],
            [0xb2, 101, 127],
            [0xb2, 100, 127],
            [0xb2, 6, 96]
        );
        expect(decoder.bendRange(2).range).toBe(24);
        expect(lines[5]).toBe('CC 6 Data Entry = 96');
    });

    it('names other RPNs and NRPNs by number', () => {
        const decoder = new MidiDecoder('win32');
        const lines = feed(decoder, [0xb0, 101, 0], [0xb0, 100, 2], [0xb0, 6, 64], [0xb0, 99, 1], [0xb0, 98, 8], [0xb0, 6, 3]);
        expect(lines[2]).toBe('RPN 0/2 coarse tuning = 64');
        expect(lines[5]).toBe('NRPN 1/8 = 3');
    });
});

describe('pitch bend arithmetic', () => {
    it('is the exact inverse of the app encoder, to within one raw step', () => {
        for (const range of [1, 2, 12, 24, 48, 96]) {
            for (const semitones of [-range, -range / 3, -1.25, -0.01, 0, 0.01, 0.5, 1.25, range / 2, range]) {
                const [, lsb, msb] = appBend(1, semitones, range);
                const decoded = bendToSemitones(lsb | (msb << 7), range);
                // The encoder clamps to the range, so that is what comes back.
                const sent = Math.max(-range, Math.min(range, semitones));
                expect(Math.abs(decoded - sent), `${semitones} st at +/-${range}`).toBeLessThanOrEqual(range / 8191 / 2 + 1e-12);
            }
        }
    });

    it('lands exactly on the ends and the centre', () => {
        expect(bendToSemitones(8192 + 8191, 48)).toBe(48);
        expect(bendToSemitones(8192 - 8191, 48)).toBe(-48);
        expect(bendToSemitones(8192, 48)).toBe(0);
    });

    it('prints the example from the plan', () => {
        const decoder = new MidiDecoder('win32');
        feed(decoder, [0xb1, 101, 0], [0xb1, 100, 0], [0xb1, 6, 48]);
        const [line] = feed(decoder, appBend(1, 1.25, 48));
        expect(line).toBe('PitchBend  +1.25 st (raw 8405, range +/-48)');
    });

    it('says centre rather than +0.00 at 8192', () => {
        const decoder = new MidiDecoder('win32');
        expect(feed(decoder, [0xe1, 0x00, 0x40])[0]).toBe('PitchBend  centre (raw 8192, range +/-2 assumed)');
    });

    it('reads a negative bend with its sign', () => {
        const decoder = new MidiDecoder('win32');
        feed(decoder, [0xb1, 101, 0], [0xb1, 100, 0], [0xb1, 6, 48]);
        expect(feed(decoder, appBend(1, -3, 48))[0]).toBe('PitchBend  -3.00 st (raw 7680, range +/-48)');
    });
});

describe('controllers and the rest', () => {
    const decoder = new MidiDecoder('win32');
    it.each([
        [[0xb1, 74, 64], 'CC 74 Slide/Timbre = 64'],
        [[0xb0, 1, 20], 'CC 1 Modulation = 20'],
        [[0xb1, 11, 90], 'CC 11 Expression = 90'],
        [[0xb0, 64, 127], 'CC 64 Sustain on'],
        [[0xb0, 64, 0], 'CC 64 Sustain off'],
        [[0xb1, 123, 0], 'CC 123 All Notes Off'],
        [[0xb1, 120, 0], 'CC 120 All Sound Off'],
        [[0xb0, 20, 5], 'CC 20 = 5'],
        [[0xd1, 40], 'ChanPressure 40'],
        [[0xa1, 60, 40], 'PolyPressure C4 (60) = 40'],
        [[0xc0, 12], 'Program    12'],
        [[0xf8], 'Clock (F8)'],
        [[0xfa], 'Start (FA)'],
        [[0xfc], 'Stop (FC)'],
    ])('%j reads as %s', (bytes, text) => {
        expect(feed(decoder, bytes)[0]).toBe(text);
    });

    it('names a GM drum on channel 10', () => {
        expect(feed(new MidiDecoder('win32'), [0x99, 36, 110])[0]).toBe('NoteOn     C2 (36)  vel 110  (drums, GM: Bass Drum 1)');
    });

    it('does not name drums on channel 10 while it is a member of an MPE zone', () => {
        // The live log printed "Tambourine" and "Vibraslap" for ordinary MPE
        // notes the allocator had put on channel 10: inside a zone it is a
        // member channel like the rest, and its notes are pitches.
        const decoder = new MidiDecoder('win32');
        feed(decoder, ...preamble(15));
        expect(feed(decoder, [0x99, 54, 110], [0x89, 54, 0])).toEqual(['NoteOn     F#3 (54)  vel 110', 'NoteOff    F#3 (54)  vel 0']);
    });

    it('names them again when the zone stops short of channel 10, or is released', () => {
        const short = new MidiDecoder('win32');
        feed(short, ...preamble(8));
        expect(feed(short, [0x99, 54, 110])[0]).toBe('NoteOn     F#3 (54)  vel 110  (drums, GM: Tambourine)');

        const released = new MidiDecoder('win32');
        feed(released, ...preamble(15), [0xb0, 101, 0], [0xb0, 100, 6], [0xb0, 6, 0]);
        expect(feed(released, [0x99, 58, 110])[0]).toBe('NoteOn     A#3 (58)  vel 110  (drums, GM: Vibraslap)');
    });

    it('shows a velocity-0 note-on as the note-off it is', () => {
        const fresh = new MidiDecoder('win32');
        const lines = feed(fresh, [0x90, 60, 100], [0x90, 60, 0]);
        expect(lines[1]).toBe('NoteOff    C4 (60)  vel 0 (NoteOn vel 0)');
        expect(fresh.heldNotes(0)).toBe(0);
    });

    it('names notes in scientific pitch, with 60 as C4', () => {
        expect(noteName(60)).toBe('C4');
        expect(noteName(61)).toBe('C#4');
        expect(noteName(0)).toBe('C-1');
        expect(noteName(127)).toBe('G9');
    });

    it('knows each status byte\'s length', () => {
        expect(messageLength(0x90)).toBe(3);
        expect(messageLength(0xd3)).toBe(2);
        expect(messageLength(0xc0)).toBe(2);
        expect(messageLength(0xe5)).toBe(3);
        expect(messageLength(0xf8)).toBe(1);
        expect(messageLength(0xf2)).toBe(3);
    });

    it('collapses channel lists into runs, 1-based', () => {
        expect(formatChannels([1, 2, 3, 9])).toBe('ch 2-4, 10');
        expect(formatChannels([0])).toBe('ch 1');
        expect(formatChannels([])).toBe('none');
    });
});

describe('warnings', () => {
    it('flags a note on the master channel while a zone is active', () => {
        const decoder = new MidiDecoder('win32');
        const warnings = warningsFrom(decoder, [0xb0, 101, 0], [0xb0, 100, 6], [0xb0, 6, 15], [0x90, 60, 100]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("lower zone's master channel");
        expect(decoder.summary().masterNotes).toBe(1);
    });

    it('does not flag channel 1 notes when no zone exists - that is plain MIDI', () => {
        const decoder = new MidiDecoder('win32');
        expect(warningsFrom(decoder, [0x90, 60, 100], [0x80, 60, 0])).toEqual([]);
        expect(decoder.summary().verdict).toBe('MPE: not used (plain MIDI) - OK');
    });

    it('flags a second held note on one member channel', () => {
        const decoder = new MidiDecoder('win32');
        const warnings = warningsFrom(decoder, [0xb0, 101, 0], [0xb0, 100, 6], [0xb0, 6, 15], [0x91, 60, 100], [0x91, 64, 100]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('second held note on member ch 2 (C4 (60) still held)');
    });

    it('flags a note-off with no note-on behind it', () => {
        const decoder = new MidiDecoder('win32');
        const warnings = warningsFrom(decoder, [0x81, 60, 64]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('NoteOff C4 (60) on ch 2 with no matching NoteOn');
    });

    it('flags MPE-shaped traffic with no MCM, once', () => {
        // The MAX_PENDING case: the app queued the preamble while its socket
        // was connecting and the queue dropped the oldest messages first.
        const decoder = new MidiDecoder('win32');
        const warnings = warningsFrom(
            decoder,
            [0xb1, 74, 64],
            [0x91, 60, 100],
            [0xb2, 74, 64],
            [0x92, 64, 100],
            appBend(1, 2, 48),
            [0xb3, 74, 64],
            [0x93, 67, 100]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('no MPE Configuration Message on this connection');
        const summary = decoder.summary();
        expect(summary.mpeLike).toBe(true);
        expect(summary.verdict).toMatch(/^MPE: CHECK - /);
        expect(summary.verdict).toContain('no MCM arrived');
    });

    it('does not take drums on channel 10 for a second MPE channel', () => {
        const decoder = new MidiDecoder('win32');
        const warnings = warningsFrom(decoder, [0xb0, 74, 64], [0x90, 60, 100], [0xb9, 74, 30], [0x99, 36, 100]);
        expect(warnings).toEqual([]);
    });

    it('flags notes that arrived before the MCM', () => {
        const decoder = new MidiDecoder('win32');
        feed(decoder, [0x91, 60, 100], [0x81, 60, 0], [0xb0, 101, 0], [0xb0, 100, 6], [0xb0, 6, 15]);
        expect(decoder.summary().verdict).toContain('1 note(s) arrived before the first MCM');
    });

    it('flags a frame RtMidi would drop on Windows and macOS, and not on Linux', () => {
        const twoNotes = [0x91, 60, 100, 0x92, 64, 100];
        const windows = warningsFrom(new MidiDecoder('win32'), twoNotes);
        expect(windows.some((warning) => warning.includes('RtMidi on Windows drops'))).toBe(true);
        expect(windows.some((warning) => warning.includes('carries 2 MIDI messages'))).toBe(true);

        const linux = warningsFrom(new MidiDecoder('linux'), twoNotes);
        expect(linux.some((warning) => warning.includes('RtMidi'))).toBe(false);
        expect(linux.some((warning) => warning.includes('carries 2 MIDI messages'))).toBe(true);
    });

    it('still decodes each message in a multi-message frame', () => {
        expect(feed(new MidiDecoder('linux'), [0x91, 60, 100, 0x81, 60, 0])).toEqual([
            'NoteOn     C4 (60)  vel 100',
            'NoteOff    C4 (60)  vel 0',
        ]);
    });

    it('flags stray data and an incomplete message', () => {
        const stray = warningsFrom(new MidiDecoder('win32'), [0xd1, 40, 0]);
        expect(stray.some((warning) => warning.includes('no status byte'))).toBe(true);
        const short = warningsFrom(new MidiDecoder('win32'), [0x91, 60]);
        expect(short).toEqual(['incomplete NoteOn: 2 of 3 bytes']);
    });
});

describe('the summary', () => {
    it('counts each kind per channel group', () => {
        const decoder = new MidiDecoder('linux');
        feed(decoder, ...preamble(15, 48, 2));
        feed(
            decoder,
            [0xb1, 74, 64],
            [0xd1, 30],
            [0x91, 60, 100],
            appBend(1, 1, 48),
            appBend(1, 2, 48),
            [0xb1, 11, 90],
            [0xb0, 1, 20],
            appBend(0, 1, 2),
            [0x81, 60, 64],
            [0xd1, 0]
        );
        const summary = decoder.summary();
        const master = summary.groups.find((group) => group.name === 'master');
        const members = summary.groups.find((group) => group.name === 'members');
        expect(master?.channels).toEqual([0]);
        // NoteOn, NoteOff, PB, CC74, CC1, CC11, ChanPressure, PolyPressure
        expect(master?.counts).toEqual([0, 0, 1, 0, 1, 0, 0, 0]);
        expect(members?.counts).toEqual([1, 1, 2, 1, 0, 1, 2, 0]);
        expect(summary.membersUsed).toEqual([1]);
        expect(summary.verdict).toBe('MPE: OK');
    });

    it('names notes left held when the connection closed', () => {
        const decoder = new MidiDecoder('linux');
        feed(decoder, ...preamble(), [0x91, 60, 100]);
        const summary = decoder.summary();
        expect(summary.held).toEqual([{ channel: 1, note: 60 }]);
        expect(summary.verdict).toContain('1 note(s) still held when the connection closed (ch 2 C4)');
    });

    it('says when nothing arrived at all', () => {
        expect(new MidiDecoder('linux').summary().verdict).toBe('MPE: nothing received on this connection');
    });

    it('keeps grouping by the last zone after the zone is released', () => {
        const decoder = new MidiDecoder('linux');
        feed(decoder, ...preamble(4), [0x91, 60, 100], [0x81, 60, 0], [0xb0, 101, 0], [0xb0, 100, 6], [0xb0, 6, 0]);
        const summary = decoder.summary();
        expect(summary.zonesActive).toBe(false);
        expect(summary.groups.find((group) => group.name === 'members')?.channels).toEqual([1, 2, 3, 4]);
    });
});

describe('the logger', () => {
    const CLOCK_PREFIX = /^\d\d:\d\d:\d\d\.\d{3} /;

    function make(
        level: MidiLogLevel | null,
        extra: {
            coalesceMs?: number;
            record?: (entry: Record<string, unknown>) => void;
            now?: () => number;
            warningRepeatMs?: number;
        } = {}
    ) {
        const lines: string[] = [];
        const logger = new MidiLogger({ level, write: (line) => lines.push(line), platform: 'win32', ...extra });
        let t = 0;
        const send = (bytes: number[], lead = 0) => {
            t += 1;
            const info: MidiLogMessage = {
                connId: 1,
                portName: 'Tutor Staff',
                claim: 'staff',
                client: 'android-app',
                t: t + lead,
                bytes,
                receivedAt: 5000 + t,
                openedAt: 5000,
            };
            logger.message(info);
        };
        const close = () =>
            logger.close({ connId: 1, portName: 'Tutor Staff', claim: 'staff', client: 'android-app', openedAt: 5000, closedAt: 5000 + t });
        const bare = () => lines.map((line) => line.replace(CLOCK_PREFIX, ''));
        return { lines, bare, logger, send, close };
    }

    afterEach(() => {
        vi.useRealTimers();
    });

    it('prints one line per message with the time, the port and connection, and a 1-based channel', () => {
        const { lines, send } = make('notes');
        send([0x91, 60, 96]);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} \[Tutor Staff #1\] ch 2   NoteOn     C4 \(60\)  vel 96$/);
    });

    it('lines channel 10 up with channel 2', () => {
        const { bare, send } = make('notes');
        send([0x91, 60, 96]);
        send([0x99, 36, 100]);
        expect(bare()[0].indexOf('NoteOn')).toBe(bare()[1].indexOf('NoteOn'));
    });

    it('shows notes, MPE setup, sustain and panic at "notes", and not the continuous streams', () => {
        const { bare, send } = make('notes');
        for (const frame of HANDSHAKE.slice(0, 3)) send(frame);
        send([0xb1, 74, 64]);
        send([0xd1, 40]);
        send([0x91, 60, 96]);
        send(appBend(1, 1.25, 48));
        send([0xb0, 64, 127]);
        send([0xb1, 123, 0]);
        send([0xf8]);
        expect(bare()).toEqual([
            '[Tutor Staff #1] ch 1   MCM: lower zone, 15 member channels (ch 2-16)',
            '[Tutor Staff #1] ch 2   NoteOn     C4 (60)  vel 96',
            '[Tutor Staff #1] ch 1   CC 64 Sustain on',
            '[Tutor Staff #1] ch 2   CC 123 All Notes Off',
        ]);
    });

    it('adds bend, pressure and CC 74/1/11 at "expr"', () => {
        const { bare, send } = make('expr');
        for (const frame of HANDSHAKE.slice(0, 6)) send(frame);
        send([0xb1, 74, 64]);
        send([0xd1, 40]);
        send([0x91, 60, 96]);
        send(appBend(1, 1.25, 48));
        send([0xb0, 1, 20]);
        send([0xb1, 11, 90]);
        send([0xa1, 60, 40]);
        send([0xf8]);
        expect(bare().slice(2)).toEqual([
            '[Tutor Staff #1] ch 2   CC 74 Slide/Timbre = 64',
            '[Tutor Staff #1] ch 2   ChanPressure 40',
            '[Tutor Staff #1] ch 2   NoteOn     C4 (60)  vel 96',
            '[Tutor Staff #1] ch 2   PitchBend  +1.25 st (raw 8405, range +/-48)',
            '[Tutor Staff #1] ch 1   CC 1 Modulation = 20',
            '[Tutor Staff #1] ch 2   CC 11 Expression = 90',
            '[Tutor Staff #1] ch 2   PolyPressure C4 (60) = 40',
        ]);
    });

    it('shows everything at "all", with the raw bytes', () => {
        const { bare, send } = make('all');
        send([0xb0, 101, 0]);
        send([0xf8]);
        send([0x91, 60, 96]);
        expect(bare()).toEqual([
            '[Tutor Staff #1] ch 1   CC 101 RPN MSB = 0  | B0 65 00',
            '[Tutor Staff #1] sys    Clock (F8)  | F8',
            '[Tutor Staff #1] ch 2   NoteOn     C4 (60)  vel 96  | 91 3C 60',
        ]);
    });

    describe('timing', () => {
        // What the phone showed live: t counts from the phone's socket-open and
        // the server's clock from its accept, so every frame of a connection
        // carries the same lead - clock offset plus a network trip - and the
        // log printed "+59 ms ahead" on every line while nothing was ahead of
        // anything.
        const USUAL = 59;

        /** Frames at the connection's usual lead, enough for the baseline to settle. */
        function settle(send: (bytes: number[], lead?: number) => void, count = BASELINE_SETTLE_FRAMES): void {
            for (let i = 0; i < count; i++) send([0xb0, 20, i], USUAL);
        }

        it('prints nothing for a connection\'s own steady lead', () => {
            const { bare, send } = make('notes');
            for (let i = 0; i < 20; i++) send([0x91, 60 + i, 96], USUAL);
            expect(bare().some((line) => /ahead|behind/.test(line))).toBe(false);
        });

        it('marks a frame only past 20 ms ahead of that lead, or 50 ms behind it, and says once what it is measured from', () => {
            const { bare, send } = make('notes');
            settle(send);
            send([0x91, 60, 96], USUAL + 1402);
            send([0x92, 62, 96], USUAL - 40);
            send([0x93, 64, 96], USUAL - 60);
            send([0x94, 65, 96], USUAL + 15);
            send([0x95, 67, 96], USUAL + 50);
            expect(bare()).toEqual([
                '[Tutor Staff #1] timing: frames on this connection usually arrive with t +59 ms from their arrival ' +
                    '(the two clocks\' offset plus the network trip); "ahead" and "behind" below are measured from that',
                '[Tutor Staff #1] ch 2   NoteOn     C4 (60)  vel 96  +1402 ms ahead',
                '[Tutor Staff #1] ch 3   NoteOn     D4 (62)  vel 96',
                '[Tutor Staff #1] ch 4   NoteOn     E4 (64)  vel 96  -60 ms behind',
                '[Tutor Staff #1] ch 5   NoteOn     F4 (65)  vel 96',
                // Measured from +74 now: the frame before got through 15 ms
                // faster than any yet, which makes it the best estimate.
                '[Tutor Staff #1] ch 6   NoteOn     G4 (67)  vel 96  +35 ms ahead',
            ]);
        });

        it('marks nothing before the baseline has settled', () => {
            const { bare, send } = make('notes');
            send([0x91, 60, 96], USUAL);
            send([0x92, 62, 96], USUAL + 1402);
            expect(bare().some((line) => /ahead|behind|timing/.test(line))).toBe(false);
        });

        it('does not read a frame that got through the network quickly as early', () => {
            // Phone Wi-Fi: most frames delayed 30-40 ms, a few not at all. Lead
            // is offset minus delay, so the quick ones have the larger lead -
            // and against a median they read as "+30 ms ahead" when all they
            // did was arrive on time.
            const { bare, send } = make('notes');
            const delays = [35, 0, 38, 32, 0, 36, 40, 33, 31, 0, 37, 34];
            for (const [i, delay] of delays.entries()) send([0x91, 60 + i, 96], 100 - delay);
            send([0x91, 80, 96], 100);
            expect(bare().some((line) => line.endsWith(' ms ahead'))).toBe(false);
        });

        it('keeps reporting a sender that stamps every frame far into the future', () => {
            // Such a frame never feeds the baseline, so it cannot become the
            // new normal while the sender goes on doing it.
            const { bare, send } = make('notes');
            settle(send);
            for (let i = 0; i < 40; i++) send([0x91, 60, 96], USUAL + 1400);
            expect(bare().filter((line) => line.endsWith('+1400 ms ahead'))).toHaveLength(40);
        });

        it('follows a real change in the lead rather than marking every frame after it', () => {
            // The radio waking up, or the two clocks drifting: a step the
            // size of a network trip is re-anchored within a few frames.
            const { bare, send } = make('notes');
            settle(send, 32);
            for (let i = 0; i < 40; i++) send([0x91, 60, 96], USUAL + 100);
            const marked = bare().filter((line) => line.endsWith(' ms ahead'));
            expect(marked.length).toBeGreaterThan(0);
            expect(marked.length).toBeLessThan(12);
            expect(bare().at(-1)).not.toContain('ahead');
        });

        it('sums the timing up in the summary, with the baseline', () => {
            const { bare, send, close } = make('notes');
            settle(send);
            send([0x91, 60, 96], USUAL + 1402);
            send([0x81, 60, 0], USUAL - 60);
            close();
            expect(bare()).toContain(
                '[Tutor Staff #1]     timing         t runs +59 ms from arrival as a rule (clock offset + network); ' +
                    '1 frame(s) more than 20 ms ahead of it (up to +1402 ms), 1 more than 50 ms behind (up to -60 ms)'
            );
        });

        it('writes the raw lead and the baseline to the file', () => {
            const records: Record<string, unknown>[] = [];
            const { send } = make(null, { record: (entry) => records.push(entry) });
            settle(send);
            send([0x91, 60, 96], USUAL + 1402);
            expect(records.at(-1)).toMatchObject({ leadMs: USUAL + 1402, baselineMs: USUAL });
            expect(records[0].baselineMs).toBeUndefined();
        });

        it('takes the fastest recent delivery as the baseline, and forgets it after 32 frames', () => {
            const baseline = new LeadBaseline();
            for (const lead of [10, 80, 30, 40, 50, 60, 70, 20]) baseline.observe(lead);
            expect(baseline.value).toBe(80);
            expect(baseline.settled).toBe(true);
            // The clocks drift the other way: once 80 has left the window, the
            // baseline follows them down.
            for (let i = 0; i < 32; i++) baseline.observe(40);
            expect(baseline.value).toBe(40);
        });

        it('marks the first on-time frame after a late setup burst once, not for a stretch', () => {
            // The app's MPE setup goes out in one burst when the socket opens,
            // while this end is still re-opening the port - so the burst reads
            // up to tens of ms late, and the first live frame after it early.
            const { bare, send } = make('notes');
            for (let i = 0; i < 40; i++) send([0xb1, 101, 0], USUAL - 40 - i);
            for (let i = 0; i < 10; i++) send([0x91, 60 + i, 96], USUAL);
            expect(bare().filter((line) => line.endsWith(' ms ahead'))).toHaveLength(1);
        });
    });

    it('prints warnings with a "!" at every level', () => {
        const { bare, send } = make('notes');
        send([0x81, 60, 64]);
        expect(bare()[1]).toMatch(/^\[Tutor Staff #1\] ! NoteOff C4 \(60\) on ch 2 with no matching NoteOn/);
    });

    describe('a warning that keeps coming', () => {
        // Take Studio's plain notes on a zone master, or a kit's overlapping
        // hits on channel 10, raise one warning per note for as long as a loop
        // plays. Printed each time, they buried everything else in the log.
        const masterNote = (note: number) => [0x90, note, 100];

        function withClock(extra: { warningRepeatMs?: number } = {}) {
            let wall = Date.UTC(2026, 8, 18, 12);
            const made = make('notes', { now: () => wall, ...extra });
            for (const frame of preamble()) made.send(frame);
            return { ...made, advance: (ms: number) => (wall += ms) };
        }

        const warningLines = (lines: string[]) => lines.filter((line) => line.includes('] ! '));

        it('prints the first in full and counts the rest, per kind and channel', () => {
            const { bare, send } = withClock();
            for (let i = 0; i < 10; i++) send(masterNote(60 + i));
            const warnings = warningLines(bare());
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("NoteOn C4 (60) on ch 1, the lower zone's master channel");
        });

        it('rolls the rest up into one line once the window has passed', () => {
            const { bare, send, advance } = withClock();
            for (let i = 0; i < 10; i++) {
                send(masterNote(60 + i));
                advance(100);
            }
            advance(WARNING_REPEAT_MS);
            send([0x91, 72, 100]);
            expect(warningLines(bare())).toEqual([
                expect.stringContaining("NoteOn C4 (60) on ch 1, the lower zone's master channel"),
                '[Tutor Staff #1] ! [+9 more] NoteOn on the zone master channel on ch 1 within 5.0 s of the one above ' +
                    '(every count is in the summary)',
            ]);
        });

        it('starts a new window after that, with its own first line in full', () => {
            const { bare, send, advance } = withClock();
            send(masterNote(60));
            send(masterNote(61));
            advance(WARNING_REPEAT_MS + 1);
            send(masterNote(62));
            const warnings = warningLines(bare());
            expect(warnings).toHaveLength(3);
            expect(warnings[1]).toContain('[+1 more]');
            expect(warnings[2]).toContain('NoteOn D4 (62) on ch 1');
        });

        it('keeps a different kind, or the same kind on another channel, apart', () => {
            const { bare, send } = withClock();
            send(masterNote(60));
            send(masterNote(61));
            send([0x81, 50, 0]);
            send([0x82, 50, 0]);
            send([0x82, 51, 0]);
            const warnings = warningLines(bare());
            expect(warnings).toHaveLength(3);
            expect(warnings[1]).toContain('NoteOff D3 (50) on ch 2 with no matching NoteOn');
            expect(warnings[2]).toContain('NoteOff D3 (50) on ch 3 with no matching NoteOn');
        });

        it('says what is still held back when the connection closes, and has every count in the summary', () => {
            const { bare, send, close } = withClock();
            for (let i = 0; i < 12; i++) send(masterNote(60 + i));
            for (let i = 0; i < 12; i++) send([0x80, 60 + i, 0]);
            send([0x83, 40, 0]);
            close();
            const text = bare();
            const rollUp = text.findIndex((line) => line.includes('[+11 more] NoteOn on the zone master channel on ch 1'));
            expect(rollUp).toBeGreaterThan(-1);
            expect(rollUp).toBeLessThan(text.findIndex((line) => line.includes('MPE SUMMARY')));
            expect(text).toContain(
                '[Tutor Staff #1]     warnings       13: 12 x NoteOn on the zone master channel (ch 1); 1 x NoteOff with no NoteOn (ch 4)'
            );
        });

        it('rate-limits dropped frames the same way', () => {
            const { bare, logger, close } = withClock();
            for (let i = 0; i < 5; i++) logger.drop({ connId: 1, portName: 'Tutor Staff', reason: 'not JSON', raw: 'x' });
            close();
            const warnings = warningLines(bare());
            expect(warnings[0]).toBe('[Tutor Staff #1] ! dropped frame, not JSON: x');
            expect(warnings[1]).toContain('[+4 more] dropped frame within');
            expect(bare()).toContain('[Tutor Staff #1]     dropped        5 frame(s)');
        });

        it('prints every one when the window is 0', () => {
            const { bare, send } = withClock({ warningRepeatMs: 0 });
            for (let i = 0; i < 4; i++) send(masterNote(60 + i));
            expect(warningLines(bare())).toHaveLength(4);
        });

        it('still writes every warning to the file', () => {
            const records: Record<string, unknown>[] = [];
            const { send } = make(null, { record: (entry) => records.push(entry) });
            for (const frame of preamble()) send(frame);
            for (let i = 0; i < 5; i++) send(masterNote(60 + i));
            expect(records.filter((record) => Array.isArray(record.warnings))).toHaveLength(5);
        });
    });

    describe('what the bridge ended itself when the socket closed', () => {
        const released = [
            [0x81, 60, 0],
            [0xb1, 64, 0],
            [0xb1, 123, 0],
        ];

        it('prints what it sent, and does not call the note hanging', () => {
            const { bare, send, logger } = make('notes');
            for (const frame of preamble()) send(frame);
            send([0x91, 60, 100]);
            logger.close({
                connId: 1,
                portName: 'Tutor Staff',
                claim: 'staff',
                client: 'android-app',
                openedAt: 5000,
                closedAt: 6000,
                released,
            });
            const text = bare();
            expect(text).toContain(
                '[Tutor Staff #1] bridge: the socket closed, so the bridge itself sent NoteOff for 1 note(s) it left held ' +
                    '(ch 2 C4 (60)); CC 64 Sustain off on ch 2; CC 123 All Notes Off on ch 2'
            );
            expect(text).toContain('[Tutor Staff #1]     held at close  ch 2 C4 (60) - all ended by the bridge');
            expect(text.at(-1)).toBe('[Tutor Staff #1]     MPE: OK');
        });

        it('takes the shutdown panic as ending everything, without a line of its own', () => {
            const { bare, send, logger } = make('notes');
            for (const frame of preamble()) send(frame);
            send([0x91, 60, 100]);
            logger.closeAll(6000, true);
            const text = bare();
            expect(text.some((line) => line.includes('bridge:'))).toBe(false);
            expect(text).toContain('[Tutor Staff #1]     held at close  ch 2 C4 (60) - all ended by the bridge');
            expect(text.at(-1)).toBe('[Tutor Staff #1]     MPE: OK');
        });

        it('still calls a note hanging that nothing ended', () => {
            const { bare, send, logger } = make('notes');
            for (const frame of preamble()) send(frame);
            send([0x91, 60, 100]);
            send([0x92, 62, 100]);
            // Another device on the port holds 62 on ch 3, so the release
            // left it (and that channel's All Notes Off) alone.
            logger.close({
                connId: 1,
                portName: 'Tutor Staff',
                claim: 'staff',
                client: 'android-app',
                openedAt: 5000,
                closedAt: 6000,
                released: [
                    [0x81, 60, 0],
                    [0xb1, 64, 0],
                    [0xb1, 123, 0],
                    [0xb2, 64, 0],
                ],
            });
            const text = bare();
            expect(text).toContain('[Tutor Staff #1]     held at close  ch 2 C4 (60), ch 3 D4 (62) - 1 of them ended by the bridge');
            expect(text.at(-1)).toContain('1 note(s) still held when the connection closed (ch 3 D4)');
        });

        it('writes the release to the file', () => {
            const records: Record<string, unknown>[] = [];
            const { send, logger } = make(null, { record: (entry) => records.push(entry) });
            send([0x91, 60, 100]);
            logger.close({ connId: 1, portName: 'Tutor Staff', claim: 'staff', client: 'x', openedAt: 0, closedAt: 1, released });
            expect(records.find((record) => record.type === 'release')).toMatchObject({ conn: 1, messages: released });
            expect(records.at(-1)).toMatchObject({ type: 'summary', endedByBridge: 1 });
        });
    });

    it('prints a dropped frame with its reason', () => {
        const { bare, logger } = make('notes');
        logger.drop({ connId: 1, portName: 'Tutor Staff', reason: 'SysEx refused (0xF0 at b[0])', raw: '{"t":1,"b":[240]}' });
        expect(bare()).toEqual(['[Tutor Staff #1] ! dropped frame, SysEx refused (0xF0 at b[0]): {"t":1,"b":[240]}']);
    });

    it('counts a dropped frame in the summary as a drop, not a warning as well', () => {
        const { bare, send, logger, close } = make('notes');
        for (const frame of HANDSHAKE) send(frame);
        logger.drop({ connId: 1, portName: 'Tutor Staff', reason: 'not JSON', raw: 'x' });
        close();
        const text = bare();
        expect(text).toContain('[Tutor Staff #1]     dropped        1 frame(s)');
        expect(text).toContain('[Tutor Staff #1]     warnings       0');
        expect(text.at(-1)).toBe('[Tutor Staff #1]     MPE: CHECK - 1 frame(s) dropped');
    });

    it('prints a summary on close, once', () => {
        const { bare, send, close } = make('notes');
        for (const frame of HANDSHAKE) send(frame);
        close();
        close();
        const text = bare();
        const summaries = text.filter((line) => line.includes('MPE SUMMARY'));
        expect(summaries).toHaveLength(1);
        expect(text.at(-1)).toBe('[Tutor Staff #1]     MPE: OK');
        expect(text.some((line) => line.includes('MCM            lower zone, 15 member channel(s) (ch 2-16)'))).toBe(true);
        expect(text.some((line) => line.includes('RPN 0 range    ch 2 = 48 st'))).toBe(true);
    });

    it('sums up every connection still open when the bridge shuts down, and none twice', () => {
        const { bare, send, logger, close } = make('notes');
        send([0x91, 60, 96]);
        logger.closeAll(5000 + 2000);
        // The socket's own close can still arrive after shutdown began.
        close();
        const text = bare();
        expect(text.filter((line) => line.includes('MPE SUMMARY'))).toHaveLength(1);
        expect(text.find((line) => line.includes('MPE SUMMARY'))).toContain('android-app, 2.0 s');
        expect(text.at(-1)).toContain('1 note(s) still held when the connection closed (ch 2 C4)');
    });

    it('prints nothing at all when the console level is off', () => {
        const records: Record<string, unknown>[] = [];
        const { lines, send, close } = make(null, { record: (entry) => records.push(entry) });
        for (const frame of HANDSHAKE) send(frame);
        send([0x81, 60, 64]);
        close();
        expect(lines).toEqual([]);
        // The file still gets every message, and the summary.
        expect(records.filter((record) => record.type === 'midi')).toHaveLength(HANDSHAKE.length + 1);
        expect(records.at(-1)).toMatchObject({ type: 'summary', verdict: expect.stringMatching(/^MPE: CHECK/) });
    });

    it('writes a structured record per message, 1-based like the console', () => {
        const records: Record<string, unknown>[] = [];
        const { send } = make(null, { record: (entry) => records.push(entry) });
        send([0x91, 60, 96]);
        send(appBend(1, 1.25, 48));
        expect(records[0]).toMatchObject({
            type: 'midi',
            conn: 1,
            port: 'Tutor Staff',
            client: 'android-app',
            bytes: [0x91, 60, 96],
            kind: 'NoteOn',
            ch: 2,
            note: 60,
            name: 'C4',
            vel: 96,
            text: 'NoteOn     C4 (60)  vel 96',
        });
        // No RPN 0 on this connection, so the bytes are read at GM's 2 - and
        // the record says the range was assumed rather than told.
        expect(records[1]).toMatchObject({ kind: 'PitchBend', raw: 8405, rangeSource: 'assumed', range: 2 });
        expect(typeof records[0].time).toBe('string');
    });

    describe('coalescing', () => {
        it('prints a stream at most every 100 ms at "expr", and its last value when it stops', () => {
            vi.useFakeTimers();
            const { bare, send } = make('expr', { coalesceMs: 100 });
            for (let i = 0; i < 10; i++) {
                send(appBend(1, i * 0.1, 2));
                vi.advanceTimersByTime(10);
            }
            expect(bare()).toHaveLength(1);
            vi.advanceTimersByTime(200);
            const lines = bare();
            expect(lines).toHaveLength(2);
            expect(lines[1]).toContain('+0.90 st');
            // Ten arrived: the two printed, and eight not shown.
            expect(lines[1]).toContain('[+8 not shown]');
        });

        it('prints what a stream held back before a later line, so the log stays in order', () => {
            vi.useFakeTimers();
            const { bare, send } = make('expr', { coalesceMs: 100 });
            send([0x91, 60, 96]);
            send(appBend(1, 0.5, 2));
            vi.advanceTimersByTime(10);
            send(appBend(1, 1, 2));
            send([0x81, 60, 64]);
            expect(bare().map((line) => line.replace('[Tutor Staff #1] ', ''))).toEqual([
                'ch 2   NoteOn     C4 (60)  vel 96',
                'ch 2   PitchBend  +0.50 st (raw 10240, range +/-2 assumed)',
                'ch 2   PitchBend  +1.00 st (raw 12288, range +/-2 assumed)',
                'ch 2   NoteOff    C4 (60)  vel 64',
            ]);
        });

        it('never coalesces at "all"', () => {
            vi.useFakeTimers();
            const { lines, send } = make('all', { coalesceMs: 100 });
            for (let i = 0; i < 10; i++) send(appBend(1, i * 0.1, 2));
            expect(lines).toHaveLength(10);
        });

        it('keeps two notes\' poly pressure apart', () => {
            vi.useFakeTimers();
            const { bare, send, logger } = make('expr', { coalesceMs: 100 });
            send([0xa0, 60, 10]);
            send([0xa0, 60, 20]);
            send([0xa0, 64, 30]);
            logger.flush();
            expect(bare().map((line) => line.replace('[Tutor Staff #1] ', ''))).toEqual([
                'ch 1   PolyPressure C4 (60) = 10',
                'ch 1   PolyPressure C4 (60) = 20',
                'ch 1   PolyPressure E4 (64) = 30',
            ]);
        });

        it('still coalesces two notes\' poly pressure when they interleave', () => {
            // Two pressed notes send alternately. Sharing one slot, each
            // note's value pushed the other's out and every message printed.
            vi.useFakeTimers();
            const { bare, send } = make('expr', { coalesceMs: 100 });
            for (let i = 0; i < 20; i++) {
                send([0xa0, 60, i]);
                send([0xa0, 64, i]);
                vi.advanceTimersByTime(5);
            }
            vi.advanceTimersByTime(200);
            const lines = bare().map((line) => line.replace('[Tutor Staff #1] ', ''));
            // Each note's first value, then its last - and nothing lost.
            expect(lines).toEqual([
                'ch 1   PolyPressure C4 (60) = 0',
                'ch 1   PolyPressure E4 (64) = 0',
                'ch 1   PolyPressure C4 (60) = 19  [+18 not shown]',
                'ch 1   PolyPressure E4 (64) = 19  [+18 not shown]',
            ]);
        });
    });

    it('keeps the client of a connection whose first frame was dropped', () => {
        const records: Record<string, unknown>[] = [];
        const { send, logger } = make(null, { record: (entry) => records.push(entry) });
        logger.drop({ connId: 1, portName: 'Tutor Staff', reason: 'not JSON', raw: 'x' });
        send([0x91, 60, 96]);
        expect(records.at(-1)).toMatchObject({ type: 'midi', client: 'android-app' });
    });
});
