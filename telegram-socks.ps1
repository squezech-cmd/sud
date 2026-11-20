# Создаёт локальный SOCKS5-прокси через ваш SSH-сервер.
# Пример: .\telegram-socks.ps1 -Server example.com -User myuser
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9.-]*$')]
    [string]$Server,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9_.-]*$')]
    [string]$User,

    [ValidateRange(1, 65535)]
    [int]$SshPort = 22,

    [ValidateRange(1, 65535)]
    [int]$LocalPort = 1080
)

$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
if (-not $ssh) {
    Write-Error 'Не найден OpenSSH Client. Установите его в дополнительных компонентах Windows.'
    exit 1
}

Write-Host "SOCKS5: 127.0.0.1:$LocalPort. Оставьте это окно открытым; Ctrl+C завершает подключение."
Write-Host 'При первом подключении проверьте отпечаток ключа сервера по доверенному каналу.'
& $ssh.Source -N -D "127.0.0.1:$LocalPort" -p $SshPort `
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
    "${User}@${Server}"
exit $LASTEXITCODE
