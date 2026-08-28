interface ParsedPluginSpec {
	packageName: string;

	features: string[] | null | "*";
}

export function parsePluginSpec(spec: string): ParsedPluginSpec {
	const bracketStart = spec.lastIndexOf("[");
	const bracketEnd = spec.lastIndexOf("]");

	if (bracketStart === -1 || bracketEnd === -1 || bracketEnd < bracketStart) {
		return { packageName: spec, features: null };
	}

	const packageName = spec.slice(0, bracketStart);
	const featureStr = spec.slice(bracketStart + 1, bracketEnd).trim();

	if (featureStr === "*") {
		return { packageName, features: "*" };
	}

	if (featureStr === "") {
		return { packageName, features: [] };
	}

	const features = featureStr
		.split(",")
		.map(f => f.trim())
		.filter(Boolean);

	return { packageName, features };
}

export function extractPackageName(specifier: string): string {
	const npmSpecifier = specifier.replace(/^npm:/i, "");

	if (npmSpecifier.startsWith("@")) {
		const match = npmSpecifier.match(/^(@[^/]+\/[^@]+)/);
		return match ? match[1] : npmSpecifier;
	}

	return npmSpecifier.replace(/@[^@]+$/, "");
}
