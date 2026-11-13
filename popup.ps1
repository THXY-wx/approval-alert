# DeepSeek Harness alert card.
#
# Launched by the `approval-alert` Host plugin once per card. Everything rendered
# here arrives through DSH_ALERT_* environment variables, so no model text ever
# passes through a command line. The process owns no state: it exits when the
# card is dismissed, when the reason disappears (the Host kills it), when the
# Host process disappears, when the user returns to Harness, or after the
# optional auto-close delay.

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    exit 1
}

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

function Get-EnvText([string] $name, [string] $fallback) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $fallback }
    return $value.Trim()
}

function Get-EnvInt([string] $name, [int] $fallback) {
    $raw = [Environment]::GetEnvironmentVariable($name)
    $parsed = 0
    if ([int]::TryParse($raw, [ref] $parsed)) { return $parsed }
    return $fallback
}

$title         = Get-EnvText 'DSH_ALERT_TITLE' 'Approval needed'
$kind          = Get-EnvText 'DSH_ALERT_KIND' 'approval'
$headline      = Get-EnvText 'DSH_ALERT_HEADLINE' 'DeepSeek Harness needs your attention'
$detail        = Get-EnvText 'DSH_ALERT_DETAIL' 'Switch to DeepSeek Harness to handle this request'
$hint          = Get-EnvText 'DSH_ALERT_HINT' ''
$action        = Get-EnvText 'DSH_ALERT_ACTION' 'Open Harness'
$sound         = (Get-EnvText 'DSH_ALERT_SOUND' '1') -eq '1'
$timeout       = Get-EnvInt 'DSH_ALERT_TIMEOUT' 0
$ownerPid      = Get-EnvInt 'DSH_ALERT_OWNER_PID' 0
$index         = [Math]::Max(0, (Get-EnvInt 'DSH_ALERT_INDEX' 0))
$closeOnFocus  = (Get-EnvText 'DSH_ALERT_CLOSE_ON_FOCUS' '0') -eq '1'

if ($title.Length -gt 60) { $title = $title.Substring(0, 57) + '...' }
$detail = ($detail -replace '\s+', ' ').Trim()
if ($detail.Length -gt 150) { $detail = $detail.Substring(0, 147) + '...' }

# ---------------------------------------------------------------------------
# Theme: follow the Windows app theme so the card looks native in both modes.
# ---------------------------------------------------------------------------

$light = $false
try {
    $personalize = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
    $light = ($personalize.AppsUseLightTheme -eq 1)
} catch {
    $light = $false
}

function Get-Color([string] $lightValue, [string] $darkValue) {
    if ($light) { return [System.Drawing.ColorTranslator]::FromHtml($lightValue) }
    return [System.Drawing.ColorTranslator]::FromHtml($darkValue)
}

$borderColor = Get-Color '#D0D7DE' '#3C4043'
$cardColor   = Get-Color '#FFFFFF' '#202124'
$titleColor  = Get-Color '#1F2328' '#F1F3F4'
$bodyColor   = Get-Color '#24292F' '#DADCE0'
$mutedColor  = Get-Color '#57606A' '#9AA0A6'
$accentColor = Get-Color '#E8710A' '#F9AB00'
$buttonText  = Get-Color '#FFFFFF' '#202124'

# ---------------------------------------------------------------------------
# Native helpers: a form that does not steal focus, and window activation by
# process id. `AppActivate` is refused when the caller is not the foreground
# window, so the button uses the same `SwitchToThisWindow` the taskbar uses.
# ---------------------------------------------------------------------------

$formType = [System.Windows.Forms.Form]
try {
    if (-not ('DshApprovalAlertForm' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Windows.Forms;

public sealed class DshApprovalAlertForm : Form
{
    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }
}
'@ -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -ErrorAction Stop
    }
    $formType = [DshApprovalAlertForm]
} catch {
    # Without the subclass the card still works; it simply takes focus once.
    $formType = [System.Windows.Forms.Form]
}

