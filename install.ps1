# Install the a0 binary from GitHub Releases on Windows.
#   irm https://raw.githubusercontent.com/Joe-Simo/a0/main/install.ps1 | iex
# Environment:
#   A0_VERSION      release tag to install (e.g. v0.8.16); default: latest
#   A0_INSTALL_DIR  destination directory; default: $env:LOCALAPPDATA\Programs\a0
#   A0_RELEASE_URL  base URL holding the assets and checksums.txt (overrides A0_VERSION; for mirrors)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'Joe-Simo/a0'
$installDir = if ($env:A0_INSTALL_DIR) { $env:A0_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\a0' }

$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($arch -ne 'X64' -and $arch -ne 'Arm64') { throw "a0 install: unsupported architecture $arch" }
# Only an x64 Windows build is published; Windows on Arm runs it under emulation.
$asset = 'a0-windows-x64.exe'

$base = if ($env:A0_RELEASE_URL) { $env:A0_RELEASE_URL.TrimEnd('/') }
  elseif ($env:A0_VERSION) { "https://github.com/$repo/releases/download/$($env:A0_VERSION)" }
  else { "https://github.com/$repo/releases/latest/download" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("a0-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "a0 install: downloading $asset from $base"
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')

  $checksumLines = @(Get-Content (Join-Path $tmp 'checksums.txt'))
  function Get-VerifiedReleaseHash([string] $name) {
    $line = $checksumLines | Where-Object { ($_ -split '\s+')[1] -in @($name, "*$name") } | Select-Object -First 1
    if (-not $line) { throw "a0 install: no checksum for $name in checksums.txt" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $name)).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "a0 install: checksum mismatch for ${name}: expected $expected, got $actual" }
    return $actual
  }
  $binaryHash = Get-VerifiedReleaseHash $asset
  Write-Host "a0 install: sha256 verified ($binaryHash)"

  # Older manifests have neither entry: keep their original license, without a current-main fallback.
  $hasLicense = @($checksumLines | Where-Object { ($_ -split '\s+')[1] -in @('LICENSE', '*LICENSE') }).Count -gt 0
  $hasNotice = @($checksumLines | Where-Object { ($_ -split '\s+')[1] -in @('NOTICE', '*NOTICE') }).Count -gt 0
  if ($hasLicense -or $hasNotice) {
    if (-not ($hasLicense -and $hasNotice)) { throw 'a0 install: checksums.txt must list both LICENSE and NOTICE' }
    foreach ($name in @('LICENSE', 'NOTICE')) {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile (Join-Path $tmp $name)
      $null = Get-VerifiedReleaseHash $name
    }
    # The checksum directory keeps notices associated with their binary across upgrades/downgrades.
    $noticeDir = Join-Path (Join-Path $installDir 'share\a0') $binaryHash
    New-Item -ItemType Directory -Force -Path $noticeDir | Out-Null
    foreach ($name in @('LICENSE', 'NOTICE')) {
      Copy-Item -Force (Join-Path $tmp $name) (Join-Path $noticeDir $name)
    }
  }

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Move-Item -Force (Join-Path $tmp $asset) (Join-Path $installDir 'a0.exe')
  Write-Host "a0 install: installed $(Join-Path $installDir 'a0.exe')"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $installDir)) {
    [Environment]::SetEnvironmentVariable('Path', (@($userPath, $installDir) -ne '' -join ';'), 'User')
    Write-Host "a0 install: added $installDir to your user PATH; open a new terminal to use a0"
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
