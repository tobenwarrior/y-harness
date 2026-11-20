import { createGraph, groupColor } from "./map-graph.js";

const POLL_MS = 2000;
const PAGE_SIZE = 60;
const MAX_FILES = 5000;
const MAX_QUERY = 512;
const API = Object.freeze({ projects: "/api/projects", map: "/api/map", status: "/api/status", file: "/api/file" });
const ids = ["project-select","refresh-button","sidebar","sidebar-button","sidebar-close","inspector","inspector-button","inspector-close","notice-strip","notice-title","notice-detail","notice-dismiss","sidebar-count","file-search","tree-state","file-tree","clear-folder","show-more","coverage-summary","coverage-detail","root-name","scope-name","graph-mode","graph","graph-tooltip","graph-loading","loading-detail","graph-empty","empty-title","empty-detail","empty-reset","graph-error","error-detail","retry-button","fit-button","zoom-in","zoom-out","zoom-reset","layout-state","layout-light","graph-summary","focus-summary","changed-count","inspector-empty","file-detail","repository-summary","inspector-title","detail-breadcrumb","detail-path","detail-summary","analysis-note","source-button","context-button","path-button","neighborhood-button","impact-button","trace-button","trace-panel","trace-target","trace-files","trace-result","connections-panel","symbols-panel","impact-panel","import-list","importer-list","symbol-list","symbol-note","detail-import-count","detail-importer-count","detail-symbol-count","unresolved-section","unresolved-count","unresolved-list","exports-section","export-list","impact-count","impact-note","impact-list","show-impact","history-back","history-forward","live-status","live-status-text","total-files","total-lines","total-symbols","branch-name","toast","source-dialog","source-title","source-meta","source-content","source-note","source-close"];
const refs = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const str = (value, fallback = "") => typeof value === "string" ? value : fallback;
const num = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const count = value => Math.round(value).toLocaleString();
const amount = (value, noun) => count(value) + " " + noun + (value === 1 ? "" : "s");
const unique = values => [...new Set(values)];
const base = path => path.split("/").pop() || path;
const parent = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const group = path => path.includes("/") ? path.split("/").slice(0, Math.min(2, path.split("/").length - 1)).join("/") : "/";
// The service keeps undecodable name bytes as lone surrogates U+DC80-U+DCFF, which encodeURIComponent rejects, so send the bytes.
const encodePath = path => Array.from(path, char => { const code = char.codePointAt(0); return code >= 0xdc80 && code <= 0xdcff ? "%" + (code - 0xdc00).toString(16).toUpperCase() : encodeURIComponent(char); }).join("");
const make = (tag, content, className) => {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = String(content);
  if (className) node.className = className;
  return node;
};
// An embedded viewer uses its host's authenticated proxy. The standalone page gets a read-only launch credential.
const viewerAccess = (() => {
  if (location.protocol !== "http:" || location.hostname !== "127.0.0.1" || !["/", "/index.html", "/code-map.html"].includes(location.pathname)) return "";
  const key = "compound-map-access";
  const grant = new URLSearchParams(location.hash.slice(1)).get("access");
  if (grant !== null) {
    history.replaceState(null, "", location.pathname + location.search);
    if (/^[0-9a-f]{64}$/.test(grant)) {
      try { sessionStorage.setItem(key, grant); } catch { /* The current page still has its credential. */ }
      return grant;
    }
  }
  try { return sessionStorage.getItem(key) || ""; } catch { return ""; }
})();
const params = new URLSearchParams(location.search);
const state = {
  projects: [], project: params.get("project") || "", name: "", model: null, lookup: new Map(), reverse: new Map(), edges: [],
  query: params.get("query") || "", selected: params.get("file") || null, folder: "", view: "all", browse: "folders", detail: "connections", page: 0,
  history: [], historyIndex: -1, revision: null, instance: "", error: "", status: null, dismissed: "", timer: null, epoch: 0, mapBusy: "", statusBusy: "", queryTimer: null,
  trace: [], impact: { paths: new Set(), limited: false }, graphStats: null, graphEdges: 0, toastTimer: null, sourceRequest: null, sourceReturn: null, used: "",
};
const graph = createGraph(refs.graph, {
  onSelect: id => chooseFile(id),
  onHover: id => { refs["graph-tooltip"].hidden = !id; const label = (id || "").split("/").pop(); refs["graph-tooltip"].textContent = label.length <= 30 ? label : "Open file details"; },
  onStats: stats => {
    state.graphStats = stats;
    refs["layout-state"].textContent = stats.layoutActive ? "Arranging" : "Settled";
    refs["layout-light"].dataset.active = String(Boolean(stats.layoutActive));
    const nodes = num(stats.nodes ?? stats.nodeCount);
    const edges = state.graphEdges;
    const drawn = num(stats.drawnEdges ?? edges);
    refs["graph-summary"].textContent = amount(nodes, "file") + " · " + amount(edges, "import") + (drawn < edges ? " · " + count(drawn) + " drawn" : "");
    refs.graph.setAttribute("aria-label", "Dependency graph: " + count(nodes) + " files, " + count(edges) + " recorded imports" + (state.selected ? ". Selected " + state.selected : ""));
  },
});

