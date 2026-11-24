// The custom memory type this demo relies on. Create it on your Agent Memory
// service in the Redis Cloud console (Configuration → Edit → Memory types &
// extraction → Add type) with exactly these names. Field names and types can't
// change after creation. See MEMORY_TYPE.md.

export const ENVIRONMENT_TYPE = 'customer_environment';

export interface EnvironmentField {
  key: string;
  label: string;
  type: 'str' | 'flag';
  description: string;
}

export const environmentFields: EnvironmentField[] = [
  { key: 'gateway_region', label: 'Gateway', type: 'str', description: 'Waypoint region the customer\'s gateway runs in, for example us-east or eu-central.' },
  { key: 'origin_location', label: 'Origin', type: 'str', description: 'Where the customer\'s own backend or origin servers run, for example Frankfurt or us-west.' },
  { key: 'client_runtime', label: 'Runtime', type: 'str', description: 'What calls Waypoint, for example AWS Lambda with Node 18, or Go on Kubernetes.' },
  { key: 'sdk_version', label: 'SDK', type: 'str', description: 'Waypoint SDK version the customer uses, for example 3.0 or 3.2.1.' },
  // Stored as text (str) on the demo service; extraction writes "true" or
  // "false". A bool field would be cleaner, but field types can't change once
  // the memory type is created.
  { key: 'keep_alive_enabled', label: 'Keep-alive', type: 'flag', description: 'Whether HTTP keep-alive is enabled in the customer\'s client.' },
];

export const environmentExtractionPrompt = `Extract the customer's technical setup for the Waypoint API gateway whenever the user states part of it. Fill only what the user actually said, and put each detail in exactly one field:
- gateway_region: the region of the Waypoint gateway itself, only when the user talks about the gateway. Never the region where the customer's own services run.
- origin_location: the region or city where the customer's own services run, whether that's their backend or the services that call Waypoint. For "Lambda functions in us-east", that's us-east.
- client_runtime: the platform and language of the services that call Waypoint, without the region, for example "AWS Lambda with Node 18" or "Java services". Never a command-line tool such as curl.
- sdk_version: the Waypoint SDK version number only, for example 3.2.1.
- keep_alive_enabled: "true" or "false". "We turned keep-alive off" or "disabled keep-alive" means "false".`;

/**
 * The exact stored value the staff query matches. Attribute filters are exact
 * and case-sensitive; with the extraction prompt above, extraction writes "false".
 */
export const KEEP_ALIVE_OFF = 'false';

/** Extraction writes one record per detail. Merge a customer's records, newest value first. */
export function mergeEnvironment(records: { attributes?: Record<string, unknown> }[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record.attributes ?? {})) {
      if (merged[key] === undefined && value !== null && value !== '') merged[key] = value;
    }
  }
  return merged;
}

export function formatAttribute(field: EnvironmentField, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (field.type === 'flag') {
    const text = String(value).trim().toLowerCase();
    if (['off', 'false', 'disabled', 'no'].includes(text)) return 'off';
    if (['on', 'true', 'enabled', 'yes'].includes(text)) return 'on';
    return text;
  }
  return String(value);
}
