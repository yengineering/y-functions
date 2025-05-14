// Import necessary dependencies for Firebase Functions, Google AI, and file processing
import { HttpsOptions, onRequest } from "firebase-functions/https";
import { genaiClient } from "../config";
import busboy from "busboy";
import admin from "../admin";
import { logger } from "firebase-functions";
import { Readable } from "stream";
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
}

// Define the possible personality types for the AI model
type PersonalityType = "yin" | "yang";

// Initialize personality-specific models with their respective system instructions
// Each model uses the same base model but with different personality prompts
const personalityModels = {
  yin: genaiClient.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yin")}`,
  }),
  yang: genaiClient.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yang")}`,
  }),
};

// Configure the generation parameters for the AI model
// These settings control the creativity and output format of the model
const generationConfig: GenerationConfig = {
  temperature: 1.15, // Higher temperature for more creative responses
  topP: 0.95, // Nucleus sampling parameter for response diversity
  topK: 40, // Top-k sampling parameter for response quality
  maxOutputTokens: 8192, // Maximum length of generated response
  responseMimeType: "application/json", // Expect JSON response
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

// Main endpoint handler for processing yin/yang personality requests
// This function handles both text and image-based interactions
export const yin_yang = onRequest(
  { allowUnparsed: true } as CustomHttpsOptions,
  async (req, res) => {
    logger.info("[Chat-API-Logs] 🚀 Yin/Yang endpoint called", {
      method: req.method,
      path: req.path
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
      // Initialize busboy for parsing multipart form data
      // This allows us to handle both text fields and file uploads
      logger.info("[Chat-API-Logs] 📝 Starting form data processing");
      const bb = busboy({ headers: req.headers });
      
      // Process the form data to get text fields and detect if images are present
      const { userPrompt, chatHistory, personality, hasImages } = 
        await processFormData(bb, req.rawBody);

      logger.info("[Chat-API-Logs] 📦 Form data processed:", {
        hasUserPrompt: !!userPrompt,
        chatHistoryLength: chatHistory.length,
        personality,
        hasImages
      });

      // Process images if present, otherwise use empty array for imageParts
      const { imageParts } = hasImages
        ? await processImages(bb, userPrompt, personality)
        : { imageParts: [] };

      logger.info("[Chat-API-Logs] 🖼️ Image processing complete:", {
        imageCount: imageParts.length
      });

      // Get chat response and handle the response
      logger.info("[Chat-API-Logs] 💭 Starting chat response generation");
      const { responseText, responseJson } = await chatResponse(personality, chatHistory, userPrompt, imageParts);

      // Log the responses for debugging and monitoring
      logger.info("[Chat-API-Logs] 📝 Raw Gemini Response Text:", responseText);
      logger.info("[Chat-API-Logs] 📦 Parsed response JSON:", {
        bubbleCount: responseJson.bubbles?.length || 0
      });

      // Send the response back to the client
      res.json({
        bubbles: responseJson.bubbles,
      });
      logger.info("[Chat-API-Logs] ✅ Response sent successfully");
    } catch (error) {
      logger.error("[Chat-API-Logs] ❌ Error processing endpoint:", error);
      res.status(500).send("Error processing your request");
    }
  },
);

// Interface defining the structure of processed form data
// This ensures type safety for the form processing function
interface FormData {
  userPrompt: string; // The user's input text
  chatHistory: Content[]; // Previous conversation context
  personality: PersonalityType; // Selected personality type
  hasImages: boolean; // Flag indicating if images are present
}

// Process all form data including fields and files
// This function handles the parsing and validation of form fields
async function processFormData(bb: busboy.Busboy, rawBody: Buffer): Promise<FormData> {
  logger.info("[Chat-API-Logs] 📝 Starting form data processing");
  
  // Initialize variables to store form data
  let userPrompt = "";
  let chatHistory: Content[] = [];
  let personality: PersonalityType = "yin"; // Default to yin if not specified
  let hasImages = false;

  // Handle form fields
  // This processes each field in the form data
  bb.on("field", (name: string, val: string) => {
    logger.info(`[Chat-API-Logs] 📋 Processing field: ${name}`);
    
    // Process different field types based on their names
    if (name === "prompt") {
      userPrompt = val;
      logger.info("[Chat-API-Logs] - User prompt received:", { length: val.length });
    } else if (name === "personality") {
      // Validate and set personality type
      // This ensures only valid personality types are accepted
      const requestedPersonality = val.toLowerCase() as PersonalityType;
      if (requestedPersonality === "yin" || requestedPersonality === "yang") {
        personality = requestedPersonality;
        logger.info(`[Chat-API-Logs] 👤 Using personality: ${personality}`);
      } else {
        logger.warn(`[Chat-API-Logs] ⚠️ Invalid personality requested: ${val}, defaulting to yin`);
      }
    } else if (name === "history") {
      try {
        // Parse and validate chat history
        // This ensures the history is in the correct format
        logger.info("[Chat-API-Logs] 📚 Processing chat history");
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

        // Normalize chat history format
        // This converts 'assistant' role to 'model' for consistency
        chatHistory = chatHistory.map((item) => ({
          ...item,
          role: item.role === "assistant" ? "model" : item.role,
        }));

        // Remove any leading model messages
        // This ensures the conversation starts with a user message
        if (chatHistory.length > 0 && chatHistory[0].role === "model") {
          logger.info("[Chat-API-Logs] 🔄 Removing leading model message from chat history");
          chatHistory = chatHistory.filter(
            (item, index) => !(index === 0 && item.role === "model"),
          );
        }

        // Ensure chat history starts with a user message
        // This maintains conversation flow
        if (chatHistory.length === 0 || chatHistory[0].role !== "user") {
          logger.info("[Chat-API-Logs] 🔄 Adding dummy user message at the beginning of chat history");
          chatHistory.unshift({
            role: "user",
            parts: [{ text: "Hello" }],
          });
        }

        logger.info("[Chat-API-Logs] ✅ Chat history processed:", {
          messageCount: chatHistory.length,
          firstMessageRole: chatHistory[0]?.role,
          lastMessageRole: chatHistory[chatHistory.length - 1]?.role
        });
      } catch (error) {
        logger.error("[Chat-API-Logs] ❌ Error parsing history field:", error);
        throw new Error("Invalid history format");
      }
    }
  });

  // Check for image files in the request
  // This sets the hasImages flag if any images are found
  bb.on("file", (name: string) => {
    if (name === "images") {
      hasImages = true;
      logger.info("[Chat-API-Logs] 🖼️ Image file detected");
    }
  });

  // End the busboy stream
  // This ensures all form data is processed
  bb.end(rawBody);

  // Return all processed form data
  logger.info("[Chat-API-Logs] ✅ Form data processing complete", {
    hasUserPrompt: !!userPrompt,
    chatHistoryLength: chatHistory.length,
    personality,
    hasImages
  });

  return {
    userPrompt,
    chatHistory,
    personality,
    hasImages,
  };
}

// Interface for processed images
// This defines the structure of the image processing result
interface ProcessedImages {
    imageParts: Part[]; // Array of processed image parts
}

// Process uploaded images
// This function handles image validation and processing
async function processImages(
    bb: busboy.Busboy,
    userPrompt: string,
    personality: PersonalityType,
): Promise<ProcessedImages> {
    logger.info("[Chat-API-Logs] 🖼️ Starting image processing");
    
    const imageParts: Part[] = [];
    const filePromises: Promise<void>[] = [];

    // Handle file uploads
    // This processes each uploaded file
    bb.on(
    "file",
    (
        name: string,
        fileStream: Readable,
        info: { filename: string; mimeType: string },
    ) => {
        logger.info(`[Chat-API-Logs] 📤 Processing file:`, {
            name,
            filename: info.filename,
            mimeType: info.mimeType
        });

        // Skip non-image files
        // This ensures we only process image files
        if (name !== "images") {
        logger.info(`[Chat-API-Logs] ⚠️ Skipping non-image file: ${name}`);
        fileStream.resume();
        return;
        }

        logger.info(
        `[Chat-API-Logs] 🖼️ Processing file: ${info.filename}, MIME type: ${info.mimeType}`,
        );

        // Validate image MIME types
        // This ensures we only accept supported image formats
        const allowedMimeTypes = [
        "image/jpeg",
        "image/png",
        "image/heif",
        "image/webp",
        ];
        if (!allowedMimeTypes.includes(info.mimeType)) {
        logger.warn(
            `[Chat-API-Logs] ❌ Rejected file with invalid MIME type: ${info.mimeType}`,
        );
        fileStream.resume(); // Discard invalid files
        return;
        } else {
        logger.info(
            `[Chat-API-Logs] ✅ Accepted file: ${info.filename} with MIME type ${info.mimeType}`,
        );
        }

        // Collect file chunks
        // This allows us to process large files efficiently
        const chunks: Buffer[] = [];

        fileStream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        });

        // Process file when complete
        // This converts the file to base64 and adds it to imageParts
        filePromises.push(
        new Promise<void>((resolve, reject) => {
            fileStream.on("end", () => {
            const buffer = Buffer.concat(chunks);
            imageParts.push({
                inlineData: {
                mimeType: info.mimeType,
                data: buffer.toString("base64"),
                },
            });
            logger.info(`[Chat-API-Logs] ✅ File processed: ${info.filename}`);
            resolve();
            });
            fileStream.on("error", (error) => {
            logger.error(`[Chat-API-Logs] ❌ Error processing file: ${info.filename}`, error);
            reject(error);
            });
        }),
        );
    },
    );

    // Wait for all files to be processed
    // This ensures all images are ready before proceeding
    await new Promise<void>((resolve, reject) => {
    bb.on("finish", async () => {
        try {
        await Promise.all(filePromises);
        logger.info(
            `[Chat-API-Logs] ✅ All files processed. Total image parts: ${imageParts.length}`,
        );
        // Log details of each processed image
        // This helps with debugging and monitoring
        for (let i = 0; i < imageParts.length; i++) {
            const part = imageParts[i];
            logger.info(
            `[Chat-API-Logs] 📊 Image ${i + 1} details:`,
            {
                type: "inlineData" in part ? "inline" : "unknown",
                mimeType:
                "inlineData" in part && part.inlineData
                    ? part.inlineData.mimeType
                    : "N/A",
                dataLength:
                "inlineData" in part &&
                part.inlineData &&
                part.inlineData.data
                    ? part.inlineData.data.length
                    : 0,
            }
            );
        }
        resolve();
        } catch (error) {
        logger.error("[Chat-API-Logs] ❌ Error processing files:", error);
        reject(error);
        }
    });

    bb.once("error", reject);
    });

    logger.info(`[Chat-API-Logs] ✅ Image processing complete. Processed ${imageParts.length} images`);

    return { imageParts };
}

