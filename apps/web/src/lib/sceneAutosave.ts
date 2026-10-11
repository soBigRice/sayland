export const AUTOSAVE_INTERVAL_MS = 5000;
export type PreferenceValues = { draft: string; speakerEnabled: boolean };
export type Preferences = PreferenceValues & { saved: PreferenceValues; pending?: Promise<void>; uncertain?: boolean };

export const createPreferences = (values: PreferenceValues): Preferences => ({ ...values, saved: { ...values } });
export const preferencesChanged = (value: Preferences) => Boolean(value.uncertain) || value.draft !== value.saved.draft || value.speakerEnabled !== value.saved.speakerEnabled;
export const preferencesPending = (value: Preferences) => Boolean(value.pending) || preferencesChanged(value);

/** Wait for the actual write, then compare the latest values, never a queued stale snapshot. */
export async function flushPreferenceChanges(value: Preferences, save: (data: PreferenceValues) => Promise<unknown>, isCurrent: () => boolean): Promise<void> {
  while (value.pending) await value.pending;
  if (!isCurrent() || !preferencesChanged(value)) return;
  const data = { draft: value.draft, speakerEnabled: value.speakerEnabled };
  const write = save(data).then(() => { value.saved = data; value.uncertain = false; });
  value.pending = write;
  try { await write; }
  // A lost response may still have committed. Reconfirm the latest values before claiming saved.
  catch (error) { value.uncertain = true; throw error; }
  finally { if (value.pending === write) value.pending = undefined; }
}
