export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// Splits on paragraph boundaries into ~size character chunks with a small overlap for context.
export function chunkText(text: string, size = 1200, overlap = 200, maxChunks = 400) {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if ((current + '\n\n' + paragraph).length > size && current) {
      chunks.push(current);
      current = current.slice(-overlap);
    }
    if (paragraph.length > size) {
      for (let index = 0; index < paragraph.length; index += size - overlap) chunks.push(paragraph.slice(index, index + size));
      current = '';
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    if (chunks.length >= maxChunks) break;
  }
  if (current.trim() && chunks.length < maxChunks) chunks.push(current);
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 20);
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.internal$|.*\.local$)/i;

export function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || PRIVATE_HOST.test(url.hostname)) throw new Error('Only public http(s) URLs are allowed');
  return url;
}