function normalizeModel(payload) {
  const raw = payload && payload.model && typeof payload.model === "object" ? payload.model : {};
  const coverage = raw.coverage && typeof raw.coverage === "object" ? raw.coverage : {};
  const files = (Array.isArray(raw.files) ? raw.files : []).slice(0, MAX_FILES).filter(file => file && typeof file.path === "string").map(file => ({
    path: file.path, language: str(file.language, "unknown"), lines: num(file.lines), analysis: str(file.analysis, "metadata"), outlineNote: str(file.outline_note),
    symbols: (Array.isArray(file.symbols) ? file.symbols : []).slice(0, 512).filter(symbol => symbol && typeof symbol.name === "string").map(symbol => ({ name: symbol.name, kind: str(symbol.kind, "symbol"), line: num(symbol.line), signature: str(symbol.signature) })),
    dependencies: unique((Array.isArray(file.dependencies) ? file.dependencies : []).filter(path => typeof path === "string")).slice(0, 256),
    exports: (Array.isArray(file.exports) ? file.exports : []).filter(value => typeof value === "string").slice(0, 512),
    unresolved: (Array.isArray(file.unresolved_imports) ? file.unresolved_imports : []).filter(value => typeof value === "string").slice(0, 128),
    cochanges: (Array.isArray(file.cochanges) ? file.cochanges : []).filter(value => value && typeof value.path === "string").slice(0, 6).map(value => ({ path: value.path, count: num(value.count) })),
    changed: str(file.changed),
  })).sort((a, b) => a.path.localeCompare(b.path));
  return { root: str(raw.root_name, "Code map"), branch: str(raw.branch), head: str(raw.head), files, coverage: {
    inventory: num(coverage.inventory), excluded: num(coverage.excluded), available: num(coverage.available ?? files.length), outOfView: num(coverage.response_skipped), skipped: Math.max(0, num(coverage.skipped) - num(coverage.response_skipped)), truncated: Boolean(coverage.truncated),
    notes: (Array.isArray(coverage.notes) ? coverage.notes : []).filter(note => typeof note === "string"),
    exclusions: coverage.excluded_reasons && typeof coverage.excluded_reasons === "object" ? Object.entries(coverage.excluded_reasons).map(([reason, total]) => count(num(total)) + " " + reason + (Number(total) === 1 ? "" : "s")) : [],
  } };
}

function indexModel(model) {
  state.lookup = new Map(model.files.map(file => [file.path, file]));
  state.reverse = new Map(model.files.map(file => [file.path, []]));
  state.edges = [];
  for (const file of model.files) file.search = [file.path, file.language, ...file.symbols.map(symbol => symbol.name)].join(" ").toLowerCase();
  for (const file of model.files) for (const dependency of file.dependencies) {
    if (!state.lookup.has(dependency)) continue;
    state.reverse.get(dependency).push(file.path);
    state.edges.push({ source: file.path, target: dependency });
  }
  state.reverse.forEach(paths => paths.sort());
}

function matcher() {
  const query = state.query.toLowerCase(), terms = query.trim().split(/\s+/).filter(Boolean), words = query.match(/[\p{L}\p{N}_$]+/gu) || [];
  const every = list => file => list.every(term => file.search.includes(term));
  // Like the service's ranking, a topic falls back to its words split at punctuation, all of them and then any of them.
  const strict = [every(terms), ...(words.length ? [every(words)] : [])].find(test => !state.model || state.model.files.some(test));
  return strict || (file => words.some(word => file.search.includes(word)));
}
function scopedFiles() { return state.model ? state.model.files.filter(file => !state.folder || group(file.path) === state.folder) : []; }
function updateUrl() {
  const next = new URLSearchParams();
  if (state.project) next.set("project", state.project);
  if (state.query) next.set("query", state.query);
  if (state.selected) next.set("file", state.selected);
  history.replaceState(null, "", location.pathname + (next.size ? "?" + next : ""));
}
async function fetchJson(url, signal) {
  const headers = { Accept: "application/json" };
  if (viewerAccess) headers.Authorization = "Bearer " + viewerAccess;
  const response = await fetch(url, { headers, cache: "no-store", signal });
  if (response.status === 401) throw new Error("Open the map again from your project to authorize this viewer.");
  let value;
  try { value = await response.json(); } catch { throw new Error("The local service returned an unreadable response."); }
  if (!response.ok) throw new Error(str(value.error, "Local service error (" + response.status + ")"));
  return value;
}
function toast(message) {
  refs.toast.textContent = message; refs.toast.hidden = false;
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { refs.toast.hidden = true; }, 2600);
}
// True while code-map.css makes the panel a drawer over the graph, the only state it gives position:fixed. A docked inspector stays open beside the Files drawer, and Escape closes that drawer first.
const floating = name => getComputedStyle(refs[name]).position === "fixed";
function drawer(name, open) {
  if (open && (name === "inspector" || floating("inspector"))) {
    const other = name === "sidebar" ? "inspector" : "sidebar";
    // A floating panel hides as it closes, so focus in it moves to the button of the panel taking its place. Safari focuses no tapped button, which leaves focus there.
    if (refs[other].contains(document.activeElement) && floating(other)) refs[name + "-button"].focus();
    refs[other].classList.remove("is-open"); refs[other + "-button"].setAttribute("aria-expanded", "false");
  }
  refs[name].classList.toggle("is-open", open);
  refs[name + "-button"].setAttribute("aria-expanded", String(open));
  if (open) state.used = name;
  if (!open && refs[name].contains(document.activeElement)) refs[name + "-button"].focus();
}
function setOverlay(kind, title, detail) {
  ["loading", "empty", "error"].forEach(name => { refs["graph-" + name].hidden = name !== kind; });
  if (kind === "empty") { refs["empty-title"].textContent = title; refs["empty-detail"].textContent = detail; }
  if (kind === "error") refs["error-detail"].textContent = detail;
  if (kind === "loading") refs["loading-detail"].textContent = detail;
}
function renderProjects() {
  refs["project-select"].replaceChildren(...state.projects.map(project => {
    const option = make("option", project.name); option.value = project.id; return option;
  }));
  refs["project-select"].value = state.project;
}
function renderStatus() {
  const error = state.error || str(state.status?.error);
  // The service also reports indexing while it checks an unchanged repository, so a loaded map stays Ready.
  const status = error ? "error" : state.model ? "live" : state.status?.indexing ? "indexing" : "loading";
  const label = status === "live" ? "Ready" : status === "error" ? "Offline" : status === "indexing" ? "Indexing" : "Connecting";
  refs["live-status"].dataset.state = status;
  if (refs["live-status-text"].textContent !== label) refs["live-status-text"].textContent = label;
  const issues = state.model?.coverage.notes.filter(note => !note.includes("import links are heuristic") && !note.includes("response file cap")) || [];
  const coverage = state.model?.coverage;
  const partial = coverage && (coverage.skipped || coverage.truncated || issues.length);
  const key = error || (partial ? JSON.stringify([coverage.skipped, coverage.truncated, issues]) : "");
  refs["notice-strip"].hidden = !key || key === state.dismissed;
  refs["notice-strip"].classList.toggle("error", Boolean(error));
  refs["notice-title"].textContent = error ? "Update unavailable" : coverage?.skipped || issues.length ? "Incomplete index" : "Limited view";
  refs["notice-detail"].textContent = error ? error + (state.model ? " The last map remains available." : "") : [coverage?.outOfView ? count(coverage.outOfView) + " indexed files outside this view; search to find them" : "", coverage?.skipped ? count(coverage.skipped) + " source files skipped" : "", issues[0]].filter(Boolean).join(" · ");
}
function renderSummary() {
  const files = state.model?.files || [];
  const lines = files.reduce((total, file) => total + file.lines, 0);
  const symbols = files.reduce((total, file) => total + file.symbols.length, 0);
  refs["root-name"].textContent = state.name || state.model?.root || "Code map";
  refs["sidebar-count"].textContent = count(files.length) + " files";
  // Beside a docked inspector at the narrowest widths three digits no longer fit, so code-map.css leaves such a count to screen readers there.
  const changed = files.filter(file => file.changed).length;
  refs["changed-count"].textContent = count(changed); refs["changed-count"].classList.toggle("is-long", changed >= 100);
  refs["total-files"].textContent = count(files.length) + " files";
  refs["total-lines"].textContent = count(lines) + " lines";
  refs["total-symbols"].textContent = count(symbols) + " symbols";
  refs["branch-name"].textContent = state.model?.branch ? "⑂ " + state.model.branch : state.model?.head ? state.model.head.slice(0, 8) : "";
  const coverage = state.model?.coverage;
  refs["coverage-summary"].textContent = count(coverage?.available ?? files.length) + " indexed" + (coverage?.outOfView ? " · " + count(files.length) + " in view" : "") + (coverage?.excluded ? " · " + count(coverage.excluded) + " excluded" : "");
  refs["coverage-detail"].textContent = coverage ? [count(coverage.inventory) + " repository files considered.", ...coverage.exclusions, ...coverage.notes].join(" ") : "Waiting for the index.";
  const folders = unique(files.map(file => group(file.path))).length;
  refs["repository-summary"].replaceChildren(make("span", count(files.length) + " files across " + count(folders) + " folder groups"), make("span", count(state.edges.length) + " recorded imports"), make("span", "Python AST · JS/TS outlines · local metadata"));
}

