[CmdletBinding()]
param(
    [string]$Text,
    [string]$MessageId,
    [string]$ReplyTo,
    [string]$ConversationId,
    [switch]$NoReply,
    [switch]$Status,
    [switch]$Stop,
    [ValidateRange(0,20)][int]$WaitSeconds = 0
)
$ErrorActionPreference = 'Stop'
$spoolRoot = [IO.Path]::GetFullPath($PSScriptRoot)
function Read-JsonFile([string]$File) { Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-AtomicJson([string]$File, $Value) {
    $resolved = [IO.Path]::GetFullPath($File)
    if (-not $resolved.StartsWith($spoolRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Message path must stay in this workspace mailbox.' }
    $temp = $resolved + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temp -Destination $resolved
}
if ($ConversationId -and $ConversationId -notmatch '^[-a-zA-Z0-9_]{1,160}$') { throw 'Invalid ConversationId' }
$contextFile = if ($ConversationId) { Join-Path $spoolRoot ('contexts\' + $ConversationId + '.json') } else { Join-Path $spoolRoot 'dialogue-context.json' }
if (-not (Test-Path -LiteralPath $contextFile)) { throw 'GPT has not opened a dialogue for this workspace.' }
$context = Read-JsonFile $contextFile
if ($Stop) {
    $controlFile = Join-Path $spoolRoot ('controls\' + $context.conversationId + '-stop.json')
    if (-not (Test-Path -LiteralPath $controlFile)) { Write-AtomicJson $controlFile ([ordered]@{version=1;conversationId=$context.conversationId;command='stop';createdAt=[DateTime]::UtcNow.ToString('o')}) }
    $until = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    while ($WaitSeconds -gt 0 -and [DateTime]::UtcNow -lt $until) { $context = Read-JsonFile $contextFile; if ($context.status -ne 'active') { break }; Start-Sleep -Milliseconds 200 }
    [ordered]@{ok=$true;stopRequested=$true;conversationId=$context.conversationId;status=$context.status} | ConvertTo-Json -Compress
    exit
}
if ($MessageId -and $MessageId -notmatch '^[-a-zA-Z0-9_]{1,160}$') { throw 'Invalid MessageId' }
if ($Status) {
    if ($MessageId) {
        $receiptFile = Join-Path $spoolRoot ('receipts\' + $MessageId + '.json')
        if (Test-Path -LiteralPath $receiptFile) { Read-JsonFile $receiptFile | ConvertTo-Json -Depth 8 }
        else { [ordered]@{messageId=$MessageId;status='unconfirmed'} | ConvertTo-Json -Compress }
    } else { $context | ConvertTo-Json -Depth 8 }
    exit
}
if ($context.status -ne 'active' -or (Test-Path -LiteralPath (Join-Path $spoolRoot ('controls\' + $context.conversationId + '-stop.json')))) { throw 'Dialogue has stopped. Do not automatically reopen it.' }
if ([string]::IsNullOrWhiteSpace($Text) -or $Text.Length -gt 12000) { throw 'Text must contain 1..12000 characters.' }
if ($ReplyTo -and $ReplyTo -notmatch '^[-a-zA-Z0-9_]{1,160}$') { throw 'Invalid ReplyTo' }
if (-not $MessageId) { $MessageId = 'dsh-' + [Guid]::NewGuid().ToString() }
$messageFile = Join-Path $spoolRoot ('dsh-to-gpt\' + $MessageId + '.json')
$message = [ordered]@{version=1;messageId=$MessageId;conversationId=$context.conversationId;from='dsh';to='gpt';createdAt=[DateTime]::UtcNow.ToString('o');body=$Text;replyTo=$(if ($ReplyTo) { $ReplyTo } else { $null });expectsReply=(-not $NoReply)}
if (Test-Path -LiteralPath $messageFile) {
    $old = Read-JsonFile $messageFile
    if ($old.conversationId -ne $message.conversationId -or $old.body -cne $Text -or $old.replyTo -ne $message.replyTo -or $old.expectsReply -ne $message.expectsReply -or $old.from -ne 'dsh') { throw 'MessageId conflict; retry the exact same content.' }
} else { Write-AtomicJson $messageFile $message }
$receiptFile = Join-Path $spoolRoot ('receipts\' + $MessageId + '.json')
$until = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
do {
    if (Test-Path -LiteralPath $receiptFile) {
        $receipt = Read-JsonFile $receiptFile
        if ($receipt.status -in @('accepted','observed','blocked','uncertain','rejected')) { $receipt | ConvertTo-Json -Depth 8; exit }
    }
    if ($WaitSeconds -eq 0 -or [DateTime]::UtcNow -ge $until) { break }
    Start-Sleep -Milliseconds 200
} while ($true)
[ordered]@{ok=$true;messageId=$MessageId;conversationId=$context.conversationId;status='published';file=$messageFile;note='Published is not proof that GPT received or read it.'} | ConvertTo-Json -Compress
