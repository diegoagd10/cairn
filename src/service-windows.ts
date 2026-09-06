import { join, win32 } from "node:path";
import { checked, installArguments, nativeRuntime } from "./service-common.ts";
import type { ServiceRuntime } from "./service-common.ts";

// Quoted PowerShell literals, carried over UTF-16 EncodedCommand, avoid cmd.exe
// expansion and preserve Unicode, apostrophes, dollar signs, and spaces in paths.
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");

export function windowsService(action: string, cli: string, db?: string, port?: string, runtime: ServiceRuntime = nativeRuntime) {
  const args = action === "install" ? installArguments(runtime, cli, db, port) : undefined;
  const logs = join(runtime.home, ".cairn", "logs");
  const powershell = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Run synchronously in a hidden console so Task Scheduler owns the process
  // tree. Do not detach Node: stopping the task must also stop the viewer.
  const viewer = args ? `& ${args.map(literal).join(" ")} >> ${literal(join(logs, "viewer.log"))} 2>> ${literal(join(logs, "viewer.error.log"))}
if ($null -eq $LASTEXITCODE) { exit 1 }
exit $LASTEXITCODE` : "";
  const install = args ? `
  New-Item -ItemType Directory -Path ${literal(logs)} -Force | Out-Null
  if ($task) { Stop-ScheduledTask -InputObject $task }
  $execute = New-ScheduledTaskAction -Execute ${literal(powershell)} -Argument ${literal(`-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded(viewer)}`)}
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
  $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $execute -Trigger $trigger -Principal $principal -Settings $settings -Description $marker -Force | Out-Null
  Start-ScheduledTask -TaskName $name -TaskPath '\\'
` : "";
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
  Import-Module ScheduledTasks -ErrorAction Stop
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $name = 'Cairn-' + $sid
  $marker = 'Managed by cairn service install'
  $operation = ${literal(action)}
  $task = Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq $name }
  if ($task -and $task.Description -ne $marker) { throw 'Refusing to manage a task not created by Cairn.' }
  if (!$task -and $operation -ne 'install') {
    if ($operation -eq 'status' -or $operation -eq 'uninstall') {
      @{ installed = $false; path = '\\' + $name } | ConvertTo-Json -Compress
      exit 0
    }
    throw 'Service is not installed. Run cairn service install first.'
  }
  switch ($operation) {
    'install' { ${install} }
    'start' {
      Enable-ScheduledTask -InputObject $task | Out-Null
      Start-ScheduledTask -InputObject $task
    }
    'stop' {
      Disable-ScheduledTask -InputObject $task | Out-Null
      Stop-ScheduledTask -InputObject $task
    }
    'uninstall' {
      Disable-ScheduledTask -InputObject $task | Out-Null
      Stop-ScheduledTask -InputObject $task
      Unregister-ScheduledTask -InputObject $task -Confirm:$false
      @{ installed = $false; path = '\\' + $name } | ConvertTo-Json -Compress
      exit 0
    }
  }
  $task = Get-ScheduledTask -TaskName $name -TaskPath '\\'
  $info = Get-ScheduledTaskInfo -InputObject $task
  @{
    installed = $true; path = '\\' + $name; logs = ${literal(logs)}
    active = $(if ($task.State -eq 'Running') { 'active' } else { 'inactive' })
    state = $task.State.ToString()
    startup = $(if ($task.Settings.Enabled) { 'enabled' } else { 'disabled' })
    lastExitCode = $info.LastTaskResult
  } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
  const output = checked(runtime, powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)]);
  return JSON.parse(output.trim());
}
