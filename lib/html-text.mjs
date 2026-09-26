// Readable text from a fetched web page, for adding a URL to persona knowledge.
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decode = text => text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code) => code[0] === '#' ? String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))) : entities[code.toLowerCase()] ?? match);

export function htmlToText(html) {
  const title = decode((String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim());
  const body = decode(String(html)
    .replace(/<(head|script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: title.replace(/\s+/g, ' ').slice(0, 100), text: body };
}
