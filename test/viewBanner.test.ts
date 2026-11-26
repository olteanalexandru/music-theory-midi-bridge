// The banner's "Open on this PC" link, the console lines for the PC view, and
// the release's version and README.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PC_VIEW_HOST, banner, parseArgs, viewEventLine } from '../src/index.js';
import { pairingUrl } from '../src/pairing.js';

/** The banner prints a blank line before the label, in the same console.log call. */
const PC_LABEL = String.fromCharCode(10) + '  Open on this PC:';

function onePort() {
    return {
        open: new Map([['Tutor Pads', { send: () => {} }]]),
        missing: [],
        closeAll: () => {},
    } as unknown as Parameters<typeof banner>[2];
}

function printed(argv: string[]): string[] {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
        lines.push(parts.map(String).join(' '));
    });
    try {
        banner(parseArgs(['--host', '192.0.2.10', ...argv]), 'token123', onePort(), '1.0.10');
    } finally {
        spy.mockRestore();
    }
    return lines;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Open on this PC', () => {
    it('is printed under the phone link, with 127.0.0.1 and the same token', () => {
        const lines = printed(['--app', 'https://note-noodle.com']);
        const phone = lines.findIndex((line) => line.startsWith('  https://') && line.includes('192.0.2.10'));
        const label = lines.indexOf(PC_LABEL);
        expect(phone).toBeGreaterThan(-1);
        expect(label).toBeGreaterThan(phone);
        // The link and the blank line after it are one console.log call.
        const link = lines[label + 1].trimEnd();
        expect(link).toBe(`  ${pairingUrl({ host: '127.0.0.1', port: 8532, token: 'token123', appOrigin: 'https://note-noodle.com' })}`);
        expect(link).toContain('bridge=127.0.0.1%3A8532');
        expect(link).toContain('t=token123');
        // The phone link is the one the QR code carries, and it is untouched.
        expect(lines[phone]).toContain('bridge=192.0.2.10%3A8532&t=token123');
    });

    it('follows --port and --app, and is the one place the loopback address appears', () => {
        const lines = printed(['--port', '9000', '--app', 'http://localhost:3000/']);
        const link = lines[lines.indexOf(PC_LABEL) + 1].trimEnd();
        expect(link).toBe('  http://localhost:3000/app/bridge?bridge=127.0.0.1%3A9000&t=token123');
        expect(PC_VIEW_HOST).toBe('127.0.0.1');
    });

    it('is left out with --quiet, with the rest of the banner below the address', () => {
        expect(printed(['--quiet']).some((line) => line.includes('Open on this PC'))).toBe(false);
    });
});

describe('the console lines for the PC view', () => {
    it('say how many are watching and whether a phone is sending, never a frame', () => {
        expect(viewEventLine({ type: 'view', senders: 1, watchers: 2 })).toBe('  ~ PC view: 2 watching, the phone is sending');
        expect(viewEventLine({ type: 'view', senders: 0, watchers: 0 })).toBe('  ~ PC view: 0 watching, no phone sending');
    });

    it('name a watcher turned away, and why', () => {
        expect(viewEventLine({ type: 'refused', reason: 'local', detail: 'phone' })).toBe(
            '  ! refused phone: the PC view can only be watched on this computer'
        );
        expect(viewEventLine({ type: 'refused', reason: 'view-busy', detail: 'unknown' })).toBe('  ! refused unknown: too many PC views open at once');
        expect(viewEventLine({ type: 'refused', reason: 'role', detail: 'both' })).toBe('  ! refused: unknown PC view role "both"');
    });

    it('leave every other event to the console as it was', () => {
        expect(viewEventLine({ type: 'refused', reason: 'token', detail: 'phone' })).toBeNull();
        expect(viewEventLine({ type: 'refused', reason: 'busy', detail: 'phone' })).toBeNull();
        expect(viewEventLine({ type: 'connected', claim: null, portName: 'Tutor MIDI', client: 'phone', connId: 1 })).toBeNull();
    });
});

describe('the release', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

    it('is 1.0.10 in the package, its lock and the README', () => {
        expect(pkg.version).toBe('1.0.10');
        expect(lock.version).toBe('1.0.10');
        expect(lock.packages[''].version).toBe('1.0.10');
        expect(readme).toContain('music-theory-midi-bridge 1.0.10\n');
        expect(readme).toMatch(/\*\*1\.0\.10\*\* - the PC view/);
    });

    it('shows the PC link in its banner sample, and documents every close code the view uses', () => {
        expect(readme).toContain('\n  Open on this PC:\n  https://note-noodle.com/app/bridge?bridge=127.0.0.1%3A8532&t=');
        for (const code of ['4004', '4005', '4006', '4007', '4008']) expect(readme, code).toContain(`\`${code}\``);
        expect(readme).toContain('/view?role=watch');
    });
});
