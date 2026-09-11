const mem = () => {
	const roll = require("node:fs").readFileSync("/proc/self/smaps_rollup", "utf8");
	const anon = Number(roll.match(/Anonymous:\s+(\d+) kB/)![1]) / 1024;
	return `rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)}MB anon ${anon.toFixed(0)}MB objs ${require("bun:jsc").heapStats().objectCount}`;
};
console.log(`bare: ${mem()}`);
for (const m of ["./src/api-registry", "./src/auth-retry", "./src/error", "./src/providers/anthropic", "./src/providers/openai-completions", "./src/providers/openai-responses", "./src/stream", "./src/registry", "./src/types", "./src/usage", "./src/auth-storage", "./src/auth-broker", "./src/auth-gateway"]) {
	await import(m);
	console.log(`${m}: ${mem()}`);
}
