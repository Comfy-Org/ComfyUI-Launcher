import { execFile } from 'child_process'

export interface LockingProcess {
  pid: number
  name: string
}

const TIMEOUT_MS = 5000

/**
 * Best-effort attempt to identify which processes hold a lock on `filePath`.
 * Returns an empty array if detection fails or times out.
 */
export function findLockingProcesses(filePath: string): Promise<LockingProcess[]> {
  if (process.platform === 'win32') {
    return findLockingProcessesWindows(filePath)
  }
  return findLockingProcessesUnix(filePath)
}

/**
 * Windows: use PowerShell + Restart Manager API via inline C# to query which
 * processes hold handles on the given file. This is a built-in Windows API —
 * no third-party tools required.
 */
function findLockingProcessesWindows(filePath: string): Promise<LockingProcess[]> {
  // Escape single quotes for PowerShell string embedding
  const escaped = filePath.replace(/'/g, "''")
  const script = `
$code = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class RmUtil {
    [StructLayout(LayoutKind.Sequential)] public struct RM_UNIQUE_PROCESS {
        public int dwProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }
    const int RmRebootReasonNone = 0;
    const int CCH_RM_MAX_APP_NAME = 255;
    const int CCH_RM_MAX_SVC_NAME = 63;
    public enum RM_APP_TYPE { RmUnknownApp=0, RmMainWindow=1, RmOtherWindow=2, RmService=3, RmExplorer=4, RmConsole=5, RmCritical=1000 }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_APP_NAME+1)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_SVC_NAME+1)] public string strServiceShortName;
        public RM_APP_TYPE ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, string key);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] rgFiles, uint nApps, RM_UNIQUE_PROCESS[] rgApps, uint nSvcs, string[] rgSvcs);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint nProcInfoNeeded, ref uint nProcInfo, [In,Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static string Query(string path) {
        uint handle;
        if (RmStartSession(out handle, 0, Guid.NewGuid().ToString()) != 0) return "";
        try {
            if (RmRegisterResources(handle, 1, new[]{path}, 0, null, 0, null) != 0) return "";
            uint needed = 0, count = 0, reasons = 0;
            int rc = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (rc == 234 && needed > 0) { count = needed; }
            else if (rc != 0) return "";
            else return "";
            var info = new RM_PROCESS_INFO[count];
            rc = RmGetList(handle, out needed, ref count, info, ref reasons);
            if (rc != 0) return "";
            var results = new List<string>();
            for (int i = 0; i < count; i++) {
                try {
                    var p = Process.GetProcessById(info[i].Process.dwProcessId);
                    results.Add(p.Id + "\\t" + p.ProcessName);
                } catch {
                    results.Add(info[i].Process.dwProcessId + "\\t" + info[i].strAppName);
                }
            }
            return string.Join("\\n", results);
        } finally { RmEndSession(handle); }
    }
}
'@
Add-Type -TypeDefinition $code
[RmUtil]::Query('${escaped}')
`
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([])
        const results: LockingProcess[] = []
        for (const line of stdout.trim().split('\n')) {
          const parts = line.trim().split('\t')
          if (parts.length >= 2) {
            const pid = parseInt(parts[0]!, 10)
            const name = parts[1]!
            if (pid > 0 && name) results.push({ pid, name })
          }
        }
        resolve(results)
      }
    )
  })
}

/**
 * Linux / macOS: use lsof -F pc for machine-readable output.
 * Each record is a pair of lines: "p<pid>\n" followed by "c<command>\n".
 * This avoids the column-width parsing issues of the default human-readable
 * format (process names with spaces would shift the PID column).
 */
function findLockingProcessesUnix(filePath: string): Promise<LockingProcess[]> {
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-F', 'pc', '--', filePath],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([])
        const results: LockingProcess[] = []
        const seen = new Set<number>()
        let currentPid = 0
        for (const line of stdout.trim().split('\n')) {
          if (line.startsWith('p')) {
            currentPid = parseInt(line.slice(1), 10)
          } else if (line.startsWith('c') && currentPid > 0) {
            if (!seen.has(currentPid)) {
              seen.add(currentPid)
              results.push({ pid: currentPid, name: line.slice(1) })
            }
          }
        }
        resolve(results)
      }
    )
  })
}
