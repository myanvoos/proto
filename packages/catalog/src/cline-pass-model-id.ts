const CLINEPASS_WIRE_PREFIX = "cline-pass/";

export function toClinePassWireModelId(modelId: string): string {
	return modelId.startsWith(CLINEPASS_WIRE_PREFIX) ? modelId : `${CLINEPASS_WIRE_PREFIX}${modelId}`;
}

export function toClinePassPublicModelId(modelId: string): string {
	return modelId.startsWith(CLINEPASS_WIRE_PREFIX) ? modelId.slice(CLINEPASS_WIRE_PREFIX.length) : modelId;
}
