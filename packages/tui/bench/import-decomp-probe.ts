// Usage: bun import-decomp-probe.ts <target>  — prints import ms + rss for one module.
const target = process.argv[2]!;
const t0 = performance.now();
await import(target);
console.log(JSON.stringify({ target, ms: performance.now() - t0, rssMb: process.memoryUsage.rss() / 1024 / 1024 }));
process.exit(0);
