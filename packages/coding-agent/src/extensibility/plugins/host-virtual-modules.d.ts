declare module "proto-host-modules" {
	/** Lazy host package namespace loaders retained for compiled extension imports. */
	export const BUNDLED_HOST_MODULE_LOADERS: Readonly<Record<string, () => Promise<Readonly<Record<string, unknown>>>>>;
}
