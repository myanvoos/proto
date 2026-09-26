import type { ImageContent } from "@oh-my-pi/pi-ai";
import { EDITOR_LIMITS } from "@oh-my-pi/pi-tui/editor-limits";
import { materializeString } from "@oh-my-pi/pi-utils/materialize-string";
import { MAX_IMAGE_INPUT_BYTES } from "./image-resources";

const OSC5522_PREFIX = "\x1b]5522;";
const OSC_TERMINATOR_ST = "\x1b\\";
const OSC_TERMINATOR_BEL = "\x07";
const PASTE_EVENT_NAME_BASE64 = Buffer.from("Paste event", "utf8").toString("base64");

const IMAGE_MIME_PRIORITY = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const TEXT_MIME_TYPE = "text/plain";

const MIME_LISTING_TARGET = ".";

type PasteReadKind = "image" | "text";

interface Osc5522Packet {
	metadata: Map<string, string>;
	payload: string;
}

interface PasteListingState {
	phase: "listing";
	mimes: string[];
	kittyDotPayload?: true;
	pw?: string;
	loc?: string;
}

interface PasteReadState {
	phase: "reading";
	kind: PasteReadKind;
	mimeType: string;
	chunks: Uint8Array[];
	bytes: number;
	encodedBytes: number;
}

type PasteState = PasteListingState | PasteReadState;

interface EnhancedPasteHandlers {
	write(data: string): void;
	pasteText(text: string): void;
	pasteImage(image: ImageContent): void | Promise<void>;
	showStatus(message: string): void;
}

function isOsc5522Packet(data: string): boolean {
	return data.startsWith(OSC5522_PREFIX) && (data.endsWith(OSC_TERMINATOR_ST) || data.endsWith(OSC_TERMINATOR_BEL));
}

function decodeBase64Utf8(value: string): string | undefined {
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return undefined;
	}
}

function parseMetadata(raw: string): Map<string, string> {
	const metadata = new Map<string, string>();
	for (const part of raw.split(":")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		metadata.set(materializeString(part.slice(0, eq)), materializeString(part.slice(eq + 1)));
	}
	return metadata;
}

function parseOsc5522Packet(data: string): Osc5522Packet | undefined {
	if (!isOsc5522Packet(data)) return undefined;
	const bodyEnd = data.endsWith(OSC_TERMINATOR_BEL) ? data.length - 1 : data.length - OSC_TERMINATOR_ST.length;
	const body = data.slice(OSC5522_PREFIX.length, bodyEnd);
	const separator = body.indexOf(";");
	const metadataRaw = separator === -1 ? body : body.slice(0, separator);
	if (metadataRaw.length > 8192) return undefined;
	const payload = separator === -1 ? "" : body.slice(separator + 1);
	return { metadata: parseMetadata(metadataRaw), payload };
}

function choosePasteMime(mimes: readonly string[]): { kind: PasteReadKind; mimeType: string } | undefined {
	for (const mimeType of IMAGE_MIME_PRIORITY) {
		if (mimes.includes(mimeType)) return { kind: "image", mimeType };
	}
	return mimes.includes(TEXT_MIME_TYPE) ? { kind: "text", mimeType: TEXT_MIME_TYPE } : undefined;
}

export class EnhancedPasteController {
	#state: PasteState | undefined;
	#handlers: EnhancedPasteHandlers;
	#processing = false;

	constructor(handlers: EnhancedPasteHandlers) {
		this.#handlers = handlers;
	}

	enable(): void {
		this.#handlers.write("\x1b[?5522h");
	}

	disable(): void {
		this.#handlers.write("\x1b[?5522l");
		this.#state = undefined;
	}

	handleInput(data: string): boolean {
		if (!isOsc5522Packet(data)) return false;
		if (this.#processing) {
			this.#handlers.showStatus("An image paste is still processing; incoming enhanced paste was discarded");
			return true;
		}
		if (data.length > Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4 + 8192) {
			this.#state = undefined;
			this.#handlers.showStatus("Enhanced paste packet exceeds the image input limit");
			return true;
		}
		const packet = parseOsc5522Packet(data);
		if (!packet) {
			this.#state = undefined;
			this.#handlers.showStatus("Enhanced paste metadata exceeds its limit");
			return true;
		}
		void this.#handlePacket(packet).catch(error => this.#handlers.showStatus(String(error)));
		return true;
	}

	async #handlePacket(packet: Osc5522Packet): Promise<void> {
		const type = packet.metadata.get("type");
		if (type !== "read") return;

