module.exports = function (eleventyConfig) {
  eleventyConfig.addGlobalData("currentYear", () =>
    String(new Date().getFullYear())
  );

  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy({ "src/favicon.ico": "favicon.ico" });

  eleventyConfig.addCollection("posts", (collectionApi) =>
    collectionApi.getFilteredByGlob("src/posts/*.md").sort((a, b) => b.date - a.date)
  );

  eleventyConfig.addCollection("notes", (collectionApi) =>
    collectionApi.getFilteredByGlob("src/notes/*.md").sort((a, b) => b.date - a.date)
  );

  eleventyConfig.addCollection("writing", (collectionApi) =>
    [
      ...collectionApi.getFilteredByGlob("src/posts/*.md"),
      ...collectionApi.getFilteredByGlob("src/notes/*.md"),
    ].sort((a, b) => b.date - a.date)
  );

  const dateParts = (dateObj) => {
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    return {
      year: d.getUTCFullYear(),
      month: String(d.getUTCMonth() + 1).padStart(2, "0"),
      day: String(d.getUTCDate()).padStart(2, "0"),
    };
  };

  eleventyConfig.addFilter("readableDate", (dateObj) => {
    const { year, month, day } = dateParts(dateObj);
    const y = year;
    const m = month;
    return `${y}.${m}.${day}`;
  });

  eleventyConfig.addFilter("shortDate", (dateObj) => {
    const { month, day } = dateParts(dateObj);
    return `${month}.${day}`;
  });

  eleventyConfig.addFilter("htmlDate", (dateObj) => {
    const { year, month, day } = dateParts(dateObj);
    return `${year}-${month}-${day}`;
  });

  eleventyConfig.addFilter("isoDate", (dateObj) => {
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    return d.toISOString();
  });

  eleventyConfig.addFilter("xmlEscape", (value) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );

  eleventyConfig.addFilter("publicTags", (tags) =>
    (tags || []).filter((tag) => tag !== "posts")
  );

  eleventyConfig.addFilter("padNum", (num, size = 3) =>
    String(num).padStart(size, "0")
  );

  eleventyConfig.addFilter("readingTime", (content) => {
    const text = String(content || "").replace(/<[^>]*>/g, "");
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const chars = text.replace(/\s/g, "").length;
    // 中文按字数估算，英文按词数；取较大值更稳妥
    const minutes = Math.max(1, Math.round(Math.max(words / 200, chars / 400)));
    return minutes;
  });

  eleventyConfig.addFilter("excerpt", (content, limit = 120) => {
    const text = String(content || "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit).trim()}…`;
  });

  eleventyConfig.addFilter("findByCategory", (posts, category) =>
    (posts || []).find((post) => post.data.category === category)
  );

  eleventyConfig.addFilter("filterByCategory", (posts, category) =>
    (posts || []).filter((post) => post.data.category === category)
  );

  eleventyConfig.addFilter("directionByKey", (items, key) =>
    (items || []).find((item) => item.key === key)
  );

  return {
    dir: {
      input: "src",
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    dataTemplateEngine: "njk",
  };
};
