export const Flag = {
	Class: 0x1000,
	ThinkingLoop: 0x0001_0000,
	Transient: 0x0002_0000,
	Timeout: 0x0004_0000,
	UsageLimit: 0x0008_0000,
	StaleResponsesItem: 0x0010_0000,
	MalformedFunctionCall: 0x0020_0000,
	ProviderFinishError: 0x0040_0000,
	EmptyResponse: 0x0000_2000,
	ContentBlocked: 0x0000_8000,

	AccountPolicy: 0x0000_4000,
	ContextOverflow: 0x0080_0000,
	AuthFailed: 0x0100_0000,
	SilentAbort: 0x0200_0000,
	UserInterrupt: 0x0400_0000,
	Abort: 0x0800_0000,

	Grammar: 0x1000_0000,

	FastModeUnsupported: 0x2000_0000,

	// Outside the raw HTTP status range, while retaining the existing high-bit layout.
	CacheControlUnsupported: 0x0000_0800,

	OAuthExpiry: 0x4000_0000,

	PayloadRejected: 0x8000_0000,
} as const;

export type Flag = (typeof Flag)[keyof typeof Flag];

export function create(...flags: number[]): number {
	let bits = 0;
	for (const f of flags) bits |= f;
	return bits | Flag.Class;
}

export function is(id: number | undefined, flag: Flag): boolean {
	return ((id ?? 0) & flag) !== 0;
}

export function attach<E extends object>(error: E, id: number): E {
	Object.defineProperty(error, "errorId", { value: id, enumerable: false, configurable: true });
	return error;
}
