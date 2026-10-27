/* eslint-disable unicorn/prefer-spread */

import jsdom from 'jsdom';

import type { Enclosure, JackettTorrent } from './types';
const { JSDOM } = jsdom;

const getElementText = (element: Element | null): string | undefined => element?.textContent?.trim();

const toNumber = (str?: string | null): number | undefined => {
  const n = str == undefined ? Number.NaN : Number(str);
  return Number.isFinite(n) ? n : undefined;
};

const getAttributeAsNumber = (element: Element | null | undefined, name: string): number | undefined => {
  const attribute = element?.getAttribute(name);
  return toNumber(attribute);
};

const parseCategories = (item: Element) => {
  const elements = item.querySelectorAll('category');
  return Array.from(elements)
    .map((category) => getElementText(category))
    .filter((str): str is string => !!str);
};

const parseEnclosure = (item: Element): Enclosure | undefined => {
  const element = item.querySelector('enclosure');
  return element
    ? {
        url: element.getAttribute('url') ?? '',
        length: getAttributeAsNumber(element, 'length'),
        type: element.getAttribute('type') ?? undefined,
      }
    : undefined;
};

// Robust torznab:attr selection:
// 1) Try CSS with escaped colon (works in most DOMs)
// 2) Fallback: inspect direct children and match by localName === "attr"
const selectTorznabAttributes = (item: Element): Element[] => {
  const torznabElements = item.querySelectorAll(String.raw`torznab\:attr, attr`);
  const attributes = Array.from(torznabElements);
  if (attributes.length > 0) return attributes;
  return Array.from(item.children).filter((child) => child.localName === 'attr');
};

const getTorznabAttributes = (item: Element) => {
  const attributes: Record<string, string> = {};
  for (const attribute of selectTorznabAttributes(item)) {
    const name = attribute.getAttribute('name');
    const value = attribute.getAttribute('value');
    if (name && value != undefined) attributes[name] = value;
  }
  return attributes;
};

const mapItemElementToTorrent = (item: Element): JackettTorrent => {
  const title = getElementText(item.querySelector('title'));
  const guid = getElementText(item.querySelector('guid'));
  const kind = getElementText(item.querySelector('type'));
  const comments = getElementText(item.querySelector('comments'));
  const pubDate = getElementText(item.querySelector('pubDate'));
  const size = toNumber(getElementText(item.querySelector('size')));
  const description = getElementText(item.querySelector('description'));
  const link = getElementText(item.querySelector('link'));
  const categories = parseCategories(item);
  const enclosure = parseEnclosure(item);
  const torznabAttributes = getTorznabAttributes(item);

  const jack = item.querySelector('jackettindexer');
  const indexer = getElementText(jack);
  const indexerId = jack?.getAttribute('id') ?? undefined;

  // Extract magnet URI from torznab attributes if available
  const magnetUrl = torznabAttributes.magneturl;

  return {
    title,
    guid,
    indexer,
    indexerId,
    type: kind,
    comments,
    pubDate,
    size,
    description,
    link,
    categories,
    enclosure,
    attributes: torznabAttributes,
    magnetUrl,
  };
};

export const parseSearchResponseXml = (xml: string): JackettTorrent[] => {
  try {
    const dom = new JSDOM(xml, { contentType: 'application/xml' });
    const document = dom.window.document;

    // Check for parse errors
    const parseError = document.querySelector('parsererror');
    if (parseError) {
      console.error('XML parse error:', parseError.textContent);
      return [];
    }

    const items = document.querySelectorAll('item');
    return Array.from(items).map((element) => mapItemElementToTorrent(element));
  } catch (error) {
    console.error('Failed to parse Jackett XML response:', error instanceof Error ? error.message : error);
    return [];
  }
};
