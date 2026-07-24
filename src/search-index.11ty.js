module.exports.data = () => ({
  permalink: "/search-index.json",
  eleventyExcludeFromCollections: true,
});

module.exports.render = function ({ collections }) {
  const items = (collections.writing || []).map((item) => {
    const isNote = item.data.kind === "note";
    const raw = String(item.templateContent || "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const excerpt =
      item.data.description ||
      (raw.length > 120 ? `${raw.slice(0, 120).trim()}…` : raw);

    return {
      title: item.data.title,
      url: isNote ? `/notes/#note-${item.data.number}` : item.url,
      category: isNote ? "短记" : item.data.category || "",
      excerpt,
      tags: item.data.tags || [],
    };
  });

  return JSON.stringify(items, null, 2);
};
