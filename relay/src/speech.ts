// Языки Supertonic 3. Ударения и выбор языка на стороне агента: сервер принимает любой текст.
const LANGUAGES = new Set([
  "ar", "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hi", "hu", "id", "it", "ja", "ko",
  "lv", "lt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "tr", "uk", "vi",
]);

/** Неизвестный или пропущенный язык не ошибка: телефон определит его по тексту. */
export function normalizeLanguage(requested: unknown) {
  return typeof requested === "string" && LANGUAGES.has(requested) ? requested : undefined;
}
