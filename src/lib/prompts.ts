/**
 * Deep-research prompt assembly.
 *
 * The produced prompt drives a DeerFlow "super agent" run. DeerFlow agents have
 * web search, sandboxed code execution, and file tools, so the prompt asks for a
 * structured, cited, written report (persisted as an artifact) rather than a
 * single chat reply.
 */

export interface ResearchPromptOptions {
  /** Optional one-line constraint to fold into the brief (e.g. "focus on the EU"). */
  focus?: string;
  /** Optional explicit model name (informational only; selection is via run context). */
  model?: string;
}

/**
 * Build the deep-research prompt for a topic.
 *
 * The structure is deliberately broad -> deep -> synthesis:
 *  1. decompose the topic into sub-questions,
 *  2. investigate each across multiple independent angles with sources,
 *  3. cross-check and weigh conflicting evidence,
 *  4. synthesize into a written, cited report saved as a markdown artifact.
 */
export function buildResearchPrompt(topic: string, options: ResearchPromptOptions = {}): string {
  const focusLine = options.focus ? `\nAdditional focus: ${options.focus}` : "";
  const modelLine = options.model ? `\nPreferred model (if available): ${options.model}\n` : "";

  return [
    `You are an expert research analyst. Conduct a thorough, rigorous investigation of the following topic and produce a comprehensive written report.`,
    ``,
    `Topic: ${topic}`,
    focusLine,
    modelLine,
    ``,
    `Approach:`,
    `1. Decompose the topic into the key sub-questions a knowledgeable reader would want answered.`,
    `2. Investigate each sub-question from multiple independent angles. Use web search and any available research tools to gather current, primary, and authoritative sources. Prefer primary sources and recent data; note the date of any time-sensitive facts.`,
    `3. Cross-check findings. Where sources conflict, present the disagreement explicitly and weigh the evidence rather than silently picking a side.`,
    `4. Synthesize. Turn the gathered evidence into a coherent narrative with clear conclusions and, where relevant, concrete recommendations.`,
    ``,
    `Deliverable:`,
    `- Write the full report in Markdown and save it as a file artifact (e.g. under the outputs directory) so it can be retrieved afterward.`,
    `- Structure the report with: an Executive Summary; a section per major sub-question; a "Key Findings" summary; a "Confidence & Limitations" section noting what is uncertain or under-sourced; and a "Sources" section listing the citations you relied on (title + URL).`,
    `- Cite sources inline in the body (e.g. [1], [2]) that map to the Sources section.`,
    `- Also return the report's main content in your final message so it can be read without opening the file.`,
    ``,
    `Do not pad the report with filler. Depth and accuracy over length. If the topic is ambiguous, state your interpretation briefly at the top and proceed.`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
