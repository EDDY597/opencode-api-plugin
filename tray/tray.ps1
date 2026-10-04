# LLM Gateway tray supervisor for Windows (PowerShell + WinForms). Zero install.
# Icon presence is synced with the gateway process: icon visible = gateway running.
# Closing the tray stops the gateway; if the gateway dies the tray closes itself.
# Right-click: 重启服务 / 设置 / 退出. Hover shows OpenCode 5h/week/month quota.
# Settings dialog edits the embedded opencode2api upstream (API key, CLI path, debug).

param([switch]$SelfTest)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'SilentlyContinue'
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:Root = if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $script:Here) 'gateway.config.json')) { Split-Path -Parent $script:Here } else { $script:Here }
$script:ConfigPath = Join-Path $script:Root 'gateway.config.json'

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

function Resolve-NodeExe {
  $standard = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $standard) { return $standard }
  return 'node.exe'
}

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
  if (-not (Test-Gateway)) {
    if ($script:Proc -and -not $script:Proc.HasExited) { return 'LLM Gateway：启动中...' }
    return 'LLM Gateway：未运行'
  }
  $u = Get-Usage
  if ($null -eq $u) { return 'LLM Gateway：额度读取失败' }
  if ((-not $u.entries -or @($u.entries).Count -eq 0) -and $u.errors -and @($u.errors).Count -gt 0) {
    $code = [string]$u.errors[0].code
    if ($u.errors[0].message -match 'subscription required' -or $code -eq 'UNKNOWN') {
      if ([string]$u.errors[0].message -match 'subscription required') { return 'LLM Gateway：额度需 OpenCode Go 订阅' }
    }
    return 'LLM Gateway：额度错误 ' + $code
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

function New-GatewayIcon([bool]$healthy) {
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $ringColor = if ($healthy) { [System.Drawing.Color]::FromArgb(255, 34, 197, 94) } else { [System.Drawing.Color]::FromArgb(255, 120, 123, 134) }
  $chevronColor = if ($healthy) { [System.Drawing.Color]::FromArgb(255, 74, 222, 128) } else { [System.Drawing.Color]::FromArgb(255, 170, 173, 184) }
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 11, 18, 32))
  $g.FillEllipse($bg, 1, 1, $size - 3, $size - 3)
  $ring = New-Object System.Drawing.Pen ($ringColor, 1.5)
  $g.DrawEllipse($ring, 1, 1, $size - 3, $size - 3)
  $pen = New-Object System.Drawing.Pen ($chevronColor, 3)
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

# --- gateway process supervision ---------------------------------------------

$script:Proc = $null

function Stop-GatewayProcess {
  if ($script:Proc -and -not $script:Proc.HasExited) {
    Start-Process -FilePath 'taskkill' -ArgumentList '/F', '/T', '/PID', $script:Proc.Id -WindowStyle Hidden -Wait
  } else {
    # Attached to an externally started gateway: stop whatever listens on the port.
    $port = Get-Port
    $pids = @()
    try {
      $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
      if ($conns) { $pids = @($conns | Select-Object -ExpandProperty OwningProcess -Unique) }
    } catch {
      $lines = netstat -ano | Select-String (':' + $port + '\s')
      foreach ($line in $lines) {
        if ($line -match '\s(\d+)\s*$') { $pids += [int]$Matches[1] }
      }
    }
    foreach ($p in $pids) { if ($p -and $p -ne $PID) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }
  }
  $script:Proc = $null
}

function Start-GatewayProcess {
  if (Test-Gateway) { return $true }  # already running (externally) — attach
  $script:Proc = Start-Process -FilePath (Resolve-NodeExe) `
    -ArgumentList ('"' + (Join-Path $script:Root 'src\standalone.ts') + '"') `
    -WorkingDirectory $script:Root -WindowStyle Hidden -PassThru
  return $false  # readiness is picked up by the monitor timer
}

function Restart-Gateway {
  Stop-GatewayProcess
  Start-Sleep -Milliseconds 800
  Start-GatewayProcess | Out-Null
}

function Quit-All([bool]$stopGateway) {
  if ($stopGateway) { Stop-GatewayProcess }
  $script:Monitor.Stop()
  $script:UsageTimer.Stop()
  $script:Notify.Visible = $false
  $script:Notify.Dispose()
  [System.Windows.Forms.Application]::ExitThread()
}

# --- settings dialog ----------------------------------------------------------

