// ============================================================================
// Sequence diagram types
//
// Models the parsed and positioned representations of a Mermaid sequence diagram.
// Sequence diagrams show actor interactions over time (vertical timeline).
// ============================================================================

/** Parsed sequence diagram — logical structure from mermaid text */
export interface SequenceDiagram {
  /** Ordered list of actors/participants */
  actors: Actor[]
  /** Messages between actors in chronological order */
  messages: Message[]
  /** Structural blocks (loop, alt, opt, par, critical) */
  blocks: Block[]
  /** Notes attached to actors */
  notes: Note[]
}

export interface Actor {
  id: string
  label: string
  /** 'participant' renders as a box, 'actor' renders as a stick figure */
  type: 'participant' | 'actor'
}

export interface Message {
  from: string
  to: string
  label: string
  /** Arrow style: solid line or dashed line */
  lineStyle: 'solid' | 'dashed'
  /** Arrow head: filled (closed) or open */
  arrowHead: 'filled' | 'open'
  /** Activate the target lifeline (+) */
  activate?: boolean
  /** Deactivate the source lifeline (-) */
  deactivate?: boolean
}

export interface Block {
  /** Block type keyword */
  type: 'loop' | 'alt' | 'opt' | 'par' | 'critical' | 'break' | 'rect'
  /** Label for the block header */
  label: string
  /** Index of the first message inside this block */
  startIndex: number
  /** Index of the last message inside this block (inclusive) */
  endIndex: number
  /** For alt/par blocks: indices where "else"/"and" dividers appear (message indices) */
  dividers: Array<{ index: number; label: string }>
}

export interface Note {
  /** Which actor(s) the note is attached to */
  actorIds: string[]
  /** Note text content */
  text: string
  /** Position relative to the actor(s) */
  position: 'left' | 'right' | 'over'
  /** Message index after which this note appears */
  afterIndex: number
}

/** Vertical dashed line from actor to bottom of diagram */
export interface Lifeline {
  actorId: string
  x: number
  topY: number
  bottomY: number
}

/** Narrow rectangle on a lifeline showing active processing */
export interface Activation {
  actorId: string
  x: number
  topY: number
  bottomY: number
  width: number
}
