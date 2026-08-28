export type SymbolPreset = "unicode";

export type SymbolKey =
	| "status.success"
	| "status.error"
	| "status.warning"
	| "status.info"
	| "status.pending"
	| "status.disabled"
	| "status.enabled"
	| "status.running"
	| "status.shadowed"
	| "status.aborted"
	| "status.done"
	| "nav.cursor"
	| "nav.selected"
	| "nav.expand"
	| "nav.collapse"
	| "nav.back"
	| "tree.branch"
	| "tree.last"
	| "tree.vertical"
	| "tree.horizontal"
	| "tree.hook"
	| "progress.filled"
	| "progress.empty"
	| "context.speculation"
	| "context.compaction"
	| "boxRound.topLeft"
	| "boxRound.topRight"
	| "boxRound.bottomLeft"
	| "boxRound.bottomRight"
	| "boxRound.horizontal"
	| "boxRound.vertical"
	| "boxSharp.topLeft"
	| "boxSharp.topRight"
	| "boxSharp.bottomLeft"
	| "boxSharp.bottomRight"
	| "boxSharp.horizontal"
	| "boxSharp.vertical"
	| "boxSharp.cross"
	| "boxSharp.teeDown"
	| "boxSharp.teeUp"
	| "boxSharp.teeRight"
	| "boxSharp.teeLeft"
	| "sep.powerline"
	| "sep.powerlineThin"
	| "sep.powerlineLeft"
	| "sep.powerlineRight"
	| "sep.powerlineThinLeft"
	| "sep.powerlineThinRight"
	| "sep.block"
	| "sep.space"
	| "sep.asciiLeft"
	| "sep.asciiRight"
	| "sep.dot"
	| "sep.slash"
	| "sep.pipe"
	| "icon.model"
	| "icon.prewalk"
	| "icon.goal"
	| "icon.pause"
	| "icon.loop"
	| "icon.folder"
	| "icon.worktree"
	| "icon.search"
	| "icon.scratchFolder"
	| "icon.file"
	| "icon.git"
	| "icon.branch"
	| "icon.pr"
	| "icon.pin"
	| "icon.tokens"
	| "icon.context"
	| "icon.cost"
	| "icon.subscription"
	| "icon.advisor"
	| "icon.time"
	| "icon.pi"
	| "icon.ghost"
	| "icon.agents"
	| "icon.job"
	| "icon.cache"
	| "icon.cacheMiss"
	| "icon.input"
	| "icon.output"
	| "icon.throughput"
	| "icon.host"
	| "icon.session"
	| "icon.package"
	| "icon.warning"
	| "icon.rewind"
	| "icon.fast"
	| "icon.extensionSkill"
	| "icon.extensionTool"
	| "icon.extensionSlashCommand"
	| "icon.extensionMcp"
	| "icon.extensionRule"
	| "icon.extensionHook"
	| "icon.extensionPrompt"
	| "icon.extensionContextFile"
	| "icon.extensionInstruction"
	| "icon.camera"
	| "thinking.minimal"
	| "thinking.low"
	| "thinking.medium"
	| "thinking.high"
	| "thinking.xhigh"
	| "thinking.max"
	| "thinking.autoPending"
	| "checkbox.checked"
	| "checkbox.unchecked"
	| "radio.selected"
	| "radio.unselected"
	| "format.bullet"
	| "format.dash"
	| "format.bracketLeft"
	| "format.bracketRight"
	| "md.quoteBorder"
	| "md.hrChar"
	| "md.bullet"
	| "md.colorSwatch"
	| "advisor.rail"
	| "block.rail"
	| "lang.default"
	| "lang.typescript"
	| "lang.javascript"
	| "lang.python"
	| "lang.rust"
	| "lang.go"
	| "lang.java"
	| "lang.c"
	| "lang.cpp"
	| "lang.csharp"
	| "lang.ruby"
	| "lang.julia"
	| "lang.php"
	| "lang.swift"
	| "lang.kotlin"
	| "lang.shell"
	| "lang.html"
	| "lang.css"
	| "lang.json"
	| "lang.yaml"
	| "lang.markdown"
	| "lang.sql"
	| "lang.docker"
	| "lang.lua"
	| "lang.text"
	| "lang.env"
	| "lang.toml"
	| "lang.xml"
	| "lang.ini"
	| "lang.conf"
	| "lang.log"
	| "lang.csv"
	| "lang.tsv"
	| "lang.image"
	| "lang.pdf"
	| "lang.archive"
	| "lang.binary"
	| "chip.image"
	| "chip.paste"
	| "tab.appearance"
	| "tab.model"
	| "tab.interaction"
	| "tab.context"
	| "tab.files"
	| "tab.shell"
	| "tab.tools"
	| "tab.memory"
	| "tab.tasks"
	| "tab.providers"
	| "tool.write"
	| "tool.edit"
	| "tool.bash"
	| "tool.ssh"
	| "tool.lsp"
	| "tool.gh"
	| "tool.webSearch"
	| "tool.exa"
	| "tool.browser"
	| "tool.eval"
	| "tool.debug"
	| "tool.mcp"
	| "tool.job"
	| "tool.launch"
	| "tool.todo"
	| "tool.memory"
	| "tool.ask"
	| "tool.resolve"
	| "tool.review"
	| "tool.inspectImage"
	| "tool.goal"
	| "tool.irc"
	| "tool.delete"
	| "tool.move";

