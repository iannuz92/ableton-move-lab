# Ableton Move Control Logic Map

Fonte funzionale: `Documentazione_originale_abletonmove/move1-manual-en.pdf`,
capitoli 6-20, in particolare "Move Control Reference". Fonte numeri MIDI:
`docs/move-midi-over-usbc-chart.pdf` piu' reverse runtime del binario
`rootfs/opt/move/Move`.

Questa tabella separa due livelli:

- **Logic**: cosa deve fare il controllo secondo il manuale.
- **Protocol**: quale evento MIDI/USB-MIDI mandiamo al binario Move.

## Global Modes

| Logic | Manual gesture | Protocol | Emulator status |
| --- | --- | --- | --- |
| Set Overview | `Shift + Step 1` | Shift CC `0x31` held + Step note `0x10` | Supported by raw events; needs runtime test |
| Note Mode | Track button from Set Overview; Note/Session toggle from Session | Track CC `0x2b..0x28`; Mode CC `0x32` | Supported |
| Session Mode | Note/Session toggle; from Set Overview press toggle | Mode CC `0x32` | Supported |
| Temporary mode preview | Hold Note/Session toggle | Mode CC `0x32` held | Protocol supported; GUI has no explicit hold affordance beyond pointer hold |
| Back/exit | Back press; Back hold exits current menu/view | Back CC `0x33` | Press supported; long-hold behavior not explicitly tested |

## Shift + Step Shortcuts

| Step | Manual function | Protocol | Emulator status |
| --- | --- | --- | --- |
| Step 1 | Set Overview | Shift held + note `0x10` | Supported; runtime LED confirmed |
| Step 2 | Setup menu | Shift held + note `0x11` | Supported; runtime LED confirmed |
| Step 3 | Workflow Settings: quantize, grid resolution, automation arm, autoload/count-in | Shift held + note `0x12` | Supported; runtime LED confirmed |
| Step 4 | No standalone function found in manual | Shift held + note `0x13` | No mapped logic expected |
| Step 5 | Tempo; wheel adjusts tempo, Shift+wheel fine increment | Shift held + note `0x14`; wheel CC `0x0e` | Supported; runtime LED confirmed |
| Step 6 | Metronome toggle/menu | Shift held + note `0x15` | Supported; runtime LED confirmed |
| Step 7 | Groove amount; wheel adjusts groove | Shift held + note `0x16`; wheel CC `0x0e` | Supported; runtime LED confirmed |
| Step 8 | 16 Pitches layout toggle for Drum Rack | Shift held + note `0x17` | Supported |
| Step 9 | Key & Scale menu | Shift held + note `0x18` | Supported; runtime LED confirmed |
| Step 10 | Full Velocity toggle | Shift held + note `0x19` | Supported |
| Step 11 | Repeat menu / repeat rate; wheel adjusts rate | Shift held + note `0x1a`; wheel CC `0x0e` | Supported |
| Step 12 | No standalone function found in manual | Shift held + note `0x1b` | No mapped logic expected |
| Step 13 | No standalone function found in manual | Shift held + note `0x1c` | No mapped logic expected |
| Step 14 | Prepare next available clip slot when current slot contains a clip | Shift held + note `0x1d` | Supported, needs runtime confirmation |
| Step 15 | Double loop for selected clip | Shift held + note `0x1e` | Supported |
| Step 16 | Quantize selected clip | Shift held + note `0x1f` | Supported |

Runtime note: while Shift is held, the step row is a function row, not a
sequencer trigger row. The engine reports Shift as CC `0x31 = 127` and emits
step note LEDs for available shortcuts. On the native Pi test, steps
1, 2, 3, 5, 6, 7, and 9 lit with velocities `122/124`; release returned
CC `0x31` to dim `24` and step note LEDs to zero. The GUI must suspend
`/api/song` trigger rendering while Shift is held and mirror engine step LEDs.

## Pads

