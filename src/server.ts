// The WebSocket server: bytes in, MIDI port out.
//
// Deliberately the dumbest part of this program. It checks a token, works out
// which port a socket claimed, and writes `b` to it. Nothing here interprets
// MIDI, and that is the whole reason MPE survives the trip - the app's
// MidiSender produces the member channels, the MPE Configuration Message and
// the per-note bends, and this passes them through without an opinion.
//
// One socket is one instrument is one port is one Ableton track. The app opens
// a separate connection per instrument because it already builds a separate
// MidiSender and MidiBridge per instrument, so the claim rides on the URL and
// nothing has to be multiplexed.
//
// The one exception to "no opinion": when a socket closes, for any reason, it
// ends what that socket left sounding (heldNotes.ts). A socket that dies
// mid-note never gets to send its note-offs, and nothing else would.
//
// And a socket that dies WITHOUT closing - a phone out of Wi-Fi range, a
// battery gone flat - is found by the heartbeat below and closed here, so
// that release reaches it too.
//
// Since 1.0.8 the same port also answers FILE_WS_PATH, where a paired client
// sends a take to be written into the takes folder (files.ts). That is a
// second WebSocketServer behind one HTTP server, so the MIDI path keeps its
// own MAX_FRAME_BYTES and nothing about it changes.

import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { createServer, STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
    CLOSE_BAD_CLAIM,
    CLOSE_BAD_TOKEN,
    CLOSE_BUSY,
    CLOSE_NO_PORT,
    DEFAULT_PORT_NAME,
    FILE_CAPABILITIES,
    FILE_WS_PATH,
    FILES_PER_MINUTE,
    MAX_FILE_CONNECTIONS,
    MAX_FILE_PAYLOAD,
    MAX_FRAME_BYTES,
    PORT_NAMES,
    PROTOCOL_VERSION,
    REFUSED_MAX_PAYLOAD,
    WS_PATH,
    isClaim,
    parseFileHeader,
    parseMessageDetailed,
    type Claim,
    type FileErrorCode,
    type FileHelloMessage,
    type FileReply,
    type HelloMessage,
    type TakeExtension,
} from './protocol.js';
import type { PortSet } from './ports.js';
import { HeldNotes } from './heldNotes.js';
import { RateLimiter, cleanTakeName, looksLike, maxBytesFor, saveTake } from './files.js';

export interface ServerOptions {
    port: number;
    /**
     * The interface to listen on. Absent means every interface, which is the
     * default on purpose: the phone may arrive over Wi-Fi or over a USB tether,
     * and those are two different addresses on this machine. Pass one to shut
     * the other out.
     */
    bind?: string;
    /** Rejected without it. See the note on why a LAN service needs one. */
    token: string;
    ports: PortSet;
    version: string;
    platform: string;
    /** Told about every connect, disconnect and refusal, for the console. */
    onEvent?: (event: ServerEvent) => void;
    /**
     * Told about every frame after it has been written to the port - for
     * --log-midi, which decodes it. After, so a slow console can never delay
     * a note, and only when somebody asked: absent, nothing per message is
     * built at all.
     */
    onMessage?: (info: MessageInfo) => void;
    /** Told about every frame that was not forwarded, and why. */
    onDrop?: (info: DropInfo) => void;
    /** Told when an accepted connection closes, so a log can sum it up. */
    onConnectionClose?: (info: ConnectionCloseInfo) => void;
    /**
     * How often to ping every accepted connection, in ms - see HEARTBEAT_MS.
     * A parameter so a test can run it in milliseconds rather than seconds;
     * 0 turns it off.
     */
    heartbeatMs?: number;
    /**
     * The folder FILE_WS_PATH writes takes into, absolute (files.ts works it
     * out from --takes-dir). Absent, the path is not served at all and the
     * hello offers no `files` - which is what every test that is not about
     * files gets, so none of them can write into a real Documents folder.
     */
    takesDir?: string;
    /**
     * How long a FILE_WS_PATH socket may receive nothing at all before it is
     * closed - see FILE_IDLE_MS. A parameter for the same reason heartbeatMs is.
     */
    fileIdleMs?: number;
}

