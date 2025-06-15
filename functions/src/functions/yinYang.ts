// Import necessary dependencies for Firebase Functions, Google AI, and file processing
import { HttpsOptions, onRequest } from "firebase-functions/https";
import busboy from "busboy";
import admin from "../admin";
import { logger } from "firebase-functions";
import {
  Content,
  GenerationConfig,
  Part,
  SchemaType,
} from "@google/generative-ai";
import { authenticate } from "../utils/auth";
import { withRetry } from "../utils/modelRetry";
import { createPersonalityModel } from "../utils/models";

// Extend HttpsOptions to allow unparsed request bodies for file uploads
interface CustomHttpsOptions extends HttpsOptions {
  allowUnparsed: boolean;
  timeoutSeconds: number;
}

// Retry configuration (Primary 2.0 Flash, Fallback 2.5 Flash)
const RETRY_DELAY_MS = 1000; // 1 second
const MAX_PRIMARY_RETRIES = 3;
const MAX_FALLBACK_RETRIES = 10;
const FAILURE_RESPONSE = "... ummmmm";

// Define the possible personality types for the AI model
type PersonalityType = "yin" | "yang";

// Configure the generation parameters for the AI model
// These settings control the creativity and output format of the model
const baseGenerationConfig: GenerationConfig = {
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      bubbles: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.STRING,
        },
      },
    },
  },
};

const generationConfigs: Record<PersonalityType, GenerationConfig> = {
  yin: { ...baseGenerationConfig, temperature: 1.0 },
  yang: { ...baseGenerationConfig, temperature: 1.15 },
};

// Add types for the unified function
interface UnifiedFormData {
  userPrompt: string;
  chatHistory: any[];
  personality: PersonalityType;
  imageParts: any[];
}

const RETRY_CONFIG = {
  primary: { maxRetries: 3, delayMs: 1000, exponentialBackoff: true },
  fallback: { maxRetries: 5, delayMs: 1000 }
};

// Main endpoint handler for processing yin/yang personality requests
// This function handles both text and image-based interactions
export const yinYang = onRequest(
  { 
    allowUnparsed: true,
    timeoutSeconds: 540, // extennded to 9 minutes (maximum allowed for HTTP functions)
  } as CustomHttpsOptions,
  async (req, res) => {
    logger.info("[Chat-API-Logs] 🚀 Yin/Yang endpoint called", {
      method: req.method,
      path: req.path,
    });

    // Only allow POST requests for security
    if (req.method !== "POST") {
      logger.info("[Chat-API-Logs] ❌ Method not allowed:", req.method);
      res.status(405).send("Method not allowed");
      return;
    }

    // Authenticate the user and get their UID
    // This ensures only authorized users can access the endpoint
    const uid = await authenticate(req, res, admin.app());
    if (!uid) return;
    logger.info(`[Chat-API-Logs] 👤 Authenticated user: ${uid}`);

    try {
      logger.info("[Chat-API-Logs] 📝 Starting form data processing");
      const {
        userPrompt,
        chatHistory,
        personality,
        imageParts,
      }: UnifiedFormData = await processFormDataAndImages(req);
      logger.info("[Chat-API-Logs] 📦 Form data processed:", {
        hasUserPrompt: !!userPrompt,
        chatHistoryLength: chatHistory.length,
        personality,
        imageCount: imageParts.length,
      });
      logger.info("[Chat-API-Logs] 🖼️ Image processing complete:", {
        imageCount: imageParts.length,
      });
      // Get chat response and handle the response
      logger.info("[Chat-API-Logs] 💭 Starting chat response generation");
      const { responseText, responseJson } = await chatResponse(
        personality,
        chatHistory,
        userPrompt,
        imageParts,
      );

      // Log the responses for debugging and monitoring
      logger.info("[Chat-API-Logs] 📝 Raw Gemini Response Text:", responseText);
      logger.info("[Chat-API-Logs] 📦 Parsed response JSON:", {
        bubbleCount: responseJson.bubbles?.length || 0,
      });

      // Send the response back to the client
      res.json({
        bubbles: Array.isArray(responseJson.bubbles)
          ? responseJson.bubbles
          : responseJson.bubbles
            ? [responseJson.bubbles]
            : [],
      });
      logger.info("[Chat-API-Logs] ✅ Response sent successfully");
    } catch (error) {
      logger.error("[Chat-API-Logs] ❌ Error processing endpoint:", error);
      res.status(500).send("Error processing your request");
    }
  },
);

