// What a closing socket ends, worked out without a socket.
//
// server.test.ts proves the release reaches the port over a real connection;
// these pin the arithmetic of it - which notes count as held, which channels
// count as used, and what another sender on the same port keeps.

import { describe, expect, it } from 'vitest';
import { HeldNotes } from '../src/heldNotes.js';

function sender(...frames: number[][]): HeldNotes {
    const held = new HeldNotes();
    for (const frame of frames) held.track(frame);
    return held;
}

describe('what a sender holds', () => {
    it('adds a note on and removes it at its note off', () => {
        const held = sender([0x91, 60, 100], [0x92, 64, 100], [0x81, 60, 0]);
        expect(held.heldNotes()).toEqual([[2, 64]]);
    });

    it('takes a velocity-0 note on as the note off it is', () => {
        expect(sender([0x91, 60, 100], [0x91, 60, 0]).heldNotes()).toEqual([]);
    });

    it('takes All Notes Off and All Sound Off as ending everything on that channel', () => {
        expect(sender([0x91, 60, 100], [0x91, 62, 100], [0xb1, 123, 0]).heldNotes()).toEqual([]);
        expect(sender([0x91, 60, 100], [0xb1, 120, 0]).heldNotes()).toEqual([]);
    });

    it('reads every message of a frame that carries several', () => {
        expect(sender([0x91, 60, 100, 0x92, 64, 100]).heldNotes()).toEqual([
            [1, 60],
            [2, 64],
        ]);
    });

    it('skips a message cut short, and real-time bytes', () => {
        expect(sender([0x91, 60], [0xf8], [0x92, 64, 100]).heldNotes()).toEqual([[2, 64]]);
    });
});

describe('what a close sends', () => {
    it('is a NoteOff per held note, then the pedal up and All Notes Off on every channel it played', () => {
        const held = sender([0x91, 60, 100], [0x92, 64, 100], [0x82, 64, 0]);
        expect(held.releaseMessages([])).toEqual([
            [0x81, 60, 0],
            [0xb1, 64, 0],
            [0xb1, 123, 0],
            [0xb2, 64, 0],
            [0xb2, 123, 0],
        ]);
    });

    it('lifts a pedal it put down, on the channel it put it down on', () => {
        const held = sender([0xb0, 64, 127], [0x91, 60, 100], [0x81, 60, 0]);
        expect(held.releaseMessages([])).toEqual([
            [0xb0, 64, 0],
            [0xb0, 123, 0],
            [0xb1, 64, 0],
            [0xb1, 123, 0],
        ]);
    });

    it('is nothing for a sender that only configured channels', () => {
        // The MPE setup writes RPN 0 to all sixteen: none of that is a note.
        const held = sender([0xb0, 101, 0], [0xb0, 100, 6], [0xb0, 6, 15], [0xb1, 101, 0], [0xb1, 100, 0], [0xb1, 6, 48]);
        expect(held.releaseMessages([])).toEqual([]);
    });

    it('leaves alone what another sender on the same port is still playing', () => {
        const leaving = sender([0x91, 60, 100], [0x91, 62, 100], [0x93, 67, 100]);
        const staying = sender([0x91, 62, 100], [0xb1, 64, 127]);
        expect(leaving.releaseMessages([staying, leaving])).toEqual([
            // 62 is also held by the other sender: its NoteOff would end it.
            [0x81, 60, 0],
            [0x83, 67, 0],
            // Channel 2: the other sender holds a note and the pedal there.
            [0xb3, 64, 0],
            [0xb3, 123, 0],
        ]);
    });

    it('sends no All Notes Off on a zone master while another sender still plays in the zone', () => {
        // Two MPE senders on one port share the lower zone. This one put its
        // pedal down on the master, ch 1, as the app does; the other's notes
        // are all on member channels. An MPE receiver applies ch 1's All Notes
        // Off to the whole zone, so it would end them.
        const leaving = sender([0xb0, 64, 127], [0x91, 60, 100], [0xb0, 64, 0], [0x81, 60, 0]);
        const staying = sender([0x92, 67, 100]);
        expect(leaving.releaseMessages([staying])).toEqual([
            [0xb0, 64, 0],
            [0xb1, 64, 0],
            [0xb1, 123, 0],
        ]);
        // The same on ch 16, the upper zone's master.
        const upper = sender([0xbf, 64, 127], [0x9e, 60, 100], [0x8e, 60, 0]);
        expect(upper.releaseMessages([staying])).not.toContainEqual([0xbf, 123, 0]);
        // And sent as usual once nobody else is playing.
        expect(leaving.releaseMessages([sender()])).toContainEqual([0xb0, 123, 0]);
    });
});
