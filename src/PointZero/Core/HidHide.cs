using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace PointZero.Core;

/// <summary>Minimal client for the HidHide control device (same IOCTLs as Nefarius.Drivers.HidHide).</summary>
public static unsafe class HidHideClient
{
    const uint DeviceType = 32769;
    static uint Ctl(uint fn) => (DeviceType << 16) | (1u << 14) | (fn << 2);   // METHOD_BUFFERED, FILE_READ_DATA
    static readonly uint GetWhitelist = Ctl(2048), SetWhitelist = Ctl(2049);
    static readonly uint GetBlacklist = Ctl(2050), SetBlacklist = Ctl(2051);
    static readonly uint GetActiveCode = Ctl(2052), SetActiveCode = Ctl(2053);
    static readonly uint GetInverse = Ctl(2054);

    static SafeFileHandle Open()
    {
        var h = Native.CreateFileW(@"\\.\HidHide", Native.GENERIC_READ | Native.GENERIC_WRITE,
            Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, IntPtr.Zero, Native.OPEN_EXISTING, Native.FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (h.IsInvalid) throw new IOException("HidHide n'est pas installé ou pas démarré.");
        return h;
    }

    public static bool IsAvailable
    {
        get { try { using var h = Open(); return true; } catch { return false; } }
    }

    static List<string> GetList(uint code)
    {
        using var h = Open();
        Native.DeviceIoControl(h, code, null, 0, null, 0, out uint required, IntPtr.Zero);
        if (required == 0) return [];
        var buf = new byte[required];
        fixed (byte* p = buf)
        {
            if (!Native.DeviceIoControl(h, code, null, 0, p, required, out uint got, IntPtr.Zero))
                throw new IOException("Lecture de la configuration HidHide impossible.");
            return Encoding.Unicode.GetString(buf, 0, (int)got).Split('\0', StringSplitOptions.RemoveEmptyEntries).ToList();
        }
    }

    static void SetList(uint code, IEnumerable<string> items)
    {
        var list = items.Where(s => !string.IsNullOrWhiteSpace(s)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        string multiSz = list.Count == 0 ? "\0\0" : string.Join('\0', list) + "\0\0";
        byte[] buf = Encoding.Unicode.GetBytes(multiSz);
        using var h = Open();
        fixed (byte* p = buf)
        {
            if (!Native.DeviceIoControl(h, code, p, (uint)buf.Length, null, 0, out _, IntPtr.Zero))
                throw new IOException("Écriture de la configuration HidHide refusée.");
        }
    }

    static bool GetFlag(uint code)
    {
        using var h = Open();
        byte v = 0;
        if (!Native.DeviceIoControl(h, code, null, 0, &v, 1, out _, IntPtr.Zero))
            throw new IOException("Lecture de l'état HidHide impossible.");
        return v != 0;
    }

    public static bool Active
    {
        get => GetFlag(GetActiveCode);
        set
        {
            using var h = Open();
            byte v = value ? (byte)1 : (byte)0;
            if (!Native.DeviceIoControl(h, SetActiveCode, &v, 1, null, 0, out _, IntPtr.Zero))
                throw new IOException("Activation HidHide refusée.");
        }
    }

    public static bool WhitelistInverted => GetFlag(GetInverse);

    public static List<string> BlockedInstances() => GetList(GetBlacklist);
    public static void SetBlockedInstances(IEnumerable<string> ids) => SetList(SetBlacklist, ids);

    /// <summary>Whitelisted applications as DOS device paths (\Device\HarddiskVolumeN\...).</summary>
    public static List<string> AllowedApps() => GetList(GetWhitelist);
    public static void SetAllowedApps(IEnumerable<string> devicePaths) => SetList(SetWhitelist, devicePaths);
}

/// <summary>
/// Hides the real controller from games only while Point Zéro runs.
/// Every change is written to a state file first (write-ahead) so a crash, a kill or a power cut
/// can always be undone: at the next start, by the "--cleanup" RunOnce entry at the next logon,
/// or by "Rendre la vraie manette visible maintenant".
/// </summary>
public sealed class CloakManager
{
    sealed class State
    {
        public List<string> Added { get; set; } = [];
        public bool EnabledActive { get; set; }
    }

    const string RunOnceKey = @"Software\Microsoft\Windows\CurrentVersion\RunOnce";
    const string RunOnceValue = "PointZeroCleanup";

    static string StatePath => System.IO.Path.Combine(AppPaths.Data, "cloak-state.json");
    readonly object _lock = new();

    public bool Available => HidHideClient.IsAvailable;

    static State Load()
    {
        try
        {
            if (File.Exists(StatePath))
                return JsonSerializer.Deserialize<State>(File.ReadAllText(StatePath)) ?? new State();
        }
        catch { }
        return new State();
    }

    static void Save(State s)
    {
        Directory.CreateDirectory(AppPaths.Data);
        string tmp = StatePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(s));
        File.Move(tmp, StatePath, overwrite: true);
    }

    /// <summary>Undo whatever a previous run left behind. Safe to call any time. Returns a short report.</summary>
    public static string? CleanupLeftovers()
    {
        if (!File.Exists(StatePath)) { RemoveRunOnce(); return null; }
        var s = Load();
        if (s.Added.Count == 0 && !s.EnabledActive) { TryDelete(StatePath); RemoveRunOnce(); return null; }
        if (!HidHideClient.IsAvailable) return "HidHide est absent : rien à nettoyer côté pilote.";
        var blocked = HidHideClient.BlockedInstances();
        int removed = blocked.RemoveAll(b => s.Added.Contains(b, StringComparer.OrdinalIgnoreCase));
        HidHideClient.SetBlockedInstances(blocked);
        if (s.EnabledActive) HidHideClient.Active = false;   // it was off before Point Zéro turned it on
        TryDelete(StatePath);
        RemoveRunOnce();
        return removed > 0 ? "La manette était restée cachée après un arrêt imprévu : elle est de nouveau visible." : null;
    }

    /// <summary>Makes sure Point Zéro (and the user's extra apps) can still see the real controller.</summary>
    public void EnsureAllowed(IEnumerable<string> exePaths)
    {
        lock (_lock)
        {
            var current = HidHideClient.AllowedApps();
            var wanted = exePaths.Select(Native.ToDosDevicePath).Where(p => p != null).Cast<string>().ToList();
            var missing = wanted.Where(w => !current.Contains(w, StringComparer.OrdinalIgnoreCase)).ToList();
            if (missing.Count > 0) HidHideClient.SetAllowedApps(current.Concat(missing));
        }
    }

    public void RemoveAllowed(string exePath)
    {
        lock (_lock)
        {
            string? dev = Native.ToDosDevicePath(exePath);
            if (dev == null) return;
            var current = HidHideClient.AllowedApps();
            if (current.RemoveAll(c => c.Equals(dev, StringComparison.OrdinalIgnoreCase)) > 0)
                HidHideClient.SetAllowedApps(current);
        }
    }

    /// <summary>Hide one device instance from every non-whitelisted application.</summary>
    public void Hide(string instanceId)
    {
        lock (_lock)
        {
            var s = Load();
            var blocked = HidHideClient.BlockedInstances();
            bool alreadyBlocked = blocked.Contains(instanceId, StringComparer.OrdinalIgnoreCase);
            bool active = HidHideClient.Active;
            if (alreadyBlocked && active) return;

            if (!alreadyBlocked && !s.Added.Contains(instanceId, StringComparer.OrdinalIgnoreCase)) s.Added.Add(instanceId);
            if (!active) s.EnabledActive = true;
            Save(s);            // write-ahead
            SetRunOnce();

            if (!alreadyBlocked) HidHideClient.SetBlockedInstances(blocked.Append(instanceId));
            if (!active) HidHideClient.Active = true;
        }
    }

    /// <summary>Remove every block Point Zéro added and restore HidHide's previous on/off state.</summary>
    public void UnhideAll()
    {
        lock (_lock)
        {
            try { CleanupLeftovers(); } catch { }
        }
    }

    public bool IsHidden(string instanceId)
    {
        try
        {
            return HidHideClient.Active &&
                   HidHideClient.BlockedInstances().Contains(instanceId, StringComparer.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    static void SetRunOnce()
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(RunOnceKey);
            k.SetValue(RunOnceValue, $"\"{Environment.ProcessPath}\" --cleanup");
        }
        catch { }
    }

    static void RemoveRunOnce()
    {
        try
        {
            using var k = Registry.CurrentUser.OpenSubKey(RunOnceKey, writable: true);
            k?.DeleteValue(RunOnceValue, throwOnMissingValue: false);
        }
        catch { }
    }

    static void TryDelete(string path) { try { File.Delete(path); } catch { } }
}
