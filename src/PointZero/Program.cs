using PointZero.Core;
using PointZero.UI;

namespace PointZero;

static class Program
{
    const string InstanceMutex = @"Local\PointZero.Instance";
    const string ShowEvent = @"Local\PointZero.Show";
    const string QuitEvent = @"Local\PointZero.Quit";

    [STAThread]
    static int Main(string[] args)
    {
        bool cleanupOnly = args.Contains("--cleanup", StringComparer.OrdinalIgnoreCase);
        bool tray = args.Contains("--tray", StringComparer.OrdinalIgnoreCase);

        // "--quit": asks the running instance to exit cleanly (real controller visible again).
        if (args.Contains("--quit", StringComparer.OrdinalIgnoreCase))
        {
            try { using var ev = EventWaitHandle.OpenExisting(QuitEvent); ev.Set(); } catch { }
            for (int i = 0; i < 50 && Mutex.TryOpenExisting(InstanceMutex, out var m); i++) { m.Dispose(); Thread.Sleep(100); }
            return 0;
        }

        // Elevated helper management (started by Point Zéro itself through UAC).
        int ih = Array.FindIndex(args, a => a.Equals("--install-helper", StringComparison.OrdinalIgnoreCase));
        if (ih >= 0) return PadRefresher.InstallElevated(ih + 1 < args.Length ? args[ih + 1] : "");
        if (args.Contains("--remove-helper", StringComparer.OrdinalIgnoreCase)) return PadRefresher.RemoveElevated();

        // "--cleanup": safety net run by RunOnce at logon after a crash/power cut. Never touches a running instance.
        if (cleanupOnly)
        {
            if (Mutex.TryOpenExisting(InstanceMutex, out var running)) { running.Dispose(); return 0; }
            try { CloakManager.CleanupLeftovers(); } catch (Exception ex) { Log.Write("Cleanup: " + ex.Message); return 1; }
            return 0;
        }

        using var mutex = new Mutex(true, InstanceMutex, out bool first);
        if (!first)
        {
            // Already running: bring the existing window to the front.
            try { using var ev = EventWaitHandle.OpenExisting(ShowEvent); ev.Set(); } catch { }
            return 0;
        }
        using var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEvent);
        using var quitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, QuitEvent);

        ApplicationConfiguration.Initialize();
        Log.Write("Start " + string.Join(' ', args));

        // Crash recovery: anything a previous run left hidden becomes visible again before we start.
        string? notice = null;
        try { notice = CloakManager.CleanupLeftovers(); } catch (Exception ex) { Log.Write("Startup cleanup: " + ex.Message); }

        var engine = new Engine { StartupNotice = notice };
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            Log.Write("Unhandled: " + e.ExceptionObject);
            try { engine.Dispose(); } catch { }
        };
        Application.ThreadException += (_, e) => Log.Write("UI exception: " + e.Exception);
        AppDomain.CurrentDomain.ProcessExit += (_, _) => { try { engine.Dispose(); } catch { } };

        engine.Start();
        var form = new MainForm(engine, startHidden: tray && engine.Settings.StartMinimized);

        var waiter = new Thread(() =>
        {
            var handles = new WaitHandle[] { showEvent, quitEvent };
            while (true)
            {
                int which = WaitHandle.WaitAny(handles);
                if (form.IsDisposed) return;
                try
                {
                    if (which == 0) form.BeginInvoke(form.ShowFromTray);
                    else { form.BeginInvoke(form.ExitApp); return; }
                }
                catch { return; }
            }
        }) { IsBackground = true, Name = "Instance listener" };
        waiter.Start();

        Application.Run(form);
        engine.Dispose();
        return 0;
    }
}
