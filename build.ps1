# Builds dist\PointZero.exe (single self-contained file, no .NET install needed to run it).
# Requires the .NET 10 SDK:  winget install Microsoft.DotNet.SDK.10
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
dotnet publish src\PointZero\PointZero.csproj -c Release -o dist -nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-ChildItem dist -Exclude PointZero.exe | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$exe = Get-Item dist\PointZero.exe
"Built {0} ({1:N1} Mo)" -f $exe.FullName, ($exe.Length / 1MB)