function createFileRow(file) {
  const button = make("button", undefined, "file-row"); button.setAttribute("aria-current", String(file.path === state.selected));
  const copy = make("span", undefined, "row-copy"); copy.append(make("span", base(file.path), "row-name"), make("span", parent(file.path) || "/", "row-path"));
  button.append(make("span", file.language === "python" ? "py" : file.language === "typescript" ? "ts" : "◇", "file-glyph"), copy);
  if (file.changed) button.append(make("span", file.changed === "untracked" ? "U" : file.changed[0].toUpperCase(), "change-mark"));
  button.addEventListener("click", () => { chooseFile(file.path); drawer("sidebar", false); }); return button;
}
function renderTree() {
  document.querySelectorAll("[data-browse]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.browse === state.browse)));
  refs["clear-folder"].hidden = !state.folder;
  const files = scopedFiles().filter(matcher());
  const mode = state.browse === "folders" && state.query ? "files" : state.browse;
  let items;
  if (mode === "folders") {
    const groups = new Map();
    for (const file of files) { const key = group(file.path); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(file); }
    items = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([name, members]) => ({ name, members }));
  } else if (mode === "symbols") {
    const terms = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    items = files.flatMap(file => file.symbols.filter(symbol => {
      const haystack = [symbol.name, file.path, file.language].join(" ").toLowerCase();
      return terms.every(term => haystack.includes(term));
    }).map(symbol => ({ file, symbol })));
  } else items = files;
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE)); state.page = state.page >= pages ? 0 : state.page;
  const fragment = document.createDocumentFragment();
  for (const item of items.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)) {
    if (mode === "folders") {
      const button = make("button", undefined, "folder-row"); button.setAttribute("aria-pressed", String(item.name === state.folder)); button.dataset.key = item.name;
      const dot = make("canvas", undefined, "folder-dot"); dot.width = dot.height = 8; const ctx = dot.getContext("2d"); ctx.fillStyle = groupColor(item.name); ctx.fillRect(0, 0, 8, 8);
      button.append(dot, make("span", item.name, "row-label"), make("span", count(item.members.length), "row-count"));
      button.addEventListener("click", () => { state.folder = item.name; state.browse = "files"; state.page = 0; renderTree(); renderGraph(true); }); fragment.append(button);
    } else if (mode === "symbols") {
      const button = make("button", undefined, "symbol-row"); button.setAttribute("aria-current", String(item.file.path === state.selected)); button.dataset.key = item.file.path + ":" + item.symbol.name;
      const copy = make("span", undefined, "row-copy"); copy.append(make("span", item.symbol.name, "row-name"), make("span", item.file.path + ":" + item.symbol.line, "row-path"));
      button.append(make("span", item.symbol.kind === "class" ? "C" : "ƒ", "file-glyph"), copy); button.addEventListener("click", () => { chooseFile(item.file.path); drawer("sidebar", false); openSource(item.file.path, item.symbol.line); }); fragment.append(button);
    } else fragment.append(createFileRow(item));
  }
  if (!items.length) fragment.append(make("p", state.model ? "No matching " + mode + "." : "Reading index…", "detail-empty"));
  refs["file-tree"].replaceChildren(fragment);
  refs["tree-state"].textContent = (items.length === 1 ? "1 " + (mode === "symbols" ? "symbol" : mode.slice(0, -1)) : count(items.length) + " " + mode) + (pages > 1 ? " · page " + (state.page + 1) + "/" + pages : "");
  refs["show-more"].hidden = pages <= 1; refs["show-more"].textContent = state.page + 1 < pages ? "Next " + PAGE_SIZE + " →" : "Back to first page ↻";
}

