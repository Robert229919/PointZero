using System.Diagnostics;
using System.Runtime.InteropServices;
using PointZero.Core;

// Reads the real DualSense for N seconds (default 3) and reports what Point Zéro sees.
// "vigem": creates a virtual Xbox 360 pad for 3 s and checks XInput sees it.
if (args.Length > 0 && args[0] == "vigem")
{
    Console.WriteLine("XInput before: " + XInputSlots());
    using var pad = VirtualPad.TryCreate(out var err);
    if (pad == null) { Console.WriteLine("ViGEm: " + err); return 4; }
    pad.Connect(VirtualType.X360);
    Thread.Sleep(1500);
    pad.Submit(new PadFrame { LX = 0.5, LY = -0.25, R2 = 200, Buttons = Btn.Cross });
    Thread.Sleep(200);
    Console.WriteLine($"Virtual slot={pad.Slot}  XInput with pad: " + XInputSlots());
    pad.Disconnect();
    Thread.Sleep(500);
    Console.WriteLine("XInput after: " + XInputSlots());
    return 0;
}

if (args.Length > 0 && args[0] == "stream")
{
    // Same pattern as the app: Connect on a pool thread, Submit at 250 Hz from another thread.
    using var pad = VirtualPad.TryCreate(out var err)!;
    Task.Run(() => pad.Connect(VirtualType.X360)).Wait();
    double lx = 0;
    var run = true;
    var t = new Thread(() => { while (run) { pad.Submit(new PadFrame { LX = Volatile.Read(ref lx) }); Thread.Sleep(4); } }) { IsBackground = true };
    t.Start();
    Thread.Sleep(1000);
    Console.WriteLine($"slot={pad.Slot} zeros:  " + XInputSlots());
    Volatile.Write(ref lx, 0.5);
    Thread.Sleep(300);
    Console.WriteLine($"lx=0.5:  " + XInputSlots() + $"  submits={pad.SubmitCount} errors={pad.SubmitErrors}");
    run = false; t.Join();
    return 0;
}

if (args.Length > 1 && args[0] == "unallow")
{
    // Removes an application path from the HidHide whitelist (cleanup of development builds).
    new CloakManager().RemoveAllowed(args[1]);
    Console.WriteLine("allowed=[" + string.Join("; ", HidHideClient.AllowedApps()) + "]");
    return 0;
}

if (args.Length > 1 && args[0] == "hold")
{
    // Behaves like Steam / a browser: keeps the pad open, and re-opens it whenever it (re)appears.
    double total = double.Parse(args[1]);
    var sw2 = Stopwatch.StartNew();
    DualSenseDevice? held = null;
    int reports = 0; bool lost = false;
    while (sw2.Elapsed.TotalSeconds < total)
    {
        if (held == null)
        {
            var h2 = DualSenseDevice.Enumerate().FirstOrDefault();
            if (h2 != null)
            {
                try { held = DualSenseDevice.Open(h2); } catch { held = null; }
                if (held != null)
                {
                    lost = false;
                    held.Input += _ => Interlocked.Increment(ref reports);
                    held.Disconnected += _ => lost = true;
                    Console.WriteLine($"{sw2.Elapsed.TotalSeconds,5:F1}s  OPENED ({held.Transport})");
                }
            }
        }
        Thread.Sleep(500);
        if (held != null && lost)
        {
            Console.WriteLine($"{sw2.Elapsed.TotalSeconds,5:F1}s  LOST the pad");
            try { held.Dispose(); } catch { }
            held = null;
        }
        if ((int)(sw2.Elapsed.TotalSeconds * 2) % 4 == 0)
            Console.WriteLine($"{sw2.Elapsed.TotalSeconds,5:F1}s  {(held == null ? "no pad visible" : $"reading, {Interlocked.Exchange(ref reports, 0)} reports")}");
    }
    held?.Dispose();
    return 0;
}

if (args.Length > 0 && args[0] == "update")
{
    // Exercises the update check, optionally against another public repo that has releases.
    var rel = UpdateChecker.CheckAsync(args.Length > 1 ? args[1] : UpdateChecker.Repo).GetAwaiter().GetResult();
    Console.WriteLine($"current={UpdateChecker.Current.ToString(3)}");
    Console.WriteLine(rel == null ? "no newer release" : $"newer: {rel.Version}  url={rel.Url}  name={rel.Name}  published={rel.PublishedAt}  notes={rel.Notes.Length} chars");
    return 0;
}

if (args.Length > 0 && args[0] == "xinput")
{
    for (int k = 0; k < 4; k++) { Console.WriteLine(XInputSlots()); Thread.Sleep(250); }
    return 0;
}

if (args.Length > 0 && args[0] == "pipeline")
{
    var h = DualSenseDevice.Enumerate().First();
    using var d = DualSenseDevice.Open(h)!;
    var cl = new StickCorrector(); cl.SetParams(new StickParams());
    var cr = new StickCorrector(); cr.SetParams(new StickParams());
    int n = 0;
    d.Input += i =>
    {
        if (n++ % 50 != 0) return;
        var l = cl.Process(StickCorrector.NormX(i.LX), StickCorrector.NormY(i.LY), 0.004, false);
        var r = cr.Process(StickCorrector.NormX(i.RX), StickCorrector.NormY(i.RY), 0.004, false);
        Console.WriteLine($"raw L ({i.LX},{i.LY}) R ({i.RX},{i.RY}) -> L ({l.X:F4},{l.Y:F4}) R ({r.X:F4},{r.Y:F4})");
    };
    Thread.Sleep(1200);
    return 0;
}

double seconds = args.Length > 0 && double.TryParse(args[0], out var s) ? s : 3;

var hids = DualSenseDevice.Enumerate().ToList();
Console.WriteLine($"DualSense HID collections: {hids.Count}");
if (hids.Count == 0) return 1;
using var dev = DualSenseDevice.Open(hids[0]);
if (dev == null) { Console.WriteLine("Open failed"); return 2; }
Console.WriteLine($"Model={dev.Model} Transport={dev.Transport} Firmware=0x{dev.FirmwareVersion:X4} VibrationV2={dev.VibrationV2} ImuCalibrated={dev.Imu.Valid}");
Console.WriteLine($"InstanceId={dev.InstanceId}");
Console.WriteLine($"Stack={string.Join(", ", Native_DriverStack(dev.InstanceId))}");

var samples = new List<DsInput>();
var sw = Stopwatch.StartNew();
dev.Input += i => { lock (samples) samples.Add(i); };
Thread.Sleep(TimeSpan.FromSeconds(seconds));
List<DsInput> list; lock (samples) list = [.. samples];
Console.WriteLine($"Reports: {list.Count} in {sw.Elapsed.TotalSeconds:F1}s = {list.Count / sw.Elapsed.TotalSeconds:F0} Hz");
if (list.Count == 0) return 3;

void Stick(string name, Func<DsInput, byte> fx, Func<DsInput, byte> fy)
{
    var xs = list.Select(i => StickCorrector.NormX(fx(i))).ToArray();
    var ys = list.Select(i => StickCorrector.NormY(fy(i))).ToArray();
    double mx = xs.Average(), my = ys.Average();
    var d = xs.Zip(ys, (x, y) => Math.Sqrt((x - mx) * (x - mx) + (y - my) * (y - my))).OrderBy(v => v).ToArray();
    Console.WriteLine($"{name}: raw bytes x {list.Min(fx)}..{list.Max(fx)}  y {list.Min(fy)}..{list.Max(fy)} | rest centre ({mx:+0.0000;-0.0000}, {my:+0.0000;-0.0000}) = {Math.Sqrt(mx * mx + my * my) * 100:F2} % | noise p99 {d[(int)(d.Length * 0.99)] * 100:F2} % max {d[^1] * 100:F2} %");
}
Stick("Left ", i => i.LX, i => i.LY);
Stick("Right", i => i.RX, i => i.RY);
var last = list[^1];
var g = dev.Imu.Gyro(last); var a = dev.Imu.Accel(last);
Console.WriteLine($"L2={last.L2} R2={last.R2} Buttons={last.Buttons} Battery={last.Battery}% charging={last.Charging} full={last.Full} headphones={last.Headphones}");
Console.WriteLine($"Gyro deg/s = ({g.Item1:F2}, {g.Item2:F2}, {g.Item3:F2})  Accel g = ({a.Item1:F3}, {a.Item2:F3}, {a.Item3:F3}) |a|={Math.Sqrt(a.Item1 * a.Item1 + a.Item2 * a.Item2 + a.Item3 * a.Item3):F3}");
Console.WriteLine($"Touch0 on={last.T0.On} ({last.T0.X},{last.T0.Y})  Touch1 on={last.T1.On}");
Console.WriteLine($"HidHide available={HidHideClient.IsAvailable}");
if (HidHideClient.IsAvailable)
{
    Console.WriteLine($"  active={HidHideClient.Active} inverted={HidHideClient.WhitelistInverted}");
    Console.WriteLine($"  blocked=[{string.Join("; ", HidHideClient.BlockedInstances())}]");
    Console.WriteLine($"  allowed=[{string.Join("; ", HidHideClient.AllowedApps())}]");
}
return 0;

static string XInputSlots()
{
    var parts = new List<string>();
    for (uint i = 0; i < 4; i++)
    {
        var st = new XInput.State();
        uint r = XInput.XInputGetState(i, ref st);
        parts.Add(r == 0 ? $"[{i + 1}: LX={st.Gamepad.sThumbLX} LY={st.Gamepad.sThumbLY} RT={st.Gamepad.bRightTrigger} btn=0x{st.Gamepad.wButtons:X4}]" : $"[{i + 1}: -]");
    }
    return string.Join(" ", parts);
}

static string[] Native_DriverStack(string id) =>
    (string[]?)typeof(Engine).Assembly.GetType("PointZero.Core.Native")!.GetMethod("DriverStack")!.Invoke(null, [id]) ?? ["?"];
