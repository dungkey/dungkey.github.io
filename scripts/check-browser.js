const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectDir = path.resolve(__dirname, "..");
const chromePath =
  process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sitePort = Number(process.env.BLOG_BROWSER_PORT || 8099);
const siteUrl = `http://127.0.0.1:${sitePort}`;
const artifactDir = process.env.BROWSER_ARTIFACTS || os.tmpdir();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stopProcess = async (child, name) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  child.kill("SIGTERM");
  if (await Promise.race([exited, delay(2000).then(() => false)])) return;

  child.kill("SIGKILL");
  const forcedExit = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(1000).then(() => false),
  ]);
  if (!forcedExit) throw new Error(`${name} did not exit after SIGKILL`);
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const waitForJson = async (url, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
};

const waitForUrl = async (url, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
};

class CdpClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.waiters = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }

      const waiters = this.waiters.get(message.method) || [];
      this.waiters.delete(message.method);
      waiters.forEach((resolve) => resolve(message.params));
    });

    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(method) || [];
      waiters.push(resolve);
      this.waiters.set(method, waiters);
    });
  }

  close() {
    this.socket?.close();
  }
}

const evaluate = async (client, expression) => {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "Browser evaluation failed");
  }
  return response.result.value;
};

const navigate = async (client, url) => {
  const loaded = client.once("Page.loadEventFired");
  await client.send("Page.navigate", { url });
  await loaded;
  await delay(180);
};

const setViewport = (client, width, height) =>
  client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 560,
  });

const capture = async (client, name) => {
  const screenshot = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const target = path.join(artifactDir, name);
  fs.writeFileSync(target, Buffer.from(screenshot.data, "base64"));
  return target;
};

const layoutSnapshot = (client) =>
  evaluate(
    client,
    `(() => {
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
      };
      const title = document.querySelector('.cover-grid h1');
      const titleRange = document.createRange();
      titleRange.selectNodeContents(title);
      const titleText = titleRange.getBoundingClientRect();
      return {
        width: innerWidth,
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.scrollingElement.scrollWidth,
        title: { left: titleText.left, right: titleText.right, width: titleText.width },
        header: rect(document.querySelector('.header-inner')),
        headerItems: ['.brand', '.nav', '.header-end'].map((selector) => ({
          selector,
          ...rect(document.querySelector(selector)),
        })),
        controls: [...document.querySelectorAll('.header-end button')].map((button) => ({
          id: button.id,
          visible: button.offsetParent !== null,
          ...rect(button),
        })),
      };
    })()`
  );

