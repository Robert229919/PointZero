using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;
using System.Text;

namespace PointZero.Core;

/// <summary>
/// HidHide only blocks *new* opens: apps that already hold the DualSense (Steam, a browser) keep seeing it, and apps
/// that failed while it was hidden never notice it come back. Restarting the pad's HID node makes every app drop it
/// and re-detect it under the new rules — the same trick DS4Windows uses.
///
/// Restarting a device needs administrator rights, so a scheduled task does it, installed once with UAC:
/// it runs as SYSTEM a fixed script stored in Program Files (not writable by the user, so the task cannot be
/// abused to run anything else), and its security descriptor lets the current user start it without a prompt.
/// </summary>
public static class PadRefresher
{
    public const string TaskName = "PointZero RestartPad";
    static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PointZero");
    static string ScriptPath => Path.Combine(Dir, "restart-pad.ps1");

    const string Script = """
        # Point Zéro : redémarre la DualSense (collections HID) pour que toutes les applications la redétectent
        # après un changement de masquage HidHide. Installé par "PointZero.exe --install-helper".
        $ErrorActionPreference = 'SilentlyContinue'
        $pnputil = Join-Path $env:SystemRoot 'System32\pnputil.exe'
        Get-PnpDevice -PresentOnly -Class HIDClass |
            Where-Object { $_.InstanceId -match '^HID\\.*VID(_|&0002)054C[&_]PID[&_](0CE6|0DF2)' } |
            ForEach-Object { & $pnputil /restart-device $_.InstanceId | Out-Null }
        """;

    static volatile bool _refreshing;
    public static bool Refreshing => _refreshing;

    public static bool IsInstalled
    {
        get
        {
            if (!File.Exists(ScriptPath)) return false;
            return RunHidden("schtasks.exe", $"/Query /TN \"{TaskName}\"", 5000) == 0;
        }
    }

    /// <summary>Restarts the pad now (fire and forget). Returns false when the helper is not installed.</summary>
    public static bool Refresh(Action? done = null)
    {
        if (_refreshing) return true;
        _refreshing = true;
        Task.Run(() =>
        {
            try
            {
                int code = RunHidden("schtasks.exe", $"/Run /TN \"{TaskName}\"", 5000);
                if (code != 0) Log.Write($"Pad refresh: schtasks /Run exit {code}");
                else Thread.Sleep(2500);   // the task needs ~1-2 s (PowerShell + pnputil)
            }
            finally
            {
                _refreshing = false;
                done?.Invoke();
            }
        });
        return true;
    }

    /// <summary>
    /// Name of the program that refused the pad's removal since <paramref name="since"/> (Kernel-PnP event 225,
    /// readable without admin rights), e.g. "MoonSweepers.exe". Null if none was logged.
    /// </summary>
    public static string? FindVetoingApp(DateTime since)
    {
        try
        {
            string t = since.ToUniversalTime().AddSeconds(-2).ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
            var q = new System.Diagnostics.Eventing.Reader.EventLogQuery("System", System.Diagnostics.Eventing.Reader.PathType.LogName,
                $"*[System[Provider[@Name='Microsoft-Windows-Kernel-PnP'] and EventID=225 and TimeCreated[@SystemTime>='{t}']]]");
            using var reader = new System.Diagnostics.Eventing.Reader.EventLogReader(q);
            string? found = null;
            for (var e = reader.ReadEvent(); e != null; e = reader.ReadEvent())
            {
                using (e)
                {
                    string msg = e.FormatDescription() ?? "";
                    if (!msg.Contains("054c", StringComparison.OrdinalIgnoreCase)) continue;
                    var m = System.Text.RegularExpressions.Regex.Match(msg, @"([^\\""]+\.exe)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                    if (m.Success) found = m.Groups[1].Value;
                }
            }
            return found;
        }
        catch (Exception ex)
        {
            Log.Write("Veto lookup: " + ex.Message);
            return null;
        }
    }

    /// <summary>Starts the task synchronously (used on exit, when no background work can finish).</summary>
    public static void RunNow() => RunHidden("schtasks.exe", $"/Run /TN \"{TaskName}\"", 3000);

    /// <summary>Asks for elevation and installs (or removes) the helper. Returns null on success, else a French message.</summary>
    public static string? RunElevated(bool install)
    {
        string? exe = Environment.ProcessPath;
        if (exe == null) return "Chemin de l'application introuvable.";
        string sid = WindowsIdentity.GetCurrent().User?.Value ?? "";
        try
        {
            using var p = Process.Start(new ProcessStartInfo(exe, install ? $"--install-helper {sid}" : "--remove-helper")
            {
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            });
            if (p == null) return "Impossible de lancer l'installation.";
            if (!p.WaitForExit(60000)) return "L'installation ne répond pas.";
            if (p.ExitCode != 0) return $"L'installation a échoué (code {p.ExitCode}).";
            return null;
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            return "Autorisation administrateur refusée.";
        }
        catch (Exception ex)
        {
            Log.Write("Helper elevation: " + ex.Message);
            return "Impossible d'obtenir l'autorisation administrateur.";
        }
    }

    // ---- the following run in the elevated process ----

    public static int InstallElevated(string userSid)
    {
        try
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(ScriptPath, Script.Replace("\n", "\r\n"), new UTF8Encoding(true));
            string ps = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            // SYSTEM runs it hidden; the current user may read and start it (GRGX), nobody else but admins.
            string sddl = $"D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;{userSid})";
            string xml = $"""
                <?xml version="1.0" encoding="UTF-16"?>
                <Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
                  <RegistrationInfo>
                    <Description>Point Zéro : redémarre la DualSense pour que les applications voient le changement de masquage.</Description>
                    <SecurityDescriptor>{sddl}</SecurityDescriptor>
                  </RegistrationInfo>
                  <Principals>
                    <Principal id="System">
                      <UserId>S-1-5-18</UserId>
                      <RunLevel>HighestAvailable</RunLevel>
                    </Principal>
                  </Principals>
                  <Settings>
                    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
                    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
                    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
                    <AllowStartOnDemand>true</AllowStartOnDemand>
                    <Enabled>true</Enabled>
                    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
                    <Priority>4</Priority>
                  </Settings>
                  <Actions Context="System">
                    <Exec>
                      <Command>{ps}</Command>
                      <Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{ScriptPath}"</Arguments>
                    </Exec>
                  </Actions>
                </Task>
                """;
            string tmp = Path.Combine(Path.GetTempPath(), "PointZero-task.xml");
            File.WriteAllText(tmp, xml, Encoding.Unicode);
            int code = RunHidden("schtasks.exe", $"/Create /TN \"{TaskName}\" /XML \"{tmp}\" /F", 15000);
            try { File.Delete(tmp); } catch { }
            return code == 0 ? 0 : 10 + code;
        }
        catch (Exception ex)
        {
            Log.Write("Helper install: " + ex);
            return 2;
        }
    }

    public static int RemoveElevated()
    {
        RunHidden("schtasks.exe", $"/Delete /TN \"{TaskName}\" /F", 15000);
        try { if (Directory.Exists(Dir)) Directory.Delete(Dir, recursive: true); } catch { }
        return 0;
    }

    static int RunHidden(string file, string args, int timeoutMs)
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo(file, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            if (p == null) return -1;
            p.StandardOutput.ReadToEndAsync();
            p.StandardError.ReadToEndAsync();
            return p.WaitForExit(timeoutMs) ? p.ExitCode : -2;
        }
        catch { return -3; }
    }
}
