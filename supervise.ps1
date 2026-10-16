# ------------------------------------------------------------------
#  مراقب — كيخلي الموقع + الرابط العمومي شغالين دايماً
#  • كيتشغّل تلقائيًا ملي تحل الحاسوب
#  • كيعاود يشغّل الخادم ولا النفق إلا طاحو
#  • كيكتب الرابط فسطح المكتب + رمز QR باش تسكانيه بالهاتف
# ------------------------------------------------------------------

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cf = "$env:USERPROFILE\.cloudflared\cloudflared.exe"
$log = "$env:TEMP\opencode-web-tunnel.log"
$urlFile = "$root\tunnel-url.txt"
$dbg = "$env:TEMP\opencode-web-supervise.log"
$desk = [Environment]::GetFolderPath("Desktop")
$txtPath = Join-Path $desk "رابط الموقع.txt"
$pngPath = Join-Path $desk "رابط الموقع.png"
$port = 8790

function Log($m) {
  "[$((Get-Date).ToString('HH:mm:ss'))] $m" | Add-Content $dbg -Encoding UTF8
}

function Test-Server {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Start-Server {
  if (Test-Server) { return }
  Log "الخادم طايح — كنعاود نشغّلو"
  Start-Process node -ArgumentList "server.mjs" -WorkingDirectory $root -WindowStyle Hidden
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Server) { break }
  }
  Log ("الخادم: " + $(if (Test-Server) { "شغّال" } else { "مازال طايح" }))
}

# عنوان اللوغ اللي خدام بيه cloudflared دابا (باش نقراو الرابط الصحيح)
function Current-TunnelLog {
  $p = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p -and $p.CommandLine -match '--logfile\s+"?([^"]+?)"?(?:\s|$)') {
    return $Matches[1].Trim()
  }
  return $log
}

function Start-Tunnel {
  if (Get-Process cloudflared -ErrorAction SilentlyContinue) { return }
  Log "النفق طايح — كنعاود نشغّلو"
  if (Test-Path $log) { Remove-Item $log -Force }
  Start-Process $cf -ArgumentList 'tunnel', '--url', "http://localhost:$port", '--no-autoupdate', '--logfile', $log, '--loglevel', 'info' -WindowStyle Hidden
}

function Get-TunnelUrl {
  $candidates = @( (Current-TunnelLog), $log, "$env:TEMP\cf-tunnel.log" ) | Select-Object -Unique
  $best = $null
  foreach ($l in $candidates) {
    if (-not (Test-Path $l)) { continue }
    $m = Select-String -Path $l -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $m) { continue }
    $t = (Get-Item $l).LastWriteTime
    if (-not $best -or $t -gt $best.t) { $best = @{ url = $m.Matches[0].Value; t = $t } }
  }
  if ($best) { return $best.url }
  return $null
}

function Save-Qr($url) {
  $enc = [uri]::EscapeDataString($url)
  $svcs = @(
    "https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=14&data=$enc",
    "https://quickchart.io/qr?size=360&margin=2&text=$enc"
  )
  foreach ($s in $svcs) {
    try {
      Invoke-WebRequest $s -OutFile $pngPath -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
      return $true
    }
    catch { }
  }
  return $false
}

Log "=== بدأ المراقب ==="
$last = $null

while ($true) {
  try {
    Start-Server
    Start-Tunnel

    $u = Get-TunnelUrl
    if ($u -and $u -ne $last) {
      $last = $u
      Log "رابط جديد: $u"
      $u | Set-Content $urlFile -Encoding UTF8
      $okQr = Save-Qr $u
      if ($okQr) { Log "رمز QR تحفظ فسطح المكتب" }

      $note = if ($okQr) {
        "سكاني رمز QR اللي حدا هاد الملف (رابط الموقع.png) بالكاميرا ديال الهاتف."
      }
      else {
        "كتب هاد الرابط فالهاتف."
      }

      @"
رابط الموقع — كيخدم من الهاتف ومن أي جهاز فالعالم
==================================================

$u

$note

• الرابط كيتبدل ملي يعاود يشعل الحاسوب — عاود شوف هاد الملف.
• كيخدم ملي الحاسوب شغال.
"@ | Set-Content $txtPath -Encoding UTF8
    }
  }
  catch {
    Log ("خطأ: " + $_.Exception.Message)
  }

  Start-Sleep -Seconds 15
}
