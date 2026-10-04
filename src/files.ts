// Writing a take the app sent into a folder on this PC.
//
// The one place this program touches the file system on somebody else's
// say-so, so everything here is about what it will NOT do: write outside the
// takes folder, overwrite anything, write a name Windows treats as a device,
// or write bytes that are not the kind of file the name says. The wire side -
// the path, the caps, the reply codes - is in protocol.ts.
//
// The folder is plain on purpose. The player adds it to the DAW's browser once
// (Live: Places > Add Folder) and drags takes from there, which is a real file
// on disk - the thing a drag out of Chrome on Windows can never be.

import { mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
    FILE_MAX_BYTES,
    isTakeExtension,
    type FileErrorCode,
    type FileReply,
    type TakeExtension,
} from './protocol.js';

/** Under the home folder, when --takes-dir does not say otherwise. */
export const DEFAULT_TAKES_SEGMENTS = ['Documents', 'Note Noodle', 'Takes'] as const;

/** Documents\Note Noodle\Takes on Windows, ~/Documents/Note Noodle/Takes elsewhere. */
export function defaultTakesDir(home: string = homedir()): string {
    return join(home, ...DEFAULT_TAKES_SEGMENTS);
}

/**
 * The takes folder, absolute, from the --takes-dir value ('' for the default).
 *
 * A leading `~` is the home folder, because cmd and PowerShell do not expand
 * it and somebody copying a line from the README will type it anyway.
 * Relative paths are from where the helper was started.
 */
export function resolveTakesDir(flag: string, home: string = homedir(), cwd: string = process.cwd()): string {
    const value = flag.trim();
    if (value === '') return defaultTakesDir(home);
    if (value === '~') return resolve(home);
    if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(home, value.slice(2));
    return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

/** The longest raw name looked at; a longer one is refused, not cut. */
export const MAX_RAW_NAME_CHARS = 255;

/**
 * The most of a name kept before its extension, in characters.
 *
 * With ` (999)` and `.musicxml` the whole name stays under 120, far inside
 * NTFS's 255 and leaving most of Windows' 260-character path for the folder.
 */
export const MAX_STEM_CHARS = 100;

/**
 * The most of a name kept before its extension, in UTF-8 bytes.
 *
 * Linux (ext4) and macOS cap a name at 255 BYTES, not characters, and 100
 * characters of Japanese are 300. With ` (999)` and `.musicxml` (15 bytes)
 * a 200-byte stem stays inside 255, so a long name is cut rather than turned
 * into 'write-failed' on the Linux and Mac builds.
 */
export const MAX_STEM_BYTES = 200;

/** `x (2)` ... `x (999)`, then 'name-taken'. */
export const MAX_COPY_NUMBER = 999;

/**
 * Refused outright rather than cleaned: a separator, a colon (a drive letter,
 * or an NTFS alternate data stream), and everything a terminal acts on - the
 * C0/C1 controls, the bidi overrides and zero-width marks, line separators,
 * lone surrogates. None of these is in a name the app makes, so a name with
 * one did not come from it.
 */
const REFUSED_IN_NAME = /[/\\:\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/** Kept as they are. Everything else (`*?"<>|`, emoji, symbols) becomes `_`. */
const KEPT_IN_NAME = /[\p{L}\p{M}\p{N} ._()-]/u;

/**
 * Device names Windows opens instead of a file - in any case, with any
 * extension, and with trailing spaces: `con.mid` is the console. COM and LPT
 * include the superscript digits, which Windows also treats as devices.
 */
const RESERVED_WINDOWS = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

export function isReservedWindowsName(stem: string): boolean {
    // Windows looks only at the part before the FIRST dot: `nul.tar.mid` is NUL.
    const base = stem.split('.')[0].trimEnd();
    return RESERVED_WINDOWS.test(base);
}

export type CleanName = { ok: true; stem: string; ext: TakeExtension; name: string } | { ok: false; code: FileErrorCode };

/**
 * The basename a client's name is saved under, or why there is none.
 *
 * Normalised to NFC, so `ă` typed on a Mac and on Windows is one name. Spaces
 * and dots trimmed from both ends: Windows drops trailing ones silently (so
 * `take.mid.` would land as `take.mid`), and a leading dot is a hidden file -
 * or `..`. Runs of dots inside become one, so no `..` survives anywhere.
 */
export function cleanTakeName(raw: unknown): CleanName {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RAW_NAME_CHARS) return { ok: false, code: 'bad-name' };
    const normal = raw.normalize('NFC');
    if (REFUSED_IN_NAME.test(normal)) return { ok: false, code: 'bad-name' };

    let kept = '';
    for (const char of normal) kept += KEPT_IN_NAME.test(char) ? char : '_';
    const trimmed = kept.replace(/\s+/g, ' ').replace(/\.{2,}/g, '.').replace(/^[ .]+|[ .]+$/g, '');

    const dot = trimmed.lastIndexOf('.');
    if (dot < 0) return { ok: false, code: 'bad-extension' };
    const ext = trimmed.slice(dot + 1).toLowerCase();
    if (!isTakeExtension(ext)) return { ok: false, code: 'bad-extension' };

    // Cut by code point, so a cut never splits a surrogate pair; trimmed
    // again, so a cut never leaves a trailing space or dot either. Never
    // empty: `trimmed` starts with neither, so `dot` is at least 1 and the
    // first character survives both trims (and the byte cut, which keeps at
    // least 50 code points of at most 4 bytes each).
    const points = Array.from(trimmed.slice(0, dot).replace(/[ .]+$/g, '')).slice(0, MAX_STEM_CHARS);
    while (Buffer.byteLength(points.join(''), 'utf8') > MAX_STEM_BYTES) points.pop();
    let stem = points.join('').replace(/[ .]+$/g, '');
    if (isReservedWindowsName(stem)) stem = `_${stem}`;
    return { ok: true, stem, ext, name: `${stem}.${ext}` };
}

/** `take.mid`, `take (2).mid`, ... */
export function numberedName(stem: string, ext: string, copy: number): string {
    return copy <= 1 ? `${stem}.${ext}` : `${stem} (${copy}).${ext}`;
}

/**
 * The full path for `name` in `dir`, or null if it would be anywhere else.
 *
 * cleanTakeName already makes this impossible; this is the second lock, so a
 * future change to the cleaning cannot by itself open a way out of the folder.
 */
export function insideFolder(dir: string, name: string): string | null {
    // A separator or a colon is the only way a name can mean somewhere else
    // (a drive, a stream, a parent), and '.' and '..' are the folder itself
    // and its parent. Anything left is one entry, in this folder.
    if (name === '' || name === '.' || name === '..' || /[/\\:]/.test(name)) return null;
    return join(resolve(dir), name);
}

/**
 * Whether `bytes` are the kind of file `ext` says.
 *
 * Only the signature: a MIDI file starts `MThd`, a WAV is `RIFF....WAVE`, and
 * XML starts with `<` after an optional byte-order mark and whitespace. Enough
 * that a `.mid` in the takes folder is a MIDI file and not whatever somebody
 * renamed, without parsing anything.
 */
export function looksLike(ext: TakeExtension, bytes: Uint8Array): boolean {
    const ascii = (from: number, text: string) =>
        bytes.length >= from + text.length && [...text].every((char, index) => bytes[from + index] === char.charCodeAt(0));
    if (ext === 'mid' || ext === 'midi') return ascii(0, 'MThd');
    if (ext === 'wav') return ascii(0, 'RIFF') && ascii(8, 'WAVE');
    // UTF-16, either order: `<` is one byte and a zero.
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes[2] === 0x3c && bytes[3] === 0x00;
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes[2] === 0x00 && bytes[3] === 0x3c;
    let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0a || bytes[at] === 0x0d)) at++;
    return bytes[at] === 0x3c;
}

