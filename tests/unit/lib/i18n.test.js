import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const i18n = require("../../../lib/i18n");

describe("i18n", () => {
  beforeEach(() => {
    i18n.init("en");
  });

  it("init sets locale to en", () => {
    expect(i18n.getLocale()).toBe("en");
  });

  it("t returns a known key from en.json", () => {
    const result = i18n.t("common.release");
    expect(result).not.toBe("common.release");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("t returns the key itself for missing translations", () => {
    expect(i18n.t("this.key.does.not.exist")).toBe("this.key.does.not.exist");
  });

  it("t substitutes parameters with {name} syntax", () => {
    const result = i18n.t("standalone.deleteEnvConfirmMessage", { env: "test-env" });
    expect(result).toContain("test-env");
    expect(result).not.toContain("{env}");
  });

  it("t preserves unknown parameter placeholders", () => {
    const result = i18n.t("standalone.deleteEnvConfirmMessage", { unrelated: "x" });
    expect(result).toContain("{env}");
  });

  it("init falls back to en for unknown locale", () => {
    i18n.init("xx-nonexistent");
    expect(i18n.getLocale()).toBe("en");
  });

  it("getAvailableLocales returns at least en", () => {
    const locales = i18n.getAvailableLocales();
    expect(locales.length).toBeGreaterThanOrEqual(1);
    expect(locales.some((l) => l.value === "en")).toBe(true);
  });
});
