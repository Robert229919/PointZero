using System.Buffers.Binary;
using HidSharp;

namespace PointZero.Core;

/// <summary>
/// One open DualSense: a reader thread decoding input reports and a writer thread coalescing output reports.
/// </summary>
public sealed class DualSenseDevice : IDisposable
{
    public HidDevice Hid { get; }
    public Transport Transport { get; }
    public string Model { get; }
    public string InstanceId { get; }
    public string Path => Hid.DevicePath;
    public ushort FirmwareVersion { get; private set; }
    public bool VibrationV2 => FirmwareVersion >= 0x0215;
    public ImuCalibration Imu { get; private set; } = new();

    /// <summary>Raised on the reader thread for every full input report.</summary>
    public event Action<DsInput>? Input;
    /// <summary>Raised once when the device stops responding (unplugged, BT lost).</summary>
    public event Action<DualSenseDevice>? Disconnected;

    readonly HidStream _stream;
    readonly int _inLen, _outLen, _featLen;
    readonly Thread _reader, _writer;
    readonly AutoResetEvent _writeSignal = new(false);
    readonly object _outLock = new();
    DsOutputState _out = new();
    bool _outDirty = true;
    byte _btSeq;
    volatile bool _stop;
    int _disconnectRaised;

    DualSenseDevice(HidDevice hid, HidStream stream, Transport transport)
    {
        Hid = hid;
        _stream = stream;
        Transport = transport;
        Model = hid.ProductID == DualSenseProtocol.PidDualSenseEdge ? "DualSense Edge" : "DualSense";
        InstanceId = InstanceIdOf(hid);
        _inLen = hid.GetMaxInputReportLength();
        _outLen = hid.GetMaxOutputReportLength();
        _featLen = hid.GetMaxFeatureReportLength();
        _reader = new Thread(ReadLoop) { IsBackground = true, Name = "DualSense reader", Priority = ThreadPriority.AboveNormal };
        _writer = new Thread(WriteLoop) { IsBackground = true, Name = "DualSense writer" };
    }

    public static IEnumerable<HidDevice> Enumerate() =>
        DeviceList.Local.GetHidDevices(DualSenseProtocol.VendorId)
            .Where(d => d.ProductID is DualSenseProtocol.PidDualSense or DualSenseProtocol.PidDualSenseEdge)
            .Where(d => SafeLen(d) >= 64);   // the gamepad collection (USB 64, BT 78)

    static int SafeLen(HidDevice d) { try { return d.GetMaxInputReportLength(); } catch { return 0; } }

    public static bool IsBluetooth(HidDevice hid) =>
        hid.DevicePath.Contains("{00001124-", StringComparison.OrdinalIgnoreCase) || SafeLen(hid) >= 78;

    /// <summary>Device instance ID as SetupAPI / HidHide store it (upper-case).</summary>
    public static string InstanceIdOf(HidDevice hid) =>
        (Native.InstanceIdFromInterfacePath(hid.DevicePath) ?? hid.DevicePath).ToUpperInvariant();

    public static DualSenseDevice? Open(HidDevice hid)
    {
        var transport = IsBluetooth(hid) ? Transport.Bluetooth : Transport.Usb;
        if (!hid.TryOpen(out HidStream stream)) return null;
        stream.ReadTimeout = 1000;
        stream.WriteTimeout = 1000;
        var dev = new DualSenseDevice(hid, stream, transport);
        dev.Init();
        return dev;
    }

    void Init()
    {
        // Reading the calibration feature report also switches a Bluetooth DualSense to full 0x31 reports.
        var cal = ReadFeature(DualSenseProtocol.FeatureCalibration);
        if (cal != null) Imu = ImuCalibration.FromFeature(cal);
        var fw = ReadFeature(DualSenseProtocol.FeatureFirmware);
        if (fw != null && fw.Length >= 46) FirmwareVersion = BinaryPrimitives.ReadUInt16LittleEndian(fw.AsSpan(44));
        _reader.Start();
        _writer.Start();
        _writeSignal.Set();
    }

    byte[]? ReadFeature(byte id)
    {
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                var buf = new byte[Math.Max(_featLen, 64)];
                buf[0] = id;
                _stream.GetFeature(buf, 0, Math.Max(_featLen, 1));
                if (buf[0] == id) return buf;
            }
            catch (Exception ex) when (ex is IOException or TimeoutException or UnauthorizedAccessException)
            {
                Thread.Sleep(30);
            }
        }
        return null;
    }

    void ReadLoop()
    {
        var buf = new byte[Math.Max(_inLen, 78)];
        int consecutiveTimeouts = 0;
        while (!_stop)
        {
            try
            {
                int n = _stream.Read(buf, 0, _inLen);
                consecutiveTimeouts = 0;
                if (n <= 0) continue;
                if (DualSenseProtocol.TryParseInput(buf.AsSpan(0, n), out var s))
                    Input?.Invoke(s);
                else if (Transport == Transport.Bluetooth && buf[0] == 0x01)
                    ReadFeature(DualSenseProtocol.FeatureCalibration); // still in simple mode: ask again for full reports
            }
            catch (TimeoutException)
            {
                // A DualSense streams continuously; a few seconds of silence means it is gone.
                if (++consecutiveTimeouts >= 3) { RaiseDisconnected(); return; }
            }
            catch (Exception) when (!_stop)
            {
                RaiseDisconnected();
                return;
            }
            catch { return; }
        }
    }

    void WriteLoop()
    {
        var buf = new byte[Math.Max(_outLen, 78)];
        while (!_stop)
        {
            _writeSignal.WaitOne(500);
            if (_stop) break;
            DsOutputState snapshot;
            lock (_outLock)
            {
                if (!_outDirty) continue;
                _outDirty = false;
                snapshot = _out.Clone();
                _out.ReleaseLightbar = false;   // one-shot
            }
            try
            {
                Array.Clear(buf);
                snapshot.Build(buf, Transport, VibrationV2, ref _btSeq);
                _stream.Write(buf, 0, _outLen > 0 ? _outLen : buf.Length);
            }
            catch (Exception) when (!_stop)
            {
                // Writes can fail transiently over Bluetooth; the next change retries.
            }
            catch { return; }
        }
    }

    /// <summary>Mutates the output state and schedules a write.</summary>
    public void UpdateOutput(Action<DsOutputState> change)
    {
        lock (_outLock)
        {
            change(_out);
            _outDirty = true;
        }
        _writeSignal.Set();
    }

    void RaiseDisconnected()
    {
        if (Interlocked.Exchange(ref _disconnectRaised, 1) == 0)
            Disconnected?.Invoke(this);
    }

    public void Dispose()
    {
        if (_stop) return;
        // Leave the controller quiet: motors off, triggers released.
        try
        {
            DsOutputState final;
            lock (_outLock)
            {
                _out.MotorLeft = _out.MotorRight = 0;
                _out.TriggerL = TriggerEffects.Off();
                _out.TriggerR = TriggerEffects.Off();
                final = _out.Clone();
            }
            var buf = new byte[Math.Max(_outLen, 78)];
            final.Build(buf, Transport, VibrationV2, ref _btSeq);
            _stream.Write(buf, 0, _outLen > 0 ? _outLen : buf.Length);
        }
        catch { /* device already gone */ }
        _stop = true;
        _writeSignal.Set();
        try { _stream.Dispose(); } catch { }
        _reader.Join(500);
        _writer.Join(500);
    }
}