/**
 * Writes `bytes` into `dir` under `name` (already through cleanTakeName),
 * never over an existing file.
 *
 * `wx` is O_CREAT|O_EXCL: the open itself fails if anything is there - a
 * file, a folder, or a symbolic link, which it does not follow - so two takes
 * saved at once cannot both win one name, and there is no window between
 * looking and writing. Taken, it tries `name (2)`, `name (3)` and so on.
 */
export async function saveTake(
    dir: string,
    clean: { stem: string; ext: TakeExtension },
    bytes: Uint8Array,
    maxCopy: number = MAX_COPY_NUMBER
): Promise<FileReply> {
    try {
        await mkdir(dir, { recursive: true });
    } catch {
        return { error: 'folder-unavailable' };
    }
    for (let copy = 1; copy <= maxCopy; copy++) {
        const name = numberedName(clean.stem, clean.ext, copy);
        const target = insideFolder(dir, name);
        if (!target) return { error: 'bad-name' };
        let handle;
        try {
            handle = await open(target, 'wx');
        } catch (error) {
            // EEXIST is the name being taken - by a file, a folder or a link,
            // on Windows as elsewhere. Anything else (a read-only folder, a
            // full disk) is not, and must not turn into 999 tries and
            // 'name-taken'.
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
            return { error: 'write-failed' };
        }
        try {
            await handle.writeFile(bytes);
            await handle.close();
        } catch {
            await handle.close().catch(() => undefined);
            // Half a take is worse than none: Live would list it.
            await unlink(target).catch(() => undefined);
            return { error: 'write-failed' };
        }
        return { saved: name, bytes: bytes.length };
    }
    return { error: 'name-taken' };
}

/** The cap for `ext`, in bytes. */
export function maxBytesFor(ext: TakeExtension): number {
    return FILE_MAX_BYTES[ext];
}

/**
 * At most `limit` takes in any `windowMs` - a sliding window. The server keeps
 * one for every file socket together (see startServer), not one per socket.
 *
 * Every attempt counts, refused ones too, so a client cannot spin on bad
 * headers either. `now` is a parameter so a test can move the clock.
 */
export class RateLimiter {
    private readonly times: number[] = [];

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now
    ) {}

    /** True and counted when there is room; false, and not counted, when not. */
    take(): boolean {
        const time = this.now();
        while (this.times.length > 0 && time - this.times[0] >= this.windowMs) this.times.shift();
        if (this.times.length >= this.limit) return false;
        this.times.push(time);
        return true;
    }
}
