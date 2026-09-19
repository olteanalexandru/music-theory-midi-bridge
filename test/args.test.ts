// What the bridge does when it is told nothing.
//
// The whole program is one gesture: run it, point a phone at the QR code, play.
// Everything else has a test; the DEFAULT did not, and that is exactly where it
// broke. `DEFAULT_APP_ORIGIN` was `https://example.com` in a released version,
// so every run that passed neither `--app` nor `TUTOR_APP_ORIGIN` - very nearly
// every run - printed a URL and a QR code pointing at somebody else's domain.
//
// Nothing reported it, because nothing was wrong: the bridge started, claimed
// its ports and waited, and it is the PHONE that discovers the link goes
// nowhere. protocol.test.ts passes an origin in explicitly and so could never
// see it. These tests exist to pin the value nobody passes.

import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_ORIGIN, parseArgs } from '../src/index.js';
import { pairingUrl } from '../src/pairing.js';

describe('the default app origin', () => {
    it('is the real site, not a placeholder', () => {
        expect(DEFAULT_APP_ORIGIN).toBe('https://note-noodle.com');
    });

    it('is not any of the usual stand-ins', () => {
        // Named rather than pattern-matched: these are the strings that get
        // typed while a thing is being written and then stay.
        for (const placeholder of ['example.com', 'example.org', 'localhost', 'yoursite', 'TODO']) {
            expect(DEFAULT_APP_ORIGIN).not.toContain(placeholder);
        }
    });

    it('is what a run with no arguments uses', () => {
        const previous = process.env.TUTOR_APP_ORIGIN;
        delete process.env.TUTOR_APP_ORIGIN;
        try {
            expect(parseArgs([]).appOrigin).toBe('https://note-noodle.com');
        } finally {
            if (previous === undefined) delete process.env.TUTOR_APP_ORIGIN;
            else process.env.TUTOR_APP_ORIGIN = previous;
        }
    });

    it('reaches the URL the QR code encodes', () => {
        // The end-to-end version, and the one that would have caught it: the
        // default is only interesting because it ends up here.
        const previous = process.env.TUTOR_APP_ORIGIN;
        delete process.env.TUTOR_APP_ORIGIN;
        try {
            const args = parseArgs([]);
            const url = pairingUrl({
                host: '192.168.1.134',
                port: args.port,
                token: 'abc123',
                appOrigin: args.appOrigin,
            });
            expect(url.startsWith('https://note-noodle.com/app/')).toBe(true);
            expect(url).not.toContain('example.com');
        } finally {
            if (previous === undefined) delete process.env.TUTOR_APP_ORIGIN;
            else process.env.TUTOR_APP_ORIGIN = previous;
        }
    });
});

describe('overriding it', () => {
    it('takes --app over the default', () => {
        expect(parseArgs(['--app', 'https://staging.note-noodle.com']).appOrigin).toBe('https://staging.note-noodle.com');
    });

    it('takes TUTOR_APP_ORIGIN over the default', () => {
        const previous = process.env.TUTOR_APP_ORIGIN;
        process.env.TUTOR_APP_ORIGIN = 'https://preview.example.net';
        try {
            expect(parseArgs([]).appOrigin).toBe('https://preview.example.net');
        } finally {
            if (previous === undefined) delete process.env.TUTOR_APP_ORIGIN;
            else process.env.TUTOR_APP_ORIGIN = previous;
        }
    });

    it('takes --app over TUTOR_APP_ORIGIN, because the flag is the more deliberate of the two', () => {
        const previous = process.env.TUTOR_APP_ORIGIN;
        process.env.TUTOR_APP_ORIGIN = 'https://from-the-environment.test';
        try {
            expect(parseArgs(['--app', 'https://from-the-flag.test']).appOrigin).toBe('https://from-the-flag.test');
        } finally {
            if (previous === undefined) delete process.env.TUTOR_APP_ORIGIN;
            else process.env.TUTOR_APP_ORIGIN = previous;
        }
    });
});

