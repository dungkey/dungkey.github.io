const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "src/assets/js/music.js"),
  "utf8"
);

const listenersFor = () => new Map();
const on = (listeners, name, callback) => {
  const callbacks = listeners.get(name) || [];
  callbacks.push(callback);
  listeners.set(name, callbacks);
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function run() {
  const toggleListeners = listenersFor();
  const documentListeners = listenersFor();
  const windowListeners = listenersFor();
  const attributes = new Map();

  const toggle = {
    classList: { toggle() {} },
    addEventListener(name, callback) {
      on(toggleListeners, name, callback);
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };

  class AudioMock {
    constructor() {
      this.listeners = listenersFor();
      this.paused = true;
      this.volume = 0;
      this.currentTime = 0;
      this.loadCount = 0;
      this.playCount = 0;
      AudioMock.instance = this;
    }

    addEventListener(name, callback) {
      on(this.listeners, name, callback);
    }

    pause() {
      this.paused = true;
      for (const callback of this.listeners.get("pause") || []) callback();
    }

    load() {
      this.loadCount += 1;
    }

    async play() {
      if (this.error) throw this.error;
      this.playCount += 1;
      this.paused = false;
      for (const callback of this.listeners.get("play") || []) callback();
    }

    removeAttribute(name) {
      if (name === "src") this.src = "";
    }
  }

  const root = { dataset: { theme: "light" } };
  const document = {
    body: { dataset: { music: "home" } },
    documentElement: root,
    visibilityState: "visible",
    getElementById(id) {
      return id === "musicToggle" ? toggle : null;
    },
    addEventListener(name, callback) {
      on(documentListeners, name, callback);
    },
  };

  const window = {
    addEventListener(name, callback) {
      on(windowListeners, name, callback);
    },
  };
  Object.defineProperty(window, "localStorage", {
    get() {
      throw new DOMException("Storage disabled", "SecurityError");
    },
  });
  Object.defineProperty(window, "sessionStorage", {
    get() {
      throw new DOMException("Storage disabled", "SecurityError");
    },
  });

  const context = {
    Audio: AudioMock,
    DOMException,
    document,
    window,
    location: { href: "https://site.test/", origin: "https://site.test", pathname: "/", search: "" },
    performance: { now: () => 0 },
    requestAnimationFrame: (callback) => callback(1000),
    addEventListener() {},
    URL,
    Math,
    Promise,
  };

  vm.runInNewContext(source, context, { filename: "music.js" });
  const audio = AudioMock.instance;

  assert.equal(audio.preload, "none", "audio must remain lazy on first visit");
  assert.equal(audio.loadCount, 0, "first visit must not download a track");
  assert.equal(audio.playCount, 0, "first visit must not autoplay");
  assert.equal(attributes.get("aria-pressed"), "false");

  toggleListeners.get("click")[0]();
  await flush();
  await flush();
  assert.equal(audio.loadCount, 1, "an explicit click should load one track");
  assert.equal(audio.playCount, 1, "an explicit click should start playback");
  assert.equal(attributes.get("aria-pressed"), "true");

  audio.error = new Error("media failed");
  for (const callback of audio.listeners.get("error") || []) callback();
  assert.equal(audio.paused, true, "a media error should stop playback");
  assert.equal(attributes.get("aria-pressed"), "false");
  assert.equal(
    attributes.get("aria-label"),
    "音乐暂时无法播放，点击重试"
  );
  assert.equal(attributes.has("aria-busy"), false);
  assert.equal(audio.src, "", "a media error should unload the failed source");
  const loadCountAfterError = audio.loadCount;

  audio.error = null;

  toggleListeners.get("click")[0]();
  await flush();
  await flush();
  assert.equal(audio.playCount, 2, "clicking after an error should retry playback");
  assert.equal(
    audio.loadCount,
    loadCountAfterError + 1,
    "retry should issue a fresh media load"
  );
  assert.equal(attributes.get("aria-pressed"), "true");

  toggleListeners.get("click")[0]();
  await flush();
  await flush();
  assert.equal(audio.paused, true, "a second click should pause playback");
  assert.equal(attributes.get("aria-pressed"), "false");

  console.log(
    "Music smoke check passed: opt-in, blocked storage, error recovery, play and pause."
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