/**
 * How long a file socket may go without a single byte arriving.
 *
 * Not the heartbeat. A 32 MiB WAV over a slow Wi-Fi link is one WebSocket
 * message that can take longer than the heartbeat's twenty seconds, and a
 * browser cannot slip a pong into the middle of it - so pings would drop
 * exactly the uploads that are working. Bytes arriving is the sign of life
 * instead, and a socket that has had none for a minute is gone or forgotten
 * and is holding one of MAX_FILE_CONNECTIONS.
 */
export const FILE_IDLE_MS = 60_000;

/**
 * How often each connection is pinged.
 *
 * *** A PHONE THAT VANISHES SAYS NOTHING. ***
 *
 * Out of Wi-Fi range, battery flat, the app killed by the OS: no close frame
 * is ever sent, and this server writes nothing after `hello`, so nothing
 * here would ever fail and the socket stayed "open" - with every note it had
 * started still sounding in the DAW - until Ctrl+C. A ping is a write, so it
 * is what finds out.
 *
 * Browsers answer pings on their own, below the page: nothing in the app has
 * to do anything, and a tab that is busy, backgrounded or throttled still
 * answers, because its network stack is not.
 *
 * Ten seconds is long enough to cost nothing (a few bytes per connection) and
 * short enough that a vanished phone's notes stop within half a minute.
 */
export const HEARTBEAT_MS = 10_000;

/**
 * Pings that may go unanswered in a row before the socket is terminated.
 *
 * Two rather than one, so one ping lost on a busy network is not a
 * disconnection. A phone that is really gone is therefore dropped between
 * 20 and 30 s after it went (two intervals, plus however far into the first
 * one it vanished).
 */
export const MISSED_PONGS_ALLOWED = 2;

export type ServerEvent =
    | { type: 'connected'; claim: Claim | null; portName: string; client: string; connId: number }
    /**
     * `ended`: how many notes that connection left held, which the close just
     * sent NoteOffs for. `timedOut`: the bridge closed it itself, because it
     * stopped answering pings - see HEARTBEAT_MS.
     */
    | { type: 'disconnected'; claim: Claim | null; portName: string; connId: number; ended: number; timedOut: boolean }
    /** `busy`: FILE_WS_PATH only, MAX_FILE_CONNECTIONS already open. */
    | { type: 'refused'; reason: 'token' | 'claim' | 'port' | 'busy'; detail: string }
    /** A take written into the takes folder, under `name` (printable already). */
    | { type: 'file-saved'; fileId: number; client: string; name: string; bytes: number }
    /** A take that was not, and why; `detail` is the name or header asked for, printable. */
    | { type: 'file-refused'; fileId: number; client: string; code: FileErrorCode; detail: string };

/**
 * One forwarded frame, with everything the server knows about it.
 *
 * `connId` numbers accepted connections from 1 for the life of the process.
 * The port name is not enough to tell sockets apart: two devices really can
 * claim one port (see inUse), and each has its own allocator and its own MCM.
 */
export interface MessageInfo {
    connId: number;
    portName: string;
    claim: Claim | null;
    client: string;
    /** The frame's own t: ms since the socket opened, on the sender's clock. */
    t: number;
    bytes: number[];
    /**
     * performance.now() here when this frame arrived, and when its socket was
     * accepted - taken first thing in the handler, before the port is
     * re-opened, because on Windows that re-open takes tens of milliseconds
     * the phone's clock has already started counting.
     */
    receivedAt: number;
    openedAt: number;
}

export interface DropInfo {
    connId: number;
    portName: string;
    reason: string;
    /** The frame as text, when there was one to read. */
    raw?: string;
}

export interface ConnectionCloseInfo {
    connId: number;
    portName: string;
    claim: Claim | null;
    client: string;
    openedAt: number;
    closedAt: number;
    /** The WebSocket close code; 1009 is a frame over MAX_FRAME_BYTES. */
    code: number;
    /**
     * Terminated by the heartbeat: the other end stopped answering pings
     * (HEARTBEAT_MS). `code` is then 1006, which on its own reads as any
     * dropped network - this says the bridge is the one that noticed.
     */
    timedOut: boolean;
    /**
     * What the close wrote to the port to end what this connection left
     * sounding (see HeldNotes.releaseMessages), already sent by the time this
     * is reported. Empty when there was nothing to end, and while the whole
     * server is shutting down - the caller's own panic covers every channel
     * then.
     */
    released: number[][];
}

