import { type AsciiRenderOptions, renderMermaidASCII } from "./vendor/mermaid-ascii";

export type { AsciiRenderOptions as MermaidAsciiRenderOptions };

export function renderMermaidAscii(source: string, options?: AsciiRenderOptions): string {
	return renderMermaidASCII(source, options);
}

export function renderMermaidAsciiSafe(source: string, options?: AsciiRenderOptions): string | null {
	try {
		return renderMermaidASCII(source, options);
	} catch {
		return null;
	}
}
