using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using HidSharp;

namespace PointZero.Core;

/// <summary>
/// Ties everything together: DualSense in → correction → virtual pad out, plus HidHide and the UI feed.
/// </summary>
public sealed class Engine : IDisposable
{
    public Settings Settings { get; }
    public Profile Profile { get; private set; }
    public string? StartupNotice { get; set; }

    public event Action? StatusChanged;
    public event Action<string>? Toast;

    readonly object _corrLock = new();
    readonly StickCorrector _left = new(), _right = new();
    readonly object _stateLock = new();
    readonly CloakManager _cloak = new();
    VirtualPad? _pad;
    string? _padError;
    bool _hidHideAvailable;
    DualSenseDevice? _device;
    readonly System.Threading.Timer _scanTimer;
    int _scanQueued;
    volatile bool _disposed;

    static readonly bool DebugLog = Environment.GetEnvironmentVariable("POINTZERO_DEBUG") == "1";
    volatile bool _calibrating;
    volatile bool _testerActive;
    public volatile bool UiWantsFrames = true;

    // UI feed
    readonly ConcurrentQueue<float[]> _samples = new();
    DsInput _last;
    byte _l2c, _r2c;
    (double, double, double) _gyro, _accel;
    readonly object _lastLock = new();
    readonly Stopwatch _clock = Stopwatch.StartNew();
    long _lastTicks;
    int _reportCount, _hz;
    long _hzWindowStart;
    string? _error;

    public Engine()
    {
        Settings = Settings.Load();
        Profile = ProfileStore.Load(Settings.ActiveProfile) ?? new Profile { Name = Settings.ActiveProfile };
        Profile.Sanitize();
        if (!ProfileStore.List().Contains(Profile.Name)) ProfileStore.Save(Profile);
        ApplyProfileToCorrectors();
        _scanTimer = new System.Threading.Timer(_ => Scan(), null, Timeout.Infinite, Timeout.Infinite);
    }

    public void Start()
    {
        FirstRun();

        _pad = VirtualPad.TryCreate(out _padError);
        if (_pad != null) _pad.Feedback += OnGameFeedback;

        _hidHideAvailable = _cloak.Available;
        if (_hidHideAvailable)
        {
            try { _cloak.EnsureAllowed(AllowedApps()); }
            catch (Exception ex) { Log.Write("HidHide whitelist: " + ex.Message); _hidHideAvailable = false; }
        }

        DeviceList.Local.Changed += (_, _) => QueueScan(250);
        QueueScan(0);
        _scanTimer.Change(0, 2000);   // also poll: cheap, and catches anything the change event misses
    }

    void FirstRun()
    {
        if (Settings.FirstRunDone) return;
        // Apps that already read the DualSense (e.g. a battery monitor) keep seeing it while it is hidden.
        foreach (var name in new[] { "BatteryHub" })
        {
            try
            {
                foreach (var p in Process.GetProcessesByName(name))
                {
                    string? path = p.MainModule?.FileName;
                    if (path != null && !Settings.Whitelist.Contains(path, StringComparer.OrdinalIgnoreCase))
                        Settings.Whitelist.Add(path);
                }
            }
            catch { }
        }
        Settings.FirstRunDone = true;
        Settings.Save();
    }

    IEnumerable<string> AllowedApps()
    {
        if (Environment.ProcessPath != null) yield return Environment.ProcessPath;
        foreach (var w in Settings.Whitelist) if (File.Exists(w)) yield return w;
    }

    // ---------------------------------------------------------------- device lifecycle

    void QueueScan(int delayMs)
    {
        if (Interlocked.Exchange(ref _scanQueued, 1) == 1) return;
        Task.Delay(delayMs).ContinueWith(_ => { Interlocked.Exchange(ref _scanQueued, 0); Scan(); });
    }

    // Every DualSense HID node present right now. A pad plugged in by cable while paired over Bluetooth shows up
    // twice (USB + Bluetooth): all of them must be hidden, not only the one Point Zéro reads.
    List<string> _presentIds = [];