function walkDependents(path) {
  const seen = new Set([path]), queue = [path]; let steps = 0, index = 0;
  while (index < queue.length && steps < 300000) {
    for (const next of state.reverse.get(queue[index++]) || []) { steps += 1; if (!seen.has(next)) { seen.add(next); queue.push(next); } }
  }
  seen.delete(path); return { paths: seen, limited: index < queue.length };
}
function traceImports(start, target) {
  const previous = new Map([[start, null]]), queue = [start]; let index = 0, steps = 0;
  while (index < queue.length && steps < 300000) {
    const path = queue[index++];
    if (path === target) { const result = []; for (let next = target; next; next = previous.get(next)) result.push(next); return { paths: result.reverse(), limited: false }; }
    for (const next of state.lookup.get(path)?.dependencies || []) { steps += 1; if (state.lookup.has(next) && !previous.has(next)) { previous.set(next, path); queue.push(next); } }
  }
  return { paths: [], limited: index < queue.length };
}
function chooseFile(path, record = true) {
  if (!state.lookup.has(path)) return;
  state.selected = path; state.trace = []; refs["trace-result"].textContent = "";
  if (state.folder && group(path) !== state.folder) state.folder = "";
  if (state.query && !matcher()(state.lookup.get(path))) { state.query = ""; refs["file-search"].value = ""; }
  if (record && state.history[state.historyIndex] !== path) { state.history = state.history.slice(0, state.historyIndex + 1); state.history.push(path); state.historyIndex = state.history.length - 1; }
  if (state.view === "trace") state.view = "neighbors";
  state.impact = walkDependents(path); updateUrl(); keepingFocus(() => { renderTree(); renderInspector(); renderGraph(); }); graph.select(path); drawer("inspector", true);
}
function renderGraph(fit = false) {
  if (!state.model) { state.graphEdges = 0; graph.setData({ nodes: [], edges: [], selected: null }); setOverlay("loading", "", "Connecting to the local index…"); return; }
  // Selection views follow imports across folders, so the folder filter applies to the others only.
  const scoped = !["neighbors", "impact", "trace"].includes(state.view);
  let files = scoped ? scopedFiles() : state.model.files;
  const matching = files.filter(matcher());
  if (state.query && !matching.length) { state.graphEdges = 0; graph.setData({ nodes: [], edges: [], selected: null }); setOverlay("empty", "No matching files", "Try a file, folder, language, or symbol name."); return; }
  let allowed;
  if (state.view === "neighbors") allowed = new Set(state.selected ? [state.selected, ...(state.lookup.get(state.selected)?.dependencies || []), ...(state.reverse.get(state.selected) || [])] : []);
  if (state.view === "changed") {
    const changed = files.filter(file => file.changed); allowed = new Set(changed.map(file => file.path));
    for (const file of changed) { file.dependencies.forEach(path => allowed.add(path)); (state.reverse.get(file.path) || []).forEach(path => allowed.add(path)); }
  }
  if (state.view === "impact") allowed = new Set([state.selected, ...state.impact.paths]);
  if (state.view === "trace") allowed = new Set(state.trace);
  if (allowed) files = files.filter(file => allowed.has(file.path));
  if (!files.length) {
    state.graphEdges = 0; graph.setData({ nodes: [], edges: [], selected: null });
    setOverlay("empty", state.view === "changed" ? "No indexed source changes" : state.view === "neighbors" ? "Choose a file" : "No files to show", state.view === "changed" ? "Changed source files appear here. Deleted or excluded files require your Git diff." : "Select a file from the sidebar to explore its connections.");
  } else {
    setOverlay(null);
    const visible = new Set(files.map(file => file.path));
    const traceEdges = new Set(state.trace.slice(1).map((path, index) => state.trace[index] + "\0" + path));
    const edges = state.view === "all" && !state.folder ? state.edges : state.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target) && (state.view !== "trace" || traceEdges.has(edge.source + "\0" + edge.target)));
    state.graphEdges = edges.length;
    let renderEdges = edges;
    if (edges.length > 120000) {
      const selectedEdges = [], queryEdges = [], sampledEdges = [];
      const highlights = new Set(state.query ? matching.map(file => file.path) : []);
      const stride = Math.ceil(edges.length / 90000);
      edges.forEach((edge, index) => {
        if (edge.source === state.selected || edge.target === state.selected) selectedEdges.push(edge);
        else if (highlights.size && (highlights.has(edge.source) || highlights.has(edge.target)) && queryEdges.length < 20000) queryEdges.push(edge);
        else if (index % stride === 0 && sampledEdges.length < 90000) sampledEdges.push(edge);
      });
      renderEdges = selectedEdges.concat(queryEdges, sampledEdges).slice(0, 120000);
    }
    graph.setData({ nodes: files.map(file => ({ id: file.path, path: file.path, group: group(file.path), kind: "file", changed: file.changed })), edges: renderEdges, selected: visible.has(state.selected) ? state.selected : null, query: state.query, mode: state.view, highlightPaths: state.view === "trace" ? state.trace : state.query ? matching.map(file => file.path) : [] });
    if (fit) graph.fit();
  }
  document.querySelectorAll("[data-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === state.view)));
  const names = { all: "everything", neighbors: "selected neighborhood", changed: "changed files + neighbors", impact: "dependent files", trace: "import trace" };
  refs["scope-name"].textContent = "/ " + (scoped && state.folder ? state.folder + " / " : "") + names[state.view];
  refs["graph-mode"].textContent = names[state.view]; refs["focus-summary"].textContent = state.view === "trace" ? "RECORDED IMPORT PATH" : "FOLDER GROUPS";
}
function edgeRow(path, arrow) {
  const item = make("li"), button = make("button", undefined, "edge-row");
  const copy = make("span", undefined, "row-copy"); copy.append(make("span", base(path), "row-name"), make("span", parent(path) || "/", "row-path"));
  button.append(make("span", arrow, "edge-arrow"), copy); button.disabled = !state.lookup.has(path); button.addEventListener("click", () => chooseFile(path)); item.append(button); return item;
}
function renderEdges(element, paths, arrow, maximum = 40) {
  if (!paths.length) { element.replaceChildren(make("li", "No recorded connections.", "detail-empty")); return; }
  element.replaceChildren(...paths.slice(0, maximum).map(path => edgeRow(path, arrow)));
  if (paths.length > maximum) {
    const item = make("li"), more = make("button", "Show " + count(paths.length - maximum) + " more", "show-more"); more.addEventListener("click", () => renderEdges(element, paths, arrow, maximum + 80)); item.append(more); element.append(item);
  }
}
function renderInspector() {
  const file = state.lookup.get(state.selected);
  refs["inspector-empty"].hidden = Boolean(file); refs["file-detail"].hidden = !file;
  refs["history-back"].disabled = state.historyIndex <= 0; refs["history-forward"].disabled = state.historyIndex >= state.history.length - 1;
  if (!file) return;
  const importedBy = state.reverse.get(file.path) || [];
  refs["inspector-title"].textContent = base(file.path); refs["detail-path"].textContent = file.path;
  refs["detail-breadcrumb"].textContent = "Repository › " + (parent(file.path) || "/");
  refs["detail-summary"].textContent = file.language + (file.lines ? ", " + amount(file.lines, "line") : "") + ". " + amount(file.dependencies.length, "import") + " · " + amount(importedBy.length, "importer") + " · " + amount(file.symbols.length, "symbol") + ".";
  const analysis = file.analysis === "python-ast" ? "Python AST outline" : file.analysis === "javascript-outline" ? "JS/TS outline · bounded import resolution" : file.analysis === "heuristic-outline" ? (file.language === "go" || file.language === "rust" ? "Heuristic symbol outline · bounded local imports" : "Heuristic symbol outline · imports unavailable") : "Metadata only · no symbol analysis";
  refs["analysis-note"].textContent = analysis + (file.changed ? " · " + file.changed : "") + (file.outlineNote ? " · " + file.outlineNote : "");
  if (file.cochanges.length) refs["detail-summary"].append(document.createTextNode(" Often changes with " + base(file.cochanges[0].path) + " (" + count(file.cochanges[0].count) + " recent commit" + (file.cochanges[0].count === 1 ? "" : "s") + ")."));
  refs["detail-import-count"].textContent = count(file.dependencies.length); refs["detail-importer-count"].textContent = count(importedBy.length); refs["detail-symbol-count"].textContent = count(file.symbols.length);
  renderEdges(refs["import-list"], file.dependencies, "→"); renderEdges(refs["importer-list"], importedBy, "←");
  refs["unresolved-section"].hidden = !file.unresolved.length; refs["unresolved-count"].textContent = count(file.unresolved.length); refs["unresolved-list"].replaceChildren(...file.unresolved.map(value => make("li", value)));
  refs["symbol-note"].textContent = file.analysis === "metadata" ? "Only file metadata is available for this language." : file.symbols.length ? (file.analysis === "heuristic-outline" ? "Heuristic declarations; select a symbol to inspect its source." : "Select a symbol to inspect its source.") : "No symbols were recorded. Check index coverage for parsing limits.";
  refs["symbol-list"].replaceChildren(...file.symbols.map(symbol => {
    const item = make("li"), button = make("button", undefined, "symbol-button"); button.dataset.key = symbol.kind + ":" + symbol.name;
    button.append(make("span", symbol.kind === "class" ? "C" : "ƒ", "symbol-kind"), make("span", symbol.signature || symbol.name, "symbol-name"), make("span", "L" + symbol.line, "symbol-line"));
    button.addEventListener("click", () => openSource(file.path, symbol.line)); item.append(button); return item;
  }));
  refs["exports-section"].hidden = !file.exports.length; refs["export-list"].replaceChildren(...file.exports.map(name => make("li", name)));
  state.impact = walkDependents(file.path);
  refs["impact-count"].textContent = (state.impact.limited ? "≥ " : "") + count(state.impact.paths.size);
  refs["impact-note"].textContent = "Direct and transitive importers. Recorded imports indicate potential impact, not runtime call behavior." + (state.impact.limited ? " Traversal limit reached." : "") + (state.model?.coverage.truncated || state.model?.coverage.skipped ? " Index limits may omit additional dependents." : "");
  renderEdges(refs["impact-list"], [...state.impact.paths].sort(), "←");
  document.querySelectorAll("[data-detail]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.detail === state.detail)));
  ["connections", "symbols", "impact"].forEach(name => { refs[name + "-panel"].hidden = state.detail !== name; });
}
function contextText(file) {
  const incoming = state.reverse.get(file.path) || [];
  const lines = ["Repository: " + state.name, "File: " + file.path, file.language + " · " + count(file.lines) + " lines · " + file.analysis, "Symbols: " + file.symbols.slice(0, 12).map(symbol => symbol.name + ":" + symbol.line).join(", "), "Imports (" + file.dependencies.length + "): " + file.dependencies.slice(0, 12).join(", "), "Imported by (" + incoming.length + "): " + incoming.slice(0, 12).join(", "), "Structural hints only. Confirm behavior in source and tests."];
  const value = lines.join("\n"); return value.length > 2500 ? value.slice(0, 2450) + "\n[Context trimmed; inspect the map for more.]" : value;
}
async function copy(value, message) {
  try { await navigator.clipboard.writeText(value); toast(message); } catch { toast("Clipboard unavailable. Use your browser’s copy controls."); }
}
async function openSource(path, line = 0) {
  if (!state.lookup.has(path)) return;
  state.sourceRequest?.abort(); const request = new AbortController(); state.sourceRequest = request;
  refs["source-title"].textContent = path; refs["source-meta"].textContent = "Reading from this repository…"; refs["source-content"].replaceChildren(make("p", "Loading source…", "detail-empty")); refs["source-note"].textContent = "Source is read only when requested and is not cached by the service.";
  // The preview shows the inspector's file, so opening it is use of the inspector, even by assistive technology, which can press a button with no pointer or focus event. A click that focused nothing, as in Safari, leaves the dialog no opener to return focus to.
  if (!refs["source-dialog"].open) { state.used = "inspector"; state.sourceReturn = document.activeElement === document.body ? null : rowFinder(document.activeElement); refs["source-dialog"].showModal(); }
  try {
    const payload = await fetchJson(API.file + "?project=" + encodeURIComponent(state.project) + "&path=" + encodePath(path), request.signal);
    if (state.sourceRequest !== request || !refs["source-dialog"].open) return;
    const content = str(payload.content).split(/\r\n|\r|\n/); if (content.at(-1) === "") content.pop();
    const fragment = document.createDocumentFragment();
    content.forEach((value, index) => { const row = make("div", undefined, "source-line" + (index + 1 === line ? " is-focus" : "")); row.append(make("span", index + 1, "source-number"), make("span", value || " ", "source-code")); fragment.append(row); });
    refs["source-content"].replaceChildren(fragment); refs["source-meta"].textContent = str(payload.language) + " · " + count(num(payload.lines) || content.length) + " lines · read from disk";
    refs["source-note"].textContent = payload.truncated ? (line > content.length ? "Line " + count(line) + " is beyond this 64 KiB preview. Open the file in your editor." : "Preview limited to 64 KiB. Open the file in your editor to read the remainder.") : "Read-only preview · source is not cached by the service.";
    refs["source-content"].querySelector(".is-focus")?.scrollIntoView({ block: "center" });
  } catch (error) { if (error.name !== "AbortError") { refs["source-content"].replaceChildren(make("p", error.message, "detail-empty")); refs["source-meta"].textContent = "Source preview unavailable"; } }
}
function closeSource() { state.sourceRequest?.abort(); state.sourceRequest = null; refs["source-dialog"].close(); refs["source-content"].replaceChildren(); }

// Re-renders replace list rows and change the counts and line numbers they show, so a row is found again by its list, its key, and its position among rows sharing that key, such as two run methods.
function rowFinder(row) {
  const list = row?.closest?.("#file-tree, .edge-list, .symbol-list"); if (!list) return () => null;
  const key = node => node.dataset.key || node.title || node.textContent, twins = () => [...list.querySelectorAll("button")].filter(button => key(button) === key(row)), repeat = twins().indexOf(row);
  return () => list.contains(row) ? row : twins()[repeat];
}
// Runs a re-render that may replace the focused row, then focuses the row now in its place, without scrolling a list the user may have scrolled away from it, and without counting as use of its panel.
function keepingFocus(render) {
  const active = document.activeElement, find = rowFinder(active), used = state.used;
  render();
  if (!active?.isConnected) { find()?.focus({ preventScroll: true }); state.used = used; }
}
// True when another panel, such as the Files drawer, lies over the middle of the element, or would once its own panel scrolled it just into view. Overlays that are not panels, such as the toast, neither cover it nor hide a panel that does.
const covered = node => {
  const own = node.closest("aside"), box = node.getBoundingClientRect(), bounds = own?.getBoundingClientRect(), y = box.y + box.height / 2;
  const panel = document.elementsFromPoint(box.x + box.width / 2, bounds ? Math.min(Math.max(y, bounds.top + box.height / 2), bounds.bottom - box.height / 2) : y).find(element => element.localName === "aside");
  return Boolean(panel) && panel !== own;
};
function renderAll() { keepingFocus(() => { renderProjects(); renderSummary(); renderStatus(); renderTree(); renderInspector(); renderGraph(); }); }
function resetTrace() {
  state.trace = []; if (state.view === "trace") state.view = "neighbors";
  refs["trace-panel"].hidden = true; refs["trace-button"].setAttribute("aria-expanded", "false");
  refs["trace-result"].textContent = refs["trace-target"].value = ""; refs["trace-files"].replaceChildren();
}
async function loadMap() {
  const project = state.project, epoch = state.epoch, requestedQuery = state.query, key = epoch + ":" + project;
  if (!project || state.mapBusy === key) return; state.mapBusy = key;
  try {
    // The service counts code points, and cutting UTF-16 units could leave half an emoji, which cannot be encoded.
    const payload = await fetchJson(API.map + "?project=" + encodeURIComponent(project) + "&query=" + encodeURIComponent(Array.from(requestedQuery).slice(0, MAX_QUERY).join("")));
    if (state.project !== project || state.epoch !== epoch) return;
    if (payload.indexing && !payload.model) {
      // A restarted service has no map yet and numbers revisions from zero again, so its first map reloads, as after a failed check.
      state.status = { ...state.status, indexing: true }; state.error = str(payload.error); state.revision = null;
      renderStatus();
      if (!state.model) setOverlay("loading", "", "Indexing source files; the map will appear automatically…");
      return;
    }
    const hadModel = Boolean(state.model); state.model = normalizeModel(payload); indexModel(state.model);
    state.name = str(payload.project?.name, state.model.root); state.revision = num(payload.revision); state.instance = str(payload.instance);
    const current = state.projects.find(value => value.id === project); if (current) current.name = state.name;
    if (!state.lookup.has(state.selected)) {
      resetTrace();
      const matching = state.model.files.filter(matcher());
      const ranked = matching.slice().sort((a, b) => ((state.reverse.get(b.path)?.length || 0) + b.dependencies.length) - ((state.reverse.get(a.path)?.length || 0) + a.dependencies.length));
      state.selected = ranked[0]?.path || null;
      if (state.selected && !state.history.length) { state.history = [state.selected]; state.historyIndex = 0; }
    }
    if (state.history.some(path => !state.lookup.has(path))) {
      const current = state.history[state.historyIndex];
      state.history = state.history.filter(path => state.lookup.has(path));
      state.historyIndex = state.history.lastIndexOf(current);
    }
    if (state.selected && state.history[state.historyIndex] !== state.selected) { state.history.push(state.selected); state.historyIndex = state.history.length - 1; }
    state.error = ""; renderAll(); if (!hadModel) graph.fit(); updateUrl();
  } catch (error) { if (state.epoch === epoch) { state.error = error.message; renderStatus(); if (!state.model) setOverlay("error", "", state.error); } }
  finally {
    if (state.mapBusy === key) state.mapBusy = "";
    if (state.epoch === epoch && requestedQuery !== state.query && state.model?.coverage.truncated) setTimeout(() => loadMap(), 0);
  }
}
async function poll(force = false) {
  if ((!force && document.visibilityState !== "visible") || !state.project) return;
  const epoch = state.epoch, project = state.project, key = epoch + ":" + project;
  if (state.statusBusy === key) return; state.statusBusy = key;
  try {
    const payload = await fetchJson(API.status + "?project=" + encodeURIComponent(project));
    if (state.epoch !== epoch) return;
    state.status = payload; state.error = str(payload.error); renderStatus();
    if (force || !state.model || num(payload.revision) !== state.revision || str(payload.instance) !== state.instance) await loadMap();
  } catch (error) { if (state.epoch === epoch) { state.error = error.message; state.revision = null; renderStatus(); if (!state.model) setOverlay("error", "", state.error); } }
  finally { if (state.statusBusy === key) state.statusBusy = ""; }
}
function startPolling() { clearInterval(state.timer); if (state.project && document.visibilityState === "visible") state.timer = setInterval(() => poll(), POLL_MS); }
async function activateProject(id) {
  if (!id) return; state.epoch += 1; state.project = id; state.name = state.projects.find(project => project.id === id)?.name || "";
  state.model = null; state.revision = null; state.instance = ""; state.status = null; state.error = ""; state.dismissed = ""; state.folder = ""; state.page = 0; state.view = "all"; state.history = []; state.historyIndex = -1; state.trace = []; clearTimeout(state.queryTimer);
  state.lookup = new Map(); state.reverse = new Map(); state.edges = []; closeSource(); renderAll(); updateUrl();
  await poll(true); startPolling();
}
async function loadProjects() {
  try {
    const payload = await fetchJson(API.projects);
    state.projects = (Array.isArray(payload.projects) ? payload.projects : []).filter(project => project && typeof project.id === "string").map(project => ({ id: project.id, name: str(project.name, "Repository") }));
    // An embedding host frames the viewer without ?project= and names its workspace's project as defaultProject.
    const target = state.projects.find(project => project.id === state.project) || (!state.project && (state.projects.find(project => project.id === payload.defaultProject) || state.projects[0]));
    if (target) await activateProject(target.id);
    else { state.error = state.project && state.projects.length ? "This repository is not registered. Open the map again from its project chat." : "No repository is registered. Open the map from a project chat."; renderProjects(); renderStatus(); setOverlay("error", "", state.error); }
  } catch (error) { state.error = error.message; renderStatus(); setOverlay("error", "", state.error); }
}
function setView(view) { state.view = view; state.trace = view === "trace" ? state.trace : []; renderGraph(true); }
function resetScope() { state.folder = ""; state.query = ""; state.view = "all"; state.page = 0; refs["file-search"].value = ""; renderTree(); renderGraph(true); updateUrl(); if (state.model?.coverage.truncated) loadMap(); }
function installInteractions() {
  refs["project-select"].addEventListener("change", event => { state.selected = null; state.query = ""; refs["file-search"].value = ""; activateProject(event.target.value); });
  refs["refresh-button"].addEventListener("click", () => poll(true)); refs["retry-button"].addEventListener("click", loadProjects);
  refs["notice-dismiss"].addEventListener("click", () => { state.dismissed = state.error || JSON.stringify([state.model?.coverage.skipped, state.model?.coverage.truncated, state.model?.coverage.notes.filter(note => !note.includes("import links are heuristic") && !note.includes("response file cap"))]); renderStatus(); });
  refs["sidebar-button"].addEventListener("click", () => drawer("sidebar", !refs.sidebar.classList.contains("is-open"))); refs["sidebar-close"].addEventListener("click", () => drawer("sidebar", false));
  refs["inspector-button"].addEventListener("click", () => drawer("inspector", !refs.inspector.classList.contains("is-open"))); refs["inspector-close"].addEventListener("click", () => drawer("inspector", false));
  // Narrowing until the docked inspector floats again would stack it and a Files drawer opened beside it, so the panel used last keeps the screen. Opening a panel or the source preview, or a tap, focus or scroll in a panel, counts as use, since Safari focuses no tapped button.
  for (const name of ["sidebar", "inspector"]) for (const type of ["pointerdown", "focusin", "wheel"]) refs[name].addEventListener(type, () => { state.used = name; }, { capture: true, passive: true });
  addEventListener("resize", () => { if (refs.sidebar.classList.contains("is-open") && refs.inspector.classList.contains("is-open") && floating("inspector")) drawer(state.used === "inspector" ? "sidebar" : "inspector", false); });
  refs["file-search"].value = state.query;
  refs["file-search"].addEventListener("input", event => {
    state.query = event.target.value; state.page = 0; updateUrl(); renderTree(); renderGraph(true);
    clearTimeout(state.queryTimer);
    if (state.model?.coverage.truncated) state.queryTimer = setTimeout(() => loadMap(), 250);
  });
  refs["show-more"].addEventListener("click", () => { state.page += 1; renderTree(); refs["file-tree"].scrollIntoView({ block: "start" }); });
  refs["clear-folder"].addEventListener("click", resetScope); refs["empty-reset"].addEventListener("click", resetScope);
  document.querySelectorAll("[data-browse]").forEach(button => button.addEventListener("click", () => { state.browse = button.dataset.browse; state.page = 0; renderTree(); }));
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  document.querySelectorAll("[data-detail]").forEach(button => button.addEventListener("click", () => { state.detail = button.dataset.detail; renderInspector(); }));
  refs["neighborhood-button"].addEventListener("click", () => setView("neighbors"));
  ["impact-button", "show-impact"].forEach(id => refs[id].addEventListener("click", () => { state.detail = "impact"; renderInspector(); setView("impact"); }));
  refs["trace-button"].addEventListener("click", () => { refs["trace-panel"].hidden = !refs["trace-panel"].hidden; refs["trace-button"].setAttribute("aria-expanded", String(!refs["trace-panel"].hidden)); if (!refs["trace-panel"].hidden) refs["trace-target"].focus(); });
  refs["trace-target"].addEventListener("input", event => { const query = event.target.value.toLowerCase(); refs["trace-files"].replaceChildren(...(state.model?.files || []).filter(file => file.path.toLowerCase().includes(query)).slice(0, 40).map(file => { const option = make("option"); option.value = file.path; return option; })); });
  refs["trace-panel"].addEventListener("submit", event => {
    event.preventDefault(); const target = refs["trace-target"].value.trim();
    if (!state.selected || !state.lookup.has(target)) { refs["trace-result"].textContent = "Choose a full indexed file path."; return; }
    const forward = traceImports(state.selected, target), result = forward.paths.length ? forward : traceImports(target, state.selected); state.trace = result.paths;
    refs["trace-result"].textContent = result.paths.length ? result.paths.join(" → ") : forward.limited || result.limited ? "Trace search limit reached. Narrow the path using a nearer file." : (state.model?.coverage.truncated || state.model?.coverage.skipped ? "No path was found in this partial index. Confirm with source search." : "No recorded import path connects these files.");
    if (result.paths.length) setView("trace");
  });
  refs["source-button"].addEventListener("click", () => openSource(state.selected)); refs["source-close"].addEventListener("click", closeSource);
  refs["source-dialog"].addEventListener("close", () => {
    state.sourceRequest?.abort(); state.sourceRequest = null; refs["source-content"].replaceChildren();
    // The dialog returns focus to its opener, unless a refresh replaced that row or removed its symbol, or a resize hid it, which leaves focus on the closed dialog. Focus then goes to the first of the row now in its place, Source and Details that can take it and that no other panel covers, without scrolling, like the dialog's own return.
    if (state.sourceReturn && (document.activeElement === document.body || refs["source-dialog"].contains(document.activeElement))) for (const target of [state.sourceReturn(), refs["source-button"], refs["inspector-button"]]) { if (target && !covered(target)) target.focus({ preventScroll: true }); if (document.activeElement === target) break; }
  });
  refs["context-button"].addEventListener("click", () => { const file = state.lookup.get(state.selected); if (file) copy(contextText(file), "Compact context copied · paste into your chat"); });
  refs["path-button"].addEventListener("click", () => copy(state.selected || "", "File path copied"));
  refs["history-back"].addEventListener("click", () => { if (state.historyIndex > 0) chooseFile(state.history[--state.historyIndex], false); });
  refs["history-forward"].addEventListener("click", () => { if (state.historyIndex + 1 < state.history.length) chooseFile(state.history[++state.historyIndex], false); });
  refs["zoom-in"].addEventListener("click", () => graph.zoom(1.25)); refs["zoom-out"].addEventListener("click", () => graph.zoom(.8)); refs["zoom-reset"].addEventListener("click", () => graph.fit()); refs["fit-button"].addEventListener("click", () => graph.fit());
  document.addEventListener("visibilitychange", () => { clearInterval(state.timer); if (document.visibilityState === "visible") { startPolling(); poll(); } });
  document.addEventListener("keydown", event => {
    if (refs["source-dialog"].open) return;
    if (event.key === "Escape") { const files = refs.sidebar.classList.contains("is-open") && floating("sidebar"); drawer("sidebar", false); if (!files) drawer("inspector", false); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (event.key === "/") { event.preventDefault(); if (floating("sidebar")) drawer("sidebar", true); refs["file-search"].focus(); }
    if (event.key.toLowerCase() === "f") graph.fit();
  });
}
installInteractions(); renderAll(); loadProjects();