// Generate a chat response using the specified personality model
// This function handles the chat session initialization and message generation
async function chatResponse(
  personality: PersonalityType,
  chatHistory: Content[],
  userPrompt: string,
  imageParts: Part[]
): Promise<{ responseText: string; responseJson: any }> {
  logger.info("[Chat-API-Logs] 💭 Starting chat response generation", {
    personality,
    chatHistoryLength: chatHistory.length,
    promptLength: userPrompt.length,
    imageCount: imageParts.length
  });

  // Initialize chat session with the appropriate personality model
  // This sets up the context for the AI's response
  logger.info(`[Chat-API-Logs] 🤖 Initializing ${personality} model chat session`);
  const chatSession = personalityModels[personality].startChat({
    generationConfig,
    history: chatHistory,
  });

  // Combine user prompt with any image parts
  // This allows the model to process both text and images together
  const messageParts: Part[] = [{ text: userPrompt }, ...imageParts];
  logger.info("[Chat-API-Logs] 📝 Sending message to model", {
    textLength: userPrompt.length,
    imageCount: imageParts.length
  });

  // Get response from the AI model
  // This generates the main response based on the input
  const llmResponse = await chatSession.sendMessage(messageParts);
  const responseText = llmResponse.response.text();
  const responseJson = JSON.parse(responseText);

  logger.info("[Chat-API-Logs] ✅ Chat response generated", {
    responseLength: responseText.length,
    bubbleCount: responseJson.bubbles?.length || 0
  });

  return { responseText, responseJson };
}