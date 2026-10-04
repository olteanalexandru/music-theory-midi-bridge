// Sending a take to this PC, over a real socket into a real folder.
//
// The file path shares the MIDI path's port and token and nothing else: its
// own caps, its own refusals, and a folder it may not leave. These run the
// whole thing - `ws` on an ephemeral port, files on disk in a temporary
// folder - because what matters is what ends up where.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startServer, type RunningServer, type ServerEvent } from '../src/server.js';
import { openPorts, type MidiBackend, type MidiOutputPort } from '../src/ports.js';
import {
    ALL_PORT_NAMES,
    CLOSE_BAD_TOKEN,
    CLOSE_BUSY,
    FILE_CAPABILITIES,
    FILE_MAX_BYTES,
    FILES_PER_MINUTE,
    MAX_FILE_CONNECTIONS,
    MAX_FILE_PAYLOAD,
    MAX_FRAME_BYTES,
    PORT_NAMES,
    PROTOCOL_VERSION,
} from '../src/protocol.js';

// The smallest bytes each kind accepts (as in files.test.ts).
const MIDI = Buffer.from('MThd\0\0\0\x06\0\x01\0\x01\x01\x80', 'latin1');
const WAV = Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1');
const XML = Buffer.from('<?xml version="1.0"?><score-partwise/>', 'utf8');

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
let root: string;
let takes: string;
let outputs: FakeOutput[];
let ports: ReturnType<typeof openPorts>;
let events: ServerEvent[];

function boot(options: { takesDir?: string | null; fileIdleMs?: number } = {}) {
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
    events = [];
    server = startServer({
        port,
        token: TOKEN,
        ports,
        version: '1.0.8-test',
        platform: 'darwin',
        heartbeatMs: 0,
        takesDir: options.takesDir === null ? undefined : (options.takesDir ?? takes),
        fileIdleMs: options.fileIdleMs ?? 0,
        onEvent: (event) => events.push(event),
    });
}

/** A file socket that queues what it is told, so a test can await each reply in turn. */
class FileClient {
    private readonly inbox: Record<string, unknown>[] = [];
    private readonly waiting: ((message: Record<string, unknown>) => void)[] = [];
    readonly opened: Promise<void>;
    readonly closed: Promise<number>;

    constructor(readonly socket: WebSocket) {
        socket.on('message', (data) => {
            const message = JSON.parse(data.toString()) as Record<string, unknown>;
            const waiter = this.waiting.shift();
            if (waiter) waiter(message);
            else this.inbox.push(message);
        });
        socket.on('error', () => undefined);
        this.closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
        this.opened = new Promise((resolve) => {
            socket.once('open', () => resolve());
            socket.once('close', () => resolve());
        });
    }

    next(): Promise<Record<string, unknown>> {
        const message = this.inbox.shift();
        if (message) return Promise.resolve(message);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no reply')), 4000);
            this.waiting.push((value) => {
                clearTimeout(timer);
                resolve(value);
            });
        });
    }

    /** Header, then body - the two steps of one take. */
    send(name: string, body: Buffer, size = body.length): void {
        this.socket.send(JSON.stringify({ name, size }));
        this.socket.send(body, { binary: true });
    }

    async save(name: string, body: Buffer): Promise<Record<string, unknown>> {
        this.send(name, body);
        return this.next();
    }
}

/** Opens /file and waits for its hello (or its close). */
async function openFile(query = `?t=${TOKEN}&client=phone`): Promise<{ client: FileClient; hello?: Record<string, unknown> }> {
    const client = new FileClient(new WebSocket(`ws://127.0.0.1:${port}/file${query}`));
    const hello = await Promise.race([client.next(), client.closed.then(() => undefined)]);
    return { client, hello };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bridge-file-'));
    takes = join(root, 'Note Noodle', 'Takes');
    boot();
});

afterEach(async () => {
    await server.close();
    ports.closeAll();
    rmSync(root, { recursive: true, force: true });
});

describe('the token', () => {
    it('is required: a wrong one or none is closed with 4001, and nothing is written', async () => {
        for (const query of ['?t=nope', '', `?t=${TOKEN.slice(0, 6)}`]) {
            const { client, hello } = await openFile(query);
            expect(hello, query).toBeUndefined();
            expect(await client.closed, query).toBe(CLOSE_BAD_TOKEN);
        }
        expect(server.fileConnections()).toBe(0);
        expect(existsSync(takes)).toBe(false);
        expect(events.filter((event) => event.type === 'refused').map((event) => event.type === 'refused' && event.reason)).toEqual([
            'token',
            'token',
            'token',
        ]);
    });

    it('lets the right one in, with a hello that states the caps', async () => {
        const { hello } = await openFile();
        expect(hello).toEqual({ hello: PROTOCOL_VERSION, version: '1.0.8-test', files: FILE_CAPABILITIES });
        expect(server.fileConnections()).toBe(1);
    });
});