export type SymbolMap = Record<SymbolKey, string>;

const UNICODE_SYMBOLS: SymbolMap = {
	"status.success": "✓",
	"status.error": "✗",
	"status.warning": "!",
	"status.info": "i",
	"status.pending": "⋯",
	"status.disabled": "⊗",
	"status.enabled": "▪",
	"status.running": "◐",
	"status.shadowed": "▫",
	"status.aborted": "∎",
	"status.done": "▪",

	"nav.cursor": "›",
	"nav.selected": "›",
	"nav.expand": "▸",
	"nav.collapse": "▾",
	"nav.back": "⟵",

	"tree.branch": "├─",
	"tree.last": "└─",
	"tree.vertical": "│",
	"tree.horizontal": "─",
	"tree.hook": "└",

	"progress.filled": "━",
	"progress.empty": "─",

	"context.speculation": "╎",
	"context.compaction": "┃",

	"boxRound.topLeft": "╭",
	"boxRound.topRight": "╮",
	"boxRound.bottomLeft": "╰",
	"boxRound.bottomRight": "╯",
	"boxRound.horizontal": "─",
	"boxRound.vertical": "│",

	"boxSharp.topLeft": "┌",
	"boxSharp.topRight": "┐",
	"boxSharp.bottomLeft": "└",
	"boxSharp.bottomRight": "┘",
	"boxSharp.horizontal": "─",
	"boxSharp.vertical": "│",
	"boxSharp.cross": "┼",
	"boxSharp.teeDown": "┬",
	"boxSharp.teeUp": "┴",
	"boxSharp.teeRight": "├",
	"boxSharp.teeLeft": "┤",

	"sep.powerline": "▕",
	"sep.powerlineThin": "┆",
	"sep.powerlineLeft": "▶",
	"sep.powerlineRight": "◀",
	"sep.powerlineThinLeft": ">",
	"sep.powerlineThinRight": "<",
	"sep.block": "▌",
	"sep.space": " ",
	"sep.asciiLeft": ">",
	"sep.asciiRight": "<",
	"sep.dot": " · ",
	"sep.slash": " / ",
	"sep.pipe": " │ ",

	"icon.model": "",
	"icon.prewalk": "",
	"icon.goal": "",
	"icon.pause": "‖",
	"icon.loop": "↻",
	"icon.folder": "",
	"icon.worktree": "◫",
	"icon.search": "⌕",
	"icon.scratchFolder": "▫",
	"icon.file": "▤",
	"icon.git": "",
	"icon.branch": "",
	"icon.pr": "",
	"icon.pin": "📌",
	"icon.tokens": "",
	"icon.context": "",
	"icon.cost": "",
	"icon.subscription": "(sub)",
	"icon.advisor": "👁",
	"icon.time": "",
	"icon.pi": "",
	"icon.ghost": "",
	"icon.agents": "",
	"icon.job": "",
	"icon.cache": "",
	"icon.cacheMiss": "⊘",
	"icon.input": "↓",
	"icon.output": "↑",
	"icon.throughput": "",
	"icon.host": "",
	"icon.session": "",
	"icon.package": "",
	"icon.warning": "!",
	"icon.rewind": "↶",
	"icon.fast": "",
	"icon.extensionSkill": "*",
	"icon.extensionTool": "",
	"icon.extensionSlashCommand": "⌘",
	"icon.extensionMcp": "",
	"icon.extensionRule": "",
	"icon.extensionHook": "",
	"icon.extensionPrompt": "¶",
	"icon.extensionContextFile": "",
	"icon.extensionInstruction": "",

	"icon.camera": "",

	"thinking.minimal": "min",
	"thinking.low": "low",
	"thinking.medium": "med",
	"thinking.high": "high",
	"thinking.xhigh": "xhigh",
	"thinking.max": "max",
	"thinking.autoPending": "◐",

	"checkbox.checked": "■",
	"checkbox.unchecked": "□",

	"radio.selected": "▣",
	"radio.unselected": "□",

	"format.bullet": "•",
	"format.dash": "—",
	"format.bracketLeft": "⟦",
	"format.bracketRight": "⟧",

	"md.quoteBorder": "▏",
	"md.hrChar": "─",
	"md.bullet": "•",
	"md.colorSwatch": "■",

	"advisor.rail": "▎",
	"block.rail": "▏",

	"lang.default": "",
	"lang.typescript": "",
	"lang.javascript": "",
	"lang.python": "",
	"lang.rust": "",
	"lang.go": "",
	"lang.java": "",
	"lang.c": "",
	"lang.cpp": "",
	"lang.csharp": "",
	"lang.ruby": "",
	"lang.julia": "",
	"lang.php": "",
	"lang.swift": "",
	"lang.kotlin": "",
	"lang.shell": "",
	"lang.html": "",
	"lang.css": "",
	"lang.json": "",
	"lang.yaml": "",
	"lang.markdown": "",
	"lang.sql": "",
	"lang.docker": "",
	"lang.lua": "",
	"lang.text": "",
	"lang.env": "",
	"lang.toml": "",
	"lang.xml": "",
	"lang.ini": "",
	"lang.conf": "",
	"lang.log": "",
	"lang.csv": "",
	"lang.tsv": "",
	"lang.image": "",
	"lang.pdf": "",
	"lang.archive": "",
	"lang.binary": "",

	"chip.image": "🖼",
	"chip.paste": "📄",

	"tab.appearance": "",
	"tab.model": "",
	"tab.interaction": "",
	"tab.context": "",
	"tab.files": "",
	"tab.shell": "",
	"tab.tools": "",
	"tab.memory": "",
	"tab.tasks": "",
	"tab.providers": "",

	"tool.write": "❐",
	"tool.edit": "✎",
	"tool.bash": ">",
	"tool.ssh": "⇄",
	"tool.lsp": "",
	"tool.gh": "◈",
	"tool.webSearch": "⌕",
	"tool.exa": "",
	"tool.browser": "N",
	"tool.eval": "▶",
	"tool.debug": "",
	"tool.mcp": "",
	"tool.job": "",
	"tool.launch": "",
	"tool.todo": "",
	"tool.memory": "R",
	"tool.ask": "?",
	"tool.resolve": "✓",
	"tool.review": "◉",
	"tool.inspectImage": "",
	"tool.goal": "◎",
	"tool.irc": "",
	"tool.delete": "",
	"tool.move": "",
};

