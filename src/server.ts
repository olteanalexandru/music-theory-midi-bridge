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

import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
    CLOSE_BAD_CLAIM,
    CLOSE_BAD_TOKEN,
    CLOSE_NO_PORT,
    DEFAULT_PORT_NAME,
    PORT_NAMES,
    PROTOCOL_VERSION,
    WS_PATH,
    isClaim,
    parseMessage,
    type Claim,
    type HelloMessage,
} from './protocol.js';
import type { PortSet } from './ports.js';

export interface ServerOptions {
    port: number;
    /** Rejected without it. See the note on why a LAN service needs one. */
    token: string;
    ports: PortSet;
    version: string;
    platform: string;
    /** Told about every connect, disconnect and refusal, for the console. */
    onEvent?: (event: ServerEvent) => void;
}

export type ServerEvent =
    | { type: 'connected'; claim: Claim | null; portName: string; client: string }
    | { type: 'disconnected'; claim: Claim | null; portName: string }
    | { type: 'refused'; reason: 'token' | 'claim' | 'port'; detail: string };

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
    const wss = new WebSocketServer({ port: options.port, path: WS_PATH });
    const report = options.onEvent ?? (() => undefined);

    wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
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

        report({ type: 'connected', claim, portName, client });

        socket.on('message', (data) => {
            const message = parseMessage(typeof data === 'string' ? data : data.toString('utf8'));
            // Dropped, not answered. A malformed frame on a local socket is a
            // bug somewhere, and replying to it would only give a broken client
            // something else to get wrong.
            if (!message) return;
            port.send(message.b);
        });

        socket.on('close', () => {
            report({ type: 'disconnected', claim, portName });
        });

        // A socket that errors is a socket that is closing; `close` reports it.
        socket.on('error', () => undefined);
    });

    return {
        connections: () => wss.clients.size,
        close: () =>
            new Promise<void>((resolve) => {
                for (const client of wss.clients) client.terminate();
                wss.close(() => resolve());
            }),
    };
}
