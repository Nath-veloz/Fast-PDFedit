function warpPoint(x, y, width, height, warpScale = 1) {
  const nx = x / Math.max(width, 1);
  const ny = y / Math.max(height, 1);

  const freqScale = width < 640 ? 0.78 : 1;
  const phaseX = Math.sin(ny * Math.PI * 3.2 * freqScale) * (1.45 * freqScale) + ny * 2.1;
  const phaseY = Math.cos(nx * Math.PI * 2.9 * freqScale) * (1.45 * freqScale) + nx * 1.9;

  // Ondulação mais longa e suave em telas pequenas para evitar curvas apertadas
  const dx =
    (Math.sin(nx * Math.PI * 3.0 * freqScale + phaseX) * 34 +
      Math.cos(ny * Math.PI * 2.2 * freqScale - nx * 2.4 * freqScale) * 20) *
    warpScale;

  const dy =
    (Math.sin(ny * Math.PI * 2.8 * freqScale + phaseY) * 32 +
      Math.cos(nx * Math.PI * 2.1 * freqScale - ny * 2.2 * freqScale) * 18) *
    warpScale;

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

    if (maxX - minX < 2) {
      ctx.restore();
      return;
    }

    const grad = ctx.createLinearGradient(minX, avgY, maxX, avgY);

    const sorted = [...pulses].sort((a, b) => a.center - b.center);
    grad.addColorStop(0, "rgba(167, 139, 250, 0)");

    let maxIntensity = 0;
    let cursorStop = 0.01;

    for (const p of sorted) {
      const intensity = p.intensity ?? 1;
      if (intensity > maxIntensity) maxIntensity = intensity;

      const spread = Math.max(0.02, p.spread);
      const start = Math.max(cursorStop, Math.min(0.97, p.center - spread));
      const end = Math.max(start + 0.01, Math.min(0.99, p.center + spread));
      const center = Math.max(start + 0.004, Math.min(end - 0.004, p.center));
      const innerStart = Math.max(start, Math.min(center - 0.002, center - spread * 0.45));
      const innerEnd = Math.min(end, Math.max(center + 0.002, center + spread * 0.45));

      const edgeAlpha = Math.min(1, 0.42 * intensity).toFixed(3);
      const coreAlpha = Math.min(1, 0.9 * intensity).toFixed(3);

      grad.addColorStop(start, "rgba(167, 139, 250, 0)");
      grad.addColorStop(innerStart, `rgba(245, 158, 11, ${edgeAlpha})`);
      grad.addColorStop(center, `rgba(253, 224, 71, ${coreAlpha})`);
      grad.addColorStop(innerEnd, `rgba(245, 158, 11, ${edgeAlpha})`);
      grad.addColorStop(end, "rgba(167, 139, 250, 0)");

      cursorStop = end;
    }

    grad.addColorStop(1, "rgba(167, 139, 250, 0)");

    buildSmoothPath(ctx, points);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.2 + 0.65 * maxIntensity;
    ctx.shadowColor = `rgba(250, 204, 21, ${Math.min(1, 0.42 * maxIntensity).toFixed(3)})`;
    ctx.shadowBlur = 9 * maxIntensity;
    ctx.stroke();
  }

  ctx.restore();
}

function addClusterToMap(
  map,
  totalCount,
  centerIdx,
  size,
  baseCenter,
  baseSpread,
  intensityBoost = 1
) {
  const halfSpan = (size - 1) / 2;
  for (let offset = -Math.floor(halfSpan); offset <= Math.ceil(halfSpan); offset++) {
    const idx = centerIdx + offset;
    if (idx < 0 || idx >= totalCount) continue;

    const distNorm =
      halfSpan > 0
        ? Math.abs(offset - (size % 2 === 0 ? 0.5 : 0)) / (halfSpan + 0.15)
        : 0;
    const falloff = Math.max(0.32, 1 - distNorm * 0.62);

    const list = map.get(idx) || [];
    list.push({
      center: baseCenter,
      spread: baseSpread * falloff,
      intensity: Math.min(1.25, (0.44 + 0.56 * falloff) * intensityBoost),
    });
    map.set(idx, list);
  }
}