| Mode/context | Manual logic | Protocol | Emulator status |
| --- | --- | --- | --- |
| Set Overview | Pads are Set slots; colored existing, pulsing selected, unlit empty, white selected empty | Pad notes `0x44..0x63`; LED ids same | Input supported; pad LED parser supported |
| Set Overview + Play | Preview selected Set | Play CC `0x55` | Supported |
| Set Overview + pad + Volume | Adjust selected Set volume | Pad held + Volume CC `0x4f` | Protocol supported; multi-touch/hold must be manually performed |
| Shift + pad in Set Overview | Color / Ableton Cloud options | Shift CC `0x31` held + pad note | Supported by raw events |
| Copy + pad in Set Overview | Copy Set, then paste to another pad | Copy CC `0x3c` held + pad note | Supported by raw events |
| Delete + pad in Set Overview | Delete Set / confirmation | Delete CC `0x77` held + pad note | Supported by raw events |
| Note Mode, Drum Rack | Left 16 pads play/sequence Drum Rack samples | Pad notes `0x44..0x63` | Input supported |
| Note Mode, 16 Pitches | Right 16 pads play selected Drum Rack sample pitched | Pad notes `0x44..0x63` | Input supported; mode is engine-owned |
| Note Mode, melodic | All 32 pads play/sequence scale/chromatic notes | Pad notes `0x44..0x63` | Input supported |
| Pad pressure | Polyphonic aftertouch modulates supported instruments | Poly aftertouch `0xa0` per pad note | Packet function exists; GUI does not emit continuous pointer pressure yet |
| Mute + Drum Rack pad | Mute/unmute pad | Mute held + pad note | Supported by raw events |
| Copy + Drum Rack pad | Copy/paste devices in pad | Copy held + pad note | Supported by raw events |
| Delete + pad | Delete note/sample/slice depending on sub-mode | Delete held + pad note | Supported by raw events |

## Step Buttons

| Context | Manual logic | Protocol | Emulator status |
| --- | --- | --- | --- |
| Note Mode | Step buttons represent 1/16 divisions by default | Step notes `0x10..0x1f` | Supported |
| Pad then Step | Add/remove note for selected pad/sample at step | Pad note + step note | Supported by raw events |
| Step then Pad | Add note to held step | Step held + pad note | Supported by raw events |
| Drum Rack / 16 Pitches | Step LEDs show only selected sample's notes | LED ids `0x10..0x1f` from engine | GUI now treats engine LED stream as authority |
| Melodic instrument | Step LEDs show all notes regardless of pitch | LED ids `0x10..0x1f` | Engine-owned |
| Step hold + Volume | Adjust velocity | Step held + Volume CC `0x4f` | Supported |
| Step hold + Wheel | Adjust note length | Step held + Wheel CC `0x0e` | Supported |
| Step hold + Left/Right | Nudge notes by 10%; Shift fine nudge | Step held + CC `0x3e/0x3f`; optional Shift | Supported |
| Step hold + Plus/Minus | Transpose semitone; long press octave | Step held + CC `0x37/0x36` | Press supported; long-press timing not explicitly handled |
| Copy + Step | Copy note/automation from step; step range copy | Copy held + step notes | Supported by raw events |
| Step hold + Pad in melodic | Add/remove multiple notes/chords | Step held + pad notes | Supported by raw events |
| Loop Mode | Steps represent bars; white selected, track color in-loop, dim outside loop | Step notes + engine LEDs | Input supported; LED interpretation engine-owned |

## Transport And Function Buttons

| Control | Manual logic | Protocol | Emulator status |
| --- | --- | --- | --- |
| Play | Start/stop playback | CC `0x55` | Supported |
| Shift + Play | Retrigger all active clips | Shift held + CC `0x55` | Supported |
| Record | Start/stop recording; starts playback after count-in if stopped | CC `0x56` | Supported |
| Capture | Capture played notes and automation; stopped transport can detect tempo | CC `0x34` | Supported |
| Sampling | Enter Sampling Mode; choose source/pad and record audio | CC `0x76` | Supported |
| Loop | Enter Loop Mode; bars shown on steps | CC `0x3a` | Supported |
| Mute | Mute tracks or Drum Rack pads, context-dependent | CC `0x58` held + target | Supported |
| Delete | Delete Sets/clips/notes/samples; Delete + encoder touch deletes automation | CC `0x77` held + target | Supported except encoder touch UX is scroll-only |
| Copy | Copy Sets, notes, step ranges, bars, clips | CC `0x3c` held + target | Supported |
| Undo | Undo last action | CC `0x38` | Supported |
| Shift + Undo | Redo | Shift held + CC `0x38` | Supported |

