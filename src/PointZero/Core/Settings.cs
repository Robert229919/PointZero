using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32;

namespace PointZero.Core;

public static class AppPaths
{
    public static string Data { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "PointZero");
    public static string Profiles => Path.Combine(Data, "profiles");
    public static string SettingsFile => Path.Combine(Data, "settings.json");
    public static string LogFile => Path.Combine(Data, "pointzero.log");
    public static string WebViewData { get; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PointZero", "WebView2");
}

public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };
}

public sealed class Settings
{
    public string ActiveProfile { get; set; } = "Défaut";
    public string VirtualType { get; set; } = "x360";
    public bool Correction { get; set; } = true;
    public bool HideReal { get; set; } = true;
    public bool CheckUpdates { get; set; } = true;
    public string? SkippedVersion { get; set; }
    public bool Autostart { get; set; }
    public bool CloseToTray { get; set; } = true;
    public bool StartMinimized { get; set; }
    public List<string> Whitelist { get; set; } = [];
    public bool FirstRunDone { get; set; }

    public static Settings Load()
    {
        try
        {
            if (File.Exists(AppPaths.SettingsFile))
                return JsonSerializer.Deserialize<Settings>(File.ReadAllText(AppPaths.SettingsFile), Json.Options) ?? new();
        }
        catch { }
        return new();
    }

    public void Save()
    {
        Directory.CreateDirectory(AppPaths.Data);
        string tmp = AppPaths.SettingsFile + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json.Options));
        File.Move(tmp, AppPaths.SettingsFile, overwrite: true);
    }
}

/// <summary>Profiles as one JSON file each in %APPDATA%\PointZero\profiles.</summary>
public static class ProfileStore
{
    static string FileFor(string name)
    {
        var safe = string.Concat(name.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c)).Trim();
        if (safe.Length == 0) safe = "profil";
        return Path.Combine(AppPaths.Profiles, safe + ".json");
    }

    public static List<string> List()
    {
        Directory.CreateDirectory(AppPaths.Profiles);
        var names = new List<string>();
        foreach (var f in Directory.EnumerateFiles(AppPaths.Profiles, "*.json"))
        {
            try
            {
                var p = JsonSerializer.Deserialize<Profile>(File.ReadAllText(f), Json.Options);
                if (p != null && !string.IsNullOrWhiteSpace(p.Name)) names.Add(p.Name);
            }
            catch { }
        }
        names.Sort(StringComparer.CurrentCultureIgnoreCase);
        return names;
    }

    public static Profile? Load(string name)
    {
        try
        {
            string f = FileFor(name);
            if (!File.Exists(f)) return null;
            var p = JsonSerializer.Deserialize<Profile>(File.ReadAllText(f), Json.Options);
            if (p == null) return null;
            p.Name = name;
            p.Sanitize();
            return p;
        }
        catch { return null; }
    }

    public static void Save(Profile p)
    {
        Directory.CreateDirectory(AppPaths.Profiles);
        string f = FileFor(p.Name);
        string tmp = f + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(p, Json.Options));
        File.Move(tmp, f, overwrite: true);
    }

    public static void Delete(string name)
    {
        try { File.Delete(FileFor(name)); } catch { }
    }
}

/// <summary>"Lancer au démarrage de Windows" via HKCU\...\Run (no elevation needed).</summary>
public static class Autostart
{
    const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string Value = "PointZero";

    public static void Set(bool on)
    {
        using var k = Registry.CurrentUser.CreateSubKey(Key);
        if (on) k.SetValue(Value, $"\"{Environment.ProcessPath}\" --tray");
        else k.DeleteValue(Value, throwOnMissingValue: false);
    }

    public static bool IsSet()
    {
        using var k = Registry.CurrentUser.OpenSubKey(Key);
        return k?.GetValue(Value) is string s && s.Contains(Environment.ProcessPath ?? "\0", StringComparison.OrdinalIgnoreCase);
    }
}

public static class Log
{
    static readonly object Gate = new();

    public static void Write(string msg)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(AppPaths.Data);
                var fi = new FileInfo(AppPaths.LogFile);
                if (fi.Exists && fi.Length > 512 * 1024) File.Move(AppPaths.LogFile, AppPaths.LogFile + ".old", overwrite: true);
                File.AppendAllText(AppPaths.LogFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}  {msg}{Environment.NewLine}");
            }
        }
        catch { }
    }
}
