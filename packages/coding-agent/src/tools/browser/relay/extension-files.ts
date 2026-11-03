/**
 * The relay extension's files as proto installs them, and the checks that let a
 * relay rewrite an installed copy in place (extension self-update).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import backgroundJs from "./extension-assets/background.js.txt" with { type: "text" };
import licenseText from "./extension-assets/LICENSE.txt" with { type: "text" };
import manifestJson from "./extension-assets/manifest.json.txt" with { type: "text" };
import optionsHtml from "./extension-assets/options.html.txt" with { type: "text" };
import optionsJs from "./extension-assets/options.js.txt" with { type: "text" };
import thirdPartyNotices from "./extension-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import { stampRelayExtensionManifest, stampRelayExtensionScript } from "./protocol";

/** The extension files `proto browser-relay install` writes, stamped with the installing proto's version. */
export function relayExtensionFiles(protoVersion: string): Record<string, string> {
	return {
		// The extension reports this stamp in its hello, so proto can tell when an older install keeps running.
		"background.js": stampRelayExtensionScript(backgroundJs, protoVersion),
		LICENSE: licenseText,
		// Shown in chrome://extensions.
		"manifest.json": stampRelayExtensionManifest(manifestJson, protoVersion),
		"options.html": optionsHtml,
		"options.js": optionsJs,
		"THIRD-PARTY-NOTICES.txt": thirdPartyNotices,
	};
}

/** Where `proto browser-relay install` puts the extension without `--dir` (~/.proto/browser-relay/extension). */
export function defaultRelayExtensionDir(): string {
	return path.join(getBrowserRelayDir(), "extension");
}

/**
 * Write the extension files of `protoVersion` into `dir`. Each changed file is
 * written beside its target and renamed over it, so Chrome never reads a
 * partly written file: a reload that meets a broken manifest unloads the
 * extension until the user reloads it by hand. `background.js` goes last: its
 * stamp is the version the extension reports, so a write that fails midway
 * leaves it reporting the old one and the update is tried again.
 */
export async function writeRelayExtension(dir: string, protoVersion: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const files = relayExtensionFiles(protoVersion);
	const names = Object.keys(files).filter(name => name !== "background.js");
	names.push("background.js");
	for (const name of names) {
		const target = path.join(dir, name);
		const content = files[name]!;
		const current = await Bun.file(target)
			.text()
			.catch(() => null);
		if (current === content) continue;
		await atomicWriteFile(target, content, { mode: 0o644 });
	}
}

/**
 * The id Chrome gives an extension loaded unpacked from `dir` (a manifest without a `key`, like the relay's), or
 * null when `dir` does not exist. Chrome makes the path absolute (`base::MakeAbsoluteFilePath`: `realpath` on
 * macOS and Linux, `_wfullpath` on Windows, which keeps links) and hashes it with {@link extensionIdForPath}.
 */
export async function unpackedExtensionId(dir: string): Promise<string | null> {
	try {
		await fs.access(dir);
		return extensionIdForPath(process.platform === "win32" ? path.resolve(dir) : await fs.realpath(dir));
	} catch {
		return null;
	}
}

/**
 * Chromium's `crx_file::id_util::GenerateIdForPath`: the first 128 bits of the SHA-256 of the path's native
 * bytes (UTF-16LE on Windows, after upper-casing a drive letter), written as letters a-p.
 */
export function extensionIdForPath(absolutePath: string, platform: NodeJS.Platform = process.platform): string {
	const bytes =
		platform === "win32"
			? Buffer.from(
					absolutePath.replace(/^[a-z]:/, drive => drive.toUpperCase()),
					"utf16le",
				)
			: Buffer.from(absolutePath, "utf8");
	const hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 32);
	return Array.from(hex, digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

/** The proto version stamped in `dir`'s manifest; "" when it has none or cannot be read. */
export async function installedRelayExtensionVersion(dir: string): Promise<string> {
	try {
		const manifest: unknown = await Bun.file(path.join(dir, "manifest.json")).json();
		if (typeof manifest === "object" && manifest !== null && "version_name" in manifest) {
			return typeof manifest.version_name === "string" ? manifest.version_name : "";
		}
	} catch {
		// Absent or unreadable: no stamp.
	}
	return "";
}
