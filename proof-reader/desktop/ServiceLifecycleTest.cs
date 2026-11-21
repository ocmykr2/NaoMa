using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

// Console entry point used by desktop-service.test.cjs. All child processes,
// ports and control files belong to the temporary fixture.
internal static class ServiceLifecycleTest
{
    private static string root;
    private static int port;
    private static bool useHttp;
    private static readonly string identity = new string('7', 64);
    private static ReaderService Reader() { return new ReaderService(root, identity, port, useHttp ? null : new FixtureTransport()); }
    // Windows AppContainer can isolate loopback connections. Read the same
    // identity bytes from the live fixture's per-PID file in that test mode.
    // Process ownership, exits, replacement, shutdown and budgets stay real.
    private sealed class FixtureTransport : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Check(request.RequestUri.Port == port && request.RequestUri.AbsolutePath == "/api/reader-identity", "Unexpected identity route.");
            int[] pids = Pids();
            if (pids.Length == 0) throw new HttpRequestException("No fixture is listening.");
            int pid = pids.Last();
            try
            {
                using (var child = Process.GetProcessById(pid))
                    if (child.HasExited) throw new HttpRequestException("Fixture has exited.");
            }
            catch (ArgumentException) { throw new HttpRequestException("Fixture has exited."); }
            string response = File.ReadAllText(Path.Combine(root, "identity-" + pid));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(response) });
        }
    }
    private static int[] Pids() { return File.ReadAllLines(Path.Combine(root, "pids")).Select(Int32.Parse).ToArray(); }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static void ExitFixture(int pid)
    {
        using (var child = Process.GetProcessById(pid))
        {
            File.WriteAllText(Path.Combine(root, "exit-" + pid), "");
            Check(child.WaitForExit(4000), "Fixture did not take its controlled exit.");
        }
    }
    private static Process StartOther(string node)
    {
        var start = new ProcessStartInfo(node, "server.cjs") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true };
        start.EnvironmentVariables["PROOF_READER_PORT"] = port.ToString();
        var child = Process.Start(start);
        for (int i = 0; i < 150; i++)
        {
            if (Pids().Contains(child.Id)) return child;
            System.Threading.Thread.Sleep(20);
        }
        child.Kill(); child.Dispose(); throw new Exception("External fixture did not listen.");
    }
    private static async Task Run(string node)
    {
        using (var reader = Reader())
        {
            await reader.EnsureStarted();
            Check(!await reader.RecoverOwnedExit(), "A healthy service was replaced.");
            for (int attempt = 0; attempt < 2; attempt++)
            {
                ExitFixture(Pids().Last());
                Check(await reader.RecoverOwnedExit(), "Owned service failed to restart.");
            }
            ExitFixture(Pids().Last());
            try { await reader.RecoverOwnedExit(); throw new Exception("Ignored restart limit."); }
            catch (InvalidOperationException e) { Check(e.Message.Contains("Two restarts") && e.Message.Contains("23"), "Missing exit diagnostic."); }
            Check(!await reader.RecoverOwnedExit() && Pids().Length == 3, "Exceeded restart limit.");
        }
        using (var reader = Reader())
        {
            await reader.EnsureStarted();
            using (var child = Process.GetProcessById(Pids().Last()))
            {
                reader.Dispose();
                Check(child.WaitForExit(4000), "Closing the reader left an owned service running.");
                Check(!await reader.RecoverOwnedExit(), "A closed reader restarted its service.");
            }
        }
        using (var other = StartOther(node))
        using (var reader = Reader())
        {
            try
            {
                await reader.EnsureStarted();
                Check(Pids().Last() == other.Id, "Reused installation spawned another server.");
                ExitFixture(other.Id);
                Check(!await reader.RecoverOwnedExit() && Pids().Last() == other.Id, "Reader relaunched a borrowed service.");
            }
            finally { if (!other.HasExited) other.Kill(); }
        }
        using (var reader = Reader())
        {
            await reader.EnsureStarted();
            ExitFixture(Pids().Last());
            File.WriteAllText(Path.Combine(root, "foreign"), "");
            using (var other = StartOther(node))
            {
                try
                {
                    try { await reader.RecoverOwnedExit(); throw new Exception("Accepted the wrong installation."); }
                    catch (InvalidOperationException e) { Check(e.Message.Contains("different service") && e.Message.Contains("23"), "Missing port conflict diagnostic."); }
                    reader.Dispose();
                    Check(!other.HasExited && Pids().Last() == other.Id, "Reader changed the foreign process.");
                }
                finally { if (!other.HasExited) other.Kill(); }
            }
        }
    }
    private static int Main(string[] args)
    {
        root = args[0];
        useHttp = args[2] == "http";
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start(); port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop();
        try { Run(args[1]).GetAwaiter().GetResult(); return 0; }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
