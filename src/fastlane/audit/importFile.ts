/**
 * Reads a saved IDA file locally. Nothing is uploaded: PDF.js (bundled, Apache-2.0) runs in this page.
 */
import { parseAuditHtml, parseAuditText } from './parseAudit';
import type { ParsedAudit } from './types';

export const MAX_AUDIT_BYTES = 15 * 1024 * 1024;

/** Groups PDF.js text items into visual lines (same y within a small tolerance), left to right. */
export function itemsToLines(items: Array<{ str: string; transform: number[] }>): string[] {
    const rows: Array<{ y: number; parts: Array<{ x: number; s: string }> }> = [];
    for (const item of items) {
        if (!item.str.trim()) continue;
        const x = item.transform[4] ?? 0;
        const y = item.transform[5] ?? 0;
        let row = rows.find(r => Math.abs(r.y - y) < 2.5);
        if (!row) {
            row = { y, parts: [] };
            rows.push(row);
        }
        row.parts.push({ x, s: item.str });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map(r =>
        r.parts
            .sort((a, b) => a.x - b.x)
            .map(p => p.s)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
}

async function pdfLines(buffer: ArrayBuffer): Promise<string[]> {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true })
        .promise;
    const lines: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        lines.push(...itemsToLines(content.items as Array<{ str: string; transform: number[] }>));
    }
    await doc.destroy();
    return lines;
}

export async function importAuditFile(file: File): Promise<ParsedAudit> {
    if (file.size > MAX_AUDIT_BYTES)
        throw new Error('That file is larger than 15 MB. Save only the audit results page.');
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) {
        return parseAuditText(await pdfLines(await file.arrayBuffer()), file.name);
    }
    if (/\.(html?|mhtml?)$/i.test(file.name) || file.type.includes('html')) {
        const text = await file.text();
        // DOMParser does not execute scripts or load resources from the saved page
        const doc = new DOMParser().parseFromString(text, 'text/html');
        return parseAuditHtml(doc, file.name);
    }
    throw new Error('Choose the audit saved as a PDF or as an HTML page (.html).');
}
