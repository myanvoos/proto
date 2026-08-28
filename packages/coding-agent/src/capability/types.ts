export interface LoadContext {
	cwd: string;

	home: string;

	repoRoot: string | null;
}

export interface LoadResult<T> {
	items: T[];

	warnings?: string[];
}

export interface Provider<T> {
	id: string;

	displayName: string;

	description: string;

	priority: number;

	load(ctx: LoadContext): Promise<LoadResult<T>>;
}

export interface LoadOptions<T = unknown> {
	providers?: string[];

	excludeProviders?: string[];

	cwd?: string;

	includeInvalid?: boolean;

	includeDisabled?: boolean;

	disabledExtensions?: string[];

	filter?(item: T & { _source: SourceMeta }): boolean;

	suppress?(item: T & { _source: SourceMeta }): boolean;
}

export interface SourceMeta {
	provider: string;

	providerName: string;

	path: string;

	level: "user" | "project" | "native";
}

export interface CapabilityResult<T> {
	items: Array<T & { _source: SourceMeta }>;

	all: Array<T & { _source: SourceMeta; _shadowed?: boolean }>;

	warnings: string[];

	providers: string[];
}

export interface Capability<T> {
	id: string;

	displayName: string;

	description: string;

	key(item: T): string | undefined;

	equivalent?(left: T, right: T): boolean;

	validate?(item: T): string | undefined;

	toExtensionId?(item: T): string | undefined;

	providers: Provider<T>[];
}

export interface CapabilityInfo {
	id: string;
	displayName: string;
	description: string;
	providers: Array<{
		id: string;
		displayName: string;
		description: string;
		priority: number;
		enabled: boolean;
	}>;
}

export interface ProviderInfo {
	id: string;
	displayName: string;
	description: string;
	priority: number;

	capabilities: string[];

	enabled: boolean;
}
