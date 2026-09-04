// Getting a phone connected without typing an IP address.
//
// This is the whole reason the helper prints anything at all. Asking somebody
// to read their laptop's LAN address off one screen and thumb it into another,
// then do the same with a token, is the kind of setup step that makes a feature
// go unused. A QR code turns both into one camera-point.
//
// What the code encodes is a link into the APP, not into this helper - opening
// `ws://192.168.1.20:8532/midi` in a phone browser does nothing a person can
// see. It opens the instrument page with the bridge details in the query
// string, and the app fills its own fields in.
//
// mDNS is deliberately absent. A browser cannot browse for services, so
// advertising `_tutor-midi._tcp` would add a dependency and a moving part to
// solve a problem the QR code has already solved.

import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Claim } from './protocol.js';

/**
 * Long enough not to be guessed, short enough to read aloud down a phone.
 *
 * Base32-ish alphabet with no 0/O/1/I, because the fallback when a camera will
 * not focus is somebody typing this by hand.
 */
const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function createToken(length = 12): string {
    const bytes = randomBytes(length);
    let token = '';
    for (const byte of bytes) token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
    return token;
}

/**
 * The address to advertise.
 *
 * Picks a real LAN address rather than a loopback one, because the point is
 * for another device to reach it. IPv4 first: a phone typing a fallback
 * address by hand can manage four numbers and cannot manage a v6 address, and
 * a USB-tethered link presents as v4 anyway.
 */
export function lanAddress(): string | null {
    const interfaces = networkInterfaces();
    const candidates: string[] = [];
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.internal) continue;
            if (entry.family !== 'IPv4') continue;
            candidates.push(entry.address);
        }
    }
    if (candidates.length === 0) return null;
    // A USB-tethered phone usually lands on 192.168.x, and so does most home
    // Wi-Fi; prefer it over the 172.x a container or VPN adapter tends to take,
    // which is reachable from nothing the player is holding.
    return candidates.find((address) => address.startsWith('192.168.')) ?? candidates[0];
}

export interface PairingLink {
    host: string;
    port: number;
    token: string;
    /** Origin of the deployed app, e.g. https://example.com */
    appOrigin: string;
    /** Which instrument page to open. */
    claim: Claim;
}

/** Instrument pages, mirroring INSTRUMENT_PATHS in the app. */
export const CLAIM_PATHS: Record<Claim, string> = {
    stylophone: '/app/stylophone',
    pads: '/app/pads',
    theremin: '/app/theremin',
    staff: '/app/playable-staff',
};

export function pairingUrl({ host, port, token, appOrigin, claim }: PairingLink): string {
    const origin = appOrigin.replace(/\/+$/, '');
    // One parameter carrying host:port rather than two, because it is one fact
    // and the app should not have to cope with half of it arriving.
    return `${origin}${CLAIM_PATHS[claim]}?bridge=${encodeURIComponent(`${host}:${port}`)}&t=${encodeURIComponent(token)}`;
}
