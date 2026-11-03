// Keeps the PC and its display awake while a run is active, so Windows doesn't sleep
// mid-run and Chrome keeps rendering. Windows: a hidden PowerShell child holds
// SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
// macOS: caffeinate. The request ends when the child is killed.

import { spawn, type ChildProcess } from "node:child_process";

// 2147483651 = 0x80000003 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED.
// SetThreadExecutionState returns the previous state, or 0 on failure; the child prints it once.
const WINDOWS_SCRIPT = [
  `$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
  "$k = Add-Type -MemberDefinition $sig -Name Power -Namespace KeepAwake -PassThru",
  "Write-Output ($k::SetThreadExecutionState([uint32]2147483651))",
  "while ($true) { Start-Sleep -Seconds 30 }",
].join("; ");

export type KeepAwake = { active: boolean; release(): void };

/** Starts holding the PC awake; resolves once Windows has accepted the request (or after 10 s). */
export async function keepAwake(): Promise<KeepAwake> {
  let child: ChildProcess | null = null;
  let active = false;
  if (process.platform === "win32") {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    active = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      child!.stdout!.once("data", (d: Buffer) => { clearTimeout(timer); resolve(Number(String(d).trim()) > 0); });
      child!.once("exit", () => { clearTimeout(timer); resolve(false); });
    });
  } else if (process.platform === "darwin") {
    child = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" });
    active = true;
  }
  return { active, release: () => { child?.kill(); child = null; } };
}
