/**
 * Test fixture: a legacy coding-agent RPC runtime.
 *
 * Emits a bare `ready` frame (no protocol or capability advertisement) and
 * acknowledges every command. Used to prove a client does not assume newer
 * runtime capabilities after a restart.
 */
process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

for await (const raw of console) {
	if (!raw) continue;
	try {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		if (frame && typeof frame === "object" && typeof frame.type === "string") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			process.stdout.write(
				`${JSON.stringify({ id, type: "response", command: frame.type, success: true, data: {} })}\n`,
			);
		}
	} catch {
		// Ignore parse errors: the client sends well-formed frames.
	}
}
process.exit(0);