$canSwitch = $false
try {
    if (-not ('DshAlertActivate' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DshAlertActivate
{
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumProc cb, IntPtr l);

    [DllImport("user32.dll")]
    static extern int GetWindowText(IntPtr h, StringBuilder s, int n);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr h);

    [DllImport("user32.dll")]
    static extern int GetWindowThreadProcessId(IntPtr h, out int pid);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern void SwitchToThisWindow(IntPtr h, bool altTab);

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr h);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr h, int cmd);

    /// Every top-level window with a non-empty title, as
    /// "handle\tpid\tvisible\ticonic\ttitle". Hidden windows are included on
    /// purpose: Harness may be sitting in the tray while the card is up.
    public static string[] ListWindows()
    {
        var rows = new System.Collections.Generic.List<string>();
        EnumWindows((h, l) =>
        {
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            if (sb.Length == 0) return true;
            int pid = 0;
            GetWindowThreadProcessId(h, out pid);
            rows.Add(h.ToInt64().ToString() + "\t" + pid.ToString() + "\t"
                + (IsWindowVisible(h) ? "1" : "0") + "\t" + (IsIconic(h) ? "1" : "0")
                + "\t" + sb.ToString());
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }

    public static int ForegroundPid()
    {
        int pid = 0;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return pid;
    }
}
'@ -ErrorAction Stop
    }
    $canSwitch = $true
} catch {
    $canSwitch = $false
}

# ---------------------------------------------------------------------------
# Locate the Harness window. The Host process is not necessarily the window
# owner (the desktop build may run the host in a child process), so the pid is
# only a hint: the window title and the process name are the fallbacks.
# ---------------------------------------------------------------------------

$appTitlePart = 'DeepSeek Harness'
$appProcessName = 'DeepSeek Harness'

function Find-AppWindow {
    param([string[]] $Rows, [int] $WantPid, [string] $TitlePart, [string] $ProcessName)

    $pidVisible = $null
    $pidHidden = $null
    $appVisible = $null
    $appHidden = $null
    $titleVisible = $null
    $titleHidden = $null

    foreach ($row in $Rows) {
        $fields = $row -split "`t"
        if ($fields.Count -lt 5) { continue }
        $entry = @{
            Handle  = [IntPtr][long]$fields[0]
            Pid     = [int]$fields[1]
            Visible = $fields[2] -eq '1'
            Iconic  = $fields[3] -eq '1'
            Title   = $fields[4]
        }
        if ($WantPid -gt 0 -and $entry.Pid -eq $WantPid) {
            if ($entry.Visible -and $null -eq $pidVisible) { $pidVisible = $entry }
            elseif (-not $entry.Visible -and $null -eq $pidHidden) { $pidHidden = $entry }
        }
        if ($entry.Title -like "*$TitlePart*") {
            # A browser tab can carry the same words in its title, so a matching
            # title only wins outright when the owning process is Harness itself.
            $isApp = $false
            try {
                $isApp = ((Get-Process -Id $entry.Pid -ErrorAction Stop).ProcessName -eq $ProcessName)
            } catch {
                $isApp = $false
            }
            if ($isApp) {
                if ($entry.Visible -and $null -eq $appVisible) { $appVisible = $entry }
                elseif (-not $entry.Visible -and $null -eq $appHidden) { $appHidden = $entry }
            } else {
                if ($entry.Visible -and $null -eq $titleVisible) { $titleVisible = $entry }
                elseif (-not $entry.Visible -and $null -eq $titleHidden) { $titleHidden = $entry }
            }
        }
    }

    if ($null -ne $pidVisible) { $pidVisible.Why = 'owner-pid'; return $pidVisible }
    if ($null -ne $appVisible) { $appVisible.Why = 'app-process'; return $appVisible }
    if ($null -ne $pidHidden) { $pidHidden.Why = 'owner-pid-hidden'; return $pidHidden }
    if ($null -ne $appHidden) { $appHidden.Why = 'app-process-hidden'; return $appHidden }
    if ($null -ne $titleVisible) { $titleVisible.Why = 'window-title'; return $titleVisible }
    if ($null -ne $titleHidden) { $titleHidden.Why = 'window-title-hidden'; return $titleHidden }
    return $null
}

