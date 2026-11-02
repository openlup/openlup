export type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, ...children);
  return node;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function link(text: string, href: string, className?: string): HTMLAnchorElement {
  if (!href.startsWith('/') || href.startsWith('//')) throw new Error('starter_link_not_local');
  return el('a', { href, class: className }, text);
}

export function button(text: string, run: () => void | Promise<void>, className?: string): HTMLButtonElement {
  const node = el('button', { type: 'button', class: className }, text);
  node.addEventListener('click', () => { void run(); });
  return node;
}

/** Render responses as text nodes; provider prose, HTML and URLs are never executed. */
export function renderValue(value: unknown, depth = 0): HTMLElement {
  if (depth > 8) return el('span', {}, '…');
  if (value === null || value === undefined) return el('span', { class: 'muted' }, '—');
  if (typeof value !== 'object') return el('span', {}, String(value));
  if (Array.isArray(value)) {
    return el('ol', { class: 'response-list' }, ...value.slice(0, 100).map(item =>
      el('li', {}, renderValue(item, depth + 1))));
  }
  const list = el('dl', { class: 'response-fields' });
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    append(list, el('dt', {}, key), el('dd', {}, renderValue(item, depth + 1)));
  }
  return list;
}
