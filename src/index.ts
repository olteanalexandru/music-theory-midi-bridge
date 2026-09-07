#!/usr/bin/env node
// music-theory-midi-bridge
//
// Puts MIDI from a phone onto a MIDI port on this machine, so a DAW can hear it.
//
// A browser cannot create a virtual MIDI port. That is the entire reason this
// program exists, and it is worth saying plainly because everything else about
// the design follows from it: the phone speaks WebSocket because that is what a
// web page can speak, and this end speaks MIDI because that is what Ableton can
// hear. Nothing in between interprets the bytes.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import qrcode from 'qrcode-terminal';
import { ALL_PORT_NAMES, CLAIMS, DEFAULT_PORT, PORT_NAMES } from './protocol.js';
import { createsVirtualPorts, listPorts, openPorts, type MidiBackend } from './ports.js';
import { startServer } from './server.js';
import { createToken, lanAddress, pairingUrl } from './pairing.js';
import { loadBackend } from './backend.js';

// The site the QR code should open. NOT a placeholder, and it used to be one:
// this is the fallback for every run that passes neither --app nor
// TUTOR_APP_ORIGIN, which is very nearly every run, so `example.com` here meant
// the printed URL and the QR code beside it both pointed at a domain that is
// not ours. Nothing failed - the bridge came up, claimed its ports and waited -
// and the one thing it exists to do, hand a phone a working link, could not
// work. parseArgs is exported below so a test pins this to a real origin.
const DEFAULT_APP_ORIGIN = 'https://note-noodle.com';

interface Args {
    port: number;
    token: string;
    appOrigin: string;
    quiet: boolean;
    help: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        port: DEFAULT_PORT,
        token: '',
        appOrigin: process.env.TUTOR_APP_ORIGIN ?? DEFAULT_APP_ORIGIN,
        quiet: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (flag === '--port' && value) { args.port = Number(value); i++; }
        else if (flag === '--token' && value) { args.token = value; i++; }
        else if (flag === '--app' && value) { args.appOrigin = value; i++; }
        else if (flag === '--quiet') args.quiet = true;
        else if (flag === '--help' || flag === '-h') args.help = true;
    }
    return args;
}

const HELP = `
music-theory-midi-bridge - play a DAW on this computer from a phone

  music-theory-midi-bridge [options]

  --port <n>     Port to listen on (default ${DEFAULT_PORT})
  --token <s>    Use this pairing token instead of a fresh one
  --app <url>    Origin of the app the QR code should open
  --quiet        No QR code, no banner
  --help         This

The phone connects over your local network, so both devices have to be on the
same one. A USB-C cable with tethering on works too, and is usually steadier
than Wi-Fi.
`;

function loadVersion(): string {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function banner(args: Args, token: string, ports: ReturnType<typeof openPorts>, version: string): void {
    const host = lanAddress();
    const virtual = createsVirtualPorts(process.platform);

    console.log(`\n  music-theory-midi-bridge ${version}\n`);

    if (ports.open.size > 0) {
        console.log('  Ports open:');
        for (const name of ports.open.keys()) console.log(`    - ${name}`);
    }

    // The Windows story, and the only failure this program has. RtMidi cannot
    // create virtual ports on Windows, so the ports have to exist already - and
    // an error that does not name them is not help.
    if (ports.missing.length > 0) {
        console.log('\n  Missing ports:');
        for (const name of ports.missing) console.log(`    - ${name}`);
        if (!virtual) {
            console.log('\n  Windows cannot create MIDI ports by itself, so these have to');
            console.log('  exist before this program can use them:');
            console.log('\n    1. Install loopMIDI  (tobias-erichsen.de/software/loopmidi.html)');
            console.log('    2. Type each name above into its "New port-name" box and press +');
            console.log('    3. Restart this program');
            console.log('\n  Instruments whose port is missing simply will not connect;');
            console.log('  the others are fine.');
        }
    }

    if (ports.open.size === 0) {
        console.log('\n  No ports open, so there is nothing to send to yet.');
        return;
    }

    if (!host) {
        console.log('\n  No network address found. Connect to Wi-Fi, or plug the phone');
        console.log('  in over USB-C and turn on USB tethering.');
        return;
    }

    console.log(`\n  Address:  ${host}:${args.port}`);
    console.log(`  Token:    ${token}`);

    if (args.quiet) return;

    // One QR per instrument would be four QR codes and a decision to make.
    // The staff is the one that opens by default; every other instrument picks
    // up the same stored address once one of them has it.
    const url = pairingUrl({ host, port: args.port, token, appOrigin: args.appOrigin, claim: 'staff' });
    console.log('\n  Scan this with the phone:\n');
    qrcode.generate(url, { small: true }, (code: string) => console.log(code));
    console.log(`  ${url}\n`);
    console.log('  In Ableton, set each track\'s MIDI From to one of the ports above,');
    console.log('  arm it, and turn on MPE for that port in Preferences > Link/MIDI.\n');
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(HELP);
        return;
    }

    const version = loadVersion();
    const token = args.token || createToken();

    let backend: MidiBackend;
    try {
        backend = loadBackend(version);
    } catch (error) {
        console.error('\n  Could not load the MIDI bindings.\n');
        console.error(`  ${error instanceof Error ? error.message : String(error)}\n`);
        console.error('  Running from npx? Node 20 or newer is needed.');
        console.error('  Running a downloaded build? Please report this with the line above:');
        console.error('  https://github.com/olteanalexandru/music-theory-midi-bridge/issues\n');
        process.exitCode = 1;
        return;
    }

    const ports = openPorts(backend, ALL_PORT_NAMES);
    banner(args, token, ports, version);

    if (!createsVirtualPorts(backend.platform) && ports.open.size === 0) {
        console.log('  Existing MIDI outputs on this machine, for reference:');
        for (const name of listPorts(backend)) console.log(`    - ${name}`);
        console.log('');
    }

    const server = startServer({
        port: args.port,
        token,
        ports,
        version,
        platform: backend.platform,
        onEvent: (event) => {
            if (args.quiet) return;
            if (event.type === 'connected') console.log(`  + ${event.client} -> ${event.portName}`);
            else if (event.type === 'disconnected') console.log(`  - ${event.portName}`);
            else if (event.reason === 'token') console.log(`  ! refused ${event.detail}: wrong token`);
            else if (event.reason === 'port') console.log(`  ! refused: no port named ${event.detail}`);
            else console.log(`  ! refused: unknown instrument "${event.detail}"`);
        },
    });

    const shutdown = () => {
        // Ports first: a DAW left with a held note because this exited without
        // closing them is the one failure a player would notice immediately.
        for (const port of ports.open.values()) {
            for (let channel = 0; channel < 16; channel++) {
                port.send([0xb0 | channel, 123, 0]);
            }
        }
        ports.closeAll();
        void server.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

// Run only as a program, never on import - the same split the app repo's Edge
// Functions use, so a test can import this module without it starting a server
// and grabbing MIDI ports.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}

export { CLAIMS, PORT_NAMES, DEFAULT_APP_ORIGIN, parseArgs };
