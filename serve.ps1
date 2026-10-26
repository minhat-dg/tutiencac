# Server tĩnh để chạy thử trên máy (bản thật deploy lên Vercel).
#   powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 5500] [-Mock]
# -Mock: giả lập Bunny Storage tại /_mock/<zone>/ (dữ liệu lưu ở thư mục mock-bunny\, mật khẩu: devkey)
#        để thử trang quản trị mà không cần tài khoản Bunny. Trong config.js đặt:
#        cdnBase: "http://localhost:5500/_mock/test", storageZone: "test", storageHost: "http://localhost:5500/_mock"
param([int]$Port = 5500, [switch]$Mock)
$root = Join-Path $PSScriptRoot "public"
$mockRoot = Join-Path $PSScriptRoot "mock-bunny"
$types = @{
  ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".css" = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"; ".webmanifest" = "application/manifest+json"
  ".epub" = "application/epub+zip"; ".jpg" = "image/jpeg"; ".png" = "image/png"
  ".webp" = "image/webp"; ".svg" = "image/svg+xml"; ".ico" = "image/x-icon"; ".mp3" = "audio/mpeg"; ".ogg" = "audio/ogg"; ".m4a" = "audio/mp4"
}
$utf8 = [Text.UTF8Encoding]::new($false)

function SendBytes($res, $bytes, $type, $method) {
  $res.ContentType = $type
  $res.ContentLength64 = $bytes.Length
  if ($method -ne "HEAD") { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
}
function TypeOf($file) {
  $t = $types[[IO.Path]::GetExtension($file).ToLower()]
  if ($t) { $t } else { "application/octet-stream" }
}

# Very small imitation of the Bunny Storage HTTP API.
function MockBunny($ctx, $rel, [bool]$viaFunction = $false) {
  $req = $ctx.Request; $res = $ctx.Response; $m = $req.HttpMethod
  $res.AddHeader("Access-Control-Allow-Origin", "*")
  $res.AddHeader("Access-Control-Allow-Headers", "AccessKey, Content-Type, Authorization, apikey")
  $res.AddHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, DELETE, OPTIONS")
  if ($m -eq "OPTIONS") { $res.StatusCode = 204; return }
  $target = [IO.Path]::GetFullPath((Join-Path $mockRoot $rel))
  if (-not ($target + "\").StartsWith($mockRoot + "\")) { $res.StatusCode = 400; return }
  $authed = $viaFunction -or ($req.Headers["AccessKey"] -eq "devkey")
  $isDir = $rel.EndsWith("/") -or $rel -notmatch '/'
  if ($m -eq "GET" -and $isDir) {
    if (-not $authed) { $res.StatusCode = 401; return }
    $items = @()
    if (Test-Path -LiteralPath $target -PathType Container) {
      $items = @(Get-ChildItem -LiteralPath $target | ForEach-Object {
        @{ ObjectName = $_.Name; IsDirectory = $_.PSIsContainer; Length = $(if ($_.PSIsContainer) { 0 } else { $_.Length }); LastChanged = $_.LastWriteTimeUtc.ToString("o") }
      })
    }
    return SendBytes $res $utf8.GetBytes((ConvertTo-Json -InputObject $items -Compress)) "application/json" $m
  }
  if ($m -eq "GET" -or $m -eq "HEAD") {
    # Bunny Storage API (with AccessKey) answers 401 for a missing file; the CDN answers 404.
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { $res.StatusCode = $(if ($authed) { 401 } else { 404 }); return }
    $res.AddHeader("Last-Modified", (Get-Item -LiteralPath $target).LastWriteTimeUtc.ToString("r"))
    $res.AddHeader("Access-Control-Expose-Headers", "Last-Modified, Content-Length")
    return SendBytes $res ([IO.File]::ReadAllBytes($target)) (TypeOf $target) $m
  }
  if (-not $authed) { $res.StatusCode = 401; return }
  if ($m -eq "PUT") {
    [void](New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($target)))
    $fs = [IO.File]::Create($target)
    try { $req.InputStream.CopyTo($fs) } finally { $fs.Dispose() }
    $res.StatusCode = 201
    return SendBytes $res $utf8.GetBytes('{"HttpCode":201,"Message":"File uploaded."}') "application/json" $m
  }
  if ($m -eq "DELETE") {
    if (-not (Test-Path -LiteralPath $target)) { $res.StatusCode = 401; return }
    Remove-Item -LiteralPath $target -Recurse -Force
    return SendBytes $res $utf8.GetBytes('{"HttpCode":200,"Message":"File deleted successfuly."}') "application/json" $m
  }
  $res.StatusCode = 405
}

# POST ?batch=1 của Edge Function: nhiều file trong một body,
# lặp lại [độ dài đường dẫn u32 BE][đường dẫn UTF-8][độ dài dữ liệu u32 BE][dữ liệu]
function MockBatch($ctx) {
  $res = $ctx.Response
  $res.AddHeader("Access-Control-Allow-Origin", "*")
  $ms = [IO.MemoryStream]::new(); $ctx.Request.InputStream.CopyTo($ms); $b = $ms.ToArray()
  $u32 = { param($o) ([int64]$b[$o] -shl 24) -bor ([int64]$b[$o + 1] -shl 16) -bor ([int64]$b[$o + 2] -shl 8) -bor $b[$o + 3] }
  $o = 0; $n = 0
  while ($o -lt $b.Length) {
    $pl = & $u32 $o; $o += 4
    $path = $utf8.GetString($b, $o, $pl); $o += $pl
    $dl = & $u32 $o; $o += 4
    $target = [IO.Path]::GetFullPath((Join-Path $mockRoot ("test/" + $path)))
    if (-not ($target + "\").StartsWith($mockRoot + "\") -or $o + $dl -gt $b.Length) { $res.StatusCode = 400; return }
    [void](New-Item -ItemType Directory -Force ([IO.Path]::GetDirectoryName($target)))
    $chunk = New-Object byte[] $dl; [Array]::Copy($b, $o, $chunk, 0, $dl); [IO.File]::WriteAllBytes($target, $chunk)
    $o += $dl; $n++
  }
  SendBytes $res $utf8.GetBytes("{""count"":$n,""failed"":[]}") "application/json" "POST"
}

# Imitation of the Supabase Edge Function "bunny" (supabase/functions/bunny):
# token "tok-admin" = admin, "tok-user" = signed in without admin rights.
function MockFunction($ctx) {
  $req = $ctx.Request; $res = $ctx.Response
  if ($req.HttpMethod -eq "OPTIONS") { return MockBunny $ctx "test/" $true }
  $path = ""
  foreach ($pair in $req.Url.Query.TrimStart('?').Split('&')) {
    $kv = $pair.Split('=', 2)
    if ($kv[0] -eq "path" -and $kv.Length -eq 2) { $path = [Uri]::UnescapeDataString($kv[1]) }
  }
  $auth = [string]$req.Headers["Authorization"]
  if ($auth -eq "Bearer tok-admin" -and $req.HttpMethod -eq "POST") { return MockBatch $ctx }
  if ($auth -eq "Bearer tok-admin") { return MockBunny $ctx ("test/" + $path) $true }
  $res.AddHeader("Access-Control-Allow-Origin", "*")
  $res.StatusCode = $(if ($auth -eq "Bearer tok-user") { 403 } else { 401 })
  SendBytes $res $utf8.GetBytes('{"error":"mock"}') "application/json" $req.HttpMethod
}

$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Tu Tien Cac: http://localhost:$Port/  (quan tri: /admin)  (Ctrl+C de dung)"
if ($Mock) { [void](New-Item -ItemType Directory -Force $mockRoot); Write-Host "Gia lap Bunny: /_mock/<zone>/  mat khau: devkey" }
try {
  while ($listener.IsListening) {
    $task = $listener.GetContextAsync()
    while (-not $task.AsyncWaitHandle.WaitOne(500)) { }
    $ctx = $task.GetAwaiter().GetResult()
    $res = $ctx.Response
    try {
      $res.AddHeader("Cache-Control", "no-store")
      # cô lập cross-origin (giống vercel.json) để giọng AI chạy WASM đa luồng
      $res.AddHeader("Cross-Origin-Opener-Policy", "same-origin")
      $res.AddHeader("Cross-Origin-Embedder-Policy", "credentialless")
      $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
      if ($Mock -and $path.StartsWith("_mock/sb/functions/v1/bunny")) { MockFunction $ctx; continue }
      if ($Mock -and $path.StartsWith("_mock/")) { MockBunny $ctx $path.Substring(6); continue }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path))
      if (Test-Path -LiteralPath $file -PathType Container) { $file = Join-Path $file "index.html" }
      elseif (-not (Test-Path -LiteralPath $file -PathType Leaf) -and (Test-Path -LiteralPath "$file.html" -PathType Leaf)) { $file = "$file.html" }
      if (($file + "\").StartsWith($root + "\") -and (Test-Path -LiteralPath $file -PathType Leaf)) {
        SendBytes $res ([IO.File]::ReadAllBytes($file)) (TypeOf $file) $ctx.Request.HttpMethod
      } else {
        $res.StatusCode = 404
      }
    } catch { Write-Host "Loi: $($_.Exception.Message)"; $res.StatusCode = 500 }
    finally { $res.Close() }
  }
} finally { $listener.Stop() }
