import { expect, test } from "bun:test";

async function runPython(body: string): Promise<void> {
	const source = `import runpy\nns = runpy.run_path(${JSON.stringify(`${import.meta.dir}/runner.py`)})\n${body}`;
	const proc = Bun.spawn(["python3", "-c", source], { stdout: "pipe", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	expect(code, stderr).toBe(0);
}

test("shell quoting cannot turn following Python strings into magic commands", async () => {
	await runPython(String.raw`
transform = ns['transform_cell']
source = '!echo "unterminated\ntext = """\n!not_a_command\n%not_a_magic\n"""\nif True:\n    !echo done'
translated = transform(source)
seen = []
scope = {'__proto_shell': seen.append}
exec(translated, scope)
assert seen == ['echo "unterminated', 'echo done'], seen
assert scope['text'] == '\n!not_a_command\n%not_a_magic\n'
`);
});

test("displayed large Python integers are exact while booleans stay booleans", async () => {
	await runPython(`
value = ns['_safe_display_json']({'ids': [9007199254740993, -9007199254740993, 42, True]})
assert value == {'ids': ['9007199254740993', '-9007199254740993', 42, True]}, value
assert type(value['ids'][-1]) is bool
`);
});

test("pip bootstraps a missing module without translating pip arguments", async () => {
	await runPython(`
run = ns['_run_pip']
g = run.__globals__
calls = []
g['_has_pip'] = lambda: False
g['_bootstrap_pip'] = lambda: calls.append('bootstrap') or 0
g['_run_installer'] = lambda argv, on_text=None: calls.append(argv) or 0
g['_emit_status'] = lambda *a, **kw: None
args = ['--isolated', '--proxy', 'install', 'list']
run(args, '--isolated --proxy install list')
assert calls == ['bootstrap', [g['sys'].executable, '-m', 'pip', *args]], calls
`);
});

for (const guarded of [false, true]) {
	test(`${guarded ? "procfs-less guarded" : "ordinary"} installer cancellation kills descendants before returning`, async () => {
		await runPython(`
import os, signal, subprocess, sys, tempfile
run = ns[${guarded ? "'_run_guarded_installer'" : "'_run_installer'"}]
g = run.__globals__
g['_procfs_usable'] = lambda: True
with tempfile.TemporaryDirectory() as directory:
    pid_file = os.path.join(directory, 'child.pid')
    child = 'import time; time.sleep(60)'
    parent = 'import subprocess,sys,time; p=subprocess.Popen([sys.executable,"-c",' + repr(child) + ']); open(' + repr(pid_file) + ',"w").write(str(p.pid)); print("ready",flush=True); time.sleep(60)'
    def interrupt(proc, on_text=None):
        assert proc.stdout.readline().strip() == b'ready'
        raise KeyboardInterrupt()
    g['_stream_process_output'] = interrupt
    try:
        run([sys.executable, '-c', parent], None, None)
        raise AssertionError('cancel did not propagate')
    except KeyboardInterrupt:
        pass
    pid = int(open(pid_file).read())
    # A killed child can remain an unreaped zombie briefly; ps distinguishes it from live work.
    result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='], capture_output=True)
    assert not result.stdout.strip() or result.stdout.strip().startswith(b'Z'), result.stdout
`);
	});
}
