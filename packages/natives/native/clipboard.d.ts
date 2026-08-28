import type { ClipboardImage } from "./index.js";

export type { ClipboardImage } from "./index.js";


export declare function copyToClipboard(text: string): void;


export declare function readImageFromClipboard(): Promise<ClipboardImage | undefined | null>;
