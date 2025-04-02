import { readFileSync } from "fs";
import path from "path";

const promptCache = new Map();

export const loadPrompt = (name: string) => {
  if (promptCache.has(name)) {
    return promptCache.get(name);
  }

  const filePath = path.join(__dirname, "..", "prompts", `${name}.txt`);
  const content = readFileSync(filePath, "utf8");
  promptCache.set(name, content);
  return content;
};
