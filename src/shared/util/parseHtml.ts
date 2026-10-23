/**
 * Parses fetched HTML (UT pages, IDA files) into an inert Document.
 *
 * DOMParser never runs scripts or event handlers, but Chrome still reports every inline `on*="…"`
 * attribute it parses as a Content Security Policy violation on extension pages. Removing those
 * attributes first keeps the console clean; the scrapers only read text and structure.
 */
const INLINE_HANDLER = /(<[a-z][^>]*?)\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

export function withoutInlineHandlers(html: string): string {
    let out = html;
    // a tag can carry several handlers; each pass removes one per tag
    for (let prev = ''; prev !== out; ) {
        prev = out;
        out = out.replace(INLINE_HANDLER, '$1');
    }
    return out;
}

export function parseHtml(html: string): Document {
    return new DOMParser().parseFromString(withoutInlineHandlers(html), 'text/html');
}
