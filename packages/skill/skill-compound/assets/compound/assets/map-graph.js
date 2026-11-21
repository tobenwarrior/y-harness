/*
 * Canvas2D dependency graph with a live force layout.
 *
 * The renderer owns drawing and pointer interaction; the file list, inspector,
 * and keyboard shortcuts stay in the surrounding UI. Animation frames run only
 * while the layout, camera, or a hover transition is still moving.
 */

const MAX_NODES = 5000;
const MAX_DRAWN_EDGES = 20000;
const MAX_RELATIONSHIPS = 120000;
const MAX_SCANNED_EDGES = MAX_RELATIONSHIPS * 2;
const MIN_SCALE = 0.12;
const MAX_SCALE = 5;
const LAYOUT_BUDGET = 180;
const CELL = 120;
const DRAG_REACH = 800;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;
export const FOLDER_PALETTE = Object.freeze([
  "#147a43", "#3e7895", "#8c65ad", "#a87826", "#b85d79", "#2c9296", "#718c37", "#9b6d8c",
]);

const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const text = (value, fallback = "") => (typeof value === "string" ? value : fallback);
const now = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
// Fraction of the remaining distance an exponential ease covers in dt milliseconds.
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);

const smoothstep = (low, high, value) => {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
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
const hashUnit = value => hashString(value) / 4294967296;

/** Return the stable legend color used for a folder group. */
export function groupColor(group) {
  return FOLDER_PALETTE[hashString(text(group, "(root)")) % FOLDER_PALETTE.length];
}

const directoryOf = path => {
  const slash = String(path || "").lastIndexOf("/");
  return slash < 0 ? "" : String(path).slice(0, slash);
};

const basename = path => {
  const source = String(path || "");
  const slash = source.lastIndexOf("/");
  return slash < 0 ? source : source.slice(slash + 1) || source;
};

/** Counting-sort spatial index whose buffers are reused across layout steps. */
function createGrid() {
  const grid = {
    size: CELL, cols: 0, rows: 0, minX: 0, minY: 0,
    start: new Int32Array(2), cursor: new Int32Array(1), items: new Int32Array(0), cellOf: new Int32Array(0),
  };
  grid.fill = (xs, ys, count) => {
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let index = 0; index < count; index += 1) {
      minX = Math.min(minX, xs[index]);
      maxX = Math.max(maxX, xs[index]);
      minY = Math.min(minY, ys[index]);
      maxY = Math.max(maxY, ys[index]);
    }
    if (!count) {
      grid.cols = grid.rows = 0;
      return;
    }
    // Coarser cells bound memory when a dragged node lands far from the rest.
    const size = Math.max(CELL, (maxX - minX) / 400, (maxY - minY) / 400);
    const cols = Math.floor((maxX - minX) / size) + 1;
    const rows = Math.floor((maxY - minY) / size) + 1;
    const cells = cols * rows;
    if (grid.start.length < cells + 1) grid.start = new Int32Array(cells + 1);
    else grid.start.fill(0, 0, cells + 1);
    if (grid.cursor.length < cells) grid.cursor = new Int32Array(cells);
    if (grid.items.length < count) [grid.items, grid.cellOf] = [new Int32Array(count), new Int32Array(count)];
    for (let index = 0; index < count; index += 1) {
      const cell = Math.floor((ys[index] - minY) / size) * cols + Math.floor((xs[index] - minX) / size);
      grid.cellOf[index] = cell;
      grid.start[cell + 1] += 1;
    }
    for (let cell = 0; cell < cells; cell += 1) grid.start[cell + 1] += grid.start[cell];
    grid.cursor.set(grid.start.subarray(0, cells));
    for (let index = 0; index < count; index += 1) grid.items[grid.cursor[grid.cellOf[index]]++] = index;
    Object.assign(grid, { size, cols, rows, minX, minY });
  };
  return grid;
}

function normalizeData(data, currentSelected) {
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
  const ids = new Set(nodes.map(node => node.id));
  const hasSelected = Object.prototype.hasOwnProperty.call(payload, "selected");
  const selectedValue = hasSelected
    ? (payload.selected && typeof payload.selected === "object" ? payload.selected.id : payload.selected)
    : currentSelected;
  const selectedId = text(selectedValue, "");
  const highlightPaths = new Set(Array.isArray(payload.highlightPaths)
    ? payload.highlightPaths.filter(value => typeof value === "string")
    : []);
  const query = text(payload.query, "").trim();
  const lowered = query.toLocaleLowerCase();
  const queryNodes = new Set(lowered ? nodes.filter(node => node.id.toLocaleLowerCase().includes(lowered)
    || node.path.toLocaleLowerCase().includes(lowered)
    || node.group.toLocaleLowerCase().includes(lowered)).map(node => node.id) : []);
  // Edges touching the selection, highlights, or query survive the relationship limit first.
  const priorityEdges = [];
  const regularEdges = [];
  const edgeSeen = new Set();
  const rawEdges = Array.isArray(payload.edges) ? payload.edges : [];
  const scanLimit = Math.min(rawEdges.length, MAX_SCANNED_EDGES);
  let validEdgesScanned = 0;
  let edgeHash = 2166136261;
  for (let index = 0; index < scanLimit; index += 1) {
    const raw = rawEdges[index];
    if (!raw || typeof raw !== "object") continue;
    const source = text(raw.source, "");
    const target = text(raw.target, "");
    if (!source || !target || source === target || !ids.has(source) || !ids.has(target)) continue;
    const key = `${source}\u0000${target}`;
    validEdgesScanned += 1;
    edgeHash = Math.imul(edgeHash ^ hashString(key), 16777619) >>> 0;
    if (edgeSeen.has(key)) continue;
    const priority = source === selectedId || target === selectedId
      || highlightPaths.has(source) || highlightPaths.has(target)
      || queryNodes.has(source) || queryNodes.has(target);
    const list = priority ? priorityEdges : regularEdges;
    if (list.length >= MAX_RELATIONSHIPS) continue;
    edgeSeen.add(key);
    list.push({ source, target });
  }
  const edges = priorityEdges.concat(regularEdges).slice(0, MAX_RELATIONSHIPS);
  const nodeSignature = nodes.map(node => `${node.id}\u0000${node.group}\u0000${node.kind}`).join("\u0001");
  const scanTruncated = scanLimit < rawEdges.length;
  return {
    nodes, edges, hasSelected, selectedId, highlightPaths, query, queryNodes,
    edgeTotal: rawEdges.length,
    validEdgesScanned,
    scannedEdges: scanLimit,
    dedupeKeys: edgeSeen.size,
    edgesTruncated: rawEdges.length > edges.length || scanTruncated,
    scanTruncated,
    signature: `${nodes.length}:${hashString(nodeSignature)}:${rawEdges.length}:${edgeHash}`,
  };
}

/**
 * Create a dependency graph renderer backed by one canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{onSelect?: Function, onHover?: Function, onStats?: Function}} options
 * @returns {{setData: Function, select: Function, fit: Function, zoom: Function, destroy: Function, getStats: Function}}
 */
