import type { EvalLanguage } from "../../eval/types";
import { formatJavaScriptForDisplay } from "./javascript";
import { formatPythonForDisplay } from "./python";

export * from "./javascript";
export * from "./python";

export function formatEvalCodeForDisplay(source: string, language: EvalLanguage): string {
	switch (language) {
		case "js":
			return formatJavaScriptForDisplay(source);
		case "python":
			return formatPythonForDisplay(source);
	}
}
