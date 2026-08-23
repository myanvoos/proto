// ============================================================================
// Symbol Presets
// ============================================================================

export type SymbolPreset = "unicode" | "ascii";

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
	| "icon.plan"
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
	| "icon.auto"
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
	// Slash-command type indicators (autocomplete); names without an existing
	// icon.* equivalent — see SlashCommandIconName for the full vocabulary.
	| "cmd.action"
	| "cmd.prompt"
	| "cmd.extension"
	| "cmd.settings"
	| "cmd.gear"
	| "cmd.shield"
	| "cmd.wave"
	| "cmd.compass"
	| "cmd.inbox"
	| "cmd.swap"
	| "cmd.expand"
	| "cmd.computer"
	| "cmd.eye"
	| "cmd.todo"
	| "cmd.stats"
	| "cmd.news"
	| "cmd.keyboard"
	| "cmd.export"
	| "cmd.clipboard"
	| "cmd.share"
	| "cmd.broadcast"
	| "cmd.globe"
	| "cmd.copy"
	| "cmd.plus"
	| "cmd.restart"
	| "cmd.eraser"
	| "cmd.trash"
	| "cmd.compress"
	| "cmd.vibrate"
	| "cmd.handoff"
	| "cmd.history"
	| "cmd.question"
	| "cmd.rocket"
	| "cmd.stethoscope"
	| "cmd.redo"
	| "cmd.bug"
	| "cmd.memory"
	| "cmd.pencil"
	| "cmd.folderMove"
	| "cmd.folderPlus"
	| "cmd.folderMinus"
	| "cmd.hammer"
	| "cmd.power"
	| "cmd.cart"
	// STT
	| "icon.mic"
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
/**
 * Icon vocabulary for slash-command autocomplete type indicators. Each name
 * resolves through `Theme.cmd` to either a dedicated `cmd.*` symbol or an
 * existing `icon.*` symbol shared with the rest of the UI.
 */
export type SlashCommandIconName =
	// Dedicated cmd.* symbols
	| "action"
	| "prompt"
	| "extension"
	| "settings"
	| "gear"
	| "shield"
	| "wave"
	| "compass"
	| "inbox"
	| "swap"
	| "expand"
	| "computer"
	| "eye"
	| "todo"
	| "stats"
	| "news"
	| "keyboard"
	| "export"
	| "clipboard"
	| "share"
	| "broadcast"
	| "globe"
	| "copy"
	| "plus"
	| "restart"
	| "eraser"
	| "trash"
	| "compress"
	| "vibrate"
	| "handoff"
	| "history"
	| "question"
	| "rocket"
	| "stethoscope"
	| "redo"
	| "bug"
	| "memory"
	| "pencil"
	| "folderMove"
	| "folderPlus"
	| "folderMinus"
	| "hammer"
	| "power"
	| "cart"
	// Shared icon.* symbols
	| "model"
	| "plan"
	| "prewalk"
	| "goal"
	| "pause"
	| "loop"
	| "session"
	| "jobs"
	| "gauge"
	| "context"
	| "agents"
	| "branch"
	| "tree"
	| "signIn"
	| "signOut"
	| "advisor"
	| "host"
	| "package"
	| "fast"
	| "voice"
	| "tools"
	| "rule"
	| "skill"
	| "mcp"
	| "pin";

