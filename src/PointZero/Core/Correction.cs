using System.Text.Json.Serialization;

namespace PointZero.Core;

public sealed class StickParams
{
    [JsonPropertyName("cx")] public double Cx { get; set; }
    [JsonPropertyName("cy")] public double Cy { get; set; }
    [JsonPropertyName("deadzone")] public double Deadzone { get; set; } = 0.05;
    [JsonPropertyName("outer")] public double Outer { get; set; } = 0.97;
    [JsonPropertyName("curve")] public double Curve { get; set; } = 1.0;
    [JsonPropertyName("antiDeadzone")] public double AntiDeadzone { get; set; }
    [JsonPropertyName("tracking")] public bool Tracking { get; set; }

    /// <summary>Where centre/deadzone come from: default | diagnostic | calibration | manual.</summary>
    [JsonPropertyName("source")] public string Source { get; set; } = "default";
    [JsonPropertyName("diagnosedAt")] public string? DiagnosedAt { get; set; }
    /// <summary>Summary of the last applied diagnostic, stored as the UI sent it.</summary>
    [JsonPropertyName("diag")] public System.Text.Json.Nodes.JsonObject? Diag { get; set; }

    public StickParams Clone()
    {
        var c = (StickParams)MemberwiseClone();
        c.Diag = Diag?.DeepClone() as System.Text.Json.Nodes.JsonObject;
        return c;
    }

    public void Sanitize()
    {
        Cx = Math.Clamp(Finite(Cx), -0.5, 0.5);
        Cy = Math.Clamp(Finite(Cy), -0.5, 0.5);
        Deadzone = Math.Clamp(Finite(Deadzone), 0, 0.4);
        Outer = Math.Clamp(Finite(Outer, 0.97), 0.6, 1.0);
        Curve = Math.Clamp(Finite(Curve, 1), 0.3, 3.5);
        AntiDeadzone = Math.Clamp(Finite(AntiDeadzone), 0, 0.5);
    }

    static double Finite(double v, double fallback = 0) => double.IsFinite(v) ? v : fallback;
}

public sealed class TriggerParams
{
    [JsonPropertyName("deadzone")] public double Deadzone { get; set; } = 0.02;
    [JsonPropertyName("outer")] public double Outer { get; set; } = 0.98;

    public TriggerParams Clone() => (TriggerParams)MemberwiseClone();

    public void Sanitize()
    {
        Deadzone = Math.Clamp(double.IsFinite(Deadzone) ? Deadzone : 0, 0, 0.5);
        Outer = Math.Clamp(double.IsFinite(Outer) ? Outer : 1, 0.5, 1.0);
    }

    public byte Apply(byte raw)
    {
        double v = raw / 255.0;
        double outer = Math.Max(Outer, Deadzone + 0.05);
        double o = Math.Clamp((v - Deadzone) / (outer - Deadzone), 0, 1);
        return (byte)Math.Round(o * 255);
    }
}

public sealed class Profile
{
    [JsonPropertyName("name")] public string Name { get; set; } = "Défaut";
    [JsonPropertyName("sticks")] public Dictionary<string, StickParams> Sticks { get; set; } = new() { ["L"] = new(), ["R"] = new() };
    [JsonPropertyName("triggers")] public Dictionary<string, TriggerParams> Triggers { get; set; } = new() { ["L"] = new(), ["R"] = new() };

    public StickParams Stick(string side) => Sticks.TryGetValue(side, out var p) ? p : Sticks[side] = new();
    public TriggerParams Trigger(string side) => Triggers.TryGetValue(side, out var p) ? p : Triggers[side] = new();

    public Profile Clone() => new()
    {
        Name = Name,
        Sticks = Sticks.ToDictionary(k => k.Key, v => v.Value.Clone()),
        Triggers = Triggers.ToDictionary(k => k.Key, v => v.Value.Clone()),
    };

    public void Sanitize()
    {
        foreach (var s in new[] { "L", "R" }) { Stick(s).Sanitize(); Trigger(s).Sanitize(); }
    }
}

/// <summary>
/// Per-stick drift correction:
/// 1. remove the rest offset, rescaling each half-axis so full travel still reaches ±1;
/// 2. scaled radial deadzone (output starts from 0 at the edge — no jump, no amplitude loss);
/// 3. outer deadzone + response curve + optional anti-deadzone;
/// 4. optional slow re-centring while the stick rests (drift that evolves over time).
/// </summary>
public sealed class StickCorrector
{
    StickParams _p = new();
    double _cx, _cy;             // effective centre (profile centre + tracking)
    double _lastX, _lastY;
    double _still;               // seconds the stick has been motionless near the centre
    bool _hasLast;

    public double CenterX => _cx;
    public double CenterY => _cy;

    public void SetParams(StickParams p)
    {
        bool centreChanged = p.Cx != _p.Cx || p.Cy != _p.Cy || !p.Tracking;
        _p = p.Clone();
        if (centreChanged) { _cx = _p.Cx; _cy = _p.Cy; }
    }

    /// <summary>Raw byte (0-255, y down) → normalized, y up.</summary>
    public static double NormX(byte b) => Math.Clamp((b - 127.5) / 127.5, -1, 1);
    public static double NormY(byte b) => Math.Clamp(-(b - 127.5) / 127.5, -1, 1);

    public (double X, double Y) Process(double rx, double ry, double dt, bool freezeTracking)
    {
        if (_p.Tracking && !freezeTracking && _hasLast) Track(rx, ry, dt);
        _lastX = rx; _lastY = ry; _hasLast = true;
        return Apply(rx, ry, _cx, _cy, _p);
    }

    void Track(double rx, double ry, double dt)
    {
        double move = Math.Sqrt((rx - _lastX) * (rx - _lastX) + (ry - _lastY) * (ry - _lastY));
        double fromCentre = Math.Sqrt((rx - _cx) * (rx - _cx) + (ry - _cy) * (ry - _cy));
        double window = Math.Max(_p.Deadzone * 1.5, 0.03);
        if (fromCentre < window && move < 0.012) _still += dt; else _still = 0;
        if (_still < 0.6) return;
        // Exponential approach, time constant ~3 s, bounded around the calibrated centre.
        double a = Math.Min(1, dt / 3.0);
        _cx += (rx - _cx) * a;
        _cy += (ry - _cy) * a;
        double dx = _cx - _p.Cx, dy = _cy - _p.Cy, d = Math.Sqrt(dx * dx + dy * dy);
        const double maxShift = 0.15;
        if (d > maxShift) { _cx = _p.Cx + dx / d * maxShift; _cy = _p.Cy + dy / d * maxShift; }
    }

    public static (double X, double Y) Apply(double rx, double ry, double cx, double cy, StickParams p)
    {
        double x = rx - cx, y = ry - cy;
        x = x >= 0 ? x / (1 - cx) : x / (1 + cx);
        y = y >= 0 ? y / (1 - cy) : y / (1 + cy);
        double m = Math.Sqrt(x * x + y * y);
        if (m <= p.Deadzone || m < 1e-9) return (0, 0);
        double outer = Math.Max(p.Outer, p.Deadzone + 0.05);
        double n = Math.Clamp((m - p.Deadzone) / (outer - p.Deadzone), 0, 1);
        if (p.Curve != 1.0) n = Math.Pow(n, p.Curve);
        if (p.AntiDeadzone > 0) n = p.AntiDeadzone + (1 - p.AntiDeadzone) * n;
        double k = n / m;
        return (Math.Clamp(x * k, -1, 1), Math.Clamp(y * k, -1, 1));
    }
}
