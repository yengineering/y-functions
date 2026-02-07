// utils/models.ts
import { genaiClient } from "../config";
import { loadPrompt } from "./loadPrompt";

export const models = {
  primary: "gemini-3-flash-preview",
  fallback: "gemini-2.5-flash-preview-05-20",
};

export function createPersonalityModel(
  personality: "yin" | "yang",
  modelType: keyof typeof models,
) {
  return genaiClient.getGenerativeModel({
    model: models[modelType],
    systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt(personality)}`,
  });
}
