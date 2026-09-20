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
import {
    startServer,
    type ConnectionCloseInfo,
    type DropInfo,
    type MessageInfo,
    type RunningServer,
    type ServerEvent,
} from '../src/server.js';
import { openPorts, type MidiBackend, type MidiOutputPort } from '../src/ports.js';
import {
    ALL_PORT_NAMES,
    CLOSE_BAD_CLAIM,
    CLOSE_BAD_TOKEN,
    CLOSE_NO_PORT,
    DEFAULT_PORT_NAME,
    MAX_FRAME_BYTES,
    PORT_NAMES,
    PROTOCOL_VERSION,
    type HelloMessage,
} from '../src/protocol.js';

const TOKEN = 'letmein12345';

/** The MPE handshake from 'carries a whole MPE handshake through in order', for the log hooks. */
const HANDSHAKE_FOR_LOG = [
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

    it('never forwards SysEx to the port', async () => {
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 0, b: [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7] }));
        socket.send(JSON.stringify({ t: 0, b: [0x90, 62, 100] }));
        await settle();

        expect(sentTo(PORT_NAMES.staff)).toEqual([[0x90, 62, 100]]);
        socket.close();
    });

    it('refuses a frame far larger than any MIDI event, rather than buffering it', async () => {
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
        socket.send('x'.repeat(MAX_FRAME_BYTES * 4));
        // 1009 is "message too big", sent by ws itself before the frame is read.
        expect(await closed).toBe(1009);
        expect(sentTo(PORT_NAMES.staff)).toEqual([]);
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

describe('the hooks --log-midi reads from', () => {
    // The server stays free of formatting; it hands the log what it saw. These
    // pin what it hands over, over a real socket, because a log fed the wrong
    // connection id or the wrong bytes would describe somebody else's stream.
    type Seen = {
        messages: MessageInfo[];
        drops: DropInfo[];
        closes: ConnectionCloseInfo[];
    };

    async function bootWithHooks(): Promise<Seen> {
        await server.close();
        const seen: Seen = { messages: [], drops: [], closes: [] };
        port = ephemeralPort();
        server = startServer({
            port,
            token: TOKEN,
            ports,
            version: 'x',
            platform: 'darwin',
            onMessage: (info) => seen.messages.push(info),
            onDrop: (info) => seen.drops.push(info),
            onConnectionClose: (info) => seen.closes.push(info),
        });
        return seen;
    }

    it('hands over every forwarded frame with its connection, port, claim, client and t', async () => {
        const seen = await bootWithHooks();
        const { socket } = await connect(`?t=${TOKEN}&port=staff&client=android-app`);
        for (const [index, bytes] of HANDSHAKE_FOR_LOG.entries()) socket.send(JSON.stringify({ t: 10 + index, b: bytes }));
        await settle();

        expect(seen.messages.map((info) => info.bytes)).toEqual(HANDSHAKE_FOR_LOG);
        const [first] = seen.messages;
        expect(first).toMatchObject({ portName: PORT_NAMES.staff, claim: 'staff', client: 'android-app', t: 10 });
        expect(first.connId).toBeGreaterThan(0);
        expect(first.receivedAt).toBeGreaterThanOrEqual(first.openedAt);
        // Written to the port as well - the hook observes, it does not replace.
        expect(sentTo(PORT_NAMES.staff)).toEqual(HANDSHAKE_FOR_LOG);
        socket.close();
    });

    it('gives two sockets on one port two connection ids', async () => {
        const seen = await bootWithHooks();
        const a = await connect(`?t=${TOKEN}&port=staff`);
        const b = await connect(`?t=${TOKEN}&port=staff`);
        a.socket.send(JSON.stringify({ t: 0, b: [0x90, 60, 100] }));
        b.socket.send(JSON.stringify({ t: 0, b: [0x90, 64, 100] }));
        await settle();
        expect(new Set(seen.messages.map((info) => info.connId)).size).toBe(2);
        a.socket.close();
        b.socket.close();
    });

    it('says why a frame was dropped', async () => {
        const seen = await bootWithHooks();
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send('not json');
        socket.send(JSON.stringify({ t: 0, b: [0xf0, 0x7e, 0xf7] }));
        socket.send(JSON.stringify({ t: 0, b: [999] }));
        socket.send(JSON.stringify({ b: [0x90, 60, 100] }));
        await settle();

        expect(seen.drops.map((drop) => drop.reason)).toEqual([
            'not JSON',
            'SysEx refused (0xF0 at b[0])',
            'b[0] = 999 is not a MIDI byte (an integer 0-255)',
            't is missing or not a finite number',
        ]);
        expect(seen.drops[0]).toMatchObject({ portName: PORT_NAMES.staff, raw: 'not json' });
        expect(seen.messages).toEqual([]);
        socket.close();
    });

    it('reports an oversize frame as a drop before the close', async () => {
        const seen = await bootWithHooks();
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        const closed = new Promise((resolve) => socket.on('close', resolve));
        socket.send('x'.repeat(MAX_FRAME_BYTES * 4));
        await closed;
        await settle();
        expect(seen.drops.map((drop) => drop.reason)).toEqual([`frame larger than ${MAX_FRAME_BYTES} bytes, connection closed (1009)`]);
        expect(seen.closes).toHaveLength(1);
        expect(seen.closes[0].code).toBe(1009);
    });

    it('says when a connection closes, with the id its frames carried', async () => {
        const seen = await bootWithHooks();
        const { socket } = await connect(`?t=${TOKEN}&port=pads&client=browser`);
        socket.send(JSON.stringify({ t: 0, b: [0x90, 60, 100] }));
        await settle();
        socket.close();
        await settle();
        expect(seen.closes).toHaveLength(1);
        expect(seen.closes[0]).toMatchObject({
            connId: seen.messages[0].connId,
            portName: PORT_NAMES.pads,
            claim: 'pads',
            client: 'browser',
        });
        expect(seen.closes[0].closedAt).toBeGreaterThanOrEqual(seen.closes[0].openedAt);
    });

    it('keeps forwarding when a hook throws', async () => {
        // A diagnostic that breaks must cost a log line, never the note.
        await server.close();
        port = ephemeralPort();
        server = startServer({
            port,
            token: TOKEN,
            ports,
            version: 'x',
            platform: 'darwin',
            onMessage: () => {
                throw new Error('log bug');
            },
        });
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 0, b: [0x90, 60, 100] }));
        socket.send(JSON.stringify({ t: 1, b: [0x80, 60, 0] }));
        await settle();
        expect(sentTo(PORT_NAMES.staff)).toEqual([
            [0x90, 60, 100],
            [0x80, 60, 0],
        ]);
        expect(socket.readyState).toBe(WebSocket.OPEN);
        socket.close();
    });
});