const UNICODE_SYMBOLS: SymbolMap = {
	// Status
	"status.success": "✔",
	"status.error": "✘",
	"status.warning": "⚠",
	"status.info": "ⓘ",
	"status.pending": "⏳",
	"status.disabled": "⦸",
	"status.enabled": "●",
	"status.running": "⟳",
	"status.shadowed": "○",
	"status.aborted": "⏹",
	"status.done": "•",
	// Navigation
	"nav.cursor": "❯",
	"nav.selected": "➤",
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
	"icon.model": "⬢",
	"icon.plan": "🗺",
	"icon.prewalk": "🏃",
	"icon.goal": "🎯",
	"icon.pause": "⏸",
	"icon.loop": "↻",
	"icon.folder": "📁",
	"icon.worktree": "🌳",
	"icon.search": "🔍",
	"icon.scratchFolder": "🗑",
	"icon.file": "📄",
	"icon.git": "⎇",
	"icon.branch": "⑂",
	"icon.pr": "⤴",
	"icon.pin": "📌",
	"icon.tokens": "🪙",
	"icon.context": "◫",
	"icon.cost": "💲",
	"icon.subscription": "(sub)",
	"icon.advisor": "👁",
	"icon.time": "⏱",
	"icon.pi": "π",
	"icon.ghost": "👻",
	"icon.agents": "👥",
	"icon.job": "⚙",
	"icon.cache": "💾",
	"icon.cacheMiss": "⊘",
	"icon.input": "⤵",
	"icon.output": "⤴",
	"icon.throughput": "⚡",
	"icon.host": "🖥",
	"icon.session": "🆔",
	"icon.package": "📦",
	"icon.warning": "⚠",
	"icon.rewind": "↶",
	"icon.auto": "∞",
	"icon.fast": "⚡",
	"icon.extensionSkill": "✦",
	"icon.extensionTool": "🛠",
	"icon.extensionSlashCommand": "⌘",
	"icon.extensionMcp": "🔌",
	"icon.extensionRule": "⚖",
	"icon.extensionHook": "🪝",
	"icon.extensionPrompt": "✎",
	"icon.extensionContextFile": "📎",
	"icon.extensionInstruction": "📘",
	// Slash-command type indicators
	"cmd.action": "❯",
	"cmd.prompt": "✎",
	"cmd.extension": "🧩",
	"cmd.settings": "🎛",
	"cmd.gear": "⚙",
	"cmd.shield": "🛡",
	"cmd.wave": "∿",
	"cmd.compass": "🧭",
	"cmd.inbox": "📥",
	"cmd.swap": "⇄",
	"cmd.expand": "⤢",
	"cmd.computer": "🖥",
	"cmd.eye": "👁",
	"cmd.todo": "☑",
	"cmd.stats": "📊",
	"cmd.news": "📰",
	"cmd.keyboard": "⌨",
	"cmd.export": "📤",
	"cmd.clipboard": "📋",
	"cmd.share": "↗",
	"cmd.broadcast": "📡",
	"cmd.globe": "🌐",
	"cmd.copy": "⧉",
	"cmd.plus": "✚",
	"cmd.restart": "↻",
	"cmd.eraser": "🧹",
	"cmd.trash": "🗑",
	"cmd.compress": "🗜",
	"cmd.vibrate": "📳",
	"cmd.handoff": "➦",
	"cmd.history": "🕘",
	"cmd.question": "❓",
	"cmd.rocket": "🚀",
	"cmd.stethoscope": "🩺",
	"cmd.redo": "🔁",
	"cmd.bug": "🐛",
	"cmd.memory": "🧠",
	"cmd.pencil": "✏",
	"cmd.folderMove": "📂",
	"cmd.folderPlus": "📁",
	"cmd.folderMinus": "📁",
	"cmd.hammer": "🔨",
	"cmd.power": "⏻",
	"cmd.cart": "🛒",
	// STT
	"icon.mic": "🎤",
	// Compaction divider
	"icon.camera": "📷",
	// Thinking levels
	"thinking.minimal": "○ min",
	"thinking.low": "◔ low",
	"thinking.medium": "◑ med",
	"thinking.high": "◒ high",
	"thinking.xhigh": "◕ xhigh",
	"thinking.max": "◉ max",
	"thinking.autoPending": "⟳",
	// Checkboxes
	"checkbox.checked": "☑",
	"checkbox.unchecked": "☐",
	// Radio (single-choice)
	"radio.selected": "◉",
	"radio.unselected": "○",
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
	// Language/file icons (emoji-centric, no Nerd Font required)
	"lang.default": "⌘",
	"lang.typescript": "🟦",
	"lang.javascript": "🟨",
	"lang.python": "🐍",
	"lang.rust": "🦀",
	"lang.go": "🐹",
	"lang.java": "☕",
	"lang.c": "Ⓒ",
	"lang.cpp": "➕",
	"lang.csharp": "♯",
	"lang.ruby": "💎",
	"lang.julia": "Ⓙ",
	"lang.php": "🐘",
	"lang.swift": "🕊",
	"lang.kotlin": "🅺",
	"lang.shell": "💻",
	"lang.html": "🌐",
	"lang.css": "🎨",
	"lang.json": "🧾",
	"lang.yaml": "📋",
	"lang.markdown": "📝",
	"lang.sql": "🗄",
	"lang.docker": "🐳",
	"lang.lua": "🌙",
	"lang.text": "🗒",
	"lang.env": "🔧",
	"lang.toml": "🧾",
	"lang.xml": "⟨⟩",
	"lang.ini": "⚙",
	"lang.conf": "⚙",
	"lang.log": "📜",
	"lang.csv": "📑",
	"lang.tsv": "📑",
	"lang.image": "🖼",
	"lang.pdf": "📕",
	"lang.archive": "🗜",
	"lang.binary": "⚙",
	// Composer attachment chips
	"chip.image": "🖼",
	"chip.paste": "📄",
	// Settings tabs
	"tab.appearance": "🎨",
	"tab.model": "🤖",
	"tab.interaction": "⌨",
	"tab.context": "📋",
	"tab.files": "📁",
	"tab.shell": "💻",
	"tab.tools": "🔧",
	"tab.memory": "🧠",
	"tab.tasks": "📦",
	"tab.providers": "🌐",
	// Tool identity icons (per-tool signature glyph on the success header)
	"tool.write": "✎",
	"tool.edit": "✎",
	"tool.bash": "❯",
	"tool.ssh": "⇄",
	"tool.lsp": "💡",
	"tool.gh": "⎇",
	"tool.webSearch": "⌕",
	"tool.exa": "🔭",
	"tool.browser": "🌐",
	"tool.eval": "▶",
	"tool.debug": "🐞",
	"tool.mcp": "🔌",
	"tool.job": "⚙",
	"tool.launch": "🚀",
	"tool.todo": "☑",
	"tool.memory": "🧠",
	"tool.ask": "?",
	"tool.resolve": "✓",
	"tool.review": "◉",
	"tool.inspectImage": "🖼",
	"tool.goal": "◎",
	"tool.irc": "✉",
	"tool.delete": "🗑",
	"tool.move": "➜",
};

export const SYMBOL_PRESETS: Record<SymbolPreset, SymbolMap> = {
	unicode: UNICODE_SYMBOLS,
	ascii: ASCII_SYMBOLS,
};

export type SpinnerType = "status" | "activity";

export const SPINNER_FRAMES: Record<SymbolPreset, Record<SpinnerType, string[]>> = {
	unicode: {
		status: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
		activity: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	},
	ascii: {
		status: ["|", "/", "-", "\\"],
		activity: ["-", "\\", "|", "/"],
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

/**
 * Get available symbol presets.
 */
export function getAvailableSymbolPresets(): SymbolPreset[] {
	return ["unicode", "ascii"];
}

/**
 * Check if a string is a valid symbol preset.
 */
export function isValidSymbolPreset(preset: string): preset is SymbolPreset {
	return preset === "unicode" || preset === "ascii";
}
