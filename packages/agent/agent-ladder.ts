const mem = () => {
	const roll = require("node:fs").readFileSync("/proc/self/smaps_rollup", "utf8");
	const anon = Number(roll.match(/Anonymous:\s+(\d+) kB/)![1]) / 1024;
	return `rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)}MB anon ${anon.toFixed(0)}MB objs ${require("bun:jsc").heapStats().objectCount}`;
};
console.log(`bare: ${mem()}`);
for (const m of ["@oh-my-pi/pi-ai", "./src/tokenizer", "./src/telemetry", "./src/proxy", "./src/compaction/index", "./src/agent", "./src/agent-loop"]) {
	await import(m);
	console.log(`${m}: ${mem()}`);
}
