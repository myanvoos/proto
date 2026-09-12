import { loadNative } from "./loader-state.js";
import { adaptDesktopSession } from "./desktop-adapter.js";



let nativeBindings;

function getNativeBindings() {
	return (nativeBindings ??= loadNative());
}

function lazyNativeExport(name, adapt, isClass = false) {
	let binding;
	let proxy;
	const localProperties = new Map();
	const deletedProperties = new Set();
	const proxyTarget = function lazyNativeBinding(...args) {
		return Reflect.apply(getBinding(), this, args);
	};

	const getBinding = () => {
		if (binding === undefined) {
			const bindings = getNativeBindings();
			binding = adapt ? adapt(bindings) : bindings[name];
			if (binding === undefined) {
				throw new Error(`Native binding ${name} is unavailable`);
			}
			if (isClass && typeof binding === "function" && binding.prototype) {
				try {
					Object.defineProperty(binding.prototype, "constructor", {
						value: proxy,
						configurable: true,
						enumerable: false,
						writable: true,
					});
				} catch {}
			}
		}
		return binding;
	};

	const localValue = property => {
		const descriptor = localProperties.get(property);
		if (!descriptor) return undefined;
		return "value" in descriptor ? descriptor.value : descriptor.get?.call(proxy);
	};

	const syncLocalDescriptor = property => {
		const descriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, property);
		if (descriptor) localProperties.set(property, descriptor);
		return descriptor;
	};

	const materializeBinding = () => {
		const target = getBinding();
		for (const property of Reflect.ownKeys(target)) {
			if (localProperties.has(property) || deletedProperties.has(property)) continue;
			const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
			if (!descriptor) continue;
			const targetDescriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, property);
			const materialized =
				targetDescriptor && !targetDescriptor.configurable
					? {
							...descriptor,
							configurable: false,
							enumerable: targetDescriptor.enumerable,
							...(typeof targetDescriptor.writable === "boolean" && "value" in descriptor
								? { writable: targetDescriptor.writable && (descriptor.writable ?? true) }
								: {}),
						}
					: descriptor;
			try {
				Reflect.defineProperty(proxyTarget, property, materialized);
			} catch {}
		}
	};

	proxy = new Proxy(proxyTarget, {
		apply(_target, thisArg, args) {
			return Reflect.apply(getBinding(), thisArg, args);
		},
		construct(_target, args, newTarget) {
			const target = getBinding();
			return Reflect.construct(target, args, newTarget === proxy ? target : newTarget);
		},
		get(_target, property, receiver) {
			if (localProperties.has(property)) return localValue(property);
			const targetValue = Reflect.get(proxyTarget, property, receiver);
			if (deletedProperties.has(property)) return targetValue;
			const target = getBinding();
			return Reflect.getOwnPropertyDescriptor(target, property)
				? Reflect.get(target, property, receiver)
				: targetValue;
		},
		set(_target, property, value) {
			const targetDescriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, property);
			if (targetDescriptor && !targetDescriptor.configurable && targetDescriptor.writable === false) return false;
			const descriptor = localProperties.get(property) ?? targetDescriptor;
			if (descriptor && ("get" in descriptor || "set" in descriptor)) {
				if (!descriptor.set) return false;
				descriptor.set.call(proxy, value);
				return true;
			}
			if (descriptor?.writable === false) return false;
			const nextDescriptor = {
				...(descriptor ?? {}),
				value,
				writable: descriptor?.writable ?? true,
				enumerable: descriptor?.enumerable ?? true,
				configurable: descriptor?.configurable ?? true,
			};
			if (!Reflect.defineProperty(proxyTarget, property, nextDescriptor)) return false;
			deletedProperties.delete(property);
			localProperties.set(property, nextDescriptor);
			return true;
		},
		defineProperty(_target, property, descriptor) {
			const targetDescriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, property);
			const createsNonConfigurable = descriptor.configurable === false || (descriptor.configurable === undefined && !targetDescriptor);
			if (createsNonConfigurable) materializeBinding();
			if (!Reflect.defineProperty(proxyTarget, property, descriptor)) return false;
			deletedProperties.delete(property);
			syncLocalDescriptor(property);
			return true;
		},
		deleteProperty(_target, property) {
			if (localProperties.has(property)) {
				if (!Reflect.deleteProperty(proxyTarget, property)) return false;
				localProperties.delete(property);
				deletedProperties.add(property);
				return true;
			}
			if (binding === undefined) {
				const targetDescriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, property);
				const deleted = Reflect.deleteProperty(proxyTarget, property);
				if (deleted && targetDescriptor) deletedProperties.add(property);
				return deleted;
			}
			const deleted = Reflect.deleteProperty(getBinding(), property);
			if (!deleted) return false;
			const targetDescriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, property);
			const targetDeleted = !targetDescriptor || Reflect.deleteProperty(proxyTarget, property);
			if (targetDeleted) deletedProperties.add(property);
			return targetDeleted;
		},
		has(_target, property) {
			if (localProperties.has(property)) return true;
			if (deletedProperties.has(property)) return false;
			return binding === undefined ? Reflect.has(proxyTarget, property) : Reflect.has(getBinding(), property);
		},
		ownKeys() {
			// Reflection is an explicit binding access: materialize first so ownKeys and
			// getOwnPropertyDescriptor report one coherent target-backed surface.
			materializeBinding();
			const keys = new Set(Reflect.ownKeys(proxyTarget));
			for (const property of localProperties.keys()) keys.add(property);
			return [...keys];
		},
		getOwnPropertyDescriptor(_target, property) {
			const targetDescriptor = Reflect.getOwnPropertyDescriptor(proxyTarget, property);
			if (localProperties.has(property)) return targetDescriptor ?? localProperties.get(property);

			if (targetDescriptor || binding !== undefined) {
				const descriptor = Reflect.getOwnPropertyDescriptor(getBinding(), property);
				if (descriptor) {
					if (!targetDescriptor) return { ...descriptor, configurable: true };
					if (!targetDescriptor.configurable) {
						return {
							...descriptor,
							configurable: false,
							enumerable: targetDescriptor.enumerable,
							...(typeof targetDescriptor.writable === "boolean" && "value" in descriptor
								? { writable: targetDescriptor.writable && (descriptor.writable ?? true) }
								: {}),
						};
					}
					return descriptor;
				}
			}
			return targetDescriptor;
		},
		preventExtensions() {
			materializeBinding();
			return Reflect.preventExtensions(proxyTarget);
		},
		setPrototypeOf(_target, prototype) {
			return Reflect.setPrototypeOf(proxyTarget, prototype);
		},
	});
	return proxy;
}
// --- generated native exports (do not edit) ---
// classes
export const DesktopSession = lazyNativeExport("DesktopSession", bindings => adaptDesktopSession(bindings.DesktopSession), true);
export const FileLock = lazyNativeExport("FileLock", undefined, true);
export const HighlightStream = lazyNativeExport("HighlightStream", undefined, true);
export const MacAppearanceObserver = lazyNativeExport("MacAppearanceObserver", undefined, true);
export const MacOSPowerAssertion = lazyNativeExport("MacOSPowerAssertion", undefined, true);
export const Process = lazyNativeExport("Process", undefined, true);
export const PtySession = lazyNativeExport("PtySession", undefined, true);
export const Shell = lazyNativeExport("Shell", undefined, true);
export const TtyWriter = lazyNativeExport("TtyWriter", undefined, true);