/**
 * Runs an observer without letting it break forwarding.
 *
 * These hooks are diagnostics. A bug in one must cost a log line, never the
 * note after it.
 */
function observe<T>(hook: ((info: T) => void) | undefined, info: T): void {
    if (!hook) return;
    try {
        hook(info);
    } catch {
        // Deliberately nothing: see above.
    }
}

/** The most of a client's own label, or of a claim it was refused, that is ever printed. */
export const MAX_CLIENT_LABEL = 64;

/** The most of a dropped frame that is quoted - midiLog's own cap for its file. */
export const MAX_RAW_QUOTE = 256;

/**
 * Controls (C0, DEL and C1), format characters (the bidi overrides and
 * isolates, zero-width marks, the BOM), line and paragraph separators, and
 * lone surrogates. Everything a terminal acts on rather than shows.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/**
 * A string that came off the network, made safe to put in a terminal.
 *
 * `client`, a refused claim and a dropped frame all reach console.log, and
 * the first two arrive BEFORE the token is checked - so anyone who can reach
 * the port could print to this terminal: `?client=%1B%5D52%3Bc%3B...%07` set
 * the operator's clipboard through OSC 52, `%1B%5B2J` wiped the screen for a
 * forged banner or QR code, and `%0A` forged whole log lines. Each of those
 * is now shown as its escape (`\x1b`), never acted on, so a strange label
 * still reads as strange rather than vanishing. Capped too, because the
 * header limit is about 16 KB and a label is a word or two.
 *
 * Done once, where the value is read, so every reader - the console, the
 * MIDI log and its file - gets the same clean string.
 */
export function printable(value: string, max: number): string {
    let out = '';
    // Counted in what is PRINTED, escapes included, so `max` bounds the line.
    let shown = 0;
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        const escape = !UNPRINTABLE.test(char)
            ? null
            : code <= 0xff
              ? `\\x${code.toString(16).padStart(2, '0')}`
              : `\\u{${code.toString(16)}}`;
        const width = escape ? escape.length : 1;
        if (shown + width > max) return `${out}…`;
        out += escape ?? char;
        shown += width;
    }
    return out;
}

/**
 * The drop reason for a frame `ws` refused as invalid WebSocket.
 *
 * ws builds the message from fixed text and numbers (an opcode, a close
 * code), so today no client can put a character into it. It goes through
 * printable anyway, because it is printed beside strings that can, and the
 * day a ws release quotes the frame it read, this is the line that would
 * carry it. A function of its own so a test can hold it to that.
 */
export function invalidFrameReason(message: string): string {
    return printable(`invalid WebSocket frame, connection closed (${message})`, MAX_RAW_QUOTE);
}

export interface RunningServer {
    close(): Promise<void>;
    /** Open MIDI sockets, for tests and for the banner. */
    connections(): number;
    /** Open FILE_WS_PATH sockets. */
    fileConnections(): number;
}

/** The path of a request URL, compared exactly as `ws` compares its own `path`. */
function pathOf(url: string | undefined): string {
    const value = url ?? '';
    const query = value.indexOf('?');
    return query === -1 ? value : value.slice(0, query);
}

/** A message as one Buffer, whatever shape `ws` handed it over in. */
function toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}

/** The most of a requested file name or header that is quoted in the console. */
export const MAX_NAME_QUOTE = 128;

/**
 * Constant-time-ish comparison for the token.
 *
 * Not because a timing attack on a LAN MIDI bridge is a realistic threat, but
 * because writing `a === b` here invites the next person to assume the token is
 * decorative. It is the only thing standing between a shared network and
 * somebody else's DAW.
 */
