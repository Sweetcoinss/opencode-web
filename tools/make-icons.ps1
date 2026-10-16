# make-icons.ps1 — كيولّد أيقونات الموقع من شعار المشروع
#
#   powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
#
# المصدر: tools\logo-source.png   (بدّلو بأي صورة مربّعة، ومن بعد عاود شغّل السكريبت)
# كيخرج: public\favicon-32.png, logo-96.png, icon-192.png,
#        icon-512.png, icon-maskable-512.png, apple-touch-icon.png
#
# كيستعمل System.Drawing ديال ويندوز — بلا أي مكتبة خارجية.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$srcPath = Join-Path $PSScriptRoot "logo-source.png"
$pub = Join-Path $root "public"

if (-not (Test-Path $srcPath)) { throw "ما لقيتش الشعار: $srcPath" }

$src = [System.Drawing.Image]::FromFile($srcPath)

function Save-Resized {
  param(
    [System.Drawing.Image]$img,
    [int]$size,
    [string]$out,
    [double]$contentPct = 1.0
  )
  # 24bpp: الخلفية معتمة، وبلا قناة ألفا كيولّي PNG أصغر بزاف
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 0, 1))
  $c = [int][Math]::Round($size * $contentPct)
  $o = [int][Math]::Round(($size - $c) / 2)
  $g.DrawImage($img, ([System.Drawing.Rectangle]::new($o, $o, $c, $c)))
  $g.Dispose()
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $kb = [Math]::Round((Get-Item $out).Length / 1KB, 1)
  "  {0,-26} {1}x{1}  {2} KB" -f (Split-Path $out -Leaf), $size, $kb
}

Write-Host "كيولّد الأيقونات من $srcPath"
Save-Resized -img $src -size 512 -out (Join-Path $pub "icon-512.png")
# maskable: المحتوى مصغّر باش ما يتقصّش ملي أندرويد كيدير قناع دائري
Save-Resized -img $src -size 512 -out (Join-Path $pub "icon-maskable-512.png") -contentPct 0.74
Save-Resized -img $src -size 192 -out (Join-Path $pub "icon-192.png")
Save-Resized -img $src -size 180 -out (Join-Path $pub "apple-touch-icon.png")
Save-Resized -img $src -size 96  -out (Join-Path $pub "logo-96.png")
Save-Resized -img $src -size 32  -out (Join-Path $pub "favicon-32.png")

$src.Dispose()
Write-Host "تم." -ForegroundColor Green
