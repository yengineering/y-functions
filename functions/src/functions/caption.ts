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

// Interface for processed form data and images
interface ProcessedFormData {
  userPrompt: string;
  prevPhotoDescription?: string;
  personality: "yin" | "yang";
  imageParts: Part[];
}

// Process all form data including fields and files in a single function
async function processFormDataAndImages(
  req: import("express").Request,
): Promise<ProcessedFormData> {
  logger.info("[Chat-API-Logs] 📝 Starting form data processing");

  return await new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
    let userPrompt = "";
    let prevPhotoDescription: string | undefined;
    let personality: "yin" | "yang" = "yin";
    const imageParts: Part[] = [];
    const filePromises: Promise<void>[] = [];

    // Handle form fields
    bb.on("field", (name: string, val: string) => {
      logger.info(`[Chat-API-Logs] 📋 Processing field: ${name}`);

      if (name === "prompt") {
        userPrompt = val;
        logger.info("[Chat-API-Logs] - User prompt received:", {
          length: val.length,
        });
      } else if (name === "prevPhotoDescription") {
        logger.info("[Chat-API-Logs] 📸 Previous photo description received:", {
          length: val.length,
        });
        prevPhotoDescription = val;
      } else if (name === "personality") {
        const requestedPersonality = val.toLowerCase() as "yin" | "yang";
        if (requestedPersonality === "yin" || requestedPersonality === "yang") {
          personality = requestedPersonality;
          logger.info(`[Chat-API-Logs] 👤 Using personality: ${personality}`);
        } else {
          logger.warn(
            `[Chat-API-Logs] ⚠️ Invalid personality requested: ${val}, defaulting to yin`,
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
          logger.info(`[Chat-API-Logs] ⚠️ Skipping non-image file: ${name}`);
          fileStream.resume();
          return;
        }

        logger.info(`[Chat-API-Logs] 📤 Processing file:`, {
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
            `[Chat-API-Logs] ❌ Rejected file with invalid MIME type: ${info.mimeType}`,
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
                `[Chat-API-Logs] ✅ File processed: ${info.filename}`,
              );
              resolve();
            });
            fileStream.on("error", (error) => {
              logger.error(
                `[Chat-API-Logs] ❌ Error processing file: ${info.filename}`,
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
          `[Chat-API-Logs] ✅ All files processed. Total image parts: ${imageParts.length}`,
        );
        resolve({
          userPrompt,
          prevPhotoDescription,
          personality,
          imageParts,
        });
      } catch (error) {
        logger.error("[Chat-API-Logs] ❌ Error processing files:", error);
        reject(error);
      }
    });

    bb.once("error", (error) => {
      logger.error("[Chat-API-Logs] ❌ Busboy error:", error);
      reject(error);
    });

    bb.end((req as any).rawBody);
  });
}

// HTTP endpoint for generating image captions
export const caption = onRequest(
  { allowUnparsed: true } as CustomHttpsOptions,
  async (req, res) => {
    logger.info("[Chat-API-Logs] 🚀 Caption endpoint called", {
      method: req.method,
      path: req.path,
    });

    // Only allow POST requests
    if (req.method !== "POST") {
      logger.info("[Chat-API-Logs] ❌ Method not allowed:", req.method);
      res.status(405).send("Method not allowed");
      return;
    }

    // Authenticate the user and get their UID
    const uid = await authenticate(req, res, admin.app());
    if (!uid) return;
    logger.info(`[Chat-API-Logs] 👤 Authenticated user: ${uid}`);

    try {
      // Process form data and images in a single step
      logger.info("[Chat-API-Logs] 📝 Processing form data and images...");
      const { userPrompt, prevPhotoDescription, personality, imageParts } =
        await processFormDataAndImages(req);

      logger.info("[Chat-API-Logs] 📦 Form data processed:", {
        hasUserPrompt: !!userPrompt,
        hasPrevDescription: !!prevPhotoDescription,
        personality,
        imageCount: imageParts.length,
      });

      // Validate that at least one image was provided
      if (imageParts.length === 0) {
        logger.info("[Chat-API-Logs] ❌ No images provided");
        res.status(400).send("No images provided");
        return;
      }

      // Generate caption using the processed image and user prompt
      logger.info("[Chat-API-Logs] 🎨 Starting caption generation...");
      const { caption, description, transitionalComment } =
        await generateCaption(
          imageParts,
          userPrompt,
          personality,
          prevPhotoDescription,
        );

      logger.info("[Chat-API-Logs] ✅ Caption generation complete:", {
        captionLength: caption.length,
        descriptionLength: description.length,
        hasTransitionalComment: !!transitionalComment,
      });

      // Return the generated caption, description, and transitional comment as JSON
      res.json({ caption, description, transitionalComment });
      logger.info("[Chat-API-Logs] 📤 Response sent successfully");
    } catch (error) {
      // Handle any errors during processing
      logger.error("[Chat-API-Logs] ❌ Error in caption endpoint:", error);
      res.status(500).send("Error generating caption");
    }
  },
);

// Utility function for generating captions
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
  logger.info("[Chat-API-Logs] 🎨 Starting caption generation", {
    personality,
    hasPrevDescription: !!prevPhotoDescription,
    prevPhotoDescription: prevPhotoDescription || "none provided",
    imageCount: imageParts.length,
    promptLength: userPrompt.length,
  });

  // Initialize the appropriate model based on personality
  logger.info(
    "[Chat-API-Logs] 🤖 Initializing model for personality:",
    personality,
  );
  const model = genaiClient.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt(personality)}`,
  });

  // Generate the social media caption
  logger.info("[Chat-API-Logs] 📝 Generating social media caption...");
  const captionResult = await model.generateContent([
    {
      text: `${loadPrompt("caption")}\n\nContext from user: ${userPrompt}`,
    },
    ...imageParts,
  ]);

  // Generate a plain description
  logger.info("[Chat-API-Logs] 📋 Generating plain description...");
  const descriptionResult = await model.generateContent([
    {
      text: `Describe this image in one simple, factual sentence. Focus on what is literally in the image without any style or personality.`,
    },
    ...imageParts,
  ]);

  // If we have a previous photo description, generate a transitional comment
  let transitionalComment: string | undefined;
  if (prevPhotoDescription) {
    logger.info(
      "[Chat-API-Logs] 🔄 Generating transitional comment for previous photo:",
      { prevPhotoDescription },
    );
    const transitionPrompt =
      personality === "yin"
        ? loadPrompt("yin_transition").replace(
            "{prevPhotoDescription}",
            prevPhotoDescription,
          )
        : loadPrompt("yang_transition").replace(
            "{prevPhotoDescription}",
            prevPhotoDescription,
          );

    const transitionResult = await model.generateContent([
      { text: transitionPrompt },
      ...imageParts,
    ]);

    transitionalComment = (await transitionResult.response).text();
    logger.info("[Chat-API-Logs] ✨ Generated transitional comment:", {
      transitionalComment,
    });
  }

  const caption = (await captionResult.response).text();
  const description = (await descriptionResult.response).text();

  logger.info("[Chat-API-Logs] ✅ Caption generation complete", {
    caption,
    description,
    hasTransitionalComment: !!transitionalComment,
    ...(transitionalComment && { transitionalComment }), // Only include if it exists
  });

  return { caption, description, transitionalComment };
}
