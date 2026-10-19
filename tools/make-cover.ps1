# 生成小程序分享封面图（800x640，5:4）：紫色渐变 + 白色卡片 + 5W1H 清单
# 用法：powershell -ExecutionPolicy Bypass -File tools\make-cover.ps1
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\miniprogram\images\survey-cover.png'
$W = 800; $H = 640
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

function New-RoundPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# 背景渐层
$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$c1 = [System.Drawing.ColorTranslator]::FromHtml('#4F46E5')
$c2 = [System.Drawing.ColorTranslator]::FromHtml('#9333EA')
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45)
$g.FillRectangle($bg, $rect)

# 装饰圆
$deco = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36, 255, 255, 255))
$g.FillEllipse($deco, 620, -80, 300, 300)
$g.FillEllipse($deco, -90, 470, 260, 260)
$deco2 = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(22, 255, 255, 255))
$g.FillEllipse($deco2, 520, 470, 180, 180)

# 卡片（含柔和阴影）
$shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(52, 15, 23, 42))
$sp = New-RoundPath 116 130 568 386 44
$g.FillPath($shadow, $sp)
$card = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$cp = New-RoundPath 110 118 568 386 44
$g.FillPath($card, $cp)

# 图示方块
$gradRect = New-Object System.Drawing.Rectangle(150, 158, 112, 112)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($gradRect, $c1, $c2, 45)
$ip = New-RoundPath 150 158 112 112 30
$g.FillPath($grad, $ip)
$iconFont = New-Object System.Drawing.Font('Microsoft YaHei', 52, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('問', $iconFont, $white, (New-Object System.Drawing.RectangleF(150, 158, 112, 112)), $sf)

# 标题与副标
$ink = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#1E1B4B'))
$gray = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#6B7280'))
$titleFont = New-Object System.Drawing.Font('Microsoft YaHei', 44, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subFont = New-Object System.Drawing.Font('Microsoft YaHei', 24, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('群公告問卷', $titleFont, $ink, 292, 178)
$g.DrawString('5W1H 公告確認 · 一分鐘完成', $subFont, $gray, 296, 238)

# 清单示意
function New-LinePen([string]$hex) {
  $pen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml($hex), 22)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  return $pen
}
$grayLine = '#E8ECF4'
$g.DrawLine((New-LinePen $grayLine), 166, 330, 622, 330)
$g.DrawLine((New-LinePen $grayLine), 166, 388, 560, 388)
$g.DrawLine((New-LinePen $grayLine), 166, 446, 600, 446)
$g.DrawLine((New-LinePen '#4F46E5'), 166, 330, 470, 330)

# 小绿勾
$green = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#10B981'))
$g.FillEllipse($green, 622, 314, 32, 32)
$check = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 5)
$check.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$check.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($check, 630, 330, 636, 336)
$g.DrawLine($check, 636, 336, 646, 323)

# 底部提示
$bottom = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 255, 255, 255))
$footFont = New-Object System.Drawing.Font('Microsoft YaHei', 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$sf2 = New-Object System.Drawing.StringFormat
$sf2.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('點擊卡片，進入作答', $footFont, $bottom, (New-Object System.Drawing.RectangleF(0, 566, 800, 40)), $sf2)

$dir = Split-Path $out -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$len = (Get-Item $out).Length
Write-Output ("已生成 {0}（{1} KB）" -f $out, [int]($len / 1024))
