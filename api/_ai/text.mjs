export function safeString(value, length = 160) {
    return typeof value === 'string'
        ? value
              .slice(0, length)
              .split('')
              .map(c => (c.charCodeAt(0) < 32 && c !== '\n' ? ' ' : c))
              .join('')
              .trim()
        : '';
}
