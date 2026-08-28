declare module "proto-host-modules" {
	export const BUNDLED_HOST_MODULE_LOADERS: Readonly<Record<string, () => Promise<Readonly<Record<string, unknown>>>>>;
}
