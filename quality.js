(function applyTopologyAwareQualityFilter() {
  if (typeof ui === "undefined" || typeof state === "undefined") return;

  const originalBuildDelaunay = window.buildDelaunay || buildDelaunay;
  const originalDrawPoints = window.drawPoints || drawPoints;
  const originalUpdateUi = window.updateUi || updateUi;

  if (!ui.qualityAdvice) {
    const actionsPanel = document.querySelector(".panel.actions");
    const panel = document.createElement("section");
    panel.className = "panel advice";
    panel.innerHTML = "<h2>개선 권장</h2><div id=\"qualityAdvice\" class=\"muted\">내부 품질 경고가 있으면 후보 포인트가 표시됩니다.</div>";
    actionsPanel.before(panel);
    ui.qualityAdvice = document.querySelector("#qualityAdvice");
  }

  function edgeKeyFromIds(a, b) {
    return [a, b].sort((left, right) => left - right).join("-");
  }

  function annotateTinTopology(triangles) {
    const edgeUse = new Map();
    for (const triangle of triangles) {
      triangle.edges = [
        edgeKeyFromIds(triangle.ids[0], triangle.ids[1]),
        edgeKeyFromIds(triangle.ids[1], triangle.ids[2]),
        edgeKeyFromIds(triangle.ids[2], triangle.ids[0])
      ];
      const quality = triangleQuality({ vertices: triangle.vertices });
      triangle.minAnglePointId = triangle.vertices[quality.minAngleVertexIndex].id;
      for (const edge of triangle.edges) {
        edgeUse.set(edge, (edgeUse.get(edge) || 0) + 1);
      }
    }
    for (const triangle of triangles) {
      triangle.isBoundary = triangle.edges.some((edge) => edgeUse.get(edge) === 1);
    }
    return triangles;
  }

  const previousTriangleQuality = triangleQuality;
  window.triangleQuality = function patchedTriangleQuality(triangle) {
    const quality = previousTriangleQuality(triangle);
    if (!quality.angles) {
      const [a, b, c] = triangle.vertices;
      const ab = distance(a, b);
      const bc = distance(b, c);
      const ca = distance(c, a);
      quality.angles = [
        angleFromSides(ab, ca, bc),
        angleFromSides(ab, bc, ca),
        angleFromSides(ca, bc, ab)
      ];
      quality.minAngle = Math.min(...quality.angles);
    }
    if (quality.minAngleVertexIndex === undefined) {
      quality.minAngleVertexIndex = quality.angles.indexOf(quality.minAngle);
    }
    return quality;
  };
  triangleQuality = window.triangleQuality;

  window.tinStatus = function patchedTinStatus(triangle) {
    const tooLong = triangle.maxEdge > Number(ui.edgeLimit.value);
    const tooSharp = triangle.minAngle < Number(ui.angleLimit.value);
    const excluded = triangle.isBoundary && (tooLong || tooSharp);
    return {
      included: !excluded,
      valid: !tooLong && !tooSharp,
      warning: !excluded && (tooLong || tooSharp),
      excluded,
      isBoundary: triangle.isBoundary,
      tooLong,
      tooSharp
    };
  };
  tinStatus = window.tinStatus;

  window.rebuildTin = function patchedRebuildTin() {
    state.triangles = annotateTinTopology(originalBuildDelaunay(state.points));
    updateUi();
    render();
  };
  rebuildTin = window.rebuildTin;

  window.getPointRecommendations = function getPointRecommendations() {
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
  };

  window.drawTin = function patchedDrawTin() {
    const longOpacity = Number(ui.longEdgeOpacity.value) / 100;
    ctx.save();
    for (const triangle of state.triangles) {
      const status = tinStatus(triangle);
      if (status.excluded && ui.hideLongTin.checked) continue;
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
      } else if (status.warning) {
        ctx.fillStyle = status.tooSharp
          ? `rgba(180, 35, 24, ${0.08 + longOpacity * 0.13})`
          : `rgba(202, 107, 32, ${0.07 + longOpacity * 0.12})`;
        ctx.strokeStyle = status.tooSharp ? "rgba(180, 35, 24, 0.9)" : "rgba(202, 107, 32, 0.85)";
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 5]);
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
      ctx.setLineDash([]);
    }
    ctx.restore();
  };
  drawTin = window.drawTin;

  window.drawPoints = function patchedDrawPoints() {
    originalDrawPoints();
    const recommendations = new Map(getPointRecommendations().map((item, index) => [item.pointId, index + 1]));
    if (!recommendations.size) return;
    ctx.save();
    for (const point of state.points) {
      if (!recommendations.has(point.id)) continue;
      const screen = worldToScreen(point);
      const selected = point.id === state.selectedId;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, selected ? 16 : 14, 0, Math.PI * 2);
      ctx.strokeStyle = "#b42318";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  };
  drawPoints = window.drawPoints;

  window.updateUi = function patchedUpdateUi() {
    const statuses = state.triangles.map(tinStatus);
    const includedTin = statuses.filter((status) => status.included).length;
    const excludedTin = statuses.filter((status) => status.excluded).length;
    const warningTin = statuses.filter((status) => status.warning).length;
    originalUpdateUi();
    ui.tinCount.textContent = String(ui.hideLongTin.checked ? includedTin : state.triangles.length);
    ui.filteredCount.textContent = String(excludedTin);
    ui.angleFilteredCount.textContent = String(warningTin);
    const recommendations = getPointRecommendations();
    if (!warningTin) {
      ui.qualityAdvice.textContent = excludedTin
        ? "외곽 저품질 TIN만 제외되었습니다. 내부 보간 공백은 없습니다."
        : "현재 TIN 품질이 기준을 만족합니다.";
    } else if (recommendations.length) {
      const labels = recommendations
        .map((item) => `#${item.pointId} (${item.count}개, 최소 ${item.minAngle.toFixed(1)}°)`)
        .join(", ");
      ui.qualityAdvice.textContent = `내부 저품질 TIN은 공백 방지를 위해 유지됩니다. 후보 포인트 ${labels}를 주변 도로 흐름에 맞게 이동하거나 보조 포인트를 추가하세요.`;
    } else {
      ui.qualityAdvice.textContent = "내부 저품질 TIN은 공백 방지를 위해 유지됩니다. 인접 포인트를 재배치하거나 보조 포인트를 추가하세요.";
    }
  };
  updateUi = window.updateUi;

  window.exportData = function patchedExportData() {
    const data = {
      version: 2,
      createdAt: new Date().toISOString(),
      edgeLimit: Number(ui.edgeLimit.value),
      angleLimit: Number(ui.angleLimit.value),
      points: state.points.map(({ id, x, y, mapX, mapY }) => ({ id, x, y, mapX, mapY })),
      triangles: state.triangles
        .filter((triangle) => tinStatus(triangle).included)
        .map((triangle) => ({
          pointIds: triangle.ids,
          maxEdge: Number(triangle.maxEdge.toFixed(2)),
          minAngle: Number(triangle.minAngle.toFixed(2)),
          isBoundary: triangle.isBoundary,
          quality: tinStatus(triangle).valid ? "ok" : "warning"
        }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "tin-points.json";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };
  exportData = window.exportData;
  ui.exportBtn.addEventListener("click", (event) => {
    event.stopImmediatePropagation();
    exportData();
  }, true);

  rebuildTin();
})();
