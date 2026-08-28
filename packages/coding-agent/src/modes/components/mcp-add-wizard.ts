import { Container, Input, matchesKey, replaceTabs, Spacer, Text, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { validateServerName } from "../../mcp/config-writer";
import { analyzeAuthError, discoverOAuthEndpoints, fetchResourceMetadataScopes } from "../../mcp/oauth-discovery";
import type { MCPHttpServerConfig, MCPServerConfig, MCPSseServerConfig, MCPStdioServerConfig } from "../../mcp/types";
import { shortenPath } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { matchesAppInterrupt, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { OverlayPanel } from "./overlay-box";

type TransportType = "stdio" | "http" | "sse";
type AuthMethod = "none" | "oauth" | "manual";
type AuthLocation = "env" | "header";
type Scope = "user" | "project";

type WizardStep =
	| "name"
	| "transport"
	| "command"
	| "args"
	| "url"
	| "auth-method"
	| "oauth-error"
	| "oauth-auth-url"
	| "oauth-token-url"
	| "oauth-client-id"
	| "oauth-client-secret"
	| "oauth-scopes"
	| "apikey"
	| "auth-location"
	| "env-var-name"
	| "header-name"
	| "scope"
	| "confirm";

interface MCPAddWizardOAuthResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

interface MCPAddWizardOAuthOptions {
	serverUrl?: string;
	resource?: string;
	registrationUrl?: string;

	abortSignal?: AbortSignal;
}

interface WizardState {
	name: string;
	transport: TransportType | null;
	command: string;
	args: string;
	url: string;
	authMethod: AuthMethod;
	oauthAuthUrl: string;
	oauthTokenUrl: string;
	oauthRegistrationUrl: string;
	oauthClientId: string;
	oauthClientSecret: string;
	oauthScopes: string;
	oauthResource: string;
	oauthCredentialId: string | null;
	apiKey: string;
	authLocation: AuthLocation | null;
	envVarName: string;
	headerName: string;
	scope: Scope | null;
}

const MAX_DISPLAY_WIDTH = 120;

function sanitize(text: string): string {
	return truncateToWidth(replaceTabs(text), MAX_DISPLAY_WIDTH);
}

export class MCPAddWizard extends OverlayPanel {
	#currentStep: WizardStep = "name";
	#state: WizardState = {
		name: "",
		transport: null,
		command: "",
		args: "",
		url: "",
		authMethod: "none",
		oauthAuthUrl: "",
		oauthTokenUrl: "",
		oauthRegistrationUrl: "",
		oauthClientId: "",
		oauthClientSecret: "",
		oauthScopes: "",
		oauthResource: "",
		oauthCredentialId: null,
		apiKey: "",
		authLocation: null,
		envVarName: "API_KEY",
		headerName: "Authorization",
		scope: null,
	};

	#contentContainer: Container;
	#inputField: Input | null = null;
	#selectedIndex = 0;
	#validationError: string | null = null;
	#onCompleteCallback: (name: string, config: MCPServerConfig, scope: Scope) => void;
	#onCancelCallback: () => void;
	#onOAuthCallback:
		| ((
				authUrl: string,
				tokenUrl: string,
				clientId: string,
				clientSecret: string,
				scopes: string,
				options?: MCPAddWizardOAuthOptions,
		  ) => Promise<MCPAddWizardOAuthResult>)
		| null = null;
	#onTestConnectionCallback: ((config: MCPServerConfig) => Promise<void>) | null = null;
	#onRenderCallback: (() => void) | null = null;

	#oauthAbort: AbortController | null = null;

	constructor(
		onComplete: (name: string, config: MCPServerConfig, scope: Scope) => void,
		onCancel: () => void,
		onOAuth?: (
			authUrl: string,
			tokenUrl: string,
			clientId: string,
			clientSecret: string,
			scopes: string,
			options?: MCPAddWizardOAuthOptions,
		) => Promise<MCPAddWizardOAuthResult>,
		onTestConnection?: (config: MCPServerConfig) => Promise<void>,
		onRender?: () => void,
		initialName?: string,
	) {
		super("Add MCP Server");
		this.#onCompleteCallback = onComplete;
		this.#onCancelCallback = onCancel;
		this.#onOAuthCallback = onOAuth ?? null;
		this.#onTestConnectionCallback = onTestConnection ?? null;
		this.#onRenderCallback = onRender ?? null;
		if (initialName && initialName.trim().length > 0) {
			this.#state.name = initialName.trim();
			this.#currentStep = "transport";
		}

		this.addChild(new Spacer(1));

		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		this.addChild(new Spacer(1));

		this.#renderStep();
	}

	#requestRender(): void {
		this.#onRenderCallback?.();
	}

	#renderStep(): void {
		this.#contentContainer.clear();
		this.#inputField = null;

		switch (this.#currentStep) {
			case "name":
				this.#renderNameStep();
				break;
			case "transport":
				this.#renderTransportStep();
				break;
			case "command":
				this.#renderCommandStep();
				break;
			case "args":
				this.#renderArgsStep();
				break;
			case "url":
				this.#renderUrlStep();
				break;
			case "auth-method":
				this.#renderAuthMethodStep();
				break;
			case "oauth-error":
				this.#renderOAuthErrorStep();
				break;
			case "oauth-auth-url":
				this.#renderOAuthAuthUrlStep();
				break;
			case "oauth-token-url":
				this.#renderOAuthTokenUrlStep();
				break;
			case "oauth-client-id":
				this.#renderOAuthClientIdStep();
				break;
			case "oauth-client-secret":
				this.#renderOAuthClientSecretStep();
				break;
			case "oauth-scopes":
				this.#renderOAuthScopesStep();
				break;
			case "apikey":
				this.#renderApiKeyStep();
				break;
			case "auth-location":
				this.#renderAuthLocationStep();
				break;
			case "env-var-name":
				this.#renderEnvVarNameStep();
				break;
			case "header-name":
				this.#renderHeaderNameStep();
				break;
			case "scope":
				this.#renderScopeStep();
				break;
			case "confirm":
				this.#renderConfirmStep();
				break;
		}
	}

	#renderNameStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 1: Server Name")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter a unique name for this server:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.name);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		if (this.#validationError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}

		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[Only letters, numbers, dash, underscore, dot, colon]"), 0, 0),
		);
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to cancel]"), 0, 0));
	}

	#renderTransportStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 2: Transport Type")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Select the transport type:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{ value: "stdio" as const, label: "stdio (Local process)" },
			{ value: "http" as const, label: "http (HTTP server)" },
			{ value: "sse" as const, label: "sse (Server-Sent Events)" },
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to cancel]"), 0, 0),
		);
	}

	#renderCommandStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 3: Command")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the command to run:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.command);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderArgsStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 4: Arguments (Optional)")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter command arguments (space-separated):", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.args);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Press Enter to skip or continue]"), 0, 0));
	}

	#renderUrlStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step 3: Server URL")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the server URL:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.url);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));

		if (this.#validationError) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `✗ ${sanitize(this.#validationError)}`), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
		}

		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Must start with http:// or https://]"), 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderAuthLocationStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step: How to provide the key?")));
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{ value: "env" as const, label: "Environment variable" },
			{ value: "header" as const, label: "HTTP header" },
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
		);
	}

	#renderEnvVarNameStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step: Environment Variable Name")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the environment variable name:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.envVarName);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderHeaderNameStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step: HTTP Header Name")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the HTTP header name:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.headerName);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderScopeStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step: Configuration Scope")));
		this.#contentContainer.addChild(new Spacer(1));

		const cwd = getProjectDir();

		const userPathLabel = shortenPath(getMCPConfigPath("user", cwd));
		const projectPathLabel = shortenPath(getMCPConfigPath("project", cwd));
		const options = [
			{ value: "user" as const, label: `User level (${userPathLabel})` },
			{ value: "project" as const, label: `Project level (${projectPathLabel})` },
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
		);
	}

	#renderConfirmStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Review Configuration")));
		this.#contentContainer.addChild(new Spacer(1));

		this.#contentContainer.addChild(new Text(`Name: ${theme.fg("accent", this.#state.name)}`, 0, 0));
		this.#contentContainer.addChild(new Text(`Type: ${this.#state.transport}`, 0, 0));

		if (this.#state.transport === "stdio") {
			this.#contentContainer.addChild(new Text(`Command: ${this.#state.command}`, 0, 0));
			if (this.#state.args) {
				this.#contentContainer.addChild(new Text(`Args: ${this.#state.args}`, 0, 0));
			}
		} else {
			this.#contentContainer.addChild(new Text(`URL: ${sanitize(this.#state.url)}`, 0, 0));
		}

		if (this.#state.authMethod === "none") {
			this.#contentContainer.addChild(new Text("Auth: None", 0, 0));
		} else if (this.#state.authMethod === "oauth") {
			this.#contentContainer.addChild(new Text("Auth: OAuth (authenticated)", 0, 0));
		} else if (this.#state.authMethod === "manual") {
			if (this.#state.authLocation === "env") {
				this.#contentContainer.addChild(new Text(`Auth: API key via env (${this.#state.envVarName})`, 0, 0));
			} else {
				this.#contentContainer.addChild(new Text(`Auth: API key via header (${this.#state.headerName})`, 0, 0));
			}
		}

		const scopeLabel = this.#state.scope === "user" ? "User level" : "Project level";
		this.#contentContainer.addChild(new Text(`Scope: ${scopeLabel}`, 0, 0));

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Save this configuration?", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		const options = ["Yes", "No"];
		for (let i = 0; i < options.length; i++) {
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", options[i]) : options[i];
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
		);
	}

	handleInput(keyData: string): void {
		if (this.#oauthAbort && (keyData === "\x03" || matchesAppInterrupt(keyData))) {
			this.#oauthAbort.abort("MCP OAuth flow cancelled by user");
			return;
		}

		if (keyData === "\x03") {
			this.#onCancelCallback();
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			if (this.#currentStep === "name") {
				this.#onCancelCallback();
				return;
			}

			this.#goBack();
			return;
		}

		if (this.#inputField) {
			if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
				this.#saveInputAndProceed();
				return;
			}

			this.#inputField.handleInput(keyData);
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrentOption();
			return;
		}

		if (matchesSelectUp(keyData)) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(keyData)) {
			this.#moveSelection(1);
			return;
		}
	}

	#saveInputAndProceed(): void {
		if (!this.#inputField) return;

		const value = this.#inputField.getValue().trim();

		switch (this.#currentStep) {
			case "name": {
				const nameError = validateServerName(value);
				if (nameError) {
					this.#validationError = nameError;
					this.#renderStep();
					return;
				}
				this.#validationError = null;
				this.#state.name = value;
				this.#currentStep = "transport";
				this.#selectedIndex = 0;
				break;
			}
			case "command":
				if (!value) {
					return;
				}
				this.#state.command = value;
				this.#currentStep = "args";
				break;
			case "args":
				this.#state.args = value;
				void this.#testConnectionAndDetectAuth();
				return;
			case "url": {
				if (!value) {
					this.#validationError = "URL is required";
					this.#renderStep();
					return;
				}
				let parsedUrl: URL;
				try {
					parsedUrl = new URL(value);
				} catch {
					this.#validationError = "Invalid URL format (must start with http:// or https://)";
					this.#renderStep();
					return;
				}
				if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
					this.#validationError = "URL must use http:// or https:// scheme";
					this.#renderStep();
					return;
				}
				this.#validationError = null;
				this.#state.url = value;
				void this.#testConnectionAndDetectAuth();
				return;
			}
			case "oauth-auth-url":
				if (!value) return;
				this.#state.oauthAuthUrl = value;
				this.#currentStep = "oauth-token-url";
				break;
			case "oauth-token-url":
				if (!value) return;
				this.#state.oauthTokenUrl = value;
				this.#currentStep = "oauth-client-id";
				break;
			case "oauth-client-id":
				if (!value) return;
				this.#state.oauthClientId = value;
				this.#currentStep = "oauth-client-secret";
				break;
			case "oauth-client-secret":
				this.#state.oauthClientSecret = value;
				this.#currentStep = "oauth-scopes";
				break;
			case "oauth-scopes":
				this.#state.oauthScopes = value;

				void this.#launchOAuthFlow();
				return;
			case "apikey":
				if (!value) {
					return;
				}
				this.#state.apiKey = value;

				if (this.#state.transport === "stdio") {
					this.#currentStep = "env-var-name";
				} else {
					this.#currentStep = "auth-location";
					this.#selectedIndex = 0;
				}
				break;
			case "env-var-name":
				if (!value) {
					return;
				}
				this.#state.envVarName = value;
				this.#state.authLocation = "env";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				break;
			case "header-name":
				if (!value) {
					return;
				}
				this.#state.headerName = value;
				this.#state.authLocation = "header";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				break;
		}

		this.#inputField = null;
		this.#renderStep();
	}

	#selectCurrentOption(): void {
		switch (this.#currentStep) {
			case "transport": {
				const transports: TransportType[] = ["stdio", "http", "sse"];
				this.#state.transport = transports[this.#selectedIndex];
				this.#currentStep = this.#state.transport === "stdio" ? "command" : "url";
				break;
			}
			case "auth-method": {
				const authMethods: Array<"oauth" | "manual"> = ["oauth", "manual"];
				this.#state.authMethod = authMethods[this.#selectedIndex];
				if (this.#state.authMethod === "oauth") {
					this.#currentStep = "oauth-auth-url";
				} else {
					this.#currentStep = "apikey";
				}
				break;
			}
			case "oauth-error":
				if (this.#selectedIndex === 0) {
					void this.#launchOAuthFlow();
				} else {
					this.#currentStep = "oauth-auth-url";
				}
				return;
			case "auth-location": {
				const authLocations: Array<"env" | "header"> = ["env", "header"];
				this.#state.authLocation = authLocations[this.#selectedIndex];
				if (this.#state.authLocation === "env") {
					this.#currentStep = "env-var-name";
				} else {
					this.#currentStep = "header-name";
				}
				break;
			}
			case "scope": {
				const scopes: Scope[] = ["user", "project"];
				this.#state.scope = scopes[this.#selectedIndex];
				this.#currentStep = "confirm";
				this.#selectedIndex = 0;
				break;
			}
			case "confirm": {
				if (this.#selectedIndex === 0) {
					this.#complete();
					return;
				}
				this.#currentStep = "scope";
				this.#selectedIndex = this.#state.scope === "user" ? 0 : 1;
				break;
			}
		}

		this.#renderStep();
	}

	#moveSelection(delta: number): void {
		const maxIndex = this.#getMaxIndexForCurrentStep();
		this.#selectedIndex = (this.#selectedIndex + delta + maxIndex + 1) % (maxIndex + 1);
		this.#renderStep();
		this.#requestRender();
	}

	#getMaxIndexForCurrentStep(): number {
		switch (this.#currentStep) {
			case "transport":
				return 2;
			case "auth-method":
				return 1;
			case "oauth-error":
				return 1;
			case "auth-location":
				return 1;
			case "scope":
				return 1;
			case "confirm":
				return 1;
			default:
				return 0;
		}
	}

	#goBack(): void {
		switch (this.#currentStep) {
			case "transport":
				this.#currentStep = "name";
				break;
			case "command":
			case "url":
				this.#currentStep = "transport";
				this.#selectedIndex = this.#state.transport === "stdio" ? 0 : this.#state.transport === "http" ? 1 : 2;
				break;
			case "args":
				this.#currentStep = "command";
				break;
			case "auth-method":
				if (this.#state.transport === "stdio") {
					this.#currentStep = "args";
				} else {
					this.#currentStep = "url";
				}
				break;
			case "oauth-auth-url":
			case "apikey":
				if (this.#state.transport === "stdio") {
					this.#currentStep = "args";
				} else {
					this.#currentStep = "url";
				}
				break;
			case "auth-location":
				this.#currentStep = "apikey";
				break;
			case "env-var-name":
			case "header-name":
				if (this.#state.transport === "stdio") {
					this.#currentStep = "apikey";
				} else {
					this.#currentStep = "auth-location";
					this.#selectedIndex = this.#state.authLocation === "env" ? 0 : 1;
				}
				break;
			case "oauth-token-url":
			case "oauth-client-id":
			case "oauth-client-secret":
			case "oauth-scopes":
				if (this.#currentStep === "oauth-token-url") {
					this.#currentStep = "oauth-auth-url";
				} else if (this.#currentStep === "oauth-client-id") {
					this.#currentStep = "oauth-token-url";
				} else if (this.#currentStep === "oauth-client-secret") {
					this.#currentStep = "oauth-client-id";
				} else if (this.#currentStep === "oauth-scopes") {
					this.#currentStep = "oauth-client-secret";
				}
				break;
			case "scope":
				if (this.#state.authMethod === "oauth") {
					this.#currentStep = "oauth-scopes";
				} else {
					if (this.#state.authLocation === "env") {
						this.#currentStep = "env-var-name";
					} else {
						this.#currentStep = "header-name";
					}
				}
				break;
			case "oauth-error":
				this.#currentStep = "oauth-auth-url";
				break;
			case "confirm":
				this.#currentStep = "scope";
				this.#selectedIndex = this.#state.scope === "user" ? 0 : 1;
				break;
		}

		this.#renderStep();
	}

	#renderAuthMethodStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "Step: Authentication Method")));
		this.#contentContainer.addChild(new Spacer(1));

		const options = [
			{ value: "oauth" as const, label: "OAuth flow (web-based)", desc: "(opens browser)" },
			{ value: "manual" as const, label: "Manual API key/token", desc: "(paste or use shell command)" },
		];

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", option.label) : option.label;
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
			if (!isSelected) {
				this.#contentContainer.addChild(new Text(`    ${theme.fg("dim", option.desc)}`, 0, 0));
			}
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
		);
	}

	#renderOAuthAuthUrlStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth: Authorization URL")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the OAuth authorization endpoint:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthAuthUrl);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "e.g., https://auth.example.com/oauth/authorize"), 0, 0),
		);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderOAuthTokenUrlStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth: Token URL")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter the OAuth token endpoint:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthTokenUrl);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "e.g., https://auth.example.com/oauth/token"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderOAuthClientIdStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth: Client ID")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter your OAuth client ID:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthClientId);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderOAuthClientSecretStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth: Client Secret (Optional)")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter your OAuth client secret:", 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "(Leave empty for PKCE-only flows)"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthClientSecret);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderOAuthScopesStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth: Scopes (Optional)")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter OAuth scopes (space-separated):", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.oauthScopes);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "e.g., read write"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	#renderOAuthErrorStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("error", "OAuth authentication failed"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Choose next action:", 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		const options = ["Retry OAuth authentication", "Edit OAuth settings"];
		for (let i = 0; i < options.length; i++) {
			const isSelected = i === this.#selectedIndex;
			const prefix = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const text = isSelected ? theme.fg("accent", options[i]) : options[i];
			this.#contentContainer.addChild(new Text(prefix + text, 0, 0));
		}

		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
		);
	}

	#renderApiKeyStep(): void {
		this.#contentContainer.addChild(new Text(theme.fg("accent", "API Key Required")));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Enter your API key or token:", 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "(Supports !command for password manager)"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));

		this.#inputField = new Input();
		this.#inputField.setValue(this.#state.apiKey);
		this.#contentContainer.addChild(this.#inputField);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "[Enter to continue, Esc to go back]"), 0, 0));
	}

	async #testConnectionAndDetectAuth(): Promise<void> {
		const testConfig = this.#buildServerConfig();

		if (!this.#onTestConnectionCallback) {
			this.#currentStep = "scope";
			this.#selectedIndex = 0;
			this.#renderStep();
			return;
		}

		try {
			await this.#onTestConnectionCallback(testConfig);

			this.#contentContainer.clear();
			this.#contentContainer.addChild(new Text(theme.fg("success", "✓ Connection successful!"), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text("No authentication required", 0, 0));
			this.#contentContainer.addChild(new Spacer(1));

			setTimeout(() => {
				this.#state.authMethod = "none";
				this.#currentStep = "scope";
				this.#selectedIndex = 0;
				this.#renderStep();
			}, 1000);
		} catch (error) {
			const authResult = analyzeAuthError(error as Error, this.#state.url);

			if (authResult.requiresAuth) {
				let oauth = authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;
				if (!oauth && this.#state.transport !== "stdio" && this.#state.url) {
					try {
						oauth = await discoverOAuthEndpoints(
							this.#state.url,
							authResult.authServerUrl,
							authResult.resourceMetadataUrl,
							{ protectedScopes: authResult.scopes },
						);
					} catch {}
				}
				if (oauth && !oauth.scopes && authResult.resourceMetadataUrl) {
					const scopes = await fetchResourceMetadataScopes(authResult.resourceMetadataUrl);
					if (scopes) oauth = { ...oauth, scopes };
				}

				if (oauth) {
					this.#state.oauthAuthUrl = oauth.authorizationUrl;
					this.#state.oauthTokenUrl = oauth.tokenUrl;
					this.#state.oauthRegistrationUrl = oauth.registrationUrl || "";
					this.#state.oauthClientId = oauth.clientId || "";
					this.#state.oauthScopes = oauth.scopes || "";
					this.#state.oauthResource = oauth.resource || (this.#state.transport === "stdio" ? "" : this.#state.url);
					this.#state.authMethod = "oauth";

					this.#contentContainer.clear();
					this.#contentContainer.addChild(new Text(theme.fg("success", "✓ OAuth detected"), 0, 0));
					this.#contentContainer.addChild(new Spacer(1));
					this.#contentContainer.addChild(new Text("Launching browser for authorization...", 0, 0));
					this.#contentContainer.addChild(new Spacer(1));

					void this.#launchOAuthFlow();
					return;
				}

				this.#contentContainer.clear();
				this.#contentContainer.addChild(new Text(theme.fg("warning", "Authentication required"), 0, 0));
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text("OAuth parameters could not be discovered.", 0, 0));
				this.#contentContainer.addChild(new Text("Provide API key/token manually.", 0, 0));
				this.#contentContainer.addChild(new Spacer(1));
				this.#currentStep = "apikey";
				this.#renderStep();
			} else {
				const errorMsg = sanitize(error instanceof Error ? error.message : String(error));
				this.#contentContainer.clear();
				this.#contentContainer.addChild(new Text(theme.fg("error", "✗ Connection failed"), 0, 0));
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(errorMsg, 0, 0));
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("muted", "Adding server anyway..."), 0, 0));

				setTimeout(() => {
					this.#state.authMethod = "none";
					this.#currentStep = "scope";
					this.#selectedIndex = 0;
					this.#renderStep();
				}, 2000);
			}
		}
	}

	#buildServerConfig(): MCPServerConfig {
		return this.#buildServerConfigWithAuth(false);
	}

	#buildServerConfigWithAuth(includeAuth: boolean): MCPServerConfig {
		const transport = this.#state.transport ?? "stdio";

		if (transport === "stdio") {
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: this.#state.command,
				timeout: 5000,
			};

			if (this.#state.args) {
				config.args = this.#state.args.split(/\s+/).filter(Boolean);
			}

			if (includeAuth && this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
				config.auth = {
					type: "oauth",
					credentialId: this.#state.oauthCredentialId,
					tokenUrl: this.#state.oauthTokenUrl || undefined,
					resource: this.#state.oauthResource || undefined,
					clientId: this.#state.oauthClientId || undefined,
					clientSecret: this.#state.oauthClientSecret || undefined,
				};
			}

			if (includeAuth && this.#state.authMethod === "manual" && this.#state.apiKey) {
				config.env = {
					...(config.env ?? {}),
					[this.#state.envVarName || "API_KEY"]: this.#state.apiKey,
				};
			}

			return config;
		}

		const config: MCPHttpServerConfig | MCPSseServerConfig = {
			type: transport,
			url: this.#state.url,
			timeout: 5000,
		};

		if (includeAuth && this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
			config.auth = {
				type: "oauth",
				credentialId: this.#state.oauthCredentialId,
				tokenUrl: this.#state.oauthTokenUrl || undefined,
				resource: this.#state.oauthResource || undefined,
				clientId: this.#state.oauthClientId || undefined,
				clientSecret: this.#state.oauthClientSecret || undefined,
			};
		}

		if (includeAuth && this.#state.authMethod === "manual" && this.#state.apiKey) {
			if (this.#state.authLocation === "env") {
				config.headers = {
					...(config.headers ?? {}),
					[this.#state.headerName || "Authorization"]: this.#state.apiKey,
				};
			} else {
				const headerName = this.#state.headerName || "Authorization";
				config.headers = {
					...(config.headers ?? {}),
					[headerName]: this.#state.apiKey,
				};
			}
		}

		return config;
	}

	async #launchOAuthFlow(): Promise<void> {
		if (!this.#onOAuthCallback) {
			this.#contentContainer.clear();
			this.#contentContainer.addChild(new Text(theme.fg("error", "OAuth flow not available"), 0, 0));
			this.#renderStep();
			this.#requestRender();
			return;
		}

		if (!this.#state.oauthAuthUrl || !this.#state.oauthTokenUrl) {
			this.#contentContainer.clear();
			this.#contentContainer.addChild(new Text(theme.fg("error", "OAuth configuration incomplete"), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text("Authorization and Token URLs are required.", 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("muted", "[Press Esc to go back]"), 0, 0));
			this.#requestRender();
			return;
		}

		this.#contentContainer.clear();
		this.#contentContainer.addChild(new Text(theme.fg("accent", "OAuth Authentication"), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text("Launching OAuth flow...", 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "Browser will open automatically."), 0, 0));
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(
			new Text(theme.fg("warning", "If browser doesn't open, copy the URL from chat."), 0, 0),
		);
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("muted", "(Press Esc to cancel)"), 0, 0));
		this.#requestRender();

		this.#oauthAbort = new AbortController();
		try {
			const oauthResource = this.#state.oauthResource || (this.#state.transport === "stdio" ? "" : this.#state.url);
			const oauthResult = await this.#onOAuthCallback(
				this.#state.oauthAuthUrl,
				this.#state.oauthTokenUrl,
				this.#state.oauthClientId,
				this.#state.oauthClientSecret,
				this.#state.oauthScopes,
				{
					serverUrl: this.#state.url || undefined,
					registrationUrl: this.#state.oauthRegistrationUrl || undefined,
					resource: oauthResource || undefined,
					abortSignal: this.#oauthAbort.signal,
				},
			);

			this.#state.oauthCredentialId = oauthResult.credentialId;
			if (oauthResult.clientId) this.#state.oauthClientId = oauthResult.clientId;
			this.#state.oauthResource = oauthResult.resource ?? oauthResource;

			this.#contentContainer.clear();
			this.#contentContainer.addChild(new Text(theme.fg("success", "✓ Authentication successful!"), 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("muted", "Running connection health check..."), 0, 0));
			const spinnerFrames = theme.spinnerFrames;
			const initialFrame = spinnerFrames[0] ?? "|";
			const healthText = new Text(theme.fg("muted", `${initialFrame} Checking server connection...`), 0, 0);
			this.#contentContainer.addChild(healthText);

			let spinnerIndex = 0;
			const spinner = setInterval(() => {
				healthText.setText(
					theme.fg("muted", `${spinnerFrames[spinnerIndex % spinnerFrames.length]} Checking server connection...`),
				);
				spinnerIndex++;
				this.#requestRender();
			}, 80);

			let healthPassed = true;
			let healthError = "";
			if (this.#onTestConnectionCallback) {
				try {
					const { promise: timeoutPromise, reject: timeoutReject } = Promise.withResolvers<never>();
					const timer = setTimeout(
						() => timeoutReject(new Error("Health check timed out after 10 seconds")),
						10_000,
					);
					try {
						await Promise.race([
							this.#onTestConnectionCallback(this.#buildServerConfigWithAuth(true)),
							timeoutPromise,
						]);
					} finally {
						clearTimeout(timer);
					}
				} catch (error) {
					healthPassed = false;
					healthError = sanitize(error instanceof Error ? error.message : String(error));
				}
			}

			clearInterval(spinner);
			if (healthPassed) {
				healthText.setText(theme.fg("success", "✓ Health check passed"));
			} else {
				healthText.setText(theme.fg("warning", "Health check failed (will still save config)"));
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("muted", healthError), 0, 0));
			}
			this.#requestRender();

			setTimeout(
				() => {
					this.#currentStep = "scope";
					this.#selectedIndex = 0;
					this.#renderStep();
					this.#requestRender();
				},
				healthPassed ? 1000 : 2000,
			);
		} catch (error) {
			const cancelled = error instanceof Error && error.name === "MCPOAuthCancelledError";
			const errorMsg = sanitize(error instanceof Error ? error.message : String(error));
			this.#contentContainer.clear();
			this.#contentContainer.addChild(
				new Text(
					cancelled ? theme.fg("muted", "○ OAuth cancelled") : theme.fg("error", "✗ OAuth authentication failed"),
					0,
					0,
				),
			);
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(errorMsg, 0, 0));
			this.#contentContainer.addChild(new Spacer(1));

			if (cancelled) {
				this.#contentContainer.addChild(
					new Text(theme.fg("muted", "Tip: Choose Retry to launch the browser again."), 0, 0),
				);
			} else if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
				this.#contentContainer.addChild(
					new Text(theme.fg("muted", "Tip: Complete authorization faster next time"), 0, 0),
				);
			} else if (errorMsg.includes("Invalid OAuth URLs")) {
				this.#contentContainer.addChild(
					new Text(theme.fg("muted", "Tip: Check that the OAuth URLs are correct"), 0, 0),
				);
			} else if (errorMsg.includes("ECONNREFUSED")) {
				this.#contentContainer.addChild(
					new Text(theme.fg("muted", "Tip: Verify the OAuth server is accessible"), 0, 0),
				);
			}

			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(`${theme.fg("accent", "→ ")}Retry`, 0, 0));
			this.#contentContainer.addChild(new Text("  Edit OAuth settings", 0, 0));
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(
				new Text(theme.fg("muted", "[↑↓ to navigate, Enter to select, Esc to go back]"), 0, 0),
			);
			this.#requestRender();

			this.#selectedIndex = 0;
			this.#currentStep = "oauth-error";
		} finally {
			this.#oauthAbort = null;
		}
	}

	#complete(): void {
		if (!this.#state.scope) return;

		const config: MCPServerConfig = this.#buildConfig();

		this.#onCompleteCallback(this.#state.name, config, this.#state.scope);
	}

	#buildConfig(): MCPServerConfig {
		if (this.#state.transport === "stdio") {
			const config: MCPStdioServerConfig = {
				type: "stdio",
				command: this.#state.command,
			};

			if (this.#state.args) {
				config.args = this.#state.args.split(/\s+/).filter(Boolean);
			}

			if (this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
				config.auth = {
					type: "oauth",
					credentialId: this.#state.oauthCredentialId,
					tokenUrl: this.#state.oauthTokenUrl || undefined,
					resource: this.#state.oauthResource || undefined,
					clientId: this.#state.oauthClientId || undefined,
					clientSecret: this.#state.oauthClientSecret || undefined,
				};
			}

			if (this.#state.authMethod === "manual" && this.#state.apiKey) {
				const envKey = this.#state.envVarName || "API_KEY";
				config.env = {
					[envKey]: this.#state.apiKey,
				};
			}

			return config;
		}

		const config: MCPHttpServerConfig | MCPSseServerConfig = {
			type: this.#state.transport!,
			url: this.#state.url,
		};

		if (this.#state.authMethod === "oauth" && this.#state.oauthCredentialId) {
			config.auth = {
				type: "oauth",
				credentialId: this.#state.oauthCredentialId,
				tokenUrl: this.#state.oauthTokenUrl || undefined,
				resource: this.#state.oauthResource || undefined,
				clientId: this.#state.oauthClientId || undefined,
				clientSecret: this.#state.oauthClientSecret || undefined,
			};
		}

		if (this.#state.authMethod === "manual" && this.#state.apiKey) {
			if (this.#state.authLocation === "env") {
				const headerName = this.#state.headerName || "Authorization";
				config.headers = {
					[headerName]: this.#state.apiKey,
				};
			} else {
				const headerName = this.#state.headerName || "Authorization";
				config.headers = {
					[headerName]: this.#state.apiKey,
				};
			}
		}

		return config;
	}
}
