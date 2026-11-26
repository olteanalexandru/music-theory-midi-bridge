// The PC view's constants and its two small parsers.

import { describe, expect, it } from 'vitest';
import {
    CLOSE_BAD_CLAIM,
    CLOSE_BAD_TOKEN,
    CLOSE_BUSY,
    CLOSE_NO_PORT,
    CLOSE_VIEW_NOT_LOCAL,
    CLOSE_VIEW_RATE,
    CLOSE_VIEW_REPLACED,
    CLOSE_VIEW_TOO_SLOW,
    MAX_FRAME_BYTES,
    MAX_VIEW_BYTES_PER_SECOND,
    MAX_VIEW_FRAME_BYTES,
    MAX_VIEW_FRAMES_PER_SECOND,
    MAX_VIEW_WATCHERS,
    MAX_WATCH_FRAME_BYTES,
    VIEW_FRAME_TYPES,
    VIEW_WS_PATH,
    isForwardableViewFrame,
    isLoopbackAddress,
    isViewRole,
    parseWatcherFrame,
} from '../src/protocol.js';

describe('the numbers the site relies on', () => {
    it('are the ones the design states', () => {
        expect(VIEW_WS_PATH).toBe('/view');
        expect(MAX_VIEW_WATCHERS).toBe(4);
        expect(MAX_VIEW_FRAME_BYTES).toBe(4096);
        expect(MAX_VIEW_FRAME_BYTES).toBe(MAX_FRAME_BYTES);
        expect(MAX_WATCH_FRAME_BYTES).toBe(256);
        expect(MAX_VIEW_FRAMES_PER_SECOND).toBe(200);
        expect(MAX_VIEW_BYTES_PER_SECOND).toBe(128 * 1024);
        expect([...VIEW_FRAME_TYPES]).toEqual(['snap', 'p', 'alive', 'off', 'bye']);
    });

    it('close codes are distinct from each other and from the ones before them', () => {
        const codes = [
            CLOSE_BAD_TOKEN,
            CLOSE_BAD_CLAIM,
            CLOSE_NO_PORT,
            CLOSE_BUSY,
            CLOSE_VIEW_REPLACED,
            CLOSE_VIEW_TOO_SLOW,
            CLOSE_VIEW_NOT_LOCAL,
            CLOSE_VIEW_RATE,
        ];
        expect(new Set(codes).size).toBe(codes.length);
        expect([CLOSE_VIEW_REPLACED, CLOSE_VIEW_TOO_SLOW, CLOSE_VIEW_NOT_LOCAL, CLOSE_VIEW_RATE]).toEqual([4005, 4006, 4007, 4008]);
    });
});

describe('who is on this computer', () => {
    it('loopback in every spelling a socket reports it', () => {
        for (const address of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(address), address).toBe(true);
    });

    it('nothing else, nor a missing address', () => {
        for (const address of [
            undefined,
            '',
            '192.168.1.20',
            '10.0.0.1',
            '0.0.0.0',
            '::',
            '::2',
            'fe80::1',
            '::ffff:192.168.1.20',
            '127.0.0.1.evil',
            'x127.0.0.1',
            '128.0.0.1',
        ]) {
            expect(isLoopbackAddress(address), String(address)).toBe(false);
        }
    });
});

describe('the roles', () => {
    it('are send and watch', () => {
        expect(isViewRole('send')).toBe(true);
        expect(isViewRole('watch')).toBe(true);
        for (const value of ['', 'Send', 'both', null, undefined, 1]) expect(isViewRole(value)).toBe(false);
    });
});

describe('a watcher frame', () => {
    it('is only {"visible": boolean}', () => {
        expect(parseWatcherFrame('{"visible":true}')).toEqual({ visible: true });
        expect(parseWatcherFrame('{"visible":false,"x":1}')).toEqual({ visible: false });
        for (const raw of ['', 'nope', '[]', 'null', '1', '{}', '{"visible":"yes"}', '{"visible":1}', '{"hidden":true}']) {
            expect(parseWatcherFrame(raw), raw).toBeNull();
        }
    });
});

describe('a sender frame the helper forwards', () => {
    it('is a JSON object whose t is one of the five', () => {
        for (const t of VIEW_FRAME_TYPES) expect(isForwardableViewFrame(JSON.stringify({ t })), t).toBe(true);
    });

    it('is nothing else', () => {
        for (const raw of ['', 'snap', '[{"t":"snap"}]', 'null', '{}', '{"t":"hello"}', '{"t":"SNAP"}', '{"t":1}', '{"t":"snap"', '{"hello":1}']) {
            expect(isForwardableViewFrame(raw), raw).toBe(false);
        }
    });
});
