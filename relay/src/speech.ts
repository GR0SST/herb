// Supertonic 3 languages. Stress marks and language are up to the agent: the server accepts any text.
const LANGUAGES = new Set([
  "ar", "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hi", "hu", "id", "it", "ja", "ko",
  "lv", "lt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "tr", "uk", "vi",
]);

/** An unknown or missing language is not an error: the phone detects it from the text. */
export function normalizeLanguage(requested: unknown) {
  return typeof requested === "string" && LANGUAGES.has(requested) ? requested : undefined;
}
