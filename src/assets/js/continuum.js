(() => {
  const canvas = document.getElementById("continuum");
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  const anchors = [...document.querySelectorAll("[data-scene]")];
  if (!anchors.length) return;

  const labelsHost = document.getElementById("visualLabels");
  const visualMeta = document.getElementById("visualMeta");
  const veilLeft = document.getElementById("veilLeft");
  const veilRight = document.getElementById("veilRight");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");
  const header = document.getElementById("siteHeader");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const N = 88;
  const PATHS = 7;
  const NODES = 7;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let targetScroll = scrollY;
  let currentScroll = scrollY;
  let anchorY = [];
  let last = performance.now();

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => {
    t = clamp(t);
    return t * t * (3 - 2 * t);
  };
  const point = (x, y) => ({ x, y });
  const sample = (fn) => Array.from({ length: N }, (_, i) => fn(i / (N - 1), i));
  const emptyNodes = () =>
    Array.from({ length: NODES }, () => ({ x: 0.5, y: 0.5, r: 0, a: 0, fill: 0 }));
  const blank = (side) => ({
    side,
    paths: Array.from({ length: PATHS }, () =>
      Array.from({ length: N }, () => point(0.5, 0.5))
    ),
    nodes: emptyNodes(),
    alpha: [1, 0.86, 0.72, 0.58, 0.48, 0.38, 0.3],
    weight: [1.35, 1.15, 1, 1, 1, 1, 1],
  });
  const line = (x1, y1, x2, y2, wave = 0, cycles = 1) =>
    sample((t) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const s = Math.sin(t * Math.PI * 2 * cycles) * wave;
      return point(lerp(x1, x2, t) - (dy / len) * s, lerp(y1, y2, t) + (dx / len) * s);
    });
  const ellipse = (cx, cy, rx, ry, rot = 0, turns = 1) =>
    sample((t) => {
      const a = t * Math.PI * 2 * turns;
      const x = Math.cos(a) * rx;
      const y = Math.sin(a) * ry;
      return point(
        cx + x * Math.cos(rot) - y * Math.sin(rot),
        cy + x * Math.sin(rot) + y * Math.cos(rot)
      );
    });
  const polyline = (pts) =>
    sample((t) => {
      const lengths = [];
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        lengths.push(d);
        total += d;
      }
      let dist = t * total;
      for (let i = 0; i < lengths.length; i++) {
        if (dist <= lengths[i] || i === lengths.length - 1) {
          const q = lengths[i] ? dist / lengths[i] : 0;
          return point(lerp(pts[i].x, pts[i + 1].x, q), lerp(pts[i].y, pts[i + 1].y, q));
        }
        dist -= lengths[i];
      }
      return pts.at(-1);
    });
  const rect = (x, y, rw, rh, fold = 0) =>
    polyline([
      point(x - rw / 2, y - rh / 2),
      point(x + rw / 2 - fold, y - rh / 2),
      point(x + rw / 2, y - rh / 2 + fold),
      point(x + rw / 2, y + rh / 2),
      point(x - rw / 2, y + rh / 2),
      point(x - rw / 2, y - rh / 2),
    ]);
  const triangle = (cx, cy, r, rot = 0) =>
    polyline(
      [0, 1, 2, 0].map((i) => {
        const a = rot + (i * Math.PI * 2) / 3;
        return point(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      })
    );

  function stateHero(side) {
    const s = blank(side);
    s.paths[0] = polyline([
      point(0.11, 0.24),
      point(0.43, 0.19),
      point(0.49, 0.28),
      point(0.49, 0.78),
      point(0.15, 0.72),
      point(0.11, 0.24),
    ]);
    s.paths[1] = polyline([
      point(0.49, 0.28),
      point(0.55, 0.19),
      point(0.88, 0.24),
      point(0.84, 0.72),
      point(0.49, 0.78),
      point(0.49, 0.28),
    ]);
    s.paths[2] = line(0.49, 0.28, 0.49, 0.78);
    s.paths[3] = line(0.19, 0.37, 0.4, 0.34);
    s.paths[4] = line(0.58, 0.36, 0.79, 0.39);
    s.paths[5] = line(0.66, 0.7, 0.9, 0.28);
    s.paths[6] = triangle(0.91, 0.26, 0.035, -0.75);
    s.nodes[0] = { x: 0.66, y: 0.7, r: 0.015, a: 1, fill: 1 };
    return s;
  }

  function stateIntro(side) {
    const s = blank(side);
    s.paths[0] = rect(0.5, 0.49, 0.62, 0.7, 0.1);
    s.paths[1] = polyline([point(0.71, 0.14), point(0.71, 0.24), point(0.81, 0.24)]);
    s.paths[2] = line(0.27, 0.34, 0.68, 0.34);
    s.paths[3] = line(0.27, 0.45, 0.73, 0.45);
    s.paths[4] = line(0.27, 0.56, 0.61, 0.56);
    s.paths[5] = line(0.27, 0.67, 0.51, 0.67);
    s.paths[6] = line(0.69, 0.52, 0.69, 0.68);
    s.nodes[0] = { x: 0.69, y: 0.69, r: 0.011, a: 1, fill: 1 };
    return s;
  }

  function stateWriting(side) {
    const s = blank(side);
    s.paths[0] = rect(0.43, 0.45, 0.54, 0.61, 0.06);
    s.paths[1] = rect(0.51, 0.5, 0.54, 0.61, 0.06);
    s.paths[2] = rect(0.59, 0.55, 0.54, 0.61, 0.06);
    s.paths[3] = line(0.43, 0.4, 0.68, 0.4);
    s.paths[4] = line(0.43, 0.51, 0.72, 0.51);
    s.paths[5] = line(0.43, 0.62, 0.65, 0.62);
    s.paths[6] = line(0.43, 0.73, 0.58, 0.73);
    s.nodes[0] = { x: 0.36, y: 0.4, r: 0.012, a: 1, fill: 1 };
    s.nodes[1] = { x: 0.36, y: 0.51, r: 0.012, a: 1, fill: 0 };
    s.nodes[2] = { x: 0.36, y: 0.62, r: 0.012, a: 1, fill: 0 };
    return s;
  }

  function stateArticle(side, variant = 0) {
    const s = blank(side);
    const ox = (variant % 3) * 0.02;
    const oy = ((variant + 1) % 3) * 0.015;
    s.paths[0] = rect(0.5 + ox, 0.49 + oy, 0.58, 0.68, 0.08);
    s.paths[1] = polyline([
      point(0.68 + ox, 0.16 + oy),
      point(0.68 + ox, 0.26 + oy),
      point(0.78 + ox, 0.26 + oy),
    ]);
    s.paths[2] = line(0.28 + ox, 0.36 + oy, 0.7 + ox, 0.36 + oy);
    s.paths[3] = line(0.28 + ox, 0.46 + oy, 0.74 + ox, 0.46 + oy);
    s.paths[4] = line(0.28 + ox, 0.56 + oy, 0.62 + ox, 0.56 + oy);
    s.paths[5] = line(0.28 + ox, 0.66 + oy, 0.54 + ox, 0.66 + oy);
    s.paths[6] = line(0.28 + ox, 0.76 + oy, 0.48 + ox, 0.76 + oy);
    s.nodes[0] = { x: 0.34 + ox, y: 0.28 + oy, r: 0.012, a: 1, fill: 1 };
    return s;
  }

  function stateNotes(side) {
    const s = blank(side);
    s.paths[0] = rect(0.32, 0.42, 0.28, 0.42, 0.03);
    s.paths[1] = rect(0.5, 0.5, 0.28, 0.42, 0.03);
    s.paths[2] = rect(0.68, 0.58, 0.28, 0.42, 0.03);
    s.paths[3] = line(0.24, 0.34, 0.4, 0.34);
    s.paths[4] = line(0.42, 0.42, 0.58, 0.42);
    s.paths[5] = line(0.6, 0.5, 0.76, 0.5);
    s.paths[6] = ellipse(0.5, 0.22, 0.04, 0.04);
    s.nodes[0] = { x: 0.32, y: 0.28, r: 0.01, a: 1, fill: 1 };
    s.nodes[1] = { x: 0.5, y: 0.36, r: 0.01, a: 1, fill: 0 };
    s.nodes[2] = { x: 0.68, y: 0.44, r: 0.01, a: 1, fill: 0 };
    return s;
  }

  function stateAbout(side) {
    const s = blank(side);
    s.paths[0] = rect(0.5, 0.49, 0.68, 0.61, 0.04);
    s.paths[1] = ellipse(0.35, 0.43, 0.105, 0.105);
    s.paths[2] = polyline([
      point(0.22, 0.65),
      point(0.27, 0.57),
      point(0.35, 0.54),
      point(0.43, 0.57),
      point(0.48, 0.65),
    ]);
    s.paths[3] = line(0.53, 0.38, 0.76, 0.38);
    s.paths[4] = line(0.53, 0.49, 0.8, 0.49);
    s.paths[5] = line(0.53, 0.6, 0.7, 0.6);
    s.paths[6] = polyline([
      point(0.52, 0.75),
      point(0.63, 0.68),
      point(0.72, 0.73),
      point(0.84, 0.62),
    ]);
    s.nodes[0] = { x: 0.84, y: 0.62, r: 0.014, a: 1, fill: 1 };
    return s;
  }

  function stateClosing(side) {
    const s = blank(side);
    s.paths[0] = line(0.1, 0.42, 0.9, 0.42);
    s.paths[1] = polyline([
      point(0.3, 0.9),
      point(0.43, 0.42),
      point(0.57, 0.42),
      point(0.7, 0.9),
    ]);
    s.paths[2] = line(0.5, 0.84, 0.5, 0.68);
    s.paths[3] = line(0.5, 0.62, 0.5, 0.51);
    s.paths[4] = line(0.5, 0.46, 0.5, 0.35);
    s.paths[5] = polyline([point(0.66, 0.28), point(0.82, 0.28), point(0.82, 0.44)]);
    s.paths[6] = triangle(0.82, 0.47, 0.038, Math.PI / 2);
    s.nodes[0] = { x: 0.5, y: 0.42, r: 0.014, a: 1, fill: 1 };
    return s;
  }

  function makeStates() {
    let articleIndex = 0;
    return anchors.map((el) => {
      const kind = el.dataset.kind || "article";
      const side = el.dataset.side === "left" ? "left" : "right";
      switch (kind) {
        case "hero":
          return stateHero(side);
        case "intro":
          return stateIntro(side);
        case "writing":
          return stateWriting(side);
        case "notes":
          return stateNotes(side);
        case "about":
          return stateAbout(side);
        case "closing":
          return stateClosing(side);
        default:
          return stateArticle(side, articleIndex++);
      }
    });
  }

  const states = makeStates();

  anchors.forEach((el, i) => {
    const label = document.createElement("div");
    label.className = "visual-label";
    label.innerHTML = `<strong>${String(i).padStart(2, "0")} / ${el.dataset.title}</strong><span>${el.dataset.subtitle || ""}</span>`;
    labelsHost.appendChild(label);
  });
  const labelEls = [...labelsHost.children];

  function resize() {
    w = Math.max(1, innerWidth);
    h = Math.max(1, innerHeight);
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    measure();
  }

  function measure() {
    anchorY = anchors.map((el) => el.offsetTop + el.offsetHeight * 0.5 - innerHeight * 0.5);
    for (let i = 1; i < anchorY.length; i++) {
      if (anchorY[i] <= anchorY[i - 1]) anchorY[i] = anchorY[i - 1] + 1;
    }
  }

  function segmentAt(y) {
    if (y <= anchorY[0]) return { i: 0, j: 0, t: 0 };
    const lastIndex = anchorY.length - 1;
    if (y >= anchorY[lastIndex]) return { i: lastIndex, j: lastIndex, t: 0 };
    for (let i = 0; i < lastIndex; i++) {
      if (y >= anchorY[i] && y <= anchorY[i + 1]) {
        return {
          i,
          j: i + 1,
          t: smooth((y - anchorY[i]) / (anchorY[i + 1] - anchorY[i])),
        };
      }
    }
    return { i: 0, j: 0, t: 0 };
  }

  function sideValue(side) {
    return side === "right" ? 1 : 0;
  }

  function mapPoint(state, p) {
    if (w < 980) return point(0.12 + p.x * 0.76, 0.06 + p.y * 0.42);
    const start = state.side === "right" ? 0.57 : 0.05;
    return point(start + p.x * 0.38, 0.17 + p.y * 0.66);
  }

  function mappedCenter(state) {
    return w < 980
      ? point(0.5, 0.27)
      : point(state.side === "right" ? 0.76 : 0.24, 0.5);
  }

  function morphPoint(a, b, t, pa, pb) {
    const A = mapPoint(a, pa);
    const B = mapPoint(b, pb);
    let x = lerp(A.x, B.x, t);
    let y = lerp(A.y, B.y, t);
    if (w >= 980 && a.side !== b.side && a !== b) {
      const arc = Math.sin(Math.PI * t);
      const ca = mappedCenter(a);
      const cb = mappedCenter(b);
      const cx = lerp(ca.x, cb.x, t);
      const cy = lerp(ca.y, cb.y, t) - arc * 0.2;
      const shrink = 1 - arc * 0.48;
      x = cx + (x - lerp(ca.x, cb.x, t)) * shrink;
      y = cy + (y - lerp(ca.y, cb.y, t)) * shrink;
    }
    return point(x, y);
  }

  function inkColor() {
    return getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "#11110f";
  }

  function drawPath(a, b, t, index, phase) {
    ctx.save();
    ctx.beginPath();
    for (let k = 0; k < N; k++) {
      const q = morphPoint(a, b, t, a.paths[index][k], b.paths[index][k]);
      const breathe = Math.sin(phase + k * 0.06 + index) * 0.0012;
      const px = (q.x + breathe) * w;
      const py = (q.y + breathe * 0.5) * h;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    const changingSide = a.side !== b.side && a !== b;
    const transitionFade = changingSide ? 1 - Math.sin(Math.PI * t) * 0.22 : 1;
    ctx.strokeStyle = inkColor();
    ctx.globalAlpha = lerp(a.alpha[index], b.alpha[index], t) * transitionFade;
    ctx.lineWidth = lerp(a.weight[index], b.weight[index], t);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  function drawNode(a, b, t, index, phase) {
    const na = a.nodes[index];
    const nb = b.nodes[index];
    const q = morphPoint(a, b, t, na, nb);
    const changingSide = a.side !== b.side && a !== b;
    const shrink = changingSide ? 1 - Math.sin(Math.PI * t) * 0.48 : 1;
    const r = Math.max(
      0,
      lerp(na.r, nb.r, t) * Math.min(w, h) * shrink * (1 + Math.sin(phase + index) * 0.018)
    );
    const alpha = lerp(na.a, nb.a, t);
    const fill = lerp(na.fill, nb.fill, t);
    if (r < 0.2 || alpha < 0.01) return;
    const ink = inkColor();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = ink;
    ctx.beginPath();
    ctx.arc(q.x * w, q.y * h, r, 0, Math.PI * 2);
    if (fill > 0.5) {
      ctx.fillStyle = ink;
      ctx.fill();
    } else ctx.stroke();
    ctx.restore();
  }

  function drawGrid(y) {
    const p = clamp(y / Math.max(1, document.documentElement.scrollHeight - innerHeight));
    ctx.save();
    ctx.strokeStyle = inkColor();
    ctx.globalAlpha = 0.026;
    ctx.lineWidth = 1;
    const spacing = w < 980 ? 64 : 82;
    const ox = (p * spacing * 1.5) % spacing;
    const oy = (p * spacing * 0.65) % spacing;
    for (let x = -spacing + ox; x < w + spacing; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let yy = -spacing + oy; yy < h + spacing; yy += spacing) {
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
    }
    ctx.restore();
  }

  function updateLayout(seg) {
    if (w < 980) {
      visualMeta.style.left = "17px";
      veilLeft.style.opacity = "1";
      veilRight.style.opacity = "1";
      return;
    }
    const side = lerp(sideValue(states[seg.i].side), sideValue(states[seg.j].side), seg.t);
    const pageWidth =
      document.querySelector(".page")?.getBoundingClientRect().width ||
      Math.min(1520, w - 96);
    const pageMargin = Math.max(36, (w - pageWidth) / 2);
    const metaWidth = Math.min(340, w * 0.27);
    const leftPos = pageMargin;
    const rightPos = w - pageMargin - metaWidth;
    visualMeta.style.left = `${lerp(leftPos, rightPos, side)}px`;
    veilLeft.style.opacity = side.toFixed(3);
    veilRight.style.opacity = (1 - side).toFixed(3);
  }

  function draw(y, now) {
    ctx.clearRect(0, 0, w, h);
    drawGrid(y);
    const seg = segmentAt(y);
    const a = states[seg.i];
    const b = states[seg.j];
    const phase = now * 0.00018;
    for (let p = 0; p < PATHS; p++) drawPath(a, b, seg.t, p, phase);
    for (let n = 0; n < NODES; n++) drawNode(a, b, seg.t, n, phase);
    updateLayout(seg);

    labelEls.forEach((el, index) => {
      let opacity = 0;
      let move = 10;
      if (seg.i === seg.j && index === seg.i) {
        opacity = 1;
        move = 0;
      } else if (index === seg.i) {
        opacity = 1 - seg.t;
        move = -seg.t * 10;
      } else if (index === seg.j) {
        opacity = seg.t;
        move = (1 - seg.t) * 10;
      }
      el.style.opacity = opacity.toFixed(4);
      el.style.transform = `translate3d(0,${move}px,0)`;
    });
    const total = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const gp = clamp(y / total);
    progressBar.style.width = `${(gp * 100).toFixed(2)}%`;
    progressText.textContent = String(Math.round(gp * 100)).padStart(3, "0");
  }

  function frame(now) {
    const dt = Math.min(34, now - last);
    last = now;
    const factor = reduced ? 1 : 1 - Math.pow(0.00055, dt / 1000);
    currentScroll += (targetScroll - currentScroll) * factor;
    if (Math.abs(targetScroll - currentScroll) < 0.02) currentScroll = targetScroll;
    draw(currentScroll, now);
    requestAnimationFrame(frame);
  }

  addEventListener(
    "scroll",
    () => {
      targetScroll = scrollY;
      header?.classList.toggle("is-scrolled", scrollY > 8);
    },
    { passive: true }
  );
  addEventListener("resize", resize, { passive: true });
  addEventListener("load", measure, { once: true });
  resize();
  header?.classList.toggle("is-scrolled", scrollY > 8);
  requestAnimationFrame(frame);

  const observer = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          observer.unobserve(entry.target);
        }
      }),
    { threshold: 0.12 }
  );
  document.querySelectorAll("[data-reveal]").forEach((el) => observer.observe(el));
})();
