/**
 * 精密仪器风 WebGL2 环境背景层
 * 零依赖、自适应深浅双主题、支持 prefers-reduced-motion 与后台自动休眠
 */
(() => {
  'use strict';

  const VERT_SRC = `#version 300 es
    in vec2 a_pos;
    out vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const FRAG_SRC = `#version 300 es
    precision highp float;

    in vec2 v_uv;
    out vec4 fragColor;

    uniform vec2 u_res;
    uniform float u_time;
    uniform vec2 u_mouse;
    uniform float u_light; // 0.0 = dark, 1.0 = light
    uniform float u_audio; // 0.0 ~ 1.0 音频能量

    // 快速伪随机哈希（用于胶片微粒噪点，消除色带）
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // 平滑二维值噪声
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash12(i);
      float b = hash12(i + vec2(1.0, 0.0));
      float c = hash12(i + vec2(0.0, 1.0));
      float d = hash12(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
      for (int i = 0; i < 3; i++) {
        v += a * noise(p);
        p = rot * p * 2.02;
        a *= 0.5;
      }
      return v;
    }

    void main() {
      vec2 aspect = vec2(u_res.x / max(u_res.y, 1.0), 1.0);
      vec2 p = (v_uv - 0.5) * aspect;
      vec2 m = (u_mouse - 0.5) * aspect;

      // 缓慢呼吸的流体场
      float t = u_time * 0.085;
      float n1 = fbm(p * 1.45 + vec2(t, -t * 0.6));
      float n2 = fbm(p * 2.30 - vec2(t * 0.5, t * 0.8) + n1 * 0.45);

      // 鼠标跟随的克制环境光晕
      float distMouse = length(p - m * 0.65);
      float mouseGlow = exp(-distMouse * distMouse * 2.6);

      // 顶部偏左的固定主光源（呼应左栏工作台）
      float distAnchor = length(p - vec2(-0.38 * aspect.x, 0.28));
      float anchorGlow = exp(-distAnchor * distAnchor * 1.8);

      // 暗色主题色板 (#090a0d 底 + #f59e0b 暖琥珀微光)
      vec3 darkBg = vec3(0.035, 0.039, 0.051);
      vec3 darkMist = vec3(0.075, 0.088, 0.115);
      vec3 darkAccent = vec3(0.961, 0.620, 0.043);

      // 浅色主题色板 (#f4f5f8 底 + #c2410c 陶土暖棕微光)
      vec3 lightBg = vec3(0.957, 0.961, 0.973);
      vec3 lightMist = vec3(0.905, 0.918, 0.945);
      vec3 lightAccent = vec3(0.761, 0.255, 0.047);

      vec3 bg = mix(darkBg, lightBg, u_light);
      vec3 mist = mix(darkMist, lightMist, u_light);
      vec3 accent = mix(darkAccent, lightAccent, u_light);

      // 混合流体暗纹（克制收敛，保留精密质感）
      vec3 col = mix(bg, mist, smoothstep(0.22, 0.88, n2) * 0.58);

      // 缓慢斜向扫描光带
      float sweep = exp(-pow(fract((p.x * 0.35 + p.y * 0.25) - u_time * 0.025) - 0.5, 2.0) * 90.0);
      col += mix(vec3(1.0), vec3(0.0), u_light) * sweep * 0.012;

      // 叠加极克制的暖色环境光（随音频微弱呼吸）
      float audioBoost = 1.0 + u_audio * 0.55;
      float accentStrength = (mouseGlow * 0.075 + anchorGlow * 0.055) * (0.65 + 0.35 * n1) * audioBoost;
      col = mix(col, accent, accentStrength * mix(1.0, 0.45, u_light));

      // 精密坐标点阵 + 十字准星（仅在光标光场附近隐约显现）
      vec2 gridPx = gl_FragCoord.xy;
      vec2 cell = mod(gridPx, 40.0);
      float dotMask = step(cell.x, 1.25) * step(cell.y, 1.25);
      float crossH = step(abs(cell.y - 20.0), 0.5) * step(abs(cell.x - 20.0), 3.0);
      float crossV = step(abs(cell.x - 20.0), 0.5) * step(abs(cell.y - 20.0), 3.0);
      float crossMask = clamp(crossH + crossV, 0.0, 1.0);
      float gridVis = (0.02 + mouseGlow * 0.055 + u_audio * 0.025) * mix(1.0, 0.65, u_light);
      vec3 gridCol = mix(vec3(1.0), vec3(0.1), u_light);
      col = mix(col, gridCol, (dotMask + crossMask * 0.55) * gridVis);

      // 轻微径向暗角，增强中心聚焦感
      float vig = smoothstep(1.35, 0.35, length(p));
      col *= mix(0.92, 1.0, vig);

      // 胶片微粒噪点（消除渐变色带，增加磨砂质感）
      float grain = (hash12(gl_FragCoord.xy + fract(u_time) * 100.0) - 0.5) * 0.014;
      col += grain;

      fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `;

  function createShader(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function init() {
    const canvas = document.createElement('canvas');
    canvas.id = 'ambient-gl';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '0',
      pointerEvents: 'none',
      display: 'block'
    });

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power'
    });
    if (!gl) return;

    const vs = createShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uMouse = gl.getUniformLocation(prog, 'u_mouse');
    const uLight = gl.getUniformLocation(prog, 'u_light');
    const uAudio = gl.getUniformLocation(prog, 'u_audio');

    document.body.prepend(canvas);

    let width = 0;
    let height = 0;
    let targetMouse = [0.35, 0.65];
    let currentMouse = [0.35, 0.65];
    let targetLight = document.documentElement.getAttribute('data-theme') === 'light' ? 1 : 0;
    let currentLight = targetLight;
    let currentAudio = 0;
    let rafId = 0;
    let startTime = performance.now();

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.floor(window.innerWidth * dpr);
      height = Math.floor(window.innerHeight * dpr);
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }

    function render(now) {
      const elapsed = (now - startTime) * 0.001;

      currentMouse[0] += (targetMouse[0] - currentMouse[0]) * 0.045;
      currentMouse[1] += (targetMouse[1] - currentMouse[1]) * 0.045;
      currentLight += (targetLight - currentLight) * 0.08;

      let targetAudio = 0;
      const audioEl = document.querySelector('audio');
      if (audioEl && !audioEl.paused) {
        targetAudio = 0.28 + 0.16 * Math.sin(elapsed * 3.2) + 0.08 * Math.sin(elapsed * 7.1);
      }
      currentAudio += (targetAudio - currentAudio) * 0.12;

      gl.useProgram(prog);
      gl.uniform2f(uRes, width, height);
      gl.uniform1f(uTime, elapsed);
      gl.uniform2f(uMouse, currentMouse[0], currentMouse[1]);
      gl.uniform1f(uLight, currentLight);
      gl.uniform1f(uAudio, currentAudio);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (!reducedMotion && !document.hidden) {
        rafId = requestAnimationFrame(render);
      } else {
        rafId = 0;
      }
    }

    function start() {
      if (!rafId) {
        rafId = requestAnimationFrame(render);
      }
    }

    window.addEventListener('resize', () => {
      resize();
      if (reducedMotion) render(performance.now());
    }, { passive: true });

    let cardHoverRaf = 0;
    let lastPointerEvent = null;

    window.addEventListener('pointermove', (e) => {
      targetMouse[0] = e.clientX / Math.max(window.innerWidth, 1);
      targetMouse[1] = 1.0 - e.clientY / Math.max(window.innerHeight, 1);

      lastPointerEvent = e;
      if (!cardHoverRaf) {
        cardHoverRaf = requestAnimationFrame(() => {
          cardHoverRaf = 0;
          const ev = lastPointerEvent;
          if (!ev) return;
          const card = ev.target && ev.target.closest ? ev.target.closest('.card, .panel') : null;
          if (card) {
            const rect = card.getBoundingClientRect();
            card.style.setProperty('--mx', `${ev.clientX - rect.left}px`);
            card.style.setProperty('--my', `${ev.clientY - rect.top}px`);
          }
        });
      }
    }, { passive: true });

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    });

    canvas.addEventListener('webglcontextrestored', () => {
      canvas.remove();
      init();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      } else if (!reducedMotion) {
        start();
      }
    });

    new MutationObserver(() => {
      targetLight = document.documentElement.getAttribute('data-theme') === 'light' ? 1 : 0;
      if (reducedMotion) {
        currentLight = targetLight;
        render(performance.now());
      }
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    resize();
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
