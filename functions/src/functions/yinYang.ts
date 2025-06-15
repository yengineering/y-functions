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
          const rawHistory = JSON.parse(val);
          if (!Array.isArray(rawHistory)) {
            throw new Error("History must be an array");
          }
          
          // Convert to Gemini format while preserving personality info for our analysis
          chatHistory = rawHistory
            .filter(msg => msg.parts?.[0]?.text) // Only messages with text content
            .map((msg) => {
              // Store personality info separately for our analysis
              const personalityInfo = msg.personality;
              
              // Create clean Gemini-compatible format
              const cleanMsg = {
                role: msg.role === "assistant" ? "model" : msg.role,
                parts: msg.parts
              };
              
              // Add our metadata (not sent to Gemini, just used for logging/analysis)
              if (personalityInfo) {
                (cleanMsg as any)._personality = personalityInfo; // Use underscore to avoid conflicts
              }
              
              return cleanMsg;
            });
          
          // Add dummy user message if needed
          if (chatHistory.length === 0 || chatHistory[0].role !== "user") {
            chatHistory.unshift({ role: "user", parts: [{ text: "Hello" }] });
          }
          
          logger.info(`[History-Processing] Processed ${chatHistory.length} messages from unified chat with personality info`);
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

  // ENHANCED GROUP CHAT LOGGING
  const otherPersonality = personality === "yin" ? "yang" : "yin";
  
  // Analyze conversation flow
  const conversationAnalysis = analyzeConversationFlow(chatHistory, personality);
  logger.info(`[GroupChat-${personality.toUpperCase()}] 🔄 Conversation analysis:`, conversationAnalysis);

  // ADD DETAILED CHAT HISTORY LOGGING WITH GROUP CONTEXT
  logger.info(`[Chat-History-${personality.toUpperCase()}] 📚 Full chat history being passed to ${personality} model:`, {
    historyLength: chatHistory.length,
    isGroupChat: conversationAnalysis.isGroupChat,
    yinMessages: conversationAnalysis.yinMessages,
    yangMessages: conversationAnalysis.yangMessages,
    lastSpeaker: conversationAnalysis.lastSpeaker,
    lastPersonality: conversationAnalysis.lastPersonality,
    history: chatHistory.map((item, index) => ({
      index,
      role: item.role,
      personality: (item as any)._personality || "unknown",
      speaker: item.role === "model" ? 
        ((item as any)._personality === "yin" ? "😇" : 
         (item as any)._personality === "yang" ? "😈" : "🤖") : "👤",
      content: item.parts[0]?.text ? 
        item.parts[0].text.substring(0, 100) + (item.parts[0].text.length > 100 ? '...' : '') : 
        '[no text]',
      isOtherPersonality: item.role === "model" && (item as any)._personality === otherPersonality
    }))
  });

  const messageParts: Part[] = [];
  if (userPrompt.trim()) {
    // Add group chat context to the message if it's a group chat
    if (conversationAnalysis.isGroupChat) {
      const contextualPrompt = conversationAnalysis.isRespondingToOther 
        ? `[Group Chat: User just asked "${userPrompt}" - the last message was from ${conversationAnalysis.lastPersonality === "yin" ? "😇" : "😈"} (${conversationAnalysis.lastPersonality}). You can respond to the user, react to ${conversationAnalysis.lastPersonality === "yin" ? "😇" : "😈"}'s message, or both.]`
        : `[Group Chat: User said "${userPrompt}"]`;
      messageParts.push({ text: contextualPrompt });
    } else {
      messageParts.push({ text: userPrompt });
    }
  } else if (imageParts.length > 0) {
    messageParts.push({ text: "Describe what you see and provide thoughtful commentary." });
  }
  messageParts.push(...imageParts);

  // ADD MESSAGE PARTS LOGGING
  logger.info(`[Message-${personality.toUpperCase()}] 💬 Message parts being sent to ${personality} model:`, {
    partsCount: messageParts.length,
    currentUserPrompt: userPrompt,
    isRespondingToOtherPersonality: conversationAnalysis.isRespondingToOther,
    parts: messageParts.map((part, index) => ({
      index,
      text: part.text ? part.text.substring(0, 200) + (part.text.length > 200 ? '...' : '') : undefined,
      hasInlineData: !!part.inlineData,
      mimeType: part.inlineData?.mimeType
    }))
  });

  // ADD GENERATION CONFIG LOGGING
  logger.info(`[Config-${personality.toUpperCase()}] ⚙️ Generation config for ${personality} model:`, {
    temperature: generationConfigs[personality].temperature,
    topP: generationConfigs[personality].topP,
    topK: generationConfigs[personality].topK,
    maxOutputTokens: generationConfigs[personality].maxOutputTokens
  });

  async function generateWithModel(modelType: 'primary' | 'fallback') {
    logger.info(`[Model-${personality.toUpperCase()}] 🤖 Calling ${modelType} ${personality} model with complete context:`, {
      personality,
      modelType,
      historyEntries: chatHistory.length,
      currentMessageParts: messageParts.length,
      totalTokensEstimate: estimateTokens(chatHistory, messageParts),
      groupChatContext: {
        isGroupChat: conversationAnalysis.isGroupChat,
        otherPersonality: otherPersonality,
        lastSpeaker: conversationAnalysis.lastSpeaker,
        canSeeOtherResponses: conversationAnalysis.isRespondingToOther
      }
    });

    const model = createPersonalityModel(personality, modelType);
    
    // Clean history for Gemini (preserve personality info in text content)
    const cleanHistory = chatHistory.map(item => ({
      role: item.role,
      parts: item.role === "model" && (item as any)._personality
        ? [{ text: `${(item as any)._personality === "yin" ? "😇" : "😈"}: ${item.parts[0]?.text || ""}` }]
        : item.parts
    }));
    
    // LOG WHAT'S ACTUALLY SENT TO GEMINI
    logger.info(`[Gemini-Input-${personality.toUpperCase()}] 📤 Data being sent to Gemini:`, {
      cleanHistory: cleanHistory.map((item, index) => ({
        index,
        role: item.role,
        text: item.parts[0]?.text?.substring(0, 150) + (item.parts[0]?.text && item.parts[0].text.length > 150 ? '...' : '')
      })),
      messageParts: messageParts.map((part, index) => ({
        index,
        text: part.text?.substring(0, 200) + (part.text && part.text.length > 200 ? '...' : ''),
        hasImage: !!part.inlineData
      }))
    });
    
    const chatSession = model.startChat({
      generationConfig: generationConfigs[personality],
      history: cleanHistory,
    });
    
    const result = await chatSession.sendMessage(messageParts);
    
    const responseText = result.response.text();
    logger.info(`[Response-${personality.toUpperCase()}] 📤 ${personality} ${modelType} model response:`, {
      responseLength: responseText.length,
      responsePreview: responseText.substring(0, 300) + (responseText.length > 300 ? '...' : ''),
      personality,
      modelType,
      potentialReactionToOther: conversationAnalysis.isRespondingToOther
    });
    
    return responseText;
  }

  // Try primary, then fallback
  let responseText: string;
  try {
    responseText = await withRetry(
      () => generateWithModel('primary'),
      RETRY_CONFIG.primary,
      'primary chat'
    );
  } catch (error) {
    logger.error(`[Error-${personality.toUpperCase()}] ❌ Primary ${personality} model failed:`, error);
    try {
      responseText = await withRetry(
        () => generateWithModel('fallback'),
        RETRY_CONFIG.fallback,
        'fallback chat'
      );
    } catch (fallbackError) {
      logger.error(`[Error-${personality.toUpperCase()}] ❌ Fallback ${personality} model also failed:`, fallbackError);
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
    responseJson.bubbles = responseJson.bubbles.map((bubble: string) => 
      bubble.replace(/^😇 yin:\s*|^😈yang:\s*/i, '').trim()
    );
    logger.info(`[Parsed-${personality.toUpperCase()}] 🎯 Final parsed response from ${personality}:`, {
      bubbleCount: responseJson.bubbles.length,
      bubbles: responseJson.bubbles,
      mightBeReactingToOther: conversationAnalysis.isRespondingToOther && responseJson.bubbles.some((bubble: string) => 
        bubble.includes('you') || bubble.includes('your') || bubble.includes('stop') || bubble.includes('fr')
      )
    });
  } catch (parseError) {
    logger.error(`[Parse-Error-${personality.toUpperCase()}] ❌ Failed to parse ${personality} response:`, {
      error: parseError,
      rawResponse: responseText
    });
    responseJson = { bubbles: ["I'm having trouble processing right now."] };
  }
  
  return { responseText, responseJson };
}

