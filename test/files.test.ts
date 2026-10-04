// What the helper will and will not write into the takes folder.
//
// The file system on somebody else's say-so: every rule here is a way a name
// or a body sent over the network could otherwise land outside the folder,
// over something already there, or on a Windows device. Real files in a real
// temporary folder, because the point is what ends up on disk.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_TAKES_SEGMENTS,
    MAX_RAW_NAME_CHARS,
    MAX_STEM_BYTES,
    MAX_STEM_CHARS,
    RateLimiter,
    cleanTakeName,
    defaultTakesDir,
    insideFolder,
    isReservedWindowsName,
    looksLike,
    numberedName,
    resolveTakesDir,
    saveTake,
} from '../src/files.js';
import { FILE_MAX_BYTES, MAX_FILE_PAYLOAD, TAKE_EXTENSIONS, parseFileHeader, MAX_FILE_HEADER_BYTES } from '../src/protocol.js';

/** The smallest bytes each kind accepts. */
const MIDI = Buffer.from('MThd\0\0\0\x06\0\x01\0\x01\x01\x80', 'latin1');
const WAV = Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1');
const XML = Buffer.from('<?xml version="1.0"?><score-partwise/>', 'utf8');

function cleaned(raw: unknown): string {
    const result = cleanTakeName(raw);
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    return result.name;
}

function refused(raw: unknown): string {
    const result = cleanTakeName(raw);
    return result.ok ? `accepted as ${result.name}` : result.code;
}

describe('the takes folder', () => {
    it('defaults to Documents/Note Noodle/Takes under the home folder', () => {
        expect(DEFAULT_TAKES_SEGMENTS).toEqual(['Documents', 'Note Noodle', 'Takes']);
        expect(defaultTakesDir('/home/ana')).toBe(join('/home/ana', 'Documents', 'Note Noodle', 'Takes'));
    });

    it('is the default when --takes-dir is empty or blank', () => {
        expect(resolveTakesDir('', '/home/ana')).toBe(defaultTakesDir('/home/ana'));
        expect(resolveTakesDir('   ', '/home/ana')).toBe(defaultTakesDir('/home/ana'));
    });

    it('reads a leading ~ as the home folder, since cmd and PowerShell will not', () => {
        expect(resolveTakesDir('~/Live/Takes', '/home/ana')).toBe(resolve('/home/ana', 'Live/Takes'));
        expect(resolveTakesDir('~\\Live', '/home/ana')).toBe(resolve('/home/ana', 'Live'));
        expect(resolveTakesDir('~', '/home/ana')).toBe(resolve('/home/ana'));
    });

    it('makes a relative folder absolute, from where the helper started', () => {
        expect(resolveTakesDir('takes', '/home/ana', '/work')).toBe(resolve('/work', 'takes'));
        expect(resolveTakesDir(resolve('/abs/takes'), '/home/ana', '/work')).toBe(resolve('/abs/takes'));
    });
});

