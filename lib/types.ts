export interface FeedEntry {
  id: string;
  title: string;
  link: string;
  published: Date;
  summary?: string;
  content?: string;
  categories?: string[];
}

export interface FeedMeta {
  title: string;
  description: string;
  link: string;
  id: string;
  author: string;
}

export interface Provider {
  /** Namespace for routing, e.g. "blogs" */
  namespace: string;
  /** Route pattern within namespace, e.g. "claude-code" */
  route: string;
  /** Feed metadata */
  meta: FeedMeta;
  /** Fetch entries from the source */
  fetch(): Promise<FeedEntry[]>;
}
