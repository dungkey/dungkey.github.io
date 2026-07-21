(() => {
  const TRACKS = {
    "home-light": [
      "/assets/music/home-light-1.mp3",
      "/assets/music/home-light-2.mp3",
    ],
    "home-dark": [
      "/assets/music/home-dark-1.mp3",
      "/assets/music/home-dark-2.mp3",
    ],
    catalog: ["/assets/music/catalog-1.mp3", "/assets/music/catalog-2.mp3"],
    article: ["/assets/music/article-1.mp3", "/assets/music/article-2.mp3"],
  };

  const VOLUMES = {
    "home-light": 0.3,
    "home-dark": 0.3,
    catalog: 0.14,
    article: 0.3,
  };

  const FADE_MS = 800;
  const STORAGE_KEY = "qijue-music";
  const SESSION_KEY = "qijue-music-session";

  const toggle = document.getElementById("musicToggle");
  if (!toggle) return;

  const pageScene = document.body.dataset.music || "catalog";
  const root = document.documentElement;
  const audio = new Audio();
  audio.loop = true;
  audio.preload = "auto";
  audio.volume = 0;

  let wanted = localStorage.getItem(STORAGE_KEY) !== "off";
  let unlocked = false;
  let currentKey = "";
  let currentSrc = "";
  let fadeGen = 0;
  let switching = false;
  let navigating = false;

  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const volumeFor = (key) => VOLUMES[key] ?? 0.42;

  const sceneKey = () => {
    if (pageScene === "home") {
      return root.dataset.theme === "dark" ? "home-dark" : "home-light";
    }
    return pageScene === "article" ? "article" : "catalog";
  };

  const keyFromPath = (pathname) => {
    const path = pathname.replace(/\/+$/, "") || "/";
    if (path === "/") {
      return root.dataset.theme === "dark" ? "home-dark" : "home-light";
    }
    if (path.startsWith("/posts/")) return "article";
    return "catalog";
  };

  const setUi = (playing) => {
    toggle.classList.toggle("is-playing", playing);
    toggle.setAttribute("aria-pressed", playing ? "true" : "false");
    toggle.setAttribute(
      "aria-label",
      playing ? "暂停背景音乐" : "播放背景音乐"
    );
  };

  const readSession = () => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data?.key || !data?.src) return null;
      return data;
    } catch {
      return null;
    }
  };

  const writeSession = () => {
    if (!currentKey || !currentSrc) return;
    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          key: currentKey,
          src: currentSrc,
          time: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        })
      );
    } catch {
      /* ignore */
    }
  };

  const fadeTo = (to, ms = FADE_MS) => {
    const gen = ++fadeGen;
    const from = audio.volume;
    if (ms <= 0 || Math.abs(from - to) < 0.008) {
      audio.volume = to;
      return Promise.resolve(true);
    }

    const start = performance.now();
    return new Promise((resolve) => {
      const tick = (now) => {
        if (gen !== fadeGen) {
          resolve(false);
          return;
        }
        const t = Math.min(1, (now - start) / ms);
        const eased = t * t * (3 - 2 * t);
        audio.volume = from + (to - from) * eased;
        if (t < 1) {
          requestAnimationFrame(tick);
          return;
        }
        audio.volume = to;
        resolve(true);
      };
      requestAnimationFrame(tick);
    });
  };

  const waitCanPlay = () =>
    new Promise((resolve) => {
      if (audio.readyState >= 2) {
        resolve();
        return;
      }
      const done = () => {
        audio.removeEventListener("canplay", done);
        resolve();
      };
      audio.addEventListener("canplay", done, { once: true });
      // 兜底：避免个别浏览器卡住
      setTimeout(done, 2500);
    });

  const resolveTrack = (key) => {
    const list = TRACKS[key];
    if (!list?.length) return null;

    const session = readSession();
    if (session?.key === key && list.includes(session.src)) {
      return {
        src: session.src,
        time: Number(session.time) || 0,
        continued: true,
      };
    }

    return { src: pick(list), time: 0, continued: false };
  };

  const applyTrack = async (src, key, { time = 0, fadeIn = true } = {}) => {
    switching = true;
    const target = volumeFor(key);
    const sameTrack = src === currentSrc && key === currentKey;

    if (!sameTrack && currentSrc && (!audio.paused || audio.volume > 0.01)) {
      const ok = await fadeTo(0);
      if (!ok) {
        switching = false;
        return false;
      }
    }

    if (!sameTrack) {
      audio.pause();
      audio.src = src;
      audio.load();
      await waitCanPlay();
      try {
        audio.currentTime = Math.max(0, time || 0);
      } catch {
        /* ignore seek errors */
      }
      currentKey = key;
      currentSrc = src;
    } else {
      currentKey = key;
      currentSrc = src;
      if (time > 0 && Math.abs((audio.currentTime || 0) - time) > 1.5) {
        try {
          audio.currentTime = time;
        } catch {
          /* ignore */
        }
      }
    }

    writeSession();
    switching = false;

    if (!wanted) {
      audio.volume = target;
      setUi(false);
      return true;
    }

    try {
      if (fadeIn) audio.volume = 0;
      await audio.play();
      unlocked = true;
      setUi(true);
      if (fadeIn) await fadeTo(target);
      else audio.volume = target;
      return true;
    } catch {
      setUi(false);
      return false;
    }
  };

  const play = async () => {
    wanted = true;
    unlocked = true;
    localStorage.setItem(STORAGE_KEY, "on");

    if (!currentSrc) {
      const key = sceneKey();
      const track = resolveTrack(key);
      if (!track) return false;
      return applyTrack(track.src, key, { time: track.time, fadeIn: true });
    }

    try {
      audio.volume = 0;
      await audio.play();
      setUi(true);
      await fadeTo(volumeFor(currentKey));
      writeSession();
      return true;
    } catch {
      setUi(false);
      return false;
    }
  };

  const pause = async () => {
    wanted = false;
    localStorage.setItem(STORAGE_KEY, "off");
    writeSession();
    await fadeTo(0);
    if (!wanted) {
      audio.pause();
      setUi(false);
    }
  };

  const bootstrap = async () => {
    const key = sceneKey();
    const track = resolveTrack(key);
    if (!track) {
      setUi(false);
      return;
    }

    currentKey = key;
    currentSrc = track.src;
    audio.src = track.src;
    audio.load();
    await waitCanPlay();
    try {
      audio.currentTime = track.time;
    } catch {
      /* ignore */
    }

    if (!wanted) {
      audio.volume = volumeFor(key);
      setUi(false);
      writeSession();
      return;
    }

    try {
      audio.volume = 0;
      await audio.play();
      unlocked = true;
      setUi(true);
      await fadeTo(volumeFor(key));
    } catch {
      audio.volume = volumeFor(key);
      setUi(false);
    }
    writeSession();
  };

  toggle.addEventListener("click", () => {
    if (!audio.paused && wanted) {
      pause();
      return;
    }
    play();
  });

  const unlockOnce = () => {
    if (unlocked || !wanted || !audio.paused) return;
    play();
  };

  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    document.addEventListener(eventName, unlockOnce, {
      once: true,
      passive: true,
    });
  });

  window.addEventListener("themechange", () => {
    if (pageScene !== "home") return;
    const key = sceneKey();
    const list = TRACKS[key];
    if (!list?.length) return;
    // 主题切换属于场景变化：淡出后换曲再淡入
    applyTrack(pick(list), key, { time: 0, fadeIn: true });
  });

  // 站内跳转：同场景保持曲目；跨场景先淡出再离开
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const link = event.target.closest("a[href]");
    if (!link || link.hasAttribute("download") || link.target === "_blank") return;

    let url;
    try {
      url = new URL(link.href, location.href);
    } catch {
      return;
    }

    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) {
      // 仅 hash 跳转，不动音乐
      return;
    }

    const nextKey = keyFromPath(url.pathname);
    const curKey = sceneKey();
    writeSession();

    if (nextKey === curKey) {
      // 目录↔目录 / 正文↔正文：不换曲，直接跳转，新页从进度续播
      return;
    }

    if (!wanted || audio.paused || audio.volume < 0.01) return;

    event.preventDefault();
    if (navigating) return;
    navigating = true;

    fadeTo(0).then(() => {
      writeSession();
      location.href = url.href;
    });
  });

  audio.addEventListener("play", () => {
    if (wanted) setUi(true);
  });

  audio.addEventListener("pause", () => {
    if (!wanted && !switching) setUi(false);
  });

  audio.addEventListener("timeupdate", () => {
    if (!audio.paused) writeSession();
  });

  document.addEventListener("visibilitychange", () => {
    writeSession();
    if (document.visibilityState === "hidden") return;
    if (wanted && unlocked && audio.paused && !navigating) {
      play();
    }
  });

  addEventListener("pagehide", writeSession);
  addEventListener("beforeunload", writeSession);

  bootstrap();
})();
