'use strict';

/**
 * Istanbul coverage reporter printing one clickable `path:line:col` record per
 * uncovered statement, branch path, and function. Vitest's per-file threshold
 * failures name only the file; this reporter supplies the exact locations.
 * The GitHub baseline admits existing gaps only in declarations identical
 * to the measured source.
 *
 * CommonJS by requirement: istanbul-reports loads custom reporters with a bare
 * require() outside the tsx/ESM pipeline (istanbul-reports index.js create()),
 * so this file can be neither TypeScript nor ESM. Wired into vitest.config.ts
 * by absolute path — require() would resolve a relative specifier against
 * istanbul-reports' own directory.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { ReportBase } = require('istanbul-lib-report');

/**
 * End column of a location that spans to the end of its start line. Whole-line
 * statements carry `Infinity` until a partition blob serializes it, which the
 * partition reporter replaces with this finite column
 * (scripts/coverage-canonical-locations.ts); both spellings read as line ends.
 */
const END_OF_LINE_COLUMN = Number.MAX_SAFE_INTEGER;

/**
 * Editor-convention `line:column` of an istanbul location start (istanbul
 * columns are 0-based; editors and terminal link handlers expect 1-based).
 */
function pos(loc, offset = 0) {
  return `${loc.start.line + offset}:${loc.start.column + 1}`;
}

/** Whether a location carries a usable 1-based start line. */
function usable(loc) {
  return Boolean(loc && loc.start && Number.isFinite(loc.start.line) && loc.start.line >= 1);
}

/** Whether an end column marks its line's end instead of a measured position. */
function atLineEnd(column) {
  return !Number.isFinite(column) || column >= END_OF_LINE_COLUMN;
}

/**
 * ` (to line:col)` suffix when the range end adds information beyond the
 * start. v8-remapped whole-line statements end at their line end; those
 * degrade to a line-only suffix, or to nothing on a single line.
 */
function endSuffix(loc, offset) {
  const end = loc?.end;
  if (!loc?.start || !end || !Number.isFinite(end.line) || end.line < 1) return '';
  if (atLineEnd(end.column)) {
    return end.line === loc.start.line ? '' : ` (to ${end.line + offset})`;
  }
  if (end.line === loc.start.line && end.column === loc.start.column) return '';
  return ` (to ${end.line + offset}:${end.column + 1})`;
}

function recordText({ loc, detail }, offset = 0) {
  const suffix = detail === 'statement' ? endSuffix(loc, offset) : '';
  return `${pos(loc, offset)} uncovered ${detail}${suffix}`;
}

/** Anonymous ordinals depend on other declarations in the instrumented file. */
function stableFunctionName(text) {
  return text.replace(/ uncovered function \(anonymous_\d+\)$/, ' uncovered function (anonymous)');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readBaseline(file) {
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObject(baseline) || baseline.version !== 1 || baseline.platform !== process.platform
    || !Number.isSafeInteger(baseline.job) || baseline.job <= 0 || !isObject(baseline.files)
    || (baseline.sourceTree !== undefined
      && (typeof baseline.sourceTree !== 'string' || !/^[a-f0-9]{40}$/.test(baseline.sourceTree)))) {
    throw new Error('Invalid coverage baseline for this platform.');
  }
  for (const [name, entry] of Object.entries(baseline.files)) {
    if (!/^packages\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/src\/[a-z0-9_./-]+\.tsx?$/i.test(name)
      || name.split('/').some(segment => segment === '.' || segment === '..' || segment === '')
      || !isObject(entry) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Array.isArray(entry.uncovered) || entry.uncovered.length === 0
      || !entry.uncovered.every(item => typeof item === 'string' && /^\d+:\d+ uncovered (statement|branch|function)(?: |$)/.test(item))) {
      throw new Error(`Invalid coverage baseline entry: ${name}`);
    }
  }
  return baseline;
}

