<#
    JARVIS Node Agent — Windows

    The counterpart to jarvis-agent.sh, speaking the same protocol. Written in Windows
    PowerShell 5.1 because that ships with every supported Windows and needs no install,
    and because a script piped from the network never meets SmartScreen the way a
    PyInstaller .exe does. See DEVIATIONS.md D1.

        iwr http://10.42.0.1:3000/join.ps1 -UseBasicParsing | iex

    Or, with arguments:

        powershell -ExecutionPolicy Bypass -File jarvis-agent.ps1 -Node BETA -Token <TOKEN>

    Per SPEC.md §15 this does not need parity with macOS. Each capability is probed and
    advertised only if it actually works, so a machine without speech simply never
    receives a speak command.
#>

# No [CmdletBinding()] on purpose: it turns this into an advanced script, and advanced
# scripts do not receive $args — which is the only way the `iex` form can pass anything.
param(
    [string]$Node = $env:JARVIS_NODE,
    [string]$Token = $env:JARVIS_TOKEN,
    [string]$Server = '@@CORE_URL@@'
)

$ErrorActionPreference = 'Stop'
$AgentVersion = '1.0.0'

# Left unreplaced when the file is run straight from a checkout rather than served by Core.
if ($Server -like '@@*') { $Server = 'http://10.42.0.1:3000' }

# ---------------------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------------------

# `iex` gives no way to pass parameters, so the piped form reads them from the environment:
#   $env:JARVIS_NODE='BETA'; $env:JARVIS_TOKEN='...'; iwr .../join.ps1 -UseBasicParsing | iex
if (-not $Node -and $args -and $args.Count -ge 1) { $Node = $args[0] }
if (-not $Token -and $args -and $args.Count -ge 2) { $Token = $args[1] }

if (-not $Node) {
    Write-Host ''
    Write-Host '  JARVIS Node Agent' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '    $env:JARVIS_NODE  = "BETA"'
    Write-Host '    $env:JARVIS_TOKEN = "<token>"'
    Write-Host "    iwr $Server/join.ps1 -UseBasicParsing | iex"
    Write-Host ''
    return
}

if (-not $Token) {
    $secure = Read-Host -Prompt "Token for $Node" -AsSecureString
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$Node = $Node.ToUpper()
$Server = $Server.TrimEnd('/')

# ---------------------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------------------

$script:SessionId = $null
$script:OverlayProcess = $null
$script:HeartbeatRunspace = $null
$script:HeartbeatShell = $null
$script:HeartbeatMs = 5000
$script:Running = $true

# Shared with the heartbeat runspace, which runs concurrently and cannot see $script: state
# from this one. A synchronized hashtable is the supported way to pass live values across a
# runspace boundary; without it the heartbeat can only report a hardcoded overlay flag and
# the Command Wall never shows a Windows node as having an overlay up.
$script:Shared = [hashtable]::Synchronized(@{ Overlay = '0' })

# Unique to this run. A dedicated --user-data-dir forces a separate browser process tree,
# so terminating the overlay cannot disturb the tabs the user already had open — the
# reliability requirement in SPEC.md §16.
$script:OverlayProfile = Join-Path $env:TEMP ("jarvis-overlay-" + [Guid]::NewGuid().ToString('N'))

function Write-Log($message) {
    Write-Host ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $message)
}

# ---------------------------------------------------------------------------------------
# Wire decoding
# ---------------------------------------------------------------------------------------

# Core percent-encodes every byte outside the RFC 3986 unreserved set, so this is the whole
# agent-side protocol. UnescapeDataString decodes UTF-8 percent sequences correctly, which
# matters for any speech text that is not plain ASCII.
function Convert-FromWire([string]$value) {
    if ([string]::IsNullOrEmpty($value)) { return '' }
    return [System.Uri]::UnescapeDataString($value)
}

# ---------------------------------------------------------------------------------------
# Capability probing
# ---------------------------------------------------------------------------------------

# Edge first: it is present on every supported Windows, so the overlay works with nothing
# installed. Chrome is preferred only if the operator has standardised on it.
function Find-Browser {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($path in $candidates) {
        if ($path -and (Test-Path $path)) { return $path }
    }
    return $null
}

