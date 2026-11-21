using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("Proof Reader")]
[assembly: System.Reflection.AssemblyProduct("Proof Reader")]

internal static class Program
{
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string root = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName;
        string installation;
        using (var sha = SHA256.Create())
            installation = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "").ToLowerInvariant();
        int port;
        if (!Int32.TryParse(Environment.GetEnvironmentVariable("PROOF_READER_PORT") ?? "8794", out port) || port < 1 || port > 65535)
        {
            MessageBox.Show("Set PROOF_READER_PORT to a port between 1 and 65535.", "Proof Reader");
            return;
        }
        bool first;
        using (var mutex = new Mutex(true, "Local\\ProofReader-" + installation + "-" + port, out first))
        {
            if (!first)
            {
                foreach (var process in Process.GetProcessesByName(Process.GetCurrentProcess().ProcessName))
                using (process)
                {
                    if (process.MainWindowHandle == IntPtr.Zero || process.MainWindowTitle != "Proof Reader") continue;
                    if (IsIconic(process.MainWindowHandle)) ShowWindow(process.MainWindowHandle, 9);
                    SetForegroundWindow(process.MainWindowHandle);
                }
                return;
            }
            using (var service = new ReaderService(root, installation, port))
            using (var window = new ReaderWindow(service)) Application.Run(window);
        }
    }
}

internal sealed class ReaderService : IDisposable
{
    internal readonly Uri Origin;
    private readonly string root, expected;
    private readonly HttpClient client;
    private Process owned;
    private readonly Queue<DateTime> recentRestarts = new Queue<DateTime>();
    private bool disposed;

    internal ReaderService(string root, string installation, int port, HttpMessageHandler transport = null)
    {
        this.root = root;
        Origin = new Uri("http://127.0.0.1:" + port + "/");
        expected = "{\"app\":\"proof-reader\",\"installation\":\"" + installation + "\"}";
        client = new HttpClient(transport ?? new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false });
        client.Timeout = TimeSpan.FromSeconds(2);
        client.MaxResponseContentBufferSize = 2048;
    }

    private async Task<bool> IsRunning()
    {
        try
        {
            using (var response = await client.GetAsync(new Uri(Origin, "api/reader-identity")))
            {
                if (response.IsSuccessStatusCode && response.Content.Headers.ContentLength == Encoding.UTF8.GetByteCount(expected)
                    && await response.Content.ReadAsStringAsync() == expected) return true;
                throw new InvalidOperationException("Port " + Origin.Port + " is in use by a different service. Close that service or set PROOF_READER_PORT to another port.");
            }
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
    }

    private static string FindExecutable(string name)
    {
        foreach (string folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            string directory = folder.Trim().Trim('"');
            if (directory.Length == 0 || !Path.IsPathRooted(directory)) continue;
            string file = Path.Combine(directory, name);
            if (File.Exists(file)) return file;
        }
        return null;
    }

    private static void AddDesktopCodex(ProcessStartInfo start)
    {
        if (FindExecutable("codex.exe") != null) return;
        const string packages = @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";
        using (var key = Registry.CurrentUser.OpenSubKey(packages))
        {
            if (key == null) return;
            foreach (string id in key.GetSubKeyNames().Where(n => n.StartsWith("OpenAI.Codex_", StringComparison.OrdinalIgnoreCase)).OrderByDescending(n => n))
            using (var pkg = key.OpenSubKey(id))
            {
                var installed = pkg == null ? null : pkg.GetValue("PackageRootFolder") as string;
                if (String.IsNullOrEmpty(installed)) continue;
                var tools = Path.Combine(installed, "app", "resources");
                if (!File.Exists(Path.Combine(tools, "codex.exe"))) continue;
                start.EnvironmentVariables["PATH"] = start.EnvironmentVariables["PATH"] + ";" + tools;
                return;
            }
        }
    }

    internal async Task EnsureStarted()
    {
        if (disposed) return;
        bool running = await IsRunning();
        if (disposed || running) return;
        var node = FindExecutable("node.exe");
        if (node == null) throw new InvalidOperationException("Install Node.js and reopen Proof Reader.");
        var server = Path.Combine(root, "server.cjs");
        if (!File.Exists(server)) throw new FileNotFoundException("Keep the desktop folder alongside the reader's server.cjs.");
        var start = new ProcessStartInfo(node, "\"" + server + "\"") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true };
        start.EnvironmentVariables["PROOF_READER_PORT"] = Origin.Port.ToString();
        AddDesktopCodex(start);
        var child = Process.Start(start);
        owned = child;
        for (int i = 0; i < 45; i++)
        {
            await Task.Delay(200);
            if (disposed) return;
            if (await IsRunning()) return;
            if (disposed) return;
            if (child.HasExited) break;
        }
        throw new InvalidOperationException("The local reading service could not start. Check the reader files and Node.js installation.");
    }

    // The window calls this on its UI thread and suspends its timer while a
    // replacement is starting. Never restart a service owned by another app.
    internal async Task<bool> RecoverOwnedExit()
    {
        if (disposed || owned == null || !owned.HasExited) return false;
        int exitCode = owned.ExitCode;
        owned.Dispose();
        owned = null;
        var now = DateTime.UtcNow;
        while (recentRestarts.Count > 0 && now - recentRestarts.Peek() >= TimeSpan.FromMinutes(10))
            recentRestarts.Dequeue();
        if (recentRestarts.Count >= 2)
            throw new InvalidOperationException("Couldn’t keep the local reading service running. Two restarts in ten minutes reached the limit. Last Node exit code " + exitCode + " on port " + Origin.Port + ".");
        recentRestarts.Enqueue(now);
        try { await EnsureStarted(); }
        catch (Exception error)
        {
            throw new InvalidOperationException("Couldn’t restart the local reading service after Node exited with code " + exitCode + ". " + error.Message, error);
        }
        return !disposed;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        client.Dispose();
        if (owned == null) return;
        try { if (!owned.HasExited) owned.Kill(); } catch (InvalidOperationException) { }
        owned.Dispose();
    }
}

