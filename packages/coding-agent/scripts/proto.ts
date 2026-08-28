const launchCwd = process.env.PROTO_LAUNCH_CWD;
if (launchCwd) {
	delete process.env.PROTO_LAUNCH_CWD;
	try {
		process.chdir(launchCwd);
	} catch {}
}