// Replace processFormData and processImages with a single unified function
async function processFormDataAndImages(
  req: import("express").Request,
): Promise<UnifiedFormData> {
  return await new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    let userPrompt = "";
    let chatHistory: any[] = [];
    let personality: PersonalityType = "yin";
    const imageParts: any[] = [];
    const filePromises: Promise<void>[] = [];

    bb.on("field", (name: string, val: string) => {
      if (name === "prompt") {
        userPrompt = val;
      } else if (name === "personality") {
        const requestedPersonality = val.toLowerCase() as PersonalityType;
        logger.info(`[Personality] Received personality type from request: ${requestedPersonality}`);
        if (requestedPersonality === "yin" || requestedPersonality === "yang") {
          personality = requestedPersonality;
        }
      } else if (name === "history") {
        try {
          chatHistory = JSON.parse(val);
          if (
            !Array.isArray(chatHistory) ||
            !chatHistory.every(
              (item) =>
                typeof item === "object" &&
                item !== null &&
                "role" in item &&
                "parts" in item,
            )
          ) {
            throw new Error("History must be an array of Content objects");
          }
          chatHistory = chatHistory.map((item) => ({
            ...item,
            role: item.role === "assistant" ? "model" : item.role,
          }));
          if (chatHistory.length > 0 && chatHistory[0].role === "model") {
            chatHistory = chatHistory.filter(
              (item, index) => !(index === 0 && item.role === "model"),
            );
          }
          if (chatHistory.length === 0 || chatHistory[0].role !== "user") {
            chatHistory.unshift({ role: "user", parts: [{ text: "Hello" }] });
          }
        } catch (error) {
          reject(error);
        }
      }
    });

    bb.on(
      "file",
      (
        name: string,
        fileStream: import("stream").Readable,
        info: { filename: string; mimeType: string },
      ) => {
        if (name !== "images") {
          fileStream.resume();
          return;
        }
        const allowedMimeTypes = [
          "image/jpeg",
          "image/png",
          "image/heif",
          "image/webp",
        ];
        if (!allowedMimeTypes.includes(info.mimeType)) {
          fileStream.resume();
          return;
        }
        const chunks: Buffer[] = [];
        fileStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        filePromises.push(
          new Promise<void>((res, rej) => {
            fileStream.on("end", () => {
              imageParts.push({
                inlineData: {
                  mimeType: info.mimeType,
                  data: Buffer.concat(chunks).toString("base64"),
                },
              });
              res();
            });
            fileStream.on("error", rej);
          }),
        );
      },
    );

    bb.on("finish", async () => {
      try {
        await Promise.all(filePromises);
        resolve({ userPrompt, chatHistory, personality, imageParts });
      } catch (err) {
        reject(err);
      }
    });
    bb.once("error", reject);
    bb.end((req as any).rawBody);
  });
}

// Generate a chat response using the specified personality model
async function chatResponse(
  personality: PersonalityType,
  chatHistory: Content[],
  userPrompt: string,
  imageParts: Part[],
): Promise<{ responseText: string; responseJson: any }> {
  logger.info("[Chat-API-Logs] 💭 Starting chat response generation", {
    personality,
    chatHistoryLength: chatHistory.length,
    promptLength: userPrompt.length,
    imageCount: imageParts.length,
  });

  const messageParts: Part[] = [];
  if (userPrompt.trim()) {
    messageParts.push({ text: userPrompt });
  } else if (imageParts.length > 0) {
    messageParts.push({ text: "Describe what you see and provide thoughtful commentary." });
  }
  messageParts.push(...imageParts);

  async function generateWithModel(modelType: 'primary' | 'fallback') {
    const model = createPersonalityModel(personality, modelType);
    const chatSession = model.startChat({
      generationConfig: generationConfigs[personality],
      history: chatHistory,
    });
    const result = await chatSession.sendMessage(messageParts);
    return result.response.text();
  }

  // Try primary, then fallback
  let responseText: string;
  try {
    responseText = await withRetry(
      () => generateWithModel('primary'),
      RETRY_CONFIG.primary,
      'primary chat'
    );
  } catch {
    try {
      responseText = await withRetry(
        () => generateWithModel('fallback'),
        RETRY_CONFIG.fallback,
        'fallback chat'
      );
    } catch {
      responseText = JSON.stringify({ bubbles: ["... ummmmm"] });
    }
  }

  // Parse response
  let responseJson;
  try {
    responseJson = JSON.parse(responseText);
    if (!responseJson.bubbles?.length) {
      responseJson.bubbles = ["... ummmmm"];
    }
  } catch {
    responseJson = { bubbles: ["I'm having trouble processing right now."] };
  }
  return { responseText, responseJson };
}
