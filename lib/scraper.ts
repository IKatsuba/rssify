import { DOMParser } from "@b-fuze/deno-dom";

export async function scrape(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Rssify/1.0 (RSS Feed Generator)",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const html = await response.text();

  if (hasContent(html)) {
    return html;
  }

  return await scrapeWithBrowser(url);
}

export function hasContent(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const bodyText = doc?.body?.textContent?.trim() ?? "";
  return bodyText.length > 200;
}

async function scrapeWithBrowser(url: string): Promise<string> {
  const { launch } = await import("@astral/astral");
  const browser = await launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0" });
    const html = await page.evaluate(
      `document.documentElement.outerHTML`,
    ) as string;
    return html;
  } finally {
    await browser.close();
  }
}

export function parseHTML(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}
