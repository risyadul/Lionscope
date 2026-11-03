## Operating the emulator from the dashboard

The device picker lists every AVD, also the ones that are off. **Boot** starts one without a window on the host
GPU (`-no-window -gpu host`), as a **Quick boot** (loads the Quick Boot snapshot and saves it on shutdown) or a
**Cold boot** (`-no-snapshot-load`). Its screen then shows in the Device column, where you use it like the
emulator window: click and drag to touch, Alt+drag to pinch (two fingers mirrored around the centre), scroll
with the wheel, type when the screen has focus (Esc is Back), and use the toolbar for
Back, Home, Recents, Power, rotation, a full-resolution screenshot and the frame size (360, 540 or 720 px along
the short edge). Under the screen, next to Back/Home/Recents, the frame rate cap (≤15, ≤30 or ≤60 fps, or
**Other…** for a custom whole number from 5 to 60; 30 by default, remembered per browser) sets how many frames per
second the emulator streams at most, and applies to the running stream at once. A custom number outside 5–60 is
clamped into it, and a fraction rounded, with a note saying so; text that is not a number keeps the cap you had.
Mirroring works with or without a profiling session, and only streams while the column is open and the tab is
visible.

**Share clipboard** (toolbar, on by default) keeps the clipboards in step: text you copy on your computer is put
on Android's clipboard when you click or focus the screen, so Android's own long-press **Paste** has it, and
text copied inside Android lands on your computer's clipboard ("Copied from the emulator"). Cmd/Ctrl+V on the
screen pastes straight into the focused field. Any Unicode text up to 32 KB works. Reading your clipboard needs
the browser's clipboard permission (Chrome asks once); Firefox-based browsers (Firefox, Zen) and Safari don't offer it,
so there press Cmd/Ctrl+V on the screen to send your clipboard (the screen shows that hint); copying out of
Android works everywhere. Turn the toggle off and nothing is read from or written to either clipboard
(Cmd/Ctrl+V still pastes, as an explicit action).

**Shut down emulator** (in the Device column and next to the device picker) closes any running emulator, after
stopping a profiling session on it. Lionscope asks first when the emulator wasn't booted by Lionscope (for example
Android Studio) or a session is running. Emulators Lionscope booted are also shut down when the server stops; one
you started yourself never is.

Lionscope talks to the emulator's own gRPC endpoint, found through the emulator's discovery file
(`avd/running/pid_<pid>.ini`, which holds its port and access token). Frames are captured by the emulator on
the host side and sent as PNG only when the screen changes, so Android inside the emulator does no extra work
and the app's measurements are not affected; an idle screen sends nothing. While the screen changes, the frame
rate cap holds the emulator's stream back between frames (and while the browser is still receiving the last
one), so the emulator doesn't encode frames that would only be dropped, and the last frame of every change (the
settled screen) always arrives. On an M-series Mac at 540 px, a scrolling list streams at the cap; 30 fps sends
about half the data of 60 fps (~20 vs ~41 Mbit/s) and costs the emulator noticeably less CPU. Pick 60 for smooth
animations, 15 to save the most.

If an emulator renders in software (SwiftShader, e.g. `-no-window` without `-gpu host`), the dashboard warns:
frame times are then not representative of a device.

## Operating a physical device from the dashboard

Pick a phone connected over USB and its screen shows in the Device column, with the same controls as an
emulator (touch, multi-touch, wheel, keys, Share clipboard, Back / Home / Recents / Power, rotation where the app
allows it, screenshot and frame size). Nothing is installed on the phone: Lionscope pushes the bundled
[scrcpy](https://github.com/Genymobile/scrcpy) server (v5.0.1, Apache-2.0, checked against its published SHA-256)
to `/data/local/tmp`, runs it over adb while the column is open, and it removes itself when mirroring stops. The
phone's screen stays on while it is mirrored (scrcpy's `stay_awake`); the previous setting comes back afterwards.
The phone's hardware encoder sends H.264 video that the browser decodes with WebCodecs (Chrome, Firefox 130+,
Safari 16.4+; the dashboard must be opened on `localhost`).

The phone's hardware encoder does add a little work while it is mirrored, so close the Device column for the
cleanest measurements.

On Xiaomi / HyperOS (and some other OEM builds) the phone refuses injected input until **USB debugging (Security
settings)** is turned on in Developer options; the screen still mirrors and the dashboard tells you what to turn
on.
