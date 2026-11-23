using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Reflection;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using PointZero.Core;

namespace PointZero.UI;

public sealed class MainForm : Form
{
    const string Host = "pointzero.local";
    static readonly Color Bg = Color.FromArgb(10, 10, 10);

    readonly Engine _engine;
    readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Bg };
    readonly System.Windows.Forms.Timer _frameTimer = new() { Interval = 16 };
    readonly System.Windows.Forms.Timer _statusTimer = new() { Interval = 1500 };
    readonly System.Windows.Forms.Timer _updateTimer = new() { Interval = 6 * 3600 * 1000 };
    ReleaseInfo? _pendingUpdate;
    readonly NotifyIcon _tray = new();
    readonly ToolStripMenuItem _trayCorrection = new("Correction active");
    readonly ToolStripMenuItem _trayHide = new("Cacher la vraie manette");
    readonly Icon _iconOn, _iconOff;
    readonly string? _devRoot = Environment.GetEnvironmentVariable("POINTZERO_WWWROOT");
    bool _webReady, _exiting, _trayHintShown, _startHidden;
    string _lastStatusJson = "";

    public MainForm(Engine engine, bool startHidden)
    {
        _engine = engine;
        _startHidden = startHidden;
        Text = "Point Zéro";
        BackColor = Bg;
        ClientSize = new Size(1280, 800);
        MinimumSize = new Size(1100, 720);
        StartPosition = FormStartPosition.CenterScreen;
        using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("PointZero.ico"))
            if (s != null) Icon = new Icon(s);
        _iconOn = TrayIcons.Make(true);
        _iconOff = TrayIcons.Make(false);
        Controls.Add(_web);

        BuildTray();

        _frameTimer.Tick += (_, _) => PushFrame();
        _statusTimer.Tick += (_, _) => PushStatus();
        _updateTimer.Tick += async (_, _) => await CheckForUpdateAsync(manual: false);
        _updateTimer.Start();
        // First check shortly after start (also when starting hidden in the tray).
        var first = new System.Windows.Forms.Timer { Interval = 8000 };
        first.Tick += async (_, _) => { first.Stop(); first.Dispose(); await CheckForUpdateAsync(manual: false); };
        first.Start();
        _engine.StatusChanged += () => RunOnUi(PushStatus);
        _engine.Toast += text => RunOnUi(() => Post(new { t = "toast", text }));

        Microsoft.Win32.SystemEvents.SessionEnding += (_, _) => _engine.Dispose();
    }

    protected override void SetVisibleCore(bool value)
    {
        if (_startHidden && !IsHandleCreated) { CreateHandle(); value = false; }
        base.SetVisibleCore(value);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Native.DarkTitleBar(Handle, 0x000A0A0A);
    }

    protected override async void OnShown(EventArgs e)
    {
        base.OnShown(e);
        await InitWebAsync();
    }

    Task? _init;
    Task InitWebAsync() => _init ??= InitWebCoreAsync();

    async Task InitWebCoreAsync()
    {
        try
        {
            var options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
            var env = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewData, options);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            Log.Write("WebView2: " + ex);
            MessageBox.Show(this, "Le composant Microsoft Edge WebView2 est introuvable.\nInstalle « WebView2 Runtime » depuis le site de Microsoft puis relance Point Zéro.",
                "Point Zéro", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        var core = _web.CoreWebView2;
        bool devtools = Debugger.IsAttached || _devRoot != null;
        core.Settings.AreDevToolsEnabled = devtools;
        core.Settings.AreDefaultContextMenusEnabled = devtools;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = devtools;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;

        core.AddWebResourceRequestedFilter($"https://{Host}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += ServeResource;
        core.PermissionRequested += (_, e) =>
        {
            // Microphone access is only used by the tester to monitor the controller's microphone.
            e.State = e.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)
                ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
        };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.NavigationStarting += (_, e) =>
        {
            if (!e.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
        };
        core.WebMessageReceived += OnWebMessage;
        core.Navigate($"https://{Host}/index.html");
        _webReady = true;
        _frameTimer.Start();
        _statusTimer.Start();
    }

    // ---------------------------------------------------------------- static files

    static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8", [".css"] = "text/css; charset=utf-8", [".js"] = "text/javascript; charset=utf-8",
        [".json"] = "application/json", [".svg"] = "image/svg+xml", [".png"] = "image/png", [".ico"] = "image/x-icon",
        [".ttf"] = "font/ttf", [".woff2"] = "font/woff2", [".woff"] = "font/woff", [".wav"] = "audio/wav", [".mp3"] = "audio/mpeg",
    };

    void ServeResource(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var uri = new Uri(e.Request.Uri);
        string rel = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
        if (rel.Length == 0) rel = "index.html";
        if (rel.Contains("..")) { e.Response = _web.CoreWebView2.Environment.CreateWebResourceResponse(null, 403, "Forbidden", ""); return; }

        Stream? data = null;
        if (_devRoot != null)
        {
            string f = Path.Combine(_devRoot, rel.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(f)) data = new MemoryStream(File.ReadAllBytes(f));
        }
        data ??= Assembly.GetExecutingAssembly().GetManifestResourceStream("wwwroot/" + rel)
                 ?? Assembly.GetExecutingAssembly().GetManifestResourceStream("wwwroot/" + rel.Replace('/', '\\'));
        if (data == null)
        {
            e.Response = _web.CoreWebView2.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");
            return;
        }
        string type = Mime.TryGetValue(Path.GetExtension(rel), out var m) ? m : "application/octet-stream";
        e.Response = _web.CoreWebView2.Environment.CreateWebResourceResponse(data, 200, "OK",
            $"Content-Type: {type}\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: https://{Host}");
    }

    // ---------------------------------------------------------------- messages

    void Post(object msg)
    {
        if (!_webReady || _web.CoreWebView2 == null) return;
        try { _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(msg, Json.Options)); } catch { }
    }

    void PushFrame()
    {
        bool visible = Visible && WindowState != FormWindowState.Minimized;
        _engine.UiWantsFrames = visible;
        if (!visible || !_webReady || !_engine.HasDevice) return;
        try { _web.CoreWebView2.PostWebMessageAsJson(_engine.BuildFrameJson()); } catch { }
    }

    void PushStatus()
    {
        var status = _engine.StatusObject();
        string json = JsonSerializer.Serialize(status, Json.Options);
        UpdateTray(status);
        if (json == _lastStatusJson) return;
        _lastStatusJson = json;
        if (_webReady) try { _web.CoreWebView2.PostWebMessageAsJson(json); } catch { }
    }

    void SendHello()
    {
        _lastStatusJson = "";
        Post(_engine.HelloObject());
        if (_engine.StartupNotice is { } notice)
        {
            _engine.StartupNotice = null;
            Post(new { t = "toast", text = notice });
        }
        if (_pendingUpdate != null) PostUpdate(_pendingUpdate);
    }

    // ---------------------------------------------------------------- new releases

    async Task CheckForUpdateAsync(bool manual)
    {
        if (!manual && !_engine.Settings.CheckUpdates) return;
        var rel = await UpdateChecker.CheckAsync();
        if (rel == null)
        {
            if (manual) Post(new { t = "toast", text = $"Point Zéro est à jour (version {UpdateChecker.Current.ToString(3)})" });
            return;
        }
        if (!manual && rel.Version == _engine.Settings.SkippedVersion) return;
        bool isNew = _pendingUpdate?.Version != rel.Version;
        _pendingUpdate = rel;
        PostUpdate(rel);
        if (isNew && (!Visible || WindowState == FormWindowState.Minimized))
        {
            _tray.BalloonTipTitle = $"Point Zéro {rel.Version} est disponible";
            _tray.BalloonTipText = "Clique ici pour voir les nouveautés.";
            _tray.ShowBalloonTip(8000);
        }
    }

    void PostUpdate(ReleaseInfo r) => Post(new
    {
        t = "update",
        version = r.Version,
        current = UpdateChecker.Current.ToString(3),
        url = r.Url,
        name = r.Name,
        notes = r.Notes,
        publishedAt = r.PublishedAt,
    });

    static void OpenReleasePage(string url)
    {
        // Only ever open this project's GitHub pages.
        if (!url.StartsWith($"https://github.com/{UpdateChecker.Repo}/", StringComparison.OrdinalIgnoreCase)) url = UpdateChecker.ReleasesPage;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch (Exception ex) { Log.Write("Open URL: " + ex.Message); }
    }

    void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonElement m;
        try { m = JsonDocument.Parse(e.WebMessageAsJson).RootElement; }
        catch { return; }
        if (m.ValueKind != JsonValueKind.Object || !m.TryGetProperty("t", out var tEl)) return;
        string side = m.TryGetProperty("side", out var sEl) && sEl.GetString() == "R" ? "R" : "L";
        bool On() => m.TryGetProperty("on", out var o) && o.ValueKind == JsonValueKind.True;
        int Int(string k, int def = 0) => m.TryGetProperty(k, out var v) && v.TryGetInt32(out int i) ? i : def;
        string Str(string k) => m.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

        try
        {
            switch (tEl.GetString())
            {
                case "ready": SendHello(); break;
                case "setCorrection": _engine.SetCorrection(On()); PushStatus(); break;
                case "setStick": if (m.TryGetProperty("params", out var sp)) _engine.SetStick(side, sp); break;
                case "setTrigger": if (m.TryGetProperty("params", out var tp)) _engine.SetTrigger(side, tp); break;
                case "resetStick": _engine.ResetStick(side); Post(new { t = "profile", profile = _engine.Profile }); break;
                case "calibrating": _engine.SetCalibrating(On()); break;
                case "setVirtualType": _engine.SetVirtualType(Str("type")); break;
                case "profileSave":
                    _engine.ProfileSave(Str("name"));
                    Post(new { t = "profiles", list = ProfileStore.List(), active = _engine.Profile.Name });
                    Post(new { t = "profile", profile = _engine.Profile });
                    break;
                case "profileLoad":
                    if (_engine.ProfileLoad(Str("name")))
                    {
                        Post(new { t = "profile", profile = _engine.Profile });
                        Post(new { t = "profiles", list = ProfileStore.List(), active = _engine.Profile.Name });
                    }
                    break;
                case "profileDelete":
                    if (_engine.ProfileDelete(Str("name")))
                    {
                        Post(new { t = "profiles", list = ProfileStore.List(), active = _engine.Profile.Name });
                        Post(new { t = "profile", profile = _engine.Profile });
                    }
                    else Post(new { t = "toast", text = "Impossible de supprimer le dernier profil." });
                    break;
                case "setting":
                    if (m.TryGetProperty("value", out var val) && val.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    {
                        _engine.SetSetting(Str("key"), val.GetBoolean());
                        PushStatus();
                    }
                    break;
                case "whitelistAdd": PickWhitelistApp(); break;
                case "whitelistRemove": _engine.WhitelistRemove(Str("path")); SendHello(); break;
                case "unhideNow": _engine.UnhideNow(); break;
                case "openUrl": OpenReleasePage(Str("url")); break;
                case "skipVersion":
                    _engine.Settings.SkippedVersion = Str("version");
                    _engine.Settings.Save();
                    break;
                case "checkUpdates": _ = CheckForUpdateAsync(manual: true); break;
                case "helperInstall": _engine.SetHelper(true); break;
                case "helperRemove": _engine.SetHelper(false); break;
                case "refreshPad":
                    if (!_engine.RefreshPad()) Post(new { t = "toast", text = "Active d'abord l'actualisation automatique (Réglages)." });
                    break;
                case "rumble": _engine.Rumble(Int("left"), Int("right")); break;
                case "triggerEffect": if (m.TryGetProperty("effect", out var fx)) _engine.TriggerEffect(side, fx); break;
                case "lightbar": _engine.Lightbar(Int("r"), Int("g"), Int("b")); break;
                case "playerLeds": _engine.PlayerLeds(Int("mask")); break;
                case "muteLed": _engine.MuteLed(Int("mode")); break;
                case "audio": _engine.Audio(Str("route"), Int("volume", 80)); break;
                case "testerActive": _engine.SetTesterActive(On()); break;
            }
        }
        catch (Exception ex)
        {
            Log.Write($"UI message {tEl.GetString()}: {ex}");
        }
    }

    void PickWhitelistApp()
    {
        using var dlg = new OpenFileDialog
        {
            Title = "Application autorisée à voir la vraie manette",
            Filter = "Applications (*.exe)|*.exe",
            CheckFileExists = true,
        };
        if (dlg.ShowDialog(this) == DialogResult.OK)
        {
            _engine.WhitelistAdd(dlg.FileName);
            SendHello();
        }
    }

    void RunOnUi(Action a)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(a); } catch { }
    }

    // ---------------------------------------------------------------- tray

    void BuildTray()
    {
        var menu = new ContextMenuStrip { Renderer = new DarkMenuRenderer(), ShowImageMargin = false, ShowCheckMargin = true, Font = new Font("Segoe UI", 9.5f) };
        var open = new ToolStripMenuItem("Ouvrir Point Zéro", null, (_, _) => ShowFromTray()) { Font = new Font("Segoe UI", 9.5f, FontStyle.Bold) };
        _trayCorrection.Click += (_, _) => { _engine.SetCorrection(!_engine.Settings.Correction); PushStatus(); };
        _trayHide.Click += (_, _) => { _engine.SetSetting("hideReal", !_engine.Settings.HideReal); PushStatus(); };
        var quit = new ToolStripMenuItem("Quitter", null, (_, _) => ExitApp());
        menu.Items.AddRange([open, new ToolStripSeparator(), _trayCorrection, _trayHide, new ToolStripSeparator(), quit]);
        _tray.ContextMenuStrip = menu;
        _tray.Icon = _iconOff;
        _tray.Text = "Point Zéro";
        _tray.Visible = true;
        _tray.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowFromTray(); };
        _tray.BalloonTipClicked += (_, _) =>
        {
            ShowFromTray();
            if (_pendingUpdate != null) PostUpdate(_pendingUpdate);
        };
    }

    void UpdateTray(object status)
    {
        bool corr = _engine.Settings.Correction;
        var json = JsonSerializer.SerializeToElement(status, Json.Options);
        bool connected = json.GetProperty("controller").GetProperty("connected").GetBoolean();
        bool virt = json.GetProperty("virtual").GetProperty("connected").GetBoolean();
        bool cloaked = json.GetProperty("cloaked").GetBoolean();
        _trayCorrection.Checked = corr;
        _trayHide.Checked = _engine.Settings.HideReal;
        _trayHide.Enabled = corr;
        _tray.Icon = corr && virt ? _iconOn : _iconOff;
        string text = !connected ? "Point Zéro — aucune manette"
            : corr && virt ? $"Point Zéro — correction active{(cloaked ? ", vraie manette cachée" : "")}"
            : "Point Zéro — correction désactivée";
        _tray.Text = text.Length > 127 ? text[..127] : text;
    }

    public void ShowFromTray()
    {
        _startHidden = false;
        if (!Visible) Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    public void ExitApp()
    {
        _exiting = true;
        Close();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_exiting && e.CloseReason == CloseReason.UserClosing && _engine.Settings.CloseToTray)
        {
            e.Cancel = true;
            Hide();
            if (!_trayHintShown)
            {
                _trayHintShown = true;
                _tray.ShowBalloonTip(3000, "Point Zéro continue", "La correction reste active. Clic droit sur l'icône pour quitter.", ToolTipIcon.None);
            }
            return;
        }
        _frameTimer.Stop();
        _statusTimer.Stop();
        _tray.Visible = false;
        _engine.Dispose();
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _tray.Dispose();
            _updateTimer.Dispose();
            _frameTimer.Dispose();
            _statusTimer.Dispose();
            _iconOn.Dispose();
            _iconOff.Dispose();
        }
        base.Dispose(disposing);
    }
}

