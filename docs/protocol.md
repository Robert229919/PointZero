# Point Zéro — host ⇄ UI protocol

The UI (`src/PointZero/wwwroot`) runs in WebView2, served from `https://pointzero.local/`.
Messages are JSON objects with a `t` (type) field.

- Host → UI: `window.chrome.webview.addEventListener('message', e => e.data)` (already parsed JSON).
- UI → host: `window.chrome.webview.postMessage(obj)` (send a plain object, not a string).

Coordinate convention for sticks: normalized floats, **x right = +1, y up = +1**, range −1…+1.
Raw bytes from the controller are 0…255 (y down); the host converts.

## Host → UI

### `hello` (answer to `ready`, and after any reload)
```json
{ "t": "hello", "version": "1.0.0",
  "settings": {
    "activeProfile": "Défaut",
    "virtualType": "x360",            // "x360" | "ds4"
    "correction": true,               // master switch: virtual pad (+ hiding when hideReal)
    "hideReal": true,                 // hide the real pad from games while the correction is on
    "autostart": false,
    "closeToTray": true,
    "startMinimized": false,
    "whitelist": ["C:\\Users\\...\\BatteryHub.exe"]   // extra apps allowed to see the real pad
  },
  "profiles": ["Défaut", "FPS"],
  "profile": <Profile>,
  "status": <Status> }
```

### `status` (whenever something changes)
```json
{ "t": "status",
  "controller": { "connected": true, "model": "DualSense", "transport": "usb", "firmware": "0x0630" },
  "drivers":    { "vigem": true, "hidhide": true },
  "correction": true,            // master switch state (user intent)
  "hideReal": true,              // user intent: hide the real pad while correcting
  "cloaked": true,               // real pad currently hidden from games
  "virtual":    { "connected": true, "type": "x360", "slot": 1 },   // slot = XInput player index 1-4 (0 = unknown)
  "helper":     { "installed": true, "refreshing": false, "blockedBy": null, "needsReconnect": false },  // see below
  "error": null }                // short French message or null
```

Pad refresh: HidHide only blocks *new* opens. Apps that already hold the pad (Steam, a browser) keep seeing it,
and apps that failed while it was hidden don't notice it come back. Point Zéro therefore restarts the pad's HID node
after every change of the hidden state, through an elevated scheduled task (the "helper", installed once with UAC).
While `helper.installed` is false the UI should explain this and offer to install it.
An app that already holds the pad can refuse the restart (typically a game started before Point Zéro).
Then `helper.blockedBy` holds its executable name (e.g. `"MoonSweepers.exe"`, or `"une application"` when unknown)
until the next successful restart; the host also sends a toast.
After such a refusal Windows flags the pad "reboot required" and ignores further restarts until the pad is
reconnected: `helper.needsReconnect` is then true. UI text: "Reconnecte la manette (câble, ou PS 10 s puis PS)
pour que les applications déjà ouvertes voient le changement."

### `profile` / `profiles`
```json
{ "t": "profile", "profile": <Profile> }
{ "t": "profiles", "list": ["Défaut","FPS"], "active": "Défaut" }
```

`Profile`:
```json
{ "name": "Défaut",
  "sticks": {
    "L": { "cx": 0.0, "cy": 0.0, "deadzone": 0.05, "outer": 0.97, "curve": 1.0, "antiDeadzone": 0.0, "tracking": false },
    "R": { ... } },
  "triggers": {
    "L": { "deadzone": 0.02, "outer": 0.98 },
    "R": { ... } } }
```
- `cx, cy`: rest-position offset (normalized, y up) removed before everything else.
  After removal each half-axis is rescaled so full travel still reaches ±1 (no amplitude loss).
- `deadzone`: radius of the scaled radial deadzone (0…0.4). Output starts at 0 at the edge — no jump.
- `outer`: magnitude considered 100 % (0.7…1.0).
- `curve`: response exponent applied to the post-deadzone magnitude (0.4…3, 1 = linear, >1 = finer near centre).
- `antiDeadzone`: output floor to cancel a game's own deadzone (0…0.4).
- `tracking`: slow re-centring while the stick is at rest (drift that evolves over time).
- `source`: where the current centre/deadzone come from: `"default"` (never measured), `"diagnostic"`,
  `"calibration"` (2 s rest calibration) or `"manual"` (user moved a slider afterwards). The host stores it as-is.
- `diagnosedAt`: ISO-8601 date of the last diagnostic applied to this stick, or null.
- `diag`: summary of that diagnostic, or null:
  `{ "offset": 0.028, "spread": 0.020, "noise": 0.0, "deadzone": 0.0277, "outer": 1.0, "minAmplitude": 1.014,
     "circularity": 0.047, "jumps": 0, "verdict": "excellent" }` (fractions; verdict excellent|correct|limite|trop-fort).
  The UI sends `source`, `diagnosedAt` and `diag` inside `setStick` params; the host persists them in the profile.
- Triggers: `deadzone` = raw fraction ignored at the start, `outer` = raw fraction that already counts as 100 %.

