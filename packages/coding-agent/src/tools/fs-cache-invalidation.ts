import { invalidateFsScanCache } from "@oh-my-pi/pi-natives";

export function invalidateFsScanAfterWrite(path: string): void {
	invalidateFsScanCache(path);
}

export function invalidateFsScanAfterDelete(path: string): void {
	invalidateFsScanCache(path);
}

export function invalidateFsScanAfterRename(oldPath: string, newPath: string): void {
	invalidateFsScanCache(oldPath);
	if (newPath !== oldPath) {
		invalidateFsScanCache(newPath);
	}
}