describe('saving a take', () => {
    it('writes the bytes into the takes folder, made on the first save, and says the name', async () => {
        const { client } = await openFile();
        expect(await client.save('staff-120bpm-12notes.mid', MIDI)).toEqual({ saved: 'staff-120bpm-12notes.mid', bytes: MIDI.length });
        expect(readFileSync(join(takes, 'staff-120bpm-12notes.mid'))).toEqual(MIDI);
        expect(events).toContainEqual({ type: 'file-saved', fileId: 1, client: 'phone', name: 'staff-120bpm-12notes.mid', bytes: MIDI.length });
    });

    it('takes every kind it lists', async () => {
        const { client } = await openFile();
        expect(await client.save('a.midi', MIDI)).toMatchObject({ saved: 'a.midi' });
        expect(await client.save('a.musicxml', XML)).toMatchObject({ saved: 'a.musicxml' });
        expect(await client.save('a.xml', XML)).toMatchObject({ saved: 'a.xml' });
        expect(await client.save('a.wav', WAV)).toMatchObject({ saved: 'a.wav' });
    });

    it('never overwrites: the same name again is saved as (2)', async () => {
        const { client } = await openFile();
        const other = Buffer.concat([MIDI, Buffer.from([1, 2, 3])]);
        expect(await client.save('take.mid', MIDI)).toMatchObject({ saved: 'take.mid' });
        expect(await client.save('take.mid', other)).toMatchObject({ saved: 'take (2).mid' });
        expect(readFileSync(join(takes, 'take.mid'))).toEqual(MIDI);
        expect(readFileSync(join(takes, 'take (2).mid'))).toEqual(other);
    });

    it('answers in the order the takes were sent', async () => {
        const { client } = await openFile();
        client.send('a.mid', MIDI);
        client.send('nope.exe', MIDI);
        client.send('b.wav', WAV);
        expect(await client.next()).toMatchObject({ saved: 'a.mid' });
        expect(await client.next()).toEqual({ error: 'bad-extension' });
        expect(await client.next()).toMatchObject({ saved: 'b.wav' });
    });
});

describe('the folder it may not leave', () => {
    it('refuses traversal and absolute paths, and drops their bodies unread', async () => {
        const { client } = await openFile();
        for (const name of ['../escape.mid', '..\\escape.mid', '/tmp/escape.mid', 'C:\\Users\\Public\\escape.mid', 'C:escape.mid', 'sub/escape.mid']) {
            // The body that follows is dropped, not answered: the next reply is the next take's.
            client.send(name, MIDI);
            expect(await client.next(), name).toEqual({ error: 'bad-name' });
        }
        expect(await client.save('fine.mid', MIDI)).toMatchObject({ saved: 'fine.mid' });
        expect(readdirSync(takes)).toEqual(['fine.mid']);
        expect(readdirSync(join(root, 'Note Noodle'))).toEqual(['Takes']);
        expect(readdirSync(root)).toEqual(['Note Noodle']);
    });

    it('renames a Windows device name rather than writing to the device', async () => {
        const { client } = await openFile();
        expect(await client.save('NUL.mid', MIDI)).toMatchObject({ saved: '_NUL.mid' });
        expect(await client.save('com1.wav', WAV)).toMatchObject({ saved: '_com1.wav' });
        expect(readdirSync(takes).sort()).toEqual(['_NUL.mid', '_com1.wav']);
    });

    it('keeps a Romanian name, composed', async () => {
        const { client } = await openFile();
        expect(await client.save('Piesa\u0306 în Do.mid', MIDI)).toMatchObject({ saved: 'Piesă în Do.mid' });
        expect(readdirSync(takes).map((name) => name.normalize('NFC'))).toEqual(['Piesă în Do.mid']);
    });

    it('refuses a name a terminal would act on, and quotes it escaped', async () => {
        const { client } = await openFile('?t=' + TOKEN + '&client=' + encodeURIComponent('\u001b]52;c;x\u0007'));
        client.send('take\u001b[2J.mid', MIDI);
        expect(await client.next()).toEqual({ error: 'bad-name' });
        const refusal = events.find((event) => event.type === 'file-refused');
        expect(refusal).toMatchObject({ code: 'bad-name', detail: 'take\\x1b[2J.mid', client: '\\x1b]52;c;x\\x07' });
        expect(JSON.stringify(events)).not.toContain('\u001b');
    });
});

