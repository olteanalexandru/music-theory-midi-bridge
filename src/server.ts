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

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
    CLOSE_BAD_CLAIM,
    CLOSE_BAD_TOKEN,
    CLOSE_NO_PORT,
    DEFAULT_PORT_NAME,
    MAX_FRAME_BYTES,
    PORT_NAMES,
    PROTOCOL_VERSION,
    WS_PATH,
    isClaim,
    parseMessageDetailed,
    type Claim,
    type HelloMessage,
} from './protocol.js';
import type { PortSet } from './ports.js';
import { HeldNotes } from './heldNotes.js';

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
}

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
    | { type: 'refused'; reason: 'token' | 'claim' | 'port'; detail: string };

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

export interface RunningServer {
    close(): Promise<void>;
    /** Open sockets, for tests and for the banner. */
    connections(): number;
}

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
    // maxPayload: a frame past it is refused by `ws` itself (close 1009) before
    // it is buffered - see MAX_FRAME_BYTES.
    const wss = new WebSocketServer({ port: options.port, host: options.bind, path: WS_PATH, maxPayload: MAX_FRAME_BYTES });
    const report = options.onEvent ?? (() => undefined);
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
        const client = url.searchParams.get('client') ?? 'unknown';

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
                report({ type: 'refused', reason: 'claim', detail: claimParam });
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
                observe(onDrop, { connId, portName, reason: parsed.reason, raw });
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
            observe(onDrop, { connId, portName, reason: `invalid WebSocket frame, connection closed (${error.message})` });
        });
    });

    return {
        connections: () => wss.clients.size,
        close: () =>
            new Promise<void>((resolve) => {
                shuttingDown = true;
                for (const client of wss.clients) client.terminate();
                wss.close(() => resolve());
            }),
    };
}
