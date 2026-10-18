/*
 * Small Canvas2D dependency graph renderer.
 *
 * The renderer deliberately owns only drawing and pointer interaction.  The
 * file list, inspector, and keyboard navigation stay in the surrounding UI;
 * callers can select a file through the returned select() method.
 */

const MAX_NODES = 5000;
const MAX_DRAWN_EDGES = 20000;
const MAX_RELATIONSHIPS = 120000;
const MAX_SCANNED_EDGES = MAX_RELATIONSHIPS * 2;
const MIN_SCALE = 0.12;
const MAX_SCALE = 5;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;
export const FOLDER_PALETTE = Object.freeze([
  "#62d2a2",
  "#74a7ff",
  "#c496ff",
  "#f0b35a",
  "#f37e9b",
  "#5cc8d7",
  "#b9d96b",
  "#e49ac6",
]);

const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const text = (value, fallback = "") => {
  if (typeof value !== "string") return fallback;
  return value;
};

const hashString = value => {
  let hash = 2166136261;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** Return the stable legend color used for a folder group. */
export function groupColor(group) {
  return FOLDER_PALETTE[hashString(text(group, "(root)")) % FOLDER_PALETTE.length];
}

const hashUnit = value => hashString(value) / 4294967296;

const directoryOf = path => {
  const slash = String(path || "").lastIndexOf("/");
  return slash < 0 ? "" : String(path).slice(0, slash);
};

const basename = path => {
  const source = String(path || "");
  const slash = source.lastIndexOf("/");
  return slash < 0 ? source : source.slice(slash + 1) || source;
};

const now = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  return Date.now();
};

const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);

const rectsOverlap = (left, right) => (
  left.x < right.x + right.width
  && left.x + left.width > right.x
  && left.y < right.y + right.height
  && left.y + left.height > right.y
);

/**
 * Create a dependency graph renderer backed by one canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} options
 * @returns {{setData: Function, select: Function, fit: Function, zoom: Function, destroy: Function, getStats: Function}}
 */