// functions
export const __ompInstallTokioRuntime = lazyNativeExport("__ompInstallTokioRuntime");
export const __piNativesV18_1_6 = lazyNativeExport("__piNativesV18_1_6");
export const astEdit = lazyNativeExport("astEdit");
export const astGrep = lazyNativeExport("astGrep");
export const astMatch = lazyNativeExport("astMatch");
export const blockRangeAt = lazyNativeExport("blockRangeAt");
export const codeOutline = lazyNativeExport("codeOutline");
export const copyToClipboard = lazyNativeExport("copyToClipboard");
export const cosineSimilarityPairs = lazyNativeExport("cosineSimilarityPairs");
export const countTokens = lazyNativeExport("countTokens");
export const detectMacOSAppearance = lazyNativeExport("detectMacOSAppearance");
export const deviceCheckGenerateToken = lazyNativeExport("deviceCheckGenerateToken");
export const diffLineRuns = lazyNativeExport("diffLineRuns");
export const diffLines = lazyNativeExport("diffLines");
export const diffWords = lazyNativeExport("diffWords");
export const enclosingBlockBoundaries = lazyNativeExport("enclosingBlockBoundaries");
export const encodeSixel = lazyNativeExport("encodeSixel");
export const executeShell = lazyNativeExport("executeShell");
export const extractSegments = lazyNativeExport("extractSegments");
export const fuzzyFind = lazyNativeExport("fuzzyFind");
export const getSupportedLanguages = lazyNativeExport("getSupportedLanguages");
export const getWorkProfile = lazyNativeExport("getWorkProfile");
export const glob = lazyNativeExport("glob");
export const grep = lazyNativeExport("grep");
export const hasMatch = lazyNativeExport("hasMatch");
export const highlightCode = lazyNativeExport("highlightCode");
export const htmlToMarkdown = lazyNativeExport("htmlToMarkdown");
export const invalidateFsScanCache = lazyNativeExport("invalidateFsScanCache");
export const isoBackend = lazyNativeExport("isoBackend");
export const isoDiff = lazyNativeExport("isoDiff");
export const isoIsUnavailableError = lazyNativeExport("isoIsUnavailableError");
export const isoProbe = lazyNativeExport("isoProbe");
export const isoResolve = lazyNativeExport("isoResolve");
export const isoStart = lazyNativeExport("isoStart");
export const isoStop = lazyNativeExport("isoStop");
export const listWorkspace = lazyNativeExport("listWorkspace");
export const macOSAutocorrectWord = lazyNativeExport("macOSAutocorrectWord");
export const macOSCheckSpelling = lazyNativeExport("macOSCheckSpelling");
export const macOSCompleteWord = lazyNativeExport("macOSCompleteWord");
export const macOSSpellCheckerAvailable = lazyNativeExport("macOSSpellCheckerAvailable");
export const macOSSpellingGuesses = lazyNativeExport("macOSSpellingGuesses");
export const matchesKey = lazyNativeExport("matchesKey");
export const matchesKittySequence = lazyNativeExport("matchesKittySequence");
export const matchesLegacySequence = lazyNativeExport("matchesLegacySequence");
export const mmrRerankIndices = lazyNativeExport("mmrRerankIndices");
export const nodeChainAt = lazyNativeExport("nodeChainAt");
export const parseKey = lazyNativeExport("parseKey");
export const parseKittySequence = lazyNativeExport("parseKittySequence");
export const pdfToMarkdown = lazyNativeExport("pdfToMarkdown");
export const readImageFromClipboard = lazyNativeExport("readImageFromClipboard");
export const search = lazyNativeExport("search");
export const setHangulCompatJamoWidthOverride = lazyNativeExport("setHangulCompatJamoWidthOverride");
export const sliceWithWidth = lazyNativeExport("sliceWithWidth");
export const structuredPatchHunks = lazyNativeExport("structuredPatchHunks");
export const summarizeCode = lazyNativeExport("summarizeCode");
export const supportsLanguage = lazyNativeExport("supportsLanguage");
export const truncateToWidth = lazyNativeExport("truncateToWidth");
export const vectorIndexTopK = lazyNativeExport("vectorIndexTopK");
export const visibleWidth = lazyNativeExport("visibleWidth");
export const wrapTextWithAnsi = lazyNativeExport("wrapTextWithAnsi");

