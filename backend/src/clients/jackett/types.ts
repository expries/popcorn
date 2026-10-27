
export type Enclosure = {
  url: string;
  length?: number; // in bytes
  type?: string;
};

export type JackettTorrent = {
  title?: string;
  guid?: string;
  indexer?: string;
  indexerId?: string;
  type?: string;
  comments?: string;
  pubDate?: string;
  size?: number; // in bytes
  description?: string;
  link?: string;
  categories: string[];
  enclosure?: Enclosure;
  attributes: Record<string, string>; // torznab:attr (name: value)
  magnetUrl?: string; // Direct magnet URI if available
};
