module.exports.data = () => ({
  permalink: "/search-index.json",
  eleventyExcludeFromCollections: true,
});

module.exports.render = function ({ collections }) {
  const items = (collections.posts || []).map((post) => {
    const raw = String(post.templateContent || "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const excerpt =
      post.data.description ||
      (raw.length > 120 ? `${raw.slice(0, 120).trim()}…` : raw);

    return {
      title: post.data.title,
      url: post.url,
      category: post.data.category || "",
      excerpt,
      tags: post.data.tags || [],
    };
  });

  return JSON.stringify(items, null, 2);
};
