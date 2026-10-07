import en from './locales/en.js';
import ar from './locales/ar.js';

export const copy = { en, ar };

const cache = {};

// Missing Arabic strings fall back to English, and missing keys fall back to the key itself.
export function translator(locale) {
  cache[locale] ||= new Proxy(copy[locale] || en, {
    get: (target, key) => (typeof key === 'string' ? target[key] ?? en[key] ?? key : undefined),
  });
  return cache[locale];
}
