// The DAW setup lines under the QR code.
//
// The app announces its MPE zone, but no DAW switches MPE on for a port by
// itself, so the banner is where a player first learns the one setting only
// they can make. These pin the lines to the menu names the DAWs use today -
// Live 12 renamed Preferences to Settings, and the banner said Preferences
// until 1.0.6 - to the bend range the app declares, and to a console that is
// 80 columns wide.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAW_SETUP_LINES, banner, parseArgs } from '../src/index.js';

/** The member bend range the app's MidiSender declares (MPE_BEND_SEMITONES there). */
const APP_MEMBER_BEND = 48;

/** One open port, so the banner gets as far as the QR code. */
function onePort() {
    return {
        open: new Map([['Tutor Pads', { send: () => {} }]]),
        missing: [],
        closeAll: () => {},
    } as unknown as Parameters<typeof banner>[2];
}

/** Everything the banner printed, one string per console.log call. */
function printed(argv: string[]): string[] {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
        lines.push(parts.map(String).join(' '));
    });
    try {
        banner(parseArgs(['--host', '192.0.2.10', ...argv]), 'token123', onePort(), '1.0.6');
    } finally {
        spy.mockRestore();
    }
    return lines;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the DAW setup lines', () => {
    it('are printed under the QR code, each with the banner’s indent', () => {
        const lines = printed([]);
        const qr = lines.findIndex((line) => line.includes('Scan this with the phone'));
        expect(qr).toBeGreaterThan(-1);
        for (const expected of DAW_SETUP_LINES) {
            const at = lines.indexOf(`  ${expected}`);
            expect(at, expected).toBeGreaterThan(qr);
        }
    });

    it('are left out with --quiet, with the rest of the banner below the address', () => {
        const lines = printed(['--quiet']);
        expect(lines.some((line) => line.includes('MPE On'))).toBe(false);
    });

    it('give Live 12’s own path to the switch, and not the one it renamed', () => {
        const text = DAW_SETUP_LINES.join('\n');
        expect(text).toContain('Settings > Link, Tempo & MIDI');
        expect(text).toContain('"In: Tutor ..."');
        expect(text).toContain('Track On, MPE On');
        expect(text).not.toMatch(/Preferences/);
        expect(text).not.toMatch(/Link\/MIDI/);
    });

    it('name the switch in Bitwig, Logic and REAPER too', () => {
        const text = DAW_SETUP_LINES.join('\n');
        expect(text).toContain('Use MPE');
        expect(text).toContain('MIDI Mono Mode');
        expect(text).toContain('On (with common base\n');
        expect(text).toContain('MIDI Input Devices');
    });

    it('ask for the bend range the app declares, everywhere a number is asked for', () => {
        // "Live 12" and "channel 1" aside, every number in the lines is a
        // bend range - Bitwig's, Logic's and REAPER's.
        const numbers = (DAW_SETUP_LINES.join(' ').match(/\d+/g) ?? []).map(Number).filter((value) => value !== 12 && value !== 1);
        expect(numbers.length).toBeGreaterThanOrEqual(3);
        for (const value of numbers) expect(value).toBe(APP_MEMBER_BEND);
    });

    it('fit an 80-column console with the indent they are printed with', () => {
        for (const line of DAW_SETUP_LINES) expect(`  ${line}`.length, line).toBeLessThanOrEqual(80);
    });
});

describe('the README', () => {
    // CRLF on disk; compared line by line, so the ending does not matter.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

    it('shows the same DAW lines in its banner sample as the program prints', () => {
        for (const line of DAW_SETUP_LINES) expect(readme, line).toContain(`\n  ${line}\n`);
    });

    it('no longer sends anybody to Live’s old Preferences menu', () => {
        expect(readme).not.toMatch(/Preferences → Link/);
        expect(readme).toContain('Link, Tempo & MIDI');
    });
});
