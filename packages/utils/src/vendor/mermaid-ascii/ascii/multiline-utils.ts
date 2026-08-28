







import { displayWidth } from '../text-metrics'


export function splitLines(label: string): string[] {
  return label.split('\n')
}


export function maxLineWidth(label: string): number {
  const lines = splitLines(label)
  return Math.max(...lines.map(l => displayWidth(l)), 0)
}


export function lineCount(label: string): number {
  return splitLines(label).length
}