// Helper function to analyze conversation flow for group chat dynamics
function analyzeConversationFlow(chatHistory: any[], currentPersonality: PersonalityType) {
  const otherPersonality = currentPersonality === "yin" ? "yang" : "yin";
  
  // Count messages from each personality using our preserved metadata
  const yinMessages = chatHistory.filter(msg => 
    msg.role === "model" && (msg as any)._personality === "yin"
  ).length;
  
  const yangMessages = chatHistory.filter(msg => 
    msg.role === "model" && (msg as any)._personality === "yang"
  ).length;
  
  const hasOtherPersonality = (currentPersonality === "yin" ? yangMessages : yinMessages) > 0;
  
  let lastSpeaker = "user";
  let isRespondingToOther = false;
  let lastPersonality = null;
  
  if (chatHistory.length > 0) {
    const lastEntry = chatHistory[chatHistory.length - 1];
    lastSpeaker = lastEntry.role;
    
    // Check if the last model response was from the other personality
    if (lastEntry.role === "model") {
      lastPersonality = (lastEntry as any)._personality;
      isRespondingToOther = lastPersonality === otherPersonality;
    }
  }
  
  return {
    hasOtherPersonality,
    isGroupChat: hasOtherPersonality,
    lastSpeaker,
    lastPersonality,
    isRespondingToOther,
    conversationTurns: chatHistory.length,
    yinMessages,
    yangMessages,
    otherPersonalityName: otherPersonality === "yin" ? "😇" : "😈"
  };
}

// Helper function to estimate token count for logging
function estimateTokens(chatHistory: Content[], messageParts: Part[]): number {
  const historyText = chatHistory.reduce((acc, item) => 
    acc + item.parts.reduce((partAcc, part) => partAcc + (part.text?.length || 0), 0), 0
  );
  const messageText = messageParts.reduce((acc, part) => acc + (part.text?.length || 0), 0);
  return Math.ceil((historyText + messageText) / 4); // Rough token estimation
}
