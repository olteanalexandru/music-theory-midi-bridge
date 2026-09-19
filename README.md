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

  MIDI logging: off  (--log-midi to print every message)

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

The bridge passes MIDI clock through like anything else, but the app does not
send any at the moment (the pad grid's sequencer that did was retired), so
Live keeps its own tempo.

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

## When the phone goes away mid-note

A tab that is closed, an app that is swiped away, a network error: the socket
ends with note-ons already in Live and their note-offs never coming. So when a
connection closes, for any reason, the bridge ends what **that connection** left
sounding: a NoteOff for every note it still held, then CC 64 (sustain) off and
CC 123 (All Notes Off) on each channel it played a note or moved the pedal on.
The console says so on the disconnect line: `- Tutor Staff, ended 2 note(s) it
left held`.

It acts when this computer learns the connection closed. A phone that simply
vanishes - out of Wi-Fi range, battery flat - says nothing on its way out, and
the bridge never writes to a connection after greeting it, so nothing here
notices: those notes stay on until Ctrl+C (below). Locking the phone is not that
case: the app sends its own note-offs as it goes to the background.

Only that connection's notes. Two devices can share a port, and one of them
leaving sends no NoteOff for a note the other is also holding, no pedal-up where
the other has its pedal down, and no All Notes Off on a channel the other is
still playing - nor on channel 1 or 16 while the other plays anywhere, because
those are MPE zone masters and an All Notes Off there reaches the whole zone.
The app does its part first: disconnecting sends the note-offs it was still
holding back for later.

Stopping the bridge itself (Ctrl+C) sends sustain off and All Notes Off on all
16 channels of every port instead.

---

## Options

```
--port <n>            Port to listen on (default 8532)
--token <s>           Use this token instead of a fresh one
--app <url>           Origin the QR code should open (default https://note-noodle.com)
--host <ip>           Advertise this address instead of guessing one
--bind <ip>           Listen only on this interface (default: all of them)
--quiet               No QR code, no banner
--log-midi[=<level>]  Print every MIDI message, decoded: notes, expr or all
                      (bare --log-midi means all)
--log-file <path>     Append every decoded message to <path> as JSON Lines
--help
```

Environment: `TUTOR_APP_ORIGIN=<url>` does what `--app` does, and
`TUTOR_BRIDGE_LOG_MIDI=<level>` what `--log-midi` does (`1` means `all`). A flag
wins over its variable.

`--host` is worth knowing about before you need it. This program has to guess
which of your machine's addresses the phone can reach, and Hyper-V, WSL, Docker
and most VPN clients all hold LAN-looking ones that it cannot. Every address
found is printed under the chosen one; pin the right one with this.

`--bind` is the other half of the same question. `--host` changes the address
this program *advertises*; `--bind` changes the one it *listens* on. The default
is every interface, on purpose: the phone may arrive over Wi-Fi or over a USB
tether, and those are two different addresses on this machine. Pass one to shut
the others out - `--bind 127.0.0.1` accepts only a browser on this computer.

The token is not decoration. This is a socket open to your local network that
injects MIDI into whatever your machine is running, so a device without the
token is refused. A fresh one is generated per run; `--token` pins it if you want
a QR code that keeps working across restarts.

---

## Verifying MPE in the terminal

"MIDI is active" in Live does not say whether the MPE setup arrived, what bend
range each channel was told, or whether a note's bend landed on that note's
channel. `--log-midi` does. It decodes every message the phone sends, keeping
the state a receiver would keep (the MPE zone, the RPN 0 range on each channel,
which notes are held), and prints one line per message:

```
music-theory-midi-bridge --log-midi=expr
```

```
19:04:12.301 [Tutor Staff #1] ch 1   MCM: lower zone, 15 member channels (ch 2-16)
19:04:12.302 [Tutor Staff #1] ch 2   RPN 0 pitch-bend range = 48 st
   ... one per member channel ...
19:04:12.310 [Tutor Staff #1] ch 1   RPN 0 pitch-bend range = 2 st
19:04:12.447 [Tutor Staff #1] ch 2   CC 74 Slide/Timbre = 64
19:04:12.449 [Tutor Staff #1] ch 2   NoteOn     C4 (60)  vel 96
19:04:12.465 [Tutor Staff #1] ch 2   PitchBend  +1.25 st (raw 8405, range +/-48)
19:04:12.577 [Tutor Staff #1] ch 2   PitchBend  +2.86 st (raw 8680, range +/-48)  [+6 not shown]
19:04:12.580 [Tutor Staff #1] ch 2   ChanPressure 40
19:04:12.930 [Tutor Staff #1] ch 1   CC 1 Modulation = 20
19:04:12.933 [Tutor Staff #1] ch 1   CC 64 Sustain on
19:04:12.937 [Tutor Staff #1] ch 2   NoteOff    C4 (60)  vel 64
19:04:12.938 [Tutor Staff #1] ch 2   PitchBend  centre (raw 8192, range +/-48)
19:04:12.939 [Tutor Staff #1] ch 2   ChanPressure 0
19:04:13.102 [Tutor Staff #1] ch 3   NoteOn     E4 (64)  vel 88
```

`[Tutor Staff #1]` is the port and the connection: two devices on one port get
two numbers. Channels are 1-based, as Live shows them. Notes are named with 60
as C4 - **Live calls 60 "C3"**, which is why the number is always there too.
Notes on channel 10 get their General MIDI drum name (`(drums, GM: Bass Drum 1)`)
only while channel 10 is not a member of an MPE zone: inside one it is a member
channel like the rest, and its notes are pitches.

When the connection closes, a summary says whether it was MPE a receiver could
use - read the last line first:

```
19:05:00.120 [Tutor Staff #1] MPE SUMMARY  android-app, 47.8 s, 1834 message(s) in 1834 frame(s)
19:05:00.120 [Tutor Staff #1]     MCM            lower zone, 15 member channel(s) (ch 2-16); 1 MCM(s), before the first note
19:05:00.120 [Tutor Staff #1]     RPN 0 range    ch 1 = 2 st; ch 2-16 = 48 st
19:05:00.120 [Tutor Staff #1]     members used   ch 2-7 (6 of 15)
19:05:00.120 [Tutor Staff #1]     master         ch 1: NoteOn 0  NoteOff 0  PB 0  CC74 0  CC1 12  CC11 0  ChanPressure 0  PolyPressure 0
19:05:00.120 [Tutor Staff #1]     members        ch 2-16: NoteOn 40  NoteOff 40  PB 910  CC74 212  CC1 0  CC11 0  ChanPressure 388  PolyPressure 0
19:05:00.120 [Tutor Staff #1]     held at close  none
19:05:00.120 [Tutor Staff #1]     timing         t runs +59 ms from arrival as a rule (clock offset + network); 0 frame(s) more than 20 ms ahead of it, 0 more than 50 ms behind
19:05:00.120 [Tutor Staff #1]     warnings       0
19:05:00.120 [Tutor Staff #1]     MPE: OK
```

Anything else there - `MPE: CHECK - ...` - names what is wrong: no MCM, notes
before the MCM, notes on the master channel, notes still held when the socket
closed that the bridge could not end (another device on the port still holds
them), dropped frames. With MPE off in the app the last
line reads `MPE: not used (plain MIDI)`, which is correct for plain MIDI.

**Levels.**

| Level | Shows |
| --- | --- |
| `notes` | note on/off, the MCM, RPN 0 ranges, sustain, all-notes-off, warnings, summaries |
| `expr` | `notes` plus pitch bend, channel and poly pressure, CC 74 (slide), CC 1 (mod wheel), CC 11 (expression) |
| `all` | every message, including RPN selection, clock and unknown CCs, each with its raw bytes (`\| E1 55 41`) |

At `expr` a continuous stream - one finger's bend, one note's pressure - prints
at most about ten lines a second per channel; `[+6 not shown]` counts what was
skipped, and the last value of a gesture is always printed. `all` never skips.

**Warnings** start with `!`, at every level:

- a note on the zone's master channel while MPE is on (a receiver treats it as
  zone-wide, so per-note bend does not apply to it);
