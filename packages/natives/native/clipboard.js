import { loadNative } from "./loader-state.js";


export function copyToClipboard(text) {
	return loadNative().copyToClipboard(text);
}


export function readImageFromClipboard() {
	return loadNative().readImageFromClipboard();
}
