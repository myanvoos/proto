import {
	buildHashBase,
	buildKeyedReplacementRun,
	buildPlaceholder,
	defaultPlaceholderKey,
	inferCaseHint,
	lookupFriendlyPlaceholderAlias,
	MIN_OBFUSCATE_SECRET_LEN,
	PLACEHOLDER_RE,
	placeholderWithoutFriendlyName,
	resumePlaceholderScanAfterRejectedCandidate,
	sanitizedLabelCollidesWithSecret,
	sanitizeForCollisionCheck,
	sanitizeSecretFriendlyName,
} from "./placeholder";
import {
	buildReplaceRegexScan,
	countOutsidePlaceholderRanges,
	deepWalkStrings,
	deobfuscateGeneratedPlaceholderRanges,
	extendPastAdjacentPlaceholders,
	firstOutsidePlaceholderRange,
	mapReplaceRegexMatch,
	outsidePlaceholderRangesAnyIndependentlyMatch,
	placeholderInnerText,
	redactWithFixedReplacementOutsidePlaceholders,
	replaceRange,
	textOutsidePlaceholderRanges,
	trailingOutsidePreservedPlaceholderChunk,
	transformOutsidePlaceholdersTracked,
} from "./placeholder-scan";
import { compileSecretRegex } from "./regex";
import {
	ensureDistinctReplacement,
	findNonMatchingReplacement,
	generateDeterministicReplacement,
	type RegexMatchContext,
	regexHasUnresolvableShortMatchFallback,
	regexRematchesInContext,
} from "./replacement";

export interface SecretEntry {
	type: "plain" | "regex";
	content: string;
	mode?: "obfuscate" | "replace";
	replacement?: string;
	flags?: string;
	friendlyName?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };
export type JsonRecord = { [key: string]: JsonValue | undefined };

export class SecretObfuscator {
	#plainMappings = new Map<string, number>();

	#regexEntries: Array<{ regex: RegExp; mode: "obfuscate" | "replace"; replacement?: string; friendlyName?: string }> =
		[];

	#obfuscateMappings = new Map<number, { secret: string; placeholder: string }>();

	#replaceMappings = new Map<string, string>();

	#deobfuscateMap = new Map<string, { secret: string; recursive: boolean }>();

	#generatedPlaceholders = new Set<string>();

	#generatedReplaceChunks = new Set<string>();

	#configuredSecretValues = new Set<string>();

	#currentRegexSecretValues = new Set<string>();

	#placeholderBaseByKey = new Map<string, string>();

	#placeholderBaseOwners = new Map<string, string>();

	#nextIndex: number;

	#hasAny: boolean;

	#key: string | undefined;
	#keyProvider: (() => string) | undefined;