    void Scan()
    {
        if (_disposed) return;
        bool changed = false;
        DualSenseDevice? dropped = null;
        lock (_stateLock)
        {
            var all = DualSenseDevice.Enumerate().ToList();
            var ids = all.Select(DualSenseDevice.InstanceIdOf).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            if (!ids.SequenceEqual(_presentIds, StringComparer.OrdinalIgnoreCase)) { _presentIds = ids; changed = true; }

            // Prefer USB (lower latency, audio): leave Bluetooth as soon as the cable is plugged in.
            if (_device is { Transport: Transport.Bluetooth } bt && all.Any(h => !DualSenseDevice.IsBluetooth(h)))
            {
                Log.Write("USB cable detected: switching from Bluetooth to USB");
                bt.Disconnected -= OnDisconnected;
                dropped = bt;
                _device = null;
            }

            if (_device == null)
            {
                foreach (var hid in all.OrderBy(h => DualSenseDevice.IsBluetooth(h) ? 1 : 0))
                {
                    DualSenseDevice? dev = null;
                    try { dev = DualSenseDevice.Open(hid); }
                    catch (Exception ex) { Log.Write("Open failed: " + ex.Message); }
                    if (dev == null) continue;
                    dev.Input += OnInput;
                    dev.Disconnected += OnDisconnected;
                    _device = dev;
                    _hz = 0; _reportCount = 0;
                    changed = true;
                    Log.Write($"Connected {dev.Model} {dev.Transport} fw=0x{dev.FirmwareVersion:X4} imu={dev.Imu.Valid} id={dev.InstanceId}");
                    break;
                }
            }
        }
        if (dropped != null) { dropped.Input -= OnInput; try { dropped.Dispose(); } catch { } }
        if (changed) Reconcile();
    }

    void OnDisconnected(DualSenseDevice dev)
    {
        Task.Run(() =>
        {
            lock (_stateLock)
            {
                if (_device != dev) return;
                _device = null;
            }
            Log.Write("Disconnected");
            _refreshDropSeen = true;
            _refreshBlockedBy = null;
            try { dev.Dispose(); } catch { }
            Reconcile();
            QueueScan(500);
        });
    }

    // While the real pad briefly disappears (pad refresh, Bluetooth hiccup), keep the virtual pad plugged in so games
    // don't see a controller unplug; it is removed only if the real pad stays away.
    const int PadGraceMs = 12000;   // a Bluetooth restart can take several seconds
    System.Threading.Timer? _padGrace;
    bool? _lastCloaked;          // hidden state the apps were last told about (null = unknown, e.g. at start)
    readonly HashSet<string> _covered = new(StringComparer.OrdinalIgnoreCase);   // nodes refreshed for that state

    /// <summary>Brings virtual pad + hiding in line with the user's intent and the hardware present. Idempotent.</summary>
    public void Reconcile()
    {
        if (_disposed) return;
        bool refresh = false;
        lock (_stateLock)
        {
            _error = null;
            var dev = _device;
            bool want = Settings.Correction && dev != null;
            try
            {
                if (_pad != null)
                {
                    if (want)
                    {
                        _padGrace?.Dispose(); _padGrace = null;
                        _pad.Connect(Settings.VirtualType == "ds4" ? VirtualType.DS4 : VirtualType.X360);
                    }
                    else if (Settings.Correction && _pad.Connected)
                    {
                        _pad.Submit(new PadFrame());   // neutral while the real pad is away
                        _padGrace ??= new System.Threading.Timer(_ => { lock (_stateLock) { _padGrace = null; } Reconcile2(); }, null, PadGraceMs, Timeout.Infinite);
                    }
                    else _pad.Disconnect();
                }
            }
            catch (Exception ex) { _error = "Manette virtuelle impossible à créer."; Log.Write("ViGEm: " + ex); }

            try
            {
                if (_hidHideAvailable)
                {
                    if (want && Settings.HideReal && _pad?.Connected == true)
                    {
                        _cloak.Hide(dev!.InstanceId);
                        foreach (var id in _presentIds) _cloak.Hide(id);   // the same pad's other node (USB + Bluetooth)
                    }
                    else if (!Settings.Correction || !Settings.HideReal) _cloak.UnhideAll();
                }
            }
            catch (Exception ex) { _error = "HidHide a refusé la modification."; Log.Write("HidHide: " + ex); }

            if (_error == null && want && Settings.HideReal && _hidHideAvailable && dev != null)
            {
                var stack = Native.DriverStack(dev.InstanceId);
                if (stack != null && !stack.Any(s => s.Contains("HidHide", StringComparison.OrdinalIgnoreCase)))
                    _error = "Débranche puis rebranche la manette une fois : HidHide ne peut pas encore la cacher.";
            }

            // Make every app re-detect the pad when its hidden state changes, or when a node nobody was refreshed for
            // shows up while hidden (cable plugged in, Bluetooth reconnect). Nodes that merely come back after our own
            // restart are already covered, so this can't loop.
            if (dev != null && _hidHideAvailable)
            {
                bool cloaked = _cloak.IsHidden(dev.InstanceId);
                var ids = _presentIds.Append(dev.InstanceId).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                if (_lastCloaked is bool was && was != cloaked) { refresh = true; _covered.Clear(); }
                else if (_lastCloaked == null && cloaked) refresh = true;
                else if (cloaked && ids.Any(id => !_covered.Contains(id))) refresh = true;
                if (refresh) foreach (var id in ids) _covered.Add(id);
                _lastCloaked = cloaked;
            }
        }
        if (refresh) RefreshPad(auto: true);
        StatusChanged?.Invoke();
    }