/// <summary>Tray icons drawn at runtime: ring + dot, accent dot when the correction is live.</summary>
static class TrayIcons
{
    public static Icon Make(bool active)
    {
        int s = SystemInformation.SmallIconSize.Width;
        using var bmp = new Bitmap(s, s);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            float stroke = Math.Max(1.5f, s * 0.11f);
            float ring = s - stroke - 1;
            using var pen = new Pen(Color.FromArgb(236, 236, 232), stroke);
            g.DrawEllipse(pen, (s - ring) / 2f, (s - ring) / 2f, ring, ring);
            float dot = s * 0.34f;
            using var brush = new SolidBrush(active ? Color.FromArgb(200, 255, 60) : Color.FromArgb(110, 110, 104));
            g.FillEllipse(brush, (s - dot) / 2f, (s - dot) / 2f, dot, dot);
        }
        IntPtr h = bmp.GetHicon();
        using var tmp = Icon.FromHandle(h);
        return (Icon)tmp.Clone();
    }
}

sealed class DarkMenuRenderer : ToolStripProfessionalRenderer
{
    public DarkMenuRenderer() : base(new DarkColors()) { RoundedEdges = false; }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        e.TextColor = e.Item.Enabled ? Color.FromArgb(236, 236, 232) : Color.FromArgb(110, 110, 104);
        base.OnRenderItemText(e);
    }

    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
    {
        var r = e.ImageRectangle;
        using var b = new SolidBrush(Color.FromArgb(200, 255, 60));
        e.Graphics.FillRectangle(b, r.X + r.Width / 2 - 4, r.Y + r.Height / 2 - 4, 8, 8);
    }

    sealed class DarkColors : ProfessionalColorTable
    {
        static readonly Color Back = Color.FromArgb(21, 21, 21), Line = Color.FromArgb(46, 46, 46), Hover = Color.FromArgb(34, 34, 34);
        public override Color ToolStripDropDownBackground => Back;
        public override Color MenuBorder => Line;
        public override Color MenuItemBorder => Hover;
        public override Color MenuItemSelected => Hover;
        public override Color ImageMarginGradientBegin => Back;
        public override Color ImageMarginGradientMiddle => Back;
        public override Color ImageMarginGradientEnd => Back;
        public override Color SeparatorDark => Line;
        public override Color SeparatorLight => Back;
        public override Color CheckBackground => Back;
        public override Color CheckSelectedBackground => Hover;
        public override Color CheckPressedBackground => Hover;
    }
}
