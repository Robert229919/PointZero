using System.Buffers.Binary;

namespace PointZero.Core;

public enum Transport { Usb, Bluetooth }

/// <summary>Button bitmask, same bit order as docs/protocol.md.</summary>
[Flags]
public enum Btn : uint
{
    None = 0,
    Square = 1u << 0, Cross = 1u << 1, Circle = 1u << 2, Triangle = 1u << 3,
    L1 = 1u << 4, R1 = 1u << 5, L2 = 1u << 6, R2 = 1u << 7,
    Create = 1u << 8, Options = 1u << 9, L3 = 1u << 10, R3 = 1u << 11,
    PS = 1u << 12, Touchpad = 1u << 13, Mute = 1u << 14,
    Up = 1u << 15, Down = 1u << 16, Left = 1u << 17, Right = 1u << 18,
    FnL = 1u << 19, FnR = 1u << 20, BackL = 1u << 21, BackR = 1u << 22,
}

public struct TouchPoint
{
    public bool On;
    public byte Id;
    public ushort X, Y;
}

/// <summary>One decoded input report.</summary>
public struct DsInput
{
    public byte LX, LY, RX, RY, L2, R2;
    public Btn Buttons;
    public short GyroX, GyroY, GyroZ, AccelX, AccelY, AccelZ;
    public TouchPoint T0, T1;
    public int Battery;          // 0-100
    public bool Charging, Full;
    public bool Headphones, Mic;
}

/// <summary>
/// DualSense HID report layouts (Linux hid-playstation is the reference).
/// USB input 0x01 (64 bytes), Bluetooth input 0x31 (78 bytes, data shifted by one byte).
/// USB output 0x02, Bluetooth output 0x31 with CRC32 (seed 0xA2).
/// </summary>
public static class DualSenseProtocol
{
    public const int VendorId = 0x054C;
    public const int PidDualSense = 0x0CE6;
    public const int PidDualSenseEdge = 0x0DF2;

    public const byte FeatureCalibration = 0x05;
    public const byte FeatureFirmware = 0x20;

    static readonly Btn[] Hat =
    [
        Btn.Up, Btn.Up | Btn.Right, Btn.Right, Btn.Down | Btn.Right,
        Btn.Down, Btn.Down | Btn.Left, Btn.Left, Btn.Up | Btn.Left,
    ];