		const status = packet.metadata.get("status");
		if (status === "OK") {
			this.#handleOk(packet);
			return;
		}
		if (status === "DATA") {
			this.#handleData(packet);
			return;
		}
		if (status === "DONE") {
			await this.#handleDone();
			return;
		}
		if (status) {
			this.#state = undefined;
			this.#handlers.showStatus(`Enhanced paste failed: ${status}`);
		}
	}

	#handleOk(packet: Osc5522Packet): void {
		if (this.#state?.phase === "reading") return;
		const loc = packet.metadata.get("loc");
		this.#state = {
			phase: "listing",
			mimes: [],
			pw: packet.metadata.get("pw"),
			loc: loc === "primary" ? loc : undefined,
		};
	}

	#handleData(packet: Osc5522Packet): void {
		const state = this.#state;
		if (!state) return;
		const encodedMime = packet.metadata.get("mime");
		if (!encodedMime) return;
		const mimeType = decodeBase64Utf8(encodedMime);
		if (!mimeType) return;

		if (state.phase === "listing") {
			if (packet.payload.length > 8192 || state.mimes.length >= 128 || mimeType.length > 256) {
				this.#state = undefined;
				this.#handlers.showStatus("Enhanced paste MIME listing exceeds its limit");
				return;
			}
			if (mimeType === MIME_LISTING_TARGET) {
				if (!packet.payload) return;
				const listing = decodeBase64Utf8(packet.payload);
				if (!listing) return;
				state.kittyDotPayload = true;
				for (const candidate of listing.split(/\s+/)) {
					if (candidate && candidate !== MIME_LISTING_TARGET && state.mimes.length < 128)
						state.mimes.push(candidate);
				}
				return;
			}
			state.mimes.push(mimeType);
			return;
		}

		if (state.mimeType === mimeType && packet.payload) {
			const maxBytes = state.kind === "text" ? EDITOR_LIMITS.draftBytes : MAX_IMAGE_INPUT_BYTES;
			const bytes = Buffer.byteLength(packet.payload, "base64");
			const encodedBytes = Buffer.byteLength(packet.payload);
			if (
				state.bytes + bytes > maxBytes ||
				state.encodedBytes + encodedBytes > Math.ceil(maxBytes / 3) * 4 ||
				state.chunks.length >= 8192
			) {
				this.#state = undefined;
				this.#handlers.showStatus(`Enhanced ${state.kind} paste exceeds its byte/chunk limit and was discarded`);
				return;
			}
			state.chunks.push(Buffer.from(packet.payload, "base64"));
			state.bytes += bytes;
			state.encodedBytes += encodedBytes;
		}
	}

	async #handleDone(): Promise<void> {
		const state = this.#state;
		if (!state) return;
		if (state.phase === "listing") {
			this.#finishListing(state);
			return;
		}
		this.#state = undefined;
		const bytes = Buffer.concat(state.chunks, state.bytes);
		state.chunks = [];
		if (bytes.byteLength === 0) {
			this.#handlers.showStatus("Clipboard paste was empty");
			return;
		}
		if (state.kind === "text") {
			this.#handlers.pasteText(bytes.toString("utf8"));
			return;
		}
		this.#processing = true;
		try {
			await this.#handlers.pasteImage({
				type: "image",
				data: bytes.toString("base64"),
				mimeType: state.mimeType,
			});
		} finally {
			this.#processing = false;
		}
	}

	#finishListing(state: PasteListingState): void {
		const selected = choosePasteMime(state.mimes);
		if (!selected) {
			this.#state = undefined;
			this.#handlers.showStatus("Clipboard paste has no supported text or image data");
			return;
		}

		this.#state = {
			phase: "reading",
			kind: selected.kind,
			mimeType: selected.mimeType,
			chunks: [],
			bytes: 0,
			encodedBytes: 0,
		};

		const encodedMime = Buffer.from(selected.mimeType, "utf8").toString("base64");
		const metadata = ["type=read"];
		if (state.loc) metadata.push(`loc=${state.loc}`);
		if (state.pw) {
			metadata.push(`pw=${state.pw}`, `name=${PASTE_EVENT_NAME_BASE64}`);
		}
		if (state.kittyDotPayload) {
			this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")};${encodedMime}${OSC_TERMINATOR_BEL}`);
			return;
		}
		metadata.push(`mime=${encodedMime}`);
		this.#handlers.write(`${OSC5522_PREFIX}${metadata.join(":")}${OSC_TERMINATOR_BEL}`);
	}
}
