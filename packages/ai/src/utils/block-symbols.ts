export const kStreamingPartialJson = Symbol("provider.block.partialJson");

export type StreamingPartialJsonCarrier = object & { [kStreamingPartialJson]?: string };

export function getStreamingPartialJson(block: StreamingPartialJsonCarrier | null | undefined): string | undefined {
	return block?.[kStreamingPartialJson];
}

export function setStreamingPartialJson(block: StreamingPartialJsonCarrier, value: string | undefined): void {
	block[kStreamingPartialJson] = value;
}

export function clearStreamingPartialJson(block: StreamingPartialJsonCarrier): void {
	if (Object.hasOwn(block, kStreamingPartialJson)) block[kStreamingPartialJson] = undefined;
}

export const kStreamingBlockIndex = Symbol("provider.block.index");

export const kStreamingLastParseLen = Symbol("provider.block.lastParseLen");

export const kStreamingEnvelopeId = Symbol("provider.block.envelopeId");

export const kStreamingArgumentsDone = Symbol("provider.block.argumentsDone");

export const kStreamingBlockKind = Symbol("provider.block.kind");

export const kCursorExecResolved = Symbol("provider.block.cursorExecResolved");

export type CursorExecResolvedCarrier = object & { [kCursorExecResolved]?: true };

export function isCursorExecResolved(block: CursorExecResolvedCarrier | null | undefined): boolean {
	return block?.[kCursorExecResolved] === true;
}

export function copyCursorExecResolved(target: CursorExecResolvedCarrier, source: CursorExecResolvedCarrier): void {
	if (source[kCursorExecResolved] === true) target[kCursorExecResolved] = true;
}

export const kDemotedThinking = Symbol("provider.block.demotedThinking");

export type DemotedThinkingCarrier = object & { [kDemotedThinking]?: boolean };

export function isDemotedThinking(block: DemotedThinkingCarrier | null | undefined): boolean {
	return block?.[kDemotedThinking] === true;
}

export const kConversationalUser = Symbol("provider.message.conversationalUser");

export type ConversationalUserCarrier = object & { [kConversationalUser]?: boolean };

export function isConversationalUser(message: ConversationalUserCarrier | null | undefined): boolean {
	return message?.[kConversationalUser] === true;
}

export const kSyntheticUser = Symbol("provider.message.syntheticUser");

export type SyntheticUserCarrier = object & { [kSyntheticUser]?: boolean };

export function isSyntheticUser(message: SyntheticUserCarrier | null | undefined): boolean {
	return message?.[kSyntheticUser] === true;
}

export const kPerCallContextMessage = Symbol("agent.message.perCallContext");

export type PerCallContextMessageCarrier = object & { [kPerCallContextMessage]?: true };

export function markPerCallContextMessage(message: PerCallContextMessageCarrier): void {
	message[kPerCallContextMessage] = true;
}

export function copyPerCallContextMessage(
	target: PerCallContextMessageCarrier,
	source: PerCallContextMessageCarrier,
): void {
	if (source[kPerCallContextMessage] === true) target[kPerCallContextMessage] = true;
}

export function isPerCallContextMessage(message: PerCallContextMessageCarrier | null | undefined): boolean {
	return message?.[kPerCallContextMessage] === true;
}

export const kContextHistoryIndex = Symbol("agent.message.contextHistoryIndex");

export type ContextHistoryIndexCarrier = object & { [kContextHistoryIndex]?: number };

export function getContextHistoryIndex(message: ContextHistoryIndexCarrier | null | undefined): number | undefined {
	return message?.[kContextHistoryIndex];
}

export function setContextHistoryIndex(message: ContextHistoryIndexCarrier, index: number): void {
	message[kContextHistoryIndex] = index;
}

export function clearContextHistoryIndex(message: ContextHistoryIndexCarrier): void {
	delete message[kContextHistoryIndex];
}