    /// <summary>Decodes a full input report. Returns false for anything else (e.g. the short BT 0x01 report).</summary>
    public static bool TryParseInput(ReadOnlySpan<byte> r, out DsInput s)
    {
        s = default;
        int o;
        if (r.Length >= 64 && r[0] == 0x01) o = 1;            // USB
        else if (r.Length >= 78 && r[0] == 0x31) o = 2;       // Bluetooth full report
        else return false;

        s.LX = r[o + 0]; s.LY = r[o + 1]; s.RX = r[o + 2]; s.RY = r[o + 3];
        s.L2 = r[o + 4]; s.R2 = r[o + 5];

        byte b0 = r[o + 7], b1 = r[o + 8], b2 = r[o + 9];
        Btn b = Btn.None;
        int hat = b0 & 0x0F;
        if (hat < 8) b |= Hat[hat];
        if ((b0 & 0x10) != 0) b |= Btn.Square;
        if ((b0 & 0x20) != 0) b |= Btn.Cross;
        if ((b0 & 0x40) != 0) b |= Btn.Circle;
        if ((b0 & 0x80) != 0) b |= Btn.Triangle;
        if ((b1 & 0x01) != 0) b |= Btn.L1;
        if ((b1 & 0x02) != 0) b |= Btn.R1;
        if ((b1 & 0x04) != 0) b |= Btn.L2;
        if ((b1 & 0x08) != 0) b |= Btn.R2;
        if ((b1 & 0x10) != 0) b |= Btn.Create;
        if ((b1 & 0x20) != 0) b |= Btn.Options;
        if ((b1 & 0x40) != 0) b |= Btn.L3;
        if ((b1 & 0x80) != 0) b |= Btn.R3;
        if ((b2 & 0x01) != 0) b |= Btn.PS;
        if ((b2 & 0x02) != 0) b |= Btn.Touchpad;
        if ((b2 & 0x04) != 0) b |= Btn.Mute;
        if ((b2 & 0x10) != 0) b |= Btn.FnL;     // Edge
        if ((b2 & 0x20) != 0) b |= Btn.FnR;     // Edge
        if ((b2 & 0x40) != 0) b |= Btn.BackL;   // Edge
        if ((b2 & 0x80) != 0) b |= Btn.BackR;   // Edge
        s.Buttons = b;

        s.GyroX = BinaryPrimitives.ReadInt16LittleEndian(r[(o + 15)..]);
        s.GyroY = BinaryPrimitives.ReadInt16LittleEndian(r[(o + 17)..]);
        s.GyroZ = BinaryPrimitives.ReadInt16LittleEndian(r[(o + 19)..]);
        s.AccelX = BinaryPrimitives.ReadInt16LittleEndian(r[(o + 21)..]);
        s.AccelY = BinaryPrimitives.ReadInt16LittleEndian(r[(o + 23)..]);
        s.AccelZ = BinaryPrimitives.ReadInt16LittleEndian(r[(o + 25)..]);

        s.T0 = ReadTouch(r[(o + 32)..]);
        s.T1 = ReadTouch(r[(o + 36)..]);

        byte st0 = r[o + 52], st1 = r[o + 53];
        int cap = st0 & 0x0F, chg = st0 >> 4;
        s.Charging = chg == 0x1;
        s.Full = chg == 0x2;
        s.Battery = s.Full ? 100 : Math.Min(cap * 10 + 5, 100);
        s.Headphones = (st1 & 0x01) != 0;
        s.Mic = (st1 & 0x02) != 0;
        return true;
    }

    static TouchPoint ReadTouch(ReadOnlySpan<byte> p) => new()
    {
        On = (p[0] & 0x80) == 0,
        Id = (byte)(p[0] & 0x7F),
        X = (ushort)(p[1] | ((p[2] & 0x0F) << 8)),
        Y = (ushort)((p[2] >> 4) | (p[3] << 4)),
    };

    // ---- CRC32 (IEEE, reflected) used by Bluetooth reports ----

    static readonly uint[] CrcTable = BuildCrcTable();

    static uint[] BuildCrcTable()
    {
        var t = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            uint c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            t[i] = c;
        }
        return t;
    }

    public static uint Crc32(byte seed, ReadOnlySpan<byte> data)
    {
        uint c = 0xFFFFFFFFu;
        c = CrcTable[(c ^ seed) & 0xFF] ^ (c >> 8);
        foreach (byte b in data) c = CrcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        return ~c;
    }
}

/// <summary>Everything Point Zéro can drive on the controller. Built into one output report.</summary>
public sealed class DsOutputState
{
    public byte MotorLeft;   // strong / low frequency
    public byte MotorRight;  // weak / high frequency
    public byte[] TriggerL = TriggerEffects.Off();
    public byte[] TriggerR = TriggerEffects.Off();

    public bool LightbarSet;
    public byte R, G, B;

    public bool PlayerLedsSet;
    public byte PlayerLeds;     // 5 bits

    public bool MuteLedSet;
    public byte MuteLed;        // 0 off, 1 on, 2 pulse

    public bool AudioSet;
    public bool SpeakerRoute;   // true = internal speaker, false = headphone jack
    public byte Volume;         // 0-100

    public bool ReleaseLightbar = true;  // first report: stop the default blue fade so our colour shows

    public DsOutputState Clone()
    {
        var c = (DsOutputState)MemberwiseClone();
        c.TriggerL = (byte[])TriggerL.Clone();
        c.TriggerR = (byte[])TriggerR.Clone();
        return c;
    }