describe('what it will not take', () => {
    it('only the five kinds', async () => {
        const { client } = await openFile();
        for (const name of ['take.exe', 'take.html', 'take.mxl', 'take']) {
            client.send(name, MIDI);
            expect(await client.next(), name).toEqual({ error: 'bad-extension' });
        }
        expect(existsSync(takes)).toBe(false);
    });

    it('a MIDI or MusicXML file over 2 MiB, or a WAV over 32 MiB, refused at the header', async () => {
        const { client } = await openFile();
        client.socket.send(JSON.stringify({ name: 'big.mid', size: FILE_MAX_BYTES.mid + 1 }));
        expect(await client.next()).toEqual({ error: 'too-large', max: 2 * 1024 * 1024 });
        client.socket.send(JSON.stringify({ name: 'big.musicxml', size: FILE_MAX_BYTES.musicxml + 1 }));
        expect(await client.next()).toEqual({ error: 'too-large', max: 2 * 1024 * 1024 });
        client.socket.send(JSON.stringify({ name: 'big.wav', size: FILE_MAX_BYTES.wav + 1 }));
        expect(await client.next()).toEqual({ error: 'too-large', max: 32 * 1024 * 1024 });
    });

    it('a message over 32 MiB at all: `ws` closes with 1009 before reading it', async () => {
        const { client } = await openFile();
        client.socket.send(Buffer.alloc(MAX_FILE_PAYLOAD + 1), { binary: true });
        expect(await client.closed).toBe(1009);
        await settle();
        expect(events).toContainEqual(expect.objectContaining({ type: 'file-refused', code: 'too-large' }));
    });

    it('a body that is not the size the header said, or not the kind of file the name says', async () => {
        const { client } = await openFile();
        client.send('short.mid', MIDI, MIDI.length + 1);
        expect(await client.next()).toEqual({ error: 'size-mismatch' });
        expect(await client.save('fake.mid', WAV)).toEqual({ error: 'bad-content' });
        expect(await client.save('fake.wav', MIDI)).toEqual({ error: 'bad-content' });
        expect(await client.save('fake.xml', MIDI)).toEqual({ error: 'bad-content' });
        expect(existsSync(takes)).toBe(false);
    });

    it('a body with no header, a header that is not one, and an empty file', async () => {
        const { client } = await openFile();
        client.socket.send(MIDI, { binary: true });
        expect(await client.next()).toEqual({ error: 'no-header' });
        client.socket.send('not json');
        expect(await client.next()).toEqual({ error: 'bad-header' });
        client.socket.send(JSON.stringify({ name: 'take.mid', size: 0 }));
        expect(await client.next()).toEqual({ error: 'empty' });
    });

    it(`more than ${FILES_PER_MINUTE} takes a minute on one connection, refused ones included`, async () => {
        const { client } = await openFile();
        for (let i = 0; i < FILES_PER_MINUTE; i++) {
            client.send(`t${i}.exe`, MIDI);
            expect(await client.next()).toEqual({ error: 'bad-extension' });
        }
        expect(await client.save('one-too-many.mid', MIDI)).toEqual({ error: 'rate-limited' });
    });

    it('counts bodies sent with no header against the same limit', async () => {
        const { client } = await openFile();
        for (let i = 0; i < FILES_PER_MINUTE; i++) {
            client.socket.send(MIDI, { binary: true });
            expect(await client.next()).toEqual({ error: 'no-header' });
        }
        client.socket.send(MIDI, { binary: true });
        expect(await client.next()).toEqual({ error: 'rate-limited' });
    });

    it('reads no more than 1 KiB from a socket it turned away for its token', async () => {
        // By hand, because a real client answers the close at once and the
        // difference would never show: with the 32 MiB cap, a refused socket
        // that keeps sending is read for up to 30 s; with 1 KiB it is ended
        // on the first larger message.
        const raw = connectTcp(port, '127.0.0.1');
        raw.on('error', () => undefined);
        const upgraded = new Promise<string>((resolve) => raw.once('data', (data) => resolve(data.toString('latin1'))));
        raw.write(
            'GET /file?t=nope HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
        );
        expect(await upgraded).toMatch(/^HTTP\/1\.1 101/);
        const ended = new Promise<boolean>((resolve) => {
            raw.once('close', () => resolve(true));
            setTimeout(() => resolve(false), 1500);
        });
        // A masked text frame of 2048 bytes (the mask is zero, so the payload is as written).
        raw.write(Buffer.concat([Buffer.from([0x81, 0xfe, 0x08, 0x00, 0, 0, 0, 0]), Buffer.alloc(2048, 0x78)]));
        expect(await ended).toBe(true);
        raw.destroy();
    });

    it(`more than ${MAX_FILE_CONNECTIONS} file sockets at once`, async () => {
        const open = [];
        for (let i = 0; i < MAX_FILE_CONNECTIONS; i++) open.push((await openFile()).client);
        const { client, hello } = await openFile();
        expect(hello).toBeUndefined();
        expect(await client.closed).toBe(CLOSE_BUSY);
        expect(events).toContainEqual({ type: 'refused', reason: 'busy', detail: 'phone' });

        open[0].socket.close();
        await open[0].closed;
        await settle();
        expect((await openFile()).hello).toMatchObject({ files: FILE_CAPABILITIES });
    });

    it('a socket that has sent nothing for the idle time is closed', async () => {
        await server.close();
        boot({ fileIdleMs: 120 });
        const { client } = await openFile();
        expect(await client.closed).toBe(1006);
        await settle();
        expect(server.fileConnections()).toBe(0);
    });
});

