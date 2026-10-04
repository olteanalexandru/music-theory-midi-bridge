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
    /**
     * Where and how big a take may be sent to this PC - see FILE_WS_PATH.
     *
     * Its presence IS the capability: a helper from before 1.0.8 sends no
     * `files`, and the app hides 'Send to PC' rather than offering a button
     * whose socket would be refused at the handshake. Absent too on a server
     * started without a takes folder, which only a test does.
     */
    files?: FileCapabilities;
}

/** Rejection reasons, sent as a WebSocket close code's reason string. */
export const CLOSE_BAD_TOKEN = 4001;
export const CLOSE_BAD_CLAIM = 4002;
export const CLOSE_NO_PORT = 4003;
/** FILE_WS_PATH only: MAX_FILE_CONNECTIONS are already open. */
export const CLOSE_BUSY = 4004;

// *** SENDING A TAKE TO THIS PC (1.0.8) ***
//
// Chrome on Windows hands a dragged download to the drop target as a file
// that only exists once the target runs Explorer's async handshake, which a
// DAW does not - so a take cannot be dragged from the page into Live. The
// helper is already on the PC and already paired, so it writes the file into
// a folder instead (files.ts), the player adds that folder to the DAW's
// browser once, and drags from there. It works from the phone too.
//
// A path of its own, never the MIDI one. MAX_FRAME_BYTES is what keeps a
// socket on a shared network from making this program buffer megabytes, and
// widening it for files would widen it for every instrument. `/file` has its
// own caps, per type, and the same token.
//
//   1. connect  ws://<host>:<port>/file?t=<token>&client=<label>
//      (a wrong token is refused BEFORE the upgrade completes, by a socket
//      that will read no more than REFUSED_MAX_PAYLOAD - so nobody without
//      the token can make this buffer a 32 MiB frame)
//   2. helper -> {"hello": 1, "version": "1.0.8", "files": FileCapabilities}
//   3. client -> {"name": "take.mid", "size": 1234}      (a text frame)
//   4. client -> the file's bytes, `size` of them         (one binary message)
//   5. helper -> {"saved": "take (2).mid", "bytes": 1234}
//             or {"error": "<FileErrorCode>"}  (+ "max" for too-large)
//
// Steps 3-5 repeat on one socket, replies in order. A header that is refused
// is answered at once, and the binary message after it is dropped unlooked-at
// rather than answered a second time. `ws` still buffers that message, and
// any body, up to MAX_FILE_PAYLOAD: the per-kind caps above are checked at
// the header, and only MAX_FILE_PAYLOAD is enforced before bytes are held.

/** The path a paired client sends a take to. */
export const FILE_WS_PATH = '/file';

/** The only kinds of file written, by extension (lower case, no dot). */
export const TAKE_EXTENSIONS = ['mid', 'midi', 'musicxml', 'xml', 'wav'] as const;
export type TakeExtension = (typeof TAKE_EXTENSIONS)[number];

export function isTakeExtension(value: string): value is TakeExtension {
    return (TAKE_EXTENSIONS as readonly string[]).includes(value);
}

const MIB = 1024 * 1024;

/**
 * The largest file of each kind, in bytes.
 *
 * MIDI and MusicXML: 2 MiB (2,097,152 bytes). A take of several minutes with
 * every bend, pressure and slide sample is tens of kilobytes; MusicXML is
 * wordier but of the same order. WAV: 32 MiB (33,554,432 bytes), about three
 * minutes of 16-bit 44.1 kHz stereo - the length of a take, not an album.
 */
export const FILE_MAX_BYTES: Readonly<Record<TakeExtension, number>> = {
    mid: 2 * MIB,
    midi: 2 * MIB,
    musicxml: 2 * MIB,
    xml: 2 * MIB,
    wav: 32 * MIB,
};

/** What `ws` will read on FILE_WS_PATH: the largest of FILE_MAX_BYTES, refused (1009) past it. */
export const MAX_FILE_PAYLOAD = Math.max(...Object.values(FILE_MAX_BYTES));

/** The largest header (step 3) read as one; a name is a few words. */
export const MAX_FILE_HEADER_BYTES = 2048;

/** What a socket refused at the handshake will read before it is gone. */
export const REFUSED_MAX_PAYLOAD = 1024;

/** Files the helper takes a minute over every FILE_WS_PATH connection together (one limit per run), refused ones included. */
export const FILES_PER_MINUTE = 10;

/** Open FILE_WS_PATH sockets at once; the next is closed with CLOSE_BUSY. */
export const MAX_FILE_CONNECTIONS = 4;

/** Sent in the MIDI hello and the file hello. */
export interface FileCapabilities {
    path: typeof FILE_WS_PATH;
    maxBytes: Readonly<Record<TakeExtension, number>>;
    perMinute: number;
}

export const FILE_CAPABILITIES: FileCapabilities = {
    path: FILE_WS_PATH,
    maxBytes: FILE_MAX_BYTES,
    perMinute: FILES_PER_MINUTE,
};

/** Helper -> client, once, as a FILE_WS_PATH socket is accepted. */
export interface FileHelloMessage {
    hello: typeof PROTOCOL_VERSION;
    version: string;
    files: FileCapabilities;
}

/** Step 3: what the next binary message is. */
export interface FileHeader {
    /** The file's name. Only a cleaned basename of it is used - see files.ts. */
    name: string;
    /** Its length in bytes; the binary message must be exactly this long. */
    size: number;
}

/**
 * Why a file was not saved. Stable: the app maps each to a message, so a code
 * is added, never renamed.
 */