    /// <summary>Fills the 47-byte "common" block shared by USB and BT output reports.</summary>
    public void WriteCommon(Span<byte> c, bool vibrationV2)
    {
        c.Clear();
        byte f0 = 0x02 | 0x04 | 0x08;                 // haptics select (rumble emulation), right + left trigger effects
        if (!vibrationV2) f0 |= 0x01;                 // compatible vibration (older firmware)
        byte f1 = 0;
        byte f2 = 0;
        if (vibrationV2) f2 |= 0x04;                  // compatible vibration v2 (fw >= 2.21)

        c[2] = MotorRight;
        c[3] = MotorLeft;

        if (AudioSet)
        {
            f0 |= 0x10 | 0x20 | 0x80;                 // headphone volume, speaker volume, audio control
            c[4] = (byte)Math.Round(Volume / 100.0 * 0x7F);          // headphone volume 0..0x7F
            c[5] = (byte)Math.Round(0x3D + Volume / 100.0 * (0x64 - 0x3D)); // speaker volume, useful range 0x3D..0x64
            // byte 7, bits 4-5: output path. 0 = headphones L/R, 3 = internal speaker (right channel).
            c[7] = SpeakerRoute ? (byte)0x30 : (byte)0x00;
        }

        if (MuteLedSet) { f1 |= 0x01; c[8] = MuteLed; }

        TriggerR.AsSpan(0, 11).CopyTo(c[10..]);
        TriggerL.AsSpan(0, 11).CopyTo(c[21..]);

        if (ReleaseLightbar) { f2 |= 0x02; c[41] = 0x02; }   // lightbar setup: "light out" (ends the startup animation)
        if (LightbarSet) { f1 |= 0x04; c[44] = R; c[45] = G; c[46] = B; }
        if (PlayerLedsSet) { f1 |= 0x10; c[42] = 0x00; c[43] = (byte)(PlayerLeds & 0x1F); }

        c[0] = f0;
        c[1] = f1;
        c[38] = f2;
    }

    /// <summary>Builds a complete output report for the given transport.</summary>
    public int Build(Span<byte> buf, Transport t, bool vibrationV2, ref byte btSeq)
    {
        buf.Clear();
        if (t == Transport.Usb)
        {
            buf[0] = 0x02;
            WriteCommon(buf.Slice(1, 47), vibrationV2);
            return 48;
        }
        buf[0] = 0x31;
        buf[1] = (byte)(btSeq << 4);
        btSeq = (byte)((btSeq + 1) & 0x0F);
        buf[2] = 0x10;
        WriteCommon(buf.Slice(3, 47), vibrationV2);
        uint crc = DualSenseProtocol.Crc32(0xA2, buf[..74]);
        BinaryPrimitives.WriteUInt32LittleEndian(buf.Slice(74, 4), crc);
        return 78;
    }
}

/// <summary>Adaptive trigger effect blocks (11 bytes), formats documented by the community (Nielk1).</summary>
public static class TriggerEffects
{
    public static byte[] Off() { var e = new byte[11]; e[0] = 0x05; return e; }

    /// <summary>Continuous resistance from zone <paramref name="start"/> (0-9), strength 1-8.</summary>
    public static byte[] Feedback(int start, int strength)
    {
        start = Math.Clamp(start, 0, 9); strength = Math.Clamp(strength, 1, 8);
        uint active = 0; ulong force = 0;
        uint v = (uint)((strength - 1) & 7);
        for (int i = start; i < 10; i++) { active |= 1u << i; force |= (ulong)v << (3 * i); }
        var e = new byte[11];
        e[0] = 0x21;
        e[1] = (byte)active; e[2] = (byte)(active >> 8);
        for (int k = 0; k < 4; k++) e[3 + k] = (byte)(force >> (8 * k));
        return e;
    }

