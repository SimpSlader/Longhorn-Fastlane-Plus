import { parseHtml, withoutInlineHandlers } from '@shared/util/parseHtml';
import { describe, expect, it } from 'vitest';

describe('inert HTML parsing', () => {
    it('removes every inline event handler but keeps content and other attributes', () => {
        const html =
            '<body onload="x()"><a href="#c" class=link onclick=\'go(1)\' onmouseover=hi>Course</a><img src="a.png" onerror="y()"></body>';
        const out = withoutInlineHandlers(html);
        expect(out).not.toMatch(/\son[a-z]+=/i);
        const doc = parseHtml(html);
        const a = doc.querySelector('a');
        expect(a?.getAttribute('href')).toBe('#c');
        expect(a?.className).toBe('link');
        expect(a?.textContent).toBe('Course');
        expect(doc.querySelector('img')?.getAttribute('src')).toBe('a.png');
    });

    it('leaves text that merely mentions onclick alone', () => {
        expect(withoutInlineHandlers('<p>Use onclick= in text</p>')).toBe('<p>Use onclick= in text</p>');
    });
});
