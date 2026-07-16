import { GoogleGenerativeAI } from "@google/generative-ai";

export const genaiClient = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY || "",
);
