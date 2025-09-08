import * as crypto from "crypto";
import * as dns from "dns";
import { promisify } from "util";
import * as cheerio from "cheerio";
import * as robotsParser from "robots-parser";
import * as readline from "readline";

// Types and Interfaces
interface CrawlConfig {
  maxPages: number;
  maxDepth: number;
  politenessDelay: number;
  timeout: number;
  userAgent: string;
  respectRobots: boolean;
}

interface URLInfo {
  url: string;
  priority: number;
  depth: number;
  host: string;
  timestamp: number;
}

interface CrawlResult {
  url: string;
  content: string;
  links: string[];
  statusCode: number;
  contentType: string;
  hash: string;
}

// DNS Resolver with caching
class DNSResolver {
  private cache: Map<string, string> = new Map();
  private resolve = promisify(dns.resolve4);

  async resolveHost(hostname: string): Promise<string> {
    if (this.cache.has(hostname)) {
      return this.cache.get(hostname)!;
    }

    try {
      const addresses = await this.resolve(hostname);
      const ip = addresses[0];
      this.cache.set(hostname, ip);
      return ip;
    } catch (error) {
      throw new Error(`DNS resolution failed for ${hostname}: ${error}`);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// Robots.txt Handler
class RobotsHandler {
  private robotsCache: Map<string, any> = new Map();

  async canCrawl(url: string, userAgent: string): Promise<boolean> {
    const urlObj = new URL(url);
    const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;

    if (!this.robotsCache.has(urlObj.host)) {
      try {
        const response = await fetch(robotsUrl);
        if (response.ok) {
          const robotsTxt = await response.text();
          const robots = robotsParser(robotsUrl, robotsTxt);
          this.robotsCache.set(urlObj.host, robots);
        } else {
          // If robots.txt doesn't exist, allow crawling
          this.robotsCache.set(urlObj.host, null);
        }
      } catch (error) {
        // If we can't fetch robots.txt, allow crawling
        this.robotsCache.set(urlObj.host, null);
      }
    }

    const robots = this.robotsCache.get(urlObj.host);
    return robots ? robots.isAllowed(url, userAgent) : true;
  }
}

// Content Storage
class ContentStorage {
  private storage: Map<string, CrawlResult> = new Map();
  private seenHashes: Set<string> = new Set();

  isContentSeen(hash: string): boolean {
    return this.seenHashes.has(hash);
  }

  store(result: CrawlResult): void {
    this.storage.set(result.url, result);
    this.seenHashes.add(result.hash);
  }

  get(url: string): CrawlResult | undefined {
    return this.storage.get(url);
  }

  getAllResults(): CrawlResult[] {
    return Array.from(this.storage.values());
  }
}

// URL Storage
class URLStorage {
  private visitedUrls: Set<string> = new Set();

  isURLSeen(url: string): boolean {
    return this.visitedUrls.has(url);
  }

  markAsVisited(url: string): void {
    this.visitedUrls.add(url);
  }

  getVisitedCount(): number {
    return this.visitedUrls.size;
  }
}

// Priority Queue for URL prioritization
class PriorityQueue<T> {
  private items: Array<{ item: T; priority: number }> = [];

  enqueue(item: T, priority: number): void {
    const queueElement = { item, priority };
    let added = false;

    for (let i = 0; i < this.items.length; i++) {
      if (queueElement.priority > this.items[i].priority) {
        this.items.splice(i, 0, queueElement);
        added = true;
        break;
      }
    }

    if (!added) {
      this.items.push(queueElement);
    }
  }

  dequeue(): T | undefined {
    return this.items.shift()?.item;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  size(): number {
    return this.items.length;
  }
}

// URL Frontier with politeness and prioritization
class URLFrontier {
  private frontQueues: Map<number, PriorityQueue<URLInfo>> = new Map();
  private backQueues: Map<string, URLInfo[]> = new Map();
  private hostToQueue: Map<string, string> = new Map();
  private lastAccessTime: Map<string, number> = new Map();
  private politenessDelay: number;

  constructor(politenessDelay: number = 1000) {
    this.politenessDelay = politenessDelay;

    // Initialize priority levels (0-4, where 4 is highest priority)
    for (let i = 0; i <= 4; i++) {
      this.frontQueues.set(i, new PriorityQueue<URLInfo>());
    }
  }

  addURL(urlInfo: URLInfo): void {
    // Add to front queue based on priority
    const queue =
      this.frontQueues.get(urlInfo.priority) || this.frontQueues.get(0)!;
    queue.enqueue(urlInfo, urlInfo.priority);
  }

  getNextURL(): URLInfo | null {
    // Select from front queues (higher priority first)
    for (let priority = 4; priority >= 0; priority--) {
      const queue = this.frontQueues.get(priority)!;
      if (!queue.isEmpty()) {
        const urlInfo = queue.dequeue()!;

        // Move to back queue for politeness
        if (!this.backQueues.has(urlInfo.host)) {
          this.backQueues.set(urlInfo.host, []);
        }
        this.backQueues.get(urlInfo.host)!.push(urlInfo);

        return this.getFromBackQueue();
      }
    }

    return this.getFromBackQueue();
  }

  private getFromBackQueue(): URLInfo | null {
    const now = Date.now();

    for (const [host, queue] of this.backQueues.entries()) {
      if (queue.length === 0) continue;

      const lastAccess = this.lastAccessTime.get(host) || 0;
      if (now - lastAccess >= this.politenessDelay) {
        const urlInfo = queue.shift()!;
        this.lastAccessTime.set(host, now);
        return urlInfo;
      }
    }

    return null;
  }

  isEmpty(): boolean {
    for (const queue of this.frontQueues.values()) {
      if (!queue.isEmpty()) return false;
    }

    for (const queue of this.backQueues.values()) {
      if (queue.length > 0) return false;
    }

    return true;
  }
}

// Content Parser
class ContentParser {
  parseHTML(html: string, baseUrl: string): { links: string[]; text: string } {
    const $ = cheerio.load(html);
    const links: string[] = [];
    const text = $.text();

    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      if (href) {
        try {
          const absoluteUrl = new URL(href, baseUrl).href;
          links.push(absoluteUrl);
        } catch (error) {
          // Invalid URL, skip
        }
      }
    });

    return { links, text };
  }

  generateContentHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }
}

// HTML Downloader
class HTMLDownloader {
  private dnsResolver: DNSResolver;
  private robotsHandler: RobotsHandler;
  private timeout: number;
  private userAgent: string;

