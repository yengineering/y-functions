import { GoogleGenerativeAI } from "@google/generative-ai";

import { defineSecret } from "firebase-functions/params";

export const openaiKey = defineSecret("OPENAI_API_KEY");

export const genaiClient = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY || "",
);