    /// <summary>Resistance between <paramref name="start"/> (2-7) and <paramref name="end"/> then a click (trigger break).</summary>
    public static byte[] Weapon(int start, int end, int strength)
    {
        start = Math.Clamp(start, 2, 7); end = Math.Clamp(end, start + 1, 8); strength = Math.Clamp(strength, 1, 8);
        uint zones = (1u << start) | (1u << end);
        var e = new byte[11];
        e[0] = 0x25;
        e[1] = (byte)zones; e[2] = (byte)(zones >> 8);
        e[3] = (byte)(strength - 1);
        return e;
    }

    /// <summary>Vibration from zone <paramref name="start"/> (0-9), amplitude 1-8, frequency 1-255 Hz.</summary>
    public static byte[] Vibration(int start, int amplitude, int frequency)
    {
        start = Math.Clamp(start, 0, 9); amplitude = Math.Clamp(amplitude, 1, 8); frequency = Math.Clamp(frequency, 1, 255);
        uint active = 0; ulong amp = 0;
        uint v = (uint)((amplitude - 1) & 7);
        for (int i = start; i < 10; i++) { active |= 1u << i; amp |= (ulong)v << (3 * i); }
        var e = new byte[11];
        e[0] = 0x26;
        e[1] = (byte)active; e[2] = (byte)(active >> 8);
        for (int k = 0; k < 4; k++) e[3 + k] = (byte)(amp >> (8 * k));
        e[9] = (byte)frequency;
        return e;
    }
}

/// <summary>IMU calibration from feature report 0x05 → physical units.</summary>
public sealed class ImuCalibration
{
    readonly double[] _gyroScale = [1 / 16.4, 1 / 16.4, 1 / 16.4];   // fallback: ±2000 dps
    readonly double[] _accScale = [1 / 8192.0, 1 / 8192.0, 1 / 8192.0];
    readonly double[] _accBias = new double[3];
    public bool Valid { get; private set; }

    public static ImuCalibration FromFeature(ReadOnlySpan<byte> buf)
    {
        var c = new ImuCalibration();
        if (buf.Length < 35 || buf[0] != DualSenseProtocol.FeatureCalibration) return c;
        byte[] b = buf.ToArray();
        short S(int i) => BinaryPrimitives.ReadInt16LittleEndian(b.AsSpan(i));

        short pitchBias = S(1), yawBias = S(3), rollBias = S(5);
        short pitchPlus = S(7), pitchMinus = S(9), yawPlus = S(11), yawMinus = S(13), rollPlus = S(15), rollMinus = S(17);
        short speedPlus = S(19), speedMinus = S(21);
        double speed2x = speedPlus + speedMinus;
        double[] den =
        [
            Math.Abs(pitchPlus - pitchBias) + Math.Abs(pitchMinus - pitchBias),
            Math.Abs(yawPlus - yawBias) + Math.Abs(yawMinus - yawBias),
            Math.Abs(rollPlus - rollBias) + Math.Abs(rollMinus - rollBias),
        ];
        bool ok = speed2x > 0;
        for (int i = 0; i < 3; i++)
        {
            if (den[i] <= 0) { ok = false; continue; }
            c._gyroScale[i] = speed2x / den[i];
        }

        short[] plus = [S(23), S(27), S(31)];
        short[] minus = [S(25), S(29), S(33)];
        for (int i = 0; i < 3; i++)
        {
            double range2g = plus[i] - minus[i];
            if (range2g <= 0) { ok = false; continue; }
            c._accBias[i] = plus[i] - range2g / 2;
            c._accScale[i] = 2.0 / range2g;
        }
        c.Valid = ok;
        return c;
    }

    public (double, double, double) Gyro(in DsInput s) =>
        (s.GyroX * _gyroScale[0], s.GyroY * _gyroScale[1], s.GyroZ * _gyroScale[2]);

    public (double, double, double) Accel(in DsInput s) =>
        ((s.AccelX - _accBias[0]) * _accScale[0], (s.AccelY - _accBias[1]) * _accScale[1], (s.AccelZ - _accBias[2]) * _accScale[2]);
}
