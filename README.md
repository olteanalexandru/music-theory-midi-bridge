# music-theory-midi-bridge

Play a DAW on your computer from the instruments in
[Music Theory Cheatsheet](https://github.com/olteanalexandru/Music-theory-cheatsheet)
running on your phone — with MPE intact, and **one Ableton track per instrument**.

A browser cannot create a virtual MIDI port. That is the whole reason this exists.
The phone speaks WebSocket, because that is what a web page can speak; this end
speaks MIDI, because that is what Ableton can hear. Nothing in between interprets
the bytes, which is why per-note bend, channel pressure, CC74 and the MPE
Configuration Message all arrive exactly as the app sent them.

---

## Install and run

Grab a standalone build from
[Releases](https://github.com/olteanalexandru/music-theory-midi-bridge/releases)
and double-click it — Windows, Linux and Apple Silicon. There is no Intel Mac
build: GitHub retired the last x64 macOS runner and a native MIDI addon cannot
be cross-compiled from Apple Silicon, so an Intel Mac has to build from source
(`npm install && npm run build && node dist/index.js`).

> **`npx music-theory-midi-bridge` does not work yet.** This package has never
> been published to npm — the registry returns a 404 for it — so the one-liner
> that used to head this section sent everybody who tried it into an error. The
> releases above are real and current. When 1.0.1 is published the line comes
> back, here and on the app's download page, which gates it on the same fact.

It prints an address, a pairing token and a QR code. Scan the QR with the phone
and it opens a pairing page with the connection already filled in — one tap to
connect, and it names any loopMIDI port it could not find. Every instrument
picks the address up from there.

```
  music-theory-midi-bridge 1.0.0

  Ports open:
    - Tutor MIDI
    - Tutor Stylophone
    - Tutor Pads
    - Tutor Theremin
    - Tutor Staff

  Address:  192.168.1.20:8532
  Token:    kfp7mqx2wnhd

  Scan this with the phone:
  [QR]
```

---

## Windows needs loopMIDI first

**RtMidi cannot create virtual MIDI ports on Windows.** `openVirtualPort` is
implemented for macOS CoreMIDI, Linux ALSA and JACK, and throws on the Windows
MultiMedia API — see [thestk/rtmidi#332](https://github.com/thestk/rtmidi/issues/332).
There is no flag and no version where this changes; it is a limit of the Windows
API underneath, not of this program.

So on Windows the ports have to exist before this can use them:

1. Install [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html).
2. Type each of these into its **New port-name** box and press **+**:
   - `Tutor Stylophone`
   - `Tutor Pads`
   - `Tutor Theremin`
   - `Tutor Staff`
   - `Tutor MIDI`
3. Run the bridge again.

You only need the ones for instruments you actually play. Any that are missing
are named on startup, and the instruments whose ports *do* exist work fine
meanwhile.

**macOS and Linux need none of this** — the ports are created on startup and
disappear when you quit.

---

## Windows also has a firewall

Defender asks once, on the first run, whether to let this accept connections.
That prompt is easy to dismiss, and dismissing it — or allowing it only for
"Public" networks while your Wi-Fi is classified "Private", or the reverse —
blocks every connection from the phone with no further sign of it anywhere.

The tell is that this program's console stays **completely empty** after a
scan. Every line it prints about a connection comes from a socket that already
completed its handshake, so a blank console means nothing arrived: firewall, or
an address the phone cannot reach (see `--host` below), and nothing else.

Fix it in Windows Security → Firewall & network protection → Allow an app
through firewall, with both Private and Public ticked for this program.

---

## If the phone will not connect

Three causes, in the order worth checking.

1. **This console is empty after a scan.** Nothing reached the program. That is
   the firewall above, or the advertised address being one of your machine's
   virtual adapters rather than the one the phone shares — `--host` pins it.
2. **The phone says the browser will not allow it.** A page served over https
   cannot open an insecure WebSocket, and this program has no certificate. Use
   the Android app, which carries that one exemption, or run the helper on the
   same machine as the browser — a connection to `localhost` is exempt.
3. **`! refused: no port named …`.** A loopMIDI port with that exact name does
   not exist. Create it and restart.

---

## One instrument, one track

Each instrument connects on its own socket and claims its own port, so each gets
a full fifteen-channel MPE zone instead of four instruments fighting over one
port's channels.

| Instrument | Port | Set this as the Live track's *MIDI From* |
| --- | --- | --- |
| Stylophone | `Tutor Stylophone` | track 1 |
| Pad grid / Bass | `Tutor Pads` | track 2 |
| Theremin | `Tutor Theremin` | track 3 |
| Playable staff | `Tutor Staff` | track 4 |

In Ableton, per track:

1. **MIDI From** → the port for that instrument.
2. Arm the track (the record button on it).
3. **Preferences → Link/Tempo/MIDI** → find that port under *MIDI Ports* and
   turn on **MPE**. Without this Live reads the per-note bends as one part-wide
   bend, and a chord will slide as a block instead of per note.

To have Live follow the app's tempo, also switch **Sync** on for the port and set
Live's clock source to it. The pad grid's sequencer is the only thing that sends
clock.

---

## Over a USB-C cable

Two ways, and the difference matters.

**USB tethering — recommended.** Plug the phone in, turn on USB tethering, and
run the bridge as usual. The cable becomes a network link: no router, steadier
than Wi-Fi, and it keeps one port per instrument. The address the bridge prints
will be the tethered one.

**Android USB MIDI mode.** Set the phone's USB mode to *MIDI* and it becomes a
class-compliant USB MIDI device your computer can see directly — no bridge at
all. Lowest latency of anything here, but it gives you **one** port, so one MPE
zone, so effectively one instrument at a time. Good for playing; it cannot do the
per-track routing above.

---

## Options

```
--port <n>     Port to listen on (default 8532)
--token <s>    Use this token instead of a fresh one
--app <url>    Origin the QR code should open (default https://note-noodle.com)
--host <ip>    Advertise this address instead of guessing one
--quiet        No QR code, no banner
--help
```

`--host` is worth knowing about before you need it. This program has to guess
which of your machine's addresses the phone can reach, and Hyper-V, WSL, Docker
and most VPN clients all hold LAN-looking ones that it cannot. Every address
found is printed under the chosen one; pin the right one with this.

The token is not decoration. This is a socket open to your local network that
injects MIDI into whatever your machine is running, so a device without the
token is refused. A fresh one is generated per run; `--token` pins it if you want
a QR code that keeps working across restarts.

---

## Protocol

For anyone reimplementing either end. Connect to:

```
ws://<host>:8532/midi?t=<token>&port=<claim>&client=<label>
```

`claim` is one of `stylophone`, `pads`, `theremin`, `staff`, or absent for the
shared `Tutor MIDI` port.

**App → helper**, one JSON object per MIDI message:

```json
{ "t": 1234, "b": [144, 60, 100] }
```

- `b` — raw MIDI bytes, written to the port verbatim.
- `t` — milliseconds since *that socket* opened. Relative, never a wall clock:
  the two machines have different ones. It is there so the gaps between messages
  the app scheduled ahead of time survive the trip.

**Helper → app**, once, on connect:

```json
{ "hello": 1, "version": "1.0.0", "platform": "win32", "claimed": "staff",
  "portName": "Tutor Staff", "ports": ["Tutor Pads"], "missing": ["Tutor Staff"] }
```

Sent *before* any refusal, because `missing` is what lets the app say which
loopMIDI port to create rather than just going quiet.

Close codes: `4001` bad token, `4002` unknown claim, `4003` no such port.

JSON rather than binary frames on purpose: a helper in any language can read it
with its standard library, the traffic is a few hundred bytes a second even under
a fast trill, and a protocol you can read in a log is one somebody can reimplement
without the source open beside them.

---

## Development

```bash
npm install
npm test          # no MIDI hardware and no build toolchain needed
npm run build
node dist/index.js
```

`src/ports.ts` takes its MIDI backend as an argument, so every test hands in a
fake and the native module is never loaded. That is also what makes the Windows
path — the only one that can fail — testable from a Mac.

## Licence

MIT.
