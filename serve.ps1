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
  ".json" = "application/json; charset=utf-8"; ".epub" = "application/epub+zip"; ".jpg" = "image/jpeg"; ".png" = "image/png"
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
function MockBunny($ctx, $rel) {
  $req = $ctx.Request; $res = $ctx.Response; $m = $req.HttpMethod
  $res.AddHeader("Access-Control-Allow-Origin", "*")
  $res.AddHeader("Access-Control-Allow-Headers", "AccessKey, Content-Type")
  $res.AddHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, DELETE, OPTIONS")
  if ($m -eq "OPTIONS") { $res.StatusCode = 204; return }
  $target = [IO.Path]::GetFullPath((Join-Path $mockRoot $rel))
  if (-not ($target + "\").StartsWith($mockRoot + "\")) { $res.StatusCode = 400; return }
  $authed = $req.Headers["AccessKey"] -eq "devkey"
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
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { $res.StatusCode = 404; return }
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
    if (-not (Test-Path -LiteralPath $target)) { $res.StatusCode = 404; return }
    Remove-Item -LiteralPath $target -Recurse -Force
    return SendBytes $res $utf8.GetBytes('{"HttpCode":200,"Message":"File deleted successfuly."}') "application/json" $m
  }
  $res.StatusCode = 405
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
      $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
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
