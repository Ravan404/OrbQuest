/**
 * catalogSearch.ts
 *
 * The catalog's search rules.
 *
 * Typing only ever searches the LOCAL quest database and game list (debounced,
 * no network request to Reddit). Reddit is searched only after an explicit
 * action - pressing Enter or the Search Reddit button - and even then the
 * results screen checks the local database first.
 */

/** Shortest query the catalog searches for. */
export const MIN_CATALOG_QUERY_LENGTH = 2;

/** Pause after the last keystroke before the local catalog is searched. */
export const CATALOG_TYPING_DEBOUNCE_MS = 300;

/**
 * The game name an explicit search (Enter / Search Reddit) opens on the
 * results screen: the selected card, otherwise exactly what was typed.
 * `null` means there is nothing to search for yet.
 */
export function catalogSubmitTarget(query: string, selectedGameName?: string | null): string | null {
  if (selectedGameName && selectedGameName.trim()) return selectedGameName.trim();
  const typed = query.trim();
  return typed.length >= MIN_CATALOG_QUERY_LENGTH ? typed : null;
}
