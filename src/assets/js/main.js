(() => {
  const root = document.documentElement;
  const header = document.getElementById("siteHeader");
  const searchOverlay = document.getElementById("searchOverlay");
  const searchOpen = document.getElementById("searchOpen");
  const searchClose = document.getElementById("searchClose");
  const searchInput = document.getElementById("searchInput");
  const searchResults = document.getElementById("searchResults");
  const themeToggle = document.getElementById("themeToggle");
  const year = document.getElementById("year");
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  const safeStore = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // The interface should still work when storage is disabled.
    }
  };

  const safeRead = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  let hasSavedTheme = ["dark", "light"].includes(
    safeRead("qijue-theme")
  );

  const applyThemeUi = () => {
    const isDark = root.dataset.theme === "dark";
    const isEditorialHome = root.classList.contains("is-home-document");
    const lightColor = isEditorialHome ? "#f9f8f6" : "#f2f1ec";
    const darkColor = isEditorialHome ? "#1c1c1c" : "#10110f";

    themeMeta?.setAttribute("content", isDark ? darkColor : lightColor);
    themeToggle?.setAttribute(
      "aria-label",
      isDark ? "切换浅色模式" : "切换深色模式"
    );
    themeToggle?.setAttribute(
      "title",
      isDark ? "切换浅色模式" : "切换深色模式"
    );
  };

  applyThemeUi();

  themeToggle?.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    hasSavedTheme = true;
    safeStore("qijue-theme", next);
    applyThemeUi();
    window.dispatchEvent(
      new CustomEvent("themechange", { detail: { theme: next } })
    );
  });

  const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  const followSystemTheme = (event) => {
    if (hasSavedTheme) return;
    const next = event.matches ? "dark" : "light";
    root.dataset.theme = next;
    applyThemeUi();
    window.dispatchEvent(
      new CustomEvent("themechange", { detail: { theme: next } })
    );
  };
  if (systemTheme?.addEventListener) {
    systemTheme.addEventListener("change", followSystemTheme);
  } else if (systemTheme?.addListener) {
    systemTheme.addListener(followSystemTheme);
  }

  if (header) {
    const updateHeader = () => {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    addEventListener("scroll", updateHeader, { passive: true });
    updateHeader();
  }

  let searchIndex = [];
  let searchState = "idle";
  let searchReturnFocus = null;
  let focusFrame = 0;
  let focusTimer = 0;
  let previousBodyOverflow = "";
  let backgroundTabStops = [];
  let backgroundAriaStates = [];

  const emptyHint = "输入标题、主题或摘要关键词…";
  const backgroundRegions = [
    ...document.querySelectorAll("body > header, body > main, body > footer"),
  ];

  const setPageInert = (isInert) => {
    backgroundRegions.forEach((region) => {
      region.inert = isInert;
      if (isInert) {
        backgroundAriaStates.push({
          region,
          ariaHidden: region.getAttribute("aria-hidden"),
        });
        region.setAttribute("aria-hidden", "true");
        const focusable = region.querySelectorAll(
          'a[href], button, input, select, textarea, [contenteditable="true"], [tabindex]'
        );
        focusable.forEach((element) => {
          backgroundTabStops.push({
            element,
            tabIndex: element.getAttribute("tabindex"),
          });
          element.setAttribute("tabindex", "-1");
        });
      }
    });

    if (!isInert) {
      backgroundAriaStates.forEach(({ region, ariaHidden }) => {
        if (!region.isConnected) return;
        if (ariaHidden === null) region.removeAttribute("aria-hidden");
        else region.setAttribute("aria-hidden", ariaHidden);
      });
      backgroundAriaStates = [];

      backgroundTabStops.forEach(({ element, tabIndex }) => {
        if (!element.isConnected) return;
        if (tabIndex === null) element.removeAttribute("tabindex");
        else element.setAttribute("tabindex", tabIndex);
      });
      backgroundTabStops = [];
    }
  };

  const setSearchMessage = (message) => {
    if (searchResults) searchResults.textContent = message;
  };

  const renderSearchError = () => {
    if (!searchResults) return;
    const message = document.createElement("span");
    const retry = document.createElement("button");
    message.textContent = "暂时无法载入文章索引。";
    retry.className = "search-retry";
    retry.type = "button";
    retry.textContent = "重新载入";
    retry.addEventListener("click", () => {
      searchState = "idle";
      loadSearchIndex();
    });
    searchResults.replaceChildren(message, retry);
  };

  const loadSearchIndex = async () => {
    if (searchState === "loading" || searchState === "ready") return;
    searchState = "loading";
    setSearchMessage("正在载入文章索引…");

    try {
      const response = await fetch("/search-index.json", {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Search index: ${response.status}`);
      const payload = await response.json();
      searchIndex = Array.isArray(payload)
        ? payload
            .filter((item) => item && typeof item === "object")
            .map((item) => ({
              ...item,
              tags: Array.isArray(item.tags) ? item.tags : [],
            }))
        : [];
      searchState = "ready";
      if (searchInput?.value.trim()) {
        searchInput.dispatchEvent(new Event("input"));
      } else {
        setSearchMessage(emptyHint);
      }
    } catch {
      searchIndex = [];
      searchState = "error";
      renderSearchError();
    }
  };

  const isSearchOpen = () =>
    Boolean(searchOverlay?.classList.contains("is-open"));

  const openSearch = () => {
    if (!searchOverlay) return;

    if (isSearchOpen()) {
      searchInput?.focus();
      return;
    }

    const activeElement = document.activeElement;
    searchReturnFocus =
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement !== root
        ? activeElement
        : searchOpen;
    previousBodyOverflow = document.body.style.overflow;
    searchOverlay.removeAttribute("inert");
    searchOverlay.inert = false;
    searchOverlay.classList.add("is-open");
    searchOverlay.setAttribute("aria-hidden", "false");
    searchOpen?.setAttribute("aria-expanded", "true");
    setPageInert(true);
    document.body.style.overflow = "hidden";
    if (searchState === "loading") setSearchMessage("正在载入文章索引…");
    loadSearchIndex();

    cancelAnimationFrame(focusFrame);
    clearTimeout(focusTimer);
    focusFrame = requestAnimationFrame(() => {
      if (isSearchOpen()) searchInput?.focus({ preventScroll: true });
      focusTimer = window.setTimeout(() => {
        if (isSearchOpen() && document.activeElement !== searchInput) {
          searchInput?.focus({ preventScroll: true });
        }
      }, 80);
    });
  };

  const closeSearch = () => {
    if (!searchOverlay || !isSearchOpen()) return;

    cancelAnimationFrame(focusFrame);
    clearTimeout(focusTimer);
    searchOverlay.classList.remove("is-open");
    searchOverlay.setAttribute("aria-hidden", "true");
    searchOverlay.setAttribute("inert", "");
    searchOverlay.inert = true;
    searchOpen?.setAttribute("aria-expanded", "false");
    setPageInert(false);
    document.body.style.overflow = previousBodyOverflow;
    if (searchInput) searchInput.value = "";
    if (searchState === "error") renderSearchError();
    else setSearchMessage(emptyHint);

    const returnTarget = searchReturnFocus;
    searchReturnFocus = null;
    if (returnTarget?.isConnected) returnTarget.focus();
  };

  searchOpen?.addEventListener("click", openSearch);
  searchClose?.addEventListener("click", closeSearch);

  searchOverlay?.addEventListener("click", (event) => {
    if (event.target === searchOverlay) closeSearch();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isSearchOpen()) {
      event.preventDefault();
      closeSearch();
      return;
    }

    if (event.key === "Tab" && isSearchOpen()) {
      const focusable = [
        ...searchOverlay.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), a[href]'
        ),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!searchOverlay.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
    }
  });

  const normalize = (value) =>
    String(value || "").normalize("NFKC").toLocaleLowerCase("zh-CN");

  const searchableText = (item) =>
    normalize(
      [
        item?.title,
        item?.category,
        item?.excerpt,
        ...(Array.isArray(item?.tags) ? item.tags : []),
      ].join(" ")
    );

  if (searchInput && searchResults) {
    searchInput.addEventListener("input", () => {
      const value = normalize(searchInput.value.trim());

      if (!value) {
        if (searchState === "error") renderSearchError();
        else setSearchMessage(emptyHint);
        return;
      }

      if (searchState === "idle") loadSearchIndex();
      if (searchState === "loading") {
        setSearchMessage("正在载入文章索引…");
        return;
      }
      if (searchState === "error") {
        renderSearchError();
        return;
      }

      const hits = searchIndex
        .filter((item) => searchableText(item).includes(value))
        .slice(0, 10);

      searchResults.replaceChildren();

      if (!hits.length) {
        setSearchMessage("没有找到相关文章。换一个更短的关键词试试。");
        return;
      }

      hits.forEach((item) => {
        const row = document.createElement("div");
        const link = document.createElement("a");
        const title = document.createElement("strong");
        link.href = item.url;
        title.textContent = item.title;
        link.append(title);
        row.append(link);

        if (item.category) {
          const category = document.createElement("span");
          category.className = "search-cat";
          category.textContent = item.category;
          row.append(category);
        }

        searchResults.append(row);
      });
    });
  }

  if (year) year.textContent = String(new Date().getFullYear());
})();
