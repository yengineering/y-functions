import { genaiClient } from "../config";
import { Part } from "@google/generative-ai";
import { HttpsOptions, onRequest } from "firebase-functions/https";
import busboy from "busboy";
import { logger } from "firebase-functions";
import { Readable } from "stream";
import { loadPrompt } from "../utils/loadPrompt";
import { authenticate } from "../utils/auth";
import admin from "../admin";

interface CustomHttpsOptions extends HttpsOptions {
  allowUnparsed: boolean;
}

// Retry configuration (Primary 2.0 Flash, Fallback 2.5 Flash)
const RETRY_DELAY_MS = 1000; // 1 second
const MAX_PRIMARY_RETRIES = 3;
const MAX_FALLBACK_RETRIES = 10;
const FAILURE_RESPONSES = {
  caption: "caption error",
  description: "",
  transitionalComment: ""
};

const DESCRIPTION_PROMPT = "Describe this image in one simple, factual sentence. Focus on what is literally in the image without any style or personality.";

// Initialize personality-specific models with their respective system instructions
// Each model uses the same base model but with different personality prompts
const personalityModels = {
  yin: {
    primary: genaiClient.getGenerativeModel({
      model: "gemini-2.5-flash-preview-05-20",
      systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yin")}`,
    }),
    fallback: genaiClient.getGenerativeModel({
      model: "gemini-2.5-flash-preview-05-20",
      systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yin")}`,
    }),
  },
  yang: {
    primary: genaiClient.getGenerativeModel({
      model: "gemini-2.5-flash-preview-05-20",
      systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yang")}`,
    }),
    fallback: genaiClient.getGenerativeModel({
      model: "gemini-2.5-flash-preview-05-20",
      systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yang")}`,
    }),
  },
};

// Interface for processed form data and images
interface ProcessedFormData {
  userPrompt: string;
  prevPhotoDescription?: string;
  personality: "yin" | "yang";
  imageParts: Part[];
}

// HTTP endpoint for generating image captions
export const caption = onRequest(
  { allowUnparsed: true } as CustomHttpsOptions,
  async (req, res) => {
    logger.info("[CAPTION-API-Logs] 🚀 Caption endpoint called", {
      method: req.method,
      path: req.path,
    });

    // Only allow POST requests
    if (req.method !== "POST") {
      logger.info("[CAPTION-API-Logs] ❌ Method not allowed:", req.method);
      res.status(405).send("Method not allowed");
      return;
    }

    // Authenticate the user and get their UID
    const uid = await authenticate(req, res, admin.app());
    if (!uid) return;
    logger.info(`[CAPTION-API-Logs] 👤 Authenticated user: ${uid}`);

    try {
      // Process form data and images in a single step
      logger.info("[CAPTION-API-Logs] 📝 Processing form data and images...");
      const { userPrompt, prevPhotoDescription, personality, imageParts } =
        await processFormDataAndImages(req);

      logger.info("[CAPTION-API-Logs] 📦 Form data processed:", {
        hasUserPrompt: !!userPrompt,
        hasPrevDescription: !!prevPhotoDescription,
        personality,
        imageCount: imageParts.length,
      });

      // Validate that at least one image was provided
      if (imageParts.length === 0) {
        logger.info("[CAPTION-API-Logs] ❌ No images provided");
        res.status(400).send("No images provided");
        return;
      }

      // Generate caption using the processed image and user prompt
      logger.info("[CAPTION-API-Logs] 🎨 Starting caption generation...");
      const { caption, description, transitionalComment } =
        await generateCaption(
          imageParts,
          userPrompt,
          personality,
          prevPhotoDescription,
        );

      logger.info("[CAPTION-API-Logs] ✅ Caption generation complete:", {
        captionLength: caption.length,
        descriptionLength: description.length,
        hasTransitionalComment: !!transitionalComment,
      });

      // Return the generated caption, description, and transitional comment as JSON
      res.json({ caption, description, transitionalComment });
      logger.info("[CAPTION-API-Logs] 📤 Response sent successfully");
    } catch (error) {
      // Handle any errors during processing
      logger.error("[CAPTION-API-Logs] ❌ Error in caption endpoint:", error);
      res.status(500).send("Error generating caption");
    }
  },
);

