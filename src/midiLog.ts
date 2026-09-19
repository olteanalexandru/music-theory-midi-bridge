// Reading the bytes back, for a person watching a terminal.
//
// The bridge forwards bytes without interpreting them, and that stays true:
// nothing in this file touches what reaches the port. It exists because "MIDI
// is active" does not answer the question somebody checking MPE is asking,
// which is whether the MPE Configuration Message arrived, what bend range each
// member channel was told, and whether every per-note bend, slide and press
// landed on the channel its note is on. Ableton cannot show that, and a byte
// monitor on loopMIDI shows the bytes without their meaning. This shows both,
// per socket, with the state a receiver would be holding.
//
// Everything here is pure apart from one optional timer, the coalescing flush.
// It is handed what the server saw and produces lines, so every rule can be
// tested without a socket or a port.
//
// Allocation-light, not allocation-free: decoding reuses one event object and
// plain counters, and a string is only built for a line that is printed. When
// the log is off none of this is constructed at all (see index.ts).

export const MIDI_LOG_LEVELS = ['notes', 'expr', 'all'] as const;
export type MidiLogLevel = (typeof MIDI_LOG_LEVELS)[number];

export function isMidiLogLevel(value: unknown): value is MidiLogLevel {
    return typeof value === 'string' && (MIDI_LOG_LEVELS as readonly string[]).includes(value);
}

const LEVEL_RANK: Record<MidiLogLevel, number> = { notes: 0, expr: 1, all: 2 };

/**
 * How often, at most, one continuous stream (a bend, a press, a slide) on one
 * channel prints a line at the "expr" level.
 *
 * A finger sliding on a phone produces a pitch-bend message per pointer event,
 * sixty or more a second per note, and a chord of five sliding notes prints
 * three hundred lines a second - which is a scrolling blur, not a log. Ten a
 * second per channel per dimension still shows a gesture's shape. "all" never
 * coalesces: it is the level for when every message matters.
 */
export const DEFAULT_COALESCE_MS = 100;

/**
 * How far past this connection's usual lead a frame has to be before its line
 * says "ahead" - see LeadBaseline for what "usual" is.
 */
export const LEAD_REPORT_MS = 20;

/**
 * How far short of the usual lead a frame has to be before its line says
 * "behind". Wider than LEAD_REPORT_MS on purpose: arriving late is what Wi-Fi
 * does to some frames all the time, twenty-odd milliseconds of it is routine,
 * and a log that flags every one of them is the noise the baseline exists to
 * remove. Fifty is late enough to be worth a look - a throttled background
 * tab, a stalled radio.
 */
export const LATE_REPORT_MS = 50;

/**
 * How often one warning, on one channel, may print a line.
 *
 * Take Studio's plain notes on a zone master, or a kit's overlapping hits on
 * channel 10, raise the same warning once per note - a line a beat for as long
 * as a loop plays, burying everything else in the log. So the first one prints
 * in full; repeats inside this window are counted, and printed as one
 * "[+N more]" line when it ends. The summary has every count.
 */
export const WARNING_REPEAT_MS = 5000;

/** What a warning is about, so repeats of one kind on one channel can be counted rather than printed. */
export type WarningKind =
    | 'master-note'
    | 'second-held'
    | 'outside-zone'
    | 'orphan-off'
    | 'no-mcm'
    | 'mcm-channel'
    | 'stray'
    | 'incomplete'
    | 'long-frame'
    | 'multi-message'
    /** Raised by the logger, not the decoder: the server refused the frame. */
    | 'drop';

/** Short names, for a "[+N more]" line and the summary's counts. */
export const WARNING_LABELS: Record<WarningKind, string> = {
    'master-note': 'NoteOn on the zone master channel',
    'second-held': 'second held note on one member channel',
    'outside-zone': 'NoteOn outside the MPE zone',
    'orphan-off': 'NoteOff with no NoteOn',
    'no-mcm': 'MPE-shaped notes with no MCM',
    'mcm-channel': 'MCM on a channel that cannot be a master',
    stray: 'data bytes with no status byte',
    incomplete: 'incomplete message',
    'long-frame': 'frame longer than 3 bytes',
    'multi-message': 'several messages in one frame',
    drop: 'dropped frame',
};

/** How many times one kind of warning was raised on one channel (-1: not about a channel). */
export interface WarningCount {
    kind: WarningKind;
    channel: number;
    count: number;
}

export type MpeZone = 'lower' | 'upper';

/**
 * Where a channel's bend range came from.
 *
 * 'rpn' was told explicitly (RPN 0), 'mcm' is the MPE default an MCM implies
 * (48 for members, 2 for the master), and 'assumed' is General MIDI's 2
 * semitones for a channel nobody has said anything about.
 */
export type RangeSource = 'rpn' | 'mcm' | 'assumed';

export type MidiEventKind =
    | 'NoteOn'
    | 'NoteOff'
    | 'PolyPressure'
    | 'ControlChange'
    /** CC 101/100/99/98: which parameter the next data entry is for. */
    | 'ParamSelect'
    /** The MPE Configuration Message: RPN 6 on a zone's master channel. */
    | 'MCM'
    /** RPN 0, pitch-bend sensitivity. */
    | 'BendRange'
    | 'RpnData'
    | 'NrpnData'
    | 'Program'
    | 'ChanPressure'
    | 'PitchBend'
    | 'System'
    | 'Realtime'
    /** Data bytes with no status byte in front of them. */
    | 'Stray'
    /** A status byte without all of its data bytes. */
    | 'Incomplete';

/** One decoded message. The decoder reuses a single instance; copy what you keep. */
export interface MidiEvent {
    kind: MidiEventKind;
    /** Zero-based; -1 for system messages, which have no channel. */
    channel: number;
    status: number;
    data1: number;
    data2: number;
    /** Where this message sits inside its frame. */
    start: number;
    length: number;
    /** Pitch bend in semitones, and the range it was read with. */
    semitones: number;
    range: number;
    rangeSource: RangeSource;
    /** RPN or NRPN number, (MSB << 7) | LSB. */
    param: number;
    /** For an MCM: which zone, and how many member channels it now has. */
    zone: MpeZone | null;
    members: number;
    /** Whether this arrived on a zone's master channel. */
    onMaster: boolean;
    /**
     * Whether this arrived on a member channel of an active zone. Channel 10
     * is GM's drum channel only outside one: inside, it is a member like the
     * rest and its notes are pitches, not drums.
     */
    onMember: boolean;
}

function blankEvent(): MidiEvent {
    return {
        kind: 'Stray',
        channel: -1,
        status: 0,
        data1: 0,
        data2: 0,
        start: 0,
        length: 0,
        semitones: 0,
        range: 0,
        rangeSource: 'assumed',
        param: 0,
        zone: null,
        members: 0,
        onMaster: false,
        onMember: false,
    };
}

function copyEvent(target: MidiEvent, source: MidiEvent): void {
    Object.assign(target, source);
}

const BEND_CENTRE = 8192;
const NULL_PARAM = (127 << 7) | 127;
/** GM puts drums on channel 10. The app does too - DRUM_MIDI_CHANNEL in drumSynth.ts. */
const DRUM_CHANNEL = 9;
const DRUM_BIT = 1 << DRUM_CHANNEL;

/** The MPE spec's defaults once an MCM has been received. */
const MPE_MEMBER_RANGE = 48;
const MPE_MASTER_RANGE = 2;
/** General MIDI's default, for a channel nobody configured. */
const GM_RANGE = 2;

// Per-channel counters, in the order the summary prints them.
const COUNT_NOTE_ON = 0;
const COUNT_NOTE_OFF = 1;
const COUNT_PB = 2;
const COUNT_CC74 = 3;
const COUNT_CC1 = 4;
const COUNT_CC11 = 5;
const COUNT_CHAN_PRESSURE = 6;
const COUNT_POLY_PRESSURE = 7;
export const COUNTER_LABELS = ['NoteOn', 'NoteOff', 'PB', 'CC74', 'CC1', 'CC11', 'ChanPressure', 'PolyPressure'] as const;

const PARAM_NONE = 0;
const PARAM_RPN = 1;
const PARAM_NRPN = 2;