function sourceDigest(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Read the measured source by Git tree id and repository-relative path. */
function readMeasuredSource(root, tree, file) {
  try {
    return execFileSync('git', ['show', `${tree}:${file}`], {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    }).replace(/\r\n/g, '\n');
  } catch (error) {
    throw new Error(`${file}: measured coverage source is unavailable in tree ${tree}`, { cause: error });
  }
}

/** Return the carried offset only if the coverage span fits inside the unchanged declaration. */
function retainedOffset(anchors, { loc, span }) {
  const anchor = anchors.get(loc.start.line);
  if (anchor === undefined || !usable(span) || !Number.isFinite(span.end?.line)) return undefined;
  const end = span.end;
  const last = end.column === 0 && end.line > span.start.line ? end.line - 1 : end.line;
  return span.start.line >= anchor.first && last <= anchor.last ? anchor.offset : undefined;
}

class UncoveredLocationsReport extends ReportBase {
  constructor(opts = {}) {
    super(opts);
    // Vitest passes the resolved config root alongside reporter options.
    this.projectRoot = opts.projectRoot || process.cwd();
    this.baselineFile = opts.baselineFile;
  }

  onStart() {
    this.records = [];
    if (this.baselineFile === undefined) return;
    this.baseline = readBaseline(this.baselineFile);
    this.measured = new Set();
    this.failures = [];
    this.allowedCount = 0;
  }

  onDetail(node) {
    const fc = node.getFileCoverage();
    const rel = path.relative(this.projectRoot, fc.path).split(path.sep).join('/');
    const items = [];
    const functionsAtPosition = new Map();
    let unmapped = 0;
    const add = (loc, detail, span = loc) => {
      if (!usable(loc)) {
        unmapped += 1;
        return;
      }
      items.push({ loc, detail, span });
    };

    for (const id of Object.keys(fc.statementMap)) {
      if (fc.s[id] !== 0) continue;
      const loc = fc.statementMap[id];
      add(loc, 'statement');
    }

    for (const id of Object.keys(fc.fnMap)) {
      const fn = fc.fnMap[id];
      const loc = usable(fn.decl) ? fn.decl : fn.loc;
      if (this.baseline?.sourceTree !== undefined && usable(loc)) {
        const key = pos(loc);
        functionsAtPosition.set(key, (functionsAtPosition.get(key) ?? 0) + 1);
      }
      if (fc.f[id] !== 0) continue;
      const name = fn.name ? ` ${fn.name}` : '';
      add(loc, `function${name}`, fn.loc);
    }

    for (const id of Object.keys(fc.branchMap)) {
      const counts = fc.b[id];
      const branch = fc.branchMap[id];
      for (let i = 0; i < counts.length; i += 1) {
        if (counts[i] !== 0) continue;
        // Implicit arms (e.g. a missing else) may carry an empty location;
        // fall back to the branch's own span so the record stays clickable.
        const loc = usable(branch.locations && branch.locations[i]) ? branch.locations[i] : branch.loc;
        add(loc, `branch (${branch.type}, path ${i + 1}/${counts.length})`, branch.loc);
      }
    }

    items.sort((a, b) => a.loc.start.line - b.loc.start.line || a.loc.start.column - b.loc.start.column);
    if (this.baseline !== undefined) {
      this.checkFile(rel, fc.path, items, unmapped, functionsAtPosition);
      return;
    }
    for (const item of items) this.records.push(`${rel}:${recordText(item)}`);
  }

  checkFile(rel, file, items, unmapped, functionsAtPosition) {
    this.measured.add(rel);
    if (unmapped > 0) this.failures.push(`${rel}: ${unmapped} uncovered locations could not be identified`);
    if (items.length === 0) return;

    const entry = this.baseline.files[rel];
    let anchors;
    if (entry !== undefined) {
      const current = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      if (sourceDigest(current) !== entry.sha256) {
        if (this.baseline.sourceTree === undefined) {
          this.failures.push(`${rel}: changed source still has ${items.length} uncovered locations`);
          return;
        }
        const measured = readMeasuredSource(this.projectRoot, this.baseline.sourceTree, rel);
        if (sourceDigest(measured) !== entry.sha256) {
          this.failures.push(`${rel}: measured source does not match the recorded digest`);
          return;
        }
        const { coverageSourceAnchors } = require('./coverage-source-anchors.cjs');
        anchors = coverageSourceAnchors(rel, measured, current);
      }
    }
    const remaining = new Map();
    for (const location of entry?.uncovered ?? []) {
      const key = anchors === undefined ? location : stableFunctionName(location);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const item of items) {
      const offset = anchors === undefined ? 0 : retainedOffset(anchors, item);
      let original = offset === undefined ? undefined : recordText(item, offset);
      if (anchors !== undefined && original !== undefined && functionsAtPosition.get(pos(item.loc)) === 1) {
        original = stableFunctionName(original);
      }
      const count = remaining.get(original) ?? 0;
      if (count === 0) this.failures.push(`${rel}:${recordText(item)}`);
      else {
        remaining.set(original, count - 1);
        this.allowedCount += 1;
      }
    }
  }

  verifyBaseline() {
    if (this.measured.size === 0) this.failures.push('No source files were measured.');
    for (const name of Object.keys(this.baseline.files)) {
      if (!this.measured.has(name) && statSync(path.resolve(this.projectRoot, name), { throwIfNoEntry: false }) !== undefined) {
        this.failures.push(`${name}: expected coverage measurement is missing`);
      }
    }
    if (this.failures.length > 0) {
      throw new Error(`Coverage baseline rejected ${this.failures.length} results:\n${this.failures.slice(0, 50).join('\n')}`);
    }
    console.log(`Coverage baseline accepted ${this.allowedCount} existing gaps across ${this.measured.size} measured files.`);
  }

  onEnd() {
    if (this.baseline !== undefined) {
      this.verifyBaseline();
      return;
    }
    if (this.records.length === 0) return;
    console.log(`\nUncovered locations (per-file 100% gate): ${this.records.length}`);
    for (const record of this.records) console.log(record);
    console.log('');
  }
}

module.exports = UncoveredLocationsReport;
