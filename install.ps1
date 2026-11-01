# KV cache: none
# Installs rlmh on Windows x64 into <home>\bin (step 10). Windows PowerShell 5.1 and PowerShell 7:
#   irm https://github.com/RishiJain905/rlm-harness/releases/latest/download/install.ps1 | iex
# Inputs, from the environment only (irm | iex cannot take parameters):
#   RLMH_VERSION         latest (default), 0.1.0 or v0.1.0
#   RLMH_HOME            <home>, default %USERPROFILE%\.rlm-harness
#   RLMH_DOWNLOAD_BASE   a folder holding rlmh-windows-x64.exe and SHA256SUMS, used as given
#   RLMH_NO_MODIFY_PATH  1 leaves HKCU\Environment\Path alone
# A saved copy runs with: powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# (this process only; the installer never changes the execution policy). It installs uv into
# <home>\bin only when uv is not on PATH; Python and the engine come later, from "rlmh setup".
# The checksums catch a corrupted download, not a compromised release.
# Keep this file ASCII with no BOM: irm decodes a release asset without a charset.
$rlmhSavedPreferences = @($ErrorActionPreference, $ProgressPreference, [Net.ServicePointManager]::SecurityProtocol)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Install-Rlmh {
    function Get-RlmhFile([string]$Url, [string]$OutFile) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
        } catch {
            throw "rlmh install: could not download ${Url}: $($_.Exception.Message)"
        }
    }

    # Checks FILE against EXPECTED (empty when no SHA256SUMS line names it); deletes it on a mismatch.
    function Test-RlmhSha256([string]$File, [string]$Name, [string]$Expected) {
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $File).Hash.ToLowerInvariant()
        if ((-not $Expected) -or ($Expected -ne $actual)) {
            $shown = $Expected
            if (-not $shown) { $shown = "(no line for $Name)" }
            Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
            throw "rlmh install: checksum mismatch for $Name`n  expected  $shown`n  actual    $actual`nrlmh install: nothing was installed"
        }
    }

    # Moves NEW onto DEST. A DEST that is running is renamed to .old first, then deleted if it can be.
    function Install-RlmhExe([string]$New, [string]$Dest) {
        $old = "$Dest.old"
        if (Test-Path -LiteralPath $Dest) {
            if (Test-Path -LiteralPath $old) {
                Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
                # An older copy may still run from .old; step aside with a unique name.
                if (Test-Path -LiteralPath $old) { $old = "$Dest.old.$PID" }
            }
            Move-Item -LiteralPath $Dest -Destination $old -Force
        }
        Move-Item -LiteralPath $New -Destination $Dest -Force
        try { Unblock-File -LiteralPath $Dest } catch { }
        if (Test-Path -LiteralPath $old) {
            try { Remove-Item -LiteralPath $old -Force } catch { }
        }
    }

    # True when a ;-separated PATH value has DIR as an entry (trailing \ and case ignored).
    function Test-RlmhPathHas([string]$PathValue, [string]$Dir) {
        $want = $Dir.TrimEnd('\')
        foreach ($entry in ($PathValue -split ';')) {
            if (-not $entry) { continue }
            if ($entry.TrimEnd('\') -eq $want) { return $true }
            if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -eq $want) { return $true }
        }
        return $false
    }

    # Tells open programs that the user environment changed. Fails under Constrained Language Mode,
    # which is not worth failing the install for.
    function Send-RlmhSettingChange {
        try {
            if (-not ('RlmhInstall.NativeMethods' -as [type])) {
                Add-Type -Namespace RlmhInstall -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
            }
            $result = [UIntPtr]::Zero
            # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5 s.
            [void][RlmhInstall.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
        } catch { }
    }

    $uvVersion = '0.13.6'
    # The SHA-256 of uv's Windows archive, copied from that release's <archive>.sha256 file.
    $uvArchive = 'uv-x86_64-pc-windows-msvc.zip'
    $uvSha256 = 'a2a8820d5eea32f08ef467ef3b7f66883a9b076d5737a2fc2fbb5f458d1bb50f'
    $repoUrl = 'https://github.com/RishiJain905/rlm-harness'
    $asset = 'rlmh-windows-x64.exe'
    $unsupported = 'rlmh v0 ships macOS arm64 and x64, Windows x64 and Linux x64 (glibc).'

    # Platform: only x64 Windows. PROCESSOR_ARCHITEW6432 is the real one under 32-bit PowerShell.
    if ($env:OS -ne 'Windows_NT') {
        throw "$unsupported This machine is not Windows; use install.sh."
    }
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -ne 'AMD64') {
        throw "$unsupported This machine is Windows $arch."
    }

    # <home>: RLMH_HOME, else %USERPROFILE%\.rlm-harness, as a full path with no trailing \.
    $defaultHome = ''
    if ($env:USERPROFILE) { $defaultHome = Join-Path $env:USERPROFILE '.rlm-harness' }
    $customHome = $false
    if ($env:RLMH_HOME) {
        $homeDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:RLMH_HOME)
    } else {
        if (-not $defaultHome) { throw 'rlmh install: USERPROFILE is not set; set USERPROFILE or RLMH_HOME' }
        $homeDir = $defaultHome
    }
    if ($homeDir.Length -gt 3) { $homeDir = $homeDir.TrimEnd([char[]]@('\', '/')) }
    if ($env:RLMH_HOME -and ($homeDir -ne $defaultHome)) { $customHome = $true }
    $bin = Join-Path $homeDir 'bin'

    $version = $env:RLMH_VERSION
    if (-not $version) { $version = 'latest' }
    if ($env:RLMH_DOWNLOAD_BASE) {
        $base = $env:RLMH_DOWNLOAD_BASE.TrimEnd('/')
    } elseif ($version -eq 'latest') {
        $base = "$repoUrl/releases/latest/download"
    } else {
        if (-not $version.StartsWith('v')) { $version = "v$version" }
        $base = "$repoUrl/releases/download/$version"
    }

    $madeHome = $false
    $madeBin = $false
    if (-not (Test-Path -LiteralPath $homeDir)) {
        [void](New-Item -ItemType Directory -Path $homeDir -Force)
        $madeHome = $true
    }
    if (-not (Test-Path -LiteralPath $bin)) {
        [void](New-Item -ItemType Directory -Path $bin -Force)
        $madeBin = $true
    }
    $tmp = Join-Path $bin ".install.$PID"
    $done = $false
    try {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
        [void](New-Item -ItemType Directory -Path $tmp)

        # 1. rlmh: download and check it before anything in <home>\bin changes.
        $sums = Join-Path $tmp 'SHA256SUMS'
        $download = Join-Path $tmp $asset
        Get-RlmhFile "$base/SHA256SUMS" $sums
        Get-RlmhFile "$base/$asset" $download
        $expected = ''
        foreach ($line in (Get-Content -LiteralPath $sums)) {
            $parts = $line.Trim() -split '\s+', 2
            if ($parts.Count -eq 2) {
                $name = $parts[1].TrimStart('*')
                if ($name -ceq $asset) {
                    $expected = $parts[0].ToLowerInvariant()
                    break
                }
            }
        }
        Test-RlmhSha256 $download $asset $expected

        # 2. uv, only when it is not on PATH and not in <home>\bin already.
        $uvNew = ''
        $uvDest = Join-Path $bin 'uv.exe'
        $uvOnPath = Get-Command uv -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($uvOnPath) {
            $uvLine = "$($uvOnPath.Path) (already on PATH)"
        } elseif (Test-Path -LiteralPath $uvDest) {
            $uvLine = "$uvDest (already installed)"
        } else {
            $zip = Join-Path $tmp $uvArchive
            Get-RlmhFile "https://github.com/astral-sh/uv/releases/download/$uvVersion/$uvArchive" $zip
            Test-RlmhSha256 $zip $uvArchive $uvSha256
            $uvDir = Join-Path $tmp 'uv'
            Expand-Archive -LiteralPath $zip -DestinationPath $uvDir -Force
            $found = Get-ChildItem -LiteralPath $uvDir -Recurse -File | Where-Object { $_.Name -eq 'uv.exe' } | Select-Object -First 1
            if (-not $found) { throw "rlmh install: $uvArchive holds no file named uv.exe" }
            $uvNew = $found.FullName
            $uvLine = "$uvDest (installed by this script)"
        }

        # 3. Install. A running rlmh.exe cannot be replaced, but it can be renamed.
        $dest = Join-Path $bin 'rlmh.exe'
        $new = "$dest.new"
        Move-Item -LiteralPath $download -Destination $new -Force
        Install-RlmhExe $new $dest
        if ($uvNew) {
            Copy-Item -LiteralPath $uvNew -Destination "$uvDest.new" -Force
            Install-RlmhExe "$uvDest.new" $uvDest
        }

        # 4. PATH: one entry in HKCU\Environment\Path, %VARS% kept unexpanded.
        $pathNow = "`$env:Path += ';$($bin.Replace("'", "''"))'"
        $pathPlace = 'HKCU\Environment\Path'
        if ($env:RLMH_NO_MODIFY_PATH -eq '1') {
            $pathLine = "not changed (RLMH_NO_MODIFY_PATH=1); to use rlmh, run: $pathNow"
        } else {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
            if (-not $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
            try {
                $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                if (Test-RlmhPathHas $old $bin) {
                    $pathLine = "already in $pathPlace; open a new terminal, or run: $pathNow"
                } else {
                    if (-not $old) {
                        $newPath = $bin
                    } elseif ($old.EndsWith(';')) {
                        $newPath = "$old$bin"
                    } else {
                        $newPath = "$old;$bin"
                    }
                    $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
                    Send-RlmhSettingChange
                    $pathLine = "added to $pathPlace; open a new terminal, or run: $pathNow"
                }
            } finally {
                $key.Close()
            }
            if (-not (Test-RlmhPathHas $env:Path $bin)) {
                if ((-not $env:Path) -or $env:Path.EndsWith(';')) {
                    $env:Path = "$env:Path$bin"
                } else {
                    $env:Path = "$env:Path;$bin"
                }
            }
        }

        # 5. The last check: the installed binary runs and names its version.
        $out = & $dest --version
        if ($LASTEXITCODE -ne 0) { throw "rlmh install: $dest --version failed (exit $LASTEXITCODE)" }
        $out = (($out | Out-String).Trim())
        if (-not ($out -match '^rlmh (\S+)$')) { throw "rlmh install: $dest --version printed `"$out`", not `"rlmh <version>`"" }
        $installed = $Matches[1]
        $done = $true
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        if (-not $done) {
            # Only folders this run made and left empty.
            if ($madeBin -and (Test-Path -LiteralPath $bin) -and -not (Get-ChildItem -LiteralPath $bin -Force)) {
                Remove-Item -LiteralPath $bin -Force -ErrorAction SilentlyContinue
            }
            if ($madeHome -and (Test-Path -LiteralPath $homeDir) -and -not (Get-ChildItem -LiteralPath $homeDir -Force)) {
                Remove-Item -LiteralPath $homeDir -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Write-Host "rlmh $installed installed"
    Write-Host "  binary   $dest"
    Write-Host "  uv       $uvLine"
    Write-Host "  data     $homeDir   (Python and the engine are added on first run)"
    Write-Host "  PATH     $pathLine"
    if ($customHome) {
        Write-Host "Set RLMH_HOME=$homeDir as a user environment variable, or rlmh will look in $defaultHome. In PowerShell:"
        Write-Host "  [Environment]::SetEnvironmentVariable('RLMH_HOME', '$($homeDir.Replace("'", "''"))', 'User')"
    }
    Write-Host 'Next: run "rlmh". It asks before it downloads Python 3.12.'
    Write-Host 'Uninstall: delete saved keys in /providers first, then run in PowerShell:'
    Write-Host '  $h = if ($env:RLMH_HOME) { $env:RLMH_HOME } else { "$env:USERPROFILE\.rlm-harness" }'
    Write-Host '  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(''Environment'', $true)'
    Write-Host '  $p = $k.GetValue(''Path'', '''', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)'
    Write-Host '  $k.SetValue(''Path'', (($p -split '';'' | Where-Object { $_ -and $_.TrimEnd(''\'') -ne "$h\bin" }) -join '';''), [Microsoft.Win32.RegistryValueKind]::ExpandString)'
    Write-Host '  Remove-Item -Recurse -Force $h'
}

# Never exit under iex: it would close the user's terminal. Only a run as a file ends in exit 1.
$rlmhAsFile = $false
try { if ($MyInvocation.MyCommand.Path) { $rlmhAsFile = $true } } catch { }
$rlmhFailed = $false
try {
    Install-Rlmh
} catch {
    $rlmhFailed = $true
    $rlmhMessage = $_.Exception.Message
    if (-not $rlmhMessage.StartsWith('rlmh ')) { $rlmhMessage = "rlmh install: $rlmhMessage" }
    Write-Host $rlmhMessage -ForegroundColor Red
} finally {
    $ErrorActionPreference = $rlmhSavedPreferences[0]
    $ProgressPreference = $rlmhSavedPreferences[1]
    [Net.ServicePointManager]::SecurityProtocol = $rlmhSavedPreferences[2]
}
if ($rlmhFailed -and $rlmhAsFile) { exit 1 }
