# Proof Reader for Windows

Double-click **Proof Reader.exe** to open the x64 Windows app. You can also use **start-reader.cmd** in the parent folder. Keep the desktop folder with the reader files when moving the app.

The window uses the installed Microsoft Edge WebView2 Evergreen Runtime. Reading runs through a local Node.js service on `127.0.0.1:8794`. An existing service is reused only when its installation identity matches this copy. The app closes a service it started when the main window closes. Set `PROOF_READER_PORT` before launch to use a different fixed local port.

If the window’s own service exits while you are reading, the window restarts it on the same port and reconnects the open page. Two automatic restarts are available in a ten-minute interval. If the service keeps exiting or another installation claims the port, the window displays the exit code and the reason recovery stopped.

Imported PDFs use Poppler. Tutor answers and research use the signed-in Codex CLI. The desktop host can locate the Windows Codex app's CLI from its installation record when it is absent from PATH.

The desktop reading profile is stored in `%LOCALAPPDATA%\ProofReader\DesktopProfile`. Its knowledge, library, and other persistent site data belong to this app profile. Browser profiles are separate. Changing the service port changes the origin used by WebView2 storage.

## Remove a paper

Select a paper in the picker, click **Remove paper…**, and confirm its title. Removing a paper clears its library entry, reading plans, conversations, progress, and paper-specific background choices. For an upload, it also clears the app’s saved copy. The original file and shared technique preferences stay available. Import the file again to prepare a new overview and choose your background and notation.

## Diagnose reading-plan preparation

Open **Diagnostics** on the waiting or failure screen. Click **Refresh** for the latest events, or **Copy diagnostics** to include the report in a bug report. Use the part number, page, field and check code to locate the problem. The report contains operational metadata and an opaque job key.

If a definition still lacks a verified source, the reader saves that part and continues reviewing independent parts. The progress report lists the parts with outstanding source checks and those waiting for a prerequisite. **Retry** resumes from the saved work. The complete plan opens after every part passes review.

With the reader running, use that job key to read the same report from PowerShell. Adjust the port if you set `PROOF_READER_PORT`.

```powershell
$jobKey = Read-Host "Reading-plan job key"
Invoke-RestMethod "http://127.0.0.1:8794/api/reading-plan/$jobKey/diagnostics" | ConvertTo-Json -Depth 6
```

The local service keeps the latest 96 events per job across restarts. An interrupted run can show its last recorded stage and retry count. Older jobs can show their saved progress with `historyAvailable` set to `false`. Reading the report leaves the job at its current stage.

## Rebuild

The Windows x64 release includes its Lean runtime. To build the download from a committed revision, use Python 3.11 or later and the official `lean-4.36.0-windows.zip`. The packaging script verifies the archive and includes the compiler, libraries and license notices.

```powershell
python proof-reader/desktop/package-windows.py lean-4.36.0-windows.zip dist/NaoMa-Windows-x64.zip
```

Run `./build.ps1` in PowerShell on x64 Windows with the .NET Framework 4.x compiler. The script verifies the SHA-256 digest of the pinned Microsoft WebView2 SDK package, extracts the three runtime libraries and their notices, and builds the window and its icon. For an offline rebuild, supply the downloaded package path with `-SdkPackage`.

The SDK comes from the [Microsoft WebView2 NuGet package](https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4314.35). Its license and redistribution notices are included beside the executable.
