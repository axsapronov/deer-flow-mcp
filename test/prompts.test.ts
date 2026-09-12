import { describe, it, expect } from "vitest";
import { buildResearchPrompt } from "../src/lib/prompts.js";

describe("buildResearchPrompt", () => {
  it("includes the topic", () => {
    expect(buildResearchPrompt("Quantum computing")).toContain("Quantum computing");
  });

  it("includes the focus line when provided", () => {
    expect(buildResearchPrompt("X", { focus: "the EU" })).toContain("Additional focus: the EU");
  });

  it("omits focus and model lines when absent", () => {
    const prompt = buildResearchPrompt("X");
    expect(prompt).not.toContain("Additional focus");
    expect(prompt).not.toContain("Preferred model");
  });

  it("includes the model line when provided", () => {
    expect(buildResearchPrompt("X", { model: "gpt-x" })).toContain(
      "Preferred model (if available): gpt-x"
    );
  });

  it("asks for a saved markdown artifact with a Sources section", () => {
    const prompt = buildResearchPrompt("X");
    expect(prompt).toMatch(/save it as a file artifact/i);
    expect(prompt).toMatch(/Sources/);
  });

  it("instructs cross-checking conflicting sources", () => {
    expect(buildResearchPrompt("X")).toMatch(/cross-check/i);
  });
});
