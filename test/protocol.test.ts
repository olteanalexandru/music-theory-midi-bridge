// The wire format.
//
// This file is one half of a contract whose other half lives in the app repo
// (`app/utils/__tests__/midiBridge.test.ts`). The app's tests assert what it
// ENCODES; these assert what this end DECODES from the same shape. Neither
// repo can see the other, so the format being small enough to state completely
// is what keeps them honest.

import { describe, expect, it } from 'vitest';
import {
    ALL_PORT_NAMES,
    CLAIMS,
    DEFAULT_PORT_NAME,
    PORT_NAMES,
    PROTOCOL_VERSION,
    isClaim,
    parseMessage,
} from '../src/protocol.js';
import { CLAIM_PATHS, PAIRING_PATH, createToken, pairingUrl } from '../src/pairing.js';

describe('parsing a MIDI frame', () => {
    it('reads exactly what the app sends', () => {
        expect(parseMessage('{"t":12,"b":[144,60,100]}')).toEqual({ t: 12, b: [144, 60, 100] });
    });

    it('accepts a zero timestamp, which is what a queued message carries', () => {
        expect(parseMessage('{"t":0,"b":[176,74,64]}')).toEqual({ t: 0, b: [176, 74, 64] });
    });

    it('takes a long frame, because MPE sends plenty of them', () => {
        const bytes = Array.from({ length: 64 }, (_, i) => i % 128);
        expect(parseMessage(JSON.stringify({ t: 1, b: bytes }))?.b).toHaveLength(64);
    });

    for (const [label, raw] of [
        ['not JSON', 'hello'],
        ['not an object', '42'],
        ['null', 'null'],
        ['no bytes', '{"t":1}'],
        ['empty bytes', '{"t":1,"b":[]}'],
        ['no timestamp', '{"b":[144,60,100]}'],
        ['a timestamp that is not a number', '{"t":"soon","b":[144]}'],
        ['an infinite timestamp', '{"t":null,"b":[144]}'],
        ['a byte out of range', '{"t":1,"b":[144,300,100]}'],
        ['a negative byte', '{"t":1,"b":[-1]}'],
        ['a fractional byte', '{"t":1,"b":[144.5]}'],
        ['a byte that is a string', '{"t":1,"b":["144"]}'],
    ] as const) {
        it(`drops ${label} rather than throwing`, () => {
            // This socket is open to a local network. A bad frame is a thing
            // to drop, not a thing to crash the helper somebody is playing
            // through - and clamping it would turn a corrupt frame into a
            // wrong note, which is harder to notice than no note.
            expect(parseMessage(raw)).toBeNull();
        });
    }
});

describe('the port table, which is the Ableton routing', () => {
    it('gives every instrument its own port', () => {
        const names = CLAIMS.map((claim) => PORT_NAMES[claim]);
        expect(new Set(names).size).toBe(names.length);
    });

    it('includes the shared port for a connection that claims nothing', () => {
        expect(ALL_PORT_NAMES).toContain(DEFAULT_PORT_NAME);
        expect(ALL_PORT_NAMES).toHaveLength(CLAIMS.length + 1);
    });

    it('keeps the names typeable, because Windows users have to type them', () => {
        // They go into loopMIDI's "New port-name" box by hand.
        for (const name of ALL_PORT_NAMES) {
            expect(name).toMatch(/^[A-Za-z0-9 ]+$/);
            expect(name.length).toBeLessThan(32);
        }
    });

    it('recognises only the four instruments', () => {
        expect(isClaim('staff')).toBe(true);
        expect(isClaim('bass')).toBe(false);
        expect(isClaim('')).toBe(false);
        expect(isClaim(null)).toBe(false);
    });

    it('has a page for every claim', () => {
        for (const claim of CLAIMS) expect(CLAIM_PATHS[claim]).toMatch(/^\/app\//);
    });
});

describe('pairing', () => {
    it('builds a link that opens the app with the bridge filled in', () => {
        const url = pairingUrl({
            host: '192.168.1.20',
            port: 8532,
            token: 'abc123',
            appOrigin: 'https://example.com',
        });
        expect(url).toBe('https://example.com/app/bridge?bridge=192.168.1.20%3A8532&t=abc123');
    });

    it('lands somewhere no purchase can hide', () => {
        // The regression this replaced a passing test for. The link used to
        // open an INSTRUMENT page, and 'staff' was the hard-coded one: that
        // page is wrapped in the app's purchase gate, so a scan by anybody who
        // had not bought the Stylophone rendered a buy card with no MIDI panel
        // on it - and the part of the app that reads ?bridge= only runs on a
        // mounted instrument, so the address never got read at all. The old
        // test asserted the exact URL and was perfectly happy.
        expect(PAIRING_PATH).toBe('/app/bridge');
        for (const claim of CLAIMS) expect(PAIRING_PATH).not.toBe(CLAIM_PATHS[claim]);
    });

    it('does not double the slash on an origin with a trailing one', () => {
        const url = pairingUrl({
            host: '10.0.0.5',
            port: 9,
            token: 't',
            appOrigin: 'https://example.com/',
        });
        expect(url).toContain('https://example.com/app/bridge?');
    });

    it('makes a token nobody has to disambiguate by hand', () => {
        // The fallback when a camera will not focus is somebody reading this
        // out, so no 0/O/1/I.
        for (let i = 0; i < 50; i++) {
            expect(createToken()).toMatch(/^[a-hj-km-np-z2-9]{12}$/);
        }
    });

    it('does not repeat itself', () => {
        const tokens = new Set(Array.from({ length: 200 }, () => createToken()));
        expect(tokens.size).toBe(200);
    });
});

describe('versioning', () => {
    it('is announced, so an old app finds out rather than misbehaving', () => {
        expect(PROTOCOL_VERSION).toBe(1);
    });
});