export const FILE_ERROR_CODES = [
    /** Step 3 was not JSON, not {name, size}, or longer than MAX_FILE_HEADER_BYTES. */
    'bad-header',
    /** A name that is a path, or carries control or format characters, or is nothing once cleaned. */
    'bad-name',
    /** Not one of TAKE_EXTENSIONS. */
    'bad-extension',
    /** `size` 0. */
    'empty',
    /** Over FILE_MAX_BYTES for its kind; the reply carries `max`. */
    'too-large',
    /** A binary message with no header before it. */
    'no-header',
    /** The binary message was not `size` bytes. */
    'size-mismatch',
    /** The bytes are not the kind of file the name says (MThd, RIFF/WAVE, '<'). */
    'bad-content',
    /** Over FILES_PER_MINUTE, counted across every file connection. */
    'rate-limited',
    /** The takes folder could not be created. */
    'folder-unavailable',
    /** Every name from `x` to `x (999)` is taken. */
    'name-taken',
    /** Writing the file failed (disk full, permissions); nothing is left behind. */
    'write-failed',
] as const;
export type FileErrorCode = (typeof FILE_ERROR_CODES)[number];

/** Step 5. */
export type FileReply = { saved: string; bytes: number } | { error: FileErrorCode; max?: number };

export type ParsedFileHeader = { ok: true; header: FileHeader } | { ok: false; code: FileErrorCode };

/** Reads step 3. Size is checked here; the name is files.ts's business. */
export function parseFileHeader(raw: string): ParsedFileHeader {
    // Measured in UTF-8 bytes, which is what arrived.
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_HEADER_BYTES) return { ok: false, code: 'bad-header' };
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return { ok: false, code: 'bad-header' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'bad-header' };
    const { name, size } = value as Partial<Record<keyof FileHeader, unknown>>;
    if (typeof name !== 'string') return { ok: false, code: 'bad-header' };
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return { ok: false, code: 'bad-header' };
    if (size === 0) return { ok: false, code: 'empty' };
    return { ok: true, header: { name, size } };
}

/**
 * The largest frame the server will read, in bytes.
 *
 * One message is one MIDI event - three bytes, or the six of an RPN - wrapped
 * in a few dozen bytes of JSON. `ws` would otherwise accept a 100 MiB frame and
 * buffer the whole of it before this code ever saw a byte, which on a socket
 * reachable from a shared network is a way to stall the machine a DAW is
 * running on. Four kilobytes is two orders of magnitude of headroom.
 */
export const MAX_FRAME_BYTES = 4096;

/** System Exclusive start and end. See parseMessage. */
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

/**
 * Parses one inbound frame.
 *
 * Returns null rather than throwing for anything malformed: this is a socket
 * open to a local network, so a bad frame is a thing to drop, not a thing to
 * crash the helper somebody is playing through.
 */
export function parseMessage(raw: string): BridgeMessage | null {
    const parsed = parseMessageDetailed(raw);
    return parsed.ok ? parsed.message : null;
}

export type ParsedMessage = { ok: true; message: BridgeMessage } | { ok: false; reason: string };

/**
 * parseMessage, saying why when it drops a frame.
 *
 * The reason is for the --log-midi console and nothing else: the socket still
 * gets no reply (see server.ts), so a broken client learns nothing new from it.
 * It exists because "dropped" alone sends whoever is reading the log back to
 * the source to find out which of eight rules the frame broke.
 */
export function parseMessageDetailed(raw: string): ParsedMessage {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return { ok: false, reason: 'not JSON' };
    }
    if (!value || typeof value !== 'object') return { ok: false, reason: 'not a JSON object' };
    const message = value as Partial<BridgeMessage>;
    if (typeof message.t !== 'number' || !Number.isFinite(message.t)) {
        return { ok: false, reason: 't is missing or not a finite number' };
    }
    if (!Array.isArray(message.b) || message.b.length === 0) return { ok: false, reason: 'b is missing or empty' };

    const bytes: number[] = [];
    for (let index = 0; index < message.b.length; index++) {
        const byte: unknown = message.b[index];
        // A MIDI byte is 0..255 and nothing else. Silently clamping would turn
        // a corrupt frame into a wrong note, which is harder to notice than no
        // note at all.
        if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
            return { ok: false, reason: `b[${index}] = ${shortValue(byte)} is not a MIDI byte (an integer 0-255)` };
        }
        // SysEx is refused outright. The app never sends it - it calls
        // requestMIDIAccess with SysEx off and emits no 0xF0 byte anywhere -
        // so a frame carrying one did not come from the app, and SysEx is the
        // one MIDI message that can reprogram, overwrite or brick hardware on
        // the other end of the port. Data bytes are all below 0x80, so either
        // byte appearing anywhere in a frame can only mean SysEx.
        if (byte === SYSEX_START || byte === SYSEX_END) {
            return { ok: false, reason: `SysEx refused (0x${byte.toString(16).toUpperCase()} at b[${index}])` };
        }
        bytes.push(byte);
    }
    return { ok: true, message: { t: message.t, b: bytes } };
}

/** How much of a rejected value a drop reason quotes. */
export const REASON_VALUE_CHARS = 40;

/**
 * A rejected value as the drop reason quotes it, cut to REASON_VALUE_CHARS.
 *
 * A frame is up to 4 KB and one entry of `b` can be most of it - a string, a
 * nested object - so quoting it whole put a 4 KB line in the log for one bad
 * frame. Forty characters says what the thing was; the raw frame, already cut
 * short by the log, is there for anybody who needs more.
 */
function shortValue(value: unknown): string {
    // JSON.stringify(undefined) is undefined, not a string - String() it.
    const text = JSON.stringify(value) ?? String(value);
    return text.length > REASON_VALUE_CHARS ? `${text.slice(0, REASON_VALUE_CHARS)}...` : text;
}