  constructor(timeout: number = 5000, userAgent: string = "WebCrawler/1.0") {
    this.dnsResolver = new DNSResolver();
    this.robotsHandler = new RobotsHandler();
    this.timeout = timeout;
    this.userAgent = userAgent;
  }

  async download(
    url: string,
    respectRobots: boolean = true,
  ): Promise<CrawlResult> {
    // Check robots.txt
    if (
      respectRobots &&
      !(await this.robotsHandler.canCrawl(url, this.userAgent))
    ) {
      throw new Error(`Robots.txt disallows crawling: ${url}`);
    }

    // Resolve DNS
    const urlObj = new URL(url);
    await this.dnsResolver.resolveHost(urlObj.hostname);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        headers: {
          "User-Agent": this.userAgent,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.text();
      const contentType = response.headers.get("content-type") || "";

      return {
        url,
        content,
        links: [],
        statusCode: response.status,
        contentType,
        hash: crypto.createHash("sha256").update(content).digest("hex"),
      };
    } catch (error) {
      throw new Error(`Failed to download ${url}: ${error}`);
    }
  }
}

// URL Filter
class URLFilter {
  private blacklistedDomains: Set<string> = new Set();
  private allowedExtensions: Set<string> = new Set([
    ".html",
    ".htm",
    ".php",
    ".asp",
    ".jsp",
  ]);
  private maxUrlLength: number = 2000;

  constructor() {
    // Add some default blacklisted domains
    this.blacklistedDomains.add("spam.com");
    this.blacklistedDomains.add("malicious.com");
  }