describe('the rate limit, shared by every file socket', () => {
    // The app opens a new /file socket for every file it sends, so a limit
    // kept per socket would never be reached by the real client.
    afterEach(() => {
        vi.useRealTimers();
    });

    /** One take over its own socket, closed after the reply - as the app sends it. */
    async function saveAlone(name: string, body: Buffer): Promise<Record<string, unknown>> {
        const { client } = await openFile();
        const reply = await client.save(name, body);
        client.socket.close();
        await client.closed;
        return reply;
    }

    it(`refuses take ${FILES_PER_MINUTE + 1} inside a minute, each over its own socket, and writes nothing for it`, async () => {
        for (let i = 0; i < FILES_PER_MINUTE; i++) {
            expect(await saveAlone(`take-${i}.mid`, MIDI)).toMatchObject({ saved: `take-${i}.mid` });
        }
        expect(await saveAlone('one-too-many.mid', MIDI)).toEqual({ error: 'rate-limited' });
        await settle();
        expect(readdirSync(takes)).toHaveLength(FILES_PER_MINUTE);
        expect(existsSync(join(takes, 'one-too-many.mid'))).toBe(false);
        expect(events).toContainEqual(expect.objectContaining({ type: 'file-refused', code: 'rate-limited' }));
    });

    it('counts across sockets open at the same time', async () => {
        const first = (await openFile()).client;
        const second = (await openFile()).client;
        for (let i = 0; i < FILES_PER_MINUTE; i++) {
            const client = i % 2 === 0 ? first : second;
            client.send(`t${i}.exe`, MIDI);
            expect(await client.next()).toEqual({ error: 'bad-extension' });
        }
        expect(await first.save('late.mid', MIDI)).toEqual({ error: 'rate-limited' });
        expect(await second.save('later.mid', MIDI)).toEqual({ error: 'rate-limited' });
        await settle();
        expect(existsSync(takes) ? readdirSync(takes) : []).toEqual([]);
    });

    it('slides: a take is allowed again a minute after the oldest, not before', async () => {
        await server.close();
        ports.closeAll();
        // Only Date is faked: the sockets and the test's own waits keep real timers.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
        boot();
        expect(await saveAlone('first.mid', MIDI)).toMatchObject({ saved: 'first.mid' });
        vi.setSystemTime(new Date('2026-10-04T12:00:30Z'));
        for (let i = 1; i < FILES_PER_MINUTE; i++) {
            expect(await saveAlone(`take-${i}.mid`, MIDI)).toMatchObject({ saved: `take-${i}.mid` });
        }
        // 59.999 s after the first: all ten still inside the window.
        vi.setSystemTime(new Date('2026-10-04T12:00:59.999Z'));
        expect(await saveAlone('too-soon.mid', MIDI)).toEqual({ error: 'rate-limited' });
        // A minute after the first: it has left the window, the other nine have not.
        vi.setSystemTime(new Date('2026-10-04T12:01:00Z'));
        expect(await saveAlone('room-again.mid', MIDI)).toMatchObject({ saved: 'room-again.mid' });
        expect(await saveAlone('full-again.mid', MIDI)).toEqual({ error: 'rate-limited' });
        // A minute after the nine: all of them gone.
        vi.setSystemTime(new Date('2026-10-04T12:01:30Z'));
        expect(await saveAlone('after.mid', MIDI)).toMatchObject({ saved: 'after.mid' });
        await settle();
        const written = readdirSync(takes);
        expect(written).toHaveLength(FILES_PER_MINUTE + 2);
        expect(written).not.toContain('too-soon.mid');
        expect(written).not.toContain('full-again.mid');
    });

    it('is one per run: a restarted bridge starts afresh', async () => {
        for (let i = 0; i < FILES_PER_MINUTE; i++) {
            expect(await saveAlone(`take-${i}.mid`, MIDI)).toMatchObject({ saved: `take-${i}.mid` });
        }
        expect(await saveAlone('refused.mid', MIDI)).toEqual({ error: 'rate-limited' });
        await server.close();
        ports.closeAll();
        boot();
        expect(await saveAlone('fresh.mid', MIDI)).toMatchObject({ saved: 'fresh.mid' });
    });

    it('leaves the MIDI path alone', async () => {
        for (let i = 0; i < FILES_PER_MINUTE; i++) {
            expect(await saveAlone(`take-${i}.mid`, MIDI)).toMatchObject({ saved: `take-${i}.mid` });
        }
        const socket = new WebSocket(`ws://127.0.0.1:${port}/midi?t=${TOKEN}&port=staff`);
        const hello = await new Promise<Record<string, unknown>>((resolve, reject) => {
            socket.on('error', reject);
            socket.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
        });
        // The hello still states the limit it now keeps.
        expect(hello.files).toEqual(FILE_CAPABILITIES);
        expect(FILE_CAPABILITIES.perMinute).toBe(FILES_PER_MINUTE);
        for (let i = 0; i < FILES_PER_MINUTE + 5; i++) socket.send(JSON.stringify({ t: i, b: [0x90, 60, 100] }));
        await settle();
        const sent = outputs.filter((output) => output.opened === PORT_NAMES.staff).flatMap((output) => output.sent);
        expect(sent).toHaveLength(FILES_PER_MINUTE + 5);
        socket.close();
    });
});


