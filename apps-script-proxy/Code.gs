/**
 * Yaoi Journal — cross-reference proxy
 *
 * This Apps Script's only job is to fetch an Anime-Planet (or MangaGo) page
 * server-side and hand back a small JSON summary (cover URL, synopsis, tags,
 * author/artist, chapters, status, year). It doesn't store anything and
 * doesn't need to be bound to any spreadsheet — a fresh standalone script at
 * script.google.com works fine.
 *
 * Deploy this as a Web App (Execute as: Me, Who has access: Anyone), then
 * paste the resulting /exec URL into the Yaoi Journal app's Settings (⚙️).
 *
 * NOTE: cross-origin fetch() behavior from Apps Script web apps has some
 * historical quirks. If your phone's browser console shows a CORS error
 * when the app calls this, the fix is to redeploy the same logic as a
 * Cloudflare Worker instead (free tier, explicit CORS headers) — ask for
 * that version if this one doesn't work for you.
 */

function doGet(e) {
  const action = e.parameter.action;
  if (action === 'fetchReference') {
    return jsonOut(fetchReference(e.parameter.url));
  }
  if (action === 'searchMatch') {
    return jsonOut(searchMatch(e.parameter.title, e.parameter.site, e.parameter.kind));
  }
  return jsonOut({ error: 'Unknown action. Use ?action=fetchReference&url=... or ?action=searchMatch&title=...&site=anime-planet|mangago&kind=manga|anime' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Anime-Planet (and some CDNs in front of MangaGo) return HTTP 403 to
// requests that don't look like a real browser — Apps Script's default
// UrlFetchApp user agent gets blocked. Sending a normal desktop-browser
// User-Agent (and a couple of the headers a real browser sends) fixes that
// in most cases.
function browserFetchOptions() {
  return {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  };
}

/**
 * Best-effort "find it for me": searches the given site for a title and
 * fetches the top result's page so the app can offer it as a suggested
 * match, without the user needing to find and paste the URL themselves.
 * This is regex-based screen-scraping of a search results page, so it's
 * not bulletproof — if a site changes its markup this may need updating.
 */
function searchMatch(title, site, kind) {
  if (!title) return { error: 'Missing title parameter' };
  site = site === 'mangago' ? 'mangago' : 'anime-planet';
  kind = kind === 'anime' ? 'anime' : 'manga';
  try {
    if (site === 'mangago') {
      // MangaGo only has manga/manhwa content — there's nothing to search
      // for an anime-format entry here.
      if (kind === 'anime') return { error: 'MangaGo has no anime catalog' };
      const searchUrl = 'https://www.mangago.me/r/l_search/?name=' + encodeURIComponent(title);
      const resp = UrlFetchApp.fetch(searchUrl, browserFetchOptions());
      if (resp.getResponseCode() >= 400) return { error: 'MangaGo search returned HTTP ' + resp.getResponseCode() };
      const html = resp.getContentText();
      const m = html.match(/href="(https:\/\/www\.mangago\.me\/read-manga\/[a-z0-9_-]+\/)"/i);
      if (!m) return { error: 'No MangaGo results found for "' + title + '"' };
      const data = fetchReference(m[1]);
      if (!data.error) data.confidence = 'auto';
      return data;
    } else {
      const searchUrl = 'https://www.anime-planet.com/' + kind + '/all?name=' + encodeURIComponent(title);
      const resp = UrlFetchApp.fetch(searchUrl, browserFetchOptions());
      if (resp.getResponseCode() >= 400) return { error: 'Anime-Planet search returned HTTP ' + resp.getResponseCode() };
      const html = resp.getContentText();
      const m = html.match(new RegExp('href="(/' + kind + '/[a-z0-9-]+)"', 'i'));
      if (!m) return { error: 'No Anime-Planet results found for "' + title + '"' };
      const data = fetchReference('https://www.anime-planet.com' + m[1]);
      if (!data.error) data.confidence = 'auto';
      return data;
    }
  } catch (err) {
    return { error: 'Search failed: ' + err.message };
  }
}

function fetchReference(url) {
  if (!url) return { error: 'Missing url parameter' };
  if (!/^https:\/\/(www\.)?(anime-planet\.com|mangago\.me)\//.test(url)) {
    return { error: 'Only anime-planet.com and mangago.me URLs are supported' };
  }
  let html;
  try {
    const resp = UrlFetchApp.fetch(url, browserFetchOptions());
    if (resp.getResponseCode() >= 400) {
      return { error: 'Page returned HTTP ' + resp.getResponseCode() };
    }
    html = resp.getContentText();
  } catch (err) {
    return { error: 'Fetch failed: ' + err.message };
  }

  if (url.indexOf('anime-planet.com') > -1) return parseAnimePlanet(html, url);
  return parseMangago(html, url);
}

function metaContent(html, property) {
  // Matches <meta property="og:xxx" content="..."> in either attribute order.
  let re = new RegExp('<meta[^>]+(?:property|name)=["\']' + property + '["\'][^>]+content=["\']([^"\']*)["\']', 'i');
  let m = html.match(re);
  if (m) return decodeEntities(m[1]);
  re = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + property + '["\']', 'i');
  m = html.match(re);
  return m ? decodeEntities(m[1]) : '';
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;rsquo;|&rsquo;/g, "’")
    .replace(/&amp;ldquo;|&ldquo;/g, '“')
    .replace(/&amp;rdquo;|&rdquo;/g, '”')
    .replace(/&amp;mdash;|&mdash;/g, '—')
    .replace(/&amp;hellip;|&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseAnimePlanet(html, url) {
  // Anime pages end in "... Anime | Anime-Planet", manga pages in "... Manga | Anime-Planet" —
  // strip whichever suffix is present so both kinds of pages get a clean title.
  const title = metaContent(html, 'og:title').replace(/\s*(Manga|Anime)?\s*\|\s*Anime-Planet$/i, '').trim();
  const coverUrl = metaContent(html, 'og:image');
  let summary = metaContent(html, 'og:description');

  // Alt title appears as: ## Alt title: 레드 맨션
  let altTitle = '';
  const altMatch = html.match(/Alt title:\s*<\/[a-z]+>?\s*([^<\n]+)/i) || html.match(/Alt title:\s*([^\n<]+)/i);
  if (altMatch) altTitle = decodeEntities(altMatch[1]).trim();

  // Tags: links like /manga/tags/xxx or /anime/tags/xxx with visible text
  const tagRe = /<a[^>]+href="https:\/\/www\.anime-planet\.com\/(?:manga|anime)\/tags\/[^"]+"[^>]*>([^<]+)<\/a>/g;
  const tags = [];
  let tm;
  while ((tm = tagRe.exec(html)) !== null) {
    const t = decodeEntities(tm[1]).trim();
    if (t && tags.indexOf(t) === -1) tags.push(t);
  }

  // Staff: "**Name**Artist -" or "**Name**Original Creator -" style lines from the plain-text
  // rendering. Author and Artist are searched separately (instead of one
  // combined regex matching whichever label comes first) so both get
  // captured when the source lists them separately, instead of Artist
  // silently getting lost whenever Author happens to appear first.
  let author = '';
  const authorMatch = html.match(/([A-Za-z0-9 .'-]+)\s*<\/[a-z]+>?\s*(Original Creator|Story\s*&\s*Art|Author)(?!s)/i);
  if (authorMatch) author = authorMatch[1].trim();
  let artist = '';
  const artistMatch = html.match(/([A-Za-z0-9 .'-]+)\s*<\/[a-z]+>?\s*Artist/i);
  if (artistMatch) artist = artistMatch[1].trim();

  // Chapters / year / status, best-effort from visible text like "Ch: 50" and "2023 - 2025"
  let chapters = null;
  const chMatch = html.match(/Ch:\s*(\d+)/i);
  if (chMatch) chapters = Number(chMatch[1]);
  let year = null;
  const yearMatch = html.match(/(\d{4})\s*-\s*(\d{4}|\?{2,4})/);
  if (yearMatch) year = Number(yearMatch[1]);

  return {
    site: 'Anime-Planet',
    sourceUrl: url,
    title: title,
    altTitle: altTitle,
    coverUrl: coverUrl,
    summary: summary,
    tags: tags,
    author: author,
    artist: artist,
    chapters: chapters,
    year: year
  };
}

function parseMangago(html, url) {
  const title = metaContent(html, 'og:title');
  const coverUrl = metaContent(html, 'og:image');
  const summary = metaContent(html, 'og:description');
  return {
    site: 'MangaGo',
    sourceUrl: url,
    title: title,
    altTitle: '',
    coverUrl: coverUrl,
    summary: summary,
    tags: [],
    author: '',
    artist: '',
    chapters: null,
    year: null
  };
}

/**
 * Quick manual test — run this from the Apps Script editor (select
 * testFetch from the function dropdown, click Run) to sanity-check parsing
 * without needing the deployed web app yet.
 */
function testFetch() {
  const result = fetchReference('https://www.anime-planet.com/manga/red-mansion');
  Logger.log(JSON.stringify(result, null, 2));
}