describe('cleaning a name', () => {
    it('keeps an ordinary take name as it is', () => {
        expect(cleaned('staff-sequence-120bpm-12notes.mid')).toBe('staff-sequence-120bpm-12notes.mid');
        expect(cleaned('My take (live).wav')).toBe('My take (live).wav');
    });

    it('accepts exactly the five kinds, in any case, saved in lower case', () => {
        for (const ext of TAKE_EXTENSIONS) expect(cleaned(`take.${ext.toUpperCase()}`)).toBe(`take.${ext}`);
        for (const name of ['take.exe', 'take.mid.exe', 'take.mxl', 'take.html', 'take', 'take.', 'take.mid.lnk', 'take.bat']) {
            expect(refused(name), name).toBe('bad-extension');
        }
    });

    it('refuses anything that is a path rather than cleaning it into a name', () => {
        for (const name of [
            '../take.mid',
            '..\\take.mid',
            'sub/take.mid',
            'sub\\take.mid',
            '/etc/take.mid',
            'C:\\Users\\Public\\take.mid',
            'C:take.mid',
            '\\\\server\\share\\take.mid',
            'take.mid:stream',
            '\\\\?\\C:\\take.mid',
        ]) {
            expect(refused(name), name).toBe('bad-name');
        }
    });

    it('leaves no .. anywhere, and no dot or space at either end', () => {
        expect(cleaned('..take.mid')).toBe('take.mid');
        expect(cleaned('a..b.mid')).toBe('a.b.mid');
        expect(cleaned('take.mid.')).toBe('take.mid');
        expect(cleaned('  take  .mid  ')).toBe('take.mid');
        expect(cleaned('take...mid')).toBe('take.mid');
        expect(refused('..mid')).toBe('bad-extension');
        expect(refused('.mid')).toBe('bad-extension');
        expect(refused('...')).toBe('bad-extension');
        expect(refused(' . .mid')).toBe('bad-extension');
    });

    it('renames the Windows device names instead of opening the device', () => {
        for (const stem of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'COM¹', 'LPT³', 'nul.tar', 'CON ']) {
            const name = cleaned(`${stem}.mid`);
            expect(name.startsWith('_'), stem).toBe(true);
            expect(isReservedWindowsName(name.slice(0, -'.mid'.length)), stem).toBe(false);
        }
        // Only the whole word: these are ordinary names.
        for (const stem of ['console', 'icon', 'COM10', 'nullify', 'LPT']) expect(cleaned(`${stem}.mid`), stem).toBe(`${stem}.mid`);
    });

    it('keeps letters in any script, normalised, and turns symbols into _', () => {
        expect(cleaned('Piesă în Do major.mid')).toBe('Piesă în Do major.mid');
        expect(cleaned('Țară și ștergere.mid')).toBe('Țară și ștergere.mid');
        // Decomposed (as a Mac types it) arrives composed.
        expect(cleaned('Pies\u0103.mid')).toBe(cleaned('Piesa\u0306.mid'));
        expect(cleaned('ドレミ.mid')).toBe('ドレミ.mid');
        expect(cleaned('take*?"<>|.mid')).toBe('take______.mid');
        expect(cleaned('take 🎹.mid')).toBe('take _.mid');
        // A fullwidth solidus looks like a separator and is not one; it is kept out anyway.
        expect(cleaned('a\uff0fb.mid')).toBe('a_b.mid');
        expect(cleaned('a\u2024\u2024b.mid')).toBe('a__b.mid');
    });

    it('refuses control and format characters, which a terminal would act on', () => {
        for (const name of ['take\u0000.mid', 'take\u001b[2J.mid', 'take\n.mid', 'gpj\u202e.mid', 'ta\u200bke.mid', 'take\u2028.mid', 'take\ud800.mid', '\ufefftake.mid']) {
            expect(refused(name), JSON.stringify(name)).toBe('bad-name');
        }
    });

    it('refuses what is not a string, empty, or longer than any real name', () => {
        for (const value of [undefined, null, 42, {}, ['take.mid'], '']) expect(refused(value), String(value)).toBe('bad-name');
        expect(refused(`${'a'.repeat(MAX_RAW_NAME_CHARS - 4)}.mid`)).toBe(`accepted as ${'a'.repeat(MAX_STEM_CHARS)}.mid`);
        expect(refused(`${'a'.repeat(MAX_RAW_NAME_CHARS - 3)}.mid`)).toBe('bad-name');
    });

    it('caps a long name by code point, without splitting one or leaving a space at the cut', () => {
        expect(cleaned(`${'x'.repeat(150)}.mid`)).toBe(`${'x'.repeat(MAX_STEM_CHARS)}.mid`);
        const astral = cleaned(`${'𝄞'.repeat(120)}.mid`);
        // 𝄞 is a symbol, so it is `_`; a letter outside the BMP is kept whole.
        expect(astral).toBe(`${'_'.repeat(MAX_STEM_CHARS)}.mid`);
        // A letter outside the BMP is 4 UTF-8 bytes, so the byte cap cuts first.
        const letters = cleaned(`${'𐐀'.repeat(120)}.mid`);
        expect(Array.from(letters.slice(0, -4))).toHaveLength(MAX_STEM_BYTES / 4);
        expect(letters.isWellFormed()).toBe(true);
        expect(cleaned(`${'a'.repeat(MAX_STEM_CHARS - 1)} b.mid`)).toBe(`${'a'.repeat(MAX_STEM_CHARS - 1)}.mid`);
    });

    it('caps a long name in UTF-8 bytes too, so the longest numbered copy fits a 255-byte file system', () => {
        // 100 characters of Japanese are 300 bytes: past ext4's and APFS's 255.
        const japanese = cleanTakeName(`${'ド'.repeat(120)}.musicxml`);
        expect(japanese.ok).toBe(true);
        if (!japanese.ok) return;
        expect(Buffer.byteLength(japanese.stem, 'utf8')).toBeLessThanOrEqual(MAX_STEM_BYTES);
        expect(japanese.stem).toBe('ド'.repeat(Math.floor(MAX_STEM_BYTES / 3)));
        expect(Buffer.byteLength(numberedName(japanese.stem, japanese.ext, 999), 'utf8')).toBeLessThanOrEqual(255);
        // Romanian letters are 2 bytes: 100 of them are exactly the cap, kept whole.
        expect(cleaned(`${'ș'.repeat(120)}.mid`)).toBe(`${'ș'.repeat(MAX_STEM_CHARS)}.mid`);
    });
});

