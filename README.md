# 🕷️ TypeScript Web Crawler (CLI)

A lightweight web crawler written in **TypeScript + Node.js** that respects `robots.txt`, uses a polite delay, and prioritizes URLs intelligently.  
This crawler can fetch HTML content, extract links, and avoid duplicate content using hashing.

---

## ✨ Features

- ✅ CLI input — asks user for URL at runtime
- ✅ Respects `robots.txt` rules (optional)
- ✅ Politeness delay between requests
- ✅ DNS resolution with caching
- ✅ Deduplication using content hashing (`SHA-256`)
- ✅ URL filtering (domain blacklist + safe extensions)
- ✅ Priority queue for frontier management
- ✅ Crawl depth + max page limit configurable

---

## 📦 Installation

1. Clone the repo:

```bash
git clone git@github.com:NalinDalal/crawler-bun.git
cd crawler-bun
```

2. Install dependencies:

```bash
bun install
```

3. Build (optional if running via `ts-node`):

```bash
bun run index.ts
```

You’ll be prompted:

```
Enter the URL to crawl:
```

Example:

```
Enter the URL to crawl: https://example.com
```

The crawler will then:

- Crawl up to **10 pages** (default, configurable in code)
- Follow links up to **depth 2**
- Print crawl results + statistics

---

## ⚙️ Configuration

Inside `crawler.ts`, you can tweak:

```ts
const crawler = new WebCrawler({
  maxPages: 10, // total pages to crawl
  maxDepth: 2, // max depth from seed URL
  politenessDelay: 1000, // ms delay between requests to same host
  timeout: 5000, // request timeout (ms)
  respectRobots: true, // obey robots.txt
});
```

---

## 📊 Example Output

```
Enter the URL to crawl: https://example.com
Starting crawl with 1 seed URLs...
Crawling: https://example.com (depth: 0)
Crawled: https://example.com - Found 12 links

✅ Crawl completed. Total pages crawled: 5

URL: https://example.com
Status: 200
Content Type: text/html
Links found: 12
Content hash: 3f7a82d9c1ab...

📊 Final Stats: {
  crawledPages: 5,
  visitedUrls: 5,
  queueSize: false
}
```

---

## 🛠️ Tech Stack

- [TypeScript](https://www.typescriptlang.org/)
- [Bun.js](https://bun.com/)
- [Cheerio](https://cheerio.js.org/) – HTML parsing
- [robots-parser](https://www.npmjs.com/package/robots-parser) – robots.txt support

---

## 📌 TODO / Future Improvements

- Add concurrency support (parallel crawling)
- Support for sitemap.xml parsing
- CLI flags for config (e.g., `--max-pages 50 --depth 3`)

---

## 📜 License

MIT © 2025 NalinDalal