- a second note held on one member channel (its bend now moves both);
- a note-off with no note-on before it on this connection;
- notes with their own bend or slide on several channels but no MPE
  Configuration Message - usually the MCM was lost, and Live will not treat the
  channels as one instrument;
- a frame holding more than one MIDI message, or longer than 3 bytes. RtMidi on
  Windows and macOS **silently drops** any non-SysEx message longer than 3 bytes
  (it prints to stderr and sends nothing), so such a frame never reaches Live;
- a frame the bridge dropped, with the reason (not JSON, a byte out of range,
  SysEx, larger than 4 KB).

A warning that repeats - the same kind on the same channel, such as a note on
the master channel for every note of a loop - prints in full the first time;
the repeats in the next 5 seconds are counted and printed as one line,
`! [+11 more] NoteOn on the zone master channel on ch 1 within 5.0 s ...`. The
summary's `warnings` row has every count, by kind and channel.

**Timing.** Each frame carries `t`, the milliseconds since its socket opened on
the phone. Compared with when the frame arrived here it is never exactly on
time: the two ends start their clocks at different moments, and every frame
spends a trip on the network. So each connection has a steady lead of its own -
`+59 ms` on a phone is typical - and the log measures that **baseline** from the
connection's fastest recent frame (the largest lead among the last 32: network
delay only ever makes a frame later), following it as the clocks drift. A line is marked only when its frame departs
from the baseline: `+1402 ms ahead` past 20 ms early, `-80 ms behind` past 50 ms
late (late is the network or a throttled tab; a few are normal on Wi-Fi). The
first mark on a connection comes after one line giving the baseline, and the
summary's `timing` row gives it again with the counts. Nothing is marked during
the first 8 frames, while the baseline settles.

`ahead` is a message stamped for the future but sent now - the Take Studio
sequencer looks up to 1.4 s ahead. The bridge does not wait for `t`; it writes
every frame as it arrives, so a message that arrives ahead is played early. The
app now holds a scheduled message until it is due, so from a current app this
should not appear; an app build from before that change shows it on every
sequenced note-off.

**To a file.** `--log-file midi.jsonl` appends one JSON object per message -
`{"type":"midi","conn":1,"port":"Tutor Staff","ch":2,"kind":"PitchBend","semitones":1.2482,"range":48,...}` -
plus one per dropped frame and one summary per connection. It records every
message whatever the console level, and works without `--log-midi` if the
console should stay quiet.

With neither flag nothing per message is printed, decoded or stored. The log
only reads what was already written to the port; it never changes it. The one
thing the bridge writes on its own - the release when a socket closes (see
[When the phone goes away mid-note](#when-the-phone-goes-away-mid-note)) - gets
a `bridge:` line of its own, and `held at close` in the summary says which notes
it ended.

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