// string/numeric enums (napi-rs string_enum produces TS-only const enum)
export const AstMatchStrictness = {
	Cst: "cst",
	Smart: "smart",
	Ast: "ast",
	Relaxed: "relaxed",
	Signature: "signature",
	Template: "template",
};
export const Ellipsis = {
	Unicode: 0,
	Ascii: 1,
	Omit: 2,
};
export const Encoding = {
	O200kBase: "O200kBase",
	Cl100kBase: "Cl100kBase",
	ClaudeV3: "ClaudeV3",
	ClaudeV47: "ClaudeV47",
	ClaudeV5: "ClaudeV5",
	ClaudeV5Sonnet: "ClaudeV5Sonnet",
	Qwen3: "Qwen3",
	DeepSeekV3: "DeepSeekV3",
	KimiK2: "KimiK2",
	Glm5: "Glm5",
};
export const FileType = {
	File: 1,
	Dir: 2,
	Symlink: 3,
};
export const FsObservationKind = {
	Read: "read",
	Write: "write",
};
export const GrepOutputMode = {
	Content: "content",
	Count: "count",
	FilesWithMatches: "filesWithMatches",
};
export const IsoBackendKind = {
	Apfs: 0,
	Btrfs: 1,
	Zfs: 2,
	LinuxReflink: 3,
	Overlayfs: 4,
	Rcopy: 7,
};
export const IsoChangeKind = {
	Added: 0,
	Modified: 1,
	Removed: 2,
};
export const KeyEventType = {
	Press: 1,
	Repeat: 2,
	Release: 3,
};
export const MacOSAppearance = {
	Dark: "dark",
	Light: "light",
};
export const ProcessStatus = {
	Running: "running",
	Exited: "exited",
};
// --- end generated native exports ---

