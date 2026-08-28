const startTime = Bun.nanoseconds();
const resolved = new Set<string>();

Bun.plugin({
	name: "trace-loader",
	setup(build) {
		build.onResolve({ filter: /.*/ }, args => {
			if (resolved.has(args.path)) {
				return undefined;
			}
			resolved.add(args.path);

			const elapsed = ((Bun.nanoseconds() - startTime) / 1e6).toFixed(1);

			if (!args.path.includes("node_modules") && !args.path.startsWith("node:")) {
				const shortPath = args.path.replace(process.cwd(), ".");
				process.stderr.write(`[${elapsed}ms] resolve: ${shortPath}\n`);
			}

			return undefined;
		});
	},
});

process.stderr.write(`[trace-loader] preload active\n`);