describe('ending what a closed socket left sounding', () => {
    // A phone that locks, a tab that is closed, Wi-Fi that drops mid-chord:
    // the socket ends with note-ons already in the DAW and their note-offs
    // never coming. Nothing else would end them.

    /** Waits for the server to have handled a close, which the client learns before it does. */
    async function closeAndSettle(socket: WebSocket, how: 'close' | 'terminate' = 'close'): Promise<void> {
        if (how === 'close') socket.close();
        else socket.terminate();
        await settle();
    }

    it('sends a NoteOff for every note it held, then the pedal up and All Notes Off on the channels it played', async () => {
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        for (const bytes of [
            [0xb0, 64, 127],
            [0x91, 60, 100],
            [0x92, 64, 100],
            [0x93, 67, 100],
            [0x83, 67, 0],
        ]) {
            socket.send(JSON.stringify({ t: 0, b: bytes }));
        }
        await settle();
        const before = sentTo(PORT_NAMES.staff).length;
        await closeAndSettle(socket);

        expect(sentTo(PORT_NAMES.staff).slice(before)).toEqual([
            [0x81, 60, 0],
            [0x82, 64, 0],
            [0xb0, 64, 0],
            [0xb0, 123, 0],
            [0xb1, 64, 0],
            [0xb1, 123, 0],
            [0xb2, 64, 0],
            [0xb2, 123, 0],
            [0xb3, 64, 0],
            [0xb3, 123, 0],
        ]);
    });

    it('does the same when the socket dies rather than closing', async () => {
        const { socket } = await connect(`?t=${TOKEN}&port=pads`);
        socket.send(JSON.stringify({ t: 0, b: [0x91, 60, 100] }));
        await settle();
        await closeAndSettle(socket, 'terminate');
        expect(sentTo(PORT_NAMES.pads)).toContainEqual([0x81, 60, 0]);
        expect(sentTo(PORT_NAMES.pads).at(-1)).toEqual([0xb1, 123, 0]);
    });

    it('sends nothing when the socket ended its own notes and played nothing else', async () => {
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        for (const bytes of HANDSHAKE_FOR_LOG.slice(0, 6)) socket.send(JSON.stringify({ t: 0, b: bytes }));
        await settle();
        const before = sentTo(PORT_NAMES.staff).length;
        await closeAndSettle(socket);
        expect(sentTo(PORT_NAMES.staff).slice(before)).toEqual([]);
    });

    it("leaves another socket's notes on a shared port sounding", async () => {
        const leaving = await connect(`?t=${TOKEN}&port=staff`);
        const staying = await connect(`?t=${TOKEN}&port=staff`);
        leaving.socket.send(JSON.stringify({ t: 0, b: [0x91, 60, 100] }));
        leaving.socket.send(JSON.stringify({ t: 0, b: [0x92, 62, 100] }));
        staying.socket.send(JSON.stringify({ t: 0, b: [0x91, 64, 100] }));
        staying.socket.send(JSON.stringify({ t: 0, b: [0x92, 62, 100] }));
        await settle();
        const before = sentTo(PORT_NAMES.staff).length;
        await closeAndSettle(leaving.socket);

        const released = sentTo(PORT_NAMES.staff).slice(before);
        // Its own note on ch 2 ends; 62 on ch 3 is the other socket's too, and
        // both channels still carry the other socket's notes - so no NoteOff
        // for 62 and no All Notes Off anywhere.
        expect(released).toEqual([
            [0x81, 60, 0],
            [0xb1, 64, 0],
            [0xb2, 64, 0],
        ]);
        expect(staying.socket.readyState).toBe(WebSocket.OPEN);

        // And the one that stays is released in full when it goes.
        await closeAndSettle(staying.socket);
        expect(sentTo(PORT_NAMES.staff).slice(before + released.length)).toEqual([
            [0x81, 64, 0],
            [0x82, 62, 0],
            [0xb1, 64, 0],
            [0xb1, 123, 0],
            [0xb2, 64, 0],
            [0xb2, 123, 0],
        ]);
    });

    it('reports what it sent to the log hook and in the disconnect event', async () => {
        await server.close();
        const closes: ConnectionCloseInfo[] = [];
        const ended: number[] = [];
        port = ephemeralPort();
        server = startServer({
            port,
            token: TOKEN,
            ports,
            version: 'x',
            platform: 'darwin',
            onEvent: (event) => {
                if (event.type === 'disconnected') ended.push(event.ended);
            },
            onConnectionClose: (info) => closes.push(info),
        });
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 0, b: [0x91, 60, 100] }));
        await settle();
        await closeAndSettle(socket);
        expect(closes[0].released).toEqual([
            [0x81, 60, 0],
            [0xb1, 64, 0],
            [0xb1, 123, 0],
        ]);
        expect(ended).toEqual([1]);
    });

    it('leaves the whole-port panic to the caller when the server itself is shutting down', async () => {
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 0, b: [0x91, 60, 100] }));
        await settle();
        const before = sentTo(PORT_NAMES.staff).length;
        await server.close();
        await settle();
        expect(sentTo(PORT_NAMES.staff).slice(before)).toEqual([]);
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

