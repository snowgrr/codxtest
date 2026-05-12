(function () {
  if (typeof ol === "undefined" || typeof vworldKey !== "function") return;

  mapSource = function (type) {
    const key = vworldKey();
    const satellite = type === "satellite";
    if (!key) {
      return satellite
        ? new ol.source.XYZ({ maxZoom: MAXZ, url: "" })
        : new ol.source.OSM({ crossOrigin: "anonymous", maxZoom: MAXZ });
    }

    return new ol.source.XYZ({
      maxZoom: MAXZ,
      url: `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(key)}/${satellite ? "Satellite" : "Base"}/{z}/{y}/{x}.${satellite ? "jpeg" : "png"}`
    });
  };

  refreshMapSources = function () {
    saveVworldKey();
    if (baseLayer) baseLayer.setSource(mapSource("base"));
    if (satLayer) satLayer.setSource(mapSource("satellite"));
    render();
  };

  if (vworldKey()) refreshMapSources();
})();
