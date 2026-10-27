import { describe, it, expect } from "vitest";
import { weaponIn, weaponPositive, weaponNegative, ANATOMY_NEGATIVE } from "../app/ui/manga-tags.js";

describe("weapon guard", () => {
  it("finds the weapon word in a prompt, through emphasis syntax, and nothing when there is none", () => {
    expect(weaponIn("1boy, navy riot gear, holding gun, rain")).toBe("gun");
    expect(weaponIn("(assault rifle:1.2), aiming")).toBe("rifle");
    expect(weaponIn("1girl, katana, slash")).toBe("katana");
    expect(weaponIn("1boy, running, rain")).toBeNull();
  });
  it("says how a gun or a blade is held and names the failure modes", () => {
    expect(weaponPositive("gun").join(", ")).toContain("two-handed grip");
    expect(weaponPositive("sword").join(", ")).toContain("hilt");
    const n = weaponNegative("gun");
    for (const w of ["gun fused with hand", "gun growing from arm", "floating gun", "extra gun"]) expect(n).toContain(w);
    expect(ANATOMY_NEGATIVE).toContain("objects growing from body");
  });
});