$rows = @()
$target = $null
if ($canSwitch) {
    try {
        $rows = [DshAlertActivate]::ListWindows()
        $target = Find-AppWindow -Rows $rows -WantPid $ownerPid -TitlePart $appTitlePart -ProcessName $appProcessName
    } catch {
        $target = $null
    }
}
if ($null -eq $target) {
    try {
        $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($null -ne $proc) {
            $target = @{
                Handle  = [IntPtr]$proc.MainWindowHandle
                Pid     = $proc.Id
                Visible = $true
                Iconic  = $false
                Title   = $proc.MainWindowTitle
                Why     = 'process-name'
            }
        }
    } catch {
        $target = $null
    }
}

$appFocused = $false
if ($canSwitch) {
    try {
        $foreground = [DshAlertActivate]::ForegroundPid()
        $appFocused = ($ownerPid -gt 0 -and $foreground -eq $ownerPid) -or
            ($null -ne $target -and $foreground -eq $target.Pid)
    } catch {
        $appFocused = $false
    }
}

# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

$form = [Activator]::CreateInstance($formType)
$form.Text = $title
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.KeyPreview = $true
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
$form.Width = 420
$form.Height = 152
$form.BackColor = $borderColor
$form.Padding = New-Object System.Windows.Forms.Padding(1)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$card = New-Object System.Windows.Forms.Panel
$card.Dock = [System.Windows.Forms.DockStyle]::Fill
$card.BackColor = $cardColor
$form.Controls.Add($card)

$bar = New-Object System.Windows.Forms.Panel
$bar.Dock = [System.Windows.Forms.DockStyle]::Left
$bar.Width = 4
$bar.BackColor = $accentColor
$card.Controls.Add($bar)

function Add-Label($parent, [string] $text, [int] $x, [int] $y, [int] $width, [int] $height, $font, $color) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $text
    $label.Location = New-Object System.Drawing.Point($x, $y)
    $label.Size = New-Object System.Drawing.Size($width, $height)
    $label.AutoSize = $false
    $label.AutoEllipsis = $true
    $label.UseMnemonic = $false
    $label.BackColor = [System.Drawing.Color]::Transparent
    $label.Font = $font
    $label.ForeColor = $color
    $parent.Controls.Add($label)
    return $label
}

$titleFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$bodyFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$hintFont = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)

Add-Label $card $title 24 14 320 26 $titleFont $titleColor | Out-Null
Add-Label $card $headline 24 48 372 22 $bodyFont $bodyColor | Out-Null
Add-Label $card $detail 24 72 372 22 $bodyFont $mutedColor | Out-Null

$hintLabel = $null
if ($hint.Length -gt 0) {
    $hintLabel = Add-Label $card $hint 24 108 244 18 $hintFont $mutedColor
}

$close = Add-Label $card 'X' 384 8 24 24 $titleFont $mutedColor
$close.Cursor = [System.Windows.Forms.Cursors]::Hand
$close.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$close.Add_Click({ $form.Close() })

$open = New-Object System.Windows.Forms.Button
$open.Text = $action
$open.Location = New-Object System.Drawing.Point(284, 100)
$open.Size = New-Object System.Drawing.Size(120, 30)
$open.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$open.FlatAppearance.BorderSize = 0
$open.BackColor = $accentColor
$open.ForeColor = $buttonText
$open.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$open.Cursor = [System.Windows.Forms.Cursors]::Hand
function Invoke-ActivateHarness {
    $result = @{ Activated = $false; Why = 'none' }

    if ($null -ne $target) {
        try {
            if ($target.Iconic -or -not $target.Visible) {
                # SW_RESTORE also reveals a window that is hidden in the tray.
                [DshAlertActivate]::ShowWindow($target.Handle, 9) | Out-Null
            }
            [DshAlertActivate]::SwitchToThisWindow($target.Handle, $true)
            Start-Sleep -Milliseconds 250
            if ([DshAlertActivate]::ForegroundPid() -eq $target.Pid) {
                $result.Activated = $true
                $result.Why = $target.Why
                return $result
            }
        } catch {
            $result.Why = 'switch-failed'
        }
    }

    if ($ownerPid -gt 0 -and $canSwitch) {
        try {
            # Activate the window-owning process, not the Host process: the
            # desktop build may run the host as a child without a window.
            $activatePid = if ($null -ne $target) { $target.Pid } else { $ownerPid }
            Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction Stop
            [Microsoft.VisualBasic.Interaction]::AppActivate($activatePid) | Out-Null
            Start-Sleep -Milliseconds 200
            if ([DshAlertActivate]::ForegroundPid() -eq $activatePid) {
                $result.Activated = $true
                $result.Why = 'appactivate'
            }
        } catch {
            # Nothing else to try; the caller reports the failure on the card.
        }
    }

    return $result
}

