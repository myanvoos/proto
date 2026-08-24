// ============================================================================
// ASCII renderer — multi-line text utilities
//
// Shared utilities for handling multi-line labels (containing \n from <br> tags)
// in ASCII/Unicode rendering. Provides consistent text splitting, sizing, and
// centered rendering across all diagram types.
// ============================================================================

import { displayWidth } from '../text-metrics'

/**
 * Split a label into lines.
 * Labels are already normalized by parsers (br tags → \n).
 */
export function splitLines(label: string): string[] {
  return label.split('\n')
}

/**
 * Get the maximum line width for sizing calculations.
 * Used to determine column widths for multi-line labels.
 */
export function maxLineWidth(label: string): number {
  const lines = splitLines(label)
  return Math.max(...lines.map(l => displayWidth(l)), 0)
}

/**
 * Get the number of lines for height calculations.
 * Used to determine row heights for multi-line labels.
 */
export function lineCount(label: string): number {
  return splitLines(label).length
}
