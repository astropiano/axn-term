// Demo agent stub for the axn-term-online scenario. The session-host image
// hardlinks this binary to /usr/local/bin/{devin,claude,vibe} so workflow
// steps that launch an "agent" visibly start a foreground process (and the
// session picks up the invoked name as its process).
var self = Path.GetFileName(Environment.ProcessPath ?? Environment.GetCommandLineArgs()[0]);

Console.WriteLine($"[{self}] demo agent stub");
if (args.Length > 0)
    Console.WriteLine($"[{self}] args: {string.Join(' ', args)}");
Console.WriteLine($"[{self}] not a real agent — type + Enter echoes, Ctrl-C/Ctrl-D exits");
Console.WriteLine($"[{self}] working…");

string? line;
while ((line = Console.ReadLine()) is not null)
    Console.WriteLine($"[{self}] received: {line}");

Console.WriteLine($"[{self}] exiting");
