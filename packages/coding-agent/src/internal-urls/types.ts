import type { Skill } from "../extensibility/skills";
import type { LocalProtocolOptions } from "./local-protocol";

export interface InternalResource {
	url: string;

	content: string;

	contentType: "text/markdown" | "application/json" | "text/plain";

	size?: number;

	sourcePath?: string;

	notes?: string[];

	immutable?: boolean;

	isDirectory?: boolean;
}

export interface UrlCompletion {
	value: string;

	label?: string;

	description?: string;
}

export interface InternalUrl extends URL {
	rawHost: string;

	rawPathname?: string;

	rawHref?: string;
}

export interface ResolveContext {
	cwd?: string;

	settings?: unknown;

	signal?: AbortSignal;

	localProtocolOptions?: LocalProtocolOptions;

	skills?: readonly Skill[];

	xd?: {
		read(name: string | null): Promise<string>;
	};

	skipDirectoryListing?: boolean;

	pathOnly?: boolean;
}

export interface WriteContext {
	cwd?: string;

	signal?: AbortSignal;

	localProtocolOptions?: LocalProtocolOptions;

	xd?: {
		write(name: string | null, content: string): Promise<void>;
	};
}

export interface ProtocolHandler {
	readonly scheme: string;

	readonly immutable: boolean;

	resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>;

	write?(url: InternalUrl, content: string, context?: WriteContext): Promise<void>;

	complete?(query?: string, context?: ResolveContext): Promise<UrlCompletion[]>;
}