describe('the second lock on the folder', () => {
    const dir = resolve('/takes');

    it('allows a plain name, and gives its full path', () => {
        expect(insideFolder(dir, 'take.mid')).toBe(join(dir, 'take.mid'));
    });

    it('refuses anything that is not a plain name, even if it would land inside', () => {
        for (const name of ['', '.', '..', '../take.mid', 'a/../take.mid', 'sub/take.mid', 'sub\\take.mid', 'C:take.mid', '/take.mid', resolve('/elsewhere/take.mid')]) {
            expect(insideFolder(dir, name), name).toBeNull();
        }
    });
});

describe('telling a file by its first bytes', () => {
    it('knows a MIDI file, a WAV and XML', () => {
        expect(looksLike('mid', MIDI)).toBe(true);
        expect(looksLike('midi', MIDI)).toBe(true);
        expect(looksLike('wav', WAV)).toBe(true);
        expect(looksLike('musicxml', XML)).toBe(true);
        expect(looksLike('xml', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\r\n  <score/>')]))).toBe(true);
        expect(looksLike('xml', Buffer.from('\ufeff<a/>', 'utf16le'))).toBe(true);
        expect(looksLike('xml', Buffer.from([0xfe, 0xff, 0x00, 0x3c]))).toBe(true);
    });

    it('refuses bytes that are not what the name says', () => {
        expect(looksLike('mid', WAV)).toBe(false);
        expect(looksLike('mid', Buffer.from('MTh'))).toBe(false);
        expect(looksLike('wav', MIDI)).toBe(false);
        expect(looksLike('wav', Buffer.from('RIFF\0\0\0\0AVI '))).toBe(false);
        expect(looksLike('xml', MIDI)).toBe(false);
        expect(looksLike('musicxml', Buffer.from('PK\x03\x04'))).toBe(false);
        expect(looksLike('xml', Buffer.from('   '))).toBe(false);
        expect(looksLike('xml', Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
    });
});

describe('the header', () => {
    it('reads {name, size}', () => {
        expect(parseFileHeader('{"name":"take.mid","size":14}')).toEqual({ ok: true, header: { name: 'take.mid', size: 14 } });
    });

    it('says empty for size 0, and bad-header for anything else wrong', () => {
        expect(parseFileHeader('{"name":"take.mid","size":0}')).toEqual({ ok: false, code: 'empty' });
        for (const raw of ['nope', '[]', 'null', '42', '{"size":3}', '{"name":5,"size":3}', '{"name":"a.mid"}', '{"name":"a.mid","size":-1}', '{"name":"a.mid","size":1.5}', '{"name":"a.mid","size":"3"}', '{"name":"a.mid","size":1e300}']) {
            expect(parseFileHeader(raw), raw).toEqual({ ok: false, code: 'bad-header' });
        }
    });

    it('refuses a header longer than MAX_FILE_HEADER_BYTES, counted in UTF-8', () => {
        const fits = JSON.stringify({ name: 'a.mid', size: 1, pad: 'x'.repeat(MAX_FILE_HEADER_BYTES - 40) });
        expect(Buffer.byteLength(fits)).toBeLessThanOrEqual(MAX_FILE_HEADER_BYTES);
        expect(parseFileHeader(fits).ok).toBe(true);
        // Same length in characters, three times it in bytes.
        const wide = JSON.stringify({ name: 'a.mid', size: 1, pad: 'ș'.repeat(MAX_FILE_HEADER_BYTES - 40) });
        expect(parseFileHeader(wide)).toEqual({ ok: false, code: 'bad-header' });
    });

    it('caps MIDI and MusicXML at 2 MiB and WAV at 32 MiB, and reads no message larger', () => {
        expect(FILE_MAX_BYTES).toEqual({ mid: 2097152, midi: 2097152, musicxml: 2097152, xml: 2097152, wav: 33554432 });
        expect(MAX_FILE_PAYLOAD).toBe(33554432);
    });
});

describe('saving', () => {
    let dir: string;
    beforeEach(() => {
        dir = join(mkdtempSync(join(tmpdir(), 'bridge-takes-')), 'Note Noodle', 'Takes');
    });
    afterEach(() => {
        rmSync(resolve(dir, '..', '..'), { recursive: true, force: true });
    });

    const take = (name: string) => {
        const result = cleanTakeName(name);
        if (!result.ok) throw new Error(result.code);
        return result;
    };

    it('makes the folder on the first save, and writes the bytes', async () => {
        expect(await saveTake(dir, take('take.mid'), MIDI)).toEqual({ saved: 'take.mid', bytes: MIDI.length });
        expect(readFileSync(join(dir, 'take.mid'))).toEqual(MIDI);
    });

    it('never overwrites: the second take of one name is (2), the third (3)', async () => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'take.mid'), 'precious');
        expect(await saveTake(dir, take('take.mid'), MIDI)).toMatchObject({ saved: 'take (2).mid' });
        expect(await saveTake(dir, take('take.mid'), MIDI)).toMatchObject({ saved: 'take (3).mid' });
        expect(readFileSync(join(dir, 'take.mid'), 'utf8')).toBe('precious');
        expect(readdirSync(dir).sort()).toEqual(['take (2).mid', 'take (3).mid', 'take.mid']);
    });

    it('treats a folder of the same name as taken, not as a failure', async () => {
        mkdirSync(join(dir, 'take.mid'), { recursive: true });
        expect(await saveTake(dir, take('take.mid'), MIDI)).toMatchObject({ saved: 'take (2).mid' });
    });

    it('gives up with name-taken rather than counting for ever', async () => {
        mkdirSync(dir, { recursive: true });
        for (const name of ['take.mid', 'take (2).mid', 'take (3).mid']) writeFileSync(join(dir, name), 'x');
        expect(await saveTake(dir, take('take.mid'), MIDI, 3)).toEqual({ error: 'name-taken' });
        expect(numberedName('take', 'mid', 1)).toBe('take.mid');
        expect(numberedName('take', 'mid', 12)).toBe('take (12).mid');
    });

    it('checks the folder again itself, whatever it is handed', async () => {
        expect(await saveTake(dir, { stem: '../escape', ext: 'mid' }, MIDI)).toEqual({ error: 'bad-name' });
        expect(await saveTake(dir, { stem: 'C:escape', ext: 'mid' }, MIDI)).toEqual({ error: 'bad-name' });
        expect(readdirSync(resolve(dir, '..'))).toEqual(['Takes']);
        expect(readdirSync(dir)).toEqual([]);
    });

    it('says write-failed, at once, when the open fails for any reason but a taken name', async () => {
        // Longer than any file system allows: not "taken", so not 999 tries and name-taken.
        expect(await saveTake(dir, { stem: 'x'.repeat(400), ext: 'mid' }, MIDI)).toEqual({ error: 'write-failed' });
    });

    it('leaves nothing behind when the write itself fails', async () => {
        // Not bytes at all, so the write throws after the file was created.
        expect(await saveTake(dir, take('half.mid'), 42 as unknown as Uint8Array)).toEqual({ error: 'write-failed' });
        expect(readdirSync(dir)).toEqual([]);
    });

    it('says folder-unavailable when the folder cannot be made', async () => {
        const parent = resolve(dir, '..');
        mkdirSync(resolve(parent, '..'), { recursive: true });
        writeFileSync(parent, 'a file where the folder should be');
        expect(await saveTake(dir, take('take.mid'), MIDI)).toEqual({ error: 'folder-unavailable' });
    });

    it('writes a renamed device name as a file, inside the folder', async () => {
        expect(await saveTake(dir, take('CON.mid'), MIDI)).toMatchObject({ saved: '_CON.mid' });
        expect(readdirSync(dir)).toEqual(['_CON.mid']);
    });
});

describe('the rate limit', () => {
    it('allows `limit` in a window, then none until the oldest has aged out', () => {
        let now = 1000;
        const limiter = new RateLimiter(3, 60_000, () => now);
        expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false]);
        now += 59_999;
        expect(limiter.take()).toBe(false);
        now += 1;
        expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false]);
        // Sliding, not reset: one taken later ages out later.
        now += 30_000;
        expect(limiter.take()).toBe(false);
    });
});
