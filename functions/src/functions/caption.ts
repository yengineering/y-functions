import { Part } from "@google/generative-ai";
import { HttpsOptions, onRequest } from "firebase-functions/https";
import busboy from "busboy";
import { logger } from "firebase-functions";
import { Readable } from "stream";
import { loadPrompt } from "../utils/loadPrompt";
import { authenticate } from "../utils/auth";
import admin from "../admin";
import { withRetry } from "../utils/modelRetry";
import { createPersonalityModel } from "../utils/models";

interface CustomHttpsOptions extends HttpsOptions {
  allowUnparsed: boolean;
}

// Simple configuration
const RETRY_CONFIG = {
  primary: { maxRetries: 3, delayMs: 1000, exponentialBackoff: true },
  fallback: { maxRetries: 5, delayMs: 1000 },
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
        logger.info(
          "[CAPTION-API-Logs] 📸 Previous photo description received:",
          {
            length: val.length,
          },
        );
        prevPhotoDescription = val;
      } else if (name === "personality") {
        const requestedPersonality = val.toLowerCase() as "yin" | "yang";
        if (requestedPersonality === "yin" || requestedPersonality === "yang") {
          personality = requestedPersonality;
          logger.info(
            `[CAPTION-API-Logs] 👤 Using personality: ${personality}`,
          );
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
  const effectivePrompt =
    userPrompt.trim() ||
    "Please generate a natural, engaging caption for this image.";

  logger.info("[Chat-API-Logs] 🎨 Starting caption generation", {
    personality,
    hasPrevDescription: !!prevPhotoDescription,
    imageCount: imageParts.length,
    promptLength: effectivePrompt.length,
  });

  // Simple generation function
  async function generateWithModel(
    modelType: "primary" | "fallback",
    prompt: string,
  ) {
    const model = createPersonalityModel(personality, modelType);
    const result = await model.generateContent([
      { text: prompt },
      ...imageParts,
    ]);
    return result.response.text();
  }

  // Generate all content with simple retry
  const [caption, description, transitionalComment] = await Promise.all([
    // Caption
    withRetry(
      () =>
        generateWithModel(
          "primary",
          `${loadPrompt("caption")}\n\nContext: ${effectivePrompt}`,
        ),
      RETRY_CONFIG.primary,
      "caption generation",
    ).catch(() =>
      withRetry(
        () =>
          generateWithModel(
            "fallback",
            `${loadPrompt("caption")}\n\nContext: ${effectivePrompt}`,
          ),
        RETRY_CONFIG.fallback,
        "caption fallback",
      ).catch(() => "Caption unavailable"),
    ),

    // Description
    withRetry(
      () =>
        generateWithModel(
          "primary",
          "Describe this image in one simple, factual sentence.",
        ),
      RETRY_CONFIG.primary,
      "description generation",
    ).catch(() => ""),

    // Transitional comment (if needed)
    prevPhotoDescription
      ? withRetry(
          () =>
            generateWithModel(
              "primary",
              loadPrompt(`${personality}_transition`).replace(
                "{prevPhotoDescription}",
                prevPhotoDescription,
              ),
            ),
          RETRY_CONFIG.primary,
          "transition generation",
        ).catch(() => "")
      : Promise.resolve(""),
  ]);

  logger.info("[CAPTION-API-Logs] ✅ Caption generation complete", {
    caption,
    description,
    hasTransitionalComment: !!transitionalComment,
  });

  return {
    caption,
    description,
    transitionalComment: transitionalComment || undefined,
  };
}
