function warpPoint(x, y, width, height) {
  const nx = x / Math.max(width, 1);
  const ny = y / Math.max(height, 1);

  const phaseX = Math.sin(ny * Math.PI * 3.2) * 1.45 + ny * 2.1;
  const phaseY = Math.cos(nx * Math.PI * 2.9) * 1.45 + nx * 1.9;

  const dx =
    Math.sin(nx * Math.PI * 3.0 + phaseX) * 34 +
    Math.cos(ny * Math.PI * 2.2 - nx * 2.4) * 20;

  const dy =
    Math.sin(ny * Math.PI * 2.8 + phaseY) * 32 +
    Math.cos(nx * Math.PI * 2.1 - ny * 2.2) * 18;

  return { x: x + dx, y: y + dy };
}

function buildSmoothPath(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) * 0.5;
    const midY = (points[i].y + points[i + 1].y) * 0.5;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
}

function drawContinuousLine(ctx, points, baseColor, pulses = null) {
  if (points.length < 2) return;

  ctx.save();
  buildSmoothPath(ctx, points);
  ctx.strokeStyle = baseColor;
  ctx.lineWidth = 1.15;
  ctx.stroke();

  if (pulses && pulses.length > 0) {
    let minX = points[0].x;
    let maxX = points[0].x;
    let avgY = points[0].y;
    for (let i = 1; i < points.length; i++) {
      if (points[i].x < minX) minX = points[i].x;
      if (points[i].x > maxX) maxX = points[i].x;
      avgY += points[i].y;
    }
    avgY /= points.length;

    const grad = ctx.createLinearGradient(minX, avgY, maxX, avgY);

    // Ordena os pulsos da esquerda para a direita para montar os stops sem sobreposição
    const sorted = [...pulses].sort((a, b) => a.center - b.center);
    grad.addColorStop(0, "rgba(167, 139, 250, 0)");

    let maxIntensity = 0;
    for (const p of sorted) {
      const intensity = p.intensity ?? 1;
      if (intensity > maxIntensity) maxIntensity = intensity;

      const spread = Math.max(0.02, p.spread);
      const start = Math.max(0.01, p.center - spread);
      const end = Math.min(0.99, p.center + spread);
      const innerStart = Math.max(start, p.center - spread * 0.45);
      const innerEnd = Math.min(end, p.center + spread * 0.45);

      const edgeAlpha = (0.42 * intensity).toFixed(3);
      const coreAlpha = (0.9 * intensity).toFixed(3);

      grad.addColorStop(start, "rgba(167, 139, 250, 0)");
      grad.addColorStop(innerStart, `rgba(245, 158, 11, ${edgeAlpha})`);
      grad.addColorStop(p.center, `rgba(253, 224, 71, ${coreAlpha})`);
      grad.addColorStop(innerEnd, `rgba(245, 158, 11, ${edgeAlpha})`);
      grad.addColorStop(end, "rgba(167, 139, 250, 0)");
    }

    grad.addColorStop(1, "rgba(167, 139, 250, 0)");

    buildSmoothPath(ctx, points);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.2 + 0.65 * maxIntensity;
    ctx.shadowColor = `rgba(250, 204, 21, ${(0.42 * maxIntensity).toFixed(3)})`;
    ctx.shadowBlur = 9 * maxIntensity;
    ctx.stroke();
  }

  ctx.restore();
}

function addClusterToMap(map, totalCount, centerIdx, size, baseCenter, baseSpread) {
  const halfSpan = (size - 1) / 2;
  for (let offset = -Math.floor(halfSpan); offset <= Math.ceil(halfSpan); offset++) {
    const idx = centerIdx + offset;
    if (idx < 0 || idx >= totalCount) continue;

    const distNorm =
      halfSpan > 0
        ? Math.abs(offset - (size % 2 === 0 ? 0.5 : 0)) / (halfSpan + 0.15)
        : 0;
    const falloff = Math.max(0.28, 1 - distNorm * 0.66);

    const list = map.get(idx) || [];
    list.push({
      center: baseCenter,
      spread: baseSpread * falloff,
      intensity: 0.42 + 0.58 * falloff,
    });
    map.set(idx, list);
  }
}