function Show-Settings {
  $cfg = $null
  if (Test-Path -LiteralPath $script:ConfigPath) {
    try { $cfg = Get-Content -LiteralPath $script:ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
  }
  if (-not $cfg) { $cfg = New-Object psobject }
  if (-not $cfg.upstreams) { $cfg | Add-Member -NotePropertyName upstreams -NotePropertyValue @() -Force }
  if ($cfg.upstreams -isnot [array]) { $cfg.upstreams = @($cfg.upstreams) }

  $up = @($cfg.upstreams | Where-Object { $_.type -eq 'opencode2api' } | Select-Object -First 1)
  if (-not $up -or @($up).Count -eq 0) {
    [System.Windows.Forms.MessageBox]::Show('配置中没有嵌入式上游（type: "opencode2api"），无可设置项。', 'LLM Gateway 设置', 'OK', 'Warning') | Out-Null
    return
  }
  $script:DlgUp = $up[0]
  $script:DlgCfg = $cfg

  # Controls live in script scope: event handlers fire after this function's
  # local scope is gone, so function-locals would resolve to $null.
  $script:DlgForm = New-Object System.Windows.Forms.Form
  $script:DlgForm.Text = 'LLM Gateway 设置'
  $script:DlgForm.Size = New-Object System.Drawing.Size(480, 250)
  $script:DlgForm.FormBorderStyle = 'FixedDialog'
  $script:DlgForm.MaximizeBox = $false
  $script:DlgForm.StartPosition = 'CenterScreen'

  $lbKey = New-Object System.Windows.Forms.Label
  $lbKey.Text = 'OpenCode API Key（Zen 密钥 oc_sk_...）'
  $lbKey.Location = New-Object System.Drawing.Point(12, 12); $lbKey.AutoSize = $true
  $script:DlgForm.Controls.Add($lbKey)

  $script:DlgKey = New-Object System.Windows.Forms.TextBox
  $script:DlgKey.Location = New-Object System.Drawing.Point(12, 34)
  $script:DlgKey.Size = New-Object System.Drawing.Size(380, 23)
  $script:DlgKey.UseSystemPasswordChar = $true
  $script:DlgKey.Text = [string]$script:DlgUp.zenApiKey
  $script:DlgForm.Controls.Add($script:DlgKey)

  $script:DlgShow = New-Object System.Windows.Forms.CheckBox
  $script:DlgShow.Text = '显示'; $script:DlgShow.AutoSize = $true
  $script:DlgShow.Location = New-Object System.Drawing.Point(398, 36)
  $script:DlgShow.Add_CheckedChanged({ $script:DlgKey.UseSystemPasswordChar = (-not $script:DlgShow.Checked) })
  $script:DlgForm.Controls.Add($script:DlgShow)

  $lbPath = New-Object System.Windows.Forms.Label
  $lbPath.Text = 'opencode 可执行文件路径（留空 = 自动搜索 PATH）'
  $lbPath.Location = New-Object System.Drawing.Point(12, 68); $lbPath.AutoSize = $true
  $script:DlgForm.Controls.Add($lbPath)

  $script:DlgPath = New-Object System.Windows.Forms.TextBox
  $script:DlgPath.Location = New-Object System.Drawing.Point(12, 90)
  $script:DlgPath.Size = New-Object System.Drawing.Size(440, 23)
  $script:DlgPath.Text = [string]$script:DlgUp.opencodePath
  $script:DlgForm.Controls.Add($script:DlgPath)

  $script:DlgDebug = New-Object System.Windows.Forms.CheckBox
  $script:DlgDebug.Text = '调试日志'; $script:DlgDebug.AutoSize = $true
  $script:DlgDebug.Location = New-Object System.Drawing.Point(12, 122)
  $script:DlgDebug.Checked = ([string]$script:DlgUp.debug -eq 'true' -or $script:DlgUp.debug -eq $true)
  $script:DlgForm.Controls.Add($script:DlgDebug)

  $lbHint = New-Object System.Windows.Forms.Label
  $lbHint.Text = '保存后自动重启网关使配置生效。'
  $lbHint.Location = New-Object System.Drawing.Point(12, 150); $lbHint.AutoSize = $true
  $lbHint.ForeColor = [System.Drawing.Color]::Gray
  $script:DlgForm.Controls.Add($lbHint)

  $btnSave = New-Object System.Windows.Forms.Button
  $btnSave.Text = '保存并重启'
  $btnSave.Location = New-Object System.Drawing.Point(280, 180)
  $btnSave.Size = New-Object System.Drawing.Size(110, 28)
  $script:DlgForm.Controls.Add($btnSave)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = '取消'
  $btnCancel.Location = New-Object System.Drawing.Point(160, 180)
  $btnCancel.Size = New-Object System.Drawing.Size(90, 28)
  $btnCancel.DialogResult = 'Cancel'
  $script:DlgForm.Controls.Add($btnCancel)

  $btnSave.Add_Click({
      $key = $script:DlgKey.Text.Trim()
      $path = $script:DlgPath.Text.Trim()
      $script:DlgUp | Add-Member -NotePropertyName zenApiKey -NotePropertyValue $key -Force
      $script:DlgUp | Add-Member -NotePropertyName opencodePath -NotePropertyValue $(if ($path) { $path } else { 'opencode' }) -Force
      $script:DlgUp | Add-Member -NotePropertyName debug -NotePropertyValue [bool]$script:DlgDebug.Checked -Force

      # Guard: PS 5.1 unwraps single-element arrays on ConvertFrom-Json.
      if ($script:DlgCfg.upstreams -isnot [array]) { $script:DlgCfg.upstreams = @($script:DlgCfg.upstreams) }
      $json = $script:DlgCfg | ConvertTo-Json -Depth 12
      [System.IO.File]::WriteAllText($script:ConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
      $script:DlgForm.DialogResult = 'OK'
      $script:DlgForm.Close()
    })

  if ($script:DlgForm.ShowDialog() -eq 'OK') { Restart-Gateway }
}

# --- tray UI ------------------------------------------------------------------

if ($SelfTest) {
  Write-Output ('root=' + $script:Root)
  Write-Output ('base=' + (Get-Base))
  Write-Output ('gateway=' + (Test-Gateway))
  Write-Output ('tooltip=' + (Build-Tooltip))
  Write-Output ('icon=' + (New-GatewayIcon $true).Size)
  exit 0
}

$script:IconOn = New-GatewayIcon $true
$script:IconOff = New-GatewayIcon $false

$script:Notify = New-Object System.Windows.Forms.NotifyIcon
$script:Notify.Icon = $script:IconOff
$script:Notify.Visible = $true
$script:Notify.Text = 'LLM Gateway'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miRestart = $menu.Items.Add('重启服务')
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$miSettings = $menu.Items.Add('设置...')
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$miExit = $menu.Items.Add('退出')
$miRestart.Add_Click({
    $miRestart.Enabled = $false
    Restart-Gateway
    $miRestart.Enabled = $true
    Update-Tray
  })
$miSettings.Add_Click({ Show-Settings; Update-Tray })
$miExit.Add_Click({ Quit-All $true })
$script:Notify.ContextMenuStrip = $menu

function Update-Tray {
  if ($script:Notify) {
    $script:Notify.Text = Build-Tooltip
    $healthy = Test-Gateway
    $script:Notify.Icon = if ($healthy) { $script:IconOn } else { $script:IconOff }
  }
}

# Startup: attach to a running gateway or spawn one.
if (-not (Test-Gateway)) {
  Start-GatewayProcess | Out-Null
  Write-Host 'LLM Gateway: spawning gateway process...'
} else {
  Write-Host 'LLM Gateway: attaching to running gateway...'
}

# Monitor (3s): icon state syncs with the gateway process. If the gateway dies
# for good, the tray closes itself so the icon never lies about the process.
$script:FailStreak = 0
$script:Monitor = New-Object System.Windows.Forms.Timer
$script:Monitor.Interval = 3000
$script:Monitor.Add_Tick({
    try {
      if ($script:Proc -and $script:Proc.HasExited) {
        $script:Monitor.Stop()
        $script:Notify.ShowBalloonTip(4000, 'LLM Gateway', '网关进程已退出，托盘随之关闭', [System.Windows.Forms.ToolTipIcon]::Warning)
        $script:QuitTimer = New-Object System.Windows.Forms.Timer
        $script:QuitTimer.Interval = 1200
        $script:QuitTimer.Add_Tick({ $script:QuitTimer.Stop(); Quit-All $false })
        $script:QuitTimer.Start()
        return
      }
      if (Test-Gateway) {
        $script:FailStreak = 0
        $script:Notify.Icon = $script:IconOn
      } else {
        $script:FailStreak += 1
        $script:Notify.Icon = $script:IconOff
        if (-not $script:Proc -and $script:FailStreak -ge 2) {
          # Attached external gateway is gone — keep icon presence in sync.
          $script:Monitor.Stop()
          $script:Notify.ShowBalloonTip(4000, 'LLM Gateway', '网关已停止，托盘随之关闭', [System.Windows.Forms.ToolTipIcon]::Warning)
          $script:QuitTimer = New-Object System.Windows.Forms.Timer
          $script:QuitTimer.Interval = 1200
          $script:QuitTimer.Add_Tick({ $script:QuitTimer.Stop(); Quit-All $false })
          $script:QuitTimer.Start()
          return
        }
      }
      Update-Tray
    } catch { }
  })
$script:Monitor.Start()

# Usage/tooltip refresh (60s): OpenCode 5h / week / month balance.
$script:UsageTimer = New-Object System.Windows.Forms.Timer
$script:UsageTimer.Interval = 60000
$script:UsageTimer.Add_Tick({ Update-Tray })
$script:UsageTimer.Start()

Update-Tray

$ctx = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($ctx)
$script:Notify.Visible = $false
$script:Notify.Dispose()
