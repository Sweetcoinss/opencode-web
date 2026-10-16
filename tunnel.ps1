# ------------------------------------------------------------------
#  رابط عمومي للموقع (Cloudflare Tunnel)
#  كيشغّل الخادم + النفق، وكيطبع الرابط اللي كيخدم من الهاتف ومن أي جهاز.
# ------------------------------------------------------------------

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cf = "$env:USERPROFILE\.cloudflared\cloudflared.exe"
$log = "$env:TEMP\opencode-web-tunnel.log"
$urlFile = "$root\tunnel-url.txt"

function Show-Url($u) {
  Write-Host ""
  Write-Host "  ======================================================" -ForegroundColor Yellow
  Write-Host "        الرابط العمومي — حلّو من الهاتف ولا أي جهاز" -ForegroundColor Yellow
  Write-Host "  ======================================================" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "     $u" -ForegroundColor Green
  Write-Host ""
}

if (-not (Test-Path $cf)) {
  Write-Host "cloudflared ما كاينش فـ: $cf" -ForegroundColor Red
  exit 1
}

# ---------------- 1) الخادم ----------------
$listen = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue
if (-not $listen) {
  Write-Host "[1/2] كنشغّل الخادم..." -ForegroundColor Cyan
  Start-Process node -ArgumentList "server.mjs" -WorkingDirectory $root -WindowStyle Minimized
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue) { break }
  }
}
if (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "[1/2] الخادم شغّال ✅" -ForegroundColor Green
}
else {
  Write-Host "[1/2] الخادم ما بغاش يشعل ❌  (شغّل start.cmd أولا وشوف الخطأ)" -ForegroundColor Red
  exit 1
}

# ---------------- 2) النفق ----------------
$running = Get-Process cloudflared -ErrorAction SilentlyContinue
$old = $null
if (Test-Path $urlFile) { $old = (Get-Content $urlFile -Raw).Trim() }

if ($running -and $old) {
  Write-Host "[2/2] النفق شغّال من قبل ✅" -ForegroundColor Green
  Show-Url $old
  exit 0
}

Write-Host "[2/2] كنفتح النفق..." -ForegroundColor Cyan
if (Test-Path $log) { Remove-Item $log -Force }

$p = Start-Process $cf -ArgumentList 'tunnel', '--url', 'http://localhost:8790', '--no-autoupdate', '--logfile', $log, '--loglevel', 'info' -PassThru -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
}

if (-not $url) {
  Write-Host "ما نجحتش نجيب الرابط — شوف اللوغ: $log" -ForegroundColor Red
  exit 1
}

$url | Set-Content $urlFile -Encoding utf8
Show-Url $url

Write-Host "  ✅ الرابط محفوظ فـ tunnel-url.txt" -ForegroundColor DarkGray
Write-Host "  ✅ الوضع المباشر خدام | الوضع المحلي مسدود من برّا" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  سدّ هاد النافذة = الرابط كيتوقف. الرابط كيتبدل ملي تعاود تشغّل." -ForegroundColor DarkGray
Write-Host ""

Wait-Process -Id $p.Id