    // Grace timer callback: the real pad did not come back, drop the virtual one now.
    void Reconcile2()
    {
        lock (_stateLock)
        {
            if (_device == null) try { _pad?.Disconnect(); } catch { }
        }
        StatusChanged?.Invoke();
    }

    /// <summary>Restarts the pad so every app re-detects it. Returns false when the helper is missing.</summary>
    public bool RefreshPad(bool auto = false)
    {
        if (!HelperInstalled)
        {
            if (auto) Log.Write("Hidden state changed; pad refresh helper not installed.");
            return false;
        }
        Log.Write(auto ? "Pad refresh (hidden state changed)" : "Pad refresh (manual)");
        var started = DateTime.Now;
        _refreshDropSeen = false;
        _refreshBlockedBy = null;
        PadRefresher.Refresh(() => StatusChanged?.Invoke());
        StatusChanged?.Invoke();
        // A restart that worked makes our own handle drop too. If it did not, an app vetoed it (typically a game
        // that already had the pad open): find out which one from Windows' Kernel-PnP log and tell the user.
        Task.Delay(9000).ContinueWith(_ =>
        {
            var dev = _device;
            if (_refreshDropSeen || dev == null || _disposed) return;
            string? app = PadRefresher.FindVetoingApp(started);
            bool stuck = Native.IsRebootRequired(dev.InstanceId);
            _refreshBlockedBy = app ?? "une application";
            Log.Write($"Pad refresh had no effect: veto by {app ?? "?"}, rebootRequired={stuck}");
            Toast?.Invoke(stuck
                ? $"{(app ?? "Une application")} a refusé de lâcher la manette. Ferme-la, puis reconnecte la manette (câble, ou PS 10 s puis PS) pour que tout soit à jour."
                : $"{_refreshBlockedBy} garde la manette ouverte : ferme-la puis clique sur « Actualiser maintenant ».");
            StatusChanged?.Invoke();
        });
        return true;
    }

    /// <summary>Windows is waiting for the pad to be reconnected before it can restart it again.</summary>
    public bool PadNeedsReconnect =>
        (_device is { } d && Native.IsRebootRequired(d.InstanceId)) || _presentIds.Any(Native.IsRebootRequired);

    volatile bool _refreshDropSeen;
    volatile string? _refreshBlockedBy;

    bool? _helperInstalled;
    public bool HelperInstalled => _helperInstalled ??= PadRefresher.IsInstalled;

    /// <summary>Installs or removes the helper (UAC prompt). Runs on a worker thread.</summary>
    public void SetHelper(bool install)
    {
        Task.Run(() =>
        {
            string? err = PadRefresher.RunElevated(install);
            _helperInstalled = PadRefresher.IsInstalled;
            if (err != null) Toast?.Invoke(err);
            else if (install && _helperInstalled == true)
            {
                Toast?.Invoke("Actualisation automatique activée");
                if (_device != null && _lastCloaked == true) RefreshPad();   // apply it right away
            }
            else if (!install) Toast?.Invoke("Actualisation automatique désactivée");
            StatusChanged?.Invoke();
        });
    }

    // ---------------------------------------------------------------- input path (reader thread)

