'use strict';

/** Match complete, unchanged declarations in the source measured by the coverage baseline. */

const ts = require('typescript');

/** Numbered line ranges that uniquely belong to one statement or class member. */
function declarationRanges(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  if (source.parseDiagnostics.length > 0) return [];
  const starts = source.getLineStarts();
  const ranges = [];

  function add(node, classHeader = '') {
    const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const last = source.getLineAndCharacterOfPosition(node.end - 1).line + 1;
    const lines = text.slice(starts[first - 1], starts[last] ?? text.length);
    ranges.push({ first, last, key: JSON.stringify([node.kind, classHeader, lines]) });
  }

  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && statement.members.length > 0) {
      const header = text.slice(statement.getStart(source), statement.members.pos);
      for (const member of statement.members) add(member, header);
    } else {
      add(statement);
    }
  }
  return ranges.filter(({ first, last }, index) =>
    (index === 0 || ranges[index - 1].last < first)
    && (index === ranges.length - 1 || last < ranges[index + 1].first));
}

/** A repeated declaration cannot identify one original coverage location. */
function uniqueRanges(ranges) {
  const index = new Map();
  for (const range of ranges) index.set(range.key, index.has(range.key) ? undefined : range);
  return index;
}

/**
 * Map current source lines to offsets in unaltered declarations from the measured revision.
 * @param file Repository-relative TypeScript path.
 * @param measured Original source with its recorded digest already verified.
 * @param current Current source using the same newline normalization.
 * @returns A source map for unique declarations that preserve their relative order.
 */
function coverageSourceAnchors(file, measured, current) {
  const originalRanges = uniqueRanges(declarationRanges(file, measured));
  const currentRanges = uniqueRanges(declarationRanges(file, current));
  const lines = new Map();
  let lastOriginalLine = 0;
  for (const [key, range] of currentRanges) {
    const original = originalRanges.get(key);
    if (range === undefined || original === undefined) continue;
    if (original.first <= lastOriginalLine) return new Map();
    lastOriginalLine = original.last;
    const span = { first: range.first, last: range.last, offset: original.first - range.first };
    for (let line = range.first; line <= range.last; line++) lines.set(line, span);
  }
  return lines;
}

module.exports = { coverageSourceAnchors };