	constructor(entries: SecretEntry[], key: string | (() => string) = defaultPlaceholderKey()) {
		if (typeof key === "function") {
			this.#keyProvider = key;
		} else {
			this.#setPlaceholderKey(key);
		}

		for (const entry of entries) {
			if (entry.type === "plain") {
				this.#configuredSecretValues.add(entry.content);
				continue;
			}
			try {
				const regex = compileSecretRegex(entry.content, entry.flags);
				const mode = entry.mode ?? "obfuscate";

				if (
					mode === "replace" &&
					entry.replacement === undefined &&
					regexHasUnresolvableShortMatchFallback(regex)
				) {
					continue;
				}
				this.#regexEntries.push({
					regex,
					mode,
					replacement: entry.replacement,
					friendlyName: entry.friendlyName,
				});
			} catch {}
		}
		let index = 0;
		let hasRealSec = this.#regexEntries.length > 0;
		for (const entry of entries) {
			if (entry.type !== "plain") continue;
			const mode = entry.mode ?? "obfuscate";
			if (mode === "obfuscate") {
				if (entry.content.length < MIN_OBFUSCATE_SECRET_LEN) {
					continue;
				}
				const placeholder = this.#createPlaceholder(entry.content, entry.friendlyName);
				this.#plainMappings.set(entry.content, index);
				this.#obfuscateMappings.set(index, { secret: entry.content, placeholder });
				this.#generatedPlaceholders.add(placeholder);
				index++;
				hasRealSec = true;
			} else {
				const replacement = entry.replacement ?? this.#generateSecretReplacement(entry.content);
				this.#replaceMappings.set(entry.content, replacement);
				hasRealSec = true;
			}
		}

		this.#nextIndex = index;
		this.#hasAny = hasRealSec;
	}

	#setPlaceholderKey(key: string): void {
		this.#key = key;
		this.#replaceMappings.set(key, this.#generateSecretReplacement(key));
		this.#configuredSecretValues.add(key);
	}

	#getKey(): string {
		let key = this.#key;
		if (key === undefined) {
			key = this.#keyProvider?.() ?? defaultPlaceholderKey();
			this.#keyProvider = undefined;
			this.#setPlaceholderKey(key);
		}
		return key;
	}

	#willMintRegexPlaceholder(secretValues: ReadonlySet<string>): boolean {
		for (const entry of this.#regexEntries) {
			if (entry.mode !== "obfuscate") continue;
			for (const value of secretValues) {
				entry.regex.lastIndex = 0;
				const matches = entry.regex.test(value);
				entry.regex.lastIndex = 0;
				if (matches) return true;
			}
		}
		return false;
	}

	hasSecrets(): boolean {
		return this.#hasAny;
	}

	obfuscate(text: string, sharedRegexSecretValues?: ReadonlySet<string>): string {
		if (!this.#hasAny) return text;
		this.#currentRegexSecretValues = this.collectRegexSecretValuesForObfuscation(text);
		for (const secretValue of sharedRegexSecretValues ?? []) {
			this.#currentRegexSecretValues.add(secretValue);
		}

		if (this.#keyProvider !== undefined && this.#willMintRegexPlaceholder(this.#currentRegexSecretValues)) {
			this.#getKey();
		}
		let result = text;

		let origin = "I".repeat(text.length);

		for (const [secret, replacement] of [...this.#replaceMappings].sort((a, b) => b[0].length - a[0].length)) {
			({ text: result, origin } = this.#replaceOutsidePlaceholdersTracked(result, origin, secret, replacement, "I"));
		}
		for (const secretValue of this.#collectRegexSecretValues(result)) {
			this.#currentRegexSecretValues.add(secretValue);
		}
		for (const secretValue of this.#collectRegexSecretValuesAfterRegexReplacements(result, origin)) {
			this.#currentRegexSecretValues.add(secretValue);
		}
		for (const secretValue of sharedRegexSecretValues ?? []) {
			this.#currentRegexSecretValues.add(secretValue);
		}
		({ text: result, origin } = this.#stripUnsafeFriendlyPrefixes(result, origin));

		for (const [secret, index] of [...this.#plainMappings].sort((a, b) => b[0].length - a[0].length)) {
			const mapping = this.#obfuscateMappings.get(index)!;
			({ text: result, origin } = this.#replaceOutsidePlaceholdersTracked(
				result,
				origin,
				secret,
				this.#placeholderForCurrentInput(mapping.placeholder),
				"F",
			));
		}

		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const matches = this.#collectRegexMatches(result, entry.regex, entry.mode, origin, entry.replacement);

			for (const match of matches) {
				if (entry.mode === "replace") {
					if (match.preserveGeneratedPlaceholders) {
						if (
							match.preserveInputPlaceholders &&
							entry.replacement === undefined &&
							match.inputPlaceholderOutsideChunkCount === 1 &&
							match.inputPlaceholderOutsideStart >= 0 &&
							origin
								.slice(
									match.inputPlaceholderOutsideStart,
									match.inputPlaceholderOutsideStart + match.inputPlaceholderOutside.length,
								)
								.includes("F") &&
							this.#generatedReplaceChunks.has(match.inputPlaceholderOutside)
						) {
							continue;
						}

						if (
							match.inputPlaceholderInnerIndependentlyMatches &&
							!match.inputPlaceholderOutsideIndependentlyMatches
						) {
							continue;
						}
						let replaceEnd = match.end;
						let span = result.slice(match.start, replaceEnd);
						if (entry.replacement !== undefined) {
							const trailingChunk = trailingOutsidePreservedPlaceholderChunk(span, placeholder =>
								this.#isGeneratedPlaceholder(placeholder),
							);
							if (trailingChunk.length > 0 && entry.replacement.startsWith(trailingChunk)) {
								const trailingSuffix = entry.replacement.slice(trailingChunk.length);
								if (trailingSuffix.length > 0 && result.slice(replaceEnd).startsWith(trailingSuffix)) {
									replaceEnd += trailingSuffix.length;
									span = result.slice(match.start, replaceEnd);
								}
							}
						}

						const spanOrigin = origin.slice(match.start, replaceEnd);
						const redacted =
							entry.replacement !== undefined
								? redactWithFixedReplacementOutsidePlaceholders(
										span,
										spanOrigin,
										entry.replacement,
										placeholder => this.#isGeneratedPlaceholder(placeholder),
									)
								: this.#redactRegexMatchOutsidePlaceholders(span, spanOrigin, entry.regex, match.scanContext);
						result = replaceRange(result, match.start, replaceEnd, redacted.text);
						origin = replaceRange(origin, match.start, replaceEnd, redacted.origin);
					} else {
						const replacement = entry.replacement ?? match.defaultReplacement;
						if (replacement === undefined) {
							throw new Error("regex replace match missing a generated replacement");
						}
						result = replaceRange(result, match.start, match.end, replacement);
						origin = replaceRange(origin, match.start, match.end, "I".repeat(replacement.length));
					}
				} else {
					if (match.scanMatchLength < MIN_OBFUSCATE_SECRET_LEN) {
						continue;
					}
					if (match.preserveInputPlaceholders) {
						if (
							match.inputPlaceholderInnerIndependentlyMatches &&
							!match.inputPlaceholderOutsideIndependentlyMatches
						) {
							continue;
						}
						const span = result.slice(match.start, match.end);
						const spanOrigin = origin.slice(match.start, match.end);
						const obfuscated = this.#obfuscateOutsidePlaceholdersTracked(span, spanOrigin, entry.friendlyName);
						result = replaceRange(result, match.start, match.end, obfuscated.text);
						origin = replaceRange(origin, match.start, match.end, obfuscated.origin);
						continue;
					}

					let index = this.#findObfuscateIndex(match.canonicalValue);
					if (index === undefined) {
						index = this.#nextIndex++;
						const placeholder = this.#createPlaceholder(
							match.canonicalValue,
							entry.friendlyName,
							match.recursive,
						);
						this.#obfuscateMappings.set(index, { secret: match.canonicalValue, placeholder });
						this.#generatedPlaceholders.add(placeholder);
					}
					const mapping = this.#obfuscateMappings.get(index)!;
					const placeholder = this.#placeholderForCurrentInput(mapping.placeholder);
					result = replaceRange(result, match.start, match.end, placeholder);
					origin = replaceRange(origin, match.start, match.end, "F".repeat(placeholder.length));
				}
			}
			if (entry.mode === "replace") {
				for (const secretValue of this.#collectRegexSecretValues(result)) {
					this.#currentRegexSecretValues.add(secretValue);
				}
			}
		}
		({ text: result, origin } = this.#stabilizeReplaceRegexPlaceholderSpillover(result, origin));

		this.#currentRegexSecretValues = new Set();
		return result;
	}

	deobfuscate(text: string): string {
		return this.#deobfuscate(text);
	}

	#lookupLiveAlias(placeholder: string): { secret: string; recursive: boolean } | undefined {
		const direct = this.#deobfuscateMap.get(placeholder);
		if (direct !== undefined) return direct;
		const body = placeholder.slice(2, -2);
		const match = /^([A-Z0-9]+)_([A-Z0-9]{4,}(?::[ULCM])?)$/.exec(body);
		if (match === null || this.#prefixIsSecretShaped(match[1]!)) return undefined;
		return this.#deobfuscateMap.get(`$$${match[2]}$$`);
	}

	#deobfuscate(text: string): string {
		if (!this.#hasAny || !text.includes("$$")) return text;
		let result = text;
		for (;;) {
			let shouldContinue = false;
			const next = result.replace(PLACEHOLDER_RE, match => {
				const mapped = this.#lookupLiveAlias(match);
				if (mapped !== undefined) {
					shouldContinue ||= mapped.recursive;
					return mapped.secret;
				}
				return match;
			});
			if (next === result || !shouldContinue || !next.includes("$$")) return next;
			result = next;
		}
	}

	deobfuscateObject<T>(obj: T): T {
		if (!this.#hasAny) return obj;
		return deepWalkStrings(obj, s => this.deobfuscate(s));
	}

	obfuscateObject<T>(obj: T): T {
		if (!this.#hasAny) return obj;
		return deepWalkStrings(obj, s => this.obfuscate(s));
	}

	#generateReplacement(chunk: string): string {
		const replacement =
			chunk.length <= 2
				? "Z".repeat(chunk.length)
				: `ZZ${buildKeyedReplacementRun(this.#getKey(), chunk.length - 2)}`;
		this.#generatedReplaceChunks.add(replacement);
		return replacement;
	}

	#generateSecretReplacement(secret: string): string {
		const replacement = ensureDistinctReplacement(generateDeterministicReplacement(secret), secret);
		this.#generatedReplaceChunks.add(replacement);
		return replacement;
	}

	#generateRegexReplacement(value: string, regex: RegExp, context: RegexMatchContext): string {
		let replacement = generateDeterministicReplacement(value);

		if (replacement === value || regexRematchesInContext(replacement, regex, context)) {
			const stable = findNonMatchingReplacement(value, regex, context);

			replacement =
				stable ??
				(value.length <= 2
					? buildKeyedReplacementRun(this.#getKey(), value.length)
					: this.#generateReplacement(value));
			regex.lastIndex = 0;
		}
		this.#generatedReplaceChunks.add(replacement);
		return replacement;
	}

	#generateRegexChunkReplacement(chunk: string, regex: RegExp, context: RegexMatchContext): string {
		let replacement = this.#generateReplacement(chunk);
		if (regexRematchesInContext(replacement, regex, context)) {
			const stable = findNonMatchingReplacement(chunk, regex, context);
			if (stable !== undefined) {
				replacement = stable;
				this.#generatedReplaceChunks.add(replacement);
			}
			regex.lastIndex = 0;
		}
		return replacement;
	}

	#redactRegexMatchOutsidePlaceholders(
		text: string,
		origin: string,
		regex: RegExp,
		context: RegexMatchContext,
	): { text: string; origin: string } {
		let scanCursor = context.start;
		return transformOutsidePlaceholdersTracked(
			text,
			origin,
			placeholder => this.#isGeneratedPlaceholder(placeholder),
			chunk => {
				const start = scanCursor;
				scanCursor += chunk.length;
				if (chunk.length === 0) return "";
				return this.#generateRegexChunkReplacement(chunk, regex, {
					text: context.text,
					start,
					end: scanCursor,
				});
			},
			placeholder => {
				scanCursor +=
					lookupFriendlyPlaceholderAlias(this.#deobfuscateMap, placeholder)?.secret.length ?? placeholder.length;
				return placeholder;
			},
		);
	}

	#stabilizeReplaceRegexPlaceholderSpillover(text: string, origin: string): { text: string; origin: string } {
		let result = text;
		let currentOrigin = origin;
		for (const entry of this.#regexEntries) {
			if (entry.mode !== "replace" || entry.replacement !== undefined) continue;
			entry.regex.lastIndex = 0;
			const matches = this.#collectRegexMatches(result, entry.regex, entry.mode, currentOrigin, entry.replacement);
			entry.regex.lastIndex = 0;
			for (const match of matches) {
				if (!match.preserveGeneratedPlaceholders) continue;
				if (
					match.preserveInputPlaceholders &&
					entry.replacement === undefined &&
					match.inputPlaceholderOutsideChunkCount === 1 &&
					match.inputPlaceholderOutsideStart >= 0 &&
					currentOrigin
						.slice(
							match.inputPlaceholderOutsideStart,
							match.inputPlaceholderOutsideStart + match.inputPlaceholderOutside.length,
						)
						.includes("F") &&
					this.#generatedReplaceChunks.has(match.inputPlaceholderOutside)
				) {
					continue;
				}
				if (match.inputPlaceholderInnerIndependentlyMatches && !match.inputPlaceholderOutsideIndependentlyMatches) {
					continue;
				}
				const span = result.slice(match.start, match.end);
				const spanOrigin = currentOrigin.slice(match.start, match.end);
				const redacted =
					entry.replacement !== undefined
						? redactWithFixedReplacementOutsidePlaceholders(span, spanOrigin, entry.replacement, placeholder =>
								this.#isGeneratedPlaceholder(placeholder),
							)
						: this.#redactRegexMatchOutsidePlaceholders(span, spanOrigin, entry.regex, match.scanContext);
				if (redacted.text === span) continue;
				result = replaceRange(result, match.start, match.end, redacted.text);
				currentOrigin = replaceRange(currentOrigin, match.start, match.end, redacted.origin);
			}
		}
		return { text: result, origin: currentOrigin };
	}

	#findObfuscateIndex(secret: string): number | undefined {
		const plainIndex = this.#plainMappings.get(secret);
		if (plainIndex !== undefined) return plainIndex;

		for (const [index, mapping] of this.#obfuscateMappings) {
			if (mapping.secret === secret) return index;
		}
		return undefined;
	}

	#createPlaceholder(secret: string, friendlyName?: string, recursive: boolean = false): string {
		const hint = inferCaseHint(secret);

		const baseKey = secret;

		const requestedFriendlyName = friendlyName ? sanitizeSecretFriendlyName(friendlyName) : undefined;
		const sanitizedFriendlyName =
			requestedFriendlyName !== undefined &&
			friendlyName !== undefined &&
			!this.#friendlyNameCollidesWithSecret(sanitizeForCollisionCheck(friendlyName), friendlyName, secret)
				? requestedFriendlyName
				: undefined;
		const preferredBase = this.#resolvePreferredPlaceholderBase(baseKey);
		const preferredPlaceholder = buildPlaceholder(hint, preferredBase, sanitizedFriendlyName);
		if (!this.#placeholderConflicts(preferredPlaceholder, secret)) {
			this.#registerDeobfuscationAlias(preferredPlaceholder, secret, recursive);
			return preferredPlaceholder;
		}

		for (let attempt = 1; ; attempt++) {
			const fallbackBase = this.#reserveFallbackPlaceholderBase(baseKey, attempt);
			const placeholder = buildPlaceholder(hint, fallbackBase, sanitizedFriendlyName);
			if (!this.#placeholderConflicts(placeholder, secret)) {
				this.#registerDeobfuscationAlias(placeholder, secret, recursive);
				return placeholder;
			}
		}
	}

	#resolvePreferredPlaceholderBase(baseKey: string): string {
		const existing = this.#placeholderBaseByKey.get(baseKey);
		if (existing !== undefined) return existing;

		for (let attempt = 0; ; attempt++) {
			const base =
				attempt === 0
					? buildHashBase(this.#getKey(), baseKey)
					: buildHashBase(this.#getKey(), `${baseKey}\0${attempt}`);
			const owner = this.#placeholderBaseOwners.get(base);
			if (owner !== undefined && owner !== baseKey) continue;
			this.#placeholderBaseOwners.set(base, baseKey);
			this.#placeholderBaseByKey.set(baseKey, base);
			return base;
		}
	}

	#reserveFallbackPlaceholderBase(baseKey: string, startAttempt: number): string {
		for (let attempt = startAttempt; ; attempt++) {
			const owner = `${baseKey}\0collision\0${attempt}`;
			const base = buildHashBase(this.#getKey(), `${baseKey}\0collision\0${attempt}`);
			if (this.#placeholderBaseOwners.has(base)) continue;
			this.#placeholderBaseOwners.set(base, owner);
			return base;
		}
	}

	#placeholderCollides(placeholder: string, secret: string): boolean {
		const existing = this.#deobfuscateMap.get(placeholder);
		return existing !== undefined && existing.secret !== secret;
	}

	#placeholderConflicts(placeholder: string, secret: string): boolean {
		if (this.#placeholderCollides(placeholder, secret)) return true;
		if (this.#configuredSecretValues.has(placeholder) && placeholder !== secret) return true;
		const unprefixed = placeholderWithoutFriendlyName(placeholder);
		if (unprefixed === undefined) return false;
		if (this.#placeholderCollides(unprefixed, secret)) return true;
		return this.#configuredSecretValues.has(unprefixed) && unprefixed !== secret;
	}

	#collectRegexSecretValues(text: string): Set<string> {
		const values = new Set<string>();
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			for (;;) {
				const match = entry.regex.exec(text);
				if (match === null) break;
				if (match[0].length === 0) {
					entry.regex.lastIndex++;
					continue;
				}
				values.add(match[0]);
			}
			entry.regex.lastIndex = 0;
		}
		return values;
	}

	collectRegexSecretValuesForObfuscation(text: string): Set<string> {
		const values = this.#collectRegexSecretValues(text);
		let result = text;
		let origin = "I".repeat(text.length);
		for (const [secret, replacement] of [...this.#replaceMappings].sort((a, b) => b[0].length - a[0].length)) {
			({ text: result, origin } = this.#replaceOutsidePlaceholdersTracked(result, origin, secret, replacement, "I"));
		}
		for (const secretValue of this.#collectRegexSecretValues(result)) {
			values.add(secretValue);
		}
		for (const secretValue of this.#collectRegexSecretValuesAfterRegexReplacements(result, origin)) {
			values.add(secretValue);
		}
		return values;
	}

	#collectRegexSecretValuesAfterRegexReplacements(text: string, origin: string): Set<string> {
		const values = new Set<string>();
		let simulated = text;
		let simulatedOrigin = origin;
		for (const entry of this.#regexEntries) {
			if (entry.mode !== "replace") continue;
			entry.regex.lastIndex = 0;
			const matches = this.#collectRegexMatches(
				simulated,
				entry.regex,
				entry.mode,
				simulatedOrigin,
				entry.replacement,
			);
			entry.regex.lastIndex = 0;
			if (matches.length === 0) continue;
			for (const match of [...matches].sort((a, b) => b.start - a.start)) {
				const replacement = entry.replacement ?? match.defaultReplacement;
				if (replacement === undefined) continue;
				for (const secretValue of this.#collectRegexSecretValues(replacement)) {
					values.add(secretValue);
				}
				simulated = replaceRange(simulated, match.start, match.end, replacement);
				simulatedOrigin = replaceRange(simulatedOrigin, match.start, match.end, "I".repeat(replacement.length));
			}
			for (const secretValue of this.#collectRegexSecretValues(simulated)) {
				values.add(secretValue);
			}
		}
		return values;
	}

	#friendlyNameCollidesWithSecret(sanitizedName: string, rawName: string, secret: string): boolean {
		if (this.#prefixIsSecretShaped(sanitizedName)) return true;
		const sanitizedSecretValue = sanitizeForCollisionCheck(secret);
		if (sanitizedLabelCollidesWithSecret(sanitizedName, sanitizedSecretValue)) return true;
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const matches = entry.regex.test(rawName);
			entry.regex.lastIndex = 0;
			if (matches) return true;
		}
		return false;
	}

	#placeholderForCurrentInput(placeholder: string): string {
		const unprefixed = placeholderWithoutFriendlyName(placeholder);
		if (unprefixed === undefined) return placeholder;
		const match = /^([A-Z0-9]+)_/.exec(placeholder.slice(2, -2));
		if (match === null || !this.#prefixIsSecretShaped(match[1]!)) return placeholder;
		return unprefixed;
	}

	#stripUnsafeFriendlyPrefixes(text: string, origin: string): { text: string; origin: string } {
		PLACEHOLDER_RE.lastIndex = 0;
		let result = "";
		let resultOrigin = "";
		let cursor = 0;
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			const placeholder = match[0];
			const unprefixed = placeholderWithoutFriendlyName(placeholder);
			const replacement = unprefixed !== undefined ? this.#placeholderForCurrentInput(placeholder) : placeholder;
			if (replacement === placeholder) {
				resumePlaceholderScanAfterRejectedCandidate(match);
				continue;
			}
			result += text.slice(cursor, match.index);
			resultOrigin += origin.slice(cursor, match.index);
			result += replacement;
			resultOrigin += origin[match.index]?.repeat(replacement.length) ?? "";
			cursor = match.index + placeholder.length;
		}
		result += text.slice(cursor);
		resultOrigin += origin.slice(cursor);
		return { text: result, origin: resultOrigin };
	}

	stripUnsafeFriendlyPlaceholderPrefixes(text: string, sharedRegexSecretValues: ReadonlySet<string>): string {
		const previousRegexSecretValues = this.#currentRegexSecretValues;
		this.#currentRegexSecretValues = new Set(sharedRegexSecretValues);
		try {
			return this.#stripUnsafeFriendlyPrefixes(text, "I".repeat(text.length)).text;
		} finally {
			this.#currentRegexSecretValues = previousRegexSecretValues;
		}
	}

	#registerDeobfuscationAlias(placeholder: string, secret: string, recursive: boolean): void {
		const existing = this.#deobfuscateMap.get(placeholder);
		if (existing === undefined || existing.secret === secret) {
			this.#deobfuscateMap.set(placeholder, { secret, recursive });
		}
		const unprefixed = placeholderWithoutFriendlyName(placeholder);
		if (unprefixed !== undefined) {
			const existingUnprefixed = this.#deobfuscateMap.get(unprefixed);
			if (existingUnprefixed === undefined || existingUnprefixed.secret === secret) {
				this.#deobfuscateMap.set(unprefixed, { secret, recursive });
			}
		}
	}

	#prefixIsSecretShaped(prefix: string): boolean {
		for (const secretValue of this.#configuredSecretValues) {
			const sanitizedSecret = sanitizeForCollisionCheck(secretValue);
			if (sanitizedLabelCollidesWithSecret(prefix, sanitizedSecret)) return true;
		}
		for (const secretValue of this.#currentRegexSecretValues) {
			const sanitizedSecret = sanitizeForCollisionCheck(secretValue);
			if (sanitizedLabelCollidesWithSecret(prefix, sanitizedSecret)) return true;
		}
		for (const { secret } of this.#obfuscateMappings.values()) {
			const sanitizedSecret = sanitizeForCollisionCheck(secret);
			if (sanitizedLabelCollidesWithSecret(prefix, sanitizedSecret)) return true;
		}
		for (const entry of this.#regexEntries) {
			entry.regex.lastIndex = 0;
			const matches = entry.regex.test(prefix);
			entry.regex.lastIndex = 0;
			if (matches) return true;
		}
		return false;
	}

	#isGeneratedPlaceholder(placeholder: string): boolean {
		if (this.#deobfuscateMap.has(placeholder)) return true;
		const match = /^([A-Z0-9]+)_([A-Z0-9]{4,}(?::[ULCM])?)$/.exec(placeholder.slice(2, -2));
		if (match === null) return false;
		if (this.#prefixIsSecretShaped(match[1]!)) return false;
		return this.#deobfuscateMap.has(`$$${match[2]}$$`);
	}

	#replaceOutsidePlaceholdersTracked(
		text: string,
		origin: string,
		search: string,
		replacement: string,
		tag: string,
	): { text: string; origin: string } {
		if (search.length === 0) return { text, origin };
		PLACEHOLDER_RE.lastIndex = 0;
		let outText = "";
		let outOrigin = "";
		let pending = 0;
		const emitChunk = (from: number, to: number): void => {
			let last = from;
			let idx = text.indexOf(search, from);
			while (idx !== -1 && idx + search.length <= to) {
				outText += text.slice(last, idx) + replacement;
				outOrigin += origin.slice(last, idx) + tag.repeat(replacement.length);
				last = idx + search.length;
				idx = text.indexOf(search, last);
			}
			outText += text.slice(last, to);
			outOrigin += origin.slice(last, to);
		};
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			if (!(this.#isGeneratedPlaceholder(match[0]) && match[0] !== search)) {
				resumePlaceholderScanAfterRejectedCandidate(match);
				continue;
			}
			emitChunk(pending, match.index);
			outText += match[0];
			outOrigin += origin.slice(match.index, match.index + match[0].length);
			pending = match.index + match[0].length;
		}
		emitChunk(pending, text.length);
		return { text: outText, origin: outOrigin };
	}

	#placeholderForRegexChunk(secret: string, friendlyName: string | undefined): string {
		let index = this.#findObfuscateIndex(secret);
		if (index === undefined) {
			index = this.#nextIndex++;
			const placeholder = this.#createPlaceholder(secret, friendlyName);
			this.#obfuscateMappings.set(index, { secret, placeholder });
			this.#generatedPlaceholders.add(placeholder);
		}
		return this.#placeholderForCurrentInput(this.#obfuscateMappings.get(index)!.placeholder);
	}

	#obfuscateOutsidePlaceholdersTracked(
		text: string,
		origin: string,
		friendlyName: string | undefined,
	): { text: string; origin: string } {
		PLACEHOLDER_RE.lastIndex = 0;
		let outText = "";
		let outOrigin = "";
		let pending = 0;
		const emitChunk = (from: number, to: number): void => {
			if (from >= to) return;
			const placeholder = this.#placeholderForRegexChunk(text.slice(from, to), friendlyName);
			outText += placeholder;
			outOrigin += "F".repeat(placeholder.length);
		};
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			if (!this.#isGeneratedPlaceholder(match[0])) {
				resumePlaceholderScanAfterRejectedCandidate(match);
				continue;
			}
			emitChunk(pending, match.index);
			outText += match[0];
			outOrigin += origin.slice(match.index, match.index + match[0].length);
			pending = match.index + match[0].length;
		}
		emitChunk(pending, text.length);
		return { text: outText, origin: outOrigin };
	}

	#knownPlaceholderRanges(text: string): Array<{ start: number; end: number }> {
		PLACEHOLDER_RE.lastIndex = 0;
		const ranges: Array<{ start: number; end: number }> = [];
		for (;;) {
			const match = PLACEHOLDER_RE.exec(text);
			if (match === null) break;
			if (this.#isGeneratedPlaceholder(match[0])) {
				ranges.push({ start: match.index, end: match.index + match[0].length });
			} else {
				resumePlaceholderScanAfterRejectedCandidate(match);
			}
		}
		return ranges;
	}

	#collectRegexMatches(
		text: string,
		regex: RegExp,
		mode: "obfuscate" | "replace",
		origin: string,
		replacement: string | undefined,
	): Array<{
		start: number;
		end: number;
		value: string;
		canonicalValue: string;
		scanMatchLength: number;
		recursive: boolean;
		preserveGeneratedPlaceholders: boolean;
		preserveInputPlaceholders: boolean;
		inputPlaceholderOutside: string;
		inputPlaceholderOutsideIndependentlyMatches: boolean;
		inputPlaceholderOutsideStart: number;
		inputPlaceholderOutsideChunkCount: number;
		inputPlaceholderInnerIndependentlyMatches: boolean;
		defaultReplacement: string | undefined;
		scanContext: RegexMatchContext;
	}> {
		const knownPlaceholderRanges = this.#knownPlaceholderRanges(text);
		const regexScan = buildReplaceRegexScan(text, knownPlaceholderRanges, this.#deobfuscateMap);
		const scanText = regexScan.text;
		regex.lastIndex = 0;
		const matches: Array<{
			start: number;
			end: number;
			value: string;
			canonicalValue: string;
			scanMatchLength: number;
			recursive: boolean;
			preserveGeneratedPlaceholders: boolean;
			preserveInputPlaceholders: boolean;
			inputPlaceholderOutside: string;
			inputPlaceholderOutsideIndependentlyMatches: boolean;
			inputPlaceholderOutsideStart: number;
			inputPlaceholderOutsideChunkCount: number;
			inputPlaceholderInnerIndependentlyMatches: boolean;
			defaultReplacement: string | undefined;
			scanContext: RegexMatchContext;
		}> = [];
		for (;;) {
			const match = regex.exec(scanText);
			if (match === null) break;
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}
			let start = match.index;
			let end = match.index + match[0].length;
			let scanMatchLength = match[0].length;
			let scanMatchValue = match[0];
			let canonicalValue = "";
			let recursive = false;
			let preserveGeneratedPlaceholders = false;
			let preserveInputPlaceholders = false;
			let inputPlaceholderOutside = "";
			let inputPlaceholderOutsideIndependentlyMatches = false;
			let inputPlaceholderOutsideStart = -1;
			let inputPlaceholderOutsideChunkCount = 0;
			let inputPlaceholderInnerIndependentlyMatches = false;

			let mapped = mapReplaceRegexMatch(regexScan.segments, start, end);
			if (mapped.partialPlaceholderCut) {
				const cutResumeIndex = mapped.cutResumeIndex;
				const prefixScanEnd = mapped.firstPlaceholderScanStart;
				let handledOutside = false;
				if (prefixScanEnd > match.index) {
					regex.lastIndex = match.index;
					const prefixMatch = regex.exec(scanText);
					if (prefixMatch !== null && prefixMatch[0].length > 0 && prefixMatch.index < prefixScanEnd) {
						const prefixStart = prefixMatch.index;
						const prefixEnd = Math.min(prefixMatch.index + prefixMatch[0].length, prefixScanEnd);
						const prefixMapped = mapReplaceRegexMatch(regexScan.segments, prefixStart, prefixEnd);
						if (!prefixMapped.partialPlaceholderCut && prefixEnd > prefixStart) {
							start = prefixStart;
							end = prefixEnd;
							scanMatchValue = scanText.slice(prefixStart, prefixEnd);

							scanMatchLength = match[0].length;
							mapped = prefixMapped;
							regex.lastIndex = extendPastAdjacentPlaceholders(regexScan.segments, prefixEnd);
							handledOutside = true;
						}
					}
				}
				if (!handledOutside && cutResumeIndex < end) {
					const suffixStart = cutResumeIndex;
					const suffixEnd = end;
					const suffixMapped = mapReplaceRegexMatch(regexScan.segments, suffixStart, suffixEnd);
					if (!suffixMapped.partialPlaceholderCut) {
						start = suffixStart;
						end = suffixEnd;
						scanMatchValue = scanText.slice(suffixStart, suffixEnd);
						scanMatchLength = match[0].length;
						mapped = suffixMapped;
						regex.lastIndex = extendPastAdjacentPlaceholders(regexScan.segments, suffixEnd);
						handledOutside = true;
					}
				}
				if (!handledOutside) {
					regex.lastIndex = extendPastAdjacentPlaceholders(regexScan.segments, cutResumeIndex);
					continue;
				}
			}

			const scanMatchStart = start;
			const scanMatchEnd = end;
			let defaultReplacement: string | undefined;
			start = mapped.start;
			end = mapped.end;
			preserveGeneratedPlaceholders = mapped.preserveGeneratedPlaceholders;

			const overlapsInputPlaceholder = knownPlaceholderRanges.some(
				range => start < range.end && end > range.start && origin[range.start] === "I",
			);
			preserveInputPlaceholders = overlapsInputPlaceholder;
			if (overlapsInputPlaceholder) {
				const firstOutside = firstOutsidePlaceholderRange(start, end, knownPlaceholderRanges);
				if (
					mode === "replace" &&
					replacement !== undefined &&
					firstOutside !== undefined &&
					text.slice(firstOutside.start, firstOutside.start + replacement.length) === replacement
				) {
					const expandedEnd = firstOutside.start + replacement.length;
					if (expandedEnd > end) {
						regex.lastIndex = Math.max(regex.lastIndex, match.index + match[0].length + expandedEnd - end);
						end = expandedEnd;
					}
				}
				inputPlaceholderOutside = textOutsidePlaceholderRanges(text, start, end, knownPlaceholderRanges);
				inputPlaceholderOutsideStart =
					firstOutsidePlaceholderRange(start, end, knownPlaceholderRanges)?.start ?? -1;
				inputPlaceholderOutsideChunkCount = countOutsidePlaceholderRanges(start, end, knownPlaceholderRanges);
				if (inputPlaceholderOutside.length === 0) continue;
				const resumeIndex = regex.lastIndex;

				inputPlaceholderOutsideIndependentlyMatches = outsidePlaceholderRangesAnyIndependentlyMatch(
					text,
					scanText,
					regexScan.segments,
					start,
					end,
					knownPlaceholderRanges,
					regex,
				);

				const innerText = placeholderInnerText(text, start, end, knownPlaceholderRanges, this.#deobfuscateMap);
				regex.lastIndex = 0;
				inputPlaceholderInnerIndependentlyMatches = innerText.length > 0 && regex.test(innerText);
				regex.lastIndex = resumeIndex;
			}
			if (mode === "replace") {
				canonicalValue = scanMatchValue;
				recursive = mapped.recursive;
			} else {
				const overlappingRanges = knownPlaceholderRanges.filter(range => start < range.end && end > range.start);
				const containedByPlaceholder = overlappingRanges.some(range => start >= range.start && end <= range.end);
				if (containedByPlaceholder) {
					continue;
				}
				const canonical = deobfuscateGeneratedPlaceholderRanges(
					text,
					start,
					end,
					knownPlaceholderRanges,
					this.#deobfuscateMap,
				);
				canonicalValue = canonical.text;
				recursive = canonical.recursive;
			}

			const scanContext = {
				text: scanText,
				start: scanMatchStart,
				end: scanMatchEnd,
			};
			if (mode === "replace" && replacement === undefined && !preserveGeneratedPlaceholders) {
				const savedLastIndex = regex.lastIndex;
				defaultReplacement = this.#generateRegexReplacement(scanMatchValue, regex, scanContext);
				regex.lastIndex = savedLastIndex;
			}
			matches.push({
				start,
				end,
				value: text.slice(start, end),
				defaultReplacement,
				canonicalValue,
				scanMatchLength,
				recursive,
				preserveGeneratedPlaceholders,
				preserveInputPlaceholders,
				inputPlaceholderOutside,
				inputPlaceholderOutsideIndependentlyMatches,
				inputPlaceholderOutsideStart,
				inputPlaceholderOutsideChunkCount,
				inputPlaceholderInnerIndependentlyMatches,
				scanContext,
			});
		}
		return matches.reverse();
	}
}
