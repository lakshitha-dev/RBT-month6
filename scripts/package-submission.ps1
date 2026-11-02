# Builds the four submission artifacts in ./submission
#   powershell -ExecutionPolicy Bypass -File scripts/package-submission.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'submission'
$name = 'lakshitha-wijerathne-month6'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'  # bsdtar; Git for Windows puts GNU tar first on PATH
New-Item -ItemType Directory -Force $out | Out-Null

# 1. Design document
Copy-Item (Join-Path $root "docs/$name-system-design.md") (Join-Path $out "$name-system-design.md") -Force

# 2. C4 diagrams (draw.io + PlantUML sources + PNG renders)
$c4 = Join-Path $root 'docs/c4'
$c4Zip = Join-Path $out "$name-c4-diagrams.zip"
Remove-Item $c4Zip -ErrorAction SilentlyContinue
# tar.exe (built into Windows 10+) writes portable '/' entry paths; PS 5.1 Compress-Archive writes '\'.
$c4Files = @(Get-ChildItem $c4 -File | Where-Object { $_.Extension -in '.drawio', '.puml' } | ForEach-Object Name) + 'png'
& $tar -a -c -f $c4Zip -C $c4 @c4Files

# 3. Microservices POC (no node_modules)
$stage = Join-Path ([IO.Path]::GetTempPath()) "$name-microservices"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($item in 'services', 'gateway', 'infra', 'scripts', 'docker-compose.yml', 'README.md') {
  Copy-Item (Join-Path $root $item) $stage -Recurse -Force
}
Get-ChildItem $stage -Recurse -Directory -Filter node_modules | Remove-Item -Recurse -Force
$pocZip = Join-Path $out "$name-microservices.zip"
Remove-Item $pocZip -ErrorAction SilentlyContinue
& $tar -a -c -f $pocZip -C $stage services gateway infra scripts docker-compose.yml README.md
Remove-Item $stage -Recurse -Force

# 4. Presentation
Copy-Item (Join-Path $root 'docs/presentation/slides.pdf') (Join-Path $out "$name-presentation.pdf") -Force

Get-ChildItem $out | Select-Object Name, @{ n = 'KB'; e = { [math]::Round($_.Length / 1KB) } }
