'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { logError } = require('../../services/logService');
const { assertSafeUrl, publicOnlyLookup } = require('./ssrfGuard');

const MAX_REDIRECTS = 5;

const getFetchImplementation = () =>
    typeof fetch === 'function' ? fetch : null;

const fetchWithTimeout = async (url, options = {}, timeoutMs = 7000) => {
    const fetchFn = getFetchImplementation();
    if (!fetchFn) {
        throw new Error('Fetch API is not available in this environment');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchFn(url, {
            ...options,
            signal: controller.signal,
        });
        return response;
    } finally {
        clearTimeout(timeout);
    }
};

const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};

// Decodes the named entities above plus decimal (&#39;) and hex (&#x27;)
// character references in a single pass, so "&amp;lt;" stays "&lt;".
function decodeHtmlEntities(text) {
    return text.replace(
        /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
        (match, dec, hex, name) => {
            if (dec || hex) {
                const codePoint = dec ? parseInt(dec, 10) : parseInt(hex, 16);
                if (codePoint > 0 && codePoint <= 0x10ffff) {
                    return String.fromCodePoint(codePoint);
                }
                return match;
            }
            const decoded = NAMED_ENTITIES[name.toLowerCase()];
            return decoded === undefined ? match : decoded;
        }
    );
}

// Returns the content="..." of a <meta> tag whose `attr` is `value`, or null.
// The closing quote must match the opening one (backreference), so a
// double-quoted value can contain an apostrophe and vice versa.
function matchMetaContent(html, attr, value) {
    // attr and value are fixed strings from this file, never user input.
    const pattern = new RegExp(
        `<meta[^>]+${attr}=["']${value}["'][^>]+content=(["'])([\\s\\S]*?)\\1`,
        'i'
    );
    const match = html.match(pattern);
    return match && match[2] ? match[2] : null;
}

// Fast regex-based metadata extraction (much faster than cheerio for head content)
function extractMetadataFromHtml(html) {
    try {
        // Extract title with priority: og:title > twitter:title > title tag
        let title = null;

        // Try og:title first
        const ogTitleMatch = matchMetaContent(html, 'property', 'og:title');
        if (ogTitleMatch) {
            title = ogTitleMatch;
        } else {
            // Try twitter:title
            const twitterTitleMatch = matchMetaContent(
                html,
                'name',
                'twitter:title'
            );
            if (twitterTitleMatch) {
                title = twitterTitleMatch;
            } else {
                // Fallback to title tag
                const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
                if (titleMatch) {
                    title = titleMatch[1].trim();
                }
            }
        }

        if (title) {
            title = decodeHtmlEntities(title.trim());

            if (title.length > 100) {
                title = title.substring(0, 100) + '...';
            }
        }

        // Extract image with priority: og:image > twitter:image
        let image = null;
        const ogImageMatch = matchMetaContent(html, 'property', 'og:image');
        if (ogImageMatch) {
            image = ogImageMatch;
        } else {
            const twitterImageMatch = matchMetaContent(
                html,
                'name',
                'twitter:image'
            );
            if (twitterImageMatch) {
                image = twitterImageMatch;
            }
        }

        // Extract description
        let description = null;
        const ogDescMatch = matchMetaContent(
            html,
            'property',
            'og:description'
        );
        if (ogDescMatch) {
            description = ogDescMatch;
        } else {
            const twitterDescMatch = matchMetaContent(
                html,
                'name',
                'twitter:description'
            );
            if (twitterDescMatch) {
                description = twitterDescMatch;
            } else {
                const metaDescMatch = matchMetaContent(
                    html,
                    'name',
                    'description'
                );
                if (metaDescMatch) {
                    description = metaDescMatch;
                }
            }
        }

        if (image) image = decodeHtmlEntities(image);
        if (description) description = decodeHtmlEntities(description);

        if (description && description.length > 150) {
            description = description.substring(0, 150) + '...';
        }

        return {
            title,
            image,
            description,
        };
    } catch (error) {
        logError('Error parsing HTML:', error);
        return { title: null, image: null, description: null };
    }
}

// Helper function to resolve relative URLs to absolute URLs
function resolveUrl(baseUrl, relativeUrl) {
    try {
        return new URL(relativeUrl, baseUrl).href;
    } catch {
        return relativeUrl;
    }
}

