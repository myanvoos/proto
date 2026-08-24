// ============================================================================
// Symbol Presets
// ============================================================================

export type SymbolPreset = "unicode";

/**
 * All available symbol keys organized by category.
 */
export type SymbolKey =
	// Status Indicators
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
	// Navigation
	| "nav.cursor"
	| "nav.selected"
	| "nav.expand"
	| "nav.collapse"
	| "nav.back"
	// Tree Connectors
	| "tree.branch"
	| "tree.last"
	| "tree.vertical"
	| "tree.horizontal"
	| "tree.hook"
	// Progress Bar
	| "progress.filled"
	| "progress.empty"
	// Context gauge boundaries
	| "context.speculation"
	| "context.compaction"
	// Box Drawing - Rounded
	| "boxRound.topLeft"
	| "boxRound.topRight"
	| "boxRound.bottomLeft"
	| "boxRound.bottomRight"
	| "boxRound.horizontal"
	| "boxRound.vertical"
	// Box Drawing - Sharp
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
	// Separators
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
	// Icons
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
	// Compaction divider
	| "icon.camera"
	// Thinking Levels
	| "thinking.minimal"
	| "thinking.low"
	| "thinking.medium"
	| "thinking.high"
	| "thinking.xhigh"
	| "thinking.max"
	| "thinking.autoPending"
	// Checkboxes
	| "checkbox.checked"
	| "checkbox.unchecked"
	// Radio (single-choice)
	| "radio.selected"
	| "radio.unselected"
	// Text Formatting
	| "format.bullet"
	| "format.dash"
	| "format.bracketLeft"
	| "format.bracketRight"
	// Markdown-specific
	| "md.quoteBorder"
	| "md.hrChar"
	| "md.bullet"
	| "md.colorSwatch"
	// Advisor note rail
	| "advisor.rail"
	| "block.rail"
	// Language/file type icons
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
	// Composer attachment chips (image paste / large text paste)
	| "chip.image"
	| "chip.paste"
	// Settings tab icons
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
	// Tool identity icons
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
	// Status
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
	// Navigation
	"nav.cursor": "›",
	"nav.selected": "›",
	"nav.expand": "▸",
	"nav.collapse": "▾",
	"nav.back": "⟵",
	// Tree
	"tree.branch": "├─",
	"tree.last": "└─",
	"tree.vertical": "│",
	"tree.horizontal": "─",
	"tree.hook": "└",
	// Progress bar
	"progress.filled": "━",
	"progress.empty": "─",
	// Context gauge boundaries
	"context.speculation": "╎",
	"context.compaction": "┃",
	// Box (rounded)
	"boxRound.topLeft": "╭",
	"boxRound.topRight": "╮",
	"boxRound.bottomLeft": "╰",
	"boxRound.bottomRight": "╯",
	"boxRound.horizontal": "─",
	"boxRound.vertical": "│",
	// Box (sharp)
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
	// Separators (powerline-ish, but pure Unicode)
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
	// Icons
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
	// Compaction divider
	"icon.camera": "",
	// Thinking levels
	"thinking.minimal": "min",
	"thinking.low": "low",
	"thinking.medium": "med",
	"thinking.high": "high",
	"thinking.xhigh": "xhigh",
	"thinking.max": "max",
	"thinking.autoPending": "◐",
	// Checkboxes
	"checkbox.checked": "■",
	"checkbox.unchecked": "□",
	// Radio (single-choice)
	"radio.selected": "▣",
	"radio.unselected": "□",
	// Formatting
	"format.bullet": "•",
	"format.dash": "—",
	"format.bracketLeft": "⟦",
	"format.bracketRight": "⟧",
	// Markdown
	"md.quoteBorder": "▏",
	"md.hrChar": "─",
	"md.bullet": "•",
	"md.colorSwatch": "■",
	// Advisor note rail (heavier than md.quoteBorder so notes read as a distinct voice)
	"advisor.rail": "▎",
	"block.rail": "▏",
	// Language/file icons (emoji-centric, no Nerd Font required)
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
	// Composer attachment chips
	"chip.image": "🖼",
	"chip.paste": "📄",
	// Settings tabs
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
	// Tool identity icons (per-tool signature glyph on the success header)
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

/**
 * Shape accepted by `themeJson.symbols.spinnerFrames`. A flat array applies to
 * both spinner types; an object lets a theme override `status` and/or
 * `activity` independently. Anything not specified falls back to the symbol
 * preset's default frames.
 */
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
