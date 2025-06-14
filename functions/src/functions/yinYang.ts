// Import necessary dependencies for Firebase Functions, Google AI, and file processing
import { HttpsOptions, onRequest } from "firebase-functions/https";
import { genaiClient } from "../config";
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
import { loadPrompt } from "../utils/loadPrompt";

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

// Initialize personality-specific models with their respective system instructions
// Each model uses the same base model but with different personality prompts
const personalityModels = {
  yin: {
    primary: genaiClient.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yin")}`,
    }),
    fallback: genaiClient.getGenerativeModel({
      model: "gemini-2.5-flash-preview-05-20",
      systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yin")}`,
    }),
  },
  yang: {
    primary: genaiClient.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yang")}`,
    }),
    fallback: genaiClient.getGenerativeModel({
      model: "gemini-2.5-flash-preview-05-20",
      systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yang")}`,
    }),
  },
};

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

// Helper function to wait between retries
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

  // Combine user prompt with any image parts
  const messageParts: Part[] = [];
  if (userPrompt.trim()) {
    messageParts.push({ text: userPrompt });
  } else if (imageParts.length > 0) {
    messageParts.push({
      text: "Describe what you see in this image in detail and provide thoughtful commentary.",
    });
  }
  messageParts.push(...imageParts);

  logger.info("[Chat-API-Logs] 📝 Sending message to model", {
    textLength: userPrompt.length,
    imageCount: imageParts.length,
  });

  // Primary model retry logic
  let primaryRetries = 0;

  while (primaryRetries < MAX_PRIMARY_RETRIES) {
    try {
      return await invokeLLM(personality, chatHistory, messageParts, 'primary');
    } catch (error: any) {
      if (error.status === 503) {
        primaryRetries++;
        logger.warn(
          `[Chat-API-Logs] ⚠️ Primary model overloaded. Retrying (${primaryRetries}/${MAX_PRIMARY_RETRIES})...`
        );
        await wait(RETRY_DELAY_MS * primaryRetries); // Exponential backoff
      } else {
        throw error;
      }
    }
  }

  // If primary model fails, try fallback model
  logger.warn(
    "[Chat-API-Logs] 🚨 Primary model failed. Switching to fallback model ('gemini-2.5-flash-preview-05-20')."
  );

  // Fallback model retry logic
  let fallbackRetries = 0;

  while (fallbackRetries < MAX_FALLBACK_RETRIES) {
    try {
      return await invokeLLM(personality, chatHistory, messageParts, 'fallback');
    } catch (error: any) {
      if (error.status === 503) {
        fallbackRetries++;
        logger.warn(
          `[Chat-API-Logs] ⚠️ Fallback model overloaded. Retrying (${fallbackRetries}/${MAX_FALLBACK_RETRIES})...`
        );
        await wait(RETRY_DELAY_MS); // Constant delay for fallback
      } else {
        throw error;
      }
    }
  }

  // If we've exhausted all fallback retries, return the umm message
  logger.error("[Chat-API-Logs] ❌ All fallback retries failed. Returning fallback message.");
  return {
    responseText: JSON.stringify({ bubbles: [FAILURE_RESPONSE] }),
    responseJson: { bubbles: [FAILURE_RESPONSE] }
  };
}

// Helper function to invoke LLM
async function invokeLLM(
  personality: PersonalityType,
  chatHistory: Content[],
  messageParts: Part[],
  modelType: 'primary' | 'fallback'
): Promise<{ responseText: string; responseJson: any }> {
  logger.info(
    `[Chat-API-Logs] 🤖 Attempting ${modelType} model`
  );
  const chatSession = personalityModels[personality][modelType].startChat({
    generationConfig: generationConfigs[personality],
    history: chatHistory,
  });
  const llmResponse = await chatSession.sendMessage(messageParts);
  const responseText = llmResponse.response.text();
  let responseJson: any;
  try {
    responseJson = JSON.parse(responseText);
    if (!responseJson.bubbles) {
      responseJson.bubbles = [];
    }
    // If the response is empty and there are image parts, return the failure response:
    if (
      Array.isArray(responseJson.bubbles) &&
      responseJson.bubbles.length === 0 
      // && messageParts.some(part => 'inlineData' in part)
    ) {
      responseJson.bubbles = [FAILURE_RESPONSE];
    }
  } catch (error) {
    logger.error(`[Chat-API-Logs] ❌ Failed to parse ${modelType} response as JSON`, error);
    responseJson = {
      bubbles: [
        "I can see your image, but I'm having trouble processing it right now. Can you tell me what you'd like to know about it?",
      ],
    };
  }
  logger.info(`[Chat-API-Logs] ✅ ${modelType} model succeeded.`, {
    responseLength: responseText.length,
  });
  return { responseText, responseJson };
}
