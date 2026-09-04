// The wire format between the app and this helper.
//
// Mirrored from `app/utils/midiBridge.ts` in the music-theory-cheatsheet repo.
// Two copies rather than a shared package on purpose: the app is a static
// export with its own toolchain, this is a Node binary with a native
// dependency, and a package existing only to hold four field names would have
// to be published, versioned and installed before either could build. What
// keeps them honest instead is that the format is small enough to state
// completely, and `protocol.test.ts` here decodes exactly what the app's
// `midiBridge.test.ts` encodes.
//
// Version it, do not guess it. `PROTOCOL_VERSION` goes out in the hello frame
// so an old app talking to a new helper finds out rather than misbehaving.

export const PROTOCOL_VERSION = 1;

/** Default port. Nothing standard - just a number out of the way. */
export const DEFAULT_PORT = 8532;

/** The path the app connects to. */
export const WS_PATH = '/midi';

/**
 * One MIDI message, app -> helper.
 *
 * JSON rather than a binary frame, and not out of laziness: a helper written in
 * any language can read this with its standard library, the traffic is a few
 * hundred bytes a second even under a fast trill, and a protocol you can read
 * in a log is one somebody can reimplement without this file open beside them.
 */
export interface BridgeMessage {
    /**
     * Milliseconds since THAT SOCKET opened. Relative, never a wall clock.
     *
     * The two machines have different clocks, so this cannot be used as an
     * absolute time and must not be treated as one. It is here so the gaps
     * between messages the app scheduled ahead of time survive the trip.
     */
    t: number;
    /** Raw MIDI bytes, exactly as they would reach a port. */
    b: number[];
}

/** Which instrument is on the other end, and therefore which port it wants. */
export const CLAIMS = ['stylophone', 'pads', 'theremin', 'staff'] as const;
export type Claim = (typeof CLAIMS)[number];

export function isClaim(value: unknown): value is Claim {
    return typeof value === 'string' && (CLAIMS as readonly string[]).includes(value);
}

/**
 * The port each claim is routed to.
 *
 * These names are the whole Ableton story: one port per instrument means one
 * Live track per instrument, each with a full fifteen-channel MPE zone to
 * itself rather than four instruments fighting over one port's channels.
 *
 * On Windows they are also literally what the player has to type into loopMIDI,
 * so they must be stable, obvious, and free of anything a text field would
 * mangle - see ports.ts.
 */
export const PORT_NAMES: Record<Claim, string> = {
    stylophone: 'Tutor Stylophone',
    pads: 'Tutor Pads',
    theremin: 'Tutor Theremin',
    staff: 'Tutor Staff',
};

/** Where a socket with no claim goes: one shared port, as before ports had names. */
export const DEFAULT_PORT_NAME = 'Tutor MIDI';

export const ALL_PORT_NAMES: string[] = [DEFAULT_PORT_NAME, ...CLAIMS.map((claim) => PORT_NAMES[claim])];

/**
 * Sent once, helper -> app, as soon as a socket is accepted.
 *
 * The only message that travels this way, and it earns its place: without it
 * the app can say "connected" and nothing more, so a player whose loopMIDI port
 * is missing gets silence and no reason for it. With it the app can name the
 * port it is writing to and say when that port does not exist.
 */
export interface HelloMessage {
    hello: typeof PROTOCOL_VERSION;
    /** This helper's own version, for a support conversation. */
    version: string;
    /** 'win32' | 'darwin' | 'linux' - decides whether ports are made or found. */
    platform: string;
    /** The claim this socket was granted, or null when it asked for none. */
    claimed: Claim | null;
    /** The port name that claim resolved to. */
    portName: string;
    /** Every port this helper currently has open. */
    ports: string[];
    /**
     * Ports that should exist and do not.
     *
     * Only ever non-empty on Windows, where RtMidi cannot create ports and the
     * player has to make them in loopMIDI. The app turns this into an
     * instruction naming them.
     */
    missing: string[];
}

/** Rejection reasons, sent as a WebSocket close code's reason string. */
export const CLOSE_BAD_TOKEN = 4001;
export const CLOSE_BAD_CLAIM = 4002;
export const CLOSE_NO_PORT = 4003;

/**
 * Parses one inbound frame.
 *
 * Returns null rather than throwing for anything malformed: this is a socket
 * open to a local network, so a bad frame is a thing to drop, not a thing to
 * crash the helper somebody is playing through.
 */
export function parseMessage(raw: string): BridgeMessage | null {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!value || typeof value !== 'object') return null;
    const message = value as Partial<BridgeMessage>;
    if (typeof message.t !== 'number' || !Number.isFinite(message.t)) return null;
    if (!Array.isArray(message.b) || message.b.length === 0) return null;

    const bytes: number[] = [];
    for (const byte of message.b) {
        // A MIDI byte is 0..255 and nothing else. Silently clamping would turn
        // a corrupt frame into a wrong note, which is harder to notice than no
        // note at all.
        if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) return null;
        bytes.push(byte);
    }
    return { t: message.t, b: bytes };
}
