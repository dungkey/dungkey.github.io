const fs = require("node:fs");
const path = require("node:path");
const site = require("../src/_data/site.json");

const outputDir = path.resolve(__dirname, "..", "_site");

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });

const files = walk(outputDir);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const problems = [];
const pageTitles = new Map();
let referencesChecked = 0;

const routeForHtml = (file) => {
  const relative = path.relative(outputDir, file).split(path.sep).join("/");
  if (relative === "index.html") return "/";
  if (relative.endsWith("/index.html")) {
    return `/${relative.replace(/index\.html$/, "")}`;
  }
  return `/${relative}`;
};

const targetForUrl = (value, sourceFile) => {
  const relativeSource = path.relative(outputDir, sourceFile).split(path.sep).join("/");
  const sourceUrl = `https://site.test/${relativeSource.replace(/index\.html$/, "")}`;
  const url = new URL(value, sourceUrl);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  const target = path.resolve(outputDir, `.${pathname}`);
  const isInsideOutput =
    target === outputDir || target.startsWith(`${outputDir}${path.sep}`);
  return {
    file: isInsideOutput ? target : null,
    hash: decodeURIComponent(url.hash.slice(1)),
  };
};

for (const htmlFile of htmlFiles) {
  const html = fs.readFileSync(htmlFile, "utf8");
  const relative = path.relative(outputDir, htmlFile);
  const route = routeForHtml(htmlFile);

  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map(
    (match) => match[1]
  );
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) {
    problems.push(`${relative}: duplicate ids ${[...new Set(duplicateIds)].join(", ")}`);
  }

  for (const required of [
    /<html\b[^>]*\blang=/i,
    /<meta\b[^>]*\bname=["']description["']/i,
    /<link\b[^>]*\brel=["']canonical["']/i,
    /<main\b/i,
  ]) {
    if (!required.test(html)) {
      problems.push(`${relative}: missing ${required}`);
    }
  }

  const titles = [...html.matchAll(/<title>([\s\S]*?)<\/title>/gi)].map((match) =>
    match[1].trim()
  );
  if (titles.length !== 1 || !titles[0]) {
    problems.push(`${relative}: expected one non-empty title`);
  } else if (pageTitles.has(titles[0])) {
    problems.push(`${relative}: duplicate page title with ${pageTitles.get(titles[0])}`);
  } else {
    pageTitles.set(titles[0], relative);
  }

  const canonicalMatches = [
    ...html.matchAll(/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi),
  ];
  const expectedCanonical = `${site.url}${route}`;
  if (canonicalMatches.length !== 1 || canonicalMatches[0][1] !== expectedCanonical) {
    problems.push(`${relative}: canonical must be ${expectedCanonical}`);
  }

  if (!/<link\b[^>]*\brel=["']alternate["'][^>]*application\/atom\+xml/i.test(html)) {
    problems.push(`${relative}: missing Atom feed discovery`);
  }

  if (route === "/404.html" && !/<meta\b[^>]*content=["']noindex, nofollow["']/i.test(html)) {
    problems.push(`${relative}: 404 page must be noindex`);
  }

  const references = html.matchAll(/\b(?:href|src|poster|action)=["']([^"']+)["']/gi);
  for (const [, value] of references) {
    if (/^(?:[a-z]+:|\/\/)/i.test(value)) continue;
    const { file, hash } = targetForUrl(value, htmlFile);
    referencesChecked += 1;

    if (!file || !fs.existsSync(file)) {
      problems.push(`${relative}: broken reference ${value}`);
      continue;
    }

    if (hash && file.endsWith(".html")) {
      const targetHtml = fs.readFileSync(file, "utf8");
      const escaped = hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`\\bid=["']${escaped}["']`).test(targetHtml)) {
        problems.push(`${relative}: missing anchor ${value}`);
      }
    }
  }

  for (const [, srcset] of html.matchAll(/\bsrcset=["']([^"']+)["']/gi)) {
    for (const candidate of srcset.split(",")) {
      const value = candidate.trim().split(/\s+/)[0];
      if (!value || /^(?:data:|[a-z]+:|\/\/)/i.test(value)) continue;
      const target = targetForUrl(value, htmlFile).file;
      referencesChecked += 1;
      if (!target || !fs.existsSync(target)) {
        problems.push(`${relative}: broken srcset reference ${value}`);
      }
    }
  }
}

const postRoutes = htmlFiles
  .map(routeForHtml)
  .filter((route) => route.startsWith("/posts/"));
const notesFile = path.join(outputDir, "notes", "index.html");
const noteRoutes = fs.existsSync(notesFile)
  ? [...fs.readFileSync(notesFile, "utf8").matchAll(/\bid=["'](note-[^"']+)["']/g)].map(
      (match) => `/notes/#${match[1]}`
    )
  : [];
const contentRoutes = [...postRoutes, ...noteRoutes];

const indexFile = path.join(outputDir, "search-index.json");
try {
  const searchIndex = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  if (!Array.isArray(searchIndex) || searchIndex.length === 0) {
    problems.push("search-index.json: expected at least one article");
  } else {
    for (const [index, item] of searchIndex.entries()) {
      if (!item || typeof item !== "object") {
        problems.push(`search-index.json: item ${index} is not an object`);
        continue;
      }
      if (typeof item.title !== "string" || !item.title.trim()) {
        problems.push(`search-index.json: item ${index} has no title`);
      }
      if (!Array.isArray(item.tags)) {
        problems.push(`search-index.json: item ${index} tags must be an array`);
      }
      if (typeof item.category !== "string" || typeof item.excerpt !== "string") {
        problems.push(`search-index.json: item ${index} category/excerpt must be strings`);
      }
      if (typeof item.url !== "string") {
        problems.push(`search-index.json: item ${index} has no URL`);
        continue;
      }
      const resolved = targetForUrl(item.url, path.join(outputDir, "index.html"));
      const target = resolved.file;
      referencesChecked += 1;
      if (!target || !fs.existsSync(target)) {
        problems.push(`search-index.json: item ${index} URL is broken (${item.url})`);
      } else if (resolved.hash && target.endsWith(".html")) {
        const html = fs.readFileSync(target, "utf8");
        const escaped = resolved.hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!new RegExp(`\\bid=["']${escaped}["']`).test(html)) {
          problems.push(`search-index.json: item ${index} anchor is broken (${item.url})`);
        }
      }
    }

    const indexedUrls = searchIndex.map((item) => item?.url).filter(Boolean);
    if (new Set(indexedUrls).size !== indexedUrls.length) {
      problems.push("search-index.json: duplicate article URLs");
    }
    if (
      JSON.stringify([...indexedUrls].sort()) !== JSON.stringify([...contentRoutes].sort())
    ) {
      problems.push("search-index.json: URLs do not match generated content");
    }
  }
} catch (error) {
  problems.push(`search-index.json: ${error.message}`);
}

