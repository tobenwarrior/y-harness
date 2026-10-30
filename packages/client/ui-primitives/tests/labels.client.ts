import type {
  DiffBlockLabels,
  JsonTreeLabels,
  MarkdownLabels,
  ReadBlockLabels,
  SearchBlockLabels,
  TerminalBlockLabels,
  WebBlockLabels,
} from '../src/index.ts'

export const markdownLabels: MarkdownLabels = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
  footnotes: 'Footnotes',
}

export const diffBlockLabels: DiffBlockLabels = {
  codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Unwrap lines',
  copy: 'Copy', copied: 'Copied', collapseAria: 'Collapse diff',
  expandAria: hidden => `Expand remaining ${hidden} diff lines`,
  collapse: 'Collapse', expand: hidden => `… ${hidden} remaining lines`,
}

export const readBlockLabels: ReadBlockLabels = {
  codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Unwrap lines',
  window: (shown, total) => `Showing ${shown} / ${total} lines`,
  copy: 'Copy', copied: 'Copied', collapseAria: 'Collapse content',
  expandAria: hidden => `Expand remaining ${hidden} lines`,
  collapse: 'Collapse', expand: hidden => `… ${hidden} remaining lines`,
}

export const searchBlockLabels: SearchBlockLabels = {
  pathsSummary: (shown, total, truncated) => truncated
    ? `Showing ${shown} / ${total} paths`
    : `${shown} paths`,
  matchesSummary: (shown, total, files, truncated) => truncated
    ? `Showing ${shown} / ${total} matches · ${files} files`
    : `${shown} matches · ${files} files`,
  copy: 'Copy', copied: 'Copied', noResults: 'No results',
  collapseAria: 'Collapse results',
  expandAria: hidden => `Expand remaining ${hidden} result lines`,
  collapse: 'Collapse', expand: hidden => `… ${hidden} remaining lines`,
}

export const terminalBlockLabels: TerminalBlockLabels = {
  signal: signal => `Signal ${signal}`,
  exitCode: code => `Exit code ${code}`,
  noExitCode: 'Did not exit normally',
  running: 'Running', failed: 'Failed', done: 'Done',
  copy: 'Copy', copied: 'Copied', noOutput: 'No output',
  collapseAria: 'Collapse output', collapse: 'Collapse',
  expandAria: hidden => `Expand remaining ${hidden} output lines`,
  expand: hidden => `… ${hidden} remaining lines`,
}

export const jsonTreeLabels: JsonTreeLabels = {
  copyValue: 'Copy value', copyJson: 'Copy JSON', copyPath: 'Copy property path',
  copyPrettyJson: 'Copy pretty JSON', copyCompactJson: 'Copy compact JSON',
  copied: 'Copied', copyFailed: 'Copy failed',
  collapseNode: 'Collapse JSON node', expandNode: 'Expand JSON node',
  copyButtonTitle: action => `${action}; right-click for copy options`,
}

export const webBlockLabels: WebBlockLabels = {
  noResults: 'No results found', sourcesTruncated: 'Source list truncated',
  http: 'HTTP', contentTruncated: 'Content truncated', markdown: markdownLabels,
}
