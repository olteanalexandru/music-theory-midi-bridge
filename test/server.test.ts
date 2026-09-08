// The server, over a real socket.
//
// Real `ws` on a real ephemeral port rather than a mocked one: the things worth
// checking here are a URL being parsed, a token being compared and a close code
// arriving, and a mock of the socket layer would be asserting my own idea of
// what `ws` does rather than what it does.
//
// The MIDI end stays fake - that is what `ports.ts` takes a backend for - so
// this runs on any machine with no MIDI hardware.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../src/server.js';
import { openPorts, type MidiBackend, type MidiOutputPort } from '../src/ports.js';
import {
    ALL_PORT_NAMES,
    CLOSE_BAD_CLAIM,
    CLOSE_BAD_TOKEN,
    CLOSE_NO_PORT,
    DEFAULT_PORT_NAME,
    PORT_NAMES,
    PROTOCOL_VERSION,
    type HelloMessage,
} from '../src/protocol.js';

const TOKEN = 'letmein12345';

class FakeOutput implements MidiOutputPort {
    sent: number[][] = [];
    /** Which port this one ended up on, so a test can ask by name. */
    opened = '';
    constructor(private readonly existing: string[]) {}
    getPortCount() {
        return this.existing.length;
    }
    getPortName(index: number) {
        return this.existing[index] ?? '';
    }
    openPort(index: number) {
        this.opened = this.existing[index] ?? '';
    }
    openVirtualPort(name: string) {
        this.opened = name;
    }
    closePort() {}
    sendMessage(bytes: Buffer) {
        this.sent.push([...bytes]);
    }
}

function fakeBackend(platform = 'darwin', existing: string[] = []) {
    const outputs: FakeOutput[] = [];
    const backend: MidiBackend = {
        platform,
        createOutput: () => {
            const output = new FakeOutput(existing);
            outputs.push(output);
            return output;
        },
    };
    return { backend, outputs };
}

let server: RunningServer;
let port: number;
let outputs: FakeOutput[];
let ports: ReturnType<typeof openPorts>;

/**
 * Everything that reached one named port, across every handle it has had.
 *
 * By name rather than by index into `outputs`, because a port can be re-opened
 * while the server runs - `PortSet.refresh` closes the old handle and makes a
 * new one when an idle port is claimed, which is how a stale loopMIDI handle
 * gets repaired. An index captured at boot would point at the handle that is
 * no longer the one being written to, and the test would report an empty port
 * for a port that is working perfectly.
 */
function sentTo(name: string): number[][] {
    return outputs.filter((output) => output.opened === name).flatMap((output) => output.sent);
}

/** A free port. 0 lets the OS pick, but `ws` needs a number we know. */
function ephemeralPort(): number {
    return 20000 + Math.floor(Math.random() * 20000);
}

function boot(platform = 'darwin', existing = ALL_PORT_NAMES) {
    const made = fakeBackend(platform, existing);
    outputs = made.outputs;
    ports = openPorts(made.backend, ALL_PORT_NAMES);
    port = ephemeralPort();
    server = startServer({ port, token: TOKEN, ports, version: '1.0.0-test', platform });
}