// Helper function to handle YouTube URLs specially
function handleYouTubeUrl(url) {
    const youtubeRegex =
        /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(youtubeRegex);

    if (match) {
        const videoId = match[1];

        // For now, return basic YouTube info - this is fast and reliable
        return {
            title: 'YouTube Video',
            image: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
            description: 'YouTube video',
        };
    }

    return null;
}

const finalizeMetadata = (metadata, sourceUrl) => {
    if (!metadata) {
        return null;
    }

    const enriched = { ...metadata };

    if (
        enriched.image &&
        !enriched.image.startsWith('http') &&
        !enriched.image.startsWith('//')
    ) {
        enriched.image = resolveUrl(sourceUrl, enriched.image);
    }

    if (!enriched.title) {
        try {
            enriched.title = new URL(sourceUrl).hostname;
        } catch {
            enriched.title = sourceUrl;
        }
    }

    return enriched;
};

// The metadata fetch uses Node's http/https clients rather than fetch() so
// the connection can be pinned: publicOnlyLookup re-resolves the host when
// the socket opens and refuses a private address, which closes the gap
// between assertSafeUrl's DNS check and the request (DNS rebinding).
function fetchMetadataViaHttp(normalizedUrl, maxRedirects = MAX_REDIRECTS) {
    return new Promise((resolve) => {
        let finished = false;
        const fallbackResolve = (metadata, sourceUrl = normalizedUrl) => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(globalTimeout);
            resolve(finalizeMetadata(metadata, sourceUrl));
        };

        const globalTimeout = setTimeout(() => {
            fallbackResolve(null);
        }, 6000);

        function makeRequest(currentUrl, redirectCount = 0) {
            if (redirectCount > maxRedirects) {
                clearTimeout(globalTimeout);
                fallbackResolve(null);
                return;
            }

            assertSafeUrl(currentUrl)
                .then(() => performRequest(currentUrl, redirectCount))
                .catch((error) => {
                    logError('Blocked unsafe URL for metadata fetch:', error);
                    clearTimeout(globalTimeout);
                    fallbackResolve(null);
                });
        }

        function performRequest(currentUrl, redirectCount) {
            try {
                const urlObj = new URL(currentUrl);
                const isHttps = urlObj.protocol === 'https:';
                const client = isHttps ? https : http;

                const options = {
                    hostname: urlObj.hostname,
                    port: urlObj.port || (isHttps ? 443 : 80),
                    path: urlObj.pathname + urlObj.search || '/',
                    method: 'GET',
                    timeout: 4000,
                    lookup: publicOnlyLookup,
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    },
                };

                const req = client.request(options, (res) => {
                    let resolvedForRequest = false;
                    const conclude = (metadata) => {
                        if (resolvedForRequest) {
                            return;
                        }
                        resolvedForRequest = true;
                        fallbackResolve(metadata, currentUrl);
                    };

                    if (
                        [301, 302, 303, 307, 308].includes(res.statusCode) &&
                        res.headers.location
                    ) {
                        // This callback runs outside any try/catch or
                        // promise chain, so a Location the URL parser
                        // rejects (e.g. "http://[") would otherwise throw
                        // uncaught and take the whole process down.
                        let redirectUrl;
                        try {
                            redirectUrl = new URL(
                                res.headers.location,
                                currentUrl
                            ).href;
                        } catch {
                            res.resume();
                            conclude(null);
                            return;
                        }
                        res.resume();
                        makeRequest(redirectUrl, redirectCount + 1);
                        return;
                    }

                    if (res.statusCode < 200 || res.statusCode >= 400) {
                        conclude(null);
                        return;
                    }

                    const contentType = res.headers['content-type'];
                    if (contentType && !contentType.includes('text/html')) {
                        res.resume();
                        conclude(null);
                        return;
                    }

                    let data = '';
                    let totalBytes = 0;
                    const maxBytes = 40000;
                    let foundMeta = false;

                    res.on('data', (chunk) => {
                        totalBytes += chunk.length;
                        if (totalBytes > maxBytes) {
                            res.destroy();
                            conclude(extractMetadataFromHtml(data));
                            return;
                        }
                        data += chunk;

                        if (
                            !foundMeta &&
                            (data.includes('og:title') ||
                                data.includes('twitter:title') ||
                                data.includes('</title>'))
                        ) {
                            foundMeta = true;
                        }

                        if (foundMeta && data.includes('</head>')) {
                            res.destroy();
                            conclude(extractMetadataFromHtml(data));
                        }
                    });

                    res.on('end', () => {
                        conclude(extractMetadataFromHtml(data));
                    });
                    res.on('error', () => {
                        conclude(null);
                    });
                });

                req.on('error', () => {
                    fallbackResolve(null);
                });

                req.on('timeout', () => {
                    req.destroy();
                    fallbackResolve(null);
                });

                req.end();
            } catch (error) {
                clearTimeout(globalTimeout);
                fallbackResolve(null);
            }
        }

        makeRequest(normalizedUrl);
    });
}

