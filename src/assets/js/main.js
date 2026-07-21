(() => {
  const root = document.documentElement;
  const themeToggle = document.getElementById("themeToggle");
  const menuToggle = document.getElementById("menuToggle");
  const mobileMenu = document.getElementById("mobileMenu");
  const searchOverlay = document.getElementById("searchOverlay");
  const searchOpen = document.getElementById("searchOpen");
  const searchClose = document.getElementById("searchClose");
  const searchInput = document.getElementById("searchInput");
  const searchResults = document.getElementById("searchResults");
  const form = document.getElementById("subscribeForm");
  const formNote = document.getElementById("formNote");
  const clock = document.getElementById("clock");
  const year = document.getElementById("year");

  const savedTheme = localStorage.getItem("line-notes-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (savedTheme === "dark" || (!savedTheme && prefersDark)) {
    root.dataset.theme = "dark";
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      localStorage.setItem("line-notes-theme", next);
    });
  }

  if (menuToggle && mobileMenu) {
    menuToggle.addEventListener("click", () => {
      const open = mobileMenu.classList.toggle("is-open");
      menuToggle.setAttribute("aria-expanded", String(open));
    });

    mobileMenu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        mobileMenu.classList.remove("is-open");
        menuToggle.setAttribute("aria-expanded", "false");
      });
    });
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
    if (searchResults) {
      searchResults.textContent = "输入标题或标签关键词试试。";
    }
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
        searchResults.textContent = "输入标题或标签关键词试试。";
        return;
      }

      const hits = searchIndex.filter((item) => {
        const haystack = [item.title, item.excerpt, ...(item.tags || [])]
          .join(" ")
          .toLowerCase();
        return haystack.includes(value);
      });

      searchResults.innerHTML = hits.length
        ? hits
            .map(
              (item) =>
                `<div><a href="${item.url}"><strong>${item.title}</strong></a></div>`
            )
            .join("")
        : "没有找到结果。换一个更短的关键词试试。";
    });
  }

  if (form && formNote) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const email = document.getElementById("email");
      formNote.textContent = `已记录 ${email.value}。这是静态演示，不会真的发送邮件。`;
      email.value = "";
    });
  }

  const updateClock = () => {
    if (!clock) return;
    const text = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    clock.textContent = text;
  };

  updateClock();
  setInterval(updateClock, 30000);
  if (year) year.textContent = String(new Date().getFullYear());

  const cursor = document.getElementById("cursor");
  const finePointer = window.matchMedia("(pointer: fine)").matches;

  if (finePointer && cursor) {
    document.body.classList.add("cursor-ready");

    window.addEventListener("mousemove", (event) => {
      cursor.style.left = `${event.clientX}px`;
      cursor.style.top = `${event.clientY}px`;
      cursor.classList.add("is-visible");
    });

    document.querySelectorAll("a, button, input").forEach((el) => {
      el.addEventListener("mouseenter", () => cursor.classList.add("is-active"));
      el.addEventListener("mouseleave", () => cursor.classList.remove("is-active"));
    });

    window.addEventListener("mouseleave", () => cursor.classList.remove("is-visible"));
  }
})();
