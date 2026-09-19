// What one connection has left sounding, so that closing it can end it.
//
// The one place outside --log-midi where this program looks inside the bytes it
// forwards, and only to answer one question when a socket goes away: which
// notes did THIS sender start and not stop? A tab that is closed, an app that
// is swiped away, a network error mid-chord - each ends the socket with
// note-ons already in the DAW and their note-offs never coming. The app sends
// what it can on the way out (MidiBridge.disconnect sends the endings it was
// still holding), but a socket that simply dies has no way out, and a synth
// left droning is the failure a player notices first.
//
// Only a close this machine hears about, though. The server writes nothing
// after its hello and sets no keepalive, so a phone that vanishes without a
// word (out of Wi-Fi range) leaves a socket that never closes here, and its
// notes are ended only by the shutdown panic. A heartbeat would catch it, at
// the price of also dropping a phone that sleeps with the page open.
//
// Per connection, never per port. Two devices really can share a port (see
// `live` in server.ts), each with its own MPE allocator on the same channels,
// and one of them leaving must not cut the other's notes. So a release is
// worked out against what the OTHER live connections on that port still hold:
// a note one of them is also holding gets no NoteOff, and a channel-wide reset
// is skipped on a channel somebody else is still using.
//
// Kept apart from the logger on purpose. This runs on every frame whether or
// not anybody is logging, so it is a set per channel and two bitmasks rather
// than the decoder's full receiver state.

import { messageLength } from './midiLog.js';

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;
const CC_SUSTAIN = 64;
const CC_ALL_SOUND_OFF = 120;
const CC_RESET_ALL_CONTROLLERS = 121;
const CC_ALL_NOTES_OFF = 123;
/** Zero-based: the lower zone's master is channel 1, the upper zone's channel 16. */
const MPE_LOWER_MASTER = 0;
const MPE_UPPER_MASTER = 15;

export class HeldNotes {
    /** Per channel, the notes this sender has turned on and not yet off. */
    private readonly held: Set<number>[] = Array.from({ length: 16 }, () => new Set<number>());
    /**
     * Bit per channel: this sender started a note or moved the pedal there,
     * which is what makes a channel-wide reset there mean anything. Not "any
     * message": the app's MPE setup writes RPN 0 to all sixteen channels, and
     * a reset on a channel that never had a note is a no-op at best.
     */
    private touched = 0;
    /** Bit per channel: this sender's sustain pedal is down there. */
    private sustained = 0;

    /** Reads one forwarded frame. Malformed or partial messages are skipped - they reached the port as nothing a receiver would start a note from. */
    track(bytes: readonly number[]): void {
        const n = bytes.length;
        let i = 0;
        while (i < n) {
            const status = bytes[i];
            if (status < 0x80 || status >= 0xf0) {
                // A stray data byte, or a system message: neither starts,
                // ends or sustains a note on a channel.
                i++;
                continue;
            }
            const need = messageLength(status);
            let j = i + 1;
            while (j < n && j - i < need && bytes[j] < 0x80) j++;
            if (j - i === need) this.apply(status, bytes[i + 1], need > 2 ? bytes[i + 2] : 0);
            i = j;
        }
    }

    private apply(status: number, data1: number, data2: number): void {
        const channel = status & 0x0f;
        const bit = 1 << channel;
        switch (status & 0xf0) {
            case NOTE_ON:
                if (data2 > 0) {
                    this.held[channel].add(data1);
                    this.touched |= bit;
                    return;
                }
                // Velocity 0 is a note-off by the spec.
                this.held[channel].delete(data1);
                return;
            case NOTE_OFF:
                this.held[channel].delete(data1);
                return;
            case CONTROL_CHANGE:
                if (data1 === CC_SUSTAIN) {
                    this.touched |= bit;
                    if (data2 >= 64) this.sustained |= bit;
                    else this.sustained &= ~bit;
                } else if (data1 === CC_ALL_NOTES_OFF || data1 === CC_ALL_SOUND_OFF) {
                    // The receiver has ended every note on the channel, so
                    // there is nothing of this sender's left to end there.
                    this.held[channel].clear();
                } else if (data1 === CC_RESET_ALL_CONTROLLERS) {
                    // The spec includes the pedal in "all controllers".
                    this.sustained &= ~bit;
                }
                return;
            default:
                return;
        }
    }

    holds(channel: number, note: number): boolean {
        return this.held[channel].has(note);
    }

    holdsAny(channel: number): boolean {
        return this.held[channel].size > 0;
    }

    /** Whether this sender holds a note on any channel at all. */
    holdsAnything(): boolean {
        return this.held.some((notes) => notes.size > 0);
    }

    sustains(channel: number): boolean {
        return (this.sustained & (1 << channel)) !== 0;
    }

    /** Notes still held, as [channel, note] pairs - what a close would end. */
    heldNotes(): [number, number][] {
        const out: [number, number][] = [];
        for (let channel = 0; channel < 16; channel++) for (const note of this.held[channel]) out.push([channel, note]);
        return out;
    }

    /**
     * What ends what this sender left sounding: a NoteOff for every note it
     * still holds, then CC 64 = 0 and CC 123 on every channel it played on.
     *
     * In that order, because a NoteOff sent under a pedal that is still down
     * ends nothing a listener can hear - the pedal has to come up after it -
     * and CC 123 last, as the net under both.
     *
     * `others` are the other live connections on the same port. Their notes
     * are left alone: no NoteOff for a note one of them also holds, no pedal
     * lift on a channel where one of them has the pedal down, and no All Notes
     * Off on a channel where one of them is holding anything.
     *
     * Nor on channel 1 or 16 while one of them holds anything anywhere. Those
     * are where an MPE zone's master sits - the app sends its sustain pedal
     * there - and an MPE receiver applies a master channel's messages to the
     * whole zone, so an All Notes Off there ends every member channel's notes,
     * the other sender's included. The NoteOffs above have already ended this
     * sender's own; the net is only worth casting where it catches nobody else.
     */
    releaseMessages(others: Iterable<HeldNotes>): number[][] {
        const peers = [...others].filter((other) => other !== this);
        const messages: number[][] = [];
        for (let channel = 0; channel < 16; channel++) {
            for (const note of this.held[channel]) {
                if (peers.some((peer) => peer.holds(channel, note))) continue;
                messages.push([NOTE_OFF | channel, note, 0]);
            }
        }
        const peerPlaying = peers.some((peer) => peer.holdsAnything());
        for (let channel = 0; channel < 16; channel++) {
            if ((this.touched & (1 << channel)) === 0) continue;
            if (!peers.some((peer) => peer.sustains(channel))) messages.push([CONTROL_CHANGE | channel, CC_SUSTAIN, 0]);
            const zoneWide = channel === MPE_LOWER_MASTER || channel === MPE_UPPER_MASTER;
            const spares = zoneWide ? !peerPlaying : !peers.some((peer) => peer.holdsAny(channel));
            if (spares) messages.push([CONTROL_CHANGE | channel, CC_ALL_NOTES_OFF, 0]);
        }
        return messages;
    }
}