function buildHighlightMap(totalCount, width, seedOffset = 0) {
  const map = new Map();
  if (totalCount < 6) return map;

  const groupSizes = [3, 4, 5, 3, 4];
  const gapBetweenGroups = 1;
  const allowDualHorizontal = width >= 640;
  const isCompact = width < 640;
  const intensityBoost = isCompact ? 1.15 : 1;

  let cursor = 1;
  let groupIndex = 0;

  while (cursor + 2 < totalCount) {
    const size = groupSizes[(groupIndex + Math.round(seedOffset * 10)) % groupSizes.length];
    const halfSpan = (size - 1) / 2;
    const centerIdx = Math.min(totalCount - 2, cursor + Math.floor(halfSpan));

    const phase = (((groupIndex * 0.33 + seedOffset) % 1) + 1) % 1;
    const baseSpread = allowDualHorizontal ? 0.058 : 0.088;

    if (allowDualHorizontal) {
      const leftCenter = 0.16 + phase * 0.28;
      addClusterToMap(
        map,
        totalCount,
        centerIdx,
        size,
        leftCenter,
        baseSpread,
        intensityBoost
      );

      const secondSize = groupSizes[(groupIndex + 2) % groupSizes.length];
      const rightCenter = 0.58 + (1 - phase) * 0.28;
      const rightCenterIdx = Math.min(totalCount - 2, centerIdx + (groupIndex % 2));
      addClusterToMap(
        map,
        totalCount,
        rightCenterIdx,
        secondSize,
        rightCenter,
        baseSpread,
        intensityBoost
      );
    } else {
      const singleCenter = 0.22 + phase * 0.56;
      addClusterToMap(
        map,
        totalCount,
        centerIdx,
        size,
        singleCenter,
        baseSpread,
        intensityBoost
      );
    }

    cursor += size + gapBetweenGroups;
    groupIndex++;
  }

  return map;
}

function computeSpacing(width) {
  if (width >= 1100) return 38;
  if (width >= 640) {
    // 38px em 1100px -> 46px em 640px
    return Math.round(46 - ((width - 640) / (1100 - 640)) * 8);
  }
  // 46px em 640px -> 54px em 320px
  const ratio = Math.max(0, Math.min(1, (width - 320) / (640 - 320)));
  return Math.round(54 - ratio * 8);
}

function computeWarpScale(width) {
  if (width >= 1100) return 1;
  if (width >= 640) {
    // Transição gradual de tablet para desktop
    return 0.48 + ((width - 640) / (1100 - 640)) * 0.52;
  }
  // Suavização ampliada em telas pequenas (< 640px)
  const ratio = Math.max(0, Math.min(1, (width - 320) / (640 - 320)));
  return 0.34 + ratio * 0.20;
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

  const spacing = computeSpacing(width);
  const step = Math.max(16, Math.min(24, Math.round(spacing * 0.45)));
  const margin = Math.max(spacing * 2.5, 96);
  const warpScale = computeWarpScale(width);

  const cols = [];
  for (let gx = -margin; gx <= width + margin; gx += spacing) {
    cols.push(gx);
  }

  const rows = [];
  for (let gy = -margin; gy <= height + margin; gy += spacing) {
    rows.push(gy);
  }

  const rowHighlights = buildHighlightMap(rows.length, width, 0.27);

  cols.forEach((gx) => {
    const pts = [];
    for (let gy = -margin; gy <= height + margin; gy += step) {
      pts.push(warpPoint(gx, gy, width, height, warpScale));
    }
    drawContinuousLine(ctx, pts, "rgba(167, 139, 250, 0.16)", null);
  });

  rows.forEach((gy, idx) => {
    const pts = [];
    for (let gx = -margin; gx <= width + margin; gx += step) {
      pts.push(warpPoint(gx, gy, width, height, warpScale));
    }
    drawContinuousLine(ctx, pts, "rgba(196, 181, 253, 0.13)", rowHighlights.get(idx) || null);
  });
}

let resizeTimer = null;
let rafId = null;

function scheduleGridRender(delay = 70) {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      renderHomeWarpGrid();
    });
  }, delay);
}

export function initHomeWarpGrid() {
  renderHomeWarpGrid();

  const emptyState = document.getElementById("emptyState");
  if (emptyState && "ResizeObserver" in window) {
    const ro = new ResizeObserver(() => scheduleGridRender(60));
    ro.observe(emptyState);
  }

  window.addEventListener("resize", () => scheduleGridRender(80));
  window.addEventListener("orientationchange", () => scheduleGridRender(120));
}