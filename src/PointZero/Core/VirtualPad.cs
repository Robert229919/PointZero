using Nefarius.ViGEm.Client;
using Nefarius.ViGEm.Client.Targets;
using Nefarius.ViGEm.Client.Targets.DualShock4;
using Nefarius.ViGEm.Client.Targets.Xbox360;

namespace PointZero.Core;

public enum VirtualType { X360, DS4 }

/// <summary>Corrected controller state sent to the virtual pad.</summary>
public struct PadFrame
{
    public double LX, LY, RX, RY;    // -1..1, y up
    public byte L2, R2;
    public Btn Buttons;
}

/// <summary>The ViGEmBus virtual controller games actually see.</summary>
public sealed class VirtualPad : IDisposable
{
    readonly ViGEmClient _client;
    IXbox360Controller? _x360;
    IDualShock4Controller? _ds4;
    readonly object _lock = new();

    public VirtualType Type { get; private set; }
    public bool Connected { get; private set; }

    /// <summary>Rumble/LED requests from the game: (strong, weak, xinputLed 0-based or -1).</summary>
    public event Action<byte, byte, int>? Feedback;

    VirtualPad(ViGEmClient client) { _client = client; }

    /// <summary>Null when ViGEmBus is not installed.</summary>
    public static VirtualPad? TryCreate(out string? error)
    {
        try
        {
            error = null;
            return new VirtualPad(new ViGEmClient());
        }
        catch (Exception ex)
        {
            error = ex.GetType().Name.Contains("NotFound") ? "ViGEmBus n'est pas installé." : $"ViGEmBus indisponible ({ex.GetType().Name}).";
            return null;
        }
    }

    public void Connect(VirtualType type)
    {
        // The very first Xbox 360 pad makes Windows install its xusb22 driver, which can outlast
        // ViGEm's "device ready" wait: retry a couple of times before giving up.
        for (int attempt = 1; ; attempt++)
        {
            try { ConnectOnce(type); return; }
            catch when (attempt < 3) { lock (_lock) DisconnectLocked(); Thread.Sleep(1500); }
        }
    }

    void ConnectOnce(VirtualType type)
    {
        lock (_lock)
        {
            if (Connected && Type == type) return;
            DisconnectLocked();
            Type = type;
            if (type == VirtualType.X360)
            {
                _x360 = _client.CreateXbox360Controller();
                _x360.AutoSubmitReport = false;
                _x360.FeedbackReceived += (_, e) => Feedback?.Invoke(e.LargeMotor, e.SmallMotor, e.LedNumber);
                _x360.Connect();
            }
            else
            {
                _ds4 = _client.CreateDualShock4Controller();
                _ds4.AutoSubmitReport = false;
#pragma warning disable CS0618 // still the simplest way to get rumble from games for the DS4 target
                _ds4.FeedbackReceived += (_, e) => Feedback?.Invoke(e.LargeMotor, e.SmallMotor, -1);
#pragma warning restore CS0618
                _ds4.Connect();
            }
            Connected = true;
            _warmupUntil = Environment.TickCount64 + 2500;
        }
    }

    /// <summary>XInput slot 1-4 for the Xbox 360 pad, 0 if unknown.</summary>
    public int Slot
    {
        get
        {
            lock (_lock)
            {
                try { return _x360 != null && Connected ? _x360.UserIndex + 1 : 0; }
                catch { return 0; }
            }
        }
    }

    public void Disconnect() { lock (_lock) DisconnectLocked(); }

    void DisconnectLocked()
    {
        try { _x360?.Disconnect(); } catch { }
        try { _ds4?.Disconnect(); } catch { }
        _x360 = null;
        _ds4 = null;
        Connected = false;
    }

    static short Axis16(double v) => (short)Math.Round(Math.Clamp(v, -1, 1) * 32767);
    static byte Axis8(double v) => (byte)Math.Round(Math.Clamp(128 + v * 127.5, 0, 255));

    public long SubmitCount, SubmitErrors;
    public string? LastSubmitError;
    public PadFrame LastFrame;

    // ViGEmBus drops a report identical to the previous one, and right after plug-in the game-side driver
    // (xusb22) may not be listening yet: it then keeps uninitialised stick values while the stick rests.
    // For a short warm-up, every other report nudges the left stick X by one step (1/32767 on Xbox 360)
    // so each report differs and the neutral state is guaranteed to land once the driver is ready.
    long _warmupUntil;
    bool _nudge;

    public void Submit(in PadFrame f)
    {
        lock (_lock)
        {
            if (!Connected) return;
            try
            {
                bool nudge = false;
                if (Environment.TickCount64 < _warmupUntil) nudge = _nudge = !_nudge;
                if (_x360 != null) SubmitX360(_x360, f, nudge);
                else if (_ds4 != null) SubmitDs4(_ds4, f, nudge);
                SubmitCount++;
                LastFrame = f;
            }
            catch (Exception ex)
            {
                // Bus hiccup — the next report retries.
                SubmitErrors++;
                LastSubmitError = ex.GetType().Name + ": " + ex.Message;
            }
        }
    }

    static void SubmitX360(IXbox360Controller p, in PadFrame f, bool nudge)
    {
        var b = f.Buttons;
        short lx = Axis16(f.LX);
        if (nudge) lx = lx < short.MaxValue ? (short)(lx + 1) : (short)(lx - 1);
        p.SetAxisValue(Xbox360Axis.LeftThumbX, lx);
        p.SetAxisValue(Xbox360Axis.LeftThumbY, Axis16(f.LY));
        p.SetAxisValue(Xbox360Axis.RightThumbX, Axis16(f.RX));
        p.SetAxisValue(Xbox360Axis.RightThumbY, Axis16(f.RY));
        p.SetSliderValue(Xbox360Slider.LeftTrigger, f.L2);
        p.SetSliderValue(Xbox360Slider.RightTrigger, f.R2);
        p.SetButtonState(Xbox360Button.A, b.HasFlag(Btn.Cross));
        p.SetButtonState(Xbox360Button.B, b.HasFlag(Btn.Circle));
        p.SetButtonState(Xbox360Button.X, b.HasFlag(Btn.Square));
        p.SetButtonState(Xbox360Button.Y, b.HasFlag(Btn.Triangle));
        p.SetButtonState(Xbox360Button.LeftShoulder, b.HasFlag(Btn.L1));
        p.SetButtonState(Xbox360Button.RightShoulder, b.HasFlag(Btn.R1));
        p.SetButtonState(Xbox360Button.LeftThumb, b.HasFlag(Btn.L3));
        p.SetButtonState(Xbox360Button.RightThumb, b.HasFlag(Btn.R3));
        p.SetButtonState(Xbox360Button.Back, (b & (Btn.Create | Btn.Touchpad)) != 0);
        p.SetButtonState(Xbox360Button.Start, b.HasFlag(Btn.Options));
        p.SetButtonState(Xbox360Button.Guide, b.HasFlag(Btn.PS));
        p.SetButtonState(Xbox360Button.Up, b.HasFlag(Btn.Up));
        p.SetButtonState(Xbox360Button.Down, b.HasFlag(Btn.Down));
        p.SetButtonState(Xbox360Button.Left, b.HasFlag(Btn.Left));
        p.SetButtonState(Xbox360Button.Right, b.HasFlag(Btn.Right));
        p.SubmitReport();
    }

    static void SubmitDs4(IDualShock4Controller p, in PadFrame f, bool nudge)
    {
        var b = f.Buttons;
        byte lx = Axis8(f.LX);
        if (nudge) lx = lx < 255 ? (byte)(lx + 1) : (byte)(lx - 1);
        p.SetAxisValue(DualShock4Axis.LeftThumbX, lx);
        p.SetAxisValue(DualShock4Axis.LeftThumbY, Axis8(-f.LY));
        p.SetAxisValue(DualShock4Axis.RightThumbX, Axis8(f.RX));
        p.SetAxisValue(DualShock4Axis.RightThumbY, Axis8(-f.RY));
        p.SetSliderValue(DualShock4Slider.LeftTrigger, f.L2);
        p.SetSliderValue(DualShock4Slider.RightTrigger, f.R2);
        p.SetButtonState(DualShock4Button.Cross, b.HasFlag(Btn.Cross));
        p.SetButtonState(DualShock4Button.Circle, b.HasFlag(Btn.Circle));
        p.SetButtonState(DualShock4Button.Square, b.HasFlag(Btn.Square));
        p.SetButtonState(DualShock4Button.Triangle, b.HasFlag(Btn.Triangle));
        p.SetButtonState(DualShock4Button.ShoulderLeft, b.HasFlag(Btn.L1));
        p.SetButtonState(DualShock4Button.ShoulderRight, b.HasFlag(Btn.R1));
        p.SetButtonState(DualShock4Button.TriggerLeft, f.L2 > 0);
        p.SetButtonState(DualShock4Button.TriggerRight, f.R2 > 0);
        p.SetButtonState(DualShock4Button.ThumbLeft, b.HasFlag(Btn.L3));
        p.SetButtonState(DualShock4Button.ThumbRight, b.HasFlag(Btn.R3));
        p.SetButtonState(DualShock4Button.Share, b.HasFlag(Btn.Create));
        p.SetButtonState(DualShock4Button.Options, b.HasFlag(Btn.Options));
        p.SetButtonState(DualShock4SpecialButton.Ps, b.HasFlag(Btn.PS));
        p.SetButtonState(DualShock4SpecialButton.Touchpad, b.HasFlag(Btn.Touchpad));
        p.SetDPadDirection(DPad(b));
        p.SubmitReport();
    }

    static DualShock4DPadDirection DPad(Btn b)
    {
        bool u = b.HasFlag(Btn.Up), d = b.HasFlag(Btn.Down), l = b.HasFlag(Btn.Left), r = b.HasFlag(Btn.Right);
        if (u && r) return DualShock4DPadDirection.Northeast;
        if (u && l) return DualShock4DPadDirection.Northwest;
        if (d && r) return DualShock4DPadDirection.Southeast;
        if (d && l) return DualShock4DPadDirection.Southwest;
        if (u) return DualShock4DPadDirection.North;
        if (d) return DualShock4DPadDirection.South;
        if (l) return DualShock4DPadDirection.West;
        if (r) return DualShock4DPadDirection.East;
        return DualShock4DPadDirection.None;
    }

    public void Dispose()
    {
        Disconnect();
        try { _client.Dispose(); } catch { }
    }
}