function tokensMatch(given: string, expected: string): boolean {
    if (given.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
}

export function startServer(options: ServerOptions): RunningServer {
    // The HTTP server `ws` used to make for itself, made here so a second
    // path can share the port. A plain request gets what `ws` answered it
    // with, 426 Upgrade Required.
    const http = createServer((_request, response) => {
        const body = STATUS_CODES[426] ?? 'Upgrade Required';
        response.writeHead(426, { 'Content-Length': body.length, 'Content-Type': 'text/plain' });
        response.end(body);
    });
    // maxPayload: a frame past it is refused by `ws` itself (close 1009) before
    // it is buffered - see MAX_FRAME_BYTES.
    const wss = new WebSocketServer({ noServer: true, path: WS_PATH, maxPayload: MAX_FRAME_BYTES });
    // Its own cap, and only when there is a folder to write into.
    const takesDir = options.takesDir;
    const files = takesDir ? new WebSocketServer({ noServer: true, path: FILE_WS_PATH, maxPayload: MAX_FILE_PAYLOAD }) : null;
    // Where a file socket that is turned away is sent to be closed: it reads
    // no more than REFUSED_MAX_PAYLOAD, so the 32 MiB cap above is only ever
    // open to somebody holding the token.
    const refuser = new WebSocketServer({ noServer: true, maxPayload: REFUSED_MAX_PAYLOAD });
    const report = options.onEvent ?? (() => undefined);
    const fileIdleMs = options.fileIdleMs ?? FILE_IDLE_MS;
    let lastFileId = 0;

    http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (files && pathOf(request.url) === FILE_WS_PATH) {
            const url = new URL(request.url ?? FILE_WS_PATH, 'http://localhost');
            const client = printable(url.searchParams.get('client') ?? 'unknown', MAX_CLIENT_LABEL);
            const refuse = (code: number, reason: string) =>
                refuser.handleUpgrade(request, socket, head, (refused) => {
                    refused.on('error', () => undefined);
                    refused.close(code, reason);
                });
            // Before the upgrade, unlike /midi: the cap behind it is 32 MiB.
            if (!tokensMatch(url.searchParams.get('t') ?? '', options.token)) {
                report({ type: 'refused', reason: 'token', detail: client });
                refuse(CLOSE_BAD_TOKEN, 'bad token');
                return;
            }
            if (files.clients.size >= MAX_FILE_CONNECTIONS) {
                report({ type: 'refused', reason: 'busy', detail: client });
                refuse(CLOSE_BUSY, 'too many file connections');
                return;
            }
            files.handleUpgrade(request, socket, head, (accepted) => files.emit('connection', accepted, request));
            return;
        }
        // Everything else exactly as when `ws` owned the server: /midi is
        // accepted, any other path is answered 400 by handleUpgrade itself.
        wss.handleUpgrade(request, socket, head, (accepted) => wss.emit('connection', accepted, request));
    });
    http.listen(options.port, options.bind);
    /** See HEARTBEAT_MS. 0 turns it off, which is what a test that wants a socket held open asks for. */
    const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

    /**
     * The live sockets writing to each port, each as what it has left
     * sounding.
     *
     * Two uses. How many there are decides whether a port can safely be
     * re-opened - see the refresh below - and it is a set rather than a
     * boolean because two devices really can claim one port, and the second
     * one leaving must not make the first one's handle look abandoned. What
     * each holds is what a closing socket's release is measured against, so
     * one device leaving never ends a note the other is still playing.
     */
    const live = new Map<string, Set<HeldNotes>>();
    let lastConnId = 0;
    /** Set by close(): the caller is about to panic every port, so a socket's own release is redundant. */
    let shuttingDown = false;

    wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
        // First, before anything that can take time. The phone starts its
        // clock for `t` when the handshake completes, which is before this
        // handler runs; the port refresh below can then take tens of
        // milliseconds on Windows, and reading the time after it made every
        // frame of the connection look that much "ahead" in the log.
        const acceptedAt = performance.now();
        const url = new URL(request.url ?? WS_PATH, 'http://localhost');
        const token = url.searchParams.get('t') ?? '';
        const claimParam = url.searchParams.get('port');
        // Printable here, before the token check reports it - see printable.
        const client = printable(url.searchParams.get('client') ?? 'unknown', MAX_CLIENT_LABEL);

        if (!tokensMatch(token, options.token)) {
            report({ type: 'refused', reason: 'token', detail: client });
            socket.close(CLOSE_BAD_TOKEN, 'bad token');
            return;
        }

        // No claim is allowed: it means "the shared port", which is what a
        // connection from before ports had names would want.
        let claim: Claim | null = null;
        if (claimParam !== null && claimParam !== '') {
            if (!isClaim(claimParam)) {
                report({ type: 'refused', reason: 'claim', detail: printable(claimParam, MAX_CLIENT_LABEL) });
                socket.close(CLOSE_BAD_CLAIM, 'unknown port claim');
                return;
            }
            claim = claimParam;
        }

        const portName = claim ? PORT_NAMES[claim] : DEFAULT_PORT_NAME;

        // Re-open it before answering, because `open` and `missing` were a
        // snapshot taken at startup and this process outlives what it
        // snapshotted. Restart loopMIDI and every handle in that map is stale
        // while the map still lists them as open - so the client connects,
        // hello says the port is open and nothing is missing, every message is
        // accepted, and not one byte reaches a MIDI port.
        //
        // Measured on a real machine: a fresh helper delivered notes, and the
        // instance that had been running all afternoon delivered none - same
        // port, same second, same code.
        //
        // ONLY when nobody else is on that port. `refresh` hands back a NEW
        // handle and closes the old one, and an existing client captured the
        // old one in its message callback - so refreshing under a live
        // connection would silently stop the instrument that was already
        // playing, which is the exact failure this is here to remove. A
        // connection to an idle port is the common case and the one that
        // matters; two devices on one port keep whatever handle they started
        // with.
        let peers = live.get(portName);
        if (!peers) {
            peers = new Set();
            live.set(portName, peers);
        }
        if (peers.size === 0) options.ports.refresh(portName);
        const port = options.ports.open.get(portName);

        // Hello goes out even when the port is missing, and BEFORE the close:
        // it carries the `missing` list, which is the only way the app can tell
        // the player which loopMIDI port to create. Closing first would leave
        // them with a disconnection and no reason.
        const hello: HelloMessage = {
            hello: PROTOCOL_VERSION,
            version: options.version,
            platform: options.platform,
            claimed: claim,
            portName,
            ports: [...options.ports.open.keys()],
            missing: options.ports.missing,
            // Its presence is the capability - see HelloMessage.files.
            ...(files ? { files: FILE_CAPABILITIES } : {}),
        };
        socket.send(JSON.stringify(hello));

        if (!port) {
            report({ type: 'refused', reason: 'port', detail: portName });
            socket.close(CLOSE_NO_PORT, `no port named ${portName}`);
            return;
        }

        const connId = ++lastConnId;
        const openedAt = acceptedAt;
        const { onMessage, onDrop, onConnectionClose } = options;
        report({ type: 'connected', claim, portName, client, connId });
        const held = new HeldNotes();
        const portPeers = peers;
        portPeers.add(held);

        /**
         * The heartbeat, per accepted connection - see HEARTBEAT_MS.
         *
         * A ping is the only thing this server ever writes after `hello`, and
         * therefore the only thing that can fail: without one, a phone that
         * went out of range or had its battery die stayed "connected" with its
         * notes sounding until Ctrl+C. Terminating is deliberate rather than
         * closing politely - there is nobody left to complete a close
         * handshake with - and it lands in the `close` handler below, which is
         * what actually ends the notes.
         *
         * `unref` so a helper with a dead connection can still exit on its own
         * if nothing else is holding the loop.
         */
        let timedOut = false;
        let missedPongs = 0;
        // Browsers answer pings below the page, so nothing in the app takes
        // part in this and a backgrounded or throttled tab still replies.
        socket.on('pong', () => {
            missedPongs = 0;
        });
        const heartbeat =
            heartbeatMs > 0
                ? setInterval(() => {
                      if (missedPongs >= MISSED_PONGS_ALLOWED) {
                          timedOut = true;
                          socket.terminate();
                          return;
                      }
                      missedPongs += 1;
                      try {
                          socket.ping();
                      } catch {
                          // Already closing; `close` is on its way.
                      }
                  }, heartbeatMs)
                : null;
        heartbeat?.unref?.();

        socket.on('message', (data) => {
            // Read on arrival, not after port.send: the log's lead is measured
            // against it, and a slow port would otherwise count as network.
            const receivedAt = onMessage ? performance.now() : 0;
            const raw = typeof data === 'string' ? data : data.toString('utf8');
            const parsed = parseMessageDetailed(raw);
            // Dropped, not answered. A malformed frame on a local socket is a
            // bug somewhere, and replying to it would only give a broken client
            // something else to get wrong.
            if (!parsed.ok) {
                // Both quote the frame: `raw` whole, and the reason a value
                // out of it, through JSON.stringify, which leaves C1 controls
                // and the bidi overrides alone.
                observe(onDrop, {
                    connId,
                    portName,
                    reason: printable(parsed.reason, MAX_RAW_QUOTE),
                    raw: printable(raw, MAX_RAW_QUOTE),
                });
                return;
            }
            port.send(parsed.message.b);
            // After the send, so the note is never later for it. Always, not
            // only when logging: it is what the close below releases.
            held.track(parsed.message.b);
            if (onMessage) {
                observe(onMessage, {
                    connId,
                    portName,
                    claim,
                    client,
                    t: parsed.message.t,
                    bytes: parsed.message.b,
                    receivedAt,
                    openedAt,
                });
            }
        });

        /**
         * The close code `ws` sent, when it closed the socket itself.
         *
         * Needed because the close event cannot say: after refusing a frame
         * `ws` stops reading, never sees the client's echo of its close frame,
         * and reports 1006 - so an oversize frame would look like a network
         * drop.
         */
        let refusedWith: number | undefined;

        socket.on('close', (code: number) => {
            if (heartbeat) clearInterval(heartbeat);
            // Out of the set first, so the release below is measured against
            // the OTHER sockets on this port only.
            portPeers.delete(held);
            // Whatever the reason - a clean close, a dropped network, the
            // phone locking, a frame too large - the notes this socket left on
            // are ended now, because nothing else ever will. On `port`, the
            // handle this socket was writing to: it is still the current one,
            // since a port is only re-opened when nobody is on it.
            const released = shuttingDown ? [] : held.releaseMessages(portPeers);
            for (const bytes of released) port.send(bytes);
            const ended = released.reduce((count, bytes) => count + ((bytes[0] & 0xf0) === 0x80 ? 1 : 0), 0);
            observe(onConnectionClose, {
                connId,
                portName,
                claim,
                client,
                openedAt,
                closedAt: performance.now(),
                code: refusedWith ?? code,
                timedOut,
                released,
            });
            report({ type: 'disconnected', claim, portName, connId, ended, timedOut });
        });

        // A socket that errors is a socket that is closing; `close` reports it.
        // A WS_ERR_* error is `ws` refusing the frame it was reading - over
        // maxPayload, or not valid WebSocket - which is a dropped frame the
        // player would otherwise only see as an unexplained disconnect.
        socket.on('error', (error: Error & { code?: string }) => {
            if (!error.code?.startsWith('WS_ERR_')) return;
            if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
                refusedWith = 1009;
                observe(onDrop, { connId, portName, reason: `frame larger than ${MAX_FRAME_BYTES} bytes, connection closed (1009)` });
                return;
            }
            observe(onDrop, {
                connId,
                portName,
                reason: invalidFrameReason(error.message),
            });
        });
    });

    /**
     * FILES_PER_MINUTE, shared by every FILE_WS_PATH socket. The token is the
     * pairing, and one bridge run has one token, so this is one per pairing.
     * Not per socket: the app opens a fresh socket for every file it sends,
     * so a per-socket count never reached its limit and only
     * MAX_FILE_CONNECTIONS held anyone back. Each file announced counts
     * (refused ones included), and one over the limit is answered
     * `rate-limited` and its body dropped unread.
     */
    const limiter = new RateLimiter(FILES_PER_MINUTE, 60_000);

    /**
     * A take, sent to be written into the takes folder - see FILE_WS_PATH in
     * protocol.ts for the steps and files.ts for what is and is not written.
     * The token was checked before this socket was accepted.
     */
    files?.on('connection', (socket: WebSocket, request: IncomingMessage) => {
        const fileId = ++lastFileId;
        const url = new URL(request.url ?? FILE_WS_PATH, 'http://localhost');
        const client = printable(url.searchParams.get('client') ?? 'unknown', MAX_CLIENT_LABEL);
        const hello: FileHelloMessage = { hello: PROTOCOL_VERSION, version: options.version, files: FILE_CAPABILITIES };
        socket.send(JSON.stringify(hello));

        /** What the next binary message is: a take, one to drop unread, or nothing announced. */
        let pending: { stem: string; ext: TakeExtension; name: string; size: number } | 'skip' | null = null;
        /** Replies go out in the order the files came in, however long each write takes. */
        let queue: Promise<void> = Promise.resolve();
        const inOrder = (step: () => Promise<void> | void) => {
            queue = queue.then(step).catch(() => undefined);
        };
        const reply = (message: FileReply) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
        };
        const refuse = (code: FileErrorCode, detail: string, max?: number) =>
            inOrder(() => {
                report({ type: 'file-refused', fileId, client, code, detail });
                reply(max === undefined ? { error: code } : { error: code, max });
            });

        // See FILE_IDLE_MS. On the TCP socket, so a large message that is
        // still arriving counts as alive.
        const raw = request.socket;
        let idle: ReturnType<typeof setTimeout> | null = null;
        const touch = () => {
            if (idle) clearTimeout(idle);
            if (fileIdleMs <= 0) return;
            idle = setTimeout(() => socket.terminate(), fileIdleMs);
            idle.unref?.();
        };
        touch();
        raw.on('data', touch);

        socket.on('message', (data: RawData, isBinary: boolean) => {
            const bytes = toBuffer(data);
            if (!isBinary) {
                // A header. Whatever it announces replaces anything pending,
                // and until it is accepted its body is one to drop unread.
                pending = 'skip';
                if (!limiter.take()) return refuse('rate-limited', '');
                const text = bytes.toString('utf8');
                const parsed = parseFileHeader(text);
                if (!parsed.ok) return refuse(parsed.code, printable(text, MAX_NAME_QUOTE));
                const clean = cleanTakeName(parsed.header.name);
                if (!clean.ok) return refuse(clean.code, printable(parsed.header.name, MAX_NAME_QUOTE));
                const max = maxBytesFor(clean.ext);
                if (parsed.header.size > max) return refuse('too-large', printable(clean.name, MAX_NAME_QUOTE), max);
                pending = { stem: clean.stem, ext: clean.ext, name: clean.name, size: parsed.header.size };
                return;
            }
            const take = pending;
            pending = null;
            // The body of a header already refused, and answered: dropped unread.
            if (take === 'skip') return;
            if (take === null) {
                if (!limiter.take()) return refuse('rate-limited', '');
                return refuse('no-header', '');
            }
            const name = printable(take.name, MAX_NAME_QUOTE);
            if (bytes.length !== take.size) return refuse('size-mismatch', name);
            if (!looksLike(take.ext, bytes)) return refuse('bad-content', name);
            inOrder(async () => {
                const result = await saveTake(takesDir as string, take, bytes);
                if ('saved' in result) {
                    report({ type: 'file-saved', fileId, client, name: printable(result.saved, MAX_NAME_QUOTE), bytes: result.bytes });
                } else {
                    report({ type: 'file-refused', fileId, client, code: result.error, detail: name });
                }
                reply(result);
            });
        });

        // A message over MAX_FILE_PAYLOAD: `ws` closes with 1009 by itself,
        // and says so here first.
        socket.on('error', (error: Error & { code?: string }) => {
            if (error.code !== 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') return;
            report({
                type: 'file-refused',
                fileId,
                client,
                code: 'too-large',
                detail: `a message over ${MAX_FILE_PAYLOAD} bytes, connection closed (1009)`,
            });
        });
        socket.on('close', () => {
            if (idle) clearTimeout(idle);
            raw.off('data', touch);
        });
    });

    return {
        connections: () => wss.clients.size,
        fileConnections: () => files?.clients.size ?? 0,
        close: () =>
            new Promise<void>((resolve) => {
                shuttingDown = true;
                for (const client of wss.clients) client.terminate();
                for (const client of files?.clients ?? []) client.terminate();
                for (const client of refuser.clients) client.terminate();
                wss.close();
                files?.close();
                refuser.close();
                http.closeAllConnections();
                http.close(() => resolve());
            }),
    };
}