/** Bytes a message with this status byte occupies, status included. */
export function messageLength(status: number): number {
    if (status < 0x80) return 1;
    if (status < 0xc0) return 3;
    if (status < 0xe0) return 2;
    if (status < 0xf0) return 3;
    if (status === 0xf1 || status === 0xf3) return 2;
    if (status === 0xf2) return 3;
    return 1;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Scientific pitch: 60 is C4.
 *
 * Ableton labels 60 "C3" - it counts octaves from -2 - which is why every note
 * line carries the number as well. The number is the thing that is the same
 * everywhere.
 */
export function noteName(note: number): string {
    return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

/** The exact inverse of MidiSender.pitchBendOn in the app: raw = round(8192 + s/R * 8191). */
export function bendToSemitones(raw: number, range: number): number {
    return ((raw - BEND_CENTRE) / 8191) * range;
}

const CC_NAMES: Record<number, string> = {
    0: 'Bank Select',
    1: 'Modulation',
    2: 'Breath',
    4: 'Foot',
    5: 'Portamento Time',
    6: 'Data Entry',
    7: 'Volume',
    8: 'Balance',
    10: 'Pan',
    11: 'Expression',
    32: 'Bank Select LSB',
    38: 'Data Entry LSB',
    64: 'Sustain',
    65: 'Portamento',
    66: 'Sostenuto',
    67: 'Soft Pedal',
    68: 'Legato',
    69: 'Hold 2',
    71: 'Resonance',
    72: 'Release',
    73: 'Attack',
    74: 'Slide/Timbre',
    91: 'Reverb',
    93: 'Chorus',
    96: 'Data Increment',
    97: 'Data Decrement',
    98: 'NRPN LSB',
    99: 'NRPN MSB',
    100: 'RPN LSB',
    101: 'RPN MSB',
    120: 'All Sound Off',
    121: 'Reset All Controllers',
    122: 'Local Control',
    123: 'All Notes Off',
    124: 'Omni Off',
    125: 'Omni On',
    126: 'Mono On',
    127: 'Poly On',
};

export function ccName(controller: number): string | undefined {
    return CC_NAMES[controller];
}

const RPN_NAMES: Record<number, string> = {
    0: 'pitch-bend range',
    1: 'fine tuning',
    2: 'coarse tuning',
    5: 'modulation depth range',
    6: 'MCM',
};

const GM_DRUMS: Record<number, string> = {
    35: 'Acoustic Bass Drum',
    36: 'Bass Drum 1',
    37: 'Side Stick',
    38: 'Acoustic Snare',
    39: 'Hand Clap',
    40: 'Electric Snare',
    41: 'Low Floor Tom',
    42: 'Closed Hi-Hat',
    43: 'High Floor Tom',
    44: 'Pedal Hi-Hat',
    45: 'Low Tom',
    46: 'Open Hi-Hat',
    47: 'Low-Mid Tom',
    48: 'Hi-Mid Tom',
    49: 'Crash Cymbal 1',
    50: 'High Tom',
    51: 'Ride Cymbal 1',
    52: 'Chinese Cymbal',
    53: 'Ride Bell',
    54: 'Tambourine',
    55: 'Splash Cymbal',
    56: 'Cowbell',
    57: 'Crash Cymbal 2',
    58: 'Vibraslap',
    59: 'Ride Cymbal 2',
    60: 'Hi Bongo',
    61: 'Low Bongo',
    62: 'Mute Hi Conga',
    63: 'Open Hi Conga',
    64: 'Low Conga',
    65: 'High Timbale',
    66: 'Low Timbale',
    67: 'High Agogo',
    68: 'Low Agogo',
    69: 'Cabasa',
    70: 'Maracas',
    71: 'Short Whistle',
    72: 'Long Whistle',
    73: 'Short Guiro',
    74: 'Long Guiro',
    75: 'Claves',
    76: 'Hi Wood Block',
    77: 'Low Wood Block',
    78: 'Mute Cuica',
    79: 'Open Cuica',
    80: 'Mute Triangle',
    81: 'Open Triangle',
};

const SYSTEM_NAMES: Record<number, string> = {
    0xf1: 'MTC Quarter Frame',
    0xf2: 'Song Position',
    0xf3: 'Song Select',
    0xf6: 'Tune Request',
    0xf7: 'SysEx End',
    0xf8: 'Clock',
    0xfa: 'Start',
    0xfb: 'Continue',
    0xfc: 'Stop',
    0xfe: 'Active Sensing',
    0xff: 'Reset',
};

const STATUS_NAMES: Record<number, string> = {
    0x80: 'NoteOff',
    0x90: 'NoteOn',
    0xa0: 'PolyPressure',
    0xb0: 'ControlChange',
    0xc0: 'Program',
    0xd0: 'ChanPressure',
    0xe0: 'PitchBend',
};

function statusName(status: number): string {
    if (status >= 0xf0) return SYSTEM_NAMES[status] ?? `System ${hex(status)}`;
    return STATUS_NAMES[status & 0xf0] ?? hex(status);
}

function hex(byte: number): string {
    return byte.toString(16).toUpperCase().padStart(2, '0');
}

export function hexBytes(bytes: readonly number[], start = 0, end = bytes.length): string {
    let out = '';
    for (let i = start; i < end; i++) out += (i > start ? ' ' : '') + hex(bytes[i]);
    return out;
}

/** 1-based, with runs collapsed: [1,2,3,9] -> "ch 2-4, 10". */
export function formatChannels(channels: readonly number[]): string {
    if (channels.length === 0) return 'none';
    const sorted = [...channels].sort((a, b) => a - b);
    const parts: string[] = [];
    let from = sorted[0];
    let to = from;
    for (let i = 1; i <= sorted.length; i++) {
        const next = sorted[i];
        if (next === to + 1) {
            to = next;
            continue;
        }
        parts.push(from === to ? `${from + 1}` : `${from + 1}-${to + 1}`);
        from = next;
        to = next;
    }
    return `ch ${parts.join(', ')}`;
}

function formatRange(range: number): string {
    return Number.isInteger(range) ? String(range) : range.toFixed(2).replace(/0$/, '');
}

function signed(value: number, digits: number): string {
    const text = value.toFixed(digits);
    return value >= 0 ? `+${text}` : text;
}

function bitCount(mask: number): number {
    let count = 0;
    for (let m = mask; m !== 0; m &= m - 1) count++;
    return count;
}

function channelsOf(mask: number): number[] {
    const out: number[] = [];
    for (let channel = 0; channel < 16; channel++) if (mask & (1 << channel)) out.push(channel);
    return out;
}

class ChannelState {
    paramType = PARAM_NONE;
    rpn = NULL_PARAM;
    nrpn = NULL_PARAM;
    /** NaN until RPN 0 or an MCM says something. */
    bendSemitones = Number.NaN;
    bendCents = 0;
    rangeSource: RangeSource = 'assumed';
    /** The last explicit RPN 0, for the summary - an MCM's default is not one. */
    rpnRange = Number.NaN;
    /** Held count per note; a count because a retrigger without a release is possible. */
    readonly held = new Uint8Array(128);
    heldCount = 0;
    readonly counts = new Uint32Array(COUNTER_LABELS.length);

    get bendRange(): number {
        return Number.isNaN(this.bendSemitones) ? GM_RANGE : this.bendSemitones + this.bendCents / 100;
    }
}

export interface ZoneInfo {
    zone: MpeZone;
    /** Zero-based master channel: 0 for lower, 15 for upper. */
    master: number;
    members: number[];
}

export interface ChannelGroup {
    /** 'master', 'members' or 'other' ('channels' when no zone was ever set up). */
    name: string;
    channels: number[];
    counts: number[];
}

/** What one connection amounted to, and whether it was MPE a receiver could use. */
export interface MpeSummary {
    messages: number;
    frames: number;
    drops: number;
    mcmCount: number;
    /** The zone(s) active when the connection closed, or the last ones set up. */
    zones: ZoneInfo[];
    /** Whether `zones` were still active at the end rather than released. */
    zonesActive: boolean;
    notes: number;
    notesBeforeMcm: number;
    masterNotes: number;
    /** Notes and per-channel expression on several channels with no MCM. */
    mpeLike: boolean;
    /** Last explicit RPN 0 per channel, zero-based index; null where none came. */
    rpnRanges: (number | null)[];
    membersUsed: number[];
    groups: ChannelGroup[];
    held: { channel: number; note: number }[];
    /** How many of `held` the bridge ended itself when the socket closed. */
    endedByBridge: number;
    warnings: number;
    /** Every warning raised, by kind and channel, most frequent first. */
    warningCounts: WarningCount[];
    problems: string[];
    verdict: string;
    ok: boolean;
}

/**
 * The state a receiver would hold after the same bytes, for one connection.
 *
 * One per socket rather than per port, because two sockets on one port are two
 * senders with their own allocators and MCMs, and mixing their state would
 * report conflicts that only exist in the log.
 */
export class MidiDecoder {
    readonly event: MidiEvent = blankEvent();
    /** Raised by the last decodeMessage; emptied on every call. */
    readonly warnings: string[] = [];
    /**
     * What each of `warnings` is about, index for index: its kind, and the
     * channel it concerns (-1 for none). Parallel arrays rather than objects so
     * a message with no warning allocates nothing, and `warnings` stays the
     * plain list of sentences it always was.
     */
    readonly warningKinds: WarningKind[] = [];
    readonly warningChannels: number[] = [];
    /** Raised by the last beginFrame; emptied on every call. Never about one channel. */
    readonly frameWarnings: string[] = [];
    readonly frameWarningKinds: WarningKind[] = [];
    /** Every warning ever raised here, by kind and channel, for the summary. */
    private readonly tally = new Map<string, WarningCount>();

    private readonly channels: ChannelState[] = Array.from({ length: 16 }, () => new ChannelState());
    /** Start and length of each message in the current frame, flattened. */
    private readonly offsets: number[] = [];
    private readonly dropsLongMessages: boolean;
    private readonly platformName: string;

    private lowerMembers = 0;
    private upperMembers = 0;
    /** The zones as the last MCM that set one up left them, so a released zone still groups the summary. */
    private lastZones: ZoneInfo[] = [];
    private mcmCount = 0;
    private messages = 0;
    private frames = 0;
    private drops = 0;
    private notes = 0;
    private notesBeforeMcm = 0;
    private masterNotes = 0;
    private warningCount = 0;
    /** Bit per channel: had a note-on / had per-channel bend or slide / was a member when it did. */
    private noteChannels = 0;
    private exprChannels = 0;
    private memberNoteChannels = 0;
    private mpeLike = false;

    /**
     * @param platform decides whether a frame longer than three bytes is a
     *   warning that it never arrived. RtMidi's WinMM and CoreMIDI back ends
     *   refuse any non-SysEx message over three bytes - they print a warning
     *   to stderr and return without sending, and nothing reaches JavaScript
     *   (RtMidi.cpp, MidiOutWinMM::sendMessage and MidiOutCore::sendMessage).
     *   ALSA splits the buffer into events and sends them all.
     */
    constructor(platform: string = process.platform) {
        this.dropsLongMessages = platform === 'win32' || platform === 'darwin';
        this.platformName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform;
    }

    /** Bend range this channel is currently read with. */
    bendRange(channel: number): { range: number; source: RangeSource } {
        const state = this.channels[channel];
        return { range: state.bendRange, source: state.rangeSource };
    }

    zones(): ZoneInfo[] {
        return zonesFor(this.lowerMembers, this.upperMembers);
    }

    isMaster(channel: number): boolean {
        return (channel === 0 && this.lowerMembers > 0) || (channel === 15 && this.upperMembers > 0);
    }

    isMember(channel: number): boolean {
        if (this.lowerMembers > 0 && channel >= 1 && channel <= this.lowerMembers) return true;
        return this.upperMembers > 0 && channel <= 14 && channel >= 15 - this.upperMembers;
    }

    heldNotes(channel: number): number {
        return this.channels[channel].heldCount;
    }

    /** A frame the server refused, so the summary can count it - as a drop, not also as a warning. */
    noteDrop(): void {
        this.drops++;
    }

    /**
     * Splits one frame into messages and checks it is the one message the
     * protocol promises. Returns how many messages to decode with
     * decodeMessage.
     */
    beginFrame(bytes: readonly number[]): number {
        this.frames++;
        this.frameWarnings.length = 0;
        this.frameWarningKinds.length = 0;
        const offsets = this.offsets;
        offsets.length = 0;
        const n = bytes.length;
        let i = 0;
        while (i < n) {
            const byte = bytes[i];
            // Real-time bytes are single and may sit anywhere, even inside
            // another message; everything else runs to its own length.
            if (byte >= 0xf8) {
                offsets.push(i, 1);
                i++;
                continue;
            }
            if (byte >= 0x80) {
                const need = messageLength(byte);
                let j = i + 1;
                while (j < n && j - i < need && bytes[j] < 0x80) j++;
                offsets.push(i, j - i);
                i = j;
                continue;
            }
            const start = i;
            while (i < n && bytes[i] < 0x80) i++;
            offsets.push(start, i - start);
        }

        const count = offsets.length / 2;
        if (n > 3 && this.dropsLongMessages) {
            this.frameWarning(
                'long-frame',
                `${n}-byte frame: RtMidi on ${this.platformName} drops any non-SysEx message longer than 3 bytes ` +
                    '(a stderr warning, no error), so this frame most likely never reached the port'
            );
        }
        if (count > 1) {
            this.frameWarning('multi-message', `one frame carries ${count} MIDI messages; the protocol is one message per frame`);
        }
        return count;
    }

    /** Decodes message `index` of the frame beginFrame last split, updating the state. */
    decodeMessage(bytes: readonly number[], index: number): MidiEvent {
        const start = this.offsets[index * 2];
        const length = this.offsets[index * 2 + 1];
        const event = this.event;
        this.warnings.length = 0;
        this.warningKinds.length = 0;
        this.warningChannels.length = 0;
        this.messages++;

        event.start = start;
        event.length = length;
        event.semitones = 0;
        event.range = 0;
        event.rangeSource = 'assumed';
        event.param = 0;
        event.zone = null;
        event.members = 0;
        event.onMaster = false;
        event.onMember = false;

        const status = bytes[start];
        if (status < 0x80) {
            event.kind = 'Stray';
            event.channel = -1;
            event.status = 0;
            event.data1 = status;
            event.data2 = 0;
            this.warn(
                'stray',
                -1,
                `${length} data byte(s) with no status byte in front - a receiver may read them as a repeat ` +
                    'of the previous message (running status)'
            );
            return event;
        }

        event.status = status;
        event.data1 = length > 1 ? bytes[start + 1] : 0;
        event.data2 = length > 2 ? bytes[start + 2] : 0;
        const need = messageLength(status);

        if (length < need) {
            event.kind = 'Incomplete';
            event.channel = status >= 0xf0 ? -1 : status & 0x0f;
            this.warn('incomplete', event.channel, `incomplete ${statusName(status)}: ${length} of ${need} bytes`);
            return event;
        }

        if (status >= 0xf0) {
            event.kind = status >= 0xf8 ? 'Realtime' : 'System';
            event.channel = -1;
            return event;
        }

        const channel = status & 0x0f;
        event.channel = channel;
        // Before the message is applied: an MCM on this very message does not
        // make its own channel a member.
        event.onMaster = this.isMaster(channel);
        event.onMember = this.isMember(channel);
        switch (status & 0xf0) {
            case 0x80:
                this.noteOff(channel, event.data1);
                event.kind = 'NoteOff';
                break;
            case 0x90:
                if (event.data2 === 0) {
                    // Velocity 0 is a note-off by the spec. The app never
                    // sends one, so it is shown as what it means.
                    this.noteOff(channel, event.data1);
                    event.kind = 'NoteOff';
                } else {
                    this.noteOn(channel, event.data1);
                    event.kind = 'NoteOn';
                }
                break;
            case 0xa0:
                this.channels[channel].counts[COUNT_POLY_PRESSURE]++;
                event.kind = 'PolyPressure';
                break;
            case 0xb0:
                this.controlChange(channel, event.data1, event.data2, event);
                break;
            case 0xc0:
                event.kind = 'Program';
                break;
            case 0xd0:
                this.channels[channel].counts[COUNT_CHAN_PRESSURE]++;
                event.kind = 'ChanPressure';
                break;
            default: {
                const state = this.channels[channel];
                state.counts[COUNT_PB]++;
                event.kind = 'PitchBend';
                event.range = state.bendRange;
                event.rangeSource = state.rangeSource;
                event.semitones = bendToSemitones(event.data1 | (event.data2 << 7), event.range);
                if (channel !== DRUM_CHANNEL) this.exprChannels |= 1 << channel;
                this.checkMpeLike();
                break;
            }
        }
        return event;
    }

    private noteOn(channel: number, note: number): void {
        const state = this.channels[channel];
        state.counts[COUNT_NOTE_ON]++;
        this.notes++;
        if (this.mcmCount === 0) this.notesBeforeMcm++;

        if (this.isMaster(channel)) {
            this.masterNotes++;
            this.warn(
                'master-note',
                channel,
                `NoteOn ${noteName(note)} (${note}) on ch ${channel + 1}, the ${channel === 0 ? 'lower' : 'upper'} ` +
                    "zone's master channel - an MPE receiver treats it as zone-wide, so per-note bend and pressure do not apply"
            );
        } else if (this.isMember(channel)) {
            this.memberNoteChannels |= 1 << channel;
            if (state.heldCount > 0) {
                // The app keeps GM drums on channel 10 even inside a zone, so
                // two overlapping hits land here - worth saying, since the
                // warning is still true of what a receiver will do with them.
                const drums = channel === DRUM_CHANNEL ? ' (if these are GM drum hits on ch 10, that is expected)' : '';
                this.warn(
                    'second-held',
                    channel,
                    `second held note on member ch ${channel + 1} (${this.describeHeld(channel)} still held) - ` +
                        `its bend and pressure now move both notes${drums}`
                );
            }
        } else if ((this.lowerMembers > 0 || this.upperMembers > 0) && channel !== DRUM_CHANNEL) {
            const members = this.zones().flatMap((zone) => zone.members);
            this.warn('outside-zone', channel, `NoteOn on ch ${channel + 1}, outside the MPE zone (members ${formatChannels(members)})`);
        }

        state.held[note]++;
        state.heldCount++;
        if (channel !== DRUM_CHANNEL) this.noteChannels |= 1 << channel;
        this.checkMpeLike();
    }

    private noteOff(channel: number, note: number): void {
        const state = this.channels[channel];
        state.counts[COUNT_NOTE_OFF]++;
        if (state.held[note] > 0) {
            state.held[note]--;
            state.heldCount--;
            return;
        }
        this.warn(
            'orphan-off',
            channel,
            `NoteOff ${noteName(note)} (${note}) on ch ${channel + 1} with no matching NoteOn on this connection ` +
                '(was the note-on lost, or sent before this socket opened?)'
        );
    }

    private describeHeld(channel: number): string {
        const held = this.channels[channel].held;
        const names: string[] = [];
        for (let note = 0; note < 128; note++) if (held[note] > 0) names.push(`${noteName(note)} (${note})`);
        return names.join(', ');
    }

    private controlChange(channel: number, controller: number, value: number, event: MidiEvent): void {
        const state = this.channels[channel];
        event.kind = 'ControlChange';
        switch (controller) {
            case 101:
                state.rpn = (value << 7) | (state.rpn & 0x7f);
                state.paramType = PARAM_RPN;
                event.kind = 'ParamSelect';
                return;
            case 100:
                state.rpn = (state.rpn & ~0x7f) | value;
                state.paramType = PARAM_RPN;
                event.kind = 'ParamSelect';
                return;
            case 99:
                state.nrpn = (value << 7) | (state.nrpn & 0x7f);
                state.paramType = PARAM_NRPN;
                event.kind = 'ParamSelect';
                return;
            case 98:
                state.nrpn = (state.nrpn & ~0x7f) | value;
                state.paramType = PARAM_NRPN;
                event.kind = 'ParamSelect';
                return;
            case 6:
            case 38:
                this.dataEntry(channel, controller === 38, value, event);
                return;
            case 74:
                state.counts[COUNT_CC74]++;
                if (channel !== DRUM_CHANNEL) this.exprChannels |= 1 << channel;
                this.checkMpeLike();
                return;
            case 1:
                state.counts[COUNT_CC1]++;
                return;
            case 11:
                state.counts[COUNT_CC11]++;
                return;
            case 120:
            case 123:
                // A receiver ends every note on the channel here, so they are
                // no longer held and a later note-off for one is not an orphan
                // in its eyes either - but it is still counted as one here,
                // because the app sends its note-offs BEFORE its panic.
                state.held.fill(0);
                state.heldCount = 0;
                return;
            default:
                return;
        }
    }

    private dataEntry(channel: number, lsb: boolean, value: number, event: MidiEvent): void {
        const state = this.channels[channel];
        if (state.paramType === PARAM_RPN && state.rpn !== NULL_PARAM) {
            event.param = state.rpn;
            if (state.rpn === 0) {
                if (lsb) state.bendCents = value;
                else {
                    state.bendSemitones = value;
                    state.bendCents = 0;
                }
                state.rangeSource = 'rpn';
                state.rpnRange = state.bendRange;
                event.kind = 'BendRange';
                event.range = state.bendRange;
                event.rangeSource = 'rpn';
                return;
            }
            if (state.rpn === 6 && !lsb) {
                if (channel !== 0 && channel !== 15) {
                    event.kind = 'RpnData';
                    this.warn(
                        'mcm-channel',
                        channel,
                        `MCM (RPN 6) on ch ${channel + 1} is ignored by receivers - only ch 1 (lower zone) ` +
                            'or ch 16 (upper zone) can be a zone master'
                    );
                    return;
                }
                this.applyMcm(channel === 0 ? 'lower' : 'upper', value, event);
                return;
            }
            event.kind = 'RpnData';
            return;
        }
        if (state.paramType === PARAM_NRPN && state.nrpn !== NULL_PARAM) {
            event.param = state.nrpn;
            event.kind = 'NrpnData';
        }
        // Otherwise a data entry with nothing selected: a plain CC 6 or 38,
        // which is exactly what the app's RPN null exists to make it.
    }

    private applyMcm(zone: MpeZone, value: number, event: MidiEvent): void {
        const members = Math.min(15, value);
        this.mcmCount++;
        // The MPE spec: a zone that grows into the other shrinks it, and there
        // are fourteen member channels between two masters.
        if (zone === 'lower') {
            this.lowerMembers = members;
            if (this.upperMembers > 0 && members + this.upperMembers > 14) this.upperMembers = Math.max(0, 14 - members);
        } else {
            this.upperMembers = members;
            if (this.lowerMembers > 0 && members + this.lowerMembers > 14) this.lowerMembers = Math.max(0, 14 - members);
        }
        if (members > 0) {
            this.lastZones = this.zones();
            // What an MCM implies until RPN 0 says otherwise.
            const info = zonesFor(zone === 'lower' ? members : 0, zone === 'upper' ? members : 0)[0];
            this.setImpliedRange(info.master, MPE_MASTER_RANGE);
            for (const member of info.members) this.setImpliedRange(member, MPE_MEMBER_RANGE);
        }
        event.kind = 'MCM';
        event.zone = zone;
        event.members = members;
    }

    private setImpliedRange(channel: number, semitones: number): void {
        const state = this.channels[channel];
        state.bendSemitones = semitones;
        state.bendCents = 0;
        state.rangeSource = 'mcm';
    }

    /**
     * Notes and per-channel bend or slide on several channels, with no MCM:
     * MPE-shaped traffic a receiver has not been told is MPE. The usual cause
     * is the MCM being lost - the app queues while its socket is still
     * connecting, and a queue that overflowed dropped the oldest messages
     * first, which is the configuration. Said once per connection.
     */
    private checkMpeLike(): void {
        if (this.mpeLike || this.mcmCount > 0) return;
        const notes = this.noteChannels & ~DRUM_BIT;
        const expression = this.exprChannels & ~DRUM_BIT;
        if (bitCount(notes) < 2 || bitCount(expression) < 2) return;
        this.mpeLike = true;
        this.warn(
            'no-mcm',
            -1,
            `notes with their own bend/slide on ${bitCount(notes)} channels (${formatChannels(channelsOf(notes))}) ` +
                'but no MPE Configuration Message on this connection - a receiver will not treat them as one MPE ' +
                'instrument. Was the output chosen while the bridge was still connecting?'
        );
    }

    private warn(kind: WarningKind, channel: number, text: string): void {
        this.count(kind, channel);
        this.warnings.push(text);
        this.warningKinds.push(kind);
        this.warningChannels.push(channel);
    }

    private frameWarning(kind: WarningKind, text: string): void {
        this.count(kind, -1);
        this.frameWarnings.push(text);
        this.frameWarningKinds.push(kind);
    }

    private count(kind: WarningKind, channel: number): void {
        this.warningCount++;
        const key = `${kind}:${channel}`;
        const entry = this.tally.get(key);
        if (entry) entry.count++;
        else this.tally.set(key, { kind, channel, count: 1 });
    }

    /**
     * @param ended says whether the bridge itself ended a note still held at
     *   the close (server.ts sends a NoteOff, or All Notes Off on its channel).
     *   Such a note is reported but is no longer a problem: nothing is left
     *   hanging in the DAW. Absent, every held note is one.
     */
    summary(ended?: (channel: number, note: number) => boolean): MpeSummary {
        const zonesActive = this.lowerMembers > 0 || this.upperMembers > 0;
        const zones = zonesActive ? this.zones() : this.lastZones;

        const masters = zones.map((zone) => zone.master);
        const members = zones.flatMap((zone) => zone.members);
        const groups: ChannelGroup[] = [];
        const sum = (channels: number[]): number[] => {
            const totals = new Array<number>(COUNTER_LABELS.length).fill(0);
            for (const channel of channels) {
                const counts = this.channels[channel].counts;
                for (let i = 0; i < totals.length; i++) totals[i] += counts[i];
            }
            return totals;
        };
        const active = (channel: number): boolean => this.channels[channel].counts.some((count) => count > 0);
        if (zones.length > 0) {
            groups.push({ name: 'master', channels: masters, counts: sum(masters) });
            groups.push({ name: 'members', channels: members, counts: sum(members) });
        }
        const others: number[] = [];
        for (let channel = 0; channel < 16; channel++) {
            if (!masters.includes(channel) && !members.includes(channel) && active(channel)) others.push(channel);
        }
        if (others.length > 0) groups.push({ name: zones.length > 0 ? 'other' : 'channels', channels: others, counts: sum(others) });

        const held: { channel: number; note: number }[] = [];
        for (let channel = 0; channel < 16; channel++) {
            const state = this.channels[channel];
            if (state.heldCount === 0) continue;
            for (let note = 0; note < 128; note++) if (state.held[note] > 0) held.push({ channel, note });
        }

        const hanging = ended ? held.filter(({ channel, note }) => !ended(channel, note)) : held;
        const problems: string[] = [];
        if (hanging.length > 0) {
            const names = hanging.slice(0, 6).map(({ channel, note }) => `ch ${channel + 1} ${noteName(note)}`);
            problems.push(
                `${hanging.length} note(s) still held when the connection closed (${names.join(', ')}${hanging.length > 6 ? ', ...' : ''}) ` +
                    '- the DAW may keep them sounding'
            );
        }
        if (this.mcmCount === 0 && this.mpeLike) {
            problems.push('notes used several channels with their own bend/slide but no MCM arrived');
        }
        if (this.mcmCount > 0 && this.notesBeforeMcm > 0) {
            problems.push(`${this.notesBeforeMcm} note(s) arrived before the first MCM`);
        }
        if (this.masterNotes > 0) problems.push(`${this.masterNotes} note(s) on a zone master channel`);
        if (this.drops > 0) problems.push(`${this.drops} frame(s) dropped`);
        if (this.warningCount > 0) problems.push(`${this.warningCount} warning(s) in total`);

        const usesMpe = this.mcmCount > 0 || this.mpeLike;
        let verdict: string;
        if (this.messages === 0 && this.drops === 0) verdict = 'MPE: nothing received on this connection';
        else if (!usesMpe) {
            verdict = problems.length === 0 ? 'MPE: not used (plain MIDI) - OK' : `MPE: not used (plain MIDI) - CHECK: ${problems.join('; ')}`;
        } else verdict = problems.length === 0 ? 'MPE: OK' : `MPE: CHECK - ${problems.join('; ')}`;

        return {
            messages: this.messages,
            frames: this.frames,
            drops: this.drops,
            mcmCount: this.mcmCount,
            zones,
            zonesActive,
            notes: this.notes,
            notesBeforeMcm: this.notesBeforeMcm,
            masterNotes: this.masterNotes,
            mpeLike: this.mpeLike,
            rpnRanges: this.channels.map((state) => (Number.isNaN(state.rpnRange) ? null : state.rpnRange)),
            membersUsed: channelsOf(this.memberNoteChannels),
            groups,
            held,
            endedByBridge: held.length - hanging.length,
            warnings: this.warningCount,
            warningCounts: [...this.tally.values()]
                .map((entry) => ({ ...entry }))
                .sort((a, b) => b.count - a.count || a.channel - b.channel),
            problems,
            verdict,
            ok: problems.length === 0 && this.messages > 0,
        };
    }
}

function zonesFor(lower: number, upper: number): ZoneInfo[] {
    const zones: ZoneInfo[] = [];
    if (lower > 0) zones.push({ zone: 'lower', master: 0, members: Array.from({ length: lower }, (_, i) => 1 + i) });
    if (upper > 0) zones.push({ zone: 'upper', master: 15, members: Array.from({ length: upper }, (_, i) => 14 - i) });
    return zones;
}

/** The least detailed level a message is shown at. */
export function levelOf(event: MidiEvent): MidiLogLevel {
    switch (event.kind) {
        case 'NoteOn':
        case 'NoteOff':
        case 'MCM':
        case 'RpnData':
        case 'NrpnData':
        case 'Program':
        case 'Incomplete':
            return 'notes';
        case 'BendRange':
            // The fractional half of a range is noise when it is zero, which
            // is every time the app sends it.
            return event.data1 === 38 && event.data2 === 0 ? 'all' : 'notes';
        case 'PitchBend':
        case 'ChanPressure':
        case 'PolyPressure':
            return 'expr';
        case 'ControlChange': {
            const controller = event.data1;
            if (controller === 64 || controller >= 120) return 'notes';
            if (controller === 74 || controller === 1 || controller === 11) return 'expr';
            return 'all';
        }
        default:
            return 'all';
    }
}

// The continuous streams coalescing applies to, as a slot index per channel.
const COALESCE_TYPES = 6;
const COALESCE_POLY = 2;
function coalesceType(event: MidiEvent): number {
    switch (event.kind) {
        case 'PitchBend':
            return 0;
        case 'ChanPressure':
            return 1;
        case 'PolyPressure':
            return COALESCE_POLY;
        case 'ControlChange':
            if (event.data1 === 74) return 3;
            if (event.data1 === 1) return 4;
            if (event.data1 === 11) return 5;
            return -1;
        default:
            return -1;
    }
}

function pad(label: string): string {
    return `${label.padEnd(10)} `;
}

/** The part of a line after the channel column: what the message means. */
export function describe(event: MidiEvent, bytes?: readonly number[]): string {
    const { data1, data2 } = event;
    switch (event.kind) {
        case 'NoteOn':
        case 'NoteOff': {
            let text = `${pad(event.kind)}${noteName(data1)} (${data1})  vel ${data2}`;
            if (event.kind === 'NoteOff' && (event.status & 0xf0) === 0x90) text += ' (NoteOn vel 0)';
            // Inside an MPE zone channel 10 is a member like any other, and a
            // note there is a pitch: naming it "Tambourine" sent somebody
            // reading a live MPE log looking for a drum kit that was not there.
            if (event.channel === DRUM_CHANNEL && !event.onMember) {
                const drum = GM_DRUMS[data1];
                text += drum ? `  (drums, GM: ${drum})` : '  (drums, GM)';
            }
            return text;
        }
        case 'PolyPressure':
            return `${pad('PolyPressure')}${noteName(data1)} (${data1}) = ${data2}`;
        case 'ChanPressure':
            return `${pad('ChanPressure')}${data1}`;
        case 'Program':
            return `${pad('Program')}${data1}`;
        case 'PitchBend': {
            const raw = data1 | (data2 << 7);
            const source = event.rangeSource === 'mcm' ? ' MPE default' : event.rangeSource === 'assumed' ? ' assumed' : '';
            const range = `range +/-${formatRange(event.range)}${source}`;
            const amount = raw === BEND_CENTRE ? 'centre' : `${signed(event.semitones, 2)} st`;
            return `${pad('PitchBend')}${amount} (raw ${raw}, ${range})${event.onMaster ? ' zone-wide' : ''}`;
        }
        case 'MCM': {
            if (event.members === 0) return `MCM: ${event.zone} zone released (0 member channels)`;
            const zone = zonesFor(event.zone === 'lower' ? event.members : 0, event.zone === 'upper' ? event.members : 0)[0];
            return `MCM: ${event.zone} zone, ${event.members} member channel${event.members === 1 ? '' : 's'} (${formatChannels(zone.members)})`;
        }
        case 'BendRange':
            return data1 === 38
                ? `RPN 0 pitch-bend range cents = ${data2} (range +/-${formatRange(event.range)} st)`
                : `RPN 0 pitch-bend range = ${data2} st`;
        case 'RpnData': {
            const name = RPN_NAMES[event.param];
            return `RPN ${event.param >> 7}/${event.param & 0x7f}${name ? ` ${name}` : ''} ${data1 === 38 ? 'LSB ' : ''}= ${data2}`;
        }
        case 'NrpnData':
            return `NRPN ${event.param >> 7}/${event.param & 0x7f} ${data1 === 38 ? 'LSB ' : ''}= ${data2}`;
        case 'ParamSelect': {
            const name = ccName(data1) ?? '';
            return `CC ${data1} ${name} = ${data2}${data2 === 127 ? ' (null)' : ''}`;
        }
        case 'ControlChange': {
            const name = ccName(data1);
            if (data1 >= 64 && data1 <= 69) return `CC ${data1} ${name} ${data2 >= 64 ? 'on' : 'off'}`;
            if (data1 >= 120 && data1 !== 122 && data1 !== 126) return `CC ${data1} ${name}${data2 !== 0 ? ` (${data2})` : ''}`;
            return name ? `CC ${data1} ${name} = ${data2}` : `CC ${data1} = ${data2}`;
        }
        case 'Realtime':
        case 'System': {
            const name = SYSTEM_NAMES[event.status] ?? 'Undefined';
            if (event.status === 0xf2) return `${pad(name)}${data1 | (data2 << 7)}`;
            if (event.status === 0xf1 || event.status === 0xf3) return `${pad(name)}${data1}`;
            return `${name} (${hex(event.status)})`;
        }
        case 'Stray':
            return `Stray data ${bytes ? hexBytes(bytes, event.start, event.start + event.length) : hex(data1)} (no status byte)`;
        case 'Incomplete':
            return `${statusName(event.status)} incomplete (${event.length} of ${messageLength(event.status)} bytes)`;
    }
}

function channelColumn(channel: number): string {
    return channel >= 0 ? `ch ${String(channel + 1).padEnd(2)}  ` : 'sys    ';
}

/** A departure LeadBaseline.observe decided is worth a word; NaN prints nothing. */
function leadSuffix(departure: number): string {
    if (Number.isNaN(departure)) return '';
    const ms = Math.round(departure);
    return ms > 0 ? `  +${ms} ms ahead` : `  ${ms} ms behind`;
}

/** Recent on-time frames the baseline is measured over. */
const BASELINE_WINDOW = 32;
/** Frames that feed the baseline before any line is measured against it, and before it is announced. */
export const BASELINE_SETTLE_FRAMES = 8;
/**
 * Further ahead of the baseline than this, a frame was SENT early - stamped
 * for the future by its sender - rather than delivered fast: network delay only
 * ever makes a frame later, and the baseline is already a fast delivery. Such
 * a frame is reported and kept out of the baseline, so a sequencer that sends
 * every step 1.4 s early goes on being reported for as long as it does it,
 * rather than quietly becoming the new normal. Everything nearer than this
 * feeds the baseline, which is what lets it follow a real change: a Wi-Fi
 * radio waking up, or the two clocks drifting apart over a long session.
 */
const SCHEDULED_AHEAD_MS = 250;

/**
 * What "on time" means on one connection.
 *
 * A frame's lead is its t minus how long after the socket was accepted it
 * arrived here. That is never zero for an on-time frame, because the two ends
 * start their clocks at different moments: the phone when its socket opens,
 * after the handshake has come back to it, and this end when it accepted - and
 * then every frame spends a trip on the network. So a connection has a steady
 * lead of its own, the same on every line, which the log used to print on
 * every line: "+59 ms ahead" on a phone playing live, where nothing was ahead
 * of anything.
 *
 * The baseline is that steady lead, measured from the FASTEST recent delivery:
 * the largest lead among the last 32 on-time frames. Network delay only ever
 * makes a frame later, so a frame's lead is the offset minus its own delay,
 * and the frame delayed least is the one closest to the offset itself - the
 * minimum-delay filter clock synchronisation has always used. Anything
 * gentler lags behind the truth and reads frames that merely got through
 * quickly as early: a median (the first version) did it to half of phone
 * Wi-Fi's frames, and a high percentile did it for a handful of lines at the
 * start of every connection, whose setup burst arrives while this end is
 * still re-opening the port and so looks late. The cost is that a frame
 * really sent up to SCHEDULED_AHEAD_MS early raises the baseline for a window
 * - which only a sender that stamps frames for the future does, and the app
 * no longer does. A line says "ahead" only when its frame departs from the
 * baseline by more than LEAD_REPORT_MS, and "behind" past LATE_REPORT_MS.
 */
export class LeadBaseline {
    private readonly window = new Float64Array(BASELINE_WINDOW);
    private size = 0;
    private next = 0;
    /** Frames that have fed the baseline. */
    samples = 0;
    /** The largest lead of recent on-time frames, in ms; NaN before the first frame. */
    value = Number.NaN;
    /** The baseline the last frame was measured against; NaN before there was one. */
    reference = Number.NaN;
    /** The last frame's lead minus the baseline before it; NaN before there was one. */
    lastDeparture = Number.NaN;
    /** Frames reported, and the furthest each way. */
    ahead = 0;
    maxAhead = 0;
    behind = 0;
    maxBehind = 0;

    get settled(): boolean {
        return this.samples >= BASELINE_SETTLE_FRAMES;
    }

    /**
     * Takes one frame's lead. Returns how far it departs from the baseline as
     * it stood before this frame when that is worth printing, and NaN when it
     * is not: before the baseline has settled, or within LEAD_REPORT_MS ahead
     * and LATE_REPORT_MS behind.
     */
    observe(lead: number): number {
        if (!Number.isFinite(lead)) {
            this.lastDeparture = Number.NaN;
            return Number.NaN;
        }
        const settled = this.settled;
        const departure = Number.isNaN(this.value) ? 0 : lead - this.value;
        this.reference = Number.isNaN(this.value) ? lead : this.value;
        this.lastDeparture = departure;
        if (departure <= SCHEDULED_AHEAD_MS) this.add(lead);
        if (!settled) return Number.NaN;
        if (departure > LEAD_REPORT_MS) {
            this.ahead++;
            this.maxAhead = Math.max(this.maxAhead, departure);
            return departure;
        }
        if (departure < -LATE_REPORT_MS) {
            this.behind++;
            this.maxBehind = Math.max(this.maxBehind, -departure);
            return departure;
        }
        return Number.NaN;
    }

    private add(lead: number): void {
        this.window[this.next] = lead;
        this.next = (this.next + 1) % BASELINE_WINDOW;
        if (this.size < BASELINE_WINDOW) this.size++;
        this.samples++;
        // Over the window rather than a running maximum, so a fast frame from
        // a minute ago stops counting and the baseline follows the clocks
        // drifting down as well as up. Thirty-two numbers; nothing allocated.
        let max = -Infinity;
        for (let i = 0; i < this.size; i++) if (this.window[i] > max) max = this.window[i];
        this.value = max;
    }
}

/** A lead in ms, signed and rounded: "+59", "-3", "0". */
function signedMs(ms: number): string {
    const rounded = Math.round(ms);
    return rounded > 0 ? `+${rounded}` : String(rounded);
}

function two(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

/** Local wall-clock time, HH:MM:SS.mmm. */
export function formatClock(ms: number): string {
    const date = new Date(ms);
    const millis = date.getMilliseconds();
    return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${millis < 10 ? '00' : millis < 100 ? '0' : ''}${millis}`;
}

/** Everything the server knows about one forwarded frame. */
export interface MidiLogMessage {
    connId: number;
    portName: string;
    claim: string | null;
    client: string;
    /** The frame's own t: ms since the socket opened, on the phone's clock. */
    t: number;
    bytes: readonly number[];
    /** performance.now() on this machine when the frame arrived, and when its socket did. */
    receivedAt: number;
    openedAt: number;
}

export interface MidiLogDrop {
    connId: number;
    portName: string;
    reason: string;
    raw?: string;
}

export interface MidiLogClose {
    connId: number;
    portName: string;
    claim: string | null;
    client: string;
    openedAt: number;
    closedAt: number;
    code?: number;
    /**
     * What the server wrote to the port on its own to end what this
     * connection left sounding (server.ts, HeldNotes.releaseMessages). These
     * bytes never pass through message(), so without them the log's record of
     * what the port received would stop one step short, and the summary would
     * call a note hanging that the bridge had already ended.
     */
    released?: readonly (readonly number[])[];
    /**
     * The bridge is shutting down and has already sent sustain off and All
     * Notes Off on every channel of every port (index.ts), which ended every
     * note this connection held. Said once on the console by the shutdown
     * itself, so no line of its own here - only the summary's count.
     */
    shutdown?: boolean;
}

/** What a connection's timing came to, for the summary. */
export interface TimingSummary {
    /** The baseline lead in ms, or NaN when no frame ever fed one. */
    baseline: number;
    /** Whether enough frames arrived for lines to be marked against it. */
    settled: boolean;
    ahead: number;
    maxAhead: number;
    behind: number;
    maxBehind: number;
}

export interface MidiLoggerOptions {
    /** What the console shows. null shows nothing, for a file-only log. */
    level: MidiLogLevel | null;
    write?: (line: string) => void;
    /** One structured record per message, drop and summary - the JSON Lines file. */
    record?: (entry: Record<string, unknown>) => void;
    /** See DEFAULT_COALESCE_MS. 0 turns coalescing off. */
    coalesceMs?: number;
    /** See WARNING_REPEAT_MS. 0 prints every warning. */
    warningRepeatMs?: number;
    platform?: string;
    /** Wall clock for the printed time, and for the warning windows. */
    now?: () => number;
}

interface PendingSlot {
    pending: boolean;
    /** Messages of this stream not printed since the last line that was. */
    hidden: number;
    lastPrinted: number;
    wall: number;
    /** How far the held-back frame departed from the baseline; NaN for no mark. */
    departure: number;
    event: MidiEvent;
}

/** One kind of warning on one channel, printed once and then counted until the window closes. */
interface WarningWindow {
    kind: WarningKind;
    channel: number;
    opened: number;
    /** Raised since the printed one, and not printed. */
    hidden: number;
}

interface Connection {
    id: number;
    portName: string;
    client: string;
    claim: string | null;
    tag: string;
    /** performance.now() when the socket opened, known from its first frame; NaN before one. */
    openedAt: number;
    decoder: MidiDecoder;
    /** Keyed by slotKey; a Map because poly pressure has a slot per note, and most never exist. */
    slots: Map<number, PendingSlot>;
    pendingCount: number;
    baseline: LeadBaseline;
    /** Whether the line explaining what "ahead" is measured from has been printed. */
    timingSaid: boolean;
    /** Keyed `${kind}:${channel}`. Empty for a connection that has raised nothing, which is the normal one. */
    warningWindows: Map<string, WarningWindow>;
}

/**
 * One coalescing stream: a channel and a type, and for poly pressure the note
 * too. Two notes' poly pressure are two streams, and giving them one slot made
 * each note's value push the other's out - so two pressed notes interleaving
 * printed every message, which is the flood coalescing is for.
 */
function slotKey(event: MidiEvent, type: number): number {
    const key = event.channel * COALESCE_TYPES + type;
    return type === COALESCE_POLY ? key * 128 + event.data1 : key;
}

/**
 * The console and file side: one decoder per connection, levels, coalescing
 * and the summary a connection gets when it closes.
 */
export class MidiLogger {
    private readonly level: MidiLogLevel | null;
    private readonly write: (line: string) => void;
    private readonly record?: (entry: Record<string, unknown>) => void;
    private readonly coalesceMs: number;
    private readonly warningRepeatMs: number;
    private readonly platform: string;
    private readonly now: () => number;
    private readonly connections = new Map<number, Connection>();
    /**
     * Connections already summarised. Shutdown summarises whatever is open and
     * the sockets' own close events can still arrive afterwards; without this
     * each would print a second, empty summary claiming nothing was received.
     */
    private readonly finished = new Set<number>();
    /** Scratch for flushConnection, reused so a flush allocates nothing. */
    private readonly waiting: PendingSlot[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: MidiLoggerOptions) {
        this.level = options.level;
        this.write = options.write ?? ((line) => console.log(line));
        this.record = options.record;
        this.coalesceMs = Math.max(0, options.coalesceMs ?? DEFAULT_COALESCE_MS);
        this.warningRepeatMs = Math.max(0, options.warningRepeatMs ?? WARNING_REPEAT_MS);
        this.platform = options.platform ?? process.platform;
        this.now = options.now ?? Date.now;
    }

    private connection(id: number, portName: string, client: string, claim: string | null): Connection {
        let connection = this.connections.get(id);
        if (!connection) {
            connection = {
                id,
                portName,
                client,
                claim,
                tag: `[${portName} #${id}]`,
                openedAt: Number.NaN,
                decoder: new MidiDecoder(this.platform),
                slots: new Map(),
                pendingCount: 0,
                baseline: new LeadBaseline(),
                timingSaid: false,
                warningWindows: new Map(),
            };
            this.connections.set(id, connection);
        } else if (!connection.client && client) {
            // Made by a drop, which knows no client; the first forwarded frame
            // does, and every record after it should carry it.
            connection.client = client;
            connection.claim = claim;
        }
        return connection;
    }

    message(info: MidiLogMessage): void {
        const connection = this.connection(info.connId, info.portName, info.client, info.claim);
        connection.openedAt = info.openedAt;
        const decoder = connection.decoder;
        const wall = this.now();
        const lead = info.t - (info.receivedAt - info.openedAt);
        // Once per frame, not per message: a frame is one arrival.
        const departure = connection.baseline.observe(lead);
        const baselineMs = connection.baseline.settled ? Math.round(connection.baseline.reference) : undefined;
        const count = decoder.beginFrame(info.bytes);
        if (this.level !== null) {
            // A repeated warning's window that has run out says how many it
            // swallowed now, rather than whenever the kind next comes round.
            if (connection.warningWindows.size > 0) this.closeWarningWindows(connection, wall, false);
            decoder.frameWarnings.forEach((warning, i) => this.warning(connection, wall, warning, decoder.frameWarningKinds[i], -1));
        }

        for (let index = 0; index < count; index++) {
            const event = decoder.decodeMessage(info.bytes, index);
            if (this.record) {
                const warnings = index === 0 ? [...decoder.frameWarnings, ...decoder.warnings] : [...decoder.warnings];
                this.record(entryFor(connection, info, wall, lead, baselineMs, event, warnings, count));
            }
            if (this.level === null) continue;
            this.show(connection, event, wall, departure, info.bytes);
            decoder.warnings.forEach((warning, i) =>
                this.warning(connection, wall, warning, decoder.warningKinds[i], decoder.warningChannels[i])
            );
        }
    }

    drop(info: MidiLogDrop): void {
        const connection = this.connections.get(info.connId) ?? this.connection(info.connId, info.portName, '', null);
        connection.decoder.noteDrop();
        const wall = this.now();
        const raw = info.raw === undefined ? '' : `: ${info.raw.length > 80 ? `${info.raw.slice(0, 80)}...` : info.raw}`;
        if (this.level !== null) this.warning(connection, wall, `dropped frame, ${info.reason}${raw}`, 'drop', -1);
        this.record?.({
            type: 'drop',
            time: new Date(wall).toISOString(),
            conn: connection.id,
            port: connection.portName,
            reason: info.reason,
            raw: info.raw === undefined ? undefined : info.raw.slice(0, 256),
        });
    }

    /** Prints what is still held back, then the connection's summary. */
    close(info: MidiLogClose): void {
        if (this.finished.has(info.connId)) return;
        this.finished.add(info.connId);
        const connection = this.connection(info.connId, info.portName, info.client, info.claim);
        this.flushPending();
        this.connections.delete(info.connId);
        const wall = this.now();
        const released = info.released ?? [];
        const summary = connection.decoder.summary(
            info.shutdown ? () => true : released.length > 0 ? endedBy(released) : undefined
        );
        const timing = timingOf(connection.baseline);
        const seconds = Math.round(Math.max(0, info.closedAt - info.openedAt)) / 1000;
        if (this.level !== null) {
            this.closeWarningWindows(connection, wall, true);
            if (released.length > 0) this.write(`${formatClock(wall)} ${connection.tag} ${describeRelease(released)}`);
            for (const line of formatSummary(summary, { client: info.client, seconds, code: info.code, timing })) {
                this.write(`${formatClock(wall)} ${connection.tag} ${line}`);
            }
        }
        if (released.length > 0) {
            this.record?.({
                type: 'release',
                time: new Date(wall).toISOString(),
                conn: connection.id,
                port: connection.portName,
                messages: released.map((bytes) => [...bytes]),
            });
        }
        this.record?.({
            type: 'summary',
            time: new Date(wall).toISOString(),
            conn: connection.id,
            port: connection.portName,
            client: info.client,
            claim: info.claim,
            seconds,
            code: info.code,
            ...summary,
            timing: {
                baselineMs: Number.isNaN(timing.baseline) ? null : Math.round(timing.baseline),
                settled: timing.settled,
                ahead: timing.ahead,
                maxAheadMs: Math.round(timing.maxAhead),
                behind: timing.behind,
                maxBehindMs: Math.round(timing.maxBehind),
            },
            rpnRanges: Object.fromEntries(
                summary.rpnRanges.flatMap((range, channel) => (range === null ? [] : [[String(channel + 1), range]]))
            ),
            membersUsed: summary.membersUsed.map((channel) => channel + 1),
            zones: summary.zones.map((zone) => ({ ...zone, master: zone.master + 1, members: zone.members.map((c) => c + 1) })),
            groups: summary.groups.map((group) => ({
                name: group.name,
                channels: group.channels.map((c) => c + 1),
                counts: Object.fromEntries(COUNTER_LABELS.map((label, i) => [label, group.counts[i]])),
            })),
            held: summary.held.map(({ channel, note }) => ({ ch: channel + 1, note })),
        });
    }

    /**
     * Summaries for every connection still open - the bridge is shutting down.
     *
     * @param shutdown the caller has sent its whole-port panic, so no note of
     *   any connection is left hanging (see MidiLogClose.shutdown).
     */
    closeAll(closedAt: number, shutdown = false): void {
        for (const connection of [...this.connections.values()]) {
            this.close({
                connId: connection.id,
                portName: connection.portName,
                claim: connection.claim,
                client: connection.client,
                openedAt: Number.isNaN(connection.openedAt) ? closedAt : connection.openedAt,
                closedAt,
                shutdown,
            });
        }
        this.stopTimer();
    }

    /** Prints every coalesced line still waiting. */
    flush(): void {
        this.stopTimer();
        this.flushPending();
    }

    private stopTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private show(connection: Connection, event: MidiEvent, wall: number, departure: number, bytes: readonly number[]): void {
        const level = this.level as MidiLogLevel;
        if (LEVEL_RANK[levelOf(event)] > LEVEL_RANK[level]) return;
        if (level === 'expr' && this.coalesceMs > 0) {
            const type = coalesceType(event);
            if (type >= 0) {
                this.coalesce(connection, event, type, wall, departure);
                return;
            }
        }
        // Whatever the streams were holding back arrived first, so it prints
        // first - the last bend of a slide lands above its note-off, and the
        // log reads in the order things happened.
        this.flushPending();
        const hexText = level === 'all' ? `  | ${hexBytes(bytes, event.start, event.start + event.length)}` : '';
        const mark = this.mark(connection, departure, wall);
        this.write(`${formatClock(wall)} ${connection.tag} ${channelColumn(event.channel)}${describe(event, bytes)}${mark}${hexText}`);
    }

    /**
     * The "+N ms ahead" / "-N ms behind" a line ends with, or nothing.
     *
     * The first time a connection has one, a line saying what it is measured
     * from goes above it: a mark is relative to this connection's usual lead,
     * and a reader who does not know that reads "+30 ms ahead" as thirty
     * milliseconds, not thirty past a baseline of fifty-nine.
     */
    private mark(connection: Connection, departure: number, wall: number): string {
        const suffix = leadSuffix(departure);
        if (suffix && !connection.timingSaid) {
            connection.timingSaid = true;
            this.write(
                `${formatClock(wall)} ${connection.tag} timing: frames on this connection usually arrive with t ` +
                    `${signedMs(connection.baseline.reference)} ms from their arrival (the two clocks' offset plus the ` +
                    `network trip); "ahead" and "behind" below are measured from that`
            );
        }
        return suffix;
    }

    private coalesce(connection: Connection, event: MidiEvent, type: number, wall: number, departure: number): void {
        const key = slotKey(event, type);
        let slot = connection.slots.get(key);
        if (!slot) {
            slot = { pending: false, hidden: 0, lastPrinted: -Infinity, wall: 0, departure: Number.NaN, event: blankEvent() };
            connection.slots.set(key, slot);
        }

        if (wall - slot.lastPrinted >= this.coalesceMs) {
            // This stream's own held-back value is superseded rather than
            // printed; every other stream's arrived earlier and prints first.
            if (slot.pending) {
                slot.pending = false;
                slot.hidden++;
                connection.pendingCount--;
            }
            this.flushPending();
            const mark = this.mark(connection, departure, wall);
            this.write(
                `${formatClock(wall)} ${connection.tag} ${channelColumn(event.channel)}${describe(event)}${mark}${hiddenSuffix(slot.hidden)}`
            );
            slot.hidden = 0;
            slot.lastPrinted = wall;
            return;
        }
        if (slot.pending) slot.hidden++;
        else {
            slot.pending = true;
            connection.pendingCount++;
        }
        copyEvent(slot.event, event);
        slot.wall = wall;
        slot.departure = departure;
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null;
                this.flushPending();
            }, this.coalesceMs);
            // A log must never be what keeps the process alive.
            this.timer.unref?.();
        }
    }

    private printSlot(connection: Connection, slot: PendingSlot): void {
        if (!slot.pending) return;
        const mark = this.mark(connection, slot.departure, slot.wall);
        this.write(
            `${formatClock(slot.wall)} ${connection.tag} ${channelColumn(slot.event.channel)}${describe(slot.event)}${mark}${hiddenSuffix(slot.hidden)}`
        );
        slot.pending = false;
        slot.hidden = 0;
        slot.lastPrinted = this.now();
        connection.pendingCount--;
    }

    private flushPending(): void {
        if (this.pendingTotal() === 0) return;
        for (const connection of this.connections.values()) this.flushConnection(connection);
    }

    private pendingTotal(): number {
        let total = 0;
        for (const connection of this.connections.values()) total += connection.pendingCount;
        return total;
    }

    /** In arrival order, so held-back lines from several streams still read chronologically. */
    private flushConnection(connection: Connection): void {
        if (connection.pendingCount === 0) return;
        const waiting = this.waiting;
        for (const slot of connection.slots.values()) if (slot.pending) waiting.push(slot);
        waiting.sort((a, b) => a.wall - b.wall);
        for (const slot of waiting) this.printSlot(connection, slot);
        waiting.length = 0;
    }

    /**
     * Prints a warning - the first of its kind on its channel in full, and
     * any more inside WARNING_REPEAT_MS as a count. Take Studio's plain notes
     * on a zone master, or a kit's overlapping hits on channel 10, raise the
     * same warning once a note for as long as a loop plays; printed each time
     * they are a line a beat that buries the one warning that is new.
     */
    private warning(connection: Connection, wall: number, text: string, kind: WarningKind, channel: number): void {
        this.flushPending();
        if (this.warningRepeatMs > 0) {
            const key = `${kind}:${channel}`;
            const open = connection.warningWindows.get(key);
            if (open && wall - open.opened < this.warningRepeatMs) {
                open.hidden++;
                return;
            }
            if (open) this.closeWarningWindow(connection, key, open, wall);
            connection.warningWindows.set(key, { kind, channel, opened: wall, hidden: 0 });
        }
        this.write(`${formatClock(wall)} ${connection.tag} ! ${text}`);
    }

    /** Ends the windows that have run out - or every one, at a close - saying what each held back. */
    private closeWarningWindows(connection: Connection, wall: number, all: boolean): void {
        for (const [key, window] of connection.warningWindows) {
            if (all || wall - window.opened >= this.warningRepeatMs) this.closeWarningWindow(connection, key, window, wall);
        }
    }

    private closeWarningWindow(connection: Connection, key: string, window: WarningWindow, wall: number): void {
        connection.warningWindows.delete(key);
        if (window.hidden === 0) return;
        this.flushPending();
        const where = window.channel >= 0 ? ` on ch ${window.channel + 1}` : '';
        const span = (Math.min(wall - window.opened, this.warningRepeatMs) / 1000).toFixed(1);
        this.write(
            `${formatClock(wall)} ${connection.tag} ! [+${window.hidden} more] ${WARNING_LABELS[window.kind]}${where} ` +
                `within ${span} s of the one above (every count is in the summary)`
        );
    }
}