    void OnInput(DsInput s)
    {
        long now = _clock.ElapsedTicks;
        double dt = _lastTicks == 0 ? 0.004 : Math.Clamp((now - _lastTicks) / (double)Stopwatch.Frequency, 0, 0.1);
        _lastTicks = now;

        double lrx = StickCorrector.NormX(s.LX), lry = StickCorrector.NormY(s.LY);
        double rrx = StickCorrector.NormX(s.RX), rry = StickCorrector.NormY(s.RY);
        (double X, double Y) lo, ro;
        byte l2c, r2c;
        bool cal = _calibrating;
        lock (_corrLock)
        {
            lo = _left.Process(lrx, lry, dt, cal);
            ro = _right.Process(rrx, rry, dt, cal);
            l2c = Profile.Trigger("L").Apply(s.L2);
            r2c = Profile.Trigger("R").Apply(s.R2);
        }

        var pad = _pad;
        if (pad != null && pad.Connected)
        {
            var f = new PadFrame
            {
                LX = cal ? 0 : lo.X, LY = cal ? 0 : lo.Y, RX = cal ? 0 : ro.X, RY = cal ? 0 : ro.Y,
                L2 = l2c, R2 = r2c, Buttons = s.Buttons,
            };
            pad.Submit(f);
        }

        if (UiWantsFrames)
        {
            _samples.Enqueue([(float)lrx, (float)lry, (float)lo.X, (float)lo.Y, (float)rrx, (float)rry, (float)ro.X, (float)ro.Y]);
            while (_samples.Count > 1200 && _samples.TryDequeue(out _)) { }
        }

        var dev = _device;
        lock (_lastLock)
        {
            _last = s;
            _l2c = l2c; _r2c = r2c;
            if (dev != null) { _gyro = dev.Imu.Gyro(s); _accel = dev.Imu.Accel(s); }
        }

        _reportCount++;
        if (now - _hzWindowStart >= Stopwatch.Frequency)
        {
            _hz = _reportCount;
            _reportCount = 0;
            _hzWindowStart = now;
            if (DebugLog && pad != null)
                Log.Write($"hz={_hz} raw L({s.LX},{s.LY}) R({s.RX},{s.RY}) out L({lo.X:F3},{lo.Y:F3}) R({ro.X:F3},{ro.Y:F3}) " +
                          $"pad={pad.Connected} submits={pad.SubmitCount} errors={pad.SubmitErrors} {pad.LastSubmitError}");
        }
    }

    void OnGameFeedback(byte strong, byte weak, int led)
    {
        if (_testerActive) return;
        _device?.UpdateOutput(o =>
        {
            o.MotorLeft = strong;
            o.MotorRight = weak;
            if (led is >= 0 and <= 3)
            {
                o.PlayerLedsSet = true;
                o.PlayerLeds = PlayerPattern(led + 1);
            }
        });
    }

    static byte PlayerPattern(int player) => player switch
    {
        1 => 0b00100,
        2 => 0b01010,
        3 => 0b10101,
        4 => 0b11011,
        _ => 0b11111,
    };

    // ---------------------------------------------------------------- UI feed

