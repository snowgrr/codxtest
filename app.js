const VWORLD_KEY = "200C9F2A-A83F-3316-AEE2-5E92DED2F3D2";
const VWORLD_TILE_SIZE = 256;
const VWORLD_MIN_ZOOM = 7;
const VWORLD_MAX_ZOOM = 19;
const VWORLD_INITIAL = { lon: 126.9768, lat: 37.4016, zoom: 16 };
const tileCache = new Map();

const canvases = {
  map: document.querySelector("#mapCanvas"),
  cctv: document.querySelector("#cctvCanvas")
};

const contexts = {
  map: canvases.map.getContext("2d"),
  cctv: canvases.cctv.getContext("2d")
};

const ui = {
  cctvImageInput: document.querySelector("#cctvImageInput"),
  jsonInput: document.querySelector("#jsonInput"),
  showImage: document.querySelector("#showImage"),
  showGrid: document.querySelector("#showGrid"),
  showLabels: document.querySelector("#showLabels"),
  hideExcludedTin: document.querySelector("#hideExcludedTin"),
  edgeLimit: document.querySelector("#edgeLimit"),
  edgeValue: document.querySelector("#edgeValue"),
  angleLimit: document.querySelector("#angleLimit"),
  angleValue: document.querySelector("#angleValue"),
  warningOpacity: document.querySelector("#warningOpacity"),
  warningOpacityValue: document.querySelector("#warningOpacityValue"),
  pointCount: document.querySelector("#pointCount"),
  matchedCount: document.querySelector("#matchedCount"),
  tinCount: document.querySelector("#tinCount"),
  excludedCount: document.querySelector("#excludedCount"),
  warningCount: document.querySelector("#warningCount"),
  qualityAdvice: document.querySelector("#qualityAdvice"),
  emptySelection: document.querySelector("#emptySelection"),
  pointEditor: document.querySelector("#pointEditor"),
  cctvX: document.querySelector("#cctvX"),
  cctvY: document.querySelector("#cctvY"),
  mapX: document.querySelector("#mapX"),
  mapY: document.querySelector("#mapY"),
  deletePointBtn: document.querySelector("#deletePointBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  fitBtn: document.querySelector("#fitBtn"),
  modeButtons: document.querySelectorAll(".mode[data-mode]")
};

const state = {
  points: [],
  triangles: [],
  selectedId: null,
  mode: "add",
  dragging: null,
  nextId: 1,
  images: {
    cctv: null
  },
  imageSrc: {
    cctv: null
  },
  views: {
    map: { ...VWORLD_INITIAL },
    cctv: { scale: 1, x: 0, y: 0 }
  }
};

const pointRadius = 7;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pointCoord(point, space) {
  if (space === "cctv") return { x: point.x, y: point.y };
  if (!hasMapCoord(point)) return null;
  return { x: point.mapX, y: point.mapY };
}

function hasMapCoord(point) {
  return Number.isFinite(point.mapX) && Number.isFinite(point.mapY);
}

function selectedPoint() {
  return state.points.find((point) => point.id === state.selectedId) || null;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function edgeKeyFromIds(a, b) {
  return [a, b].sort((left, right) => left - right).join("-");
}

function angleFromSides(adjacentA, adjacentB, opposite) {
  const denominator = 2 * adjacentA * adjacentB;
  if (denominator <= 0) return 0;
  const cosine = clamp((adjacentA * adjacentA + adjacentB * adjacentB - opposite * opposite) / denominator, -1, 1);
  return Math.acos(cosine) * 180 / Math.PI;
}

function triangleQuality(vertices) {
  const [a, b, c] = vertices;
  const ab = distance(a, b);
  const bc = distance(b, c);
  const ca = distance(c, a);
  const angles = [
    angleFromSides(ab, ca, bc),
    angleFromSides(ab, bc, ca),
    angleFromSides(ca, bc, ab)
  ];
  const minAngle = Math.min(...angles);
  return {
    maxEdge: Math.max(ab, bc, ca),
    minAngle,
    minAngleVertexIndex: angles.indexOf(minAngle)
  };
}

function tinStatus(triangle) {
  const tooLong = triangle.maxEdge > Number(ui.edgeLimit.value);
  const tooSharp = triangle.minAngle < Number(ui.angleLimit.value);
  const excluded = triangle.isBoundary && (tooLong || tooSharp);
  return {
    included: !excluded,
    valid: !tooLong && !tooSharp,
    warning: !excluded && (tooLong || tooSharp),
    excluded,
    tooLong,
    tooSharp
  };
}

function triangleKey(edge) {
  return edge.map((point) => point._triIndex).sort((a, b) => a - b).join("-");
}

function circumcircle(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 0.000001) return { x: 0, y: 0, r: -1 };
  const ux = ((a.x * a.x + a.y * a.y) * (b.y - c.y) + (b.x * b.x + b.y * b.y) * (c.y - a.y) + (c.x * c.x + c.y * c.y) * (a.y - b.y)) / d;
  const uy = ((a.x * a.x + a.y * a.y) * (c.x - b.x) + (b.x * b.x + b.y * b.y) * (a.x - c.x) + (c.x * c.x + c.y * c.y) * (b.x - a.x)) / d;
  return { x: ux, y: uy, r: Math.hypot(ux - a.x, uy - a.y) };
}

function isInsideCircle(point, circle) {
  return circle.r >= 0 && Math.hypot(point.x - circle.x, point.y - circle.y) <= circle.r + 0.0001;
}

function buildDelaunay(points) {
  if (points.length < 3) return [];

  const workPoints = points.map((point, index) => ({ ...point, _triIndex: index }));
  const bounds = workPoints.reduce((box, point) => ({
    minX: Math.min(box.minX, point.x),
    minY: Math.min(box.minY, point.y),
    maxX: Math.max(box.maxX, point.x),
    maxY: Math.max(box.maxY, point.y)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

  const span = Math.max(bounds.maxX - bounds.minX || 1, bounds.maxY - bounds.minY || 1);
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;
  const superPoints = [
    { id: -1, x: midX - 20 * span, y: midY - span, _triIndex: workPoints.length },
    { id: -2, x: midX, y: midY + 20 * span, _triIndex: workPoints.length + 1 },
    { id: -3, x: midX + 20 * span, y: midY - span, _triIndex: workPoints.length + 2 }
  ];

  let triangles = [{ vertices: superPoints, circle: circumcircle(...superPoints) }];

  for (const point of workPoints) {
    const bad = triangles.filter((triangle) => isInsideCircle(point, triangle.circle));
    const edgeMap = new Map();

    for (const triangle of bad) {
      const [a, b, c] = triangle.vertices;
      [[a, b], [b, c], [c, a]].forEach((edge) => {
        const key = triangleKey(edge);
        if (edgeMap.has(key)) edgeMap.delete(key);
        else edgeMap.set(key, edge);
      });
    }

    triangles = triangles.filter((triangle) => !bad.includes(triangle));

    for (const edge of edgeMap.values()) {
      const vertices = [edge[0], edge[1], point];
      triangles.push({ vertices, circle: circumcircle(...vertices) });
    }
  }

  const result = triangles
    .filter((triangle) => triangle.vertices.every((point) => point.id > 0))
    .map((triangle) => {
      const vertices = triangle.vertices.map((vertex) => points.find((point) => point.id === vertex.id));
      const quality = triangleQuality(vertices);
      const ids = vertices.map((point) => point.id);
      return {
        ids,
        vertices,
        edges: [
          edgeKeyFromIds(ids[0], ids[1]),
          edgeKeyFromIds(ids[1], ids[2]),
          edgeKeyFromIds(ids[2], ids[0])
        ],
        minAnglePointId: vertices[quality.minAngleVertexIndex].id,
        maxEdge: quality.maxEdge,
        minAngle: quality.minAngle,
        area: Math.abs(
          (vertices[0].x * (vertices[1].y - vertices[2].y) +
          vertices[1].x * (vertices[2].y - vertices[0].y) +
          vertices[2].x * (vertices[0].y - vertices[1].y)) / 2
        )
      };
    })
    .filter((triangle) => triangle.area > 0.01);

  return annotateTinTopology(result);
}

function annotateTinTopology(triangles) {
  const edgeUse = new Map();
  for (const triangle of triangles) {
    for (const edge of triangle.edges) edgeUse.set(edge, (edgeUse.get(edge) || 0) + 1);
  }
  for (const triangle of triangles) {
    triangle.isBoundary = triangle.edges.some((edge) => edgeUse.get(edge) === 1);
  }
  return triangles;
}

function lonLatToTilePixel(lon, lat, zoom) {
  const safeLat = clamp(lat, -85.05112878, 85.05112878);
  const sin = Math.sin(safeLat * Math.PI / 180);
  const scale = VWORLD_TILE_SIZE * 2 ** zoom;
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
  };
}

function tilePixelToLonLat(x, y, zoom) {
  const scale = VWORLD_TILE_SIZE * 2 ** zoom;
  const lon = x / scale * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / scale;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { x: lon, y: lat };
}

function mapCenterPixel() {
  const view = state.views.map;
  return lonLatToTilePixel(view.lon, view.lat, view.zoom);
}

function lonLatToScreen(coord) {
  const rect = canvases.map.getBoundingClientRect();
  const center = mapCenterPixel();
  const pixel = lonLatToTilePixel(coord.x, coord.y, state.views.map.zoom);
  return {
    x: rect.width / 2 + pixel.x - center.x,
    y: rect.height / 2 + pixel.y - center.y
  };
}

function screenToLonLat(clientX, clientY) {
  const rect = canvases.map.getBoundingClientRect();
  const center = mapCenterPixel();
  const x = center.x + clientX - rect.left - rect.width / 2;
  const y = center.y + clientY - rect.top - rect.height / 2;
  return tilePixelToLonLat(x, y, state.views.map.zoom);
}

function screenToWorld(space, clientX, clientY) {
  if (space === "map") return screenToLonLat(clientX, clientY);
  const rect = canvases[space].getBoundingClientRect();
  const view = state.views[space];
  return {
    x: (clientX - rect.left - view.x) / view.scale,
    y: (clientY - rect.top - view.y) / view.scale
  };
}

function worldToScreen(space, point) {
  if (space === "map") return lonLatToScreen(point);
  const view = state.views[space];
  return {
    x: point.x * view.scale + view.x,
    y: point.y * view.scale + view.y
  };
}

function findPointAt(space, world) {
  if (space === "map") {
    const target = lonLatToScreen(world);
    const hitRadius = pointRadius + 5;
    for (let index = state.points.length - 1; index >= 0; index -= 1) {
      const coord = pointCoord(state.points[index], space);
      if (coord && distance(target, lonLatToScreen(coord)) <= hitRadius) return state.points[index];
    }
    return null;
  }

  const hitRadius = pointRadius / state.views[space].scale + 4;
  for (let index = state.points.length - 1; index >= 0; index -= 1) {
    const coord = pointCoord(state.points[index], space);
    if (coord && distance(world, coord) <= hitRadius) return state.points[index];
  }
  return null;
}

function rebuildTin() {
  state.triangles = buildDelaunay(state.points);
  updateUi();
  render();
}

function resizeCanvases() {
  const ratio = window.devicePixelRatio || 1;
  for (const [space, canvas] of Object.entries(canvases)) {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    contexts[space].setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  render();
}

function addCctvPoint(world) {
  const point = {
    id: state.nextId,
    x: Number(world.x.toFixed(1)),
    y: Number(world.y.toFixed(1)),
    mapX: null,
    mapY: null
  };
  state.points.push(point);
  state.selectedId = point.id;
  state.nextId += 1;
  rebuildTin();
}

function setMapCoord(point, world) {
  point.mapX = Number(world.x.toFixed(7));
  point.mapY = Number(world.y.toFixed(7));
  updateUi();
  render();
}

function updateSelectedPoint(changes) {
  const point = selectedPoint();
  if (!point) return;
  Object.assign(point, changes);
  rebuildTin();
}

function removeSelectedPoint() {
  if (!state.selectedId) return;
  state.points = state.points.filter((point) => point.id !== state.selectedId);
  state.selectedId = null;
  rebuildTin();
}

function setMode(mode) {
  state.mode = mode;
  ui.modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  canvases.cctv.style.cursor = mode === "add" ? "crosshair" : "default";
  canvases.map.style.cursor = "crosshair";
}

function fitView(space) {
  if (space === "map") {
    const coords = state.points.map((point) => pointCoord(point, "map")).filter(Boolean);
    if (coords.length) {
      state.views.map.lon = coords.reduce((sum, coord) => sum + coord.x, 0) / coords.length;
      state.views.map.lat = coords.reduce((sum, coord) => sum + coord.y, 0) / coords.length;
      if (coords.length === 1) state.views.map.zoom = 17;
    } else {
      Object.assign(state.views.map, VWORLD_INITIAL);
    }
    return;
  }

  const canvas = canvases[space];
  const rect = canvas.getBoundingClientRect();
  const image = state.images[space];
  const padding = 54;
  let bounds;

  if (image) {
    bounds = { minX: 0, minY: 0, maxX: image.width, maxY: image.height };
  } else {
    const coords = state.points.map((point) => pointCoord(point, space)).filter(Boolean);
    if (coords.length) {
      bounds = coords.reduce((box, point) => ({
        minX: Math.min(box.minX, point.x),
        minY: Math.min(box.minY, point.y),
        maxX: Math.max(box.maxX, point.x),
        maxY: Math.max(box.maxY, point.y)
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    } else {
      bounds = { minX: 0, minY: 0, maxX: rect.width, maxY: rect.height };
    }
  }

  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const view = state.views[space];
  view.scale = Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height, 1.8);
  view.x = (rect.width - width * view.scale) / 2 - bounds.minX * view.scale;
  view.y = (rect.height - height * view.scale) / 2 - bounds.minY * view.scale;
}

function fitBothViews() {
  fitView("map");
  fitView("cctv");
  render();
}

function drawGrid(space) {
  if (space === "map" || !ui.showGrid.checked) return;
  const ctx = contexts[space];
  const canvas = canvases[space];
  const rect = canvas.getBoundingClientRect();
  const view = state.views[space];
  const step = 50 * view.scale;
  if (step < 10) return;
  ctx.save();
  ctx.strokeStyle = "rgba(58, 71, 86, 0.14)";
  ctx.lineWidth = 1;
  const startX = ((view.x % step) + step) % step;
  const startY = ((view.y % step) + step) % step;
  for (let x = startX; x < rect.width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, rect.height);
    ctx.stroke();
  }
  for (let y = startY; y < rect.height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(rect.width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function tileUrl(z, y, x) {
  return `https://api.vworld.kr/req/wmts/1.0.0/${VWORLD_KEY}/Base/${z}/${y}/${x}.png`;
}

function getTileImage(z, y, x) {
  const url = tileUrl(z, y, x);
  if (tileCache.has(url)) return tileCache.get(url);
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.onload = render;
  image.onerror = render;
  image.src = url;
  tileCache.set(url, image);
  return image;
}

function drawVWorldMap() {
  const ctx = contexts.map;
  const rect = canvases.map.getBoundingClientRect();
  const view = state.views.map;
  const zoom = clamp(Math.round(view.zoom), VWORLD_MIN_ZOOM, VWORLD_MAX_ZOOM);
  const maxTiles = 2 ** zoom;
  const center = mapCenterPixel();
  const topLeft = {
    x: center.x - rect.width / 2,
    y: center.y - rect.height / 2
  };
  const startX = Math.floor(topLeft.x / VWORLD_TILE_SIZE);
  const startY = Math.floor(topLeft.y / VWORLD_TILE_SIZE);
  const endX = Math.floor((topLeft.x + rect.width) / VWORLD_TILE_SIZE);
  const endY = Math.floor((topLeft.y + rect.height) / VWORLD_TILE_SIZE);

  ctx.save();
  ctx.fillStyle = "#dbe3ec";
  ctx.fillRect(0, 0, rect.width, rect.height);

  for (let tileY = startY; tileY <= endY; tileY += 1) {
    if (tileY < 0 || tileY >= maxTiles) continue;
    for (let tileX = startX; tileX <= endX; tileX += 1) {
      const wrappedX = ((tileX % maxTiles) + maxTiles) % maxTiles;
      const image = getTileImage(zoom, tileY, wrappedX);
      const x = tileX * VWORLD_TILE_SIZE - topLeft.x;
      const y = tileY * VWORLD_TILE_SIZE - topLeft.y;
      if (image.complete && image.naturalWidth) {
        ctx.drawImage(image, x, y, VWORLD_TILE_SIZE, VWORLD_TILE_SIZE);
      } else {
        ctx.fillStyle = "#eef2f7";
        ctx.fillRect(x, y, VWORLD_TILE_SIZE, VWORLD_TILE_SIZE);
      }
    }
  }

  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.fillRect(10, rect.height - 28, 92, 20);
  ctx.fillStyle = "#475569";
  ctx.font = "11px Segoe UI, sans-serif";
  ctx.fillText("VWorld Base", 18, rect.height - 14);
  ctx.restore();
}

function drawImage(space) {
  if (space === "map") {
    drawVWorldMap();
    return;
  }
  const image = state.images[space];
  if (!image || !ui.showImage.checked) return;
  const ctx = contexts[space];
  const view = state.views[space];
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.drawImage(image, view.x, view.y, image.width * view.scale, image.height * view.scale);
  ctx.restore();
}

function drawTin(space) {
  const ctx = contexts[space];
  const opacity = Number(ui.warningOpacity.value) / 100;
  ctx.save();
  for (const triangle of state.triangles) {
    const status = tinStatus(triangle);
    if (status.excluded && ui.hideExcludedTin.checked) continue;
    const coords = triangle.vertices.map((point) => pointCoord(point, space));
    if (coords.some((coord) => !coord)) continue;
    const points = coords.map((coord) => worldToScreen(space, coord));
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.lineTo(points[2].x, points[2].y);
    ctx.closePath();

    if (status.valid) {
      ctx.fillStyle = space === "map" ? "rgba(37, 99, 235, 0.12)" : "rgba(15, 118, 110, 0.13)";
      ctx.strokeStyle = space === "map" ? "rgba(37, 99, 235, 0.86)" : "rgba(15, 118, 110, 0.88)";
      ctx.lineWidth = 1.4;
    } else if (status.warning) {
      ctx.fillStyle = status.tooSharp
        ? `rgba(180, 35, 24, ${0.08 + opacity * 0.13})`
        : `rgba(202, 107, 32, ${0.07 + opacity * 0.12})`;
      ctx.strokeStyle = status.tooSharp ? "rgba(180, 35, 24, 0.9)" : "rgba(202, 107, 32, 0.86)";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
    } else {
      ctx.fillStyle = `rgba(202, 107, 32, ${0.06 + opacity * 0.14})`;
      ctx.strokeStyle = `rgba(202, 107, 32, ${opacity})`;
      ctx.lineWidth = 1.1;
    }

    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function getPointRecommendations() {
  const scores = new Map();
  for (const triangle of state.triangles) {
    const status = tinStatus(triangle);
    if (!status.warning || !status.tooSharp) continue;
    const current = scores.get(triangle.minAnglePointId) || { count: 0, minAngle: Infinity };
    current.count += 1;
    current.minAngle = Math.min(current.minAngle, triangle.minAngle);
    scores.set(triangle.minAnglePointId, current);
  }
  return [...scores.entries()]
    .map(([pointId, score]) => ({ pointId, ...score }))
    .sort((a, b) => b.count - a.count || a.minAngle - b.minAngle)
    .slice(0, 3);
}

function drawPoints(space) {
  const ctx = contexts[space];
  const recommendations = new Set(getPointRecommendations().map((item) => item.pointId));
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const point of state.points) {
    const coord = pointCoord(point, space);
    if (!coord) continue;
    const screen = worldToScreen(space, coord);
    const selected = point.id === state.selectedId;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, selected ? 9 : pointRadius, 0, Math.PI * 2);
    ctx.fillStyle = selected ? "#cc5b33" : (space === "map" ? "#1d4ed8" : "#102a43");
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    if (ui.showLabels.checked) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "11px Segoe UI, sans-serif";
      ctx.fillText(point.id, screen.x, screen.y);
    }

    if (recommendations.has(point.id)) {
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, selected ? 16 : 14, 0, Math.PI * 2);
      ctx.strokeStyle = "#b42318";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

function drawMapPrompt() {
  const point = selectedPoint();
  if (!point || hasMapCoord(point)) return;
  const ctx = contexts.map;
  const rect = canvases.map.getBoundingClientRect();
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.strokeStyle = "rgba(37, 99, 235, 0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(18, rect.height - 62, Math.min(450, rect.width - 36), 44, 7);
  else ctx.rect(18, rect.height - 62, Math.min(450, rect.width - 36), 44);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1e3a8a";
  ctx.font = "13px Segoe UI, sans-serif";
  ctx.fillText(`선택 포인트 #${point.id}의 지도 위치를 클릭하세요.`, 34, rect.height - 35);
  ctx.restore();
}

function renderSpace(space) {
  const canvas = canvases[space];
  const ctx = contexts[space];
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawGrid(space);
  drawImage(space);
  drawTin(space);
  drawPoints(space);
  if (space === "map") drawMapPrompt();
}

function render() {
  renderSpace("map");
  renderSpace("cctv");
}

function updateUi() {
  const statuses = state.triangles.map(tinStatus);
  const includedTin = statuses.filter((status) => status.included).length;
  const excludedTin = statuses.filter((status) => status.excluded).length;
  const warningTin = statuses.filter((status) => status.warning).length;
  const matched = state.points.filter(hasMapCoord).length;
  const recommendations = getPointRecommendations();
  const point = selectedPoint();

  ui.edgeValue.value = `${ui.edgeLimit.value} px`;
  ui.angleValue.value = `${ui.angleLimit.value}°`;
  ui.warningOpacityValue.value = `${ui.warningOpacity.value}%`;
  ui.pointCount.textContent = String(state.points.length);
  ui.matchedCount.textContent = `${matched}/${state.points.length}`;
  ui.tinCount.textContent = String(ui.hideExcludedTin.checked ? includedTin : state.triangles.length);
  ui.excludedCount.textContent = String(excludedTin);
  ui.warningCount.textContent = String(warningTin);

  ui.emptySelection.classList.toggle("hidden", Boolean(point));
  ui.pointEditor.classList.toggle("hidden", !point);
  if (point && ![ui.cctvX, ui.cctvY, ui.mapX, ui.mapY].includes(document.activeElement)) {
    ui.cctvX.value = point.x;
    ui.cctvY.value = point.y;
    ui.mapX.value = hasMapCoord(point) ? point.mapX.toFixed(7) : "";
    ui.mapY.value = hasMapCoord(point) ? point.mapY.toFixed(7) : "";
  }

  if (state.points.length < 3) {
    ui.qualityAdvice.textContent = "CCTV 포인트 3개 이상부터 TIN 품질을 평가합니다.";
  } else if (warningTin && recommendations.length) {
    const labels = recommendations
      .map((item) => `#${item.pointId} (${item.count}개, 최소 ${item.minAngle.toFixed(1)}°)`)
      .join(", ");
    ui.qualityAdvice.textContent = `내부 예각 TIN은 지도 공백 방지를 위해 유지됩니다. 후보 ${labels}를 이동하거나 보조 포인트를 추가하세요.`;
  } else if (excludedTin) {
    ui.qualityAdvice.textContent = "외곽의 품질 낮은 TIN만 제외했습니다. 내부 지도 매칭 공백은 만들지 않습니다.";
  } else {
    ui.qualityAdvice.textContent = "현재 CCTV TIN 품질이 기준을 만족합니다.";
  }
}

function handlePointerDown(space, event) {
  const world = screenToWorld(space, event.clientX, event.clientY);
  const hit = findPointAt(space, world);

  if (hit) {
    state.selectedId = hit.id;
    state.dragging = {
      space,
      pointId: hit.id,
      offset: {
        x: pointCoord(hit, space).x - world.x,
        y: pointCoord(hit, space).y - world.y
      }
    };
    setMode("select");
    updateUi();
    render();
    return;
  }

  if (space === "cctv" && state.mode === "add") {
    addCctvPoint(world);
    return;
  }

  if (space === "map") {
    const point = selectedPoint();
    if (point) setMapCoord(point, world);
    return;
  }

  state.selectedId = null;
  updateUi();
  render();
}

function handlePointerMove(space, event) {
  if (!state.dragging || state.dragging.space !== space) return;
  const point = state.points.find((item) => item.id === state.dragging.pointId);
  if (!point) return;
  const world = screenToWorld(space, event.clientX, event.clientY);

  if (space === "cctv") {
    point.x = Number((world.x + state.dragging.offset.x).toFixed(1));
    point.y = Number((world.y + state.dragging.offset.y).toFixed(1));
    rebuildTin();
  } else {
    point.mapX = Number((world.x + state.dragging.offset.x).toFixed(7));
    point.mapY = Number((world.y + state.dragging.offset.y).toFixed(7));
    updateUi();
    render();
  }
}

function handlePointerUp() {
  state.dragging = null;
}

function handleMapWheel(event) {
  event.preventDefault();
  const rect = canvases.map.getBoundingClientRect();
  const before = screenToLonLat(event.clientX, event.clientY);
  const nextZoom = clamp(state.views.map.zoom + (event.deltaY < 0 ? 1 : -1), VWORLD_MIN_ZOOM, VWORLD_MAX_ZOOM);
  if (nextZoom === state.views.map.zoom) return;

  const pointerPixel = lonLatToTilePixel(before.x, before.y, nextZoom);
  const centerPixel = {
    x: pointerPixel.x - (event.clientX - rect.left - rect.width / 2),
    y: pointerPixel.y - (event.clientY - rect.top - rect.height / 2)
  };
  const center = tilePixelToLonLat(centerPixel.x, centerPixel.y, nextZoom);
  state.views.map.zoom = nextZoom;
  state.views.map.lon = center.x;
  state.views.map.lat = center.y;
  render();
}

function readImage(space, file) {
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      state.images[space] = image;
      state.imageSrc[space] = reader.result;
      fitView(space);
      render();
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function exportData() {
  const data = {
    version: 4,
    createdAt: new Date().toISOString(),
    coordinateSystem: "WGS84",
    initialMapCenter: { lon: VWORLD_INITIAL.lon, lat: VWORLD_INITIAL.lat, zoom: VWORLD_INITIAL.zoom },
    edgeLimit: Number(ui.edgeLimit.value),
    angleLimit: Number(ui.angleLimit.value),
    points: state.points.map(({ id, x, y, mapX, mapY }) => ({
      id,
      cctv: { x, y },
      map: hasMapCoord({ mapX, mapY }) ? { lon: mapX, lat: mapY } : null
    })),
    triangles: state.triangles
      .filter((triangle) => tinStatus(triangle).included)
      .map((triangle) => ({
        pointIds: triangle.ids,
        maxEdge: Number(triangle.maxEdge.toFixed(2)),
        minAngle: Number(triangle.minAngle.toFixed(2)),
        isBoundary: triangle.isBoundary,
        mapReady: triangle.vertices.every(hasMapCoord),
        quality: tinStatus(triangle).valid ? "ok" : "warning"
      }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = "tin-points-wgs84.json";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.points)) throw new Error("points 배열이 없습니다.");
      state.points = data.points.map((point, index) => {
        const cctv = point.cctv || point;
        const map = point.map || null;
        const lon = map ? (map.lon ?? map.x) : point.mapX;
        const lat = map ? (map.lat ?? map.y) : point.mapY;
        return {
          id: Number(point.id) || index + 1,
          x: Number(cctv.x) || 0,
          y: Number(cctv.y) || 0,
          mapX: lon !== "" && Number.isFinite(Number(lon)) ? Number(lon) : null,
          mapY: lat !== "" && Number.isFinite(Number(lat)) ? Number(lat) : null
        };
      });
      state.nextId = Math.max(0, ...state.points.map((point) => point.id)) + 1;
      state.selectedId = null;
      if (data.edgeLimit) ui.edgeLimit.value = data.edgeLimit;
      if (data.angleLimit) ui.angleLimit.value = data.angleLimit;
      rebuildTin();
      fitBothViews();
    } catch (error) {
      alert(`JSON을 불러오지 못했습니다. ${error.message}`);
    }
  };
  reader.readAsText(file);
}

for (const space of ["map", "cctv"]) {
  canvases[space].addEventListener("pointerdown", (event) => handlePointerDown(space, event));
  canvases[space].addEventListener("pointermove", (event) => handlePointerMove(space, event));
  canvases[space].addEventListener("pointerup", handlePointerUp);
  canvases[space].addEventListener("pointerleave", handlePointerUp);
}

canvases.map.addEventListener("wheel", handleMapWheel, { passive: false });

window.addEventListener("resize", () => {
  resizeCanvases();
  fitBothViews();
});

window.addEventListener("keydown", (event) => {
  const tag = document.activeElement?.tagName;
  if ((event.key === "Delete" || event.key === "Backspace") && tag !== "INPUT" && tag !== "TEXTAREA") removeSelectedPoint();
  if (event.key.toLowerCase() === "a") setMode("add");
  if (event.key.toLowerCase() === "v") setMode("select");
});

ui.modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
ui.fitBtn.addEventListener("click", fitBothViews);
ui.deletePointBtn.addEventListener("click", removeSelectedPoint);
ui.clearBtn.addEventListener("click", () => {
  if (!confirm("모든 포인트와 TIN을 삭제할까요?")) return;
  state.points = [];
  state.triangles = [];
  state.selectedId = null;
  state.nextId = 1;
  rebuildTin();
});
ui.exportBtn.addEventListener("click", exportData);

ui.cctvImageInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) readImage("cctv", file);
});

ui.jsonInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) importData(file);
});

[ui.showImage, ui.showGrid, ui.showLabels, ui.hideExcludedTin, ui.edgeLimit, ui.angleLimit, ui.warningOpacity].forEach((control) => {
  control.addEventListener("input", () => {
    updateUi();
    render();
  });
});

ui.cctvX.addEventListener("change", () => updateSelectedPoint({ x: Number(ui.cctvX.value) || 0 }));
ui.cctvY.addEventListener("change", () => updateSelectedPoint({ y: Number(ui.cctvY.value) || 0 }));
ui.mapX.addEventListener("change", () => updateSelectedPoint({ mapX: ui.mapX.value === "" ? null : Number(ui.mapX.value) }));
ui.mapY.addEventListener("change", () => updateSelectedPoint({ mapY: ui.mapY.value === "" ? null : Number(ui.mapY.value) }));

resizeCanvases();
fitBothViews();
setMode("add");
