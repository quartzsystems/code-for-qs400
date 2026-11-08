// Copyright (C), 2026 Quartz Systems. Some rights reserved. This work is
// licensed under the terms of the MIT license which can be found in the
// root directory of this project.

/**
 * How the spooled file viewer lays out `spool.readText`'s text, without
 * `vscode`: the server puts a form feed between pages; the viewer puts an
 * empty line before each page instead, which a decoration shows as
 * `— page n —`. No printed line gains or loses a character, so columns stay
 * exact, and a search finds the text as printed. The marker lines are
 * where the pages start, which is what the status bar and **Go to page…**
 * use.
 */

/** The form feed between two pages. */
export const FORM_FEED = '\f';

/** The pages read at first of a file of [`LARGE_FILE`] pages or more. */
export const FIRST_PAGES = 100;

/** A file of this many pages or more is opened at its first [`FIRST_PAGES`]. */
export const LARGE_FILE = 2000;

export interface Layout {
  /** The document's text. */
  text: string;
  /** The line of each page's marker, in page order: page `firstPage + i` at `markers[i]`. */
  markers: number[];
  /** The first page shown. */
  firstPage: number;
}

/** The marker's text for page `n`. */
export function markerText(n: number): string {
  return `— page ${n} —`;
}

/**
 * The document for `text`, whose first page is `firstPage`: each page a
 * marker line and then its printed lines. A page's last line break is its
 * end, not an empty line; CRLF is read as LF.
 */
export function layout(text: string, firstPage = 1): Layout {
  const lines: string[] = [];
  const markers: number[] = [];
  if (text === '') {
    return { text: '', markers: [], firstPage };
  }
  for (const page of text.replace(/\r\n/g, '\n').split(FORM_FEED)) {
    markers.push(lines.length);
    lines.push('');
    const printed = page.split('\n');
    if (printed.length > 1 && printed[printed.length - 1] === '') {
      printed.pop();
    }
    lines.push(...printed);
  }
  return { text: lines.join('\n') + '\n', markers, firstPage };
}

/** The page `line` is on; the first page for a line before every marker. */
export function pageAt(l: Layout, line: number): number {
  let lo = 0;
  let hi = l.markers.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (l.markers[mid] <= line) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return l.firstPage + found;
}

/** The marker line of page `page`, or undefined when it is not shown. */
export function pageLine(l: Layout, page: number): number | undefined {
  return l.markers[page - l.firstPage];
}

/** The pages to read first: all of a file under [`LARGE_FILE`] pages, else the first [`FIRST_PAGES`]. */
export function firstRead(pages: number | undefined): { lastPage: number; partial: boolean } {
  if (pages !== undefined && pages < LARGE_FILE) {
    return { lastPage: 0, partial: false };
  }
  return { lastPage: FIRST_PAGES, partial: true };
}
