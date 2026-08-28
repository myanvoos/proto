export function applyCompatOverrides(compat: object, overrides: object | undefined): void {
	if (!overrides) return;
	for (const key in overrides) {
		const value = (overrides as Record<string, unknown>)[key];
		if (value !== undefined && key in compat) {
			(compat as Record<string, unknown>)[key] = value;
		}
	}
}
