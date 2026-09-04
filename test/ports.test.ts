// Getting ports, on the two platforms that do it differently.
//
// The Windows path is the only one that can fail, and it is the one nobody
// developing on a Mac will ever exercise by accident - so the backend is
// injected and every case here runs on any machine, with no MIDI hardware and
// no native module.

import { describe, expect, it, beforeEach } from 'vitest';
import { createsVirtualPorts, listPorts, openPorts, type MidiBackend, type MidiOutputPort } from '../src/ports.js';
import { ALL_PORT_NAMES, PORT_NAMES } from '../src/protocol.js';

/** A MIDI output that records what it was asked to do. */
class FakeOutput implements MidiOutputPort {
    opened: number | null = null;
    virtualName: string | null = null;
    closed = false;
    sent: number[][] = [];

    constructor(private readonly existing: string[], private readonly failOn?: string) {}

    getPortCount(): number {
        return this.existing.length;
    }
    getPortName(index: number): string {
        return this.existing[index] ?? '';
    }
    openPort(index: number): void {
        if (this.failOn && this.existing[index] === this.failOn) throw new Error('in use');
        this.opened = index;
    }
    openVirtualPort(name: string): void {
        if (this.failOn === name) throw new Error('refused');
        this.virtualName = name;
    }
    closePort(): void {
        this.closed = true;
    }
    sendMessage(bytes: number[]): void {
        this.sent.push([...bytes]);
    }
}

function backendFor(platform: string, existing: string[] = [], failOn?: string) {
    const outputs: FakeOutput[] = [];
    const backend: MidiBackend = {
        platform,
        createOutput: () => {
            const output = new FakeOutput(existing, failOn);
            outputs.push(output);
            return output;
        },
    };
    return { backend, outputs };
}

describe('which platforms make their own ports', () => {
    it('is everything except Windows', () => {
        // Not a preference - RtMidi's openVirtualPort is unimplemented on the
        // Windows MultiMedia API and throws. See thestk/rtmidi#332.
        expect(createsVirtualPorts('darwin')).toBe(true);
        expect(createsVirtualPorts('linux')).toBe(true);
        expect(createsVirtualPorts('win32')).toBe(false);
    });
});

describe('on macOS and Linux', () => {
    it('creates every port, needing nothing installed', () => {
        const { backend, outputs } = backendFor('darwin');
        const ports = openPorts(backend);

        expect(ports.virtual).toBe(true);
        expect(ports.missing).toEqual([]);
        expect([...ports.open.keys()]).toEqual(ALL_PORT_NAMES);
        expect(outputs.map((output) => output.virtualName)).toEqual(ALL_PORT_NAMES);
    });

    it('reports a port it could not create rather than pretending', () => {
        const { backend } = backendFor('darwin', [], PORT_NAMES.staff);
        const ports = openPorts(backend);
        expect(ports.missing).toEqual([PORT_NAMES.staff]);
        expect(ports.open.has(PORT_NAMES.staff)).toBe(false);
        expect(ports.open.has(PORT_NAMES.pads)).toBe(true);
    });
});

describe('on Windows', () => {
    it('opens ports loopMIDI already made', () => {
        const { backend } = backendFor('win32', ALL_PORT_NAMES);
        const ports = openPorts(backend);

        expect(ports.virtual).toBe(false);
        expect(ports.missing).toEqual([]);
        expect([...ports.open.keys()]).toEqual(ALL_PORT_NAMES);
    });

    it('names the ports that are missing, because that IS the instruction', () => {
        // The failure this helper actually has. An error that does not say
        // which names to type into loopMIDI is not help.
        const { backend } = backendFor('win32', [PORT_NAMES.pads, PORT_NAMES.staff]);
        const ports = openPorts(backend);

        expect([...ports.open.keys()]).toEqual([PORT_NAMES.pads, PORT_NAMES.staff]);
        expect(ports.missing).toContain(PORT_NAMES.stylophone);
        expect(ports.missing).toContain(PORT_NAMES.theremin);
    });

    it('keeps the ports that DO exist working', () => {
        // Three instruments playing and one explained beats refusing to start
        // over a problem the player can fix in ten seconds.
        const { backend } = backendFor('win32', [PORT_NAMES.staff]);
        const ports = openPorts(backend);
        expect(ports.open.size).toBe(1);
        expect(ports.missing.length).toBeGreaterThan(0);
    });

    it('matches a name Windows has appended a device index to', () => {
        // loopMIDI ports come back as "Tutor Staff 3" often enough that exact
        // comparison would miss the port the player just created.
        const { backend } = backendFor('win32', ['Tutor Staff 3']);
        const ports = openPorts(backend, [PORT_NAMES.staff]);
        expect(ports.open.has(PORT_NAMES.staff)).toBe(true);
    });

    it('does not match a longer name that merely starts the same', () => {
        const { backend } = backendFor('win32', ['Tutor Staff Extra']);
        const ports = openPorts(backend, [PORT_NAMES.staff]);
        expect(ports.missing).toEqual([PORT_NAMES.staff]);
    });

    it('is not confused by case or padding', () => {
        const { backend } = backendFor('win32', ['  tutor   staff ']);
        const ports = openPorts(backend, [PORT_NAMES.staff]);
        expect(ports.open.has(PORT_NAMES.staff)).toBe(true);
    });
});

describe('sending', () => {
    let ports: ReturnType<typeof openPorts>;
    let outputs: FakeOutput[];

    beforeEach(() => {
        const made = backendFor('darwin');
        outputs = made.outputs;
        ports = openPorts(made.backend, [PORT_NAMES.staff]);
    });

    it('writes the bytes it was given, unaltered', () => {
        ports.open.get(PORT_NAMES.staff)!.send([0x90, 60, 100]);
        expect(outputs[0].sent).toEqual([[0x90, 60, 100]]);
    });

    it('survives a port that goes away mid-note', () => {
        // loopMIDI closed, or a device unplugged. It must not take down the
        // server every other instrument is playing through.
        outputs[0].sendMessage = () => {
            throw new Error('port gone');
        };
        expect(() => ports.open.get(PORT_NAMES.staff)!.send([0x90, 60, 100])).not.toThrow();
    });

    it('closes everything on shutdown', () => {
        ports.closeAll();
        expect(outputs[0].closed).toBe(true);
        expect(ports.open.size).toBe(0);
    });
});

describe('listing what is there', () => {
    it('reports the machine’s own outputs, for the diagnostic banner', () => {
        const { backend } = backendFor('win32', ['loopMIDI Port', 'Microsoft GS Wavetable Synth']);
        expect(listPorts(backend)).toEqual(['loopMIDI Port', 'Microsoft GS Wavetable Synth']);
    });
});