describe('the MIDI path beside it', () => {
    /** A MIDI socket, resolved with its hello. */
    function midi(query: string): Promise<{ socket: WebSocket; hello: Record<string, unknown> }> {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}/midi${query}`);
            socket.on('error', reject);
            socket.once('message', (data) => resolve({ socket, hello: JSON.parse(data.toString()) }));
        });
    }

    it('offers the file path in its hello', async () => {
        const { hello, socket } = await midi(`?t=${TOKEN}&port=staff`);
        expect(hello.files).toEqual(FILE_CAPABILITIES);
        socket.close();
    });

    it('offers nothing, and serves no /file, when there is no takes folder', async () => {
        await server.close();
        boot({ takesDir: null });
        const { hello, socket } = await midi(`?t=${TOKEN}&port=staff`);
        expect(hello).not.toHaveProperty('files');
        socket.close();
        const status = await new Promise<number | undefined>((resolve) => {
            const file = new WebSocket(`ws://127.0.0.1:${port}/file?t=${TOKEN}`);
            file.on('unexpected-response', (_request, response) => resolve(response.statusCode));
            file.on('open', () => resolve(undefined));
            file.on('error', () => undefined);
        });
        expect(status).toBe(400);
    });

    it('still refuses a frame over its own 4096 bytes with 1009', async () => {
        const { socket } = await midi(`?t=${TOKEN}&port=staff`);
        const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
        socket.send('x'.repeat(MAX_FRAME_BYTES + 1));
        expect(await closed).toBe(1009);
    });

    it('still forwards MIDI to the claimed port', async () => {
        const { socket } = await midi(`?t=${TOKEN}&port=staff`);
        socket.send(JSON.stringify({ t: 0, b: [0x90, 60, 100] }));
        await settle();
        const sent = outputs.filter((output) => output.opened === PORT_NAMES.staff).flatMap((output) => output.sent);
        expect(sent).toEqual([[0x90, 60, 100]]);
        socket.close();
    });

    it('still answers any other path with 400, and a plain request with 426', async () => {
        const status = await new Promise<number | undefined>((resolve) => {
            const other = new WebSocket(`ws://127.0.0.1:${port}/files?t=${TOKEN}`);
            other.on('unexpected-response', (_request, response) => resolve(response.statusCode));
            other.on('open', () => resolve(undefined));
            other.on('error', () => undefined);
        });
        expect(status).toBe(400);
        const plain = await new Promise<number | undefined>((resolve, reject) => {
            const request = httpRequest({ host: '127.0.0.1', port, path: '/midi' }, (response) => {
                response.resume();
                resolve(response.statusCode);
            });
            request.on('error', reject);
            request.end();
        });
        expect(plain).toBe(426);
    });
});