function hiddenSuffix(hidden: number): string {
    return hidden > 0 ? `  [+${hidden} not shown]` : '';
}

/** Whether the bridge's own release ended a note: a NoteOff for it, or All Notes Off on its channel. */
function endedBy(released: readonly (readonly number[])[]): (channel: number, note: number) => boolean {
    const notes = new Set<number>();
    let cleared = 0;
    for (const bytes of released) {
        const type = bytes[0] & 0xf0;
        const channel = bytes[0] & 0x0f;
        if (type === 0x80 || (type === 0x90 && bytes[2] === 0)) notes.add(channel * 128 + bytes[1]);
        else if (type === 0xb0 && (bytes[1] === 123 || bytes[1] === 120)) cleared |= 1 << channel;
    }
    return (channel, note) => notes.has(channel * 128 + note) || (cleared & (1 << channel)) !== 0;
}

/** One line for what the server sent when the socket closed, since none of it passed through message(). */
function describeRelease(released: readonly (readonly number[])[]): string {
    const offs: string[] = [];
    let pedal = 0;
    let panic = 0;
    for (const bytes of released) {
        const type = bytes[0] & 0xf0;
        const channel = bytes[0] & 0x0f;
        if (type === 0x80) offs.push(`ch ${channel + 1} ${noteName(bytes[1])} (${bytes[1]})`);
        else if (type === 0xb0 && bytes[1] === 64) pedal |= 1 << channel;
        else if (type === 0xb0 && bytes[1] === 123) panic |= 1 << channel;
    }
    const parts: string[] = [];
    if (offs.length > 0) parts.push(`NoteOff for ${offs.length} note(s) it left held (${offs.join(', ')})`);
    if (pedal) parts.push(`CC 64 Sustain off on ${formatChannels(channelsOf(pedal))}`);
    if (panic) parts.push(`CC 123 All Notes Off on ${formatChannels(channelsOf(panic))}`);
    return `bridge: the socket closed, so the bridge itself sent ${parts.join('; ')}`;
}

