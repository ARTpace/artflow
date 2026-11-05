export const MAX_ELEMENT_TAGS = 12;
export const ELEMENT_TAG_MAX_LENGTH = 24;

const compactText = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/** Canonical tag spelling is intentionally small and portable across v2 JSON documents. */
export const normalizeElementTag = (value: unknown): string | null => {
  const withoutHash = compactText(value).replace(/^#+\s*/, '').trim();
  if (!withoutHash) return null;
  const normalized = [...withoutHash.toLowerCase()].slice(0, ELEMENT_TAG_MAX_LENGTH).join('').trim();
  return normalized || null;
};

export const normalizeElementTags = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (tags.length >= MAX_ELEMENT_TAGS) break;
    const tag = normalizeElementTag(value);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
};

export const addElementTag = (existing: unknown, value: unknown): string[] => {
  const tags = normalizeElementTags(existing);
  const tag = normalizeElementTag(value);
  if (!tag || tags.length >= MAX_ELEMENT_TAGS || tags.includes(tag)) return tags;
  return [...tags, tag];
};

export const removeElementTag = (existing: unknown, value: unknown): string[] => {
  const tag = normalizeElementTag(value);
  const tags = normalizeElementTags(existing);
  return tag ? tags.filter(existingTag => existingTag !== tag) : tags;
};