  isValidURL(url: string): boolean {
    try {
      const urlObj = new URL(url);

      // Check URL length (avoid spider traps)
      if (url.length > this.maxUrlLength) {
        return false;
      }

      // Check blacklisted domains
      if (this.blacklistedDomains.has(urlObj.hostname)) {
        return false;
      }

      // Check file extensions
      const pathname = urlObj.pathname.toLowerCase();
      const hasExtension = pathname.includes(".");

      if (hasExtension) {
        const extension = pathname.substring(pathname.lastIndexOf("."));
        if (!this.allowedExtensions.has(extension)) {
          return false;
        }
      }

      // Only allow HTTP and HTTPS
      if (!["http:", "https:"].includes(urlObj.protocol)) {
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  }

  addBlacklistedDomain(domain: string): void {
    this.blacklistedDomains.add(domain);
  }
}

// Main Web Crawler
class WebCrawler {
  private config: CrawlConfig;
  private urlFrontier: URLFrontier;
  private htmlDownloader: HTMLDownloader;
  private contentParser: ContentParser;
  private contentStorage: ContentStorage;
  private urlStorage: URLStorage;
  private urlFilter: URLFilter;
  private crawledCount: number = 0;

  constructor(config: Partial<CrawlConfig> = {}) {
    this.config = {
      maxPages: 1000,
      maxDepth: 5,
      politenessDelay: 1000,
      timeout: 5000,
      userAgent: "WebCrawler/1.0",
      respectRobots: true,
      ...config,
    };

    this.urlFrontier = new URLFrontier(this.config.politenessDelay);
    this.htmlDownloader = new HTMLDownloader(
      this.config.timeout,
      this.config.userAgent,
    );
    this.contentParser = new ContentParser();
    this.contentStorage = new ContentStorage();
    this.urlStorage = new URLStorage();
    this.urlFilter = new URLFilter();
  }

  async crawl(seedUrls: string[]): Promise<CrawlResult[]> {
    console.log(`Starting crawl with ${seedUrls.length} seed URLs...`);

    // Add seed URLs to frontier
    for (const url of seedUrls) {
      if (this.urlFilter.isValidURL(url)) {
        const urlInfo: URLInfo = {
          url,
          priority: 4, // High priority for seed URLs
          depth: 0,
          host: new URL(url).hostname,
          timestamp: Date.now(),
        };
        this.urlFrontier.addURL(urlInfo);
      }
    }

    // Main crawl loop
    while (
      !this.urlFrontier.isEmpty() &&
      this.crawledCount < this.config.maxPages
    ) {
      const urlInfo = this.urlFrontier.getNextURL();

      if (!urlInfo) {
        // Wait a bit if no URLs are ready due to politeness
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      if (
        this.urlStorage.isURLSeen(urlInfo.url) ||
        urlInfo.depth > this.config.maxDepth
      ) {
        continue;
      }

      try {
        console.log(`Crawling: ${urlInfo.url} (depth: ${urlInfo.depth})`);

        // Download and parse content
        const result = await this.htmlDownloader.download(
          urlInfo.url,
          this.config.respectRobots,
        );

        // Check for duplicate content
        if (this.contentStorage.isContentSeen(result.hash)) {
          console.log(`Duplicate content found: ${urlInfo.url}`);
          this.urlStorage.markAsVisited(urlInfo.url);
          continue;
        }

        // Parse HTML content
        const { links, text } = this.contentParser.parseHTML(
          result.content,
          urlInfo.url,
        );
        result.links = links;

        // Store content and mark URL as visited
        this.contentStorage.store(result);
        this.urlStorage.markAsVisited(urlInfo.url);
        this.crawledCount++;

        // Add new URLs to frontier
        for (const link of links) {
          if (
            this.urlFilter.isValidURL(link) &&
            !this.urlStorage.isURLSeen(link)
          ) {
            const newUrlInfo: URLInfo = {
              url: link,
              priority: Math.max(0, urlInfo.priority - 1), // Decrease priority with depth
              depth: urlInfo.depth + 1,
              host: new URL(link).hostname,
              timestamp: Date.now(),
            };
            this.urlFrontier.addURL(newUrlInfo);
          }
        }

        console.log(`Crawled: ${urlInfo.url} - Found ${links.length} links`);
      } catch (error) {
        console.error(`Error crawling ${urlInfo.url}: ${error}`);
        this.urlStorage.markAsVisited(urlInfo.url);
      }
    }

    console.log(`Crawl completed. Total pages crawled: ${this.crawledCount}`);
    return this.contentStorage.getAllResults();
  }

  getStats(): {
    crawledPages: number;
    visitedUrls: number;
    queueSize: boolean;
  } {
    return {
      crawledPages: this.crawledCount,
      visitedUrls: this.urlStorage.getVisitedCount(),
      queueSize: this.urlFrontier.isEmpty(),
    };
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Ask for URL input
  const seedUrl: string = await new Promise((resolve) => {
    rl.question("Enter the URL to crawl: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!seedUrl) {
    console.error("❌ No URL provided. Exiting.");
    process.exit(1);
  }

  const crawler = new WebCrawler({
    maxPages: 10,
    maxDepth: 2,
    politenessDelay: 1000,
    timeout: 5000,
    respectRobots: true,
  });

  try {
    const results = await crawler.crawl([seedUrl]);
    console.log(`\n✅ Crawl completed. Total pages crawled: ${results.length}`);

    for (const result of results.slice(0, 5)) {
      // Show first 5 results
      console.log(`\nURL: ${result.url}`);
      console.log(`Status: ${result.statusCode}`);
      console.log(`Content Type: ${result.contentType}`);
      console.log(`Links found: ${result.links.length}`);
      console.log(`Content hash: ${result.hash.substring(0, 16)}...`);
    }

    const stats = crawler.getStats();
    console.log(`\n📊 Final Stats:`, stats);
  } catch (error) {
    console.error("❌ Crawl failed:", error);
  }
}

// Export classes for use in other modules
export {
  WebCrawler,
  DNSResolver,
  ContentParser,
  HTMLDownloader,
  URLFilter,
  ContentStorage,
  URLStorage,
  URLFrontier,
  UserInputHandler,
  CrawlConfig,
  CrawlResult,
  URLInfo,
};

// Run example if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}