// Process all form data including fields and files in a single function
async function processFormDataAndImages(
  req: import("express").Request,
): Promise<ProcessedFormData> {
  logger.info("[CAPTION-API-Logs] 📝 Starting form data processing");

  return await new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    let userPrompt = "";
    let prevPhotoDescription: string | undefined;
    let personality: "yin" | "yang" = "yin";
    const imageParts: Part[] = [];
    const filePromises: Promise<void>[] = [];

    // Handle form fields
    bb.on("field", (name: string, val: string) => {
      logger.info(`[CAPTION-API-Logs] 📋 Processing field: ${name}`);

      if (name === "prompt") {
        userPrompt = val;
        logger.info("[CAPTION-API-Logs] - User prompt received:", {
          length: val.length,
        });
      } else if (name === "prevPhotoDescription") {
        logger.info("[CAPTION-API-Logs] 📸 Previous photo description received:", {
          length: val.length,
        });
        prevPhotoDescription = val;
      } else if (name === "personality") {
        const requestedPersonality = val.toLowerCase() as "yin" | "yang";
        if (requestedPersonality === "yin" || requestedPersonality === "yang") {
          personality = requestedPersonality;
          logger.info(`[CAPTION-API-Logs] 👤 Using personality: ${personality}`);
        } else {
          logger.warn(
            `[CAPTION-API-Logs] ⚠️ Invalid personality requested: ${val}, defaulting to yin`,
          );
        }
      }
    });

    // Handle file uploads
    bb.on(
      "file",
      (
        name: string,
        fileStream: Readable,
        info: { filename: string; mimeType: string },
      ) => {
        if (name !== "images") {
          logger.info(`[CAPTION-API-Logs] ⚠️ Skipping non-image file: ${name}`);
          fileStream.resume();
          return;
        }

        logger.info(`[CAPTION-API-Logs] 📤 Processing file:`, {
          filename: info.filename,
          mimeType: info.mimeType,
        });

        // Validate image MIME types
        const allowedMimeTypes = [
          "image/jpeg",
          "image/png",
          "image/heif",
          "image/webp",
        ];
        if (!allowedMimeTypes.includes(info.mimeType)) {
          logger.warn(
            `[CAPTION-API-Logs] ❌ Rejected file with invalid MIME type: ${info.mimeType}`,
          );
          fileStream.resume();
          return;
        }

        // Collect file chunks
        const chunks: Buffer[] = [];
        fileStream.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        // Process the file when upload is complete
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
              logger.info(
                `[CAPTION-API-Logs] ✅ File processed: ${info.filename}`,
              );
              resolve();
            });
            fileStream.on("error", (error) => {
              logger.error(
                `[CAPTION-API-Logs] ❌ Error processing file: ${info.filename}`,
                error,
              );
              reject(error);
            });
          }),
        );
      },
    );

    // Handle completion
    bb.on("finish", async () => {
      try {
        await Promise.all(filePromises);
        logger.info(
          `[CAPTION-API-Logs] ✅ All files processed. Total image parts: ${imageParts.length}`,
        );
        resolve({
          userPrompt,
          prevPhotoDescription,
          personality,
          imageParts,
        });
      } catch (error) {
        logger.error("[CAPTION-API-Logs] ❌ Error processing files:", error);
        reject(error);
      }
    });

    bb.once("error", (error) => {
      logger.error("[CAPTION-API-Logs] ❌ Busboy error:", error);
      reject(error);
    });

    bb.end((req as any).rawBody);
  });
}

