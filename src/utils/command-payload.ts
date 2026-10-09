/**
 * Structured (JSON) payload for every tool that generates a curl / PowerShell command embedding the access key.
 *
 * The human text always carried a "do not save or share" warning, but the JSON payload — the default output format —
 * did not (UAT 2026-10-09, found on get_test_run_command; the same gap was in every *_command tool). An agent that
 * reads only the structured result must still see that the command contains a live credential.
 */
export const PLAINTEXT_KEY_WARNING =
  'This command embeds the active access key in plaintext. Have the user run it immediately; do not save it to a file, ' +
  'paste it into tickets or chat, commit it, or repeat it in a report.';

export function commandPayload(result: { endpoint: string; curlCommand: string; psCommand: string | null }): {
  endpoint: string; curlCommand: string; psCommand: string | null; credentialWarning: string;
} {
  return { endpoint: result.endpoint, curlCommand: result.curlCommand, psCommand: result.psCommand, credentialWarning: PLAINTEXT_KEY_WARNING };
}
