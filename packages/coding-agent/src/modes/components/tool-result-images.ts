import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Container, Image, type ImageBudget, ImageProtocol, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { resolveImageOptions } from "../../tools/render-utils";
import { convertImageToPng } from "../../utils/image-loading";
import { theme } from "../theme/theme";

/**
 * Images returned by one tool call, rendered as a block that belongs to that
 * call's card. Terminals without a graphics protocol get the textual fallback.
 * Kitty needs PNG, so other formats are converted in the background and the
 * block repaints once the conversion lands.
 */
export class ToolResultImagesComponent extends Container {
	#images: readonly ImageContent[] = [];
	#converted = new Map<string, ImageContent>();
	#conversionsInFlight = new Set<string>();

	constructor(
		private readonly keyPrefix: string,
		private readonly budget: ImageBudget | undefined,
		private readonly requestRender: () => void,
	) {
		super();
	}

	get imageCount(): number {
		return this.#images.length;
	}

	setImages(images: readonly ImageContent[]): void {
		this.#images = images.filter(image => image.type === "image" && image.data && image.mimeType);
		for (const key of [...this.#converted.keys()]) {
			if (!this.#images.some((_image, index) => this.#key(index) === key)) this.#converted.delete(key);
		}
		this.#convertForKitty();
		this.#rebuild();
	}

	#key(index: number): string {
		return `${this.keyPrefix}:${index}`;
	}

	#convertForKitty(): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (const [index, image] of this.#images.entries()) {
			const key = this.#key(index);
			if (image.mimeType === "image/png") continue;
			if (this.#converted.has(key) || this.#conversionsInFlight.has(key)) continue;
			this.#conversionsInFlight.add(key);
			convertImageToPng(image)
				.then(converted => {
					this.#conversionsInFlight.delete(key);
					this.#converted.set(key, converted);
					this.#rebuild();
					this.requestRender();
				})
				.catch(() => {
					this.#conversionsInFlight.delete(key);
				});
		}
	}

	#rebuild(): void {
		this.clear();
		for (const [index, image] of this.#images.entries()) {
			const key = this.#key(index);
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
					? this.#converted.get(key)
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				this.addChild(
					new Image(
						displayImage.data,
						displayImage.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ ...resolveImageOptions(), budget: this.budget, imageKey: key },
					),
				);
				continue;
			}
			this.addChild(new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0));
		}
	}
}
