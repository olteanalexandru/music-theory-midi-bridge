// The PC view, over real sockets.
//
// /view is a pipe: one phone sends, up to four browsers on this computer
// watch, and a frame is forwarded as it came and kept nowhere. These run `ws`
// on an ephemeral port, as fileServer.test.ts does, because what matters is
// which socket is closed with which code and which frames arrive where.

import { connect as connectTcp } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startServer, type RunningServer, type ServerEvent } from '../src/server.js';
import { openPorts, type MidiBackend, type MidiOutputPort } from '../src/ports.js';
import {
    ALL_PORT_NAMES,
    CLOSE_BAD_CLAIM,
    CLOSE_BAD_TOKEN,
    CLOSE_BUSY,
    CLOSE_VIEW_NOT_LOCAL,
    CLOSE_VIEW_RATE,
    CLOSE_VIEW_REPLACED,
    CLOSE_VIEW_TOO_SLOW,
    MAX_VIEW_BYTES_PER_SECOND,
    MAX_VIEW_FRAME_BYTES,
    MAX_VIEW_FRAMES_PER_SECOND,
    MAX_VIEW_WATCHERS,
    MAX_WATCH_FRAME_BYTES,
    MAX_WATCH_FRAMES_PER_SECOND,
    PORT_NAMES,
    PROTOCOL_VERSION,
    VIEW_SLOW_BUFFER_BYTES,
} from '../src/protocol.js';

const TOKEN = 'letmein12345';

class FakeOutput implements MidiOutputPort {
    sent: number[][] = [];
    opened = '';
    getPortCount() {
        return ALL_PORT_NAMES.length;
    }
    getPortName(index: number) {
        return ALL_PORT_NAMES[index] ?? '';
    }
    openPort(index: number) {
        this.opened = ALL_PORT_NAMES[index] ?? '';
    }
    openVirtualPort(name: string) {
        this.opened = name;
    }
    closePort() {}
    sendMessage(bytes: Buffer) {
        this.sent.push([...bytes]);
    }
}

let server: RunningServer;
let port: number;
let outputs: FakeOutput[];
let ports: ReturnType<typeof openPorts>;
let events: ServerEvent[];
/** Every argument every hook was ever given, as text, to look for what must never be in it. */
let hookCalls: string[];
const open: WebSocket[] = [];

function boot(options: { remoteAddress?: string; heartbeatMs?: number } = {}) {
    outputs = [];
    const backend: MidiBackend = {
        platform: 'darwin',
        createOutput: () => {
            const output = new FakeOutput();
            outputs.push(output);
            return output;
        },
    };
    ports = openPorts(backend, ALL_PORT_NAMES);
    port = 20000 + Math.floor(Math.random() * 20000);
    // This test's own arrays, not the shared names: the sockets of the test
    // before are still closing and would report into whatever the names point at.
    const mineEvents: ServerEvent[] = [];
    const mineCalls: string[] = [];
    events = mineEvents;
    hookCalls = mineCalls;
    const note = (info: unknown) => mineCalls.push(JSON.stringify(info));
    server = startServer({
        port,
        token: TOKEN,
        ports,
        version: '1.0.10-test',
        platform: 'darwin',
        heartbeatMs: options.heartbeatMs ?? 0,
        remoteAddressOf: options.remoteAddress === undefined ? undefined : () => options.remoteAddress,
        onEvent: (event) => mineEvents.push(event),
        onMessage: note,
        onDrop: note,
        onConnectionClose: note,
    });
}

/** A socket that keeps every text frame it is sent, in order, and how it closed. */
class Peer {
    readonly messages: string[] = [];
    readonly closed: Promise<number>;
    readonly opened: Promise<boolean>;

    constructor(readonly socket: WebSocket) {
        open.push(socket);
        socket.on('message', (data) => this.messages.push(data.toString()));
        socket.on('error', () => undefined);
        this.closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
        this.opened = new Promise((resolve) => {
            socket.once('open', () => resolve(true));
            socket.once('close', () => resolve(false));
        });
    }

    /** Everything received since the last call, parsed. */
    drain(): Record<string, unknown>[] {
        return this.messages.splice(0).map((text) => JSON.parse(text) as Record<string, unknown>);
    }