/** Opens a socket and resolves with its hello frame, or the close code. */
function connect(query: string): Promise<{ hello?: HelloMessage; code?: number; socket: WebSocket }> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/midi${query}`);
        let hello: HelloMessage | undefined;
        const timer = setTimeout(() => reject(new Error('timed out')), 4000);
        socket.on('message', (data) => {
            hello = JSON.parse(data.toString()) as HelloMessage;
            // The hello arrives first even on a refusal, so wait a beat for a
            // close that may follow it.
            setTimeout(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    clearTimeout(timer);
                    resolve({ hello, socket });
                }
            }, 50);
        });
        socket.on('close', (code) => {
            clearTimeout(timer);
            resolve({ hello, code, socket });
        });
        socket.on('error', () => undefined);
    });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

beforeEach(() => boot());
afterEach(async () => {
    await server.close();
    ports.closeAll();
});

describe('the token', () => {
    it('lets a socket with the right one in', async () => {
        const { hello, code } = await connect(`?t=${TOKEN}&port=staff`);
        expect(code).toBeUndefined();
        expect(hello?.hello).toBe(PROTOCOL_VERSION);
    });

    it('turns away a socket with the wrong one', async () => {
        // An open socket that injects MIDI into whatever this machine is
        // running should not accept the whole café.
        const { code } = await connect('?t=nope&port=staff');
        expect(code).toBe(CLOSE_BAD_TOKEN);
    });

    it('turns away a socket with none at all', async () => {
        const { code } = await connect('?port=staff');
        expect(code).toBe(CLOSE_BAD_TOKEN);
    });

    it('is not fooled by a prefix of the real one', async () => {
        const { code } = await connect(`?t=${TOKEN.slice(0, 6)}&port=staff`);
        expect(code).toBe(CLOSE_BAD_TOKEN);
    });
});

describe('claiming a port, which is claiming an Ableton track', () => {
    it('routes each instrument to its own port', async () => {
        const { hello } = await connect(`?t=${TOKEN}&port=pads`);
        expect(hello?.claimed).toBe('pads');
        expect(hello?.portName).toBe(PORT_NAMES.pads);
    });

    it('falls back to the shared port when nothing is claimed', async () => {
        const { hello } = await connect(`?t=${TOKEN}`);
        expect(hello?.claimed).toBeNull();
        expect(hello?.portName).toBe(DEFAULT_PORT_NAME);
    });

    it('refuses an instrument it has never heard of', async () => {
        const { code } = await connect(`?t=${TOKEN}&port=trombone`);
        expect(code).toBe(CLOSE_BAD_CLAIM);
    });

    it('keeps two instruments on two different ports', async () => {
        // The whole point: one socket, one instrument, one port, one track.
        const a = await connect(`?t=${TOKEN}&port=staff`);
        const b = await connect(`?t=${TOKEN}&port=theremin`);
        a.socket.send(JSON.stringify({ t: 0, b: [0x90, 60, 100] }));
        b.socket.send(JSON.stringify({ t: 0, b: [0x90, 67, 100] }));
        await settle();

        expect(sentTo(PORT_NAMES.staff)).toEqual([[0x90, 60, 100]]);
        expect(sentTo(PORT_NAMES.theremin)).toEqual([[0x90, 67, 100]]);

        a.socket.close();
        b.socket.close();
    });
});

describe('the hello frame', () => {
    it('says what this helper is and what it has open', async () => {
        const { hello } = await connect(`?t=${TOKEN}&port=staff`);
        expect(hello?.version).toBe('1.0.0-test');
        expect(hello?.platform).toBe('darwin');
        expect(hello?.ports).toEqual(ALL_PORT_NAMES);
        expect(hello?.missing).toEqual([]);
    });

    it('arrives even when the claimed port is missing, and says which', async () => {
        // The Windows case. Closing without a reason would leave the player
        // with a disconnection and nothing to act on; the missing list IS the
        // instruction the app turns into "create this in loopMIDI".
        await server.close();
        ports.closeAll();
        boot('win32', [PORT_NAMES.pads]);

        const { hello, code } = await connect(`?t=${TOKEN}&port=staff`);
        expect(hello?.missing).toContain(PORT_NAMES.staff);
        expect(hello?.portName).toBe(PORT_NAMES.staff);
        expect(code).toBe(CLOSE_NO_PORT);
    });

    it('still serves the instruments whose ports do exist', async () => {
        await server.close();
        ports.closeAll();
        boot('win32', [PORT_NAMES.pads]);

        const { hello, code } = await connect(`?t=${TOKEN}&port=pads`);
        expect(code).toBeUndefined();
        expect(hello?.portName).toBe(PORT_NAMES.pads);
    });
});

describe('what reaches the port', () => {
    it('is the bytes, unaltered', async () => {
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 3, b: [0xe1, 0x00, 0x50] }));
        await settle();
        expect(sentTo(PORT_NAMES.staff)).toEqual([[0xe1, 0x00, 0x50]]);
        socket.close();
    });

    it('carries a whole MPE handshake through in order', async () => {
        // The claim the app's own test makes from the other side: nothing here
        // interprets MIDI, so the MPE Configuration Message, the RPN 0 ranges
        // and the per-note bends arrive exactly as sent.
        const handshake = [
            [0xb0, 101, 0],
            [0xb0, 100, 6],
            [0xb0, 6, 15],
            [0xb1, 101, 0],
            [0xb1, 100, 0],
            [0xb1, 6, 48],
            [0x91, 60, 100],
            [0xe1, 0x00, 0x60],
            [0x81, 60, 64],
        ];
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        for (const bytes of handshake) socket.send(JSON.stringify({ t: 0, b: bytes }));
        await settle();

        expect(sentTo(PORT_NAMES.staff)).toEqual(handshake);
        socket.close();
    });

    it('drops a malformed frame without dropping the connection', async () => {
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send('not json');
        socket.send(JSON.stringify({ t: 0, b: [999] }));
        socket.send(JSON.stringify({ t: 0, b: [0x90, 60, 100] }));
        await settle();

        expect(sentTo(PORT_NAMES.staff)).toEqual([[0x90, 60, 100]]);
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close();
    });
});

describe('housekeeping', () => {
    it('counts its connections', async () => {
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        expect(server.connections()).toBe(1);
        socket.close();
    });

    it('reports connects and disconnects', async () => {
        await server.close();
        const events: string[] = [];
        port = ephemeralPort();
        server = startServer({
            port,
            token: TOKEN,
            ports,
            version: 'x',
            platform: 'darwin',
            onEvent: (event) => events.push(event.type),
        });

        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.close();
        await settle();
        expect(events).toContain('connected');
        expect(events).toContain('disconnected');
    });
});

describe('re-opening the port a client is about to use', () => {
    // A helper outlives what it measured at startup. Restart loopMIDI under a
    // running one and every handle it holds is stale while its map still
    // reports them open - so hello says the port is fine, every message is
    // accepted, and nothing reaches MIDI. Re-opening on connect is what makes
    // hello a statement about now.

    it('opens a fresh handle when the port is idle', async () => {
        boot();
        const name = PORT_NAMES.staff;
        const before = outputs.filter((output) => output.opened === name).length;

        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        const after = outputs.filter((output) => output.opened === name).length;
        expect(after).toBe(before + 1);

        // And the fresh one is the one that gets written to.
        socket.send(JSON.stringify({ t: 0, b: [0x90, 60, 100] }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(sentTo(name)).toEqual([[0x90, 60, 100]]);
        socket.close();
    });

    it('leaves the handle alone while somebody is already on that port', async () => {
        // Refresh closes the old handle, and a connected client captured it -
        // so refreshing under a live connection would silently stop the
        // instrument that was already playing. That is the exact failure this
        // whole change exists to remove, and it must not be reintroduced by
        // the fix for it.
        boot();
        const name = PORT_NAMES.staff;
        const first = await connect(`?t=${TOKEN}&port=staff`);
        const afterFirst = outputs.filter((output) => output.opened === name).length;

        const second = await connect(`?t=${TOKEN}&port=staff`);
        expect(outputs.filter((output) => output.opened === name).length).toBe(afterFirst);

        // Both are still writing to the same, still-open port.
        first.socket.send(JSON.stringify({ t: 0, b: [0x90, 60, 100] }));
        second.socket.send(JSON.stringify({ t: 1, b: [0x80, 60, 0] }));
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(sentTo(name)).toEqual([
            [0x90, 60, 100],
            [0x80, 60, 0],
        ]);
        first.socket.close();
        second.socket.close();
    });
});
