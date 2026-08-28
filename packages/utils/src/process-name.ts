import { dlopen, FFIType, ptr } from "bun:ffi";
import * as os from "node:os";

const PR_SET_NAME = 15;

export function setProcessName(name: string): void {
	try {
		process.title = name;
	} catch {}

	if (os.platform() !== "linux") return;

	for (const soname of ["libc.so.6", "libc.so"]) {
		try {
			const libc = dlopen(soname, {
				prctl: {
					args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64],
					returns: FFIType.i32,
				},
			});
			try {
				const buf = Buffer.from(`${name}\0`, "utf8");
				libc.symbols.prctl(PR_SET_NAME, ptr(buf), 0n, 0n, 0n);
			} finally {
				libc.close();
			}
			return;
		} catch {}
	}
}
