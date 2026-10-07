export function parseRoute() {
  const [route, id, ...rest] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  return { route: route || 'overview', id: id ? decodeURIComponent(id) : null, rest: rest.map(decodeURIComponent) };
}

export const href = (route, id) => `#/${route}${id ? `/${encodeURIComponent(id)}` : ''}`;

export function go(route, id) {
  const next = href(route, id);
  if (location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = next;
}