## Wheel, Encoders, Volume

| Control/context | Manual logic | Protocol | Emulator status |
| --- | --- | --- | --- |
| Wheel rotate | Navigate devices/menus/browser; adjust tempo/groove/repeat/loop length by context | CC `0x0e`, relative `0x01/0x7f` | Supported; normalized to avoid step jumps |
| Wheel press | Confirm/select; open browser from selected device/preset; fold/unfold racks in Live mode | CC `0x03` | Supported as `wheelPress` |
| Shift + Wheel press | Access sample parameter banks / options submenu in context | Shift held + CC `0x03` | Supported |
| Wheel touch | Capacitive touch note | Note `0x09` | Supported during scroll gesture |
| 8 encoders rotate | Adjust selected device/effect parameters | CC `0x47..0x4e` | Supported |
| 8 encoder touch | Show parameter; Delete + touch deletes automation | Notes `0x00..0x07` | Packet supported; GUI emits touch only around scroll, not tap-only touch |
| Volume encoder | Main/track/pad/Set/output volume by context | CC `0x4f` | Supported |
| Volume touch | Capacitive touch note | Note `0x08` | Supported during scroll gesture |

## Session Mode

| Logic | Manual gesture | Protocol | Emulator status |
| --- | --- | --- | --- |
| Clip grid | Pads are track clip slots and scenes | Pad notes `0x44..0x63` | Input supported; LED state engine-owned |
| Launch clip | Press clip pad | Pad note | Supported |
| Play scene | Slide vertically over a column while transport runs | Multiple pad notes in sequence | Not explicitly implemented as slide gesture; individual pad presses work |
| Select clip/scene | Shift + pad | Shift held + pad note | Supported |
| Copy/delete clip/scene | Copy/Delete held + pad | Modifier held + pad note | Supported |
| Session step controls | Odd steps select tracks; even steps stop clips; Step 15 Main, Step 16 stop all | Step notes `0x10..0x1f` | Supported by raw step events |
| Session horizontal nav | Left/Right; Shift by seven tracks | CC `0x3e/0x3f`; optional Shift | Supported |
| Session vertical nav | Plus/Minus; Shift by four scenes | CC `0x37/0x36`; optional Shift | Supported |

## Current Gaps To Verify Or Implement

1. **Runtime step trigger LEDs**: manual says Drum Rack/16 Pitches shows only the
   selected sample's notes on step LEDs; melodic shows all notes. GUI now uses
   engine step LEDs as the realtime source when present, rendering only high
   velocities (`>=120`) as triggers and treating dim values such as `104` as
   non-trigger/background state. `/api/song` remains fallback when no engine
   step-row context is available.
2. **`/api/song` fallback**: fixed path selection to only use `Song.abl`; should
   be used for diagnostics/fallback, not as primary truth.
3. **Continuous aftertouch**: protocol exists, but GUI does not yet emit pointer
   pressure changes after pad down.
4. **Tap-only capacitive touch** for encoders/volume: protocol exists, GUI emits
   touch only around wheel/scroll interactions.
5. **Long press semantics**: Back hold, Plus/Minus octave transpose, Left/Right
   full-step nudge, Note/Session hold preview need timing tests against Move.
6. **Session vertical slide gesture**: manual describes sliding over a pad column
   to play/stop scenes; GUI currently sends individual pad presses only.
7. **UI labels**: hidden/manual shortcuts such as Shift+Step 1/2/3/5/6/7/8/9/10/11/14/15/16
   are not visually exposed on the virtual surface.