internal sealed class ReaderWindow : Form
{
    private readonly ReaderService service;
    private readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill };
    private readonly Label status = new Label { Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Text = "Opening Proof Reader…" };
    private readonly System.Windows.Forms.Timer monitor = new System.Windows.Forms.Timer { Interval = 2000 };
    private bool closing, pageAvailable;
    private CoreWebView2Environment environment;

    internal ReaderWindow(ReaderService service)
    {
        this.service = service;
        Text = "Proof Reader";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(580, 450);
        var area = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Min(960, area.Width), Math.Min(780, area.Height));
        BackColor = Color.FromArgb(250, 250, 248);
        Controls.Add(view);
        Controls.Add(status);
        status.BringToFront();
        monitor.Tick += CheckService;
        Shown += OpenReader;
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        closing = true;
        monitor.Dispose();
        service.Dispose();
        base.OnFormClosed(e);
    }

    private async void CheckService(object sender, EventArgs e)
    {
        monitor.Stop();
        try
        {
            if (await service.RecoverOwnedExit() && !closing)
            {
                var core = view.CoreWebView2;
                if (pageAvailable) await core.ExecuteScriptAsync("window.dispatchEvent(new Event('online'))");
                else core.Navigate(service.Origin.AbsoluteUri);
            }
            if (!closing) monitor.Start();
        }
        catch (Exception error)
        {
            if (closing) return;
            status.Text = error.Message;
            status.Visible = true;
            status.BringToFront();
        }
    }

    private async void OpenReader(object sender, EventArgs e)
    {
        try
        {
            await service.EnsureStarted();
            if (IsDisposed) return;
            string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ProofReader", "DesktopProfile");
            CoreWebView2Environment.SetLoaderDllFolderPath(AppDomain.CurrentDomain.BaseDirectory);
            environment = await CoreWebView2Environment.CreateAsync(null, profile, null);
            if (IsDisposed) return;
            await view.EnsureCoreWebView2Async(environment);
            var core = view.CoreWebView2;
            Configure(core);
            core.NewWindowRequested += OpenLink;
            core.NavigationCompleted += delegate(object o, CoreWebView2NavigationCompletedEventArgs args) {
                if (closing || IsDisposed) return;
                pageAvailable = args.IsSuccess;
                status.Visible = !args.IsSuccess;
                if (!args.IsSuccess) status.Text = "The reading service could not load. Close and reopen Proof Reader.";
            };
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.PROOF_READER_DESKTOP = true;");
            if (closing || IsDisposed) return;
            core.Navigate(service.Origin.AbsoluteUri);
            monitor.Start();
        }
        catch (Exception error)
        {
            if (IsDisposed) return;
            status.Text = error is WebView2RuntimeNotFoundException ? "Install the Microsoft Edge WebView2 Evergreen Runtime, then reopen Proof Reader." : error.Message;
        }
    }

    private bool Local(string address)
    {
        if (address == "about:blank") return true;
        if (address.StartsWith("blob:", StringComparison.OrdinalIgnoreCase)) address = address.Substring(5);
        Uri uri;
        return Uri.TryCreate(address, UriKind.Absolute, out uri) && uri.Scheme == service.Origin.Scheme && uri.Host == service.Origin.Host && uri.Port == service.Origin.Port;
    }

    private void Configure(CoreWebView2 core)
    {
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsWebMessageEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.NavigationStarting += delegate(object o, CoreWebView2NavigationStartingEventArgs e) {
            if (Local(e.Uri)) return;
            e.Cancel = true;
            if (e.IsUserInitiated) External(e.Uri);
        };
    }

    private void External(string address)
    {
        Uri uri;
        if (!Uri.TryCreate(address, UriKind.Absolute, out uri) || !(uri.Scheme == "https" || uri.Scheme == "http")) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception error) { MessageBox.Show(this, error.Message, "Open paper"); }
    }

    private async void OpenLink(object sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (!e.IsUserInitiated) return;
        if (!Local(e.Uri)) { External(e.Uri); return; }
        var deferral = e.GetDeferral();
        var paper = new Form { Text = "Original paper · Proof Reader", Icon = Icon, Size = Size, StartPosition = FormStartPosition.CenterParent };
        try
        {
            var pdf = new WebView2 { Dock = DockStyle.Fill };
            paper.Controls.Add(pdf);
            paper.Show(this);
            await pdf.EnsureCoreWebView2Async(environment);
            Configure(pdf.CoreWebView2);
            pdf.CoreWebView2.NewWindowRequested += OpenLink;
            e.NewWindow = pdf.CoreWebView2;
        }
        catch (Exception error) { paper.Close(); if (!IsDisposed) MessageBox.Show(this, error.Message, "Open original paper"); }
        finally { deferral.Complete(); }
    }
}
