using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace PointZero.Core;

/// <summary>Small Win32 / CfgMgr32 helpers.</summary>
internal static unsafe class Native
{
    [StructLayout(LayoutKind.Sequential)]
    struct DEVPROPKEY { public Guid fmtid; public uint pid; }

    static readonly DEVPROPKEY DevpkeyInstanceId = new() { fmtid = new Guid("78C34FC8-104A-4ACA-9EA4-524D52996E57"), pid = 256 };
    static readonly DEVPROPKEY DevpkeyStack = new() { fmtid = new Guid("540B947E-8B40-45BC-A8A2-6A0B894CBDA2"), pid = 14 };

    const int CR_SUCCESS = 0;
    const int CR_BUFFER_SMALL = 0x1A;

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_Device_Interface_PropertyW(string pszDeviceInterface, in DEVPROPKEY key, out uint type, byte* buffer, ref uint size, uint flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Locate_DevNodeW(out uint devInst, string deviceId, uint flags);

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
    static extern int CM_Get_DevNode_PropertyW(uint devInst, in DEVPROPKEY key, out uint type, byte* buffer, ref uint size, uint flags);

    /// <summary>Device instance ID (e.g. HID\VID_054C&amp;PID_0CE6&amp;MI_03\8&amp;...) of a device interface path.</summary>
    public static string? InstanceIdFromInterfacePath(string interfacePath)
    {
        uint size = 0;
        int cr = CM_Get_Device_Interface_PropertyW(interfacePath, DevpkeyInstanceId, out _, null, ref size, 0);
        if (cr != CR_BUFFER_SMALL || size == 0) return FallbackInstanceId(interfacePath);
        byte[] buf = new byte[size];
        fixed (byte* p = buf)
        {
            cr = CM_Get_Device_Interface_PropertyW(interfacePath, DevpkeyInstanceId, out _, p, ref size, 0);
            if (cr != CR_SUCCESS) return FallbackInstanceId(interfacePath);
            return new string((char*)p).Trim();
        }
    }

    /// <summary>\\?\hid#vid_054c&amp;pid_0ce6&amp;mi_03#8&amp;2bc4&amp;0&amp;0000#{guid} → HID\VID_054C&amp;PID_0CE6&amp;MI_03\8&amp;2BC4&amp;0&amp;0000</summary>
    static string? FallbackInstanceId(string path)
    {
        string p = path;
        if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) p = p[4..];
        int g = p.LastIndexOf("#{", StringComparison.Ordinal);
        if (g > 0) p = p[..g];
        return p.Replace('#', '\\').ToUpperInvariant();
    }

    /// <summary>Driver stack of a device node, e.g. ["\Driver\HidHide", "\Driver\hidgamepad", ...]. Null if unknown.</summary>
    public static string[]? DriverStack(string instanceId)
    {
        if (CM_Locate_DevNodeW(out uint dev, instanceId, 0) != CR_SUCCESS) return null;
        uint size = 0;
        int cr = CM_Get_DevNode_PropertyW(dev, DevpkeyStack, out _, null, ref size, 0);
        if (cr != CR_BUFFER_SMALL || size == 0) return null;
        byte[] buf = new byte[size];
        fixed (byte* p = buf)
        {
            if (CM_Get_DevNode_PropertyW(dev, DevpkeyStack, out _, p, ref size, 0) != CR_SUCCESS) return null;
            return new string((char*)p, 0, (int)size / 2).Split('\0', StringSplitOptions.RemoveEmptyEntries);
        }
    }

    static readonly DEVPROPKEY DevpkeyRebootRequired = new() { fmtid = new Guid("540B947E-8B40-45BC-A8A2-6A0B894CBDA2"), pid = 16 };

    /// <summary>
    /// True when Windows flagged the device "reboot required" (a restart was vetoed by an app). Further restarts are
    /// ignored until the device is reconnected.
    /// </summary>
    public static bool IsRebootRequired(string instanceId)
    {
        if (CM_Locate_DevNodeW(out uint dev, instanceId, 0) != CR_SUCCESS) return false;
        byte v = 0;
        uint size = 1;
        return CM_Get_DevNode_PropertyW(dev, DevpkeyRebootRequired, out _, &v, ref size, 0) == CR_SUCCESS && v != 0;
    }

    // ---- File / IOCTL ----

    public const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3, FILE_ATTRIBUTE_NORMAL = 0x80;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DeviceIoControl(SafeFileHandle h, uint code, byte* inBuf, uint inLen, byte* outBuf, uint outLen, out uint returned, IntPtr overlapped);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint QueryDosDeviceW(string deviceName, char* target, uint max);

    /// <summary>C:\dir\app.exe → \Device\HarddiskVolume3\dir\app.exe (the form HidHide stores).</summary>
    public static string? ToDosDevicePath(string fullPath)
    {
        fullPath = Path.GetFullPath(fullPath);
        string root = Path.GetPathRoot(fullPath) ?? "";
        if (root.Length < 2 || root[1] != ':') return null;
        char* buf = stackalloc char[1024];
        uint n = QueryDosDeviceW(root[..2], buf, 1024);
        if (n == 0) return null;
        string device = new(buf);
        return device + fullPath[2..];
    }

    // ---- Window chrome ----

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    public static void DarkTitleBar(IntPtr hwnd, int captionColorBgr)
    {
        int on = 1;
        DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int));                // DWMWA_USE_IMMERSIVE_DARK_MODE
        DwmSetWindowAttribute(hwnd, 35, ref captionColorBgr, sizeof(int));   // DWMWA_CAPTION_COLOR (Win11)
        int text = 0x00E8ECEC;
        DwmSetWindowAttribute(hwnd, 36, ref text, sizeof(int));              // DWMWA_TEXT_COLOR
        int border = 0x00222222;
        DwmSetWindowAttribute(hwnd, 34, ref border, sizeof(int));            // DWMWA_BORDER_COLOR
    }
}