describe('--log-midi', () => {
    /** Runs with TUTOR_BRIDGE_LOG_MIDI set to `value` (or unset), restoring it after. */
    function withEnv<T>(value: string | undefined, run: () => T): T {
        const previous = process.env.TUTOR_BRIDGE_LOG_MIDI;
        if (value === undefined) delete process.env.TUTOR_BRIDGE_LOG_MIDI;
        else process.env.TUTOR_BRIDGE_LOG_MIDI = value;
        try {
            return run();
        } finally {
            if (previous === undefined) delete process.env.TUTOR_BRIDGE_LOG_MIDI;
            else process.env.TUTOR_BRIDGE_LOG_MIDI = previous;
        }
    }

    it('is off by default, so a player sees no line per note', () => {
        withEnv(undefined, () => {
            const args = parseArgs([]);
            expect(args.logMidi).toBeNull();
            expect(args.logFile).toBe('');
            expect(args.warnings).toEqual([]);
        });
    });

    it('means everything when given bare', () => {
        withEnv(undefined, () => expect(parseArgs(['--log-midi']).logMidi).toBe('all'));
    });

    it('takes a level after an equals sign or as the next word', () => {
        withEnv(undefined, () => {
            expect(parseArgs(['--log-midi=notes']).logMidi).toBe('notes');
            expect(parseArgs(['--log-midi=expr']).logMidi).toBe('expr');
            expect(parseArgs(['--log-midi', 'expr']).logMidi).toBe('expr');
            expect(parseArgs(['--log-midi', 'notes', '--port', '9000'])).toMatchObject({ logMidi: 'notes', port: 9000 });
        });
    });

    it('does not eat the next flag as a level', () => {
        withEnv(undefined, () => {
            expect(parseArgs(['--log-midi', '--quiet'])).toMatchObject({ logMidi: 'all', quiet: true });
        });
    });

    it('is independent of --quiet', () => {
        withEnv(undefined, () => {
            expect(parseArgs(['--quiet', '--log-midi=notes'])).toMatchObject({ logMidi: 'notes', quiet: true });
        });
    });

    it('says so about a level it does not know, and logs everything rather than nothing', () => {
        withEnv(undefined, () => {
            const spelled = parseArgs(['--log-midi=verbose']);
            expect(spelled.logMidi).toBe('all');
            expect(spelled.warnings[0]).toContain('verbose');

            const spaced = parseArgs(['--log-midi', 'cc', '--quiet']);
            expect(spaced).toMatchObject({ logMidi: 'all', quiet: true });
            expect(spaced.warnings[0]).toContain('cc');
        });
    });

    it('reads TUTOR_BRIDGE_LOG_MIDI', () => {
        withEnv('expr', () => expect(parseArgs([]).logMidi).toBe('expr'));
        withEnv('1', () => expect(parseArgs([]).logMidi).toBe('all'));
        withEnv('off', () => expect(parseArgs([]).logMidi).toBeNull());
        withEnv('', () => expect(parseArgs([]).logMidi).toBeNull());
        withEnv('loud', () => {
            const args = parseArgs([]);
            expect(args.logMidi).toBe('all');
            expect(args.warnings[0]).toContain('TUTOR_BRIDGE_LOG_MIDI=loud');
        });
    });

    it('takes the flag over the environment', () => {
        withEnv('all', () => expect(parseArgs(['--log-midi=notes']).logMidi).toBe('notes'));
    });

    it('takes a file for JSON Lines, either way of writing it', () => {
        withEnv(undefined, () => {
            expect(parseArgs(['--log-file', 'midi.jsonl']).logFile).toBe('midi.jsonl');
            expect(parseArgs(['--log-file=C:\\logs\\midi.jsonl']).logFile).toBe('C:\\logs\\midi.jsonl');
            // A file on its own logs to the file, not to the console.
            expect(parseArgs(['--log-file', 'midi.jsonl']).logMidi).toBeNull();
        });
    });
});
