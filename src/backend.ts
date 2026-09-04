// Loading the native MIDI bindings, from a package or from inside a binary.
//
// Two different problems, and the second one is why this file exists.
//
// Run from npm, `require('@julusian/midi')` is all it takes: the package finds
// its own prebuilt `.node` for this platform and arch.
//
// Run from a pkg-built executable, that fails outright - and it fails at the
// point where somebody has just downloaded a file and double-clicked it, which
// is the worst possible moment. pkg bundles JAVASCRIPT into a virtual
// filesystem; a native addon is not JavaScript, and `pkg-prebuilds` picks its
// path at runtime, so pkg's static analysis never sees it and the snapshot
// never contains it:
//
//     Could not load the MIDI bindings.
//     Cannot find module '@julusian/midi'
//     Require stack: C:\snapshot\music-theory-midi-bridge\dist\index.js
//
// So inside a binary the `.node` is carried as a pkg ASSET, written out to a
// real file on disk once, and required by absolute path - because
// `process.dlopen` needs a real path and cannot read the snapshot. The raw
// addon is loaded rather than the package's wrapper, which is fine and checked:
// it exports Output and Input directly, and every method used here
// (getPortCount, getPortName, openPort, openVirtualPort, closePort,
// sendMessage) is native.
//
// The single-file download is worth this. The alternative - a zip with a
// `.node` beside the executable - moves the problem onto the person least
// equipped to deal with it.

import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MidiBackend, MidiOutputPort } from './ports.js';

const require = createRequire(import.meta.url);

interface NativeAddon {
    Output: new () => MidiOutputPort;
}

/** True when running from a pkg-built executable rather than from node_modules. */
export function inBinary(): boolean {
    // pkg sets process.pkg; the snapshot path is the belt-and-braces check for
    // a build that sets it differently.
    return Boolean((process as { pkg?: unknown }).pkg) || __filenameSafe().includes('snapshot');
}

function __filenameSafe(): string {
    try {
        return new URL(import.meta.url).pathname;
    } catch {
        return '';
    }
}

/**
 * Where the prebuilt binding lives inside the package.
 *
 * Named the way `pkg-prebuilds` names it, because that is what is on disk and
 * what has to be listed in package.json's `pkg.assets` for the snapshot to
 * carry it.
 */
export function prebuildPath(platform = process.platform, arch = process.arch): string {
    return join('node_modules', '@julusian', 'midi', 'prebuilds', `midi-${platform}-${arch}`, 'node-napi-v7.node');
}

/**
 * Copies the binding out of the snapshot and returns the real path.
 *
 * Once per version: a cached copy is reused, so this costs nothing on every run
 * but the first. Named by version so an upgraded binary never loads the old
 * addon out of the cache.
 */
function extractBinding(version: string): string {
    const dir = join(tmpdir(), `music-theory-midi-bridge-${version}`);
    const target = join(dir, 'node-napi-v7.node');
    if (existsSync(target)) return target;

    mkdirSync(dir, { recursive: true });

    // Where the snapshot put it, tried in order rather than assumed.
    //
    // pkg roots its virtual filesystem at whatever directory it built from, so
    // the path contains a name this file cannot know - it is the checkout
    // directory, which differs between a laptop and a CI runner. Deriving it
    // from this module's own location is therefore first and correct; the
    // literal roots are fallbacks for a pkg version that resolves import.meta
    // differently, and on Windows both the POSIX and drive-letter spellings of
    // the snapshot root work.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', prebuildPath()),
        join('/snapshot', 'music-theory-midi-bridge', prebuildPath()),
        join('C:\\snapshot', 'music-theory-midi-bridge', prebuildPath()),
    ];

    let lastError: unknown = null;
    for (const source of candidates) {
        try {
            // Read rather than copy: copyFileSync refuses a snapshot path on
            // some pkg versions, while reading it as a buffer always works
            // because that IS the virtual filesystem's one job.
            writeFileSync(target, readFileSync(source));
            lastError = null;
            break;
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError) {
        throw new Error(
            `could not read the MIDI binding out of this build (tried ${candidates.length} paths): ` +
                (lastError instanceof Error ? lastError.message : String(lastError))
        );
    }
    try {
        chmodSync(target, 0o755);
    } catch {
        // Windows has no execute bit, and does not need one to dlopen.
    }
    return target;
}

export function loadBackend(version: string): MidiBackend {
    const addon: NativeAddon = inBinary()
        ? (require(extractBinding(version)) as NativeAddon)
        : (require('@julusian/midi') as NativeAddon);

    return {
        platform: process.platform,
        createOutput: () => new addon.Output(),
    };
}
