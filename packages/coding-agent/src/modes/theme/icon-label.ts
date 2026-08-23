export function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}
