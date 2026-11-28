$ErrorActionPreference = 'Stop'

$certDir = Resolve-Path (Join-Path $PSScriptRoot '..\nginx\certs')
$crtPath = Join-Path $certDir 'server.crt'
$keyPath = Join-Path $certDir 'server.key'
$pfxPath = Join-Path $certDir 'server.pfx'

$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
  $gitOpenSsl = @('C:\Program Files\Git\usr\bin\openssl.exe', 'C:\Program Files\Git\mingw64\bin\openssl.exe') |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
  if ($gitOpenSsl) {
    $openssl = Get-Command $gitOpenSsl
  }
}
if ($openssl) {
  $env:MSYS_NO_PATHCONV = '1'
  & $openssl.Source req -x509 -nodes -days 365 -newkey rsa:2048 `
    -keyout $keyPath `
    -out $crtPath `
    -subj "/CN=marketsphere.local/O=MarketSphere Local Dev/C=US" `
    -addext "subjectAltName=DNS:localhost,DNS:marketsphere.local,IP:127.0.0.1"
  if ($LASTEXITCODE -ne 0) {
    throw "OpenSSL certificate generation failed with exit code $LASTEXITCODE"
  }
  & $openssl.Source pkcs12 -export -out $pfxPath -inkey $keyPath -in $crtPath -passout pass:marketsphere-local-dev
  Write-Output "Generated OpenSSL TLS cert ($crtPath), private key ($keyPath), and PFX ($pfxPath)"
  exit 0
}

$cert = New-SelfSignedCertificate `
  -DnsName 'localhost', 'marketsphere.local', '127.0.0.1' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -FriendlyName 'MarketSphere Local Dev TLS' `
  -NotAfter (Get-Date).AddDays(365)

try {
  $pemBase64 = [System.Convert]::ToBase64String($cert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
  $pem = "-----BEGIN CERTIFICATE-----`n$pemBase64`n-----END CERTIFICATE-----`n"
  [System.IO.File]::WriteAllText($crtPath, $pem, [System.Text.Encoding]::ASCII)

  $password = ConvertTo-SecureString -String 'marketsphere-local-dev' -Force -AsPlainText
  Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null
  Write-Output "Generated local X.509 certificate ($crtPath) and PFX bundle ($pfxPath) via Windows Cert store."
  Write-Output "Note: Install OpenSSL to extract unencrypted server.key from server.pfx for Nginx Linux containers."
} finally {
  Remove-Item -Path $cert.PSPath -Force -ErrorAction SilentlyContinue
}