    send(text: string): void {
        this.socket.send(text);
    }

    /** The visible/hidden message a PC tab sends. */
    visible(value: boolean): void {
        this.send(JSON.stringify({ visible: value }));
    }

    /** Waits for `count` frames, or until the socket is closed (a refused one never gets any). */
    async waitFor(count: number): Promise<void> {
        const until = Date.now() + 4000;
        while (this.messages.length < count && this.socket.readyState !== WebSocket.CLOSED) {
            if (Date.now() > until) throw new Error(`only ${this.messages.length} of ${count} frames arrived`);
            await sleep(5);
        }
    }

    close(): void {
        this.socket.close();
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(80);

/** Opens /view as one role and waits until it is open or refused. */
async function view(role: string, query = `&t=${TOKEN}`, host = '127.0.0.1', options: ConstructorParameters<typeof WebSocket>[2] = {}) {
    const peer = new Peer(new WebSocket(`ws://${host}:${port}/view?role=${role}${query}`, options));
    const accepted = await peer.opened;
    if (accepted) await peer.waitFor(1);
    return { peer, accepted };
}

async function sender(client = 'phone') {
    return (await view('send', `&t=${TOKEN}&client=${client}`)).peer;
}

async function watcher() {
    return (await view('watch')).peer;
}

/** The shared /midi socket the phone already has. */
async function midi() {
    const peer = new Peer(new WebSocket(`ws://127.0.0.1:${port}/midi?t=${TOKEN}&client=phone`));
    await peer.opened;
    await peer.waitFor(1);
    return peer;
}

const watchersNotice = (watchers: number, resync = false) => ({ view: { watchers, ...(resync ? { resync: true } : {}) } });
const sendersNotice = (senders: number) => ({ view: { senders } });

/** A mirror frame, exactly `size` bytes of JSON text when `size` is given. */
function frame(t: string, size?: number): string {
    const base = JSON.stringify({ t, pad: '' });
    return size === undefined ? JSON.stringify({ t, n: 1 }) : JSON.stringify({ t, pad: 'x'.repeat(size - base.length) });
}

beforeEach(() => boot());

afterEach(async () => {
    vi.restoreAllMocks();
    for (const socket of open.splice(0)) socket.terminate();
    await server.close();
    ports.closeAll();
});

describe('the token', () => {
    it('is checked before the upgrade: a wrong one or none is closed with 4001, for both roles', async () => {
        for (const role of ['send', 'watch']) {
            for (const query of ['&t=nope', '', `&t=${TOKEN.slice(0, 6)}`]) {
                const { peer, accepted } = await view(role, query);
                expect(accepted && (await peer.closed), `${role}${query}`).toBe(CLOSE_BAD_TOKEN);
                expect(peer.messages, `${role}${query}`).toEqual([]);
            }
        }
        expect(server.viewConnections()).toEqual({ senders: 0, watchers: 0 });
        const refusals = events.filter((event) => event.type === 'refused');
        expect(refusals).toHaveLength(6);
        expect(refusals.every((event) => event.type === 'refused' && event.reason === 'token')).toBe(true);
    });

    it('reads no more than 1 KiB from a socket it turned away for its token', async () => {
        // By hand, as in fileServer.test.ts: a real client answers the close
        // at once and the difference never shows.
        const raw = connectTcp(port, '127.0.0.1');
        raw.on('error', () => undefined);
        const upgraded = new Promise<string>((resolve) => raw.once('data', (data) => resolve(data.toString('latin1'))));
        raw.write(
            'GET /view?role=send&t=nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
        );
        expect(await upgraded).toMatch(/^HTTP\/1\.1 101/);
        const ended = new Promise<boolean>((resolve) => {
            raw.once('close', () => resolve(true));
            setTimeout(() => resolve(false), 1500);
        });
        raw.write(Buffer.concat([Buffer.from([0x81, 0xfe, 0x08, 0x00, 0, 0, 0, 0]), Buffer.alloc(2048, 0x78)]));
        expect(await ended).toBe(true);
        raw.destroy();
    });

    it('is the same token as /midi, and an unknown or missing role is closed with 4002', async () => {
        for (const role of ['', 'both', 'SEND']) {
            const { peer, accepted } = await view(role);
            expect(accepted && (await peer.closed), role).toBe(CLOSE_BAD_CLAIM);
        }
        const none = new Peer(new WebSocket(`ws://127.0.0.1:${port}/view?t=${TOKEN}`));
        await none.opened;
        expect(await none.closed).toBe(CLOSE_BAD_CLAIM);
        expect(events.filter((event) => event.type === 'refused' && event.reason === 'role')).toHaveLength(4);
    });
});

describe('who may watch', () => {
    it('a watcher from this computer is let in, as 127.0.0.1', async () => {
        const peer = await watcher();
        expect(peer.drain()).toEqual([{ hello: PROTOCOL_VERSION, version: '1.0.10-test', view: { role: 'watch', senders: 0 } }]);
        expect(server.viewConnections()).toEqual({ senders: 0, watchers: 1 });
    });

    it('a paired watcher from anywhere else is closed with 4007 and never counted', async () => {
        await server.close();
        ports.closeAll();
        boot({ remoteAddress: '192.168.1.77' });
        const { peer, accepted } = await view('watch');
        expect(accepted && (await peer.closed)).toBe(CLOSE_VIEW_NOT_LOCAL);
        expect(peer.messages).toEqual([]);
        expect(server.viewConnections()).toEqual({ senders: 0, watchers: 0 });
        expect(events).toContainEqual({ type: 'refused', reason: 'local', detail: 'unknown' });
        // The phone is exactly that: on the network, and allowed to send.
        const phone = await view('send', `&t=${TOKEN}&client=phone`);
        expect(phone.peer.drain()[0]).toMatchObject({ hello: 1, view: { role: 'send' } });
    });

    it('a watcher with no address to judge by is refused too', async () => {
        await server.close();
        ports.closeAll();
        boot({ remoteAddress: '' });
        const { peer, accepted } = await view('watch');
        expect(accepted && (await peer.closed)).toBe(CLOSE_VIEW_NOT_LOCAL);
    });

    it.each(['::1', '::ffff:127.0.0.1', '127.0.0.1', '127.1.2.3'])('a watcher that arrives as %s is from this computer', async (address) => {
        await server.close();
        ports.closeAll();
        boot({ remoteAddress: address });
        expect((await view('watch')).peer.drain()[0]).toMatchObject({ view: { role: 'watch' } });
    });

    const lan = Object.values(networkInterfaces())
        .flatMap((entries) => entries ?? [])
        .find((entry) => !entry.internal && entry.family === 'IPv4')?.address;
    it.skipIf(!lan)('a watcher that really dials this computer by its network address is refused, with no stand-in', async () => {
        const { peer, accepted } = await view('watch', `&t=${TOKEN}`, lan as string);
        expect(accepted && (await peer.closed)).toBe(CLOSE_VIEW_NOT_LOCAL);
        expect(server.viewConnections().watchers).toBe(0);
    });
});

describe('the senders and the watchers', () => {
    it('answers a sender with its hello, and the MIDI hello gains the view capability', async () => {
        const phone = await sender();
        expect(phone.drain()).toEqual([
            { hello: PROTOCOL_VERSION, version: '1.0.10-test', view: { role: 'send', watchers: 0, maxFrame: MAX_VIEW_FRAME_BYTES } },
        ]);
        const hello = (await midi()).drain()[0];
        expect(hello).toMatchObject({ hello: PROTOCOL_VERSION, claimed: null, view: { path: '/view', maxFrame: 4096, watchers: 0 } });
        const w = await watcher();
        w.drain();
        expect((await midi()).drain()[0]).toMatchObject({ view: { path: '/view', maxFrame: 4096, watchers: 1 } });
    });

    it('one sender: a newer one replaces the older, which is closed with 4005 and changes no count', async () => {
        const first = await sender('first');
        const w = await watcher();
        w.drain();
        const second = await sender('second');
        expect(await first.closed).toBe(CLOSE_VIEW_REPLACED);
        expect(server.viewConnections()).toEqual({ senders: 1, watchers: 1 });
        await settle();
        // The watcher was never told the phone left: there is still one.
        expect(w.drain()).toEqual([]);
        // Only the newer one's frames are forwarded.
        second.send(frame('snap'));
        await w.waitFor(1);
        expect(w.drain()).toEqual([JSON.parse(frame('snap'))]);
        // And the older one closing late (it was already gone) leaves it sending.
        expect(events.filter((event) => event.type === 'view' && event.senders === 0)).toEqual([]);
    });

    it(`${MAX_VIEW_WATCHERS} watchers, and the next is closed with 4004 until one leaves`, async () => {
        const watchers: Peer[] = [];
        for (let i = 0; i < MAX_VIEW_WATCHERS; i++) watchers.push(await watcher());
        const { peer, accepted } = await view('watch');
        expect(accepted && (await peer.closed)).toBe(CLOSE_BUSY);
        expect(events).toContainEqual({ type: 'refused', reason: 'view-busy', detail: 'unknown' });
        expect(server.viewConnections().watchers).toBe(MAX_VIEW_WATCHERS);

        watchers[0].close();
        await watchers[0].closed;
        await settle();
        expect((await watcher()).drain()[0]).toMatchObject({ view: { role: 'watch' } });
    });

    it('tells a watcher whether a phone is sending, in its hello and when that changes', async () => {
        const w = await watcher();
        expect(w.drain()[0]).toMatchObject({ view: { role: 'watch', senders: 0 } });
        const phone = await sender();
        await w.waitFor(1);
        expect(w.drain()).toEqual([sendersNotice(1)]);
        phone.close();
        await phone.closed;
        await w.waitFor(1);
        expect(w.drain()).toEqual([sendersNotice(0)]);
        const late = await watcher();
        expect(late.drain()[0]).toMatchObject({ view: { senders: 0 } });
    });
});

describe('forwarding', () => {
    it('hands every visible watcher the sender frame exactly as it came, in order', async () => {
        const phone = await sender();
        const a = await watcher();
        const b = await watcher();
        a.drain();
        b.drain();
        // Odd spacing and key order on purpose: it must not be re-serialized.
        const frames = ['{"t":"snap",  "board": {"b":1} }', '{"t":"p","x":[1,2],"lit":[60]}', '{"t":"alive"}', '{"t":"off"}', '{"t":"bye"}'];
        for (const text of frames) phone.send(text);
        await a.waitFor(frames.length);
        await b.waitFor(frames.length);
        expect(a.messages).toEqual(frames);
        expect(b.messages).toEqual(frames);
        // Nothing is echoed to the sender.
        await settle();
        expect(phone.messages.filter((text) => !text.includes('"view"'))).toEqual([]);
    });

    it('does not send to a hidden tab, and does not make up what it missed when it shows again', async () => {
        const phone = await sender();
        const a = await watcher();
        const b = await watcher();
        a.drain();
        b.drain();
        b.visible(false);
        await settle();
        phone.send(frame('p'));
        await a.waitFor(1);
        await settle();
        expect(b.drain()).toEqual([]);
        b.visible(true);
        await settle();
        // Nothing is kept to replay: it waits for the sender's resync.
        expect(b.drain()).toEqual([]);
        phone.send(frame('snap'));
        await b.waitFor(1);
        expect(b.drain()).toEqual([JSON.parse(frame('snap'))]);
    });

    it('drops what is not a mirror frame, and the sender stays open', async () => {
        const phone = await sender();
        const w = await watcher();
        w.drain();
        for (const text of ['not json', '[1,2]', '42', 'null', '{"x":1}', '{"t":"hello"}', '{"t":7}', '{"t":"snap"']) phone.send(text);
        phone.socket.send(Buffer.from('{"t":"snap"}'), { binary: true });
        phone.send(frame('alive'));
        await w.waitFor(1);
        expect(w.drain()).toEqual([JSON.parse(frame('alive'))]);
        expect(phone.socket.readyState).toBe(WebSocket.OPEN);
    });

    it('keeps no frame for a watcher that comes later: it gets its hello and nothing else', async () => {
        const phone = await sender();
        phone.send('{"t":"snap","board":"before"}');
        await settle();
        const late = await watcher();
        await settle();
        expect(late.drain()).toEqual([{ hello: PROTOCOL_VERSION, version: '1.0.10-test', view: { role: 'watch', senders: 1 } }]);
    });
});

describe('the caps', () => {
    it(`a sender frame of exactly ${MAX_VIEW_FRAME_BYTES} bytes goes through; one byte more closes it with 1009`, async () => {
        const phone = await sender();
        const w = await watcher();
        w.drain();
        const exact = frame('snap', MAX_VIEW_FRAME_BYTES);
        expect(Buffer.byteLength(exact)).toBe(MAX_VIEW_FRAME_BYTES);
        phone.send(exact);
        await w.waitFor(1);
        expect(w.messages[0]).toBe(exact);
        phone.send(frame('snap', MAX_VIEW_FRAME_BYTES + 1));
        expect(await phone.closed).toBe(1009);
        await settle();
        expect(server.viewConnections().senders).toBe(0);
    });

    it(`a watcher frame over ${MAX_WATCH_FRAME_BYTES} bytes closes it with 1009`, async () => {
        const w = await watcher();
        const ok = JSON.stringify({ visible: true, pad: 'x'.repeat(MAX_WATCH_FRAME_BYTES - 30) });
        w.send(ok);
        await settle();
        expect(w.socket.readyState).toBe(WebSocket.OPEN);
        w.send(JSON.stringify({ visible: true, pad: 'x'.repeat(MAX_WATCH_FRAME_BYTES) }));
        expect(await w.closed).toBe(1009);
    });

    it(`a sender over ${MAX_VIEW_FRAMES_PER_SECOND} frames a second is closed with 4008`, async () => {
        const phone = await sender();
        for (let i = 0; i <= MAX_VIEW_FRAMES_PER_SECOND; i++) phone.send(frame('p'));
        expect(await phone.closed).toBe(CLOSE_VIEW_RATE);
    });

    it(`a sender over ${MAX_VIEW_BYTES_PER_SECOND} bytes a second is closed with 4008, well under the frame cap`, async () => {
        const phone = await sender();
        const big = frame('snap', MAX_VIEW_FRAME_BYTES);
        const frames = Math.floor(MAX_VIEW_BYTES_PER_SECOND / MAX_VIEW_FRAME_BYTES) + 2;
        expect(frames).toBeLessThan(MAX_VIEW_FRAMES_PER_SECOND);
        for (let i = 0; i < frames; i++) phone.send(big);
        expect(await phone.closed).toBe(CLOSE_VIEW_RATE);
    });

    it('one pen at sixty frames a second is nowhere near the rate cap', async () => {
        const phone = await sender();
        const w = await watcher();
        w.drain();
        for (let i = 0; i < 60; i++) phone.send(frame('p'));
        await w.waitFor(60);
        expect(phone.socket.readyState).toBe(WebSocket.OPEN);
    });

    it(`a watcher over ${MAX_WATCH_FRAMES_PER_SECOND} frames a second is closed with 4008`, async () => {
        const w = await watcher();
        for (let i = 0; i <= MAX_WATCH_FRAMES_PER_SECOND; i++) w.visible(i % 2 === 0);
        expect(await w.closed).toBe(CLOSE_VIEW_RATE);
    });
});

describe('a slow watcher', () => {
    it('is closed with 4006 when it falls behind, and counted out, rather than a frame being skipped', async () => {
        const phone = await sender();
        const slow = await watcher();
        slow.drain();
        const monitor = await midi();
        monitor.drain();
        // Every frame up to the limit is delivered, in order.
        for (let i = 0; i < 5; i++) phone.send(JSON.stringify({ t: 'p', n: i }));
        await slow.waitFor(5);
        expect(slow.drain().map((message) => message.n)).toEqual([0, 1, 2, 3, 4]);
        // Then its queue is over the limit (the getter says so: a socket that
        // is not read cannot be made to queue 256 KB under the sender's own
        // rate cap, so the number is what is standing in for the network).
        const getter = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(VIEW_SLOW_BUFFER_BYTES + 1);
        phone.send(JSON.stringify({ t: 'p', n: 5 }));
        expect(await slow.closed).toBe(CLOSE_VIEW_TOO_SLOW);
        getter.mockRestore();
        expect(slow.messages).toEqual([]);
        await settle();
        expect(server.viewConnections().watchers).toBe(0);
        expect(monitor.drain()).toEqual([watchersNotice(0)]);
        // The sender is not closed for it, and a fresh watcher is welcome again.
        expect(phone.socket.readyState).toBe(WebSocket.OPEN);
        const fresh = await watcher();
        fresh.drain();
        phone.send(JSON.stringify({ t: 'p', n: 6 }));
        await fresh.waitFor(1);
        expect(fresh.drain()).toEqual([{ t: 'p', n: 6 }]);
    });
});

describe('what is told, and only when it changes', () => {
    it('the sender: hello, then a notice for each change, with a resync when a watcher arrives', async () => {
        const phone = await sender();
        expect(phone.drain()).toEqual([
            { hello: PROTOCOL_VERSION, version: '1.0.10-test', view: { role: 'send', watchers: 0, maxFrame: MAX_VIEW_FRAME_BYTES } },
        ]);
        const a = await watcher();
        const b = await watcher();
        a.visible(false);
        a.visible(false);
        a.send('{"visible":"no"}');
        await settle();
        a.visible(true);
        b.close();
        await b.closed;
        await settle();
        a.close();
        await a.closed;
        await settle();
        expect(phone.drain()).toEqual([
            watchersNotice(1, true),
            watchersNotice(2, true),
            watchersNotice(1),
            watchersNotice(2, true),
            watchersNotice(1),
            watchersNotice(0),
        ]);
    });

    it('a sender that arrives while watchers are there is asked for one snapshot after its hello', async () => {
        const a = await watcher();
        const b = await watcher();
        a.visible(false);
        await settle();
        const phone = await sender();
        await phone.waitFor(2);
        expect(phone.drain()).toEqual([
            { hello: PROTOCOL_VERSION, version: '1.0.10-test', view: { role: 'send', watchers: 1, maxFrame: MAX_VIEW_FRAME_BYTES } },
            watchersNotice(1, true),
        ]);
        b.close();
    });

    it('the /midi socket: one notice for each change of the count, never a repeat, never a resync', async () => {
        const monitor = await midi();
        monitor.drain();
        // A sender coming, going and sending changes no count.
        const phone = await sender();
        phone.send(frame('snap'));
        await settle();
        const a = await watcher();
        const b = await watcher();
        a.visible(false);
        a.visible(false);
        a.send('{"visible":"no"}');
        await settle();
        a.visible(true);
        b.close();
        await b.closed;
        await settle();
        a.close();
        await a.closed;
        phone.close();
        await settle();
        const frames = monitor.drain();
        expect(frames).toEqual([watchersNotice(1), watchersNotice(2), watchersNotice(1), watchersNotice(2), watchersNotice(1), watchersNotice(0)]);
        // What an older site does with a frame: only a numeric `hello` key is read as the hello.
        for (const message of frames) expect(typeof message.hello).not.toBe('number');
    });

    it('at rest nothing is written to a /midi socket after its hello', async () => {
        const monitor = await midi();
        monitor.drain();
        const phone = await sender();
        phone.send(frame('snap'));
        phone.close();
        await phone.closed;
        await sleep(250);
        expect(monitor.drain()).toEqual([]);
    });

    it('a tab that hides is not counted, and one that shows again is, with the sender asked to resync', async () => {
        const phone = await sender();
        phone.drain();
        const w = await watcher();
        await settle();
        w.visible(false);
        await settle();
        expect(server.viewConnections().watchers).toBe(1);
        const monitor = await midi();
        expect(monitor.drain()[0]).toMatchObject({ view: { watchers: 0 } });
        w.visible(true);
        await settle();
        expect(phone.drain()).toEqual([watchersNotice(1, true), watchersNotice(0), watchersNotice(1, true)]);
    });

    it('a watcher that closes is counted out at once', async () => {
        const w = await watcher();
        const monitor = await midi();
        expect(monitor.drain()[0]).toMatchObject({ view: { watchers: 1 } });
        w.close();
        await w.closed;
        await monitor.waitFor(1);
        expect(monitor.drain()).toEqual([watchersNotice(0)]);
    });

    it('a watcher that vanishes without closing is dropped by the ping, and counted out', async () => {
        await server.close();
        ports.closeAll();
        boot({ heartbeatMs: 150 });
        // Never answers a ping: a tab whose machine froze.
        const { peer } = await view('watch', `&t=${TOKEN}`, '127.0.0.1', { autoPong: false });
        const monitor = await midi();
        expect(monitor.drain()[0]).toMatchObject({ view: { watchers: 1 } });
        await monitor.waitFor(1);
        expect(monitor.drain()).toEqual([watchersNotice(0)]);
        expect(await peer.closed).toBe(1006);
        expect(server.viewConnections().watchers).toBe(0);
    });
});

describe('what is kept and what is printed', () => {
    it('no frame is handed to any hook, event or console, and the events carry counts only', async () => {
        const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
        const marker = 'SECRET-PAD-MARKER-4242';
        const phone = await sender('phone');
        const w = await watcher();
        w.drain();
        phone.send(JSON.stringify({ t: 'snap', board: marker }));
        phone.send(`{"t":"nope","board":"${marker}"}`);
        phone.send(`not json ${marker}`);
        await w.waitFor(1);
        expect(w.messages[0]).toContain(marker);
        phone.close();
        w.close();
        await Promise.all([phone.closed, w.closed]);
        await settle();

        expect(hookCalls).toEqual([]);
        expect(JSON.stringify(events)).not.toContain(marker);
        for (const event of events) {
            if (event.type === 'view') expect(Object.keys(event).sort()).toEqual(['senders', 'type', 'watchers']);
        }
        for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    });
});

describe('an old /midi client', () => {
    it('is unaffected: the hello keeps every field it had, MIDI still reaches the port, and an oversize frame still closes it', async () => {
        const w = await watcher();
        w.drain();
        const monitor = new Peer(new WebSocket(`ws://127.0.0.1:${port}/midi?t=${TOKEN}&port=staff&client=old`));
        await monitor.opened;
        await monitor.waitFor(1);
        const hello = monitor.drain()[0];
        expect(hello).toMatchObject({
            hello: PROTOCOL_VERSION,
            version: '1.0.10-test',
            platform: 'darwin',
            claimed: 'staff',
            portName: PORT_NAMES.staff,
            missing: [],
        });
        expect([...(hello.ports as string[])].sort()).toEqual([...ALL_PORT_NAMES].sort());
        monitor.send(JSON.stringify({ t: 0, b: [0x90, 60, 100] }));
        await settle();
        expect(outputs.filter((output) => output.opened === PORT_NAMES.staff).flatMap((output) => output.sent)).toEqual([[0x90, 60, 100]]);
        // Watchers joining and leaving never close or disturb it.
        const second = await watcher();
        second.close();
        await second.closed;
        await settle();
        expect(monitor.socket.readyState).toBe(WebSocket.OPEN);
        monitor.send('x'.repeat(4097));
        expect(await monitor.closed).toBe(1009);
    });

    it('still answers any other path with 400', async () => {
        for (const path of ['/views', '/view/', '/mid']) {
            const status = await new Promise<number | undefined>((resolve) => {
                const other = new WebSocket(`ws://127.0.0.1:${port}${path}?t=${TOKEN}&role=send`);
                other.on('unexpected-response', (_request, response) => resolve(response.statusCode));
                other.on('open', () => resolve(undefined));
                other.on('error', () => undefined);
            });
            expect(status, path).toBe(400);
        }
    });

    it('never gets a frame with a numeric hello key but its hello, whatever the view does', async () => {
        const monitor = await midi();
        const phone = await sender();
        const w = await watcher();
        phone.send(frame('snap'));
        w.visible(false);
        w.visible(true);
        w.close();
        phone.close();
        await settle();
        const all = monitor.messages.map((text) => JSON.parse(text) as Record<string, unknown>);
        expect(all.filter((message) => typeof message.hello === 'number')).toHaveLength(1);
        expect(typeof all[0].hello).toBe('number');
    });
});

describe('shutting down', () => {
    it('closes every view socket and resolves', async () => {
        const phone = await sender();
        const w = await watcher();
        await server.close();
        expect(await Promise.race([phone.closed, sleep(2000).then(() => 'open')])).not.toBe('open');
        expect(await Promise.race([w.closed, sleep(2000).then(() => 'open')])).not.toBe('open');
        boot();
    });
});
