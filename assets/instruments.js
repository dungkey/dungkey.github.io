/**
 * 精密光学与机械仪器交互层 (Precision Optical & Mechanical Instruments)
 * 包含：
 * 1. WebGL2 双色棱镜主题切换器（折射、色差、磨砂、环绕光带、像素矩阵形态插值）
 * 2. 精密机械-光学天文钟（60分度游标环、亚秒扫描弧、日进度弧）
 * 3. 声学示波器与游标寻道预览（Web Audio FFT + 驻波回退 + 悬停时间标尺）
 * 4. 搜索光学准星与匹配率仪表盘
 * 5. 卡片 3D 微倾角、镜面高光与角标对准系统
 */
(() => {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isCoarsePointer = window.matchMedia('(pointer: coarse)');

  function getThemeLightFactor() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 1.0 : 0.0;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  /* ============================================================================
     1. WebGL2 双色棱镜主题切换器 (Optical Dichroic Prism Theme Toggle)
     ============================================================================ */
  function initThemePrismGL() {
    const wrap = document.querySelector('.theme-toggle-wrap');
    if (!wrap) return;

    const btns = Array.from(wrap.querySelectorAll('[data-set-theme]'));
    if (btns.length < 3) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'theme-prism-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    wrap.insertBefore(canvas, wrap.firstChild);

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance'
    });
    if (!gl) return;

    wrap.classList.add('has-prism-gl');

    const VERT = `#version 300 es
      in vec2 a_pos;
      out vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    const FRAG = `#version 300 es
      precision highp float;

      in vec2 v_uv;
      out vec4 fragColor;

      uniform vec2 u_res;
      uniform float u_time;
      uniform float u_pos;      // 0.0 (dark) -> 0.5 (light) -> 1.0 (auto)
      uniform float u_vel;      // 弹簧速度，用于动态拉伸与色散增强
      uniform float u_light;    // 0.0 = dark theme, 1.0 = light theme
      uniform float u_hover;    // 0.0 ~ 1.0

      float sdRoundBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }

      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      // 采样底层轨道（精细拉丝纹理 + 槽位分割刻度）
      vec3 sampleUnderlay(vec2 uv, float light, vec2 aspect) {
        float brush = (hash12(vec2(floor(uv.x * u_res.x * 0.5), floor(uv.y * u_res.y))) - 0.5) * 0.018;
        vec3 trackDark = vec3(0.068, 0.076, 0.098) + brush;
        vec3 trackLight = vec3(0.915, 0.925, 0.948) + brush * 0.6;
        vec3 base = mix(trackDark, trackLight, light);

        // 槽位之间（1/3 与 2/3 处）的微弱垂直分割刻度线，避开按钮文字与图标
        float yMask = smoothstep(0.24, 0.34, uv.y) * smoothstep(0.76, 0.66, uv.y);
        for (int i = 1; i <= 2; i++) {
          float tx = float(i) / 3.0;
          float dx = abs(uv.x - tx) * aspect.x;
          float tick = smoothstep(0.012, 0.002, dx) * yMask;
          base = mix(base, mix(vec3(0.20, 0.23, 0.29), vec3(0.76, 0.79, 0.84), light), tick * 0.55);
        }

        return base;
      }

      void main() {
        vec2 aspect = vec2(u_res.x / max(u_res.y, 1.0), 1.0);
        vec2 p = (v_uv - 0.5) * aspect;

        // 旋钮中心在 X 轴上从左槽 (1/6) 到右槽 (5/6)
        float centerX = mix(1.0 / 6.0, 5.0 / 6.0, u_pos);
        vec2 knobCenterUv = vec2(centerX, 0.5);
        vec2 knobCenter = (knobCenterUv - 0.5) * aspect;

        // 速度带来的轻微水平拉伸
        float stretch = 1.0 + min(abs(u_vel) * 0.035, 0.08);
        vec2 knobHalf = vec2((aspect.x / 6.0) * 0.91 * stretch, 0.42);
        float radius = 0.36;

        float d = sdRoundBox(p - knobCenter, knobHalf, radius);

        // 计算 SDF 梯度作为斜面法线
        vec2 eps = vec2(0.002, 0.0);
        vec2 grad = normalize(vec2(
          sdRoundBox(p - knobCenter + eps.xy, knobHalf, radius) - sdRoundBox(p - knobCenter - eps.xy, knobHalf, radius),
          sdRoundBox(p - knobCenter + eps.yx, knobHalf, radius) - sdRoundBox(p - knobCenter - eps.yx, knobHalf, radius)
        ) + 1e-5);

        // 环绕玻璃的动态光带
        float orbitAngle = mix(-1.5708, 1.5708, clamp(u_pos * 1.2, 0.0, 1.0)) + sin(u_time * 0.7) * 0.08;
        vec2 lightDir = vec2(cos(orbitAngle), sin(orbitAngle));
        float band = pow(max(dot(grad, lightDir), 0.0), 2.5);

        // 光带色调：暗色琥珀暖光 / 浅色陶土与天空冷光过渡
        vec3 glowWarm = mix(vec3(0.96, 0.62, 0.12), vec3(0.76, 0.25, 0.05), u_light);
        vec3 glowCool = mix(vec3(0.38, 0.72, 1.00), vec3(0.24, 0.50, 0.86), u_light);
        vec3 bandCol = mix(glowWarm, glowCool, smoothstep(0.35, 0.90, u_pos));

        // 轨道漫射光晕
        float trackGlow = exp(-max(d, 0.0) * 14.0) * (0.28 + 0.62 * band) * (0.78 + 0.22 * u_hover);

        // 玻璃内部折射 + 色差 (Chromatic Aberration)
        float bevel = smoothstep(-0.14, 0.0, d) * step(d, 0.006);
        float refractStrength = (0.014 + abs(u_vel) * 0.007) * (0.25 + 0.75 * bevel);
        vec2 uvR = v_uv - grad * refractStrength * 1.25;
        vec2 uvG = v_uv - grad * refractStrength * 1.00;
        vec2 uvB = v_uv - grad * refractStrength * 0.75;

        vec2 blurOff = vec2(0.003, 0.003);
        vec3 underR = sampleUnderlay(uvR, u_light, aspect);
        vec3 underG = sampleUnderlay(uvG, u_light, aspect);
        vec3 underB = sampleUnderlay(uvB, u_light, aspect);
        vec3 underBlur = sampleUnderlay(uvG + blurOff, u_light, aspect);

        vec3 glassSample = vec3(underR.r, underG.g, underB.b) * 0.75 + underBlur * 0.25;
        vec3 pillTint = mix(vec3(0.145, 0.165, 0.208), vec3(0.992, 0.994, 0.998), u_light);
        vec3 glassInner = mix(glassSample, pillTint, mix(0.62, 0.78, u_light));

        // 玻璃表面菲涅尔高光与边缘色散
        float fresnel = pow(bevel, 1.8);
        glassInner += bandCol * (0.06 + 0.26 * fresnel) * (0.35 + 0.65 * band);
        glassInner += vec3(1.0) * fresnel * mix(0.16, 0.28, u_light);

        // 边缘精细描边
        float rim = smoothstep(0.020, 0.002, abs(d));
        vec3 rimCol = mix(bandCol, vec3(1.0), 0.35);

        // 外部轨道颜色
        vec3 outerCol = sampleUnderlay(v_uv, u_light, aspect);
        outerCol += bandCol * trackGlow * mix(0.45, 0.26, u_light);

        // 混合玻璃与外部轨道
        float inside = smoothstep(0.006, -0.006, d);
        vec3 finalCol = mix(outerCol, glassInner, inside);
        finalCol = mix(finalCol, rimCol, rim * mix(0.42, 0.30, u_light));

        // 玻璃外缘微弱阴影
        float shadow = smoothstep(0.05, 0.0, d) * (1.0 - inside) * mix(0.28, 0.12, u_light);
        finalCol *= (1.0 - shadow);

        fragColor = vec4(clamp(finalCol, 0.0, 1.0), 1.0);
      }
    `;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s);
        return null;
      }
      return s;
    }

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const locPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uPos = gl.getUniformLocation(prog, 'u_pos');
    const uVel = gl.getUniformLocation(prog, 'u_vel');
    const uLight = gl.getUniformLocation(prog, 'u_light');
    const uHover = gl.getUniformLocation(prog, 'u_hover');

    const modeToPos = { dark: 0.0, light: 0.5, auto: 1.0 };
    const posToMode = ['dark', 'light', 'auto'];

    function getCurrentTarget() {
      const m = document.documentElement.getAttribute('data-theme-mode') || 'auto';
      return modeToPos[m] ?? 1.0;
    }

    let pos = getCurrentTarget();
    let targetPos = pos;
    let vel = 0;
    let lightVal = getThemeLightFactor();
    let hoverVal = 0;
    let isHovering = false;
    let isDragging = false;
    let dragStartX = 0;
    let hasDragged = false;
    let ignoreNativeClick = false;
    let rafId = 0;
    let contextLost = false;

    function resize() {
      if (contextLost) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = wrap.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
    }

    resize();
    window.addEventListener('resize', resize, { passive: true });

    wrap.addEventListener('pointerenter', () => { isHovering = true; });
    wrap.addEventListener('pointerleave', () => { isHovering = false; });

    wrap.addEventListener('click', (e) => {
      if (ignoreNativeClick) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      hasDragged = false;
      dragStartX = e.clientX;
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!isDragging) return;
      if (!hasDragged && Math.abs(e.clientX - dragStartX) > 6) {
        hasDragged = true;
        try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
      }
      if (!hasDragged) return;
      const rect = wrap.getBoundingClientRect();
      const rel = clamp((e.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      // 映射到 [0, 1] 槽位
      targetPos = clamp((rel - 1 / 6) / (4 / 6), 0, 1);
    });

    function finishDrag(e) {
      if (!isDragging) return;
      isDragging = false;
      try {
        if (e && typeof e.pointerId === 'number') {
          wrap.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}
      if (hasDragged) {
        hasDragged = false;
        const idx = Math.round(targetPos * 2);
        const mode = posToMode[clamp(idx, 0, 2)];
        const btn = btns.find(b => b.dataset.setTheme === mode);
        if (btn) {
          btn.click();
          ignoreNativeClick = true;
          setTimeout(() => { ignoreNativeClick = false; }, 0);
        }
      }
    }

    wrap.addEventListener('pointerup', finishDrag);
    wrap.addEventListener('pointercancel', () => {
      isDragging = false;
      hasDragged = false;
    });
    wrap.addEventListener('lostpointercapture', () => {
      isDragging = false;
      hasDragged = false;
    });

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      contextLost = true;
      wrap.classList.remove('has-prism-gl');
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    });

    function drawFrame(now, immediate) {
      if (contextLost) return;
      const dt = Math.min(Math.max((now - lastT) / 1000, 0), 0.05);
      lastT = now;

      if (!isDragging) {
        targetPos = getCurrentTarget();
      }

      if (immediate || prefersReducedMotion.matches) {
        pos = targetPos;
        vel = 0;
      } else {
        const stiffness = isDragging ? 260 : 180;
        const damping = isDragging ? 24 : 18;
        const force = (targetPos - pos) * stiffness;
        vel = (vel + force * dt) * Math.exp(-damping * dt);
        pos = clamp(pos + vel * dt, -0.05, 1.05);
      }

      lightVal = immediate ? getThemeLightFactor() : lerp(lightVal, getThemeLightFactor(), 0.14);
      hoverVal = lerp(hoverVal, isHovering ? 1.0 : 0.0, 0.15);

      gl.useProgram(prog);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, now * 0.001);
      gl.uniform1f(uPos, pos);
      gl.uniform1f(uVel, vel);
      gl.uniform1f(uLight, lightVal);
      gl.uniform1f(uHover, hoverVal);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 监听外部主题切换（如按钮点击或系统配色变化）
    const observer = new MutationObserver(() => {
      if (!isDragging) {
        targetPos = getCurrentTarget();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme-mode', 'data-theme']
    });

    window.addEventListener('workbench:themechange', () => {
      lightVal = getThemeLightFactor();
      targetPos = getCurrentTarget();
      pos = targetPos;
      vel = 0;
      drawFrame(performance.now(), true);
    });

    let lastT = performance.now();
    function tick(now) {
      if (document.hidden || contextLost) {
        rafId = 0;
        return;
      }
      drawFrame(now, false);
      rafId = requestAnimationFrame(tick);
    }

    function startLoop() {
      if (!document.hidden && !contextLost && !rafId) {
        lastT = performance.now();
        rafId = requestAnimationFrame(tick);
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else {
        startLoop();
      }
    });

    drawFrame(performance.now(), true);
    startLoop();
  }

  /* ============================================================================
     2. 精密机械-光学天文钟 (Precision Chronometer Dial)
     ============================================================================ */
  function initChronometer() {
    const section = document.querySelector('.clock-section');
    if (!section) return;

    const canvas = document.createElement('canvas');
    canvas.className = 'chrono-dial-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    section.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const size = 56;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    function drawFrame() {
      const now = new Date();
      const ms = now.getMilliseconds();
      const sec = now.getSeconds() + ms / 1000;
      const dayProgress = (now.getHours() * 3600 + now.getMinutes() * 60 + sec) / 86400;
      const isLight = getThemeLightFactor() > 0.5;

      const w = 56;
      const h = 56;
      const cx = w / 2;
      const cy = h / 2;
      const r = 22;

      ctx.clearRect(0, 0, w, h);

      // 60 分度游标刻度
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
        const isMajor = i % 5 === 0;
        const r1 = isMajor ? r - 4 : r - 2;
        const r2 = r;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        ctx.strokeStyle = isLight
          ? (isMajor ? 'rgba(15,23,42,0.45)' : 'rgba(15,23,42,0.16)')
          : (isMajor ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.15)');
        ctx.lineWidth = isMajor ? 1.2 : 0.8;
        ctx.stroke();
      }

      // 日进度内弧
      ctx.beginPath();
      ctx.arc(cx, cy, r - 7, -Math.PI / 2, -Math.PI / 2 + dayProgress * Math.PI * 2);
      ctx.strokeStyle = isLight ? 'rgba(194,65,12,0.35)' : 'rgba(245,158,11,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 亚秒扫描弧 + 擒纵脉冲点
      const secAngle = (sec / 60) * Math.PI * 2 - Math.PI / 2;
      const accent = isLight ? '#c2410c' : '#f59e0b';

      ctx.beginPath();
      ctx.arc(cx, cy, r, secAngle - 0.35, secAngle);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      // 指针端点高亮
      const px = cx + Math.cos(secAngle) * r;
      const py = cy + Math.sin(secAngle) * r;
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
    }

    let rafId = 0;
    function tick() {
      if (document.hidden) {
        rafId = 0;
        return;
      }
      drawFrame();
      if (!prefersReducedMotion.matches) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = 0;
      }
    }

    function startLoop() {
      if (document.hidden) return;
      if (prefersReducedMotion.matches) {
        drawFrame();
      } else if (!rafId) {
        rafId = requestAnimationFrame(tick);
      }
    }

    window.addEventListener('workbench:themechange', drawFrame);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else {
        startLoop();
      }
    });

    startLoop();
  }

  /* ============================================================================
     3. 声学示波器与游标寻道 (Sound Deck Oscilloscope & Seek Reticle)
     ============================================================================ */
  function initSoundOscilloscope() {
    const deck = document.getElementById('track');
    const audio = document.getElementById('audio');
    const seek = document.getElementById('seek');
    if (!deck || !audio) return;

    const scopeWrap = document.createElement('div');
    scopeWrap.className = 'deck-scope-wrap';
    scopeWrap.setAttribute('aria-hidden', 'true');

    const canvas = document.createElement('canvas');
    canvas.className = 'deck-scope-canvas';
    scopeWrap.appendChild(canvas);

    const seekWrap = deck.querySelector('.deck-seek-wrap');
    if (seekWrap && seekWrap.parentNode) {
      seekWrap.parentNode.insertBefore(scopeWrap, seekWrap);
    } else {
      deck.appendChild(scopeWrap);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let analyser = null;
    let dataArray = null;
    let audioCtx = null;

    function setupAudioContext() {
      if (audioCtx) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
        const src = audioCtx.createMediaElementSource(audio);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        src.connect(analyser);
        analyser.connect(audioCtx.destination);
        dataArray = new Uint8Array(analyser.frequencyBinCount);
      } catch (_) {
        // 跨域或环境限制时优雅回退到程序化驻波
      }
    }

    audio.addEventListener('play', () => {
      setupAudioContext();
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    }, { once: true });

    function syncSize(rect) {
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    syncSize(scopeWrap.getBoundingClientRect());
    window.addEventListener('resize', () => {
      syncSize(scopeWrap.getBoundingClientRect());
    }, { passive: true });

    let phase = 0;
    function drawFrame() {
      const rect = scopeWrap.getBoundingClientRect();
      if (!syncSize(rect)) return;
      const w = rect.width;
      const h = rect.height;
      const isPlaying = !audio.paused && !audio.ended;
      const isLight = getThemeLightFactor() > 0.5;
      const accent = isLight ? '#c2410c' : '#f59e0b';

      ctx.clearRect(0, 0, w, h);

      // 中心基准线
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.strokeStyle = isLight ? 'rgba(15,23,42,0.08)' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();

      let hasLiveFFT = false;
      if (analyser && dataArray && isPlaying) {
        analyser.getByteFrequencyData(dataArray);
        const sum = dataArray.reduce((a, b) => a + b, 0);
        if (sum > 10) hasLiveFFT = true;
      }

      if (hasLiveFFT) {
        const bars = dataArray.length;
        const gap = w / bars;
        for (let i = 0; i < bars; i++) {
          const v = dataArray[i] / 255;
          const bh = Math.max(2, v * (h - 4));
          const x = i * gap + gap * 0.25;
          const bw = Math.max(2, gap * 0.5);
          ctx.fillStyle = accent;
          ctx.globalAlpha = 0.25 + v * 0.75;
          ctx.fillRect(x, (h - bh) / 2, bw, bh);
        }
        ctx.globalAlpha = 1;
      } else {
        // 优雅的驻波 / 呼吸波形
        phase += isPlaying ? 0.08 : 0.02;
        const amp = isPlaying ? 8 : 2.5;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 3) {
          const nx = x / w;
          const env = Math.sin(nx * Math.PI);
          const y = h / 2 + Math.sin(nx * 14 + phase) * Math.cos(nx * 5 - phase * 0.6) * amp * env;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.globalAlpha = isPlaying ? 0.85 : 0.35;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    let rafId = 0;
    function tick() {
      if (document.hidden) {
        rafId = 0;
        return;
      }
      drawFrame();
      if (!prefersReducedMotion.matches) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = 0;
      }
    }

    function startLoop() {
      if (document.hidden) return;
      if (prefersReducedMotion.matches) {
        drawFrame();
      } else if (!rafId) {
        rafId = requestAnimationFrame(tick);
      }
    }

    window.addEventListener('workbench:themechange', drawFrame);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else {
        startLoop();
      }
    });

    startLoop();

    // 寻道条悬停时间标尺
    if (seek) {
      const tip = document.createElement('div');
      tip.className = 'seek-preview-tip';
      tip.hidden = true;
      seek.parentElement.style.position = 'relative';
      seek.parentElement.appendChild(tip);

      seek.addEventListener('pointermove', (e) => {
        if (seek.disabled || !audio.duration || !isFinite(audio.duration)) return;
        const rect = seek.getBoundingClientRect();
        const ratio = clamp((e.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
        const t = ratio * audio.duration;
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60).toString().padStart(2, '0');
        tip.textContent = `${m}:${s}`;
        tip.style.left = `${clamp(ratio * 100, 6, 94)}%`;
        tip.hidden = false;
      });
      seek.addEventListener('pointerleave', () => {
        tip.hidden = true;
      });
    }
  }

  /* ============================================================================
     4. 搜索光学准星与匹配率仪表 (Search Optical Reticle)
     ============================================================================ */
  function initSearchReticle() {
    const inner = document.querySelector('.search-inner');
    const input = document.getElementById('q');
    const countEl = document.getElementById('count');
    const totalEl = document.getElementById('total');
    if (!inner || !input) return;

    const scanLine = document.createElement('div');
    scanLine.className = 'search-scan-line';
    scanLine.setAttribute('aria-hidden', 'true');
    inner.appendChild(scanLine);

    let pulseTimer = null;
    input.addEventListener('input', () => {
      inner.classList.add('is-scanning');
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => inner.classList.remove('is-scanning'), 260);
    });

    // 匹配率微进度条
    if (countEl && totalEl) {
      const obs = new MutationObserver(() => {
        const c = parseInt(countEl.textContent || '0', 10);
        const t = Math.max(1, parseInt(totalEl.textContent || '1', 10));
        inner.style.setProperty('--match-ratio', (c / t).toFixed(3));
      });
      obs.observe(countEl, { childList: true, characterData: true, subtree: true });
    }
  }

  /* ============================================================================
     5. 卡片 3D 微倾角、镜面高光与角标对准 (Link Card Optics)
     ============================================================================ */
  function initCardOptics() {
    if (prefersReducedMotion.matches || isCoarsePointer.matches) return;

    const cards = document.querySelectorAll('.link-card');
    cards.forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = (e.clientX - rect.left) / Math.max(rect.width, 1);
        const y = (e.clientY - rect.top) / Math.max(rect.height, 1);
        const tiltY = (x - 0.5) * 6;   // deg
        const tiltX = (0.5 - y) * 5;   // deg
        card.style.setProperty('--tilt-x', `${tiltX.toFixed(2)}deg`);
        card.style.setProperty('--tilt-y', `${tiltY.toFixed(2)}deg`);
        card.style.setProperty('--glint-x', `${(x * 100).toFixed(1)}%`);
        card.style.setProperty('--glint-y', `${(y * 100).toFixed(1)}%`);
      });

      card.addEventListener('pointerleave', () => {
        card.style.setProperty('--tilt-x', '0deg');
        card.style.setProperty('--tilt-y', '0deg');
      });
    });
  }

  // 启动所有精密仪器组件
  function boot() {
    initThemePrismGL();
    initChronometer();
    initSoundOscilloscope();
    initSearchReticle();
    initCardOptics();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