function buildHighlightMap(totalCount, seedOffset = 0) {
  const map = new Map();
  if (totalCount < 6) return map;

  const groupSizes = [3, 4, 5, 3, 4];
  const gapBetweenGroups = 1; // Reduzido para aumentar a frequência vertical dos grupos

  let cursor = 1;
  let groupIndex = 0;

  while (cursor + 2 < totalCount) {
    const size = groupSizes[(groupIndex + Math.round(seedOffset * 10)) % groupSizes.length];
    const halfSpan = (size - 1) / 2;
    const centerIdx = Math.min(totalCount - 2, cursor + Math.floor(halfSpan));

    const phase = ((groupIndex * 0.33 + seedOffset) % 1 + 1) % 1;
    const baseSpread = 0.058;

    // Grupo principal na metade esquerda/central da tela
    const leftCenter = 0.16 + phase * 0.28;
    addClusterToMap(map, totalCount, centerIdx, size, leftCenter, baseSpread);

    // Segundo grupo na mesma faixa horizontal (metade direita), alternando o tamanho
    const secondSize = groupSizes[(groupIndex + 2) % groupSizes.length];
    const rightCenter = 0.58 + ((1 - phase) * 0.28);
    // Desloca 0 ou 1 linha para não ficarem rigidamente espelhados
    const rightCenterIdx = Math.min(totalCount - 2, centerIdx + (groupIndex % 2));
    addClusterToMap(map, totalCount, rightCenterIdx, secondSize, rightCenter, baseSpread);

    cursor += size + gapBetweenGroups;
    groupIndex++;
  }

  return map;
}

export function renderHomeWarpGrid() {
  const canvas = document.getElementById("homeWarpCanvas");
  const emptyState = document.getElementById("emptyState");
  if (!canvas || !emptyState || emptyState.classList.contains("hidden")) {
    if (canvas) canvas.classList.add("hidden");
    return;
  }

  canvas.classList.remove("hidden");

  const width = Math.max(1, Math.round(emptyState.clientWidth));
  const height = Math.max(1, Math.round(emptyState.scrollHeight));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const spacing = width < 640 ? 66 : width < 1100 ? 48 : 38;
  const step = Math.max(18, Math.round(spacing * 0.55));
  const margin = spacing * 2;

  const cols = [];
  for (let gx = -margin; gx <= width + margin; gx += spacing) {
    cols.push(gx);
  }

  const rows = [];
  for (let gy = -margin; gy <= height + margin; gy += spacing) {
    rows.push(gy);
  }

  const rowHighlights = buildHighlightMap(rows.length, 0.27);

  cols.forEach((gx) => {
    const pts = [];
    for (let gy = -margin; gy <= height + margin; gy += step) {
      pts.push(warpPoint(gx, gy, width, height));
    }
    drawContinuousLine(ctx, pts, "rgba(167, 139, 250, 0.16)", null);
  });

  rows.forEach((gy, idx) => {
    const pts = [];
    for (let gx = -margin; gx <= width + margin; gx += step) {
      pts.push(warpPoint(gx, gy, width, height));
    }
    drawContinuousLine(ctx, pts, "rgba(196, 181, 253, 0.13)", rowHighlights.get(idx) || null);
  });
}

let resizeTimer = null;
export function initHomeWarpGrid() {
  renderHomeWarpGrid();

  const emptyState = document.getElementById("emptyState");
  if (emptyState && "ResizeObserver" in window) {
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderHomeWarpGrid, 60);
    });
    ro.observe(emptyState);
  }

  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderHomeWarpGrid, 80);
  });
}