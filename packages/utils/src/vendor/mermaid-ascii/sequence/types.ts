







export interface SequenceDiagram {
  
  actors: Actor[]
  
  messages: Message[]
  
  blocks: Block[]
  
  notes: Note[]
}

export interface Actor {
  id: string
  label: string
  
  type: 'participant' | 'actor'
}

export interface Message {
  from: string
  to: string
  label: string
  
  lineStyle: 'solid' | 'dashed'
  
  arrowHead: 'filled' | 'open'
  
  activate?: boolean
  
  deactivate?: boolean
}

export interface Block {
  
  type: 'loop' | 'alt' | 'opt' | 'par' | 'critical' | 'break' | 'rect'
  
  label: string
  
  startIndex: number
  
  endIndex: number
  
  dividers: Array<{ index: number; label: string }>
}

export interface Note {
  
  actorIds: string[]
  
  text: string
  
  position: 'left' | 'right' | 'over'
  
  afterIndex: number
}


export interface Lifeline {
  actorId: string
  x: number
  topY: number
  bottomY: number
}


export interface Activation {
  actorId: string
  x: number
  topY: number
  bottomY: number
  width: number
}
