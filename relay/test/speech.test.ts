import { expect, test } from "bun:test";
import { normalizeLanguage } from "../src/speech";

test("keeps known language codes", () => {
  expect(normalizeLanguage("ru")).toBe("ru");
  expect(normalizeLanguage("uk")).toBe("uk");
});

test("unknown or missing language is left for the phone to detect", () => {
  expect(normalizeLanguage(undefined)).toBeUndefined();
  expect(normalizeLanguage("xx")).toBeUndefined();
  expect(normalizeLanguage(5)).toBeUndefined();
});
