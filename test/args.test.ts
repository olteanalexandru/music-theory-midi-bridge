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
                claim: 'staff',
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