async function fetchMetadataViaProxy(normalizedUrl) {
    const fetchFn = getFetchImplementation();
    if (!fetchFn) {
        return null;
    }

    const proxiedUrl = `https://r.jina.ai/${normalizedUrl}`;

    const response = await fetchWithTimeout(
        proxiedUrl,
        {
            method: 'GET',
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml',
            },
        },
        7000
    );

    if (!response || !response.ok) {
        return null;
    }

    const html = await response.text();
    if (!html) {
        return null;
    }

    return finalizeMetadata(extractMetadataFromHtml(html), normalizedUrl);
}

// Helper function to fetch URL metadata with proper redirect/timeout handling
async function fetchUrlMetadata(url) {
    if (!url) {
        return null;
    }

    let normalizedUrl = url.trim();
    if (
        !normalizedUrl.startsWith('http://') &&
        !normalizedUrl.startsWith('https://')
    ) {
        normalizedUrl = `https://${normalizedUrl}`;
    }

    try {
        const parsedUrl = new URL(normalizedUrl);
        const hostname = parsedUrl.hostname.toLowerCase();

        if (
            hostname === 'youtube.com' ||
            hostname.endsWith('.youtube.com') ||
            hostname === 'youtu.be'
        ) {
            const youtubeMetadata = handleYouTubeUrl(normalizedUrl);
            if (youtubeMetadata) {
                return youtubeMetadata;
            }
        }
    } catch (error) {
        logError('Error parsing URL for YouTube check:', error);
    }

    try {
        await assertSafeUrl(normalizedUrl);
    } catch (error) {
        logError('Blocked unsafe URL for metadata fetch:', error);
        return null;
    }

    const httpMetadata = await fetchMetadataViaHttp(normalizedUrl);
    if (httpMetadata) {
        return httpMetadata;
    }

    try {
        const proxyMetadata = await fetchMetadataViaProxy(normalizedUrl);
        if (proxyMetadata) {
            return proxyMetadata;
        }
    } catch (error) {
        logError('Error fetching URL metadata via proxy:', error);
    }

    return null;
}

class UrlService {
    async getTitle(url) {
        if (!url) {
            return { error: 'URL parameter is required' };
        }

        const metadata = await fetchUrlMetadata(url);

        if (metadata && metadata.title) {
            return {
                url,
                title: metadata.title,
                image: metadata.image,
                description: metadata.description,
            };
        } else {
            return {
                url,
                title: null,
                image: null,
                description: null,
                error: 'Could not extract metadata',
            };
        }
    }

    async extractFromText(text) {
        if (!text) {
            return { error: 'Text parameter is required' };
        }

        // Enhanced URL extraction - look for URLs with or without protocol
        const urlWithProtocolRegex = /(https?:\/\/[^\s]+)/gi;
        const urlWithoutProtocolRegex =
            /(?:^|\s)((?:www\.)?[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,5}(?::[0-9]{1,5})?(?:\/[^\s]*)?)/gi;

        let urls = text.match(urlWithProtocolRegex);

        // If no URLs with protocol found, look for URLs without protocol
        if (!urls) {
            const matches = text.match(urlWithoutProtocolRegex);
            if (matches) {
                // Clean up the matches (remove leading whitespace)
                urls = matches.map((match) => match.trim());
            }
        }

        if (urls && urls.length > 0) {
            const firstUrl = urls[0];
            const metadata = await fetchUrlMetadata(firstUrl);

            if (metadata && metadata.title) {
                return {
                    found: true,
                    url: firstUrl,
                    title: metadata.title,
                    image: metadata.image,
                    description: metadata.description,
                    originalText: text,
                };
            } else {
                return {
                    found: true,
                    url: firstUrl,
                    title: null,
                    image: null,
                    description: null,
                    originalText: text,
                };
            }
        } else {
            return { found: false };
        }
    }
}

module.exports = new UrlService();
