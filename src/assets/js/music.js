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

  const getStorage = (name) => {
    try {
      return window[name];
    } catch {
      return null;
    }
  };

  const localStore = getStorage("localStorage");
  const sessionStore = getStorage("sessionStorage");

  const safeRead = (storage, key) => {
    if (!storage) return null;
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };

  const safeWrite = (storage, key, value) => {
    if (!storage) return;
    try {
      storage.setItem(key, value);
    } catch {
      // Playback should remain usable when browser storage is unavailable.
    }
  };

  const safeRemove = (storage, key) => {
    if (!storage) return;
    try {
      storage.removeItem(key);
    } catch {
      // Ignore storage restrictions just like reads and writes.
    }
  };

  const pageScene = document.body.dataset.music || "catalog";
  const root = document.documentElement;
  const audio = new Audio();
  audio.loop = true;
  audio.preload = "none";
  audio.volume = 0;

  // Music is opt-in on a first visit. A previous explicit choice is respected.
  let wanted = safeRead(localStore, STORAGE_KEY) === "on";
  let unlocked = false;
  let currentKey = "";
  let currentSrc = "";
  let failedSrc = "";
  let fadeGen = 0;
  let operationGen = 0;
  let switching = false;
  let navigating = false;

  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const volumeFor = (key) => VOLUMES[key] ?? 0.25;

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

  const setUi = (playing, label) => {
    const action = label || (playing ? "暂停背景音乐" : "播放背景音乐");
    toggle.classList.toggle("is-playing", playing);
    toggle.setAttribute("aria-pressed", playing ? "true" : "false");
    toggle.setAttribute("aria-label", action);
    toggle.setAttribute("title", action);
  };

  const readSession = () => {
    try {
      const raw = safeRead(sessionStore, SESSION_KEY);
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
    safeWrite(
      sessionStore,
      SESSION_KEY,
      JSON.stringify({
        key: currentKey,
        src: currentSrc,
        time: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      })
    );
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
        const progress = Math.min(1, (now - start) / ms);
        const eased = progress * progress * (3 - 2 * progress);
        audio.volume = from + (to - from) * eased;
        if (progress < 1) {
          requestAnimationFrame(tick);
          return;
        }
        audio.volume = to;
        resolve(true);
      };
      requestAnimationFrame(tick);
    });
  };

  const resolveTrack = (key) => {
    const list = TRACKS[key];
    if (!list?.length) return null;

    const session = readSession();
    if (
      session?.key === key &&
      list.includes(session.src) &&
      session.src !== failedSrc
    ) {
      return {
        src: session.src,
        time: Number(session.time) || 0,
      };
    }

    const available = list.filter((src) => src !== failedSrc);
    return { src: pick(available.length ? available : list), time: 0 };
  };

  const setTrack = (src, key, time) => {
    audio.pause();
    audio.src = src;
    audio.load();
    currentKey = key;
    currentSrc = src;

    if (time > 0) {
      const restoreTime = () => {
        try {
          audio.currentTime = Math.max(0, time);
        } catch {
          // Some browsers reject seeking before metadata is available.
        }
      };
      restoreTime();
      audio.addEventListener("loadedmetadata", restoreTime, { once: true });
    }
  };

  const applyTrack = async (src, key, { time = 0, fadeIn = true } = {}) => {
    const operation = ++operationGen;
    switching = true;
    toggle.setAttribute("aria-busy", "true");
    const targetVolume = volumeFor(key);
    const sameTrack = src === currentSrc && key === currentKey;

    if (!sameTrack && currentSrc && (!audio.paused || audio.volume > 0.01)) {
      const completed = await fadeTo(0);
      if (!completed || operation !== operationGen) return false;
    }

    if (!sameTrack) setTrack(src, key, time);
    if (operation !== operationGen) return false;

    writeSession();
    if (!wanted) {
      audio.volume = 0;
      switching = false;
      toggle.removeAttribute("aria-busy");
      setUi(false);
      return true;
    }

    try {
      if (fadeIn) audio.volume = 0;
      await audio.play();
      if (operation !== operationGen) return false;
      unlocked = true;
      failedSrc = "";
      setUi(true);
      if (fadeIn) await fadeTo(targetVolume);
      else audio.volume = targetVolume;
      if (operation !== operationGen) return false;
      writeSession();
      switching = false;
      toggle.removeAttribute("aria-busy");
      return true;
    } catch {
      if (operation === operationGen) {
        switching = false;
        toggle.removeAttribute("aria-busy");
        setUi(false);
      }
      return false;
    }
  };

  const play = async () => {
    wanted = true;
    safeWrite(localStore, STORAGE_KEY, "on");

    const key = sceneKey();
    if (!currentSrc || currentKey !== key) {
      const track = resolveTrack(key);
      if (!track) {
        setUi(false, "音乐暂时无法播放");
        return false;
      }
      return applyTrack(track.src, key, {
        time: track.time,
        fadeIn: true,
      });
    }

    const operation = ++operationGen;
    switching = true;
    toggle.setAttribute("aria-busy", "true");
    try {
      audio.volume = 0;
      await audio.play();
      if (operation !== operationGen) return false;
      unlocked = true;
      failedSrc = "";
      setUi(true);
      await fadeTo(volumeFor(currentKey));
      if (operation !== operationGen) return false;
      writeSession();
      switching = false;
      toggle.removeAttribute("aria-busy");
      return true;
    } catch {
      if (operation === operationGen) {
        switching = false;
        toggle.removeAttribute("aria-busy");
        setUi(false);
      }
      return false;
    }
  };

  const pause = async () => {
    wanted = false;
    safeWrite(localStore, STORAGE_KEY, "off");
    const operation = ++operationGen;
    writeSession();
    await fadeTo(0);
    if (operation === operationGen && !wanted) {
      audio.pause();
      switching = false;
      toggle.removeAttribute("aria-busy");
      setUi(false);
    }
  };

  toggle.addEventListener("click", () => {
    if (!audio.paused && wanted) {
      pause();
      return;
    }
    play();
  });

  window.addEventListener("themechange", () => {
    if (pageScene !== "home" || !wanted || audio.paused || !unlocked) return;
    const key = sceneKey();
    const list = TRACKS[key];
    if (!list?.length) return;
    applyTrack(pick(list), key, { time: 0, fadeIn: true });
  });

  // Preserve a track within the same section; fade only when the scene changes.
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
    if (url.pathname === location.pathname && url.search === location.search) return;

    const nextKey = keyFromPath(url.pathname);
    const currentSceneKey = sceneKey();
    writeSession();

    if (nextKey === currentSceneKey) return;
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

  audio.addEventListener("error", () => {
    operationGen += 1;
    fadeGen += 1;
    unlocked = false;
    switching = false;
    audio.pause();
    failedSrc = currentSrc;
    currentKey = "";
    currentSrc = "";
    safeRemove(sessionStore, SESSION_KEY);
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch {
      // The next explicit click will create a fresh media request.
    }
    toggle.removeAttribute("aria-busy");
    setUi(false, "音乐暂时无法播放，点击重试");
  });

  audio.addEventListener("timeupdate", () => {
    if (!audio.paused) writeSession();
  });

  document.addEventListener("visibilitychange", () => {
    writeSession();
    if (
      document.visibilityState === "visible" &&
      wanted &&
      unlocked &&
      audio.paused &&
      !navigating
    ) {
      play();
    }
  });

  addEventListener("pagehide", writeSession);
  addEventListener("beforeunload", writeSession);

  setUi(false);
  if (wanted) play();
})();
