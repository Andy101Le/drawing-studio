import { describe, it, expect } from "vitest";
import { parseScript, templateFor, balloonSlots } from "../app/engine/script.js";

const SRC = `@Kai = kai, 1boy, short black hair, dark green power armor
@Mira = mira, 1girl, long silver hair

# Page 1
[wide] night city street, rain
[close-up] Kai, angry: "You lied to me."
[two-shot] Kai | Mira, calm: "I had no choice."

[action] Kai punching, speed lines | Mira dodging
Narrator: "Three days later"`;

describe("panel script", () => {
  const s = parseScript(SRC);
  it("reads cast, pages and panels", () => {
    expect(s.cast.map((c) => c.name)).toEqual(["Kai", "Mira"]);
    expect(s.pages.length).toBe(2); expect(s.pages[0]!.length).toBe(3); expect(s.pages[1]!.length).toBe(2);
  });
  it("builds prompts with the cast first, the shot last, and emotions as tags", () => {
    const p = s.pages[0]![1]!;
    expect(p.prompt.startsWith("kai, 1boy, short black hair, dark green power armor, angry")).toBe(true);
    expect(p.prompt.endsWith("close-up, portrait")).toBe(true);
    expect(p.dialogue).toEqual([{ speaker: "Kai", text: "You lied to me.", emotion: "angry" }]);
    const two = s.pages[0]![2]!;
    expect(two.prompt.startsWith("2 people, kai")).toBe(true); expect(two.cast).toEqual(["Kai", "Mira"]);
    expect(two.prompt).toContain("expressionless");
  });
  it("flags a speaker that is not in the cast and keeps the line as a caption", () => {
    expect(s.errors.some((e) => e.includes("Narrator"))).toBe(true);
    expect(s.pages[1]![1]!.dialogue[0]!.text).toBe("Three days later");
  });
  it("picks a template by panel count and shape", () => {
    expect(templateFor(s.pages[0]!)).toBe("Wide top + 2");
    expect(templateFor(s.pages[1]!)).toBe("2 rows");
    expect(templateFor([])).toBe("Single splash");
  });
  it("places balloons right to left inside the panel", () => {
    const slots = balloonSlots({ x0: 0, y0: 0, x1: 1000, y1: 800 }, 2);
    expect(slots.length).toBe(2); expect(slots[0]!.x).toBeGreaterThan(slots[1]!.x);
    for (const q of slots) { expect(q.x).toBeGreaterThanOrEqual(0); expect(q.x + q.w).toBeLessThanOrEqual(1000); }
  });
});