for (const requiredFile of ["404.html", "feed.xml", "sitemap.xml", "robots.txt"]) {
  if (!fs.existsSync(path.join(outputDir, requiredFile))) {
    problems.push(`missing publishing artifact: ${requiredFile}`);
  }
}

const publicUrls = htmlFiles
  .map(routeForHtml)
  .filter((route) => route !== "/404.html")
  .map((route) => `${site.url}${route}`)
  .sort();

try {
  const sitemap = fs.readFileSync(path.join(outputDir, "sitemap.xml"), "utf8");
  const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1])
    .sort();
  if (JSON.stringify(sitemapUrls) !== JSON.stringify(publicUrls)) {
    problems.push("sitemap.xml: URLs do not match generated public pages");
  }
} catch (error) {
  problems.push(`sitemap.xml: ${error.message}`);
}

try {
  const feed = fs.readFileSync(path.join(outputDir, "feed.xml"), "utf8");
  const entryUrls = [...feed.matchAll(/<entry>[\s\S]*?<link href="([^"]+)"[\s\S]*?<\/entry>/g)]
    .map((match) => match[1])
    .sort();
  const contentUrls = contentRoutes.map((route) => `${site.url}${route}`).sort();
  if (JSON.stringify(entryUrls) !== JSON.stringify(contentUrls)) {
    problems.push("feed.xml: entries do not match generated content");
  }
} catch (error) {
  problems.push(`feed.xml: ${error.message}`);
}

try {
  const robots = fs.readFileSync(path.join(outputDir, "robots.txt"), "utf8");
  if (!robots.includes(`Sitemap: ${site.url}/sitemap.xml`)) {
    problems.push("robots.txt: missing sitemap declaration");
  }
} catch (error) {
  problems.push(`robots.txt: ${error.message}`);
}

for (const assetFile of files.filter((file) => /\.(?:js|css)$/.test(file))) {
  const source = fs.readFileSync(assetFile, "utf8");
  const relative = path.relative(outputDir, assetFile);
  const values = [];

  if (assetFile.endsWith(".js")) {
    for (const match of source.matchAll(
      /["'](\/[^"']+\.(?:json|mp3|png|webp|svg|ico|woff2?))["']/gi
    )) {
      values.push(match[1]);
    }
  } else {
    for (const match of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      values.push(match[1]);
    }
  }

  for (const value of values) {
    if (/^(?:data:|https?:|\/\/)/i.test(value)) continue;
    const target = targetForUrl(value, assetFile).file;
    referencesChecked += 1;
    if (!target || !fs.existsSync(target)) {
      problems.push(`${relative}: broken runtime reference ${value}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Site smoke check passed: ${htmlFiles.length} pages, ${referencesChecked} local references.`
  );
}