### `frame` (~60 Hz while the window is visible)
```json
{ "t": "frame",
  "samples": { "L": [[rx,ry,ox,oy], ...], "R": [[rx,ry,ox,oy], ...] },
  "s": {
    "lx": 128, "ly": 127, "rx": 130, "ry": 125,      // raw bytes
    "l2": 0, "r2": 0, "l2c": 0, "r2c": 0,              // raw and corrected triggers 0-255
    "b": 0,                                            // button bitmask, see below
    "gyro": [0.12, -0.40, 0.03],                       // deg/s  (pitch, yaw, roll)
    "accel": [0.01, 0.99, 0.05],                       // g      (x, y, z)
    "touch": [ { "on": true, "id": 12, "x": 960, "y": 540 }, { "on": false, "id": 0, "x": 0, "y": 0 } ],
    "bat": { "level": 70, "charging": true, "full": false },
    "plug": { "headphones": false, "mic": false },
    "hz": 250 },
  "center": { "L": [cx, cy], "R": [cx, cy] } }         // current centre (moves when tracking is on)
```
`samples` holds **every** input report since the previous frame (USB ≈ 250 Hz → ~4 per frame):
`rx, ry` = raw normalized (y up, before offset removal), `ox, oy` = corrected output. Rounded to 4 decimals.
Touch coordinates: x 0…1919, y 0…1079.

Button bitmask `b` (bit index → name):
```
0 square   1 cross    2 circle   3 triangle
4 l1       5 r1       6 l2       7 r2        (l2/r2 = digital click at full travel)
8 create   9 options  10 l3      11 r3
12 ps      13 touchpad 14 mute
15 up      16 down    17 left    18 right
19 fnL     20 fnR     21 backL   22 backR    (DualSense Edge only)
```

### `settings` (after whitelist or setting changes; `hello` is also accepted at any time)
```json
{ "t": "settings", "settings": { ...same shape as hello.settings... } }
```

### `update` (a newer GitHub release exists; at start, every 6 h, or after `checkUpdates`)
```json
{ "t": "update", "version": "1.1.0", "current": "1.0.0", "url": "https://github.com/Robert229919/PointZero/releases/tag/v1.1.0",
  "name": "Point Zéro 1.1.0", "notes": "release notes (markdown, ≤ 1500 chars)", "publishedAt": "2026-12-01T10:00:00Z" }
```

### `toast`
```json
{ "t": "toast", "text": "Profil enregistré" }
```

## UI → host

| message | effect |
|---|---|
| `{t:"ready"}` | host answers `hello` |
| `{t:"setCorrection", on}` | master switch (virtual pad + hiding) |
| `{t:"setStick", side:"L"\|"R", params:{...partial stick params}}` | live update of the active profile |
| `{t:"setTrigger", side:"L"\|"R", params:{deadzone?, outer?}}` | live update |
| `{t:"resetStick", side}` | stick params back to defaults |
| `{t:"calibrating", on}` | freeze drift tracking + send neutral sticks to the virtual pad while a calibration/diagnostic runs |
| `{t:"setVirtualType", type:"x360"\|"ds4"}` | recreate the virtual pad |
| `{t:"profileSave", name}` | save current params under `name` (creates or overwrites) and make it active |
| `{t:"profileLoad", name}` | load and activate |
| `{t:"profileDelete", name}` | delete (not the last one) |
| `{t:"setting", key, value}` | `autostart`, `closeToTray`, `startMinimized`, `hideReal`, `checkUpdates`: bool |
| `{t:"whitelistAdd"}` | host opens a file picker for an .exe |
| `{t:"whitelistRemove", path}` | |
| `{t:"unhideNow"}` | legacy: same as `{t:"setting", key:"hideReal", value:false}` |
| `{t:"helperInstall"}` | install the pad-refresh helper (one UAC prompt); host answers with `status` + `toast` |
| `{t:"helperRemove"}` | uninstall it (one UAC prompt) |
| `{t:"refreshPad"}` | restart the pad now so every app re-detects it (needs the helper) |
| `{t:"checkUpdates"}` | check GitHub now; answers `update` or a toast "à jour" |
| `{t:"openUrl", url}` | open a page of this project's GitHub repo in the default browser (other URLs are refused) |
| `{t:"skipVersion", version}` | don't announce this version again automatically |
| `{t:"rumble", left, right}` | 0-255 each (left = strong/low freq, right = weak/high freq); `{left:0,right:0}` stops |
| `{t:"triggerEffect", side:"L"\|"R", effect}` | see below |
| `{t:"lightbar", r, g, b}` | 0-255 |
| `{t:"playerLeds", mask}` | 5 bits, bit 0 = leftmost LED |
| `{t:"muteLed", mode}` | 0 off, 1 on (2 = pulse is ignored by firmware 0x0520: stays solid) |
| `{t:"audio", route, volume}` | route `"speaker"` \| `"headphones"`, volume 0-100: routes the controller's audio output |
| `{t:"testerActive", on}` | while on, the host does not forward game rumble/LED to the pad |

`effect`:
```json
{ "mode": "off" }
{ "mode": "feedback",  "start": 0-9, "strength": 1-8 }            // continuous resistance from zone `start`
{ "mode": "weapon",    "start": 2-7, "end": 3-8, "strength": 1-8 } // resistance then click (trigger break)
{ "mode": "vibration", "start": 0-9, "amplitude": 1-8, "frequency": 1-255 }
```