function timingOf(baseline: LeadBaseline): TimingSummary {
    return {
        baseline: baseline.value,
        settled: baseline.settled,
        ahead: baseline.ahead,
        maxAhead: baseline.maxAhead,
        behind: baseline.behind,
        maxBehind: baseline.maxBehind,
    };
}

function entryFor(
    connection: Connection,
    info: MidiLogMessage,
    wall: number,
    lead: number,
    baselineMs: number | undefined,
    event: MidiEvent,
    warnings: string[],
    count: number
): Record<string, unknown> {
    const entry: Record<string, unknown> = {
        type: 'midi',
        time: new Date(wall).toISOString(),
        conn: connection.id,
        port: connection.portName,
        client: connection.client,
        t: info.t,
        // Raw, and the baseline it is read against once there is one: the
        // file keeps what the console only marks.
        leadMs: Math.round(lead),
        baselineMs,
        bytes: info.bytes.slice(event.start, event.start + event.length),
        kind: event.kind,
        ch: event.channel >= 0 ? event.channel + 1 : null,
        text: describe(event, info.bytes),
    };
    switch (event.kind) {
        case 'NoteOn':
        case 'NoteOff':
            entry.note = event.data1;
            entry.name = noteName(event.data1);
            entry.vel = event.data2;
            break;
        case 'PolyPressure':
            entry.note = event.data1;
            entry.name = noteName(event.data1);
            entry.value = event.data2;
            break;
        case 'ChanPressure':
        case 'Program':
            entry.value = event.data1;
            break;
        case 'PitchBend':
            entry.raw = event.data1 | (event.data2 << 7);
            entry.semitones = Math.round(event.semitones * 10000) / 10000;
            entry.range = event.range;
            entry.rangeSource = event.rangeSource;
            break;
        case 'ControlChange':
        case 'ParamSelect':
            entry.cc = event.data1;
            entry.value = event.data2;
            break;
        case 'MCM':
            entry.zone = event.zone;
            entry.members = event.members;
            break;
        case 'BendRange':
            entry.range = event.range;
            break;
        case 'RpnData':
        case 'NrpnData':
            entry.param = [event.param >> 7, event.param & 0x7f];
            entry.value = event.data2;
            break;
        default:
            break;
    }
    if (count > 1) entry.frame = [...info.bytes];
    if (warnings.length > 0) entry.warnings = warnings;
    return entry;
}