export function createGraph(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new TypeError("createGraph(canvas) requires a canvas element");
  }

  const opts = options && typeof options === "object" ? options : {};
  let context = null;
  try {
    context = canvas.getContext("2d", { alpha: true, desynchronized: true });
  } catch (_error) {
    context = canvas.getContext("2d");
  }
  if (!context) throw new Error("createGraph could not acquire a Canvas2D context");

  const ownerDocument = canvas.ownerDocument || (typeof document !== "undefined" ? document : null);
  const ownerWindow = ownerDocument && ownerDocument.defaultView
    ? ownerDocument.defaultView
    : (typeof window !== "undefined" ? window : globalThis);
  const requestFrame = typeof ownerWindow.requestAnimationFrame === "function"
    ? ownerWindow.requestAnimationFrame.bind(ownerWindow)
    : callback => setTimeout(() => callback(now()), 16);
  const cancelFrame = typeof ownerWindow.cancelAnimationFrame === "function"
    ? ownerWindow.cancelAnimationFrame.bind(ownerWindow)
    : clearTimeout;

  const palette = Array.isArray(opts.palette) && opts.palette.length
    ? opts.palette.filter(value => typeof value === "string" && value)
    : FOLDER_PALETTE;
  const onSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;
  const onHover = typeof opts.onHover === "function" ? opts.onHover : null;
  const onStats = typeof opts.onStats === "function" ? opts.onStats : null;
  const layoutBudget = clamp(Math.round(finite(opts.layoutBudget, 180)), 30, 240);

  const state = {
    destroyed: false,
    nodes: [],
    edges: [],
    renderEdges: [],
    byId: new Map(),
    positions: new Map(),
    adjacency: new Map(),
    groupTargets: new Map(),
    colors: new Map(),
    query: "",
    mode: "overview",
    highlightPaths: new Set(),
    selected: null,
    hovered: null,
    width: 1,
    height: 1,
    dpr: 1,
    view: { x: 0, y: 0, scale: 1 },
    didFit: false,
    fitTracking: false,
    cameraInteracted: false,
    nodeGrid: new Map(),
    gridCell: 120,
    frame: null,
    layoutActive: false,
    layoutIterations: 0,
    stableIterations: 0,
    layoutBudget,
    hidden: Boolean(ownerDocument && ownerDocument.visibilityState === "hidden"),
    pointer: null,
    resizeObserver: null,
    lastDrawMs: 0,
    visibleLabels: 0,
    labelOverlaps: 0,
    drawnEdges: 0,
    stats: null,
    topologySignature: "",
    edgePrioritySignature: "",
    edgeTotal: 0,
    scannedEdges: 0,
    validEdgesScanned: 0,
    dedupeKeys: 0,
    scanTruncated: false,
    edgesTruncated: false,
    layoutLimit: layoutBudget,
  };

  const oldTouchAction = canvas.style ? canvas.style.touchAction : "";
  const oldRole = typeof canvas.getAttribute === "function" ? canvas.getAttribute("role") : null;
  const oldAriaLabel = typeof canvas.getAttribute === "function" ? canvas.getAttribute("aria-label") : null;
  const rootLabel = text(
    opts.ariaLabel || opts.rootLabel || opts.rootName,
    "Dependency graph",
  );
  if (typeof canvas.setAttribute === "function") {
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", rootLabel);
  }
  if (canvas.style) canvas.style.touchAction = "none";

  const callback = (fn, value) => {
    if (!fn) return;
    try {
      fn(value);
    } catch (_error) {
      // Rendering should continue if a host callback has a bug.
    }
  };

  function colorFor(group) {
    const key = text(group, "(root)");
    const color = palette === FOLDER_PALETTE ? groupColor(key) : palette[hashString(key) % palette.length];
    if (!state.colors.has(key)) state.colors.set(key, color);
    return state.colors.get(key);
  }

  function getRadius(node) {
    const count = Math.max(0, finite(node.count, 0));
    const base = node.kind === "directory" ? 7.5 : 4.2;
    return clamp(base + Math.sqrt(count) * 0.85, base, node.kind === "directory" ? 15 : 11);
  }

  function screenPoint(position) {
    if (!finitePoint(position)) return null;
    return {
      x: (position.x - state.view.x) * state.view.scale + state.width / 2,
      y: (position.y - state.view.y) * state.view.scale + state.height / 2,
    };
  }

  function worldPoint(x, y) {
    return {
      x: state.view.x + (x - state.width / 2) / state.view.scale,
      y: state.view.y + (y - state.height / 2) / state.view.scale,
    };
  }

  function rebuildGrid() {
    state.nodeGrid.clear();
    const size = state.gridCell;
    state.positions.forEach((position, id) => {
      if (!finitePoint(position)) return;
      const gx = Math.floor(position.x / size);
      const gy = Math.floor(position.y / size);
      const key = `${gx}:${gy}`;
      const bucket = state.nodeGrid.get(key);
      if (bucket) bucket.push(id);
      else state.nodeGrid.set(key, [id]);
    });
  }

  function findNodeAt(screenX, screenY) {
    const point = worldPoint(screenX, screenY);
    const size = state.gridCell;
    const gx = Math.floor(point.x / size);
    const gy = Math.floor(point.y / size);
    let closest = null;
    let closestDistance = Infinity;
    for (let x = gx - 1; x <= gx + 1; x += 1) {
      for (let y = gy - 1; y <= gy + 1; y += 1) {
        const bucket = state.nodeGrid.get(`${x}:${y}`);
        if (!bucket) continue;
        bucket.forEach(id => {
          const node = state.byId.get(id);
          const position = state.positions.get(id);
          if (!node || !position) return;
          const dx = (position.x - point.x) * state.view.scale;
          const dy = (position.y - point.y) * state.view.scale;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const hitRadius = getRadius(node) * state.view.scale + 7;
          if (distance <= hitRadius && distance < closestDistance) {
            closest = node;
            closestDistance = distance;
          }
        });
      }
    }
    return closest;
  }

  function selectedNeighbors() {
    if (!state.selected) return new Set();
    return new Set(state.adjacency.get(state.selected) || []);
  }

  function nodeMatchesQuery(node) {
    if (!state.query) return false;
    const query = state.query.toLocaleLowerCase();
    return node.id.toLocaleLowerCase().includes(query)
      || node.path.toLocaleLowerCase().includes(query)
      || node.group.toLocaleLowerCase().includes(query);
  }

  function nodeIsHighlighted(node) {
    return state.highlightPaths.has(node.id)
      || state.highlightPaths.has(node.path)
      || state.highlightPaths.has(node.group);
  }

  function edgeIsNeighbor(edge, neighbors) {
    return Boolean(state.selected && (edge.source === state.selected || edge.target === state.selected))
      || neighbors.has(edge.source)
      || neighbors.has(edge.target);
  }

  function edgeIsVisible(source, target) {
    const left = screenPoint(source);
    const right = screenPoint(target);
    if (!left || !right) return false;
    const margin = 48;
    return Math.max(left.x, right.x) >= -margin
      && Math.min(left.x, right.x) <= state.width + margin
      && Math.max(left.y, right.y) >= -margin
      && Math.min(left.y, right.y) <= state.height + margin;
  }

  function rebuildRenderEdges() {
    const scored = state.edges.map((edge, index) => {
      let score = 0;
      const source = state.byId.get(edge.source);
      const target = state.byId.get(edge.target);
      if (state.selected && (edge.source === state.selected || edge.target === state.selected)) score += 1000;
      if ((source && nodeIsHighlighted(source)) || (target && nodeIsHighlighted(target))) score += 300;
      if ((source && nodeMatchesQuery(source)) || (target && nodeMatchesQuery(target))) score += 100;
      return { edge, index, score };
    });
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    state.renderEdges = scored.slice(0, MAX_DRAWN_EDGES).map(item => item.edge);
  }

  function labelFor(node, duplicate) {
    const labelCallback = opts.getLabel || opts.label;
    let label = typeof labelCallback === "function" ? labelCallback(node) : basename(node.path);
    label = text(label, basename(node.path) || node.id);
    if (!duplicate) return label;
    const fullPathCallback = opts.fullPath || opts.getFullPath || opts.fullPathForNode;
    const fullPath = typeof fullPathCallback === "function" ? fullPathCallback(node) : node.path;
    const pathText = text(fullPath, node.path || node.id);
    if (pathText === label) return pathText;
    const parent = directoryOf(pathText);
    return parent ? `${label} · ${basename(parent)}` : pathText;
  }

  function truncateLabel(value, maxWidth) {
    if (!value) return "";
    if (context.measureText(value).width <= maxWidth) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = `${value.slice(0, middle)}…`;
      if (context.measureText(candidate).width <= maxWidth) low = middle;
      else high = middle - 1;
    }
    return low > 0 ? `${value.slice(0, low)}…` : "…";
  }

  function buildLabelCandidates(visibleNodes) {
    const bases = new Map();
    visibleNodes.forEach(node => {
      const base = text(
        typeof (opts.getLabel || opts.label) === "function" ? (opts.getLabel || opts.label)(node) : basename(node.path),
        basename(node.path) || node.id,
      );
      const list = bases.get(base);
      if (list) list.push(node.id);
      else bases.set(base, [node.id]);
    });

    const labels = [];
    const neighbors = selectedNeighbors();
    const maxLabels = clamp(Math.round(90 + state.view.scale * 360), 90, 1300);
    visibleNodes.forEach(node => {
      const position = state.positions.get(node.id);
      const point = screenPoint(position);
      if (!point) return;
      const duplicate = (bases.get(text(
        typeof (opts.getLabel || opts.label) === "function" ? (opts.getLabel || opts.label)(node) : basename(node.path),
        basename(node.path) || node.id,
      )) || []).length > 1;
      const selected = node.id === state.selected;
      const hovered = node.id === state.hovered;
      const highlighted = nodeIsHighlighted(node);
      const queryMatch = nodeMatchesQuery(node);
      const focusNeighbor = neighbors.has(node.id);
      const degree = (state.adjacency.get(node.id) || []).length;
      const priority = selected ? 1000000
        : hovered ? 900000
          : highlighted ? 800000
            : queryMatch ? 700000
              : focusNeighbor ? 500000 + Math.min(100000, degree * 20)
                : (node.kind === "directory" ? 200000 : 0) + Math.min(100000, finite(node.count, 0) * 20);
      if (state.nodes.length > 120 && !selected && !hovered && !highlighted && !queryMatch
        && priority < 200000 && state.view.scale < 0.56) return;
      labels.push({ node, point, text: labelFor(node, duplicate), priority });
    });
    labels.sort((left, right) => right.priority - left.priority || left.node.id.localeCompare(right.node.id));
    const representatives = [];
    const representedGroups = new Set();
    labels.forEach(candidate => {
      if (candidate.priority < 500000 || representedGroups.has(candidate.node.group)) return;
      representedGroups.add(candidate.node.group);
      representatives.push(candidate);
    });
    const representativeIds = new Set(representatives.map(candidate => candidate.node.id));
    const remainder = labels.filter(candidate => !representativeIds.has(candidate.node.id));
    return representatives.concat(remainder).slice(0, Math.max(maxLabels * 2, 120));
  }

  function drawLabels(visibleNodes) {
    context.save();
    context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    context.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    context.textBaseline = "middle";
    const candidates = buildLabelCandidates(visibleNodes);
    const accepted = [];
    const labelGrid = new Map();
    const cell = 96;
    let overlaps = 0;
    const remember = (rect, item) => {
      const minX = Math.floor(rect.x / cell);
      const maxX = Math.floor((rect.x + rect.width) / cell);
      const minY = Math.floor(rect.y / cell);
      const maxY = Math.floor((rect.y + rect.height) / cell);
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = `${x}:${y}`;
          const bucket = labelGrid.get(key);
          if (bucket) bucket.push(item);
          else labelGrid.set(key, [item]);
        }
      }
    };
    const collides = rect => {
      const minX = Math.floor(rect.x / cell);
      const maxX = Math.floor((rect.x + rect.width) / cell);
      const minY = Math.floor(rect.y / cell);
      const maxY = Math.floor((rect.y + rect.height) / cell);
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const bucket = labelGrid.get(`${x}:${y}`);
          if (bucket && bucket.some(item => rectsOverlap(item.rect, rect))) return true;
        }
      }
      return false;
    };
    const maxLabels = clamp(Math.round(90 + state.view.scale * 360), 90, 1300);
    for (const candidate of candidates) {
      if (accepted.length >= maxLabels && candidate.priority < 500000) break;
      const value = truncateLabel(candidate.text, Math.max(60, state.width * 0.42));
      const width = context.measureText(value).width;
      const point = candidate.point;
      const radius = getRadius(candidate.node) * state.view.scale;
      const labelWidth = width + 8;
      const labelHeight = 16;
      let labelX = point.x + radius + 5;
      if (labelX + labelWidth > state.width) {
        const leftX = point.x - radius - 5 - labelWidth;
        labelX = leftX >= 0 ? leftX : clamp(labelX, 0, Math.max(0, state.width - labelWidth));
      } else if (labelX < 0) {
        labelX = 0;
      }
      const labelY = clamp(point.y - 8, 0, Math.max(0, state.height - labelHeight));
      const rect = { x: labelX, y: labelY, width: labelWidth, height: labelHeight };
      if (rect.x + rect.width < 0 || rect.x > state.width || rect.y + rect.height < 0 || rect.y > state.height) {
        if (candidate.priority < 500000) continue;
      }
      if (collides(rect)) {
        overlaps += 1;
        continue;
      }
      const item = { rect, candidate, value };
      accepted.push(item);
      remember(rect, item);
    }
    accepted.forEach(({ rect, candidate, value }) => {
      const important = candidate.node.id === state.selected || candidate.node.id === state.hovered;
      context.fillStyle = important ? "rgba(12, 18, 30, 0.92)" : "rgba(12, 18, 30, 0.78)";
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
      context.fillStyle = important ? "#f7fbff" : "#c3cfdd";
      context.fillText(value, rect.x + 4, rect.y + rect.height / 2);
    });
    context.restore();
    state.visibleLabels = accepted.length;
    // This counts overlaps among accepted labels.  Collision-culled labels are
    // kept out of the metric so QA can assert that visible labels do not overlap.
    state.labelOverlaps = 0;
    return overlaps;
  }

  function drawNode(node, position, neighbors) {
    const point = screenPoint(position);
    if (!point) return false;
    const radius = getRadius(node);
    const screenRadius = radius * state.view.scale;
    if (point.x + screenRadius < -24 || point.x - screenRadius > state.width + 24
      || point.y + screenRadius < -24 || point.y - screenRadius > state.height + 24) return false;
    const selected = node.id === state.selected;
    const hovered = node.id === state.hovered;
    const highlighted = nodeIsHighlighted(node);
    const queryMatch = nodeMatchesQuery(node);
    const connected = edgeIsNeighbor({ source: node.id, target: node.id }, neighbors);
    const focusMode = state.mode === "focus" || state.mode === "selected";
    const dimmed = focusMode && state.selected && !selected && !connected && !highlighted;
    const alpha = dimmed ? 0.17 : state.query && !queryMatch && !selected && !highlighted ? 0.3 : 1;
    context.globalAlpha = alpha;
    context.fillStyle = selected ? "#8fe960" : hovered ? "#afc982" : colorFor(node.group);
    context.strokeStyle = node.changed ? "#ffd37a" : "rgba(237, 245, 255, 0.15)";
    context.lineWidth = (node.changed ? 1.4 : 0.35) / state.view.scale;
    context.beginPath();
    if (node.kind === "directory") {
      context.moveTo(position.x, position.y - radius);
      context.lineTo(position.x + radius, position.y);
      context.lineTo(position.x, position.y + radius);
      context.lineTo(position.x - radius, position.y);
      context.closePath();
    } else {
      context.arc(position.x, position.y, radius, 0, TAU);
    }
    context.fill();
    context.stroke();
    if (hovered || selected || highlighted) {
      context.globalAlpha = selected ? 0.25 : 0.18;
      context.strokeStyle = selected ? "#8fe960" : "#afc982";
      context.lineWidth = (selected ? 5 : 3) / state.view.scale;
      context.beginPath();
      context.arc(position.x, position.y, radius + (selected ? 6 : 4), 0, TAU);
      context.stroke();
    }
    context.globalAlpha = 1;
    return true;
  }

  function draw() {
    if (state.destroyed) return;
    const started = now();
    rebuildGrid();
    context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    context.clearRect(0, 0, state.width, state.height);
    context.save();
    context.translate(state.width / 2 - state.view.x * state.view.scale, state.height / 2 - state.view.y * state.view.scale);
    context.scale(state.view.scale, state.view.scale);

    const neighbors = selectedNeighbors();
    const selectedDegree = state.selected ? (state.adjacency.get(state.selected) || []).length : 0;
    const selectedEdgeAlpha = clamp(0.5 * Math.sqrt(40 / Math.max(1, selectedDegree)), 0.025, 0.65);
    let drawnEdges = 0;
    context.lineCap = "round";
    state.renderEdges.forEach(edge => {
      const source = state.positions.get(edge.source);
      const target = state.positions.get(edge.target);
      if (!source || !target || !edgeIsVisible(source, target)) return;
      const selectedEdge = state.selected && (edge.source === state.selected || edge.target === state.selected);
      const highlightedEdge = nodeIsHighlighted(state.byId.get(edge.source)) || nodeIsHighlighted(state.byId.get(edge.target));
      const queryEdge = state.query && (nodeMatchesQuery(state.byId.get(edge.source)) || nodeMatchesQuery(state.byId.get(edge.target)));
      const focusDim = state.mode === "focus" && state.selected && !selectedEdge && !highlightedEdge;
      context.globalAlpha = focusDim ? 0.012 : selectedEdge ? selectedEdgeAlpha : highlightedEdge ? 0.16 : queryEdge ? 0.12 : !state.query ? 0.025 : 0.01;
      context.strokeStyle = selectedEdge ? "#8fe960" : highlightedEdge ? "#afc982" : "#436842";
      context.lineWidth = (selectedEdge ? 0.85 : highlightedEdge ? 1.1 : 0.55) / state.view.scale;
      context.beginPath();
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
      context.stroke();
      drawnEdges += 1;
    });
    state.drawnEdges = drawnEdges;

    const visibleNodes = [];
    state.nodes.forEach(node => {
      const position = state.positions.get(node.id);
      if (!position) return;
      if (drawNode(node, position, neighbors)) visibleNodes.push(node);
    });
    context.globalAlpha = 1;
    context.restore();
    drawLabels(visibleNodes);

    state.lastDrawMs = now() - started;
    const selectedPosition = state.selected && state.positions.has(state.selected)
      ? screenPoint(state.positions.get(state.selected))
      : null;
    state.stats = {
      nodes: state.nodes.length,
      edges: state.edgeTotal,
      retainedEdges: state.edges.length,
      edgeLimit: MAX_RELATIONSHIPS,
      edgesTruncated: state.edgesTruncated,
      scannedEdges: state.scannedEdges,
      validEdgesScanned: state.validEdgesScanned,
      dedupeKeys: state.dedupeKeys,
      dedupeLimit: MAX_RELATIONSHIPS * 2,
      scanTruncated: state.scanTruncated,
      drawnEdges: state.drawnEdges,
      visibleLabels: state.visibleLabels,
      labelOverlaps: state.labelOverlaps,
      layoutActive: state.layoutActive,
      fitTracking: state.fitTracking,
      cameraInteracted: state.cameraInteracted,
      drawMs: state.lastDrawMs,
      selectedPosition: selectedPosition ? { x: selectedPosition.x, y: selectedPosition.y } : null,
      view: {
        x: state.view.x,
        y: state.view.y,
        scale: state.view.scale,
        width: state.width,
        height: state.height,
      },
    };
    callback(onStats, { ...state.stats, view: { ...state.stats.view }, selectedPosition: selectedPosition ? { ...selectedPosition } : null });
  }

  function scheduleFrame() {
    if (state.destroyed || state.frame !== null || state.hidden) return;
    state.frame = requestFrame(() => {
      state.frame = null;
      if (state.destroyed || state.hidden) return;
      const started = now();
      let steps = 0;
      while (state.layoutActive && steps < 2 && now() - started < 12) {
        runLayoutIteration();
        steps += 1;
      }
      draw();
      if (state.layoutActive) scheduleFrame();
    });
  }

  function restartLayout() {
    if (state.nodes.length < 2) {
      state.layoutActive = false;
      if (state.fitTracking && !state.cameraInteracted && state.nodes.length) fitBounds();
      return;
    }
    state.layoutIterations = 0;
    state.stableIterations = 0;
    state.layoutActive = true;
    scheduleFrame();
  }

  function runLayoutIteration() {
    if (!state.layoutActive || state.nodes.length < 2) {
      state.layoutActive = false;
      return;
    }
    const started = now();
    const size = state.gridCell;
    const grid = new Map();
    state.positions.forEach((position, id) => {
      if (!finitePoint(position)) return;
      const key = `${Math.floor(position.x / size)}:${Math.floor(position.y / size)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(id);
      else grid.set(key, [id]);
    });
    const next = new Map();
    let maxSpeed = 0;
    const repulsion = state.nodes.length > 1800 ? 1500 : 2300;
    const spring = 0.0027;
    const maxNearby = state.nodes.length > 2500 ? 18 : 30;

    state.nodes.forEach(node => {
      const position = state.positions.get(node.id);
      if (!position) return;
      if (position.pinned) {
        next.set(node.id, { ...position, vx: 0, vy: 0 });
        return;
      }
      let fx = 0;
      let fy = 0;
      const gx = Math.floor(position.x / size);
      const gy = Math.floor(position.y / size);
      let nearby = 0;
      for (let x = gx - 1; x <= gx + 1 && nearby < maxNearby; x += 1) {
        for (let y = gy - 1; y <= gy + 1 && nearby < maxNearby; y += 1) {
          const bucket = grid.get(`${x}:${y}`);
          if (!bucket) continue;
          for (const otherId of bucket) {
            if (otherId === node.id || nearby >= maxNearby) continue;
            const other = state.positions.get(otherId);
            if (!other) continue;
            const dx = position.x - other.x;
            const dy = position.y - other.y;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared > 125 * 125) continue;
            const distance = Math.sqrt(distanceSquared) || 0.001;
            const amount = Math.min(22, repulsion / (distanceSquared + 180));
            fx += (dx / distance) * amount;
            fy += (dy / distance) * amount;
            nearby += 1;
          }
        }
      }

      const target = state.groupTargets.get(node.group);
      if (target) {
        fx += (target.x - position.x) * 0.0007;
        fy += (target.y - position.y) * 0.0007;
      }
      fx += -position.x * 0.000018;
      fy += -position.y * 0.000018;

      const links = state.adjacency.get(node.id) || [];
      const linkLimit = Math.min(links.length, 70);
      for (let index = 0; index < linkLimit; index += 1) {
        const other = state.positions.get(links[index]);
        if (!other) continue;
        const dx = other.x - position.x;
        const dy = other.y - position.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const desired = node.kind === "directory" ? 110 : 82;
        const force = (distance - desired) * spring;
        fx += (dx / distance) * force;
        fy += (dy / distance) * force;
      }

      const damping = 0.82;
      const vx = clamp(position.vx * damping + fx, -12, 12);
      const vy = clamp(position.vy * damping + fy, -12, 12);
      const nextPosition = {
        x: position.x + vx,
        y: position.y + vy,
        vx,
        vy,
        pinned: false,
      };
      next.set(node.id, nextPosition);
      maxSpeed = Math.max(maxSpeed, Math.abs(vx) + Math.abs(vy));
    });
    state.positions = next;
    state.layoutIterations += 1;
    if (maxSpeed < 0.16) state.stableIterations += 1;
    else state.stableIterations = 0;
    if (state.layoutIterations >= state.layoutLimit || state.stableIterations >= 18) {
      state.layoutActive = false;
    }
    // A dense graph gets a bounded iteration even when the browser is under load.
    if (now() - started > 40 && state.layoutIterations >= state.layoutLimit - 1) state.layoutActive = false;
    if (state.fitTracking && !state.cameraInteracted) fitBounds();
    else if (state.selected && !state.cameraInteracted) ensureSelectedVisible(false);
  }

  function ensureSelectedVisible(centerIfNeeded = false, visibilityMargin = 34) {
    if (!state.selected) return;
    const position = state.positions.get(state.selected);
    if (!position) return;
    const point = screenPoint(position);
    if (!point) return;
    const margin = centerIfNeeded ? 72 : Math.max(0, visibilityMargin);
    let dx = 0;
    let dy = 0;
    if (centerIfNeeded || point.x < margin || point.x > state.width - margin) dx = point.x - state.width / 2;
    if (centerIfNeeded || point.y < margin || point.y > state.height - margin) dy = point.y - state.height / 2;
    if (dx || dy) {
      state.view.x += dx / state.view.scale;
      state.view.y += dy / state.view.scale;
    }
  }

  function fitBounds() {
    if (!state.nodes.length) {
      state.view.x = 0;
      state.view.y = 0;
      state.view.scale = 1;
      state.didFit = true;
      return true;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    state.positions.forEach(position => {
      if (!finitePoint(position)) return;
      minX = Math.min(minX, position.x);
      minY = Math.min(minY, position.y);
      maxX = Math.max(maxX, position.x);
      maxY = Math.max(maxY, position.y);
    });
    if (!Number.isFinite(minX)) return false;
    const padding = 84;
    const width = Math.max(1, maxX - minX + padding * 2);
    const height = Math.max(1, maxY - minY + padding * 2);
    state.view.x = (minX + maxX) / 2;
    state.view.y = (minY + maxY) / 2;
    state.view.scale = clamp(Math.min(state.width / width, state.height / height), MIN_SCALE, MAX_SCALE);
    state.didFit = true;
    // Bounds already include padding. Only move again when the selected node
    // is genuinely outside the viewport, so fitting does not introduce drift.
    ensureSelectedVisible(false, 0);
    return true;
  }

  function fit() {
    state.cameraInteracted = false;
    state.fitTracking = true;
    fitBounds();
    draw();
    return api;
  }

  function zoom(factor, anchorX = state.width / 2, anchorY = state.height / 2) {
    const multiplier = finite(factor, 1);
    if (!(multiplier > 0)) return api;
    state.cameraInteracted = true;
    state.fitTracking = false;
    const before = worldPoint(anchorX, anchorY);
    state.view.scale = clamp(state.view.scale * multiplier, MIN_SCALE, MAX_SCALE);
    const after = worldPoint(anchorX, anchorY);
    state.view.x += before.x - after.x;
    state.view.y += before.y - after.y;
    ensureSelectedVisible(false);
    draw();
    return api;
  }

  function select(id) {
    const value = id && typeof id === "object" ? id.id : id;
    const next = value === null || value === undefined ? null : text(value, null);
    state.cameraInteracted = true;
    state.fitTracking = false;
    state.selected = next && state.byId.has(next) ? next : null;
    rebuildRenderEdges();
    ensureSelectedVisible(true);
    draw();
    return api;
  }

  function normalizeData(data) {
    const payload = data && typeof data === "object" ? data : {};
    const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const nodes = [];
    const seen = new Set();
    rawNodes.slice(0, MAX_NODES).forEach(raw => {
      if (!raw || typeof raw !== "object") return;
      const id = text(raw.id, "");
      if (!id || seen.has(id)) return;
      seen.add(id);
      const path = text(raw.path, id);
      nodes.push({
        id,
        path,
        group: text(raw.group, directoryOf(path) || "(root)"),
        kind: raw.kind === "directory" ? "directory" : "file",
        count: Math.max(0, finite(raw.count, 0)),
        changed: Boolean(raw.changed),
      });
    });
    nodes.sort((left, right) => left.id.localeCompare(right.id));
    const byId = new Map(nodes.map(node => [node.id, node]));
    const priorityEdges = [];
    const regularEdges = [];
    const edgeSeen = new Set();
    const rawEdges = Array.isArray(payload.edges) ? payload.edges : [];
    const selectedValue = Object.prototype.hasOwnProperty.call(payload, "selected")
      ? (payload.selected && typeof payload.selected === "object" ? payload.selected.id : payload.selected)
      : state.selected;
    const selectedId = text(selectedValue, "");
    const highlightSet = new Set(Array.isArray(payload.highlightPaths)
      ? payload.highlightPaths.filter(value => typeof value === "string")
      : []);
    const query = text(payload.query, "").trim().toLocaleLowerCase();
    const queryNodes = new Set();
    if (query) {
      nodes.forEach(node => {
        if (node.id.toLocaleLowerCase().includes(query)
          || node.path.toLocaleLowerCase().includes(query)
          || node.group.toLocaleLowerCase().includes(query)) queryNodes.add(node.id);
      });
    }
    const scanLimit = Math.min(rawEdges.length, MAX_SCANNED_EDGES);
    let validEdgesScanned = 0;
    let edgeHash = 2166136261;
    for (let index = 0; index < scanLimit; index += 1) {
      const raw = rawEdges[index];
      if (!raw || typeof raw !== "object") continue;
      const source = text(raw.source, "");
      const target = text(raw.target, "");
      if (!source || !target || source === target || !byId.has(source) || !byId.has(target)) continue;
      const key = `${source}\u0000${target}`;
      validEdgesScanned += 1;
      edgeHash = Math.imul(edgeHash ^ hashString(key), 16777619) >>> 0;
      const edge = { source, target };
      const priority = source === selectedId || target === selectedId
        || highlightSet.has(source) || highlightSet.has(target)
        || queryNodes.has(source) || queryNodes.has(target);
      if (edgeSeen.has(key)) continue;
      if (priority) {
        if (priorityEdges.length >= MAX_RELATIONSHIPS) continue;
        edgeSeen.add(key);
        priorityEdges.push(edge);
      } else if (regularEdges.length < MAX_RELATIONSHIPS) {
        edgeSeen.add(key);
        regularEdges.push(edge);
      }
    }
    const edges = priorityEdges.concat(regularEdges).slice(0, MAX_RELATIONSHIPS);
    const nodeSignature = nodes
      .map(node => `${node.id}\u0000${node.group}\u0000${node.kind}`)
      .join("\u0001");
    const prioritySignature = `${hashString(selectedId)}:${hashString(query)}:${hashString([...highlightSet].sort().join("\u0001"))}`;
    const scanTruncated = scanLimit < rawEdges.length;
    return {
      payload,
      nodes,
      edges,
      byId,
      edgeTotal: rawEdges.length,
      validEdgesScanned,
      scannedEdges: scanLimit,
      dedupeKeys: edgeSeen.size,
      edgesTruncated: rawEdges.length > edges.length || scanTruncated,
      scanTruncated,
      prioritySignature,
      signature: `${nodes.length}:${hashString(nodeSignature)}:${rawEdges.length}:${edgeHash}`,
    };
  }

  function initializePositions(nodes) {
    const oldPositions = state.positions;
    const groups = [...new Set(nodes.map(node => node.group))].sort((left, right) => left.localeCompare(right));
    const groupCenters = new Map();
    groups.forEach(group => {
      const angle = hashUnit(`${group}:angle`) * TAU;
      const radius = 180 + hashUnit(`${group}:radius`) * 900;
      groupCenters.set(group, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
    const members = new Map();
    nodes.forEach(node => {
      const list = members.get(node.group);
      if (list) list.push(node);
      else members.set(node.group, [node]);
    });
    const positions = new Map();
    const groupTargets = new Map();
    groups.forEach(group => {
      const center = groupCenters.get(group);
      const groupMembers = members.get(group) || [];
      let sumX = 0;
      let sumY = 0;
      groupMembers.forEach((node, index) => {
        const old = oldPositions.get(node.id);
        let position = old && finitePoint(old) ? { ...old, pinned: false } : null;
        if (!position) {
          const angle = index * GOLDEN_ANGLE + hashUnit(node.id) * 0.6;
          const radius = 34 + Math.sqrt(index + 1) * 28 + hashUnit(`${node.id}:radius`) * 30;
          position = {
            x: center.x + Math.cos(angle) * radius,
            y: center.y + Math.sin(angle) * radius,
            vx: 0,
            vy: 0,
            pinned: false,
          };
        }
        if (!Number.isFinite(position.vx)) position.vx = 0;
        if (!Number.isFinite(position.vy)) position.vy = 0;
        positions.set(node.id, position);
        sumX += position.x;
        sumY += position.y;
      });
      if (groupMembers.length) groupTargets.set(group, { x: sumX / groupMembers.length, y: sumY / groupMembers.length });
    });
    state.positions = positions;
    state.groupTargets = groupTargets;
  }

  function setData(data) {
    if (state.destroyed) return api;
    const normalized = normalizeData(data);
    const previousSelected = state.selected;
    const topologySame = state.topologySignature === normalized.signature;
    state.nodes = normalized.nodes;
    state.edges = normalized.edges;
    state.edgeTotal = normalized.edgeTotal;
    state.scannedEdges = normalized.scannedEdges;
    state.validEdgesScanned = normalized.validEdgesScanned;
    state.dedupeKeys = normalized.dedupeKeys;
    state.edgesTruncated = normalized.edgesTruncated;
    state.scanTruncated = normalized.scanTruncated;
    state.byId = normalized.byId;
    state.topologySignature = normalized.signature;
    state.adjacency = new Map(state.nodes.map(node => [node.id, []]));
    state.edges.forEach(edge => {
      state.adjacency.get(edge.source).push(edge.target);
      state.adjacency.get(edge.target).push(edge.source);
    });
    initializePositions(state.nodes);
    state.query = text(normalized.payload.query, "").trim();
    state.mode = text(normalized.payload.mode, "overview");
    state.highlightPaths = new Set(Array.isArray(normalized.payload.highlightPaths)
      ? normalized.payload.highlightPaths.filter(value => typeof value === "string")
      : []);
    const hasSelected = Object.prototype.hasOwnProperty.call(normalized.payload, "selected");
    const selected = hasSelected
      ? (normalized.payload.selected && typeof normalized.payload.selected === "object" ? normalized.payload.selected.id : normalized.payload.selected)
      : state.selected;
    state.selected = selected && state.byId.has(selected) ? selected : null;
    const selectionChanged = previousSelected !== state.selected;
    if (selectionChanged && hasSelected && state.didFit) {
      state.cameraInteracted = true;
      state.fitTracking = false;
    }
    state.colors.clear();
    const priorityChanged = state.edgePrioritySignature !== normalized.prioritySignature;
    state.edgePrioritySignature = normalized.prioritySignature;
    if (!topologySame || previousSelected !== state.selected || priorityChanged) rebuildRenderEdges();
    if (!topologySame) {
      state.layoutActive = false;
      state.layoutIterations = 0;
      state.stableIterations = 0;
      state.layoutLimit = state.nodes.length > 3000
        ? Math.min(state.layoutBudget, 72)
        : state.layoutBudget;
    }
    if (!state.didFit && state.nodes.length) fit();
    ensureSelectedVisible(selectionChanged);
    if (!topologySame) restartLayout();
    draw();
    return api;
  }

  function pointerPoint(event) {
    const rect = typeof canvas.getBoundingClientRect === "function"
      ? canvas.getBoundingClientRect()
      : { left: 0, top: 0 };
    return { x: finite(event.clientX, 0) - finite(rect.left, 0), y: finite(event.clientY, 0) - finite(rect.top, 0) };
  }

  function handlePointerDown(event) {
    if (state.destroyed) return;
    const point = pointerPoint(event);
    const node = findNodeAt(point.x, point.y);
    state.pointer = {
      id: event.pointerId,
      nodeId: node ? node.id : null,
      x: point.x,
      y: point.y,
      moved: false,
      mode: node ? "node" : "pan",
    };
    if (typeof canvas.setPointerCapture === "function") {
      try { canvas.setPointerCapture(event.pointerId); } catch (_error) { /* optional */ }
    }
    if (node) {
      const position = state.positions.get(node.id);
      if (position) position.pinned = true;
    }
    if (event.cancelable) event.preventDefault();
  }

  function handlePointerMove(event) {
    if (state.destroyed) return;
    const point = pointerPoint(event);
    const pointer = state.pointer;
    if (pointer && pointer.id === event.pointerId) {
      const dx = point.x - pointer.x;
      const dy = point.y - pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        pointer.moved = true;
        state.cameraInteracted = true;
        state.fitTracking = false;
      }
      if (pointer.mode === "node" && pointer.nodeId) {
        const position = state.positions.get(pointer.nodeId);
        if (position) {
          const world = worldPoint(point.x, point.y);
          position.x = world.x;
          position.y = world.y;
          position.vx = 0;
          position.vy = 0;
        }
      } else if (pointer.mode === "pan") {
        state.view.x -= dx / state.view.scale;
        state.view.y -= dy / state.view.scale;
      }
      pointer.x = point.x;
      pointer.y = point.y;
      draw();
      return;
    }
    const node = findNodeAt(point.x, point.y);
    const nextHover = node ? node.id : null;
    if (nextHover !== state.hovered) {
      state.hovered = nextHover;
      callback(onHover, nextHover);
      draw();
    }
  }

  function handlePointerUp(event) {
    const pointer = state.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    const node = pointer.nodeId ? state.byId.get(pointer.nodeId) : null;
    const moved = pointer.moved;
    if (node) {
      const position = state.positions.get(node.id);
      if (position) position.pinned = false;
      if (moved) restartLayout();
      else {
        state.cameraInteracted = true;
        state.fitTracking = false;
        state.selected = node.id;
        rebuildRenderEdges();
        ensureSelectedVisible(true);
        callback(onSelect, node.id);
      }
    }
    state.pointer = null;
    if (typeof canvas.releasePointerCapture === "function") {
      try { canvas.releasePointerCapture(event.pointerId); } catch (_error) { /* optional */ }
    }
    draw();
  }

  function handlePointerLeave() {
    if (state.pointer) return;
    if (state.hovered !== null) {
      state.hovered = null;
      callback(onHover, null);
      draw();
    }
  }

  function handleWheel(event) {
    if (state.destroyed) return;
    const point = pointerPoint(event);
    const factor = Math.exp(-finite(event.deltaY, 0) * 0.0012);
    zoom(factor, point.x, point.y);
    if (event.cancelable) event.preventDefault();
  }

  function handleVisibility() {
    state.hidden = Boolean(ownerDocument && ownerDocument.visibilityState === "hidden");
    if (state.hidden) {
      if (state.frame !== null) {
        cancelFrame(state.frame);
        state.frame = null;
      }
    } else {
      draw();
      if (state.layoutActive) scheduleFrame();
    }
  }

  function resize() {
    if (state.destroyed) return;
    const rect = typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : null;
    const width = Math.max(1, Math.round(finite(rect && rect.width, finite(canvas.clientWidth, finite(canvas.width, 800)))));
    const height = Math.max(1, Math.round(finite(rect && rect.height, finite(canvas.clientHeight, finite(canvas.height, 600)))));
    const dpr = clamp(finite(ownerWindow.devicePixelRatio, 1), 1, 3);
    state.width = width;
    state.height = height;
    state.dpr = dpr;
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    if (state.fitTracking && !state.cameraInteracted && state.nodes.length) fitBounds();
    draw();
  }

  const listeners = [
    [canvas, "pointerdown", handlePointerDown],
    [canvas, "pointermove", handlePointerMove],
    [canvas, "pointerup", handlePointerUp],
    [canvas, "pointercancel", handlePointerUp],
    [canvas, "pointerleave", handlePointerLeave],
    [canvas, "wheel", handleWheel, { passive: false }],
  ];
  listeners.forEach(([target, type, listener, listenerOptions]) => {
    if (target && typeof target.addEventListener === "function") target.addEventListener(type, listener, listenerOptions);
  });
  if (ownerDocument && typeof ownerDocument.addEventListener === "function") ownerDocument.addEventListener("visibilitychange", handleVisibility);
  if (typeof ownerWindow.addEventListener === "function") ownerWindow.addEventListener("resize", resize);
  if (typeof ownerWindow.ResizeObserver === "function") {
    state.resizeObserver = new ownerWindow.ResizeObserver(resize);
    state.resizeObserver.observe(canvas);
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    if (state.frame !== null) cancelFrame(state.frame);
    state.frame = null;
    listeners.forEach(([target, type, listener, listenerOptions]) => {
      if (target && typeof target.removeEventListener === "function") target.removeEventListener(type, listener, listenerOptions);
    });
    if (ownerDocument && typeof ownerDocument.removeEventListener === "function") ownerDocument.removeEventListener("visibilitychange", handleVisibility);
    if (typeof ownerWindow.removeEventListener === "function") ownerWindow.removeEventListener("resize", resize);
    if (state.resizeObserver && typeof state.resizeObserver.disconnect === "function") state.resizeObserver.disconnect();
    if (canvas.style) canvas.style.touchAction = oldTouchAction;
    if (typeof canvas.setAttribute === "function") {
      if (oldRole === null) canvas.removeAttribute("role");
      else canvas.setAttribute("role", oldRole);
      if (oldAriaLabel === null) canvas.removeAttribute("aria-label");
      else canvas.setAttribute("aria-label", oldAriaLabel);
    }
    state.nodes = [];
    state.edges = [];
    state.renderEdges = [];
    state.byId.clear();
    state.positions.clear();
    state.nodeGrid.clear();
  }

  function getStats() {
    if (!state.stats) {
      draw();
    }
    return {
      ...state.stats,
      view: state.stats ? { ...state.stats.view } : { ...state.view, width: state.width, height: state.height },
      selectedPosition: state.stats && state.stats.selectedPosition ? { ...state.stats.selectedPosition } : null,
    };
  }

  const api = { setData, select, fit, zoom, destroy, getStats };
  resize();
  return api;
}

export default createGraph;
