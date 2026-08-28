







export interface ClassDiagram {
  
  classes: ClassNode[]
  
  relationships: ClassRelationship[]
  
  namespaces: ClassNamespace[]
}

export interface ClassNode {
  id: string
  label: string
  
  annotation?: string
  
  attributes: ClassMember[]
  
  methods: ClassMember[]
}

export interface ClassMember {
  
  visibility: '+' | '-' | '#' | '~' | ''
  
  name: string
  
  type?: string
  
  isStatic?: boolean
  
  isAbstract?: boolean
  
  isMethod?: boolean
  
  params?: string
}


export type RelationshipType =
  | 'inheritance'   
  | 'composition'   
  | 'aggregation'   
  | 'association'   
  | 'dependency'    
  | 'realization'   

export interface ClassRelationship {
  from: string
  to: string
  type: RelationshipType
  
  markerAt: 'from' | 'to'
  
  label?: string
  
  fromCardinality?: string
  
  toCardinality?: string
}

export interface ClassNamespace {
  name: string
  classIds: string[]
}
