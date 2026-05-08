const canvas = document.querySelector("#tinCanvas");
const ctx = canvas.getContext("2d");

const ui = {
  imageInput: document.querySelector("#imageInput"),
  jsonInput: document.querySelector("#jsonInput"),
  showImage: document.querySelector("#showImage"),
  showGrid: document.querySelector("#showGrid"),
  showLabels: document.querySelector("#showLabels"),
  hideLongTin: document.querySelector("#hideLongTin"),
  edgeLimit: document.querySelector("#edgeLimit"),
  edgeValue: document.querySelector("#edgeValue"),
  angleLimit: document.querySelector("#angleLimit"),
  angleValue: document.querySelector("#angleValue"),
  longEdgeOpacity: document.querySelector("#longEdgeOpacity"),
  longEdgeValue: document.querySelector("#longEdgeValue"),
  pointCount: document.querySelector("#pointCount"),
  tinCount: document.querySelector("#tinCount"),
  filteredCount: document.querySelector("#filteredCount"),
  angleFilteredCount: document.querySelector("#angleFilteredCount"),
  emptySelection: document.querySelector("#emptySelection"),
  pointEditor: document.querySelector("#pointEditor"),
  pointX: document.querySelector("#pointX"),
  pointY: document.querySelector("#pointY"),
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
  dragging: false,
  dragOffset: { x: 0, y: 0 },
  nextId: 1,
  image: null,
  imageSrc: null,
  view: { scale: 1, x: 0, y: 0 },
  pointerDownAt: null
};

const pointRadius = 7;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  render();
}

function screenToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.view.x) / state.view.scale,
    y: (clientY - rect.top - state.view.y) / state.view.scale
  };
}

function worldToScreen(point) {
  return {
    x: point.x * state.view.scale + state.view.x,
    y: point.y * state.view.scale + state.view.y
  };
}

function setMode(mode) {
  state.mode = mode;
  ui.modeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  canvas.style.cursor = mode === "add" ? "crosshair" : "default";
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleFromSides(adjacentA, adjacentB, opposite) {
  const denominator = 2 * adjacentA * adjacentB;
  if (denominator <= 0) return 0;
  const cosine = Math.max(-1, Math.min(1, (adjacentA * adjacentA + adjacentB * adjacentB - opposite * opposite) / denominator));
  return Math.acos(cosine) * 180 / Math.PI;
}

function triangleQuality(triangle) {
  const [a, b, c] = triangle.vertices;
  const ab = distance(a, b);
  const bc = distance(b, c);
  const ca = distance(c, a);
  const angles = [
    angleFromSides(ab, ca, bc),
    angleFromSides(ab, bc, ca),
    angleFromSides(ca, bc, ab)
  ];
  return {
    lengths: [ab, bc, ca],
    maxEdge: Math.max(ab, bc, ca),
    minAngle: Math.min(...angles)
  };
}

function tinStatus(triangle) {
  const maxEdgeLimit = Number(ui.edgeLimit.value);
  const minAngleLimit = Number(ui.angleLimit.value);
  const tooLong = triangle.maxEdge > maxEdgeLimit;
  const tooSharp = triangle.minAngle < minAngleLimit;
  return {
    valid: !tooLong && !tooSharp,
    tooLong,
    tooSharp
  };
}

function findPointAt(world) {
  const hitRadius = pointRadius / state.view.scale + 4;
  for (let index = state.points.length - 1; index >= 0; index -= 1) {
    if (distance(world, state.points[index]) <= hitRadius) return state.points[index];
  }
  return null;
}

function addPoint(point) {
  state.points.push({
    id: state.nextId,
    x: Number(point.x.toFixed(1)),
    y: Number(point.y.toFixed(1)),
    mapX: "",
    mapY: ""
  });
  state.selectedId = state.nextId;
  state.nextId += 1;
  rebuildTin();
}

function selectedPoint() {
  return state.points.find((point) => point.id === state.selectedId) || null;
}

function removeSelectedPoint() {
  if (!state.selectedId) return;
  state.points = state.points.filter((point) => point.id !== state.selectedId);
  state.selectedId = null;
  rebuildTin();
}

function updateSelectedPoint(changes) {
  const point = selectedPoint();
  if (!point) return;
  Object.assign(point, changes);
  rebuildTin();
}

function triangleKey(edge) {
  return edge.map((point) => point._triIndex).sort((a, b) => a - b).join("-");
}

function circumcircle(a, b, c) {
  const ax = a.x;
  const ay = a.y;
  const bx = b.x;
  const by = b.y;
  const cx = c.x;
  const cy = c.y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 0.000001) return { x: 0, y: 0, r: -1 };
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  return { x: ux, y: uy, r: Math.hypot(ux - ax, uy - ay) };
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

  const dx = bounds.maxX - bounds.minX || 1;
  const dy = bounds.maxY - bounds.minY || 1;
  const span = Math.max(dx, dy);
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

  return triangles
    .filter((triangle) => triangle.vertices.every((point) => point.id > 0))
    .map((triangle) => {
      const vertices = triangle.vertices.map((vertex) => points.find((point) => point.id === vertex.id));
      const quality = triangleQuality({ vertices });
      return {
        ids: vertices.map((point) => point.id),
        vertices,
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
}

function rebuildTin() {
  state.triangles = buildDelaunay(state.points);
  updateUi();
  render();
}

function drawGrid(width, height) {
  if (!ui.showGrid.checked) return;
  const step = 50 * state.view.scale;
  if (step < 10) return;
  ctx.save();
  ctx.strokeStyle = "rgba(58, 71, 86, 0.14)";
  ctx.lineWidth = 1;
  const startX = ((state.view.x % step) + step) % step;
  const startY = ((state.view.y % step) + step) % step;
  for (let x = startX; x < width; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = startY; y < height; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawImage() {
  if (!state.image || !ui.showImage.checked) return;
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.drawImage(
    state.image,
    state.view.x,
    state.view.y,
    state.image.width * state.view.scale,
    state.image.height * state.view.scale
  );
  ctx.restore();
}

function drawTin() {
  const longOpacity = Number(ui.longEdgeOpacity.value) / 100;
  ctx.save();

  for (const triangle of state.triangles) {
    const status = tinStatus(triangle);
    if (!status.valid && ui.hideLongTin.checked) continue;
    const points = triangle.vertices.map(worldToScreen);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.lineTo(points[2].x, points[2].y);
    ctx.closePath();
    if (status.valid) {
      ctx.fillStyle = "rgba(15, 124, 128, 0.13)";
      ctx.strokeStyle = "rgba(14, 116, 144, 0.88)";
      ctx.lineWidth = 1.4;
    } else if (status.tooSharp) {
      ctx.fillStyle = `rgba(180, 35, 24, ${0.05 + longOpacity * 0.15})`;
      ctx.strokeStyle = `rgba(180, 35, 24, ${longOpacity})`;
      ctx.lineWidth = 1.1;
    } else {
      ctx.fillStyle = `rgba(202, 107, 32, ${0.06 + longOpacity * 0.14})`;
      ctx.strokeStyle = `rgba(202, 107, 32, ${longOpacity})`;
      ctx.lineWidth = 1.1;
    }
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawPoints() {
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "12px Segoe UI, sans-serif";

  for (const point of state.points) {
    const screen = worldToScreen(point);
    const selected = point.id === state.selectedId;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, selected ? 9 : pointRadius, 0, Math.PI * 2);
    ctx.fillStyle = selected ? "#cc5b33" : "#102a43";
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    if (ui.showLabels.checked) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "11px Segoe UI, sans-serif";
      ctx.fillText(point.id, screen.x, screen.y);
    }
  }

  ctx.restore();
}

function render() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawGrid(rect.width, rect.height);
  drawImage();
  drawTin();
  drawPoints();
}

function updateUi() {
  const statuses = state.triangles.map(tinStatus);
  const visibleTin = statuses.filter((status) => status.valid).length;
  const longTin = statuses.filter((status) => status.tooLong).length;
  const sharpTin = statuses.filter((status) => status.tooSharp).length;
  const filteredTin = state.triangles.length - visibleTin;
  const limit = Number(ui.edgeLimit.value);
  const angleLimit = Number(ui.angleLimit.value);
  ui.edgeValue.value = `${limit} px`;
  ui.angleValue.value = `${angleLimit}°`;
  ui.longEdgeValue.value = `${ui.longEdgeOpacity.value}%`;
  ui.pointCount.textContent = String(state.points.length);
  ui.tinCount.textContent = String(ui.hideLongTin.checked ? visibleTin : state.triangles.length);
  ui.filteredCount.textContent = String(longTin);
  ui.angleFilteredCount.textContent = String(sharpTin);

  const point = selectedPoint();
  ui.emptySelection.classList.toggle("hidden", Boolean(point));
  ui.pointEditor.classList.toggle("hidden", !point);
  if (point && document.activeElement !== ui.pointX && document.activeElement !== ui.pointY) {
    ui.pointX.value = point.x;
    ui.pointY.value = point.y;
  }
  if (point && document.activeElement !== ui.mapX && document.activeElement !== ui.mapY) {
    ui.mapX.value = point.mapX || "";
    ui.mapY.value = point.mapY || "";
  }
}

function fitView() {
  const rect = canvas.getBoundingClientRect();
  const padding = 54;
  let bounds;

  if (state.image) {
    bounds = { minX: 0, minY: 0, maxX: state.image.width, maxY: state.image.height };
  } else if (state.points.length) {
    bounds = state.points.reduce((box, point) => ({
      minX: Math.min(box.minX, point.x),
      minY: Math.min(box.minY, point.y),
      maxX: Math.max(box.maxX, point.x),
      maxY: Math.max(box.maxY, point.y)
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  } else {
    bounds = { minX: 0, minY: 0, maxX: rect.width, maxY: rect.height };
  }

  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  state.view.scale = Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height, 1.8);
  state.view.x = (rect.width - width * state.view.scale) / 2 - bounds.minX * state.view.scale;
  state.view.y = (rect.height - height * state.view.scale) / 2 - bounds.minY * state.view.scale;
  render();
}

function canvasPointerDown(event) {
  const world = screenToWorld(event.clientX, event.clientY);
  const point = findPointAt(world);
  state.pointerDownAt = { x: event.clientX, y: event.clientY };

  if (point) {
    state.selectedId = point.id;
    state.dragging = true;
    state.dragOffset = { x: point.x - world.x, y: point.y - world.y };
    setMode("select");
    updateUi();
    render();
    return;
  }

  if (state.mode === "add") {
    addPoint(world);
  } else {
    state.selectedId = null;
    updateUi();
    render();
  }
}

function canvasPointerMove(event) {
  if (!state.dragging) return;
  const point = selectedPoint();
  if (!point) return;
  const world = screenToWorld(event.clientX, event.clientY);
  point.x = Number((world.x + state.dragOffset.x).toFixed(1));
  point.y = Number((world.y + state.dragOffset.y).toFixed(1));
  rebuildTin();
}

function canvasPointerUp() {
  state.dragging = false;
  state.pointerDownAt = null;
}

function readImage(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const image = new Image();
    image.onload = () => {
      state.image = image;
      state.imageSrc = reader.result;
      fitView();
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function exportData() {
  const data = {
    version: 1,
    createdAt: new Date().toISOString(),
    edgeLimit: Number(ui.edgeLimit.value),
    angleLimit: Number(ui.angleLimit.value),
    points: state.points.map(({ id, x, y, mapX, mapY }) => ({ id, x, y, mapX, mapY })),
    triangles: state.triangles
      .filter((triangle) => tinStatus(triangle).valid)
      .map((triangle) => ({
        pointIds: triangle.ids,
        maxEdge: Number(triangle.maxEdge.toFixed(2)),
        minAngle: Number(triangle.minAngle.toFixed(2))
      }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = "tin-points.json";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.points)) throw new Error("points 배열이 없습니다.");
      state.points = data.points.map((point, index) => ({
        id: Number(point.id) || index + 1,
        x: Number(point.x) || 0,
        y: Number(point.y) || 0,
        mapX: point.mapX || "",
        mapY: point.mapY || ""
      }));
      state.nextId = Math.max(0, ...state.points.map((point) => point.id)) + 1;
      state.selectedId = null;
      if (data.edgeLimit) ui.edgeLimit.value = data.edgeLimit;
      if (data.angleLimit) ui.angleLimit.value = data.angleLimit;
      rebuildTin();
      fitView();
    } catch (error) {
      alert(`JSON을 불러오지 못했습니다: ${error.message}`);
    }
  };
  reader.readAsText(file);
}

canvas.addEventListener("pointerdown", canvasPointerDown);
canvas.addEventListener("pointermove", canvasPointerMove);
canvas.addEventListener("pointerup", canvasPointerUp);
canvas.addEventListener("pointerleave", canvasPointerUp);

window.addEventListener("resize", resizeCanvas);
window.addEventListener("keydown", (event) => {
  if (event.key === "Delete" || event.key === "Backspace") {
    const tag = document.activeElement?.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") removeSelectedPoint();
  }
  if (event.key.toLowerCase() === "a") setMode("add");
  if (event.key.toLowerCase() === "v") setMode("select");
});

ui.modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
ui.fitBtn.addEventListener("click", fitView);
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

ui.imageInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) readImage(file);
});

ui.jsonInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) importData(file);
});

[ui.showImage, ui.showGrid, ui.showLabels, ui.hideLongTin, ui.edgeLimit, ui.angleLimit, ui.longEdgeOpacity].forEach((control) => {
  control.addEventListener("input", () => {
    updateUi();
    render();
  });
});

ui.pointX.addEventListener("change", () => updateSelectedPoint({ x: Number(ui.pointX.value) || 0 }));
ui.pointY.addEventListener("change", () => updateSelectedPoint({ y: Number(ui.pointY.value) || 0 }));
ui.mapX.addEventListener("input", () => updateSelectedPoint({ mapX: ui.mapX.value }));
ui.mapY.addEventListener("input", () => updateSelectedPoint({ mapY: ui.mapY.value }));

resizeCanvas();
fitView();
