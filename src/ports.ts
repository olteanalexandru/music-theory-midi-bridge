// Getting MIDI ports, which works in two completely different ways.
//
// The constraint that shapes this whole file: **RtMidi cannot create virtual
// MIDI ports on Windows.** `openVirtualPort` is implemented for macOS CoreMIDI,
// Linux ALSA and JACK, and on the Windows MultiMedia API it throws outright -
// see https://github.com/thestk/rtmidi/issues/332. There is no flag, no
// fallback and no version of RtMidi where this changes; it is a limitation of
// the Windows API underneath it.
//
// So:
//
//   macOS / Linux   the helper CREATES its ports. Nothing else to install.
//   Windows         the helper FINDS ports that loopMIDI created, by name.
//
// The Windows path is the one that can fail, and it fails for exactly one
// reason - a port with that name does not exist yet - so it has to say the
// names rather than report "no such port". A player who has to guess what to
// type into loopMIDI has been given an error message, not help.

import { ALL_PORT_NAMES } from './protocol.js';

/**
 * The bit of `@julusian/midi` this file uses.
 *
 * Declared rather than imported as a type so the tests can hand in a fake
 * without the native module being present at all - which also means `npm test`
 * runs on a machine with no build toolchain.
 */
export interface MidiOutputPort {
    getPortCount(): number;
    getPortName(index: number): string;
    openPort(index: number): void;
    openVirtualPort(name: string): void;
    closePort(): void;
    sendMessage(bytes: number[]): void;
}

export interface MidiBackend {
    /** A fresh, unopened output. One per port, because each holds one connection. */
    createOutput(): MidiOutputPort;
    /** 'win32' | 'darwin' | 'linux'. Injected so the Windows path is testable anywhere. */
    platform: string;
}

export interface OpenPort {
    name: string;
    send(bytes: number[]): void;
    close(): void;
}

export interface PortSet {
    /** Ports actually open and writable. */
    open: Map<string, OpenPort>;
    /** Names that should exist and do not. Windows only - see the header. */
    missing: string[];
    /** True when this platform makes its own ports. */
    virtual: boolean;
    closeAll(): void;
    /**
     * Close and re-open one port, and say whether it is usable now.
     *
     * `open` and `missing` were a snapshot taken once, at startup, and a
     * long-running helper outlives the thing it snapshotted. Restart loopMIDI -
     * or let Windows renumber its devices - and every handle in that map is
     * stale while the map still cheerfully lists them as open.
     *
     * The failure that produces is the worst kind this program has: a client
     * connects, `hello` reports the port open and `missing` empty, every
     * message is accepted, and NOT ONE BYTE reaches a MIDI port. Measured, on a
     * real machine: a fresh helper delivered notes and the instance that had
     * been running for an afternoon delivered none, same port, same second,
     * same code. Nothing anywhere said so.
     *
     * So the snapshot is refreshed at the one moment it matters and costs
     * nothing - when a client connects, which is rare, and is exactly when
     * somebody is about to play.
     */
    refresh(name: string): boolean;
}

/** Windows is the only platform where ports have to already exist. */
export function createsVirtualPorts(platform: string): boolean {
    return platform !== 'win32';
}

/**
 * loopMIDI ports show up under their own name, but a Windows MIDI port name
 * often carries a device index - "Tutor Staff 3" - and comparing exactly would
 * miss it. Matching on a normalised prefix is what makes the name the player
 * typed and the name Windows reports the same thing.
 */
function matchesPortName(reported: string, wanted: string): boolean {
    const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
    const left = normalise(reported);
    const right = normalise(wanted);
    if (left === right) return true;
    // "Tutor Staff 3" for "Tutor Staff", but never "Tutor Staff Extra" for it -
    // the remainder has to be a number, which is what Windows appends.
    return left.startsWith(`${right} `) && /^\d+$/.test(left.slice(right.length + 1));
}

function findPortIndex(output: MidiOutputPort, name: string): number {
    const count = output.getPortCount();
    for (let index = 0; index < count; index++) {
        if (matchesPortName(output.getPortName(index), name)) return index;
    }
    return -1;
}

/** Every output port on this machine, for the diagnostic banner. */
export function listPorts(backend: MidiBackend): string[] {
    const probe = backend.createOutput();
    try {
        const names: string[] = [];
        const count = probe.getPortCount();
        for (let index = 0; index < count; index++) names.push(probe.getPortName(index));
        return names;
    } finally {
        probe.closePort();
    }
}

/**
 * Opens every port the helper routes to.
 *
 * Partial success is the normal case on Windows and is deliberately not an
 * error: three ports existing and one missing should leave three instruments
 * playing, with the fourth explained. Refusing to start at all would be a
 * worse answer to a problem the player can fix in ten seconds.
 */
export function openPorts(
    backend: MidiBackend,
    names: string[] = ALL_PORT_NAMES,
    onSendError?: (portName: string, error: unknown) => void
): PortSet {
    const virtual = createsVirtualPorts(backend.platform);
    const open = new Map<string, OpenPort>();
    const missing: string[] = [];

    /**
     * One port, opened. Null when it does not exist or will not open.
     *
     * Extracted so `refresh` opens a port exactly the way startup did - two
     * copies of this would be two answers to "is this port usable", and the
     * whole point of refresh is that the second answer is the trustworthy one.
     */
    const openOne = (name: string): OpenPort | null => {
        const output = backend.createOutput();
        try {
            if (virtual) {
                output.openVirtualPort(name);
            } else {
                const index = findPortIndex(output, name);
                if (index < 0) {
                    output.closePort();
                    return null;
                }
                output.openPort(index);
            }
        } catch {
            // A port that will not open is a missing port as far as the player
            // is concerned, and the instruction is the same either way.
            try {
                output.closePort();
            } catch {
                // Already gone.
            }
            return null;
        }

        let reportedSendError = false;
        return {
            name,
            send: (bytes) => {
                try {
                    output.sendMessage(bytes);
                } catch (error) {
                    // A port yanked mid-note (loopMIDI closed, device
                    // unplugged) must not take down the server everything else
                    // is playing through - but it must not be silent either.
                    // Every note after it goes nowhere, and "nothing is coming
                    // out and nothing said so" is the failure this whole
                    // program exists to avoid. Once per port: a dead port is
                    // dead for every message after the first, and a trill would
                    // print a hundred lines a second.
                    if (!reportedSendError) {
                        reportedSendError = true;
                        onSendError?.(name, error);
                    }
                }
            },
            close: () => {
                try {
                    output.closePort();
                } catch {
                    // Already gone.
                }
            },
        };
    };

    for (const name of names) {
        const port = openOne(name);
        if (port) open.set(name, port);
        else missing.push(name);
    }

    return {
        open,
        missing,
        virtual,
        closeAll: () => {
            for (const port of open.values()) port.close();
            open.clear();
        },
        refresh: (name) => {
            // Only ports this helper routes to. A refresh of anything else is
            // a caller bug, and inventing a port for it would be worse.
            if (!names.includes(name)) return false;
            open.get(name)?.close();
            open.delete(name);
            const port = openOne(name);
            if (port) {
                open.set(name, port);
                // It exists again, so it is no longer missing. Startup's list
                // is a claim about the past; this is a claim about now.
                const at = missing.indexOf(name);
                if (at >= 0) missing.splice(at, 1);
                return true;
            }
            if (!missing.includes(name)) missing.push(name);
            return false;
        },
    };
}
