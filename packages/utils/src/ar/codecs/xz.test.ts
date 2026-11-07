import { expect, test } from "bun:test";
import { xzDecompress } from "./xz";

function x86Sample(): Uint8Array {
	const out = new Uint8Array(1024);
	const view = new DataView(out.buffer);
	let seed = 1;
	let position = 0;
	while (position + 5 <= out.length) {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		out[position] = seed & 1 ? 0xe8 : 0xe9;
		view.setInt32(position + 1, ((seed >>> 8) & 0xffff) - 0x8000, true);
		position += 5;
		for (let pad = seed >>> 30; pad > 0 && position < out.length; pad--) out[position++] = 0x90;
	}
	return out;
}

const X86_FILTERED_XZ =
	"/Td6WFoAAAFpIt42BMGFBYAIBAAhAQwAAAAAALjidCjgA/8CfV0AdKDEwAACUa9LIscYc8oCVZJTUr3p0jClrnFZOhoQXJglsPqzmJu3LYT746zKUfhnY7JzZeNAR+2GIUHTPCWgWoQJeg1wfZhvgcazDOYo7iAvQE9jI/hw+WIMZwHHBWHJa3i7BzvpxBcIqJdeSYuhWM9Zt2jIBj9kIf1WG6IExopEtzXIxApz/fYlPzwQDYm0ahHUUCeLrMRCzKLnCE9ht+LVvPImGa65Ehy/6BQ/Mgouqlg53tI0GyERUIRcSCj48+7rBDI0mxNpoeG1uHCmg4FzYWwY5muLwE/tLH786YzWQkSjJD6aKv8/wdekDuUI0liCZSh5PLfb2mTK9WBIU9G7KR0P3JTZXj4PaF0xEHh3+zUKRBbpcZK+CiwNbQQk8uDWHuW4JP28OdV2hRFXuUdWa3iaNVRar9rmvgOt2il9hbFNBhVUwVtjTpNrFmMrZSePViGhezJ9uOfL01l/vlDz1aNVofNMOidKheKtGpzWVefCfDQb3aJsWOhMh4YO6SKKhCFZMFLP/SjSR6eoxP2nmjax8TFWy4sVW0TYyCF6+tzFVHGy1uLpEeQa/NlIaU3s4Ym2hc17uENmnFu0EbRLdl19IIvoFDJncapznDycNnG0lmYOJ422AgObZ55nSRGpLHhERRgQT1RUBJrNlEAichdGy5+O3vsIl+1g7nd1Kc9sHzydHFPcd/sPuuLFS5zTJEqa1dv6RwGrHkTcwH4mJLpuM/rlctGfXrWA1sTYxOJUzTEKMm2vVH2Ni01jq3i2OXCufNpLGZ2Yn+vyzC/gXBwY70jlNIhfa3tjUlAvsrp4Ds1BQ9Yq2W6bTyGyWQYVkOMw8yy4bEzIxQAAAAADWYLNAAGdBYAIAACzuQdJPjANiwIAAAAAAVla";

test("xz stream filtered with x86 BCJ decodes back to the original machine-code bytes", async () => {
	const decoded = await xzDecompress(Buffer.from(X86_FILTERED_XZ, "base64"), 1 << 20);
	expect(decoded).toEqual(x86Sample());
});