$script:Browser = Find-Browser

# Speech is probed by actually constructing the synthesiser. Server editions of Windows
# ship without the assembly, and discovering that when the presenter asks JARVIS to talk is
# too late.
$script:Speech = $null
try {
    Add-Type -AssemblyName System.Speech -ErrorAction Stop
    $script:Speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
} catch {
    $script:Speech = $null
}

# Absolute volume needs the Core Audio API, which has no PowerShell surface. This is the
# minimum P/Invoke that reaches IAudioEndpointVolume. If it fails to compile the capability
# is simply not advertised, per SPEC.md §15.
$script:VolumeReady = $false
try {
    Add-Type -ErrorAction Stop @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int _0(); int _1(); int _2(); int _3();
    int SetMasterVolumeLevelScalar(float level, ref Guid context);
    int _5();
    int GetMasterVolumeLevelScalar(out float level);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid id, int ctx, IntPtr act, [MarshalAs(UnmanagedType.IUnknown)] out object dev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int _0();
    int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public class JarvisAudio {
    public static void SetVolume(int percent) {
        IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0, 1, out device);
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        device.Activate(ref iid, 23, IntPtr.Zero, out o);
        Guid empty = Guid.Empty;
        ((IAudioEndpointVolume)o).SetMasterVolumeLevelScalar(percent / 100f, ref empty);
    }
}
'@
    $script:VolumeReady = $true
} catch {
    $script:VolumeReady = $false
}

function Get-Capabilities {
    $caps = New-Object System.Collections.Generic.List[string]
    if ($script:Browser) {
        $caps.Add('takeover'); $caps.Add('release'); $caps.Add('identify')
    }
    $caps.Add('open_url')
    $caps.Add('open_app')
    if ($script:Speech) { $caps.Add('speak') }
    if ($script:VolumeReady) { $caps.Add('set_volume') }
    return ($caps -join ',')
}

# ---------------------------------------------------------------------------------------
# Display state — DEVIATIONS.md D3
# ---------------------------------------------------------------------------------------

# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED. Holds the display awake for as
# long as this process lives, and is released automatically when it exits. Phase 1 of the
# demo is deliberately long and a slept screen shows nothing.
try {
    Add-Type -ErrorAction Stop @'
using System;
using System.Runtime.InteropServices;
public class JarvisPower {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
    public static void KeepAwake() { SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000002); }
    public static void Release()   { SetThreadExecutionState(0x80000000); }
}
'@
    [JarvisPower]::KeepAwake()
} catch {
    Write-Log 'could not hold the display awake; disable sleep manually before the demo'
}

# LogonUI owns the screen whenever Windows is locked. The wake lock cannot unlock an
# already-locked machine, so Core is told and the wall shows it.
function Test-DisplayAwake {
    try {
        $locked = Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue
        if ($locked) { return '0' }
        return '1'
    } catch {
        return '1'
    }
}

# ---------------------------------------------------------------------------------------
# Core calls
# ---------------------------------------------------------------------------------------

function Invoke-CorePost($Path, $Fields) {
    try {
        return Invoke-RestMethod -Uri "$Server$Path" -Method Post -Body $Fields -TimeoutSec 10
    } catch {
        return $null
    }
}

function Send-Ack($CommandId, $Status, $Message) {
    Invoke-CorePost '/api/agent/ack' @{
        node = $Node; session = $script:SessionId
        cid = $CommandId; status = $Status; msg = $Message
    } | Out-Null
}

# ---------------------------------------------------------------------------------------
# Overlay
# ---------------------------------------------------------------------------------------

function Start-Overlay($Url) {
    if (-not $script:Browser) { return $false }
    if ($Url -notmatch '^https?://') {
        Write-Log 'refusing overlay URL with a disallowed scheme'
        return $false
    }

    Stop-Overlay

    $arguments = @(
        "--user-data-dir=`"$($script:OverlayProfile)`"",
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--kiosk',
        "--app=`"$Url`""
    )

    try {
        $script:OverlayProcess = Start-Process -FilePath $script:Browser -ArgumentList $arguments -PassThru
        $script:Shared.Overlay = '1'
        return $true
    } catch {
        Write-Log "could not launch the overlay: $($_.Exception.Message)"
        return $false
    }
}