// A phone that vanishes WITHOUT closing - out of Wi-Fi range, battery flat,
// the app killed by the OS - sends no close frame, and this server writes
// nothing after `hello`, so nothing here would ever fail. The socket stayed
// "open" with every note it had started still sounding in the DAW, until
// Ctrl+C. A ping is a write, so it is what finds out.
describe('the heartbeat', () => {
    /** Milliseconds rather than seconds, so a test is a test and not a wait. */
    const BEAT_MS = 25;
    /** Two pings unanswered, then one more tick to act on it. */
    const UNTIL_DROPPED = BEAT_MS * 3 + 80;

    async function bootWithHeartbeat(heartbeatMs: number, onEvent?: (event: ServerEvent) => void) {
        await server.close();
        const made = fakeBackend('darwin', ALL_PORT_NAMES);
        outputs = made.outputs;
        ports = openPorts(made.backend, ALL_PORT_NAMES);
        port = ephemeralPort();
        server = startServer({ port, token: TOKEN, ports, version: 'x', platform: 'darwin', heartbeatMs, onEvent });
    }

    /**
     * What an out-of-range phone looks like from here: the socket is simply
     * never answered again. Pausing stops the client reading, so the ping is
     * never parsed and `ws`'s own automatic pong never happens - without
     * pretending to be a client that refuses to answer, which no real one is.
     */
    const vanish = (socket: WebSocket) => socket.pause();

    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('ends the notes a vanished connection left held', async () => {
        await bootWithHeartbeat(BEAT_MS);
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 0, b: [0x91, 60, 100] }));
        await settle();

        vanish(socket);
        await wait(UNTIL_DROPPED);

        // The release-on-close path, reached because the bridge closed it.
        expect(sentTo(PORT_NAMES.staff)).toContainEqual([0x81, 60, 0]);
        expect(server.connections()).toBe(0);
        socket.terminate();
    });

    it('says it was the bridge that dropped it', async () => {
        // Without this the line reads as somebody pressing Disconnect, and the
        // twenty-odd seconds it took to notice read as the bridge being slow.
        const events: ServerEvent[] = [];
        await bootWithHeartbeat(BEAT_MS, (event) => events.push(event));
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 0, b: [0x91, 60, 100] }));
        await settle();

        vanish(socket);
        await wait(UNTIL_DROPPED);

        expect(events.find((event) => event.type === 'disconnected')).toMatchObject({ ended: 1, timedOut: true });
        socket.terminate();
    });

    it('stays out of a healthy connection’s way', async () => {
        // `ws` answers pings on its own, exactly as a browser does below the
        // page - so a connection that is simply idle is never dropped.
        const events: ServerEvent[] = [];
        await bootWithHeartbeat(BEAT_MS, (event) => events.push(event));
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 0, b: [0x91, 60, 100] }));

        await wait(BEAT_MS * 6 + 40);
        expect(events.some((event) => event.type === 'disconnected')).toBe(false);
        expect(server.connections()).toBe(1);

        // And when it does go, it is not reported as a timeout.
        socket.close();
        await settle();
        expect(events.find((event) => event.type === 'disconnected')).toMatchObject({ timedOut: false });
    });

    it('can be switched off', async () => {
        await bootWithHeartbeat(0);
        const { socket } = await connect(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 0, b: [0x91, 60, 100] }));
        await settle();

        vanish(socket);
        await wait(UNTIL_DROPPED);
        expect(server.connections()).toBe(1);
        socket.terminate();
    });
});
