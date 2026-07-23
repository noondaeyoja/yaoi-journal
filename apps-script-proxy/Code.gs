/**
 * Yaoi Journal -- cross-reference proxy
 *
 * This Apps Script's only job is to fetch an Anime-Planet (or MangaGo) page
 * server-side and hand back a small JSON summary (cover URL, synopsis, tags,
 * author/artist, chapters, status, year). It doesn't store anything and
 * doesn't need to be bound to any spreadsheet -- a fresh standalone script at
 * script.google.com works fine.
 *
 * Deploy this as a Web App (Execute as: Me, Who has access: Anyone), then
 * paste the resulting /exec URL into the Yaoi Journal app's Settings.
 *
 * NOTE: cross-origin fetch() behavior from Apps Script web apps has some
 * historical quirks. If your phone's browser console shows a CORS error
 * when the app calls this, the fix is to redeploy the same logic as a
 * Cloudflare Worker instead (free tier, explicit CORS headers) -- ask for
 * that version if this one doesn't work for you.
 */

function doGet(e) {
  const action = e.parameter.action;
  if (action === 'fetchReference') {
    return jsonOut(fetchReference(e.parameter.url));
  }
  return jsonOut({ error: 'Unknown action. Use ?action=fetchReference&url=...' });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function fetchReference(url) {
  if (!url) return { error: 'Missing url parameter' };
  if (!/^https:\/\/(www\.)?(anime-planet\.com|mangago\.me)\//.test(url)) {
    return { error: 'Only anime-planet.com and mangago.me URLs are supported' };
  }
  let html;
  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
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
    .replace(/&amp;rsquo;|&rsquo;/g, "'")
    .replace(/&amp;ldquo;|&ldquo;/g, '"')
    .replace(/&amp;rdquo;|&rdquo;/g, '"')
    .replace(/&amp;mdash;|&mdash;/g, '--')
    .replace(/&amp;hellip;|&hellip;/g, '...')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseAnimePlanet(html, url) {
  const title = metaContent(html, 'og:title').replace(/\s*Manga\s*\|\s*Anime-Planet$/i, '').trim();
  const coverUrl = metaContent(html, 'og:image');
  let summary = metaContent(html, 'og:description');

  let altTitle = '';
  const altMatch = html.match(/Alt title:\s*<\/[a-z]+>?\s*([^<\n]+)/i) || html.match(/Alt title:\s*([^\n<]+)/i);
  if (altMatch) altTitle = decodeEntities(altMatch[1]).trim();

  const tagRe = /<a[^>]+href="https:\/\/www\.anime-planet\.com\/(?:manga|anime)\/tags\/[^"]+"[^>]*>([^<]+)<\/a>/g;
  const tags = [];
  let tm;
  while ((tm = tagRe.exec(html)) !== null) {
    const t = decodeEntities(tm[1]).trim();
    if (t && tags.indexOf(t) === -1) tags.push(t);
  }

  let author = '';
  const staffMatch = html.match(/([A-Za-z0-9 .'-]+)\s*<\/[a-z]+>?\s*(Original Creator|Story\s*&\s*Art|Author|Artist)/i);
  if (staffMatch) author = staffMatch[1].trim();

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
    chapters: null,
    year: null
  };
}

/**
 * Quick manual test -- run this from the Apps Script editor (select
 * testFetch from the function dropdown, click Run) to sanity-check parsing
 * without needing the deployed web app yet.
 */
function testFetch() {
  const result = fetchReference('https://www.anime-planet.com/manga/red-mansion');
  Logger.log(JSON.stringify(result, null, 2));
}