/** The summary as lines, first one headed, the rest indented under it. */
export function formatSummary(
    summary: MpeSummary,
    meta: { client: string; seconds: number; code?: number; timing?: TimingSummary }
): string[] {
    const lines: string[] = [];
    const closed = meta.code === 1009 ? ', closed: frame too large (1009)' : '';
    lines.push(
        `MPE SUMMARY  ${meta.client || 'unknown client'}, ${meta.seconds.toFixed(1)} s, ` +
            `${summary.messages} message(s) in ${summary.frames} frame(s)${closed}`
    );
    const row = (label: string, value: string) => lines.push(`    ${label.padEnd(14)} ${value}`);

    if (summary.mcmCount === 0) row('MCM', 'none on this connection');
    else {
        const zones = summary.zones
            .map((zone) => `${zone.zone} zone, ${zone.members.length} member channel(s) (${formatChannels(zone.members)})`)
            .join(' + ');
        const state = summary.zonesActive ? zones : `released at the end (last: ${zones || 'none'})`;
        const timing = summary.notesBeforeMcm > 0 ? `, AFTER ${summary.notesBeforeMcm} note(s)` : ', before the first note';
        row('MCM', `${state}; ${summary.mcmCount} MCM(s)${timing}`);
    }

    const ranges = new Map<number, number[]>();
    summary.rpnRanges.forEach((range, channel) => {
        if (range === null) return;
        const list = ranges.get(range) ?? [];
        list.push(channel);
        ranges.set(range, list);
    });
    if (ranges.size === 0) {
        row('RPN 0 range', summary.mcmCount > 0 ? 'none sent - MPE defaults apply (members 48, master 2)' : 'none sent');
    } else {
        row(
            'RPN 0 range',
            [...ranges.entries()]
                .sort((a, b) => a[1][0] - b[1][0])
                .map(([range, channels]) => `${formatChannels(channels)} = ${formatRange(range)} st`)
                .join('; ')
        );
    }

    if (summary.zones.length > 0) {
        const total = summary.zones.reduce((sum, zone) => sum + zone.members.length, 0);
        row('members used', `${formatChannels(summary.membersUsed)} (${summary.membersUsed.length} of ${total})`);
    }
    for (const group of summary.groups) {
        const counts = COUNTER_LABELS.map((label, i) => `${label} ${group.counts[i]}`).join('  ');
        row(`${group.name}`, `${formatChannels(group.channels)}: ${counts}`);
    }
    if (summary.held.length === 0) row('held at close', 'none');
    else {
        const names = summary.held.map(({ channel, note }) => `ch ${channel + 1} ${noteName(note)} (${note})`).join(', ');
        const ended =
            summary.endedByBridge === 0
                ? ''
                : summary.endedByBridge === summary.held.length
                  ? ' - all ended by the bridge'
                  : ` - ${summary.endedByBridge} of them ended by the bridge`;
        row('held at close', `${names}${ended}`);
    }
    const timing = meta.timing;
    if (timing && !Number.isNaN(timing.baseline)) {
        const marks = timing.settled
            ? `; ${timing.ahead} frame(s) more than ${LEAD_REPORT_MS} ms ahead of it` +
              (timing.ahead > 0 ? ` (up to +${Math.round(timing.maxAhead)} ms)` : '') +
              `, ${timing.behind} more than ${LATE_REPORT_MS} ms behind` +
              (timing.behind > 0 ? ` (up to -${Math.round(timing.maxBehind)} ms)` : '')
            : ' (too few frames to mark lines against)';
        row('timing', `t runs ${signedMs(timing.baseline)} ms from arrival as a rule (clock offset + network)${marks}`);
    }
    if (summary.drops > 0) row('dropped', `${summary.drops} frame(s)`);
    if (summary.warnings === 0) row('warnings', '0');
    else {
        // Every count, however few of them were printed as lines.
        const counts = summary.warningCounts.map(
            ({ kind, channel, count }) => `${count} x ${WARNING_LABELS[kind]}${channel >= 0 ? ` (ch ${channel + 1})` : ''}`
        );
        row('warnings', `${summary.warnings}: ${counts.join('; ')}`);
    }
    lines.push(`    ${summary.verdict}`);
    return lines;
}