export const SYMBOL_PRESETS = {
	unicode: UNICODE_SYMBOLS,
} as const;

export type SpinnerType = "status" | "activity" | "thinking";

export const SPINNER_FRAMES: Record<SymbolPreset, Record<SpinnerType, string[]>> = {
	unicode: {
		status: ["░", "▒", "▓", "█", "▓", "▒", "░"],
		activity: ["⠁⠀", "⠋⠀", "⠟⠁", "⡿⠋", "⣿⠟", "⣿⡿", "⣿⣿", "⣿⣿", "⣾⣿", "⣴⣿", "⣠⣾", "⢀⣴", "⠀⣠", "⠀⢀", "⠀⠀", "⠀⠀"],
		thinking: ["⠀⠶⠀", "⠰⣿⠆", "⢸⣿⡇", "⢸⣉⡇", "⢾⣉⡷", "⣿⣉⣿", "⣏⠀⣹", "⡇⠀⢸", "⡁⠀⢈"],
	},
};

export type SpinnerFramesOverride = string[] | { status?: string[]; activity?: string[] };

export function normalizeSpinnerFramesOverride(
	value: SpinnerFramesOverride | undefined,
): Partial<Record<SpinnerType, string[]>> {
	if (value === undefined) return {};
	if (Array.isArray(value)) return { status: value, activity: value };
	const result: Partial<Record<SpinnerType, string[]>> = {};
	if (value.status) result.status = value.status;
	if (value.activity) result.activity = value.activity;
	return result;
}