$open.Add_Click({
    $attempt = Invoke-ActivateHarness
    if ($attempt.Activated) {
        $form.Close()
    } elseif ($null -ne $hintLabel) {
        # Keep the card: a silent disappearance would look like a dead button.
        $hintLabel.Text = 'Harness window not found - open it from the taskbar'
        $hintLabel.ForeColor = $accentColor
    }
})
$card.Controls.Add($open)

$form.Add_KeyDown({
    if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { $form.Close() }
})

# ---------------------------------------------------------------------------
# Placement: bottom-right of the screen holding the pointer, stacked upward for
# additional cards.
# ---------------------------------------------------------------------------

$form.Add_Load({
    $screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position)
    if ($null -eq $screen) { $screen = [System.Windows.Forms.Screen]::PrimaryScreen }
    $area = $screen.WorkingArea
    $x = $area.Right - $form.Width - 24
    $y = $area.Bottom - $form.Height - 24 - ($index * ($form.Height + 12))
    if ($y -lt ($area.Top + 8)) { $y = $area.Top + 8 }
    $form.Location = New-Object System.Drawing.Point($x, $y)
})

# ---------------------------------------------------------------------------
# Signals: a chime on appearance, an optional auto-close, a "you are back"
# dismissal, and a watchdog that takes the card down when the Host is gone.
# ---------------------------------------------------------------------------

$form.Add_Shown({
    # An answer card is redundant noise while the user is already in Harness, so
    # it stays silent there instead of chiming for every turn of a conversation.
    $quiet = ($kind -eq 'finished') -and $appFocused
    if ($sound -and -not $quiet) {
        try { [System.Media.SystemSounds]::Exclamation.Play() } catch { }
    }
})

if ($timeout -gt 0) {
    $closeTimer = New-Object System.Windows.Forms.Timer
    $closeTimer.Interval = [Math]::Min($timeout * 1000, 2147483647)
    $closeTimer.Add_Tick({
        $closeTimer.Stop()
        $form.Close()
    })
    $closeTimer.Start()
}

if ($closeOnFocus -and $canSwitch -and $ownerPid -gt 0) {
    $script:focusHits = 0
    $focusTimer = New-Object System.Windows.Forms.Timer
    $focusTimer.Interval = 1200
    $focusTimer.Add_Tick({
        $current = 0
        try { $current = [DshAlertActivate]::ForegroundPid() } catch { $current = 0 }
        if ($current -eq $ownerPid) {
            $script:focusHits = $script:focusHits + 1
        } else {
            $script:focusHits = 0
        }
        if ($script:focusHits -ge 2) {
            $focusTimer.Stop()
            $form.Close()
        }
    })
    $focusTimer.Start()
}

if ($ownerPid -gt 0) {
    $watchdog = New-Object System.Windows.Forms.Timer
    $watchdog.Interval = 3000
    $watchdog.Add_Tick({
        $alive = $false
        try {
            $null = [System.Diagnostics.Process]::GetProcessById($ownerPid)
            $alive = $true
        } catch {
            $alive = $false
        }
        if (-not $alive) {
            $watchdog.Stop()
            $form.Close()
        }
    })
    $watchdog.Start()
}

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)
