module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy({ "src/favicon.ico": "favicon.ico" });

  eleventyConfig.addCollection("posts", (collectionApi) =>
    collectionApi.getFilteredByGlob("src/posts/*.md").sort((a, b) => b.date - a.date)
  );

  eleventyConfig.addCollection("notes", (collectionApi) =>
    collectionApi.getFilteredByGlob("src/notes/*.md").sort((a, b) => b.date - a.date)
  );

  eleventyConfig.addFilter("readableDate", (dateObj) => {
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}.${m}.${day}`;
  });

  eleventyConfig.addFilter("shortDate", (dateObj) => {
    const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${m}.${day}`;
  });

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