function Stop-Overlay {
    $script:Shared.Overlay = '0'

    if ($script:OverlayProcess) {
        try {
            if (-not $script:OverlayProcess.HasExited) {
                Stop-Process -Id $script:OverlayProcess.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { }
        $script:OverlayProcess = $null
    }

    # Chromium's launcher process exits immediately and leaves the real browser behind, so
    # the PID alone is not enough. Matching on the profile path is exact: it is a GUID
    # unique to this run and appears in no other process's command line.
    try {
        Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($script:OverlayProfile) } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch { }

    if (Test-Path $script:OverlayProfile) {
        Remove-Item $script:OverlayProfile -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-OverlayRunning {
    if (-not $script:OverlayProcess) { return $false }
    try { return -not $script:OverlayProcess.HasExited } catch { return $false }
}

# ---------------------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------------------

# The agent's own copy of the allowlist, mirroring core/config/apps.json. Core checks first;
# this second check means a node cannot be handed an executable path even by a misconfigured
# Core. SPEC.md §13.
function Resolve-App($Name) {
    switch ($Name) {
        'chrome'     { return 'chrome.exe' }
        'edge'       { return 'msedge.exe' }
        'vscode'     { return 'code.exe' }
        'spotify'    { return 'spotify.exe' }
        'terminal'   { return 'wt.exe' }
        'calculator' { return 'calc.exe' }
        'notes'      { return 'notepad.exe' }
        default      { return $null }
    }
}

function Invoke-OpenApp($App, $CommandId) {
    $target = Resolve-App $App
    if (-not $target) { Send-Ack $CommandId 'failed' 'app not allowlisted on this node'; return }

    try {
        Start-Process -FilePath $target -ErrorAction Stop | Out-Null
        Send-Ack $CommandId 'success' "$target launched"
    } catch {
        Send-Ack $CommandId 'failed' "$target is not installed"
    }
}

function Invoke-OpenUrl($Url, $CommandId) {
    if ($Url -notmatch '^https?://') { Send-Ack $CommandId 'failed' 'scheme not allowed'; return }
    try {
        Start-Process $Url -ErrorAction Stop | Out-Null
        Send-Ack $CommandId 'success' 'opened'
    } catch {
        Send-Ack $CommandId 'failed' 'open failed'
    }
}

function Invoke-Speak($Text, $CommandId) {
    if (-not $script:Speech) { Send-Ack $CommandId 'unsupported' 'no speech on this node'; return }
    try {
        # Asynchronous: SpeakAsync returns immediately, so a long line cannot block the
        # command channel behind it.
        $script:Speech.SpeakAsync($Text) | Out-Null
        Send-Ack $CommandId 'success' 'spoken'
    } catch {
        Send-Ack $CommandId 'failed' $_.Exception.Message
    }
}

function Invoke-SetVolume($Level, $CommandId) {
    if (-not $script:VolumeReady) { Send-Ack $CommandId 'unsupported' 'no volume control'; return }

    $value = 0
    if (-not [int]::TryParse($Level, [ref]$value)) {
        Send-Ack $CommandId 'failed' 'volume must be an integer'; return
    }
    if ($value -lt 0 -or $value -gt 100) { Send-Ack $CommandId 'failed' 'volume out of range'; return }

    try {
        [JarvisAudio]::SetVolume($value)
        Send-Ack $CommandId 'success' "volume $value"
    } catch {
        Send-Ack $CommandId 'failed' $_.Exception.Message
    }
}

# ---------------------------------------------------------------------------------------
# Command handling
# ---------------------------------------------------------------------------------------

function Invoke-JarvisCommand([string]$Line) {
    $fields = $Line -split "`t"
    if ($fields.Count -lt 2) { return }

    $commandId = Convert-FromWire $fields[0]
    $action = Convert-FromWire $fields[1]

    # Named $params, not $args: $args is an automatic variable and assigning to it inside a
    # function shadows the shell's own, which is a trap for whoever edits this next.
    $params = @{}
    for ($i = 2; $i -lt $fields.Count; $i++) {
        $split = $fields[$i].IndexOf('=')
        if ($split -lt 1) { continue }
        $params[$fields[$i].Substring(0, $split)] = Convert-FromWire $fields[$i].Substring($split + 1)
    }

    switch ($action) {
        'takeover' {
            # Relative to receipt, never an absolute time: the laptops' clocks do not agree
            # and there is no NTP on JARVIS-NET. See DEVIATIONS.md D2.
            $delay = 0
            if ($params.ContainsKey('delay')) { [int]::TryParse($params['delay'], [ref]$delay) | Out-Null }
            if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }

            if (Start-Overlay $params['url']) { Send-Ack $commandId 'success' 'overlay up' }
            else { Send-Ack $commandId 'unsupported' 'no browser on this node' }
        }
        'release' {
            Stop-Overlay
            Send-Ack $commandId 'success' 'released'
        }
        'identify' {
            if ($params.ContainsKey('url')) {
                if (Start-Overlay $params['url']) {
                    Send-Ack $commandId 'success' 'identifying'
                    $duration = 4000
                    if ($params.ContainsKey('duration')) {
                        [int]::TryParse($params['duration'], [ref]$duration) | Out-Null
                    }
                    # Blocking is acceptable here: identify is short, and a second command
                    # arriving inside four seconds would be an operator double-tap anyway.
                    Start-Sleep -Milliseconds $duration
                    Stop-Overlay
                } else {
                    Send-Ack $commandId 'unsupported' 'no browser on this node'
                }
            } else {
                Send-Ack $commandId 'unsupported' 'overlay handles identify'
            }
        }
        'open_app'   { Invoke-OpenApp $params['app'] $commandId }
        'open_url'   { Invoke-OpenUrl $params['url'] $commandId }
        'speak'      { Invoke-Speak $params['text'] $commandId }
        'set_volume' { Invoke-SetVolume $params['level'] $commandId }
        'ping'       { Send-Ack $commandId 'success' 'pong' }
        default      { Send-Ack $commandId 'unsupported' $action }
    }
}

# ---------------------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------------------

# Runs in its own runspace because the command loop blocks on the stream. A runspace rather
# than Start-Job: a job spawns a second PowerShell process, which on a teammate's laptop is
# tens of megabytes for something that posts a form every five seconds.
function Start-Heartbeat($IntervalMs) {
    $script:HeartbeatRunspace = [RunspaceFactory]::CreateRunspace()
    $script:HeartbeatRunspace.Open()
    $script:HeartbeatRunspace.SessionStateProxy.SetVariable('Server', $Server)
    $script:HeartbeatRunspace.SessionStateProxy.SetVariable('NodeId', $Node)
    $script:HeartbeatRunspace.SessionStateProxy.SetVariable('SessionId', $script:SessionId)
    $script:HeartbeatRunspace.SessionStateProxy.SetVariable('IntervalMs', $IntervalMs)
    $script:HeartbeatRunspace.SessionStateProxy.SetVariable('Shared', $script:Shared)

    $shell = [PowerShell]::Create()
    $shell.Runspace = $script:HeartbeatRunspace
    [void]$shell.AddScript({
        $seq = 0
        $rtt = 0
        while ($true) {
            $awake = '1'
            try { if (Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue) { $awake = '0' } } catch { }

            # Measured with this machine's own clock only, so no two machines' clocks are
            # ever subtracted from one another.
            $watch = [System.Diagnostics.Stopwatch]::StartNew()
            try {
                $overlay = $Shared.Overlay
                Invoke-RestMethod -Uri "$Server/api/agent/heartbeat" -Method Post -TimeoutSec 10 -Body @{
                    node = $NodeId; session = $SessionId
                    state = $(if ($overlay -eq '1') { 'overlay' } else { 'ready' })
                    overlay = $overlay; awake = $awake; seq = $seq; rtt = $rtt
                } | Out-Null
            } catch { }
            $watch.Stop()
            $rtt = [int]$watch.ElapsedMilliseconds

            $seq++
            Start-Sleep -Milliseconds $IntervalMs
        }
    })
    $script:HeartbeatHandle = $shell.BeginInvoke()
    $script:HeartbeatShell = $shell
}

function Stop-Heartbeat {
    if ($script:HeartbeatShell) {
        try { $script:HeartbeatShell.Stop() } catch { }
        $script:HeartbeatShell = $null
    }
    if ($script:HeartbeatRunspace) {
        try { $script:HeartbeatRunspace.Close() } catch { }
        $script:HeartbeatRunspace = $null
    }
}

# ---------------------------------------------------------------------------------------
# Registration and the command channel
# ---------------------------------------------------------------------------------------

function Register-Node {
    $capabilities = Get-Capabilities
    $response = $null
    try {
        $response = Invoke-RestMethod -Uri "$Server/api/agent/register" -Method Post -TimeoutSec 10 -Body @{
            node = $Node; token = $Token; os = 'windows'
            host = $env:COMPUTERNAME; caps = $capabilities; agent = $AgentVersion
        }
    } catch {
        return 2
    }

    $text = "$response".Trim()
    if ($text -like 'OK*') {
        $parts = $text -split '\s+'
        $script:SessionId = $parts[1]
        $script:HeartbeatMs = 5000
        if ($parts.Count -ge 3) { [int]::TryParse($parts[2], [ref]$script:HeartbeatMs) | Out-Null }
        return 0
    }
    if ($text -like 'REJECT*') {
        Write-Log "Core refused this node: $text"
        return 1
    }
    return 2
}

# Invoke-WebRequest buffers the whole response, which never completes for a stream that
# stays open by design. HttpWebRequest gives the raw stream to read line by line.
function Read-CommandStream {
    $url = "$Server/api/agent/stream?node=$Node&session=$($script:SessionId)"
    $request = [System.Net.HttpWebRequest]::Create($url)
    $request.Method = 'GET'
    $request.Accept = 'text/event-stream'
    $request.Timeout = 10000

    # Default is 300 seconds, which would tear the command channel down every five minutes
    # in the middle of a demo.
    $request.ReadWriteTimeout = [System.Threading.Timeout]::Infinite

    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())

    try {
        while ($script:Running) {
            $line = $reader.ReadLine()
            if ($null -eq $line) { break }
            if ($line.StartsWith('data: ')) {
                Invoke-JarvisCommand $line.Substring(6)
            }
        }
    } finally {
        $reader.Dispose()
        $response.Close()
    }
}

function Show-Banner {
    Write-Host ''
    Write-Host '    JARVIS NODE AGENT' -ForegroundColor Cyan
    Write-Host ''
    Write-Host "    Node:          $Node"
    Write-Host "    Core:          $Server"
    Write-Host '    Authenticated: YES'
    Write-Host "    Capabilities:  $(Get-Capabilities)"
    if ($script:Browser) { Write-Host "    Overlay:       $($script:Browser)" }
    else { Write-Host '    Overlay:       no Chromium-family browser found' -ForegroundColor Yellow }
    Write-Host '    Status:        READY' -ForegroundColor Green
    Write-Host ''
    Write-Host '    Running in the background. Ctrl+C ends remote control immediately.'
    Write-Host ''
}

# ---------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------

Write-Log "connecting to $Server as $Node"

try {
    $backoff = 1
    while ($script:Running) {
        $result = Register-Node

        if ($result -eq 0) {
            $backoff = 1
            Start-Heartbeat $script:HeartbeatMs
            Show-Banner

            try { Read-CommandStream } catch { }

            Stop-Heartbeat
            if ($script:Running) { Write-Log 'connection to Core lost; reconnecting' }
        }
        elseif ($result -eq 1) {
            # A refusal is permanent — a wrong token will still be wrong in two seconds.
            break
        }
        else {
            Write-Log "Core unreachable; retrying in $backoff s"
        }

        if (-not $script:Running) { break }
        Start-Sleep -Seconds $backoff
        $backoff = [Math]::Min($backoff * 2, 15)
    }
}
finally {
    # The most important block in this file. Without it, a crashed or interrupted agent
    # leaves a teammate looking at a fullscreen overlay they cannot dismiss, in a dark room,
    # mid-presentation. See DEVIATIONS.md D4.
    $script:Running = $false
    Stop-Heartbeat
    Stop-Overlay
    try { [JarvisPower]::Release() } catch { }
    if ($script:Speech) { try { $script:Speech.Dispose() } catch { } }
    Write-Log 'JARVIS agent stopped; this machine is no longer under remote control.'
}
