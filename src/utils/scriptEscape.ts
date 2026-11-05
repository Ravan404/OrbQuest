/**
 * Escaping for the start scripts of the script dialog (ScriptDialog.tsx). Game names come from Discord's list and user
 * input, so every value is escaped for the exact place it ends up in.
 */

export const stripControlChars = (value: string) => value.replace(/[\r\n\x00-\x1F\x7F]/g, ' ').trim();

/** Inside a single-quoted PowerShell string. */
export const escapePowerShell = (value: string) => stripControlChars(value).replace(/'/g, "''");

/**
 * Unquoted batch text (the `title` command): metacharacters need a caret.
 * Inside double quotes a caret is printed literally, so quoted values use
 * escapeBatchQuoted.
 */
export const escapeBatch = (value: string) =>
  stripControlChars(value)
    .replace(/\^/g, '^^')
    .replace(/%/g, '%%')
    .replace(/"/g, '')
    .replace(/[&|<>()]/g, '^$&');

/** Text inside double quotes: only % expands there, and a quote would end the string. */
export const escapeBatchQuoted = (value: string) => stripControlChars(value).replace(/%/g, '%%').replace(/"/g, '');
