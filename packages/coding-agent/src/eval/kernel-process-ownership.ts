import { Process } from "@oh-my-pi/pi-natives";

/** Keep earlier live resources and other kernels outside this request's cancellation. */
export function captureKernelChildCleanup(pid: number | undefined): () => Promise<boolean> {
	const root = pid === undefined ? null : Process.fromPid(pid);
	const existing = new Set(root?.children().map(child => child.pid));
	return async () => {
		if (!root) return false;
		try {
			// Native Process objects retain start-time identity; never rediscover a recycled PID.
			const owned = root.children().filter(child => !existing.has(child.pid));
			const settled = await Promise.all(owned.map(child => child.terminate({ gracefulMs: 0, timeoutMs: 1000 })));
			return settled.every(Boolean);
		} catch {
			return false;
		}
	};
}