async function run() {
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath}`);
  }

  const debugPort = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-browser-"));
  const server = spawn(
    process.execPath,
    [path.join(projectDir, "node_modules/@11ty/eleventy/cmd.cjs"), "--serve", `--port=${sitePort}`],
    {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      "--window-size=1440,1000",
      `${siteUrl}/`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  let client;
  const browserErrors = [];
  const screenshots = [];

  try {
    await waitForUrl(`${siteUrl}/`);
    const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");

    client = new CdpClient(page.webSocketDebuggerUrl);
    await client.connect();
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Log.enable"),
    ]);
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    client.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        browserErrors.push(message.params.exceptionDetails.text);
      }
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        browserErrors.push(message.params.entry.text);
      }
    });

    for (const width of [320, 375, 768, 1440]) {
      await setViewport(client, width, width < 600 ? 900 : 1000);
      await navigate(client, `${siteUrl}/`);
      const layout = await layoutSnapshot(client);
      assert.equal(
        layout.documentWidth,
        layout.viewportWidth,
        `${width}px page has horizontal overflow`
      );
      assert.ok(layout.title.left >= -1, `${width}px title crosses the left edge`);
      assert.ok(
        layout.title.right <= layout.viewportWidth + 1,
        `${width}px title crosses the right edge`
      );
      for (const control of layout.controls.filter((item) => item.visible)) {
        assert.ok(
          control.left >= 0 && control.right <= layout.viewportWidth,
          `${width}px ${control.id} is outside the viewport`
        );
      }
      const visibleHeaderItems = layout.headerItems.filter(
        (item) => item.width > 0 && item.bottom > item.top
      );
      for (let index = 0; index < visibleHeaderItems.length; index += 1) {
        for (let next = index + 1; next < visibleHeaderItems.length; next += 1) {
          const first = visibleHeaderItems[index];
          const second = visibleHeaderItems[next];
          const overlaps =
            first.left < second.right &&
            first.right > second.left &&
            first.top < second.bottom &&
            first.bottom > second.top;
          assert.equal(
            overlaps,
            false,
            `${width}px ${first.selector} overlaps ${second.selector}`
          );
        }
      }
      screenshots.push(await capture(client, `blog-home-${width}.png`));
    }

    await setViewport(client, 375, 900);
    await navigate(client, `${siteUrl}/`);
    await evaluate(client, `localStorage.setItem('qijue-theme', 'light')`);
    await navigate(client, `${siteUrl}/`);
    screenshots.push(await capture(client, "blog-home-375-light.png"));
    await evaluate(client, `document.getElementById('themeToggle').click()`);
    const themeState = await evaluate(
      client,
      `({ theme: document.documentElement.dataset.theme,
          saved: localStorage.getItem('qijue-theme'),
          color: document.querySelector('meta[name="theme-color"]').content })`
    );
    assert.deepEqual(themeState, {
      theme: "dark",
      saved: "dark",
      color: "#1c1c1c",
    });

    await evaluate(client, `localStorage.removeItem('qijue-theme')`);
    await client.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-color-scheme", value: "light" },
      ],
    });
    await navigate(client, `${siteUrl}/`);
    assert.equal(
      await evaluate(client, `document.documentElement.dataset.theme`),
      "light"
    );
    await client.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-color-scheme", value: "dark" },
      ],
    });
    await delay(80);
    const systemThemeState = await evaluate(
      client,
      `({ theme: document.documentElement.dataset.theme,
          saved: localStorage.getItem('qijue-theme'),
          color: document.querySelector('meta[name="theme-color"]').content,
          label: document.getElementById('themeToggle').getAttribute('aria-label') })`
    );
    assert.deepEqual(systemThemeState, {
      theme: "dark",
      saved: null,
      color: "#1c1c1c",
      label: "切换浅色模式",
    });

    await evaluate(client, `document.getElementById('searchOpen').click()`);
    await delay(180);
    const searchOpen = await evaluate(
      client,
      `({ open: document.getElementById('searchOverlay').classList.contains('is-open'),
          focus: document.activeElement.id,
          inert: document.querySelector('main').inert,
          expanded: document.getElementById('searchOpen').getAttribute('aria-expanded') })`
    );
    assert.deepEqual(searchOpen, {
      open: true,
      focus: "searchInput",
      inert: true,
      expanded: "true",
    });

    await evaluate(
      client,
      `(() => {
        const input = document.getElementById('searchInput');
        input.value = '留白';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`
    );
    await delay(250);
    const resultUrl = await evaluate(
      client,
      `document.querySelector('#searchResults a')?.getAttribute('href') || ''`
    );
    assert.equal(resultUrl, "/posts/silence-in-ui/");

    await evaluate(
      client,
      `(() => {
        const input = document.getElementById('searchInput');
        input.value = '1px';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`
    );
    await delay(80);
    const noteResultUrl = await evaluate(
      client,
      `document.querySelector('#searchResults a')?.getAttribute('href') || ''`
    );
    assert.equal(noteResultUrl, "/notes/#note-060");

    await evaluate(
      client,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    );
    const searchClosed = await evaluate(
      client,
      `({ open: document.getElementById('searchOverlay').classList.contains('is-open'),
          focus: document.activeElement.id,
          inert: document.querySelector('main').inert,
          expanded: document.getElementById('searchOpen').getAttribute('aria-expanded') })`
    );
    assert.deepEqual(searchClosed, {
      open: false,
      focus: "searchOpen",
      inert: false,
      expanded: "false",
    });

    await navigate(client, `${siteUrl}/notes/#note-060`);
    const noteTarget = await evaluate(
      client,
      `(() => {
        const target = document.getElementById('note-060');
        return { title: document.title, top: target.getBoundingClientRect().top };
      })()`
    );
    assert.equal(noteTarget.title, "短记 — 琦珏");
    assert.ok(
      noteTarget.top >= 100 && noteTarget.top < 800,
      `Note anchor position is ${noteTarget.top}px`
    );
    screenshots.push(await capture(client, "blog-notes-375.png"));

    await setViewport(client, 320, 900);
    await navigate(client, `${siteUrl}/posts/silence-in-ui/`);
    const articleLayout = await evaluate(
      client,
      `({ width: document.documentElement.clientWidth,
          scrollWidth: document.scrollingElement.scrollWidth,
          category: document.querySelector('.article-hero .inner-kicker a')?.getAttribute('href') })`
    );
    assert.equal(articleLayout.scrollWidth, articleLayout.width);
    assert.equal(articleLayout.category, "/design/");
    screenshots.push(await capture(client, "blog-article-320.png"));

    await client.send("Emulation.setScriptExecutionDisabled", { value: true });
    await navigate(client, `${siteUrl}/posts/silence-in-ui/`);
    await client.send("Emulation.setScriptExecutionDisabled", { value: false });
    const noScript = await evaluate(
      client,
      `({ title: document.querySelector('h1')?.textContent.trim(),
          prose: document.querySelector('.prose')?.textContent.trim().length || 0,
          links: document.querySelectorAll('a[href]').length })`
    );
    assert.equal(noScript.title, "界面中的沉默：留白为何不是空白");
    assert.ok(noScript.prose > 100, "Article prose should remain available without JS");
    assert.ok(noScript.links > 5, "Navigation should remain available without JS");

    assert.deepEqual(browserErrors, [], `Browser errors: ${browserErrors.join(" | ")}`);
    browserErrors.length = 0;

    await navigate(client, `${siteUrl}/missing-browser-check/`);
    const notFound = await evaluate(
      client,
      `({ title: document.title, robots: document.querySelector('meta[name="robots"]')?.content })`
    );
    assert.deepEqual(notFound, {
      title: "页面不存在 — 琦珏",
      robots: "noindex, nofollow",
    });
    const unexpected404Errors = browserErrors.filter(
      (error) => !/Failed to load resource:.*status of 404/.test(error)
    );
    assert.deepEqual(
      unexpected404Errors,
      [],
      `404 browser errors: ${unexpected404Errors.join(" | ")}`
    );

    console.log(`Browser check passed. Screenshots: ${screenshots.join(", ")}`);
  } finally {
    client?.close();
    await Promise.all([
      stopProcess(chrome, "Chrome"),
      stopProcess(server, "Eleventy server"),
    ]);
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
