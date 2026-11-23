# Generates src/PointZero/Assets/PointZero.ico (ring + centred acid-green dot on black).
# Usage: pwsh -File tools/make-icon.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\src\PointZero\Assets\PointZero.ico'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $r = [Math]::Max(2, [Math]::Round($s * 0.18))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90); $path.AddArc($s - $r * 2 - 1, 0, $r * 2, $r * 2, 270, 90)
    $path.AddArc($s - $r * 2 - 1, $s - $r * 2 - 1, $r * 2, $r * 2, 0, 90); $path.AddArc(0, $s - $r * 2 - 1, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 10, 10, 10))), $path)
    $stroke = [Math]::Max(1.5, $s * 0.075)
    $ring = $s * 0.62
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 236, 236, 232)), $stroke
    $g.DrawEllipse($pen, ($s - $ring) / 2, ($s - $ring) / 2, $ring, $ring)
    $dot = [Math]::Max(3, $s * 0.2)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 200, 255, 60))), ($s - $dot) / 2, ($s - $dot) / 2, $dot, $dot)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    , $ms.ToArray()
}

$fs = [System.IO.File]::Create($out)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $b = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$b); $w.Write([byte]$b); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Dispose()
"Wrote $out"
