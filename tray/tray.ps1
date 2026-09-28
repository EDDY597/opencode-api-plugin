# LLM Gateway tray for Windows (PowerShell + WinForms). Zero install.
# Hover shows quota. Right-click: 刷新额度 / 退出.

param([switch]$SelfTest)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'SilentlyContinue'
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:Root = if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $script:Here) 'gateway.config.json')) { Split-Path -Parent $script:Here } else { $script:Here }
$script:ConfigPath = Join-Path $script:Root 'gateway.config.json'
$script:Timer = $null
$script:Notify = $null

function Get-Port {
  if (Test-Path -LiteralPath $script:ConfigPath) {
    try {
      $cfg = Get-Content -LiteralPath $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.port) { return [int]$cfg.port }
    } catch { }
  }
  return 8787
}

function Get-Base { return ('http://127.0.0.1:' + (Get-Port)) }

function Test-Gateway {
  try { Invoke-RestMethod -Uri ((Get-Base) + '/health') -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}

function Get-Usage {
  try { return Invoke-RestMethod -Uri ((Get-Base) + '/api/usage') -TimeoutSec 10 } catch { return $null }
}

function Period-Label($p) {
  switch ($p) { 'rolling' { '5h' } 'weekly' { '周' } 'monthly' { '月' } default { $p } }
}

function Format-Reset($iso) {
  try {
    $d = [datetime]::Parse($iso).ToLocalTime()
    if ($d.Date -eq (Get-Date).Date) { return $d.ToString('HH:mm') }
    return $d.ToString('MM-dd HH:mm')
  } catch { return [string]$iso }
}

function Build-Tooltip {
  if (-not (Test-Gateway)) { return 'LLM Gateway：未运行' }
  $u = Get-Usage
  if ($null -eq $u) { return 'LLM Gateway：额度读取失败' }
  if ((-not $u.entries -or $u.entries.Count -eq 0) -and $u.errors -and $u.errors.Count -gt 0) {
    return 'LLM Gateway：额度错误 ' + $u.errors[0].code
  }
  $entries = @($u.entries)
  $names = @($entries | Select-Object -ExpandProperty name -Unique)
  $header = if ($names.Count -eq 1) { [string]$names[0] } else { 'LLM Gateway' }
  $lines = @($header)
  foreach ($e in $entries) {
    $lines += ('{0} {1}% {2}' -f (Period-Label $e.period), [int]$e.remaining, (Format-Reset $e.resetAt))
  }
  $text = $lines -join [Environment]::NewLine
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  return $text
}

function New-GatewayIcon {
  $custom = Join-Path $script:Here 'tray.ico'
  if (Test-Path -LiteralPath $custom) {
    try { return (New-Object System.Drawing.Icon($custom)) } catch { }
  }
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 11, 18, 32))
  $g.FillEllipse($bg, 1, 1, $size - 3, $size - 3)
  $ring = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 34, 197, 94), 1.5)
  $g.DrawEllipse($ring, 1, 1, $size - 3, $size - 3)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 74, 222, 128), 3)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $chevron = @(
    (New-Object System.Drawing.Point(11, 9)),
    (New-Object System.Drawing.Point(16, 16)),
    (New-Object System.Drawing.Point(11, 23))
  )
  $g.DrawLines($pen, $chevron)
  $g.DrawLine($pen, 18, 23, 24, 23)
  $g.Dispose(); $bg.Dispose(); $ring.Dispose(); $pen.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

function Update-Tray {
  if ($script:Notify) { $script:Notify.Text = Build-Tooltip }
}

if ($SelfTest) {
  Write-Output ('root=' + $script:Root)
  Write-Output ('base=' + (Get-Base))
  Write-Output ('gateway=' + (Test-Gateway))
  Write-Output ('tooltip=' + (Build-Tooltip))
  Write-Output ('icon=' + (New-GatewayIcon).Size)
  exit 0
}

$script:Notify = New-Object System.Windows.Forms.NotifyIcon
$script:Notify.Icon = New-GatewayIcon
$script:Notify.Visible = $true
$script:Notify.Text = 'LLM Gateway'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miRefresh = $menu.Items.Add('刷新额度')
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$miExit = $menu.Items.Add('退出')
$miRefresh.Add_Click({ Update-Tray })
$miExit.Add_Click({
  $script:Notify.Visible = $false
  [System.Windows.Forms.Application]::ExitThread()
})
$script:Notify.ContextMenuStrip = $menu

Update-Tray

$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 60000
$script:Timer.Add_Tick({ Update-Tray })
$script:Timer.Start()

$ctx = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($ctx)
$script:Notify.Visible = $false
$script:Notify.Dispose()
