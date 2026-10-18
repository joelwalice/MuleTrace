# Demo day: serve the API and dashboard on this laptop's network address, so judges' phones can open /send.
#   powershell -ExecutionPolicy Bypass -File demo-lan.ps1 [-Ip 192.168.0.101] [-SkipBuild]
# Phones must be on the same Wi-Fi (or the laptop's hotspot). Uses the production build: the Next dev server
# blocks its own scripts for hosts other than localhost, so /send on a phone would never become interactive.
param([string]$Ip, [switch]$SkipBuild)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $Ip) {
    $Ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi*" -ErrorAction SilentlyContinue |
           Where-Object { $_.IPAddress -notmatch '^169\.254' } | Select-Object -First 1).IPAddress
}
if (-not $Ip) { throw "No Wi-Fi IPv4 address found. Pass one: -Ip <address>" }

$env:NEXT_PUBLIC_API = "http://${Ip}:8000"  # baked into the dashboard at build time
$env:CORS_ORIGINS = "http://${Ip}:3000,http://localhost:3000"
$env:DASHBOARD_URL = "http://${Ip}:3000"  # the agent's one-click approve link
$env:PYTHONUTF8 = "1"

if (-not $SkipBuild) {
    Push-Location "$root\web"; npm run build; if ($LASTEXITCODE) { Pop-Location; throw "web build failed" }; Pop-Location
}
$api = Start-Process -FilePath "$root\.venv\Scripts\python.exe" -WorkingDirectory $root -PassThru -NoNewWindow `
    -ArgumentList "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"
Write-Host "`nDashboard: http://${Ip}:3000    Judge phones: http://${Ip}:3000/send    API: http://${Ip}:8000/docs"
Write-Host "Windows may ask to allow Python and Node through the firewall: allow Private networks. Ctrl+C stops both.`n"
try {
    Push-Location "$root\web"; npm start -- -H 0.0.0.0 -p 3000
} finally {
    Pop-Location; Stop-Process -Id $api.Id -Force -ErrorAction SilentlyContinue
}