export function createGraph(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== "function") {
    throw new TypeError("createGraph(canvas) requires a canvas element");
  }
  let context = null;
  try {
    context = canvas.getContext("2d", { alpha: true, desynchronized: true });
  } catch (_error) {
    context = canvas.getContext("2d");
  }
  if (!context) throw new Error("createGraph could not acquire a Canvas2D context");

  const opts = options && typeof options === "object" ? options : {};
  const [onSelect, onHover, onStats] = [opts.onSelect, opts.onHover, opts.onStats].map(fn => (typeof fn === "function" ? fn : null));
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
  const reducedMotion = typeof ownerWindow.matchMedia === "function" ? ownerWindow.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const animate = () => !(reducedMotion && reducedMotion.matches);

  const state = {
    destroyed: false, hidden: Boolean(ownerDocument && ownerDocument.visibilityState === "hidden"),
    width: 1, height: 1, dpr: 1, view: { x: 0, y: 0, scale: 1 }, goal: null, inertia: null,
    didFit: false, fitTracking: false, cameraInteracted: false, frame: null, lastFrame: 0,
    // Graph data; setData() replaces these typed arrays.
    nodes: [], index: new Map(), n: 0, memory: new Map(), topologySignature: "", query: "",
    selected: -1, hovered: -1, focus: -1, focusT: 0, appear: 1, ripple: null, pointers: new Map(), gesture: null,
    // Layout.
    layoutActive: false, layoutIterations: 0, layoutLimit: LAYOUT_BUDGET, stableIterations: 0, heat: 1, reach: null,
    layoutGrid: createGrid(), hitGrid: createGrid(), hitDirty: true,
    // Drawing.
    theme: null, probe: null, cache: null, sceneVersion: 0, sceneKey: "", lastKey: "", labelFont: "",
    bounds: { left: 0, right: 0, top: 0, bottom: 0 }, edgeLists: [0, 1, 2].map(() => new Int32Array(0)),
    drawnEdges: 0, visibleLabels: 0, lastDrawMs: 0, statsSignature: "",
    resizeObserver: null, themeObserver: null,
  };

  const oldTouchAction = canvas.style ? canvas.style.touchAction : "";
  const oldRole = typeof canvas.getAttribute === "function" ? canvas.getAttribute("role") : null;
  const oldAriaLabel = typeof canvas.getAttribute === "function" ? canvas.getAttribute("aria-label") : null;
  if (typeof canvas.setAttribute === "function") {
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Dependency graph");
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
  const setCursor = value => {
    if (canvas.style) canvas.style.cursor = value;
  };

  /** Resolve the page's theme tokens so the canvas matches light and dark surfaces. */
  function readTheme() {
    const fallback = { text: "#14161c", dim: "#6b6f78", accent: "#147a43", halo: "#fdf8ee", font: "sans-serif", changed: "#d99a2b" };
    const stage = canvas.parentElement;
    if (typeof ownerWindow.getComputedStyle !== "function" || !ownerDocument || !stage) return fallback;
    if (!state.probe) {
      state.probe = ownerDocument.createElement("i");
      state.probe.hidden = true;
      stage.appendChild(state.probe);
    }
    const resolve = (variable, value) => {
      state.probe.style.color = `var(${variable}, ${value})`;
      return ownerWindow.getComputedStyle(state.probe).color || value;
    };
    const canvasStyle = ownerWindow.getComputedStyle(canvas);
    const dark = canvasStyle.colorScheme === "dark";
    const background = ownerWindow.getComputedStyle(stage).backgroundColor;
    const opaque = background && background !== "transparent" && !/rgba\(.*,\s*0\)$/.test(background);
    return {
      text: resolve("--text", fallback.text),
      dim: resolve("--dim", fallback.dim),
      accent: resolve("--accent", fallback.accent),
      halo: opaque ? background : fallback.halo,
      font: canvasStyle.fontFamily || fallback.font,
      changed: dark ? "#f0c060" : fallback.changed,
    };
  }

  function refreshTheme() {
    state.theme = readTheme();
    state.sceneVersion += 1;
    invalidate();
  }

  // Camera ------------------------------------------------------------------

  const screenX = worldX => (worldX - state.view.x) * state.view.scale + state.width / 2;
  const screenY = worldY => (worldY - state.view.y) * state.view.scale + state.height / 2;
  const worldPoint = (x, y) => ({
    x: state.view.x + (x - state.width / 2) / state.view.scale,
    y: state.view.y + (y - state.height / 2) / state.view.scale,
  });

  /** Move the camera now, or ease toward the goal; an anchor keeps one world point under the pointer. */
  function setCamera(goal, instant = !animate()) {
    const scale = clamp(goal.scale, MIN_SCALE, MAX_SCALE);
    if (!instant) {
      state.goal = { ...goal, scale };
    } else {
      state.view.scale = scale;
      state.view.x = goal.anchor ? goal.anchor.wx - (goal.anchor.sx - state.width / 2) / scale : goal.x;
      state.view.y = goal.anchor ? goal.anchor.wy - (goal.anchor.sy - state.height / 2) / scale : goal.y;
      state.goal = null;
    }
    invalidate();
  }

  function fitTarget() {
    if (!state.n) return { x: 0, y: 0, scale: 1 };
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let index = 0; index < state.n; index += 1) {
      minX = Math.min(minX, state.x[index]);
      maxX = Math.max(maxX, state.x[index]);
      minY = Math.min(minY, state.y[index]);
      maxY = Math.max(maxY, state.y[index]);
    }
    const padding = 84;
    const scale = Math.min(
      state.width / Math.max(1, maxX - minX + padding * 2),
      state.height / Math.max(1, maxY - minY + padding * 2),
    );
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
  }

  /** Return where the camera is heading, so new moves build on an unfinished ease. */
  function targetView() {
    const goal = state.goal;
    if (!goal) return state.view;
    if (!goal.anchor) return goal;
    return {
      scale: goal.scale,
      x: goal.anchor.wx - (goal.anchor.sx - state.width / 2) / goal.scale,
      y: goal.anchor.wy - (goal.anchor.sy - state.height / 2) / goal.scale,
    };
  }

  /** Return a camera goal that keeps the selected node inside the viewport, or null. */
  function revealSelected(center, margin = 34) {
    if (state.selected < 0) return null;
    const view = targetView();
    const px = (state.x[state.selected] - view.x) * view.scale + state.width / 2;
    const py = (state.y[state.selected] - view.y) * view.scale + state.height / 2;
    const edge = center ? 72 : margin;
    const dx = center || px < edge || px > state.width - edge ? px - state.width / 2 : 0;
    const dy = center || py < edge || py > state.height - edge ? py - state.height / 2 : 0;
    return dx || dy ? { x: view.x + dx / view.scale, y: view.y + dy / view.scale, scale: view.scale } : null;
  }

  function stepCamera(dt) {
    let moving = false;
    const { goal, inertia, view } = state;
    if (goal) {
      const k = ease(dt, 90);
      view.scale = Math.exp(Math.log(view.scale) + (Math.log(goal.scale) - Math.log(view.scale)) * k);
      if (goal.anchor) {
        view.x = goal.anchor.wx - (goal.anchor.sx - state.width / 2) / view.scale;
        view.y = goal.anchor.wy - (goal.anchor.sy - state.height / 2) / view.scale;
      } else {
        view.x += (goal.x - view.x) * k;
        view.y += (goal.y - view.y) * k;
      }
      const settled = Math.abs(Math.log(goal.scale / view.scale)) < 0.001
        && (goal.anchor || Math.hypot(goal.x - view.x, goal.y - view.y) * view.scale < 0.25);
      if (settled) setCamera(goal, true);
      else moving = true;
    }
    if (inertia) {
      view.x -= (inertia.vx * dt) / view.scale;
      view.y -= (inertia.vy * dt) / view.scale;
      const decay = Math.exp(-dt / 260);
      inertia.vx *= decay;
      inertia.vy *= decay;
      if (Math.hypot(inertia.vx, inertia.vy) < 0.01) state.inertia = null;
      else moving = true;
    }
    return moving;
  }

  // Interaction state -------------------------------------------------------

  function markNeighbors(flags, node, value) {
    if (node < 0) return;
    for (let k = state.adjStart[node]; k < state.adjStart[node + 1]; k += 1) flags[state.adj[k]] = value;
  }

  function setFocus(node) {
    if (node === state.focus) return;
    markNeighbors(state.focusNeighbor, state.focus, 0);
    state.focus = node;
    markNeighbors(state.focusNeighbor, node, 1);
  }

  function setSelected(node) {
    if (node === state.selected) return;
    markNeighbors(state.selectedNeighbor, state.selected, 0);
    state.selected = node;
    markNeighbors(state.selectedNeighbor, node, 1);
    orderEdges();
    state.sceneVersion += 1;
  }

  function setHovered(node) {
    if (node === state.hovered) return;
    state.hovered = node;
    if (node >= 0) setFocus(node);
    setCursor(node >= 0 ? "pointer" : "");
    callback(onHover, node >= 0 ? state.nodes[node].id : null);
    invalidate();
  }

  function stepTransitions(dt) {
    const target = state.hovered >= 0 ? 1 : 0;
    state.focusT += (target - state.focusT) * (animate() ? ease(dt, 55) : 1);
    if (Math.abs(target - state.focusT) < 0.01) state.focusT = target;
    if (!state.focusT) setFocus(-1);
    state.appear += (1 - state.appear) * (animate() ? ease(dt, 140) : 1);
    if (state.appear > 0.995) state.appear = 1;
    if (state.ripple) state.ripple.t += dt / 650;
    if (state.ripple && state.ripple.t >= 1) state.ripple = null;
    return state.focusT !== target || state.appear < 1 || Boolean(state.ripple);
  }

  /** Order edges so the draw limit keeps those touching the selection, highlights, and query. */
  function orderEdges() {
    const count = state.edgeSource.length;
    const limit = Math.min(count, MAX_DRAWN_EDGES);
    state.renderOrder = new Int32Array(limit);
    if (count <= limit) {
      for (let edge = 0; edge < count; edge += 1) state.renderOrder[edge] = edge;
      return;
    }
    const rank = edge => {
      const [a, b] = [state.edgeSource[edge], state.edgeTarget[edge]];
      if (a === state.selected || b === state.selected) return 0;
      if (state.highlighted[a] || state.highlighted[b]) return 1;
      return state.queryMatch[a] || state.queryMatch[b] ? 2 : 3;
    };
    let written = 0;
    for (let level = 0; level < 4 && written < limit; level += 1) {
      for (let edge = 0; edge < count && written < limit; edge += 1) {
        if (rank(edge) === level) state.renderOrder[written++] = edge;
      }
    }
  }

  // Layout ------------------------------------------------------------------

  function rememberPositions() {
    if (state.memory.size > 4 * MAX_NODES) state.memory.clear();
    for (let index = 0; index < state.n; index += 1) state.memory.set(state.nodes[index].id, [state.x[index], state.y[index]]);
  }

  function startLayout(reach = null, limit = state.n > 3000 ? 72 : LAYOUT_BUDGET) {
    state.layoutActive = state.n >= 2;
    Object.assign(state, { reach, layoutIterations: 0, layoutLimit: limit, stableIterations: 0, heat: 1 });
    invalidate();
  }

  function stopLayout() {
    state.layoutActive = false;
    state.reach = null;
    rememberPositions();
  }

  /** Collect nodes within two links of a dragged node so the pull stays local. */
  function reachFrom(node) {
    const seen = new Uint8Array(state.n);
    const reach = [node];
    seen[node] = 1;
    for (let cursor = 0, depth = 0; depth < 2; depth += 1) {
      for (const levelEnd = reach.length; cursor < levelEnd; cursor += 1) {
        for (let k = state.adjStart[reach[cursor]]; k < state.adjStart[reach[cursor] + 1] && reach.length < DRAG_REACH; k += 1) {
          if (!seen[state.adj[k]]) {
            seen[state.adj[k]] = 1;
            reach.push(state.adj[k]);
          }
        }
      }
    }
    return Int32Array.from(reach);
  }

  function layoutStep() {
    const { n, x, y, vx, vy, fixed, reach, layoutGrid: grid } = state;
    grid.fill(x, y, n);
    const count = reach ? reach.length : n;
    const repulsion = n > 1800 ? 1500 : 2300;
    const maxNearby = n > 2500 ? 18 : 30;
    // Links to a dragged node pull harder so its neighbors visibly follow it.
    const held = state.gesture && state.gesture.dragging ? state.gesture.node : -1;
    for (let k = 0; k < count; k += 1) {
      const i = reach ? reach[k] : k;
      if (fixed[i]) {
        vx[i] = vy[i] = 0;
        continue;
      }
      const [xi, yi] = [x[i], y[i]];
      let [fx, fy, nearby] = [0, 0, 0];
      const cx = Math.floor((xi - grid.minX) / grid.size);
      const cy = Math.floor((yi - grid.minY) / grid.size);
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(grid.cols - 1, cx + 1) && nearby < maxNearby; gx += 1) {
        for (let gy = Math.max(0, cy - 1); gy <= Math.min(grid.rows - 1, cy + 1) && nearby < maxNearby; gy += 1) {
          const cell = gy * grid.cols + gx;
          for (let slot = grid.start[cell]; slot < grid.start[cell + 1] && nearby < maxNearby; slot += 1) {
            const j = grid.items[slot];
            const dx = xi - x[j];
            const dy = yi - y[j];
            const distanceSquared = dx * dx + dy * dy;
            if (j === i || distanceSquared > 125 * 125) continue;
            const distance = Math.sqrt(distanceSquared) || 0.001;
            const amount = Math.min(22, repulsion / (distanceSquared + 180));
            fx += (dx / distance) * amount;
            fy += (dy / distance) * amount;
            nearby += 1;
          }
        }
      }
      const group = state.groupOf[i];
      fx += (state.groupX[group] - xi) * 0.0007 - xi * 0.000018;
      fy += (state.groupY[group] - yi) * 0.0007 - yi * 0.000018;
      const desired = state.nodes[i].kind === "directory" ? 110 : 82;
      for (let slot = state.adjStart[i]; slot < Math.min(state.adjStart[i + 1], state.adjStart[i] + 70); slot += 1) {
        const j = state.adj[slot];
        const dx = x[j] - xi;
        const dy = y[j] - yi;
        const distance = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const force = (distance - desired) * (j === held ? 0.012 : 0.0027);
        fx += (dx / distance) * force;
        fy += (dy / distance) * force;
      }
      vx[i] = clamp(vx[i] * 0.82 + fx, -12, 12);
      vy[i] = clamp(vy[i] * 0.82 + fy, -12, 12);
    }
    let maxSpeed = 0;
    for (let k = 0; k < count; k += 1) {
      const i = reach ? reach[k] : k;
      x[i] += vx[i] * state.heat;
      y[i] += vy[i] * state.heat;
      maxSpeed = Math.max(maxSpeed, (Math.abs(vx[i]) + Math.abs(vy[i])) * state.heat);
    }
    state.hitDirty = true;
    state.sceneVersion += 1;
    state.layoutIterations += 1;
    if (held >= 0) return;
    // Past the budget, ease displacement to zero so nodes glide to rest.
    if (state.layoutIterations >= state.layoutLimit) state.heat *= 0.88;
    state.stableIterations = maxSpeed < 0.16 ? state.stableIterations + 1 : 0;
    if (state.heat < 0.03 || state.stableIterations >= 18) stopLayout();
  }

  // Drawing -----------------------------------------------------------------
  //
  // Chrome's canvas fast-paths individual short lines and circles, so elements
  // are drawn one by one, grouped by style. Hover focus composites a cached
  // bitmap of a still scene and redraws only the focused neighborhood on top.

  function labelWidth(ctx, index) {
    if (state.labelFont !== ctx.font) {
      state.labelFont = ctx.font;
      state.labelWidth.fill(NaN);
    }
    if (Number.isNaN(state.labelWidth[index])) state.labelWidth[index] = ctx.measureText(state.labels[index]).width;
    return state.labelWidth[index];
  }

  function truncateLabel(ctx, value, maxWidth) {
    if (ctx.measureText(value).width <= maxWidth) return value;
    let [low, high] = [0, value.length];
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (ctx.measureText(`${value.slice(0, middle)}…`).width <= maxWidth) low = middle;
      else high = middle - 1;
    }
    return low > 0 ? `${value.slice(0, low)}…` : "…";
  }

  function nodeRadius(index, focusT = 0) {
    const radius = Math.max(state.radius[index], 1.6 / state.view.scale);
    return index === state.focus ? radius * (1 + 0.35 * focusT) : radius;
  }

  function inView(index, radius) {
    const { left, right, top, bottom } = state.bounds;
    return state.x[index] + radius >= left && state.x[index] - radius <= right
      && state.y[index] + radius >= top && state.y[index] - radius <= bottom;
  }

  function fillNode(ctx, index, radius) {
    const [x, y] = [state.x[index], state.y[index]];
    ctx.beginPath();
    if (state.nodes[index].kind === "directory") {
      ctx.moveTo(x, y - radius);
      ctx.lineTo(x + radius, y);
      ctx.lineTo(x, y + radius);
      ctx.lineTo(x - radius, y);
      ctx.closePath();
    } else {
      ctx.arc(x, y, radius, 0, TAU);
    }
    ctx.fill();
  }

  function line(ctx, a, b) {
    ctx.beginPath();
    ctx.moveTo(state.x[a], state.y[a]);
    ctx.lineTo(state.x[b], state.y[b]);
    ctx.stroke();
  }

  function pen(ctx, color, alpha, widthPx) {
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx / state.view.scale;
  }

  function ring(ctx, index, color, alpha, gapPx, widthPx, focusT = 0) {
    if (index < 0 || alpha <= 0.01) return;
    pen(ctx, color, alpha, widthPx);
    ctx.beginPath();
    ctx.arc(state.x[index], state.y[index], nodeRadius(index, focusT) + gapPx / state.view.scale, 0, TAU);
    ctx.stroke();
  }

  function worldTransform(ctx) {
    const { dpr, view } = state;
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale,
      dpr * (state.width / 2 - view.x * view.scale), dpr * (state.height / 2 - view.y * view.scale));
  }

  /** Place labels below their nodes in priority order, skipping any that would collide. */
  function paintLabels(ctx, theme, candidates, alphaOf, strongOf, focusT = 0) {
    const { width, height } = state;
    const cell = 64;
    const placed = new Map();
    const visit = (rect, fn) => {
      for (let cx = Math.floor(rect.x0 / cell); cx <= Math.floor(rect.x1 / cell); cx += 1) {
        for (let cy = Math.floor(rect.y0 / cell); cy <= Math.floor(rect.y1 / cell); cy += 1) {
          if (fn(cx * 65536 + cy)) return true;
        }
      }
      return false;
    };
    const maxLabels = clamp(Math.round((width * height) / 2600), 40, 420);
    const accepted = [];
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.font = `11px ${theme.font}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    for (const i of candidates) {
      const strong = strongOf(i);
      if (accepted.length >= maxLabels && !strong) break;
      // Bold labels are measured with the regular face, so widen them slightly.
      const widen = strong ? 1.07 : 1;
      let value = state.labels[i];
      let wide = labelWidth(ctx, i) * widen;
      const maxWidth = Math.max(60, width * 0.42);
      if (wide > maxWidth) {
        value = truncateLabel(ctx, value, maxWidth / widen);
        wide = ctx.measureText(value).width * widen;
      }
      const x0 = clamp(screenX(state.x[i]) - wide / 2 - 2, 0, Math.max(0, width - wide - 4));
      const y0 = clamp(screenY(state.y[i]) + nodeRadius(i, focusT) * state.view.scale + 2, 0, Math.max(0, height - 15));
      const rect = { x0, y0, x1: x0 + wide + 4, y1: y0 + 15 };
      const overlaps = visit(rect, key => (placed.get(key) || []).some(other => (
        rect.x0 < other.x1 && rect.x1 > other.x0 && rect.y0 < other.y1 && rect.y1 > other.y0
      )));
      if (overlaps) continue;
      visit(rect, key => {
        placed.set(key, [...(placed.get(key) || []), rect]);
        return false;
      });
      accepted.push({ i, value, x: x0 + 2, y: y0 + 1, strong });
    }
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = theme.halo;
    for (const strong of [false, true]) {
      ctx.font = `${strong ? "600 " : ""}11px ${theme.font}`;
      ctx.fillStyle = strong ? theme.text : theme.dim;
      accepted.filter(label => label.strong === strong).forEach(label => {
        ctx.globalAlpha = alphaOf(label.i);
        ctx.strokeText(label.value, label.x, label.y);
        ctx.fillText(label.value, label.x, label.y);
      });
    }
    ctx.globalAlpha = 1;
    return accepted.length;
  }

  /** Paint edges, nodes, rings, and labels; fade dims everything for hover focus. */
  function paintScene(ctx, theme, fade = 1) {
    const { n, selected, renderOrder: order } = state;
    const scale = state.view.scale;
    const appear = state.appear * fade;
    const { left, right, top, bottom } = state.bounds;
    if (state.edgeLists[0].length < order.length) state.edgeLists = [0, 1, 2].map(() => new Int32Array(order.length));
    const counts = [0, 0, 0];
    for (let slot = 0; slot < order.length; slot += 1) {
      const edge = order[slot];
      const [a, b] = [state.edgeSource[edge], state.edgeTarget[edge]];
      const [ax, ay, bx, by] = [state.x[a], state.y[a], state.x[b], state.y[b]];
      if ((ax < left && bx < left) || (ax > right && bx > right) || (ay < top && by < top) || (ay > bottom && by > bottom)) continue;
      const kind = a === selected || b === selected ? 2 : state.highlighted[a] || state.highlighted[b] ? 1 : 0;
      state.edgeLists[kind][counts[kind]++] = edge;
    }
    state.drawnEdges = counts[0] + counts[1] + counts[2];
    worldTransform(ctx);
    const selectedDegree = selected >= 0 ? state.adjStart[selected + 1] - state.adjStart[selected] : 0;
    // One-device-pixel base edges take the canvas hairline fast path.
    [
      [theme.dim, state.edgeAlpha * (state.query ? 0.45 : 1), 1 / state.dpr],
      [theme.text, 0.32, 1.1],
      [theme.accent, clamp(0.55 * Math.sqrt(40 / Math.max(1, selectedDegree)), 0.12, 0.7), 1],
    ].forEach(([color, alpha, widthPx], kind) => {
      if (!counts[kind]) return;
      pen(ctx, color, alpha * appear, widthPx);
      const list = state.edgeLists[kind];
      for (let k = 0; k < counts[kind]; k += 1) line(ctx, state.edgeSource[list[k]], state.edgeTarget[list[k]]);
    });

    const faded = i => Boolean(state.query && !state.queryMatch[i] && !state.highlighted[i] && i !== selected);
    state.byColor.forEach((members, colorIndex) => {
      ctx.fillStyle = state.colors[colorIndex];
      for (const dim of [false, true]) {
        ctx.globalAlpha = (dim ? 0.28 : 1) * appear;
        for (const i of members) {
          const radius = nodeRadius(i);
          if (faded(i) === dim && inView(i, radius)) fillNode(ctx, i, radius);
        }
      }
    });
    state.changedNodes.forEach(i => ring(ctx, i, theme.changed, 0.95 * appear, 2, 1.4));
    ring(ctx, selected, theme.accent, 0.22 * appear, 5, 5);
    ring(ctx, selected, theme.accent, 0.95 * appear, 2.5, 1.6);

    // Labels fade in with zoom; larger hubs earn theirs sooner.
    const baseFade = n <= 120 ? smoothstep(0.2, 0.4, scale) : 0;
    const keys = new Float64Array(n);
    const alphas = new Float32Array(n);
    const candidates = [];
    for (let i = 0; i < n; i += 1) {
      const [px, py] = [screenX(state.x[i]), screenY(state.y[i])];
      if (px < -40 || px > state.width + 40 || py < -20 || py > state.height + 20) continue;
      const zoomFade = Math.max(baseFade, smoothstep(0.5, 0.9, scale * Math.sqrt(state.radius[i] / 4.2)));
      const priority = i === selected ? 7 : state.highlighted[i] ? 5 : state.queryMatch[i] ? 4 : state.selectedNeighbor[i] ? 2 : 1;
      const alpha = (priority > 2 ? 1 : priority === 2 ? Math.max(zoomFade, 0.85) : zoomFade) * appear;
      if (alpha < 0.04) continue;
      keys[i] = priority * 1e6 + state.radius[i] * 1e3;
      alphas[i] = alpha;
      candidates.push(i);
    }
    candidates.sort((left, right) => keys[right] - keys[left] || left - right);
    state.visibleLabels = paintLabels(ctx, theme, candidates, i => alphas[i], i => keys[i] >= 4e6);
  }

  /** Paint the hovered node, its links, and its neighbors above the dimmed scene. */
  function paintFocus(ctx, theme, focusT) {
    const { focus, selected } = state;
    const neighbors = Array.from(state.adj.subarray(state.adjStart[focus], state.adjStart[focus + 1]));
    worldTransform(ctx);
    pen(ctx, theme.accent, state.edgeAlpha + (0.8 - state.edgeAlpha) * focusT, 1.3);
    neighbors.forEach(j => line(ctx, focus, j));
    [...neighbors, focus].forEach(i => {
      const radius = nodeRadius(i, focusT);
      if (!inView(i, radius)) return;
      ctx.globalAlpha = 1;
      ctx.fillStyle = state.colors[state.colorOf[i]];
      fillNode(ctx, i, radius);
      if (state.nodes[i].changed) ring(ctx, i, theme.changed, 0.95, 2, 1.4, focusT);
    });
    if (selected >= 0 && (selected === focus || state.focusNeighbor[selected])) {
      ring(ctx, selected, theme.accent, 0.22, 5, 5, focusT);
      ring(ctx, selected, theme.accent, 0.95, 2.5, 1.6, focusT);
    }
    if (focus !== selected) ring(ctx, focus, theme.text, 0.75 * focusT, 2.5, 1.3, focusT);
    neighbors.sort((left, right) => state.radius[right] - state.radius[left] || left - right);
    paintLabels(ctx, theme, [focus, ...neighbors], i => (i === focus ? 1 : focusT), i => i === focus || i === selected, focusT);
  }

  function draw(emitStats = false) {
    if (state.destroyed) return;
    const started = now();
    if (!state.theme) state.theme = readTheme();
    const { theme, view, n, selected } = state;
    const margin = 24 / view.scale;
    state.bounds = {
      left: view.x - state.width / 2 / view.scale - margin,
      right: view.x + state.width / 2 / view.scale + margin,
      top: view.y - state.height / 2 / view.scale - margin,
      bottom: view.y + state.height / 2 / view.scale + margin,
    };
    const focusT = state.focus >= 0 ? smoothstep(0, 1, state.focusT) : 0;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const key = `${state.sceneVersion}|${view.x}|${view.y}|${view.scale}|${canvas.width}|${canvas.height}|${state.appear}`;
    const steady = key === state.lastKey;
    state.lastKey = key;
    // Reuse a bitmap only for a still scene; a moving one would re-render and flush it every frame.
    if (focusT > 0 && steady && ownerDocument) {
      if (!state.cache) state.cache = ownerDocument.createElement("canvas");
      if (state.sceneKey !== key) {
        [state.cache.width, state.cache.height] = [canvas.width, canvas.height];
        paintScene(state.cache.getContext("2d"), theme);
        state.sceneKey = key;
      }
      context.globalAlpha = 1 - 0.8 * focusT;
      context.drawImage(state.cache, 0, 0);
      paintFocus(context, theme, focusT);
    } else {
      paintScene(context, theme, 1 - 0.8 * focusT);
      if (focusT > 0) paintFocus(context, theme, focusT);
    }
    if (state.ripple && state.ripple.node === selected) {
      const t = state.ripple.t;
      worldTransform(context);
      ring(context, selected, theme.accent, 0.45 * (1 - t) * (1 - t), 4 + 26 * t, 1.5);
    }
    context.globalAlpha = 1;

    state.lastDrawMs = now() - started;
    const signature = `${state.layoutActive}|${n}|${state.edgeTotal}|${state.drawnEdges}|${selected}`;
    if (emitStats || signature !== state.statsSignature) {
      state.statsSignature = signature;
      callback(onStats, getStats());
    }
  }

  /** Report live camera and layout state with the counts from the latest frame. */
  function getStats() {
    const { view, selected } = state;
    return {
      nodes: state.n,
      edges: state.edgeTotal,
      retainedEdges: state.retainedEdges,
      edgeLimit: MAX_RELATIONSHIPS,
      edgesTruncated: state.edgesTruncated,
      scannedEdges: state.scannedEdges,
      validEdgesScanned: state.validEdgesScanned,
      dedupeKeys: state.dedupeKeys,
      dedupeLimit: MAX_RELATIONSHIPS * 2,
      scanTruncated: state.scanTruncated,
      drawnEdges: state.drawnEdges,
      visibleLabels: state.visibleLabels,
      // Labels are collision-culled before drawing, so accepted labels never overlap.
      labelOverlaps: 0,
      layoutActive: state.layoutActive,
      fitTracking: state.fitTracking,
      cameraInteracted: state.cameraInteracted,
      drawMs: state.lastDrawMs,
      selectedPosition: selected >= 0 ? { x: screenX(state.x[selected]), y: screenY(state.y[selected]) } : null,
      view: { x: view.x, y: view.y, scale: view.scale, width: state.width, height: state.height },
    };
  }

  // Frame loop --------------------------------------------------------------

  function invalidate() {
    if (!state.destroyed && state.frame === null && !state.hidden) state.frame = requestFrame(frame);
  }

  function frame(time) {
    state.frame = null;
    if (state.destroyed || state.hidden) return;
    const stamp = finite(time, now());
    const dt = state.lastFrame ? clamp(stamp - state.lastFrame, 1, 64) : 16;
    state.lastFrame = stamp;
    const started = now();
    for (let steps = 0; state.layoutActive && steps < 2 && now() - started < 10; steps += 1) layoutStep();
    if (state.layoutActive && !state.cameraInteracted) {
      const goal = state.fitTracking ? fitTarget() : revealSelected(false);
      if (goal) setCamera(goal, !state.didFit || !animate());
    }
    const cameraMoving = stepCamera(dt);
    const transitioning = stepTransitions(dt);
    draw();
    if (cameraMoving || transitioning || state.layoutActive) invalidate();
    else state.lastFrame = 0;
  }

  // Public API --------------------------------------------------------------

  function fit() {
    Object.assign(state, { cameraInteracted: false, fitTracking: true, inertia: null });
    setCamera(fitTarget(), !state.didFit || !animate());
    state.didFit = true;
    draw(true);
    return api;
  }

  function zoom(factor, anchorX = state.width / 2, anchorY = state.height / 2) {
    const multiplier = finite(factor, 1);
    if (!(multiplier > 0)) return api;
    Object.assign(state, { cameraInteracted: true, fitTracking: false, inertia: null });
    const world = worldPoint(anchorX, anchorY);
    setCamera({ scale: targetView().scale * multiplier, anchor: { sx: anchorX, sy: anchorY, wx: world.x, wy: world.y } });
    return api;
  }

  function select(id) {
    const value = id && typeof id === "object" ? id.id : id;
    const next = value === null || value === undefined ? -1 : (state.index.get(text(value, "")) ?? -1);
    Object.assign(state, { cameraInteracted: true, fitTracking: false });
    setSelected(next);
    if (next >= 0) {
      state.ripple = animate() ? { node: next, t: 0 } : null;
      const goal = revealSelected(true);
      if (goal) setCamera(goal);
    }
    draw(true);
    invalidate();
    return api;
  }

  /** Index the graph into typed arrays; known nodes keep their positions across updates. */
  function setData(data) {
    if (state.destroyed) return api;
    const idOf = node => (node >= 0 ? state.nodes[node].id : null);
    const normalized = normalizeData(data, idOf(state.selected));
    const previousSelected = idOf(state.selected);
    const topologySame = state.topologySignature === normalized.signature;
    const previous = { index: state.index, vx: state.vx, vy: state.vy, empty: state.n === 0 };
    const carried = {
      hovered: idOf(state.hovered),
      focus: idOf(state.focus),
      gesture: state.gesture && state.gesture.node >= 0 ? idOf(state.gesture.node) : null,
      ripple: state.ripple ? idOf(state.ripple.node) : null,
    };
    rememberPositions();

    const { nodes, edges } = normalized;
    const n = nodes.length;
    const index = new Map(nodes.map((node, position) => [node.id, position]));
    Object.assign(state, {
      nodes, n, index, query: normalized.query, topologySignature: normalized.signature,
      x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n),
      fixed: new Uint8Array(n), radius: new Float32Array(n), colorOf: new Uint8Array(n), groupOf: new Int32Array(n),
      highlighted: new Uint8Array(n), queryMatch: new Uint8Array(n), selectedNeighbor: new Uint8Array(n),
      focusNeighbor: new Uint8Array(n), labelWidth: new Float32Array(n).fill(NaN),
      edgeSource: new Int32Array(edges.length), edgeTarget: new Int32Array(edges.length), adj: new Int32Array(edges.length * 2),
      edgeTotal: normalized.edgeTotal, retainedEdges: edges.length, scannedEdges: normalized.scannedEdges,
      validEdgesScanned: normalized.validEdgesScanned, dedupeKeys: normalized.dedupeKeys,
      edgesTruncated: normalized.edgesTruncated, scanTruncated: normalized.scanTruncated,
      edgeAlpha: clamp(0.5 * Math.sqrt(150 / Math.max(150, edges.length)), 0.09, 0.5),
      selected: -1, focus: -1, hitDirty: true, sceneVersion: state.sceneVersion + 1,
      appear: previous.empty && n && animate() ? 0 : state.appear,
      colors: [], byColor: [], changedNodes: [],
    });

    // Compressed adjacency: neighbors of node i are adj[adjStart[i] .. adjStart[i + 1]).
    const degree = new Int32Array(n + 1);
    edges.forEach((edge, position) => {
      const [a, b] = [index.get(edge.source), index.get(edge.target)];
      [state.edgeSource[position], state.edgeTarget[position]] = [a, b];
      degree[a + 1] += 1;
      degree[b + 1] += 1;
    });
    for (let i = 0; i < n; i += 1) degree[i + 1] += degree[i];
    state.adjStart = degree;
    const cursor = degree.slice(0, n);
    for (let edge = 0; edge < edges.length; edge += 1) {
      const [a, b] = [state.edgeSource[edge], state.edgeTarget[edge]];
      state.adj[cursor[a]++] = b;
      state.adj[cursor[b]++] = a;
    }

    const colorIndex = new Map();
    const groupIndex = new Map();
    const labelCounts = new Map();
    nodes.forEach((node, i) => {
      const weight = Math.max(degree[i + 1] - degree[i], node.count);
      state.radius[i] = node.kind === "directory"
        ? clamp(7.5 + Math.sqrt(weight) * 0.85, 7.5, 15)
        : clamp(3.4 + Math.sqrt(weight) * 0.95, 3.4, 13);
      const color = groupColor(node.group);
      if (!colorIndex.has(color)) {
        colorIndex.set(color, state.colors.length);
        state.colors.push(color);
        state.byColor.push([]);
      }
      state.colorOf[i] = colorIndex.get(color);
      state.byColor[state.colorOf[i]].push(i);
      if (!groupIndex.has(node.group)) groupIndex.set(node.group, groupIndex.size);
      state.groupOf[i] = groupIndex.get(node.group);
      state.highlighted[i] = [node.id, node.path, node.group].some(value => normalized.highlightPaths.has(value)) ? 1 : 0;
      state.queryMatch[i] = normalized.queryNodes.has(node.id) ? 1 : 0;
      if (node.changed) state.changedNodes.push(i);
      const label = basename(node.path) || node.id;
      labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
    });
    // Repeated file names gain their parent folder, e.g. "index.ts · router".
    state.labels = nodes.map(node => {
      const label = basename(node.path) || node.id;
      const parent = directoryOf(node.path);
      return labelCounts.get(label) < 2 ? label : parent ? `${label} · ${basename(parent)}` : node.path;
    });

    // Seed new nodes around a stable per-folder center; known nodes keep their place.
    state.groupX = new Float64Array(groupIndex.size);
    state.groupY = new Float64Array(groupIndex.size);
    const members = new Int32Array(groupIndex.size);
    nodes.forEach((node, i) => {
      const group = state.groupOf[i];
      const old = state.memory.get(node.id);
      if (old) {
        [state.x[i], state.y[i]] = old;
      } else {
        const angle = hashUnit(`${node.group}:angle`) * TAU;
        const spread = 180 + hashUnit(`${node.group}:radius`) * 900;
        const theta = members[group] * GOLDEN_ANGLE + hashUnit(node.id) * 0.6;
        const distance = 34 + Math.sqrt(members[group] + 1) * 28 + hashUnit(`${node.id}:radius`) * 30;
        state.x[i] = Math.cos(angle) * spread + Math.cos(theta) * distance;
        state.y[i] = Math.sin(angle) * spread + Math.sin(theta) * distance;
      }
      members[group] += 1;
      state.groupX[group] += state.x[i];
      state.groupY[group] += state.y[i];
      if (topologySame && previous.index.has(node.id)) {
        state.vx[i] = previous.vx[previous.index.get(node.id)] || 0;
        state.vy[i] = previous.vy[previous.index.get(node.id)] || 0;
      }
    });
    for (let group = 0; group < groupIndex.size; group += 1) {
      state.groupX[group] /= members[group];
      state.groupY[group] /= members[group];
    }

    // Carry hover, drag, and selection across refreshes so polling never interrupts a gesture.
    const keep = id => (id !== null && index.has(id) ? index.get(id) : -1);
    state.hovered = keep(carried.hovered);
    if (carried.hovered !== null && state.hovered < 0) callback(onHover, null);
    setFocus(keep(carried.focus));
    if (state.focus < 0) state.focusT = 0;
    if (state.ripple) state.ripple.node = keep(carried.ripple);
    if (state.gesture && state.gesture.node >= 0) {
      state.gesture.node = keep(carried.gesture);
      if (state.gesture.node < 0) Object.assign(state.gesture, { type: "pan", dragging: false });
      else if (state.gesture.dragging) state.fixed[state.gesture.node] = 1;
    }
    setCursor(state.gesture && state.gesture.dragging ? "grabbing" : state.hovered >= 0 ? "pointer" : "");
    state.selected = keep(normalized.selectedId || null);
    markNeighbors(state.selectedNeighbor, state.selected, 1);
    orderEdges();
    const selectionChanged = previousSelected !== idOf(state.selected);
    if (selectionChanged && normalized.hasSelected && state.didFit) {
      Object.assign(state, { cameraInteracted: true, fitTracking: false });
    }
    if (!state.didFit && n) fit();
    const reveal = revealSelected(selectionChanged);
    if (reveal) setCamera(reveal, !state.didFit || !animate());
    if (!topologySame) startLayout();
    draw(true);
    return api;
  }

  // Pointer input -----------------------------------------------------------

  function pointerPoint(event) {
    const rect = typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: finite(event.clientX, 0) - finite(rect.left, 0), y: finite(event.clientY, 0) - finite(rect.top, 0) };
  }

  function findNodeAt(sx, sy) {
    if (!state.n) return -1;
    const grid = state.hitGrid;
    if (state.hitDirty) {
      grid.fill(state.x, state.y, state.n);
      state.hitDirty = false;
    }
    const point = worldPoint(sx, sy);
    const scale = state.view.scale;
    const span = Math.max(1, Math.ceil(16 / scale / grid.size));
    const cx = Math.floor((point.x - grid.minX) / grid.size);
    const cy = Math.floor((point.y - grid.minY) / grid.size);
    let [closest, closestDistance] = [-1, Infinity];
    for (let gx = Math.max(0, cx - span); gx <= Math.min(grid.cols - 1, cx + span); gx += 1) {
      for (let gy = Math.max(0, cy - span); gy <= Math.min(grid.rows - 1, cy + span); gy += 1) {
        const cell = gy * grid.cols + gx;
        for (let slot = grid.start[cell]; slot < grid.start[cell + 1]; slot += 1) {
          const i = grid.items[slot];
          const distance = Math.hypot(state.x[i] - point.x, state.y[i] - point.y) * scale;
          if (distance <= Math.max(state.radius[i] * scale, 1.6) + 6 && distance < closestDistance) {
            [closest, closestDistance] = [i, distance];
          }
        }
      }
    }
    return closest;
  }

  function pinchState() {
    const [first, second] = [...state.pointers.values()];
    const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
    return { type: "pinch", distance, mid, world: worldPoint(mid.x, mid.y), scale: state.view.scale };
  }

  function releaseDrag(gesture) {
    if (!gesture || !gesture.dragging) return;
    state.fixed[gesture.node] = 0;
    gesture.dragging = false;
    Object.assign(state, { layoutLimit: state.layoutIterations + 40, stableIterations: 0 });
  }

  function handlePointerDown(event) {
    if (state.destroyed || (event.button !== undefined && event.button > 0)) return;
    const point = pointerPoint(event);
    // A primary pointer starts a fresh gesture, even if an earlier release was never delivered.
    if (event.isPrimary && state.pointers.size) {
      releaseDrag(state.gesture);
      state.pointers.clear();
    }
    state.pointers.set(event.pointerId, point);
    if (typeof canvas.setPointerCapture === "function") {
      try { canvas.setPointerCapture(event.pointerId); } catch (_error) { /* optional */ }
    }
    Object.assign(state, { inertia: null, goal: null });
    if (state.pointers.size === 2) {
      releaseDrag(state.gesture);
      state.gesture = pinchState();
    } else if (state.pointers.size === 1) {
      const node = findNodeAt(point.x, point.y);
      const time = finite(event.timeStamp, now());
      state.gesture = { type: node >= 0 ? "node" : "pan", node, x: point.x, y: point.y, moved: false, dragging: false, vx: 0, vy: 0, time };
    }
    if (event.cancelable) event.preventDefault();
    // Preventing the default also skips the click's focus, which keyboard zoom and pan need.
    if (typeof canvas.focus === "function") canvas.focus({ preventScroll: true, focusVisible: false });
  }

  function handlePointerMove(event) {
    if (state.destroyed) return;
    const point = pointerPoint(event);
    const gesture = state.gesture;
    if (!state.pointers.has(event.pointerId) || !gesture) {
      setHovered(findNodeAt(point.x, point.y));
      return;
    }
    state.pointers.set(event.pointerId, point);
    if (gesture.type === "pinch") {
      if (state.pointers.size < 2) return;
      const current = pinchState();
      const scale = gesture.scale * (current.distance / gesture.distance);
      Object.assign(state, { cameraInteracted: true, fitTracking: false });
      setCamera({ scale, anchor: { sx: current.mid.x, sy: current.mid.y, wx: gesture.world.x, wy: gesture.world.y } }, true);
      return;
    }
    const dx = point.x - gesture.x;
    const dy = point.y - gesture.y;
    if (!gesture.moved && Math.abs(dx) + Math.abs(dy) <= 3) return;
    if (!gesture.moved) {
      gesture.moved = true;
      Object.assign(state, { cameraInteracted: true, fitTracking: false });
    }
    if (gesture.type === "node") {
      if (!gesture.dragging) {
        gesture.dragging = true;
        state.fixed[gesture.node] = 1;
        setHovered(gesture.node);
        setCursor("grabbing");
        // A running full layout keeps going; otherwise only nearby nodes wake up.
        if (state.layoutActive && !state.reach) Object.assign(state, { layoutLimit: Infinity, heat: 1, stableIterations: 0 });
        else startLayout(reachFrom(gesture.node), Infinity);
      }
      const world = worldPoint(point.x, point.y);
      [state.x[gesture.node], state.y[gesture.node]] = [world.x, world.y];
      state.hitDirty = true;
      state.sceneVersion += 1;
    } else {
      state.view.x -= dx / state.view.scale;
      state.view.y -= dy / state.view.scale;
      const time = finite(event.timeStamp, now());
      const elapsed = Math.max(1, time - gesture.time);
      gesture.vx = gesture.vx * 0.6 + (dx / elapsed) * 0.4;
      gesture.vy = gesture.vy * 0.6 + (dy / elapsed) * 0.4;
      gesture.time = time;
    }
    [gesture.x, gesture.y] = [point.x, point.y];
    invalidate();
  }

  function handlePointerUp(event) {
    if (!state.pointers.delete(event.pointerId)) return;
    if (typeof canvas.releasePointerCapture === "function") {
      try { canvas.releasePointerCapture(event.pointerId); } catch (_error) { /* optional */ }
    }
    const gesture = state.gesture;
    if (gesture && gesture.type === "pinch") {
      const [rest] = [...state.pointers.values()];
      state.gesture = rest ? { type: "pan", node: -1, x: rest.x, y: rest.y, moved: true, dragging: false, vx: 0, vy: 0, time: now() } : null;
      return;
    }
    state.gesture = null;
    if (!gesture) return;
    if (gesture.type === "node" && !gesture.moved && event.type === "pointerup") {
      const id = state.nodes[gesture.node].id;
      select(id);
      callback(onSelect, id);
    } else if (gesture.dragging) {
      releaseDrag(gesture);
      setCursor("pointer");
    } else if (gesture.type === "pan" && gesture.moved && animate()) {
      // Flick to glide; a pause before release stops in place.
      const recent = finite(event.timeStamp, now()) - gesture.time <= 80;
      if (recent && Math.hypot(gesture.vx, gesture.vy) > 0.15) state.inertia = { vx: gesture.vx, vy: gesture.vy };
    }
    invalidate();
  }

  function handlePointerLeave() {
    if (!state.gesture) setHovered(-1);
  }

  function handleWheel(event) {
    if (state.destroyed) return;
    const point = pointerPoint(event);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? state.height : 1;
    const delta = clamp(finite(event.deltaY, 0) * unit, -400, 400);
    // Trackpad pinches arrive as ctrl+wheel with small deltas.
    zoom(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018)), point.x, point.y);
    if (event.cancelable) event.preventDefault();
  }

  function handleKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (pan) {
      Object.assign(state, { cameraInteracted: true, fitTracking: false });
      const view = targetView();
      setCamera({ x: view.x + (pan[0] * 120) / view.scale, y: view.y + (pan[1] * 120) / view.scale, scale: view.scale });
    } else if (event.key === "+" || event.key === "=") zoom(1.25);
    else if (event.key === "-" || event.key === "_") zoom(0.8);
    else return;
    event.preventDefault();
  }

  function handleVisibility() {
    state.hidden = Boolean(ownerDocument && ownerDocument.visibilityState === "hidden");
    if (!state.hidden) return invalidate();
    if (state.frame !== null) cancelFrame(state.frame);
    state.frame = null;
    state.lastFrame = 0;
  }

  function resize() {
    if (state.destroyed) return;
    const rect = typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : null;
    const width = Math.max(1, Math.round(finite(rect && rect.width, finite(canvas.clientWidth, finite(canvas.width, 800)))));
    const height = Math.max(1, Math.round(finite(rect && rect.height, finite(canvas.clientHeight, finite(canvas.height, 600)))));
    // Capped at 2x: denser canvases cost raster time without visibly sharper lines.
    const dpr = clamp(finite(ownerWindow.devicePixelRatio, 1), 1, 2);
    Object.assign(state, { width, height, dpr });
    if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
    if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
    if (state.fitTracking && !state.cameraInteracted && state.n) setCamera(fitTarget(), true);
    draw();
  }

  const listeners = [
    [canvas, "pointerdown", handlePointerDown],
    [canvas, "pointermove", handlePointerMove],
    [canvas, "pointerup", handlePointerUp],
    [canvas, "pointercancel", handlePointerUp],
    [canvas, "lostpointercapture", handlePointerUp],
    [canvas, "pointerleave", handlePointerLeave],
    [canvas, "wheel", handleWheel, { passive: false }],
    [canvas, "keydown", handleKey],
    [ownerDocument, "visibilitychange", handleVisibility],
    [ownerWindow, "resize", resize],
    [reducedMotion, "change", invalidate],
  ];
  listeners.forEach(([target, type, listener, listenerOptions]) => {
    if (target && typeof target.addEventListener === "function") target.addEventListener(type, listener, listenerOptions);
  });
  if (typeof ownerWindow.ResizeObserver === "function") {
    state.resizeObserver = new ownerWindow.ResizeObserver(resize);
    state.resizeObserver.observe(canvas);
  }
  if (typeof ownerWindow.MutationObserver === "function" && ownerDocument?.documentElement) {
    state.themeObserver = new ownerWindow.MutationObserver(refreshTheme);
    state.themeObserver.observe(ownerDocument.documentElement, {
      attributes: true, attributeFilter: ["data-ds-dark-theme", "data-yh-style", "style", "class"],
    });
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    if (state.frame !== null) cancelFrame(state.frame);
    listeners.forEach(([target, type, listener, listenerOptions]) => {
      if (target && typeof target.removeEventListener === "function") target.removeEventListener(type, listener, listenerOptions);
    });
    if (state.resizeObserver && typeof state.resizeObserver.disconnect === "function") state.resizeObserver.disconnect();
    if (state.themeObserver) state.themeObserver.disconnect();
    if (state.probe) state.probe.remove();
    if (canvas.style) Object.assign(canvas.style, { touchAction: oldTouchAction, cursor: "" });
    if (typeof canvas.setAttribute === "function") {
      if (oldRole === null) canvas.removeAttribute("role");
      else canvas.setAttribute("role", oldRole);
      if (oldAriaLabel === null) canvas.removeAttribute("aria-label");
      else canvas.setAttribute("aria-label", oldAriaLabel);
    }
    Object.assign(state, { frame: null, cache: null, nodes: [], n: 0 });
    state.index.clear();
    state.memory.clear();
  }

  const api = { setData, select, fit, zoom, destroy, getStats };
  setData({});
  resize();
  return api;
}

export default createGraph;
