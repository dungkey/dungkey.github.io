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

  const applyThemeColor = () => {
    if (!themeMeta) return;
    themeMeta.setAttribute(
      "content",
      root.dataset.theme === "dark" ? "#10110f" : "#f2f1ec"
    );
  };
  applyThemeColor();

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      localStorage.setItem("qijue-theme", next);
      applyThemeColor();
      window.dispatchEvent(new CustomEvent("themechange", { detail: { theme: next } }));
    });
  }

  if (header && !document.getElementById("continuum")) {
    addEventListener(
      "scroll",
      () => header.classList.toggle("is-scrolled", scrollY > 8),
      { passive: true }
    );
    header.classList.toggle("is-scrolled", scrollY > 8);
  }

  let searchIndex = [];

  const loadSearchIndex = async () => {
    try {
      const res = await fetch("/search-index.json");
      if (!res.ok) return;
      searchIndex = await res.json();
    } catch {
      searchIndex = [];
    }
  };

  const emptyHint = "输入文章标题关键词…";

  const openSearch = () => {
    if (!searchOverlay) return;
    searchOverlay.classList.add("is-open");
    document.body.style.overflow = "hidden";
    window.setTimeout(() => searchInput && searchInput.focus(), 120);
  };

  const closeSearch = () => {
    if (!searchOverlay) return;
    searchOverlay.classList.remove("is-open");
    document.body.style.overflow = "";
    if (searchInput) searchInput.value = "";
    if (searchResults) searchResults.textContent = emptyHint;
  };

  if (searchOpen) searchOpen.addEventListener("click", openSearch);
  if (searchClose) searchClose.addEventListener("click", closeSearch);

  if (searchOverlay) {
    searchOverlay.addEventListener("click", (event) => {
      if (event.target === searchOverlay) closeSearch();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSearch();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
    }
  });

  if (searchInput && searchResults) {
    loadSearchIndex();

    searchInput.addEventListener("input", () => {
      const value = searchInput.value.trim().toLowerCase();

      if (!value) {
        searchResults.textContent = emptyHint;
        return;
      }

      const hits = searchIndex.filter((item) =>
        String(item.title || "")
          .toLowerCase()
          .includes(value)
      );

      searchResults.innerHTML = hits.length
        ? hits
            .map(
              (item) =>
                `<div><a href="${item.url}"><strong>${item.title}</strong></a>${
                  item.category ? `<span class="search-cat">${item.category}</span>` : ""
                }</div>`
            )
            .join("")
        : "没有找到匹配标题。换一个更短的关键词试试。";
    });
  }

  if (year) year.textContent = String(new Date().getFullYear());
})();