export async function generateCaption(
  imageParts: Part[],
  userPrompt: string,
  personality: "yin" | "yang" = "yin",
  prevPhotoDescription?: string,
): Promise<{
  caption: string;
  description: string;
  transitionalComment?: string;
}> {
  const effectivePrompt = userPrompt.trim() || "Please generate a natural, engaging caption for this image that captures its essence and meaning.";

  logger.info("[CAPTION-API-Logs] 🎨 Starting caption generation", {
    personality,
    hasPrevDescription: !!prevPhotoDescription,
    prevPhotoDescription: prevPhotoDescription || "none provided",
    imageCount: imageParts.length,
    promptLength: effectivePrompt.length,
    isDefaultPrompt: !userPrompt.trim(),
  });

  // Prepare all generation tasks
  const generationTasks = [
    // Generate the social media caption
    generateContentWithRetry(personality, [
      {
        text: `${loadPrompt("caption")}\n\nContext from user: ${effectivePrompt}`,
      },
      ...imageParts,
    ], 'caption'),

    // Generate a plain description
    generateContentWithRetry(personality, [
      {
        text: DESCRIPTION_PROMPT,
      },
      ...imageParts,
    ], 'description'),

    // Generate transitional comment if needed
    prevPhotoDescription
      ? generateContentWithRetry(personality, [
          {
            text: personality === "yin"
              ? loadPrompt("yin_transition").replace(
                  "{prevPhotoDescription}",
                  prevPhotoDescription,
                )
              : loadPrompt("yang_transition").replace(
                  "{prevPhotoDescription}",
                  prevPhotoDescription,
                ),
          },
          ...imageParts,
        ], 'transitionalComment')
      : Promise.resolve(""),
  ];

  // Execute all generations in parallel
  logger.info("[CAPTION-API-Logs] 🚀 Starting parallel generation of caption, description, and transitional comment");
  const [caption, description, transitionalComment] = await Promise.all(generationTasks);

  logger.info("[CAPTION-API-Logs] ✅ Caption generation complete", {
    caption,
    description,
    hasTransitionalComment: !!transitionalComment,
    ...(transitionalComment && { transitionalComment }),
  });

  return { 
    caption, 
    description, 
    transitionalComment: transitionalComment || undefined 
  };
}

// Add this helper function for retrying content generation
async function generateContentWithRetry(
  personality: "yin" | "yang",
  parts: any[],
  responseType: keyof typeof FAILURE_RESPONSES
): Promise<string> {
  // Primary model retry logic
  let primaryRetries = 0;

  while (primaryRetries < MAX_PRIMARY_RETRIES) {
    try {
      const result = await invokeLLM(personality, parts, 'primary');
      return (await result.response).text();
    } catch (error: any) {
      if (error.status === 503) {
        primaryRetries++;
        logger.warn(
          `[CAPTION-API-Logs] ⚠️ Primary model overloaded. Retrying (${primaryRetries}/${MAX_PRIMARY_RETRIES})...`
        );
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * primaryRetries)); // Exponential backoff
      } else {
        throw error;
      }
    }
  }

  // If primary model fails, try fallback model
  logger.warn(
    "[CAPTION-API-Logs] 🚨 Primary model failed. Switching to fallback model ('gemini-2.5-flash-preview-05-20')."
  );

  // Fallback model retry logic
  let fallbackRetries = 0;

  while (fallbackRetries < MAX_FALLBACK_RETRIES) {
    try {
      const result = await invokeLLM(personality, parts, 'fallback');
      return (await result.response).text();
    } catch (error: any) {
      if (error.status === 503) {
        fallbackRetries++;
        logger.warn(
          `[CAPTION-API-Logs] ⚠️ Fallback model overloaded. Retrying (${fallbackRetries}/${MAX_FALLBACK_RETRIES})...`
        );
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS)); // Constant delay for fallback
      } else {
        throw error;
      }
    }
  }

  // If all retries fail, return the appropriate failure response
  logger.error(`[CAPTION-API-Logs] ❌ All retries failed for ${responseType}. Returning failure response.`);
  return FAILURE_RESPONSES[responseType];
}

// Helper function to invoke LLM
async function invokeLLM(
  personality: "yin" | "yang",
  parts: any[],
  modelType: 'primary' | 'fallback'
): Promise<any> {
  logger.info(
    `[CAPTION-API-Logs] 🤖 Attempting ${modelType} model`
  );
  const result = await personalityModels[personality][modelType].generateContent(parts);
  logger.info(`[CAPTION-API-Logs] ✅ ${modelType} model succeeded.`);
  return result;
}