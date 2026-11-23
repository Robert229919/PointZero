using System.Net.Http;
using System.Text.Json;

namespace PointZero.Core;

/// <summary>A newer release published on GitHub.</summary>
public sealed record ReleaseInfo(string Version, string Url, string Name, string Notes, string? PublishedAt);

/// <summary>
/// Asks GitHub for the latest published release of Point Zéro (the only network access the app makes).
/// Nothing about the user or the PC is sent: one anonymous GET to the public releases API.
/// </summary>
public static class UpdateChecker
{
    public const string Repo = "Robert229919/PointZero";
    public const string ReleasesPage = $"https://github.com/{Repo}/releases";

    static readonly HttpClient Http = CreateClient();

    static HttpClient CreateClient()
    {
        var c = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("PointZero-UpdateCheck");
        c.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
        return c;
    }

    public static Version Current { get; } = Normalize(typeof(UpdateChecker).Assembly.GetName().Version?.ToString(3) ?? "0.0.0");

    /// <summary>The latest release if it is newer than this build, otherwise null. Never throws.</summary>
    public static async Task<ReleaseInfo?> CheckAsync(string repo = Repo)
    {
        try
        {
            using var resp = await Http.GetAsync($"https://api.github.com/repos/{repo}/releases/latest");
            if (!resp.IsSuccessStatusCode) return null;   // 404 until the first release exists
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync());
            var r = doc.RootElement;
            if (r.TryGetProperty("draft", out var d) && d.GetBoolean()) return null;
            if (r.TryGetProperty("prerelease", out var p) && p.GetBoolean()) return null;
            string tag = r.GetProperty("tag_name").GetString() ?? "";
            var latest = Normalize(tag);
            if (latest <= Current) return null;
            string url = r.TryGetProperty("html_url", out var u) ? u.GetString() ?? ReleasesPage : ReleasesPage;
            if (!url.StartsWith($"https://github.com/{repo}/", StringComparison.OrdinalIgnoreCase)) url = ReleasesPage;
            string name = r.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString() ?? tag : tag;
            string notes = r.TryGetProperty("body", out var b) && b.ValueKind == JsonValueKind.String ? b.GetString() ?? "" : "";
            if (notes.Length > 1500) notes = notes[..1500] + "…";
            string? published = r.TryGetProperty("published_at", out var pa) ? pa.GetString() : null;
            return new ReleaseInfo(latest.ToString(3), url, name, notes, published);
        }
        catch (Exception ex)
        {
            Log.Write("Update check: " + ex.GetType().Name);
            return null;
        }
    }

    /// <summary>"v1.2" / "1.2.0-beta" → 1.2.0. Unparseable → 0.0.0.</summary>
    static Version Normalize(string s)
    {
        s = s.Trim().TrimStart('v', 'V');
        int cut = s.IndexOfAny(['-', '+', ' ']);
        if (cut >= 0) s = s[..cut];
        if (!Version.TryParse(s, out var v)) return new Version(0, 0, 0);
        return new Version(v.Major, Math.Max(0, v.Minor), Math.Max(0, v.Build));
    }
}