    public string BuildFrameJson()
    {
        var buf = new ArrayBufferWriter<byte>(4096);
        using (var w = new Utf8JsonWriter(buf))
        {
            w.WriteStartObject();
            w.WriteString("t", "frame");

            w.WriteStartObject("samples");
            w.WriteStartArray("L");
            var drained = new List<float[]>(16);
            while (_samples.TryDequeue(out var smp)) drained.Add(smp);
            foreach (var smp in drained)
            {
                w.WriteStartArray();
                for (int i = 0; i < 4; i++) w.WriteNumberValue(Math.Round(smp[i], 4));
                w.WriteEndArray();
            }
            w.WriteEndArray();
            w.WriteStartArray("R");
            foreach (var smp in drained)
            {
                w.WriteStartArray();
                for (int i = 4; i < 8; i++) w.WriteNumberValue(Math.Round(smp[i], 4));
                w.WriteEndArray();
            }
            w.WriteEndArray();
            w.WriteEndObject();

            DsInput s; byte l2c, r2c; (double, double, double) g, a;
            lock (_lastLock) { s = _last; l2c = _l2c; r2c = _r2c; g = _gyro; a = _accel; }

            w.WriteStartObject("s");
            w.WriteNumber("lx", s.LX); w.WriteNumber("ly", s.LY); w.WriteNumber("rx", s.RX); w.WriteNumber("ry", s.RY);
            w.WriteNumber("l2", s.L2); w.WriteNumber("r2", s.R2); w.WriteNumber("l2c", l2c); w.WriteNumber("r2c", r2c);
            w.WriteNumber("b", (uint)s.Buttons);
            w.WriteStartArray("gyro");
            w.WriteNumberValue(Math.Round(g.Item1, 2)); w.WriteNumberValue(Math.Round(g.Item2, 2)); w.WriteNumberValue(Math.Round(g.Item3, 2));
            w.WriteEndArray();
            w.WriteStartArray("accel");
            w.WriteNumberValue(Math.Round(a.Item1, 3)); w.WriteNumberValue(Math.Round(a.Item2, 3)); w.WriteNumberValue(Math.Round(a.Item3, 3));
            w.WriteEndArray();
            w.WriteStartArray("touch");
            foreach (var tp in new[] { s.T0, s.T1 })
            {
                w.WriteStartObject();
                w.WriteBoolean("on", tp.On); w.WriteNumber("id", tp.Id); w.WriteNumber("x", tp.X); w.WriteNumber("y", tp.Y);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteStartObject("bat");
            w.WriteNumber("level", s.Battery); w.WriteBoolean("charging", s.Charging); w.WriteBoolean("full", s.Full);
            w.WriteEndObject();
            w.WriteStartObject("plug");
            w.WriteBoolean("headphones", s.Headphones); w.WriteBoolean("mic", s.Mic);
            w.WriteEndObject();
            w.WriteNumber("hz", _hz);
            w.WriteEndObject();

            double lcx, lcy, rcx, rcy;
            lock (_corrLock) { lcx = _left.CenterX; lcy = _left.CenterY; rcx = _right.CenterX; rcy = _right.CenterY; }
            w.WriteStartObject("center");
            w.WriteStartArray("L"); w.WriteNumberValue(Math.Round(lcx, 4)); w.WriteNumberValue(Math.Round(lcy, 4)); w.WriteEndArray();
            w.WriteStartArray("R"); w.WriteNumberValue(Math.Round(rcx, 4)); w.WriteNumberValue(Math.Round(rcy, 4)); w.WriteEndArray();
            w.WriteEndObject();

            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buf.WrittenSpan);
    }

    public bool HasDevice => _device != null;

    public object StatusObject()
    {
        var dev = _device;
        var pad = _pad;
        bool cloaked = dev != null && _hidHideAvailable && _cloak.IsHidden(dev.InstanceId);
        string? err = _error;
        if (pad == null) err ??= _padError;
        if (!_hidHideAvailable) err ??= "HidHide est absent : la vraie manette reste visible pour les jeux.";
        return new
        {
            t = "status",
            controller = new
            {
                connected = dev != null,
                model = dev?.Model ?? "",
                transport = dev == null ? "" : dev.Transport == Transport.Usb ? "usb" : "bt",
                firmware = dev == null ? "" : $"0x{dev.FirmwareVersion:X4}",
            },
            drivers = new { vigem = pad != null, hidhide = _hidHideAvailable },
            correction = Settings.Correction,
            hideReal = Settings.HideReal,
            cloaked,
            @virtual = new
            {
                connected = pad?.Connected == true,
                type = Settings.VirtualType,
                slot = pad?.Connected == true ? pad.Slot : 0,
            },
            helper = new
            {
                installed = HelperInstalled,
                refreshing = PadRefresher.Refreshing,
                blockedBy = _refreshBlockedBy,
                needsReconnect = PadNeedsReconnect,
            },
            error = err,
        };
    }

    public object HelloObject() => new
    {
        t = "hello",
        version = typeof(Engine).Assembly.GetName().Version?.ToString(3) ?? "1.0.0",
        settings = new
        {
            activeProfile = Profile.Name,
            virtualType = Settings.VirtualType,
            correction = Settings.Correction,
            hideReal = Settings.HideReal,
            checkUpdates = Settings.CheckUpdates,
            autostart = Settings.Autostart,
            closeToTray = Settings.CloseToTray,
            startMinimized = Settings.StartMinimized,
            whitelist = Settings.Whitelist,
        },
        profiles = ProfileStore.List(),
        profile = Profile,
        status = StatusObject(),
    };

    // ---------------------------------------------------------------- commands from the UI

    void ApplyProfileToCorrectors()
    {
        lock (_corrLock)
        {
            _left.SetParams(Profile.Stick("L"));
            _right.SetParams(Profile.Stick("R"));
        }
    }

    public void SetCorrection(bool on)
    {
        Settings.Correction = on;
        Settings.Save();
        Task.Run(Reconcile);
    }

    public void SetStick(string side, JsonElement p)
    {
        var sp = Profile.Stick(side);
        if (p.TryGetProperty("cx", out var v) && v.TryGetDouble(out var d)) sp.Cx = d;
        if (p.TryGetProperty("cy", out v) && v.TryGetDouble(out d)) sp.Cy = d;
        if (p.TryGetProperty("deadzone", out v) && v.TryGetDouble(out d)) sp.Deadzone = d;
        if (p.TryGetProperty("outer", out v) && v.TryGetDouble(out d)) sp.Outer = d;
        if (p.TryGetProperty("curve", out v) && v.TryGetDouble(out d)) sp.Curve = d;
        if (p.TryGetProperty("antiDeadzone", out v) && v.TryGetDouble(out d)) sp.AntiDeadzone = d;
        if (p.TryGetProperty("tracking", out v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False) sp.Tracking = v.GetBoolean();
        if (p.TryGetProperty("source", out v) && v.ValueKind == JsonValueKind.String &&
            v.GetString() is "default" or "diagnostic" or "calibration" or "manual") sp.Source = v.GetString()!;
        if (p.TryGetProperty("diagnosedAt", out v)) sp.DiagnosedAt = v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        if (p.TryGetProperty("diag", out v))
            sp.Diag = v.ValueKind == JsonValueKind.Object ? System.Text.Json.Nodes.JsonNode.Parse(v.GetRawText()) as System.Text.Json.Nodes.JsonObject : null;
        sp.Sanitize();
        ApplyProfileToCorrectors();
        SaveProfileSoon();
    }

    public void ResetStick(string side)
    {
        Profile.Sticks[side] = new StickParams();
        ApplyProfileToCorrectors();
        SaveProfileSoon();
    }

    public void SetTrigger(string side, JsonElement p)
    {
        var tp = Profile.Trigger(side);
        if (p.TryGetProperty("deadzone", out var v) && v.TryGetDouble(out var d)) tp.Deadzone = d;
        if (p.TryGetProperty("outer", out v) && v.TryGetDouble(out d)) tp.Outer = d;
        lock (_corrLock) tp.Sanitize();
        SaveProfileSoon();
    }

    CancellationTokenSource? _saveCts;
    void SaveProfileSoon()
    {
        _saveCts?.Cancel();
        var cts = _saveCts = new CancellationTokenSource();
        var snapshot = Profile.Clone();
        Task.Delay(600, cts.Token).ContinueWith(t => { if (!t.IsCanceled) ProfileStore.Save(snapshot); }, TaskScheduler.Default);
    }

    public void SetCalibrating(bool on) => _calibrating = on;

    public void SetVirtualType(string type)
    {
        Settings.VirtualType = type == "ds4" ? "ds4" : "x360";
        Settings.Save();
        Task.Run(() =>
        {
            lock (_stateLock) _pad?.Disconnect();
            Reconcile();
        });
    }

    public void ProfileSave(string name)
    {
        name = name.Trim();
        if (name.Length == 0) return;
        Profile = Profile.Clone();
        Profile.Name = name;
        ProfileStore.Save(Profile);
        Settings.ActiveProfile = name;
        Settings.Save();
        Toast?.Invoke($"Profil « {name} » enregistré");
    }

    public bool ProfileLoad(string name)
    {
        var p = ProfileStore.Load(name);
        if (p == null) return false;
        Profile = p;
        Settings.ActiveProfile = name;
        Settings.Save();
        ApplyProfileToCorrectors();
        return true;
    }

    public bool ProfileDelete(string name)
    {
        var all = ProfileStore.List();
        if (all.Count <= 1 || !all.Contains(name)) return false;
        ProfileStore.Delete(name);
        if (Profile.Name == name) ProfileLoad(ProfileStore.List()[0]);
        return true;
    }

    public void SetSetting(string key, bool value)
    {
        switch (key)
        {
            case "autostart":
                Settings.Autostart = value;
                try { Autostart.Set(value); } catch (Exception ex) { Log.Write("Autostart: " + ex.Message); }
                break;
            case "closeToTray": Settings.CloseToTray = value; break;
            case "startMinimized": Settings.StartMinimized = value; break;
            case "hideReal":
                Settings.HideReal = value;
                Settings.Save();
                Task.Run(Reconcile);
                return;
            case "checkUpdates": Settings.CheckUpdates = value; break;
            default: return;
        }
        Settings.Save();
    }

    public void WhitelistAdd(string path)
    {
        if (Settings.Whitelist.Contains(path, StringComparer.OrdinalIgnoreCase)) return;
        Settings.Whitelist.Add(path);
        Settings.Save();
        if (_hidHideAvailable) try { _cloak.EnsureAllowed([path]); } catch (Exception ex) { Log.Write("Whitelist add: " + ex.Message); }
    }

    public void WhitelistRemove(string path)
    {
        Settings.Whitelist.RemoveAll(p => p.Equals(path, StringComparison.OrdinalIgnoreCase));
        Settings.Save();
        if (_hidHideAvailable) try { _cloak.RemoveAllowed(path); } catch (Exception ex) { Log.Write("Whitelist remove: " + ex.Message); }
    }

    /// <summary>Makes the real pad visible (the correction keeps running). Same as turning "hideReal" off.</summary>
    public void UnhideNow()
    {
        SetSetting("hideReal", false);
        Toast?.Invoke("La vraie manette est visible");
    }

    public void SetTesterActive(bool on)
    {
        _testerActive = on;
        if (!on)
            _device?.UpdateOutput(o =>
            {
                o.MotorLeft = o.MotorRight = 0;
                o.TriggerL = TriggerEffects.Off();
                o.TriggerR = TriggerEffects.Off();
                if (o.AudioSet) { o.SpeakerRoute = false; }
            });
    }

    public void Rumble(int left, int right) =>
        _device?.UpdateOutput(o => { o.MotorLeft = (byte)Math.Clamp(left, 0, 255); o.MotorRight = (byte)Math.Clamp(right, 0, 255); });

    public void TriggerEffect(string side, JsonElement e)
    {
        string mode = e.TryGetProperty("mode", out var m) ? m.GetString() ?? "off" : "off";
        int I(string k, int def) => e.TryGetProperty(k, out var v) && v.TryGetInt32(out int i) ? i : def;
        byte[] fx = mode switch
        {
            "feedback" => TriggerEffects.Feedback(I("start", 3), I("strength", 6)),
            "weapon" => TriggerEffects.Weapon(I("start", 3), I("end", 6), I("strength", 7)),
            "vibration" => TriggerEffects.Vibration(I("start", 2), I("amplitude", 6), I("frequency", 30)),
            _ => TriggerEffects.Off(),
        };
        _device?.UpdateOutput(o => { if (side == "L") o.TriggerL = fx; else o.TriggerR = fx; });
    }

    public void Lightbar(int r, int g, int b) =>
        _device?.UpdateOutput(o => { o.LightbarSet = true; o.R = (byte)r; o.G = (byte)g; o.B = (byte)b; });

    public void PlayerLeds(int mask)
    {
        // UI: bit 0 = leftmost LED. Report: bit 0 = leftmost as well (Linux uses the same order).
        _device?.UpdateOutput(o => { o.PlayerLedsSet = true; o.PlayerLeds = (byte)(mask & 0x1F); });
    }

    public void MuteLed(int mode) =>
        _device?.UpdateOutput(o => { o.MuteLedSet = true; o.MuteLed = (byte)Math.Clamp(mode, 0, 2); });

    public void Audio(string route, int volume) =>
        _device?.UpdateOutput(o => { o.AudioSet = true; o.SpeakerRoute = route == "speaker"; o.Volume = (byte)Math.Clamp(volume, 0, 100); });

    // ---------------------------------------------------------------- shutdown

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _scanTimer.Dispose();
        _padGrace?.Dispose();
        try { _pad?.Disconnect(); } catch { }
        try { _cloak.UnhideAll(); } catch (Exception ex) { Log.Write("Unhide on exit: " + ex.Message); }
        // Let apps that were refused the pad (Steam, a browser) find it again.
        if (_lastCloaked == true && HelperInstalled) PadRefresher.RunNow();
        DualSenseDevice? dev;
        lock (_stateLock) { dev = _device; _device = null; }
        try { dev?.Dispose(); } catch { }
        try { _pad?.Dispose(); } catch { }
        Log.Write("Stopped");
    }
}
