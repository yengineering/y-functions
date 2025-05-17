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
import { generateCaption } from "./caption";

interface CustomHttpsOptions extends HttpsOptions {
  allowUnparsed: boolean;
}

const model = genaiClient.getGenerativeModel({
  model: "gemini-2.5-flash-preview-04-17",
  systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yang")}`,
});

const generationConfig: GenerationConfig = {
  temperature: 1.15,
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

export const yang = onRequest(
  { allowUnparsed: true } as CustomHttpsOptions,
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    // Authenticate the request
    const uid = await authenticate(req, res, admin.app());
    if (!uid) return;
    logger.info(`Authenticated user: ${uid}`);

    let userPrompt = "";
    let chatHistory: Content[] = [];
    let prevPhotoDescription = "";
    // Content has role (user/model) and parts: Part[]
    // TextPart - text string
    // InlineDataPart - image data
    // FileDataPart - represents file data

    try {
      const bb = busboy({ headers: req.headers });

      bb.on("field", (name: string, val: string) => {
        logger.info(`Field: ${name}, Value: ${val}`);
        if (name === "prompt") {
          userPrompt = val;
        } else if (name === "prevPhotoDescription") {
          logger.info("📸 Previous photo description received:", val);
          prevPhotoDescription = val;
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

            // Replace 'assistant' with 'model' in the chat history
            chatHistory = chatHistory.map((item) => ({
              ...item,
              role: item.role === "assistant" ? "model" : item.role,
            }));

            // Filter out leading model messages
            if (chatHistory.length > 0 && chatHistory[0].role === "model") {
              logger.info("Removing leading model message from chat history");
              chatHistory = chatHistory.filter(
                (item, index) => !(index === 0 && item.role === "model"),
              );
            }

            // If chat history is now empty or still starts with a non-user message, add a dummy user message
            if (chatHistory.length === 0 || chatHistory[0].role !== "user") {
              logger.info(
                "Adding dummy user message at the beginning of chat history",
              );
              chatHistory.unshift({
                role: "user",
                parts: [{ text: "Hello" }],
              });
            }
          } catch (error) {
            logger.error("Error parsing history field", error);
            res.status(400).send("Invalid history format");
            return;
          }
        }
      });

      const imageParts: Part[] = [];
      const filePromises: Promise<void>[] = [];

      bb.on(
        "file",
        (
          name: string,
          fileStream: Readable,
          info: { filename: string; mimeType: string },
        ) => {
          logger.info(`File: ${name}, FileInfo: ${JSON.stringify(info)}`);

          if (name !== "images") {
            // Skip non-image files.
            fileStream.resume();
            return;
          }

          logger.info(
            `Processing file: ${info.filename}, MIME type: ${info.mimeType}`,
          );

          // Validate allowed MIME types
          const allowedMimeTypes = [
            "image/jpeg",
            "image/png",
            "image/heif",
            "image/webp",
          ];
          if (!allowedMimeTypes.includes(info.mimeType)) {
            logger.warn(
              `Rejected file with invalid MIME type: ${info.mimeType}`,
            );
            fileStream.resume(); // Discard the file
            return;
          } else {
            logger.info(
              `Accepted file: ${info.filename} with MIME type ${info.mimeType}`,
            );
          }

          const chunks: Buffer[] = [];

          fileStream.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });

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
                resolve();
              });
              fileStream.on("error", reject);
            }),
          );
        },
      );

      // Wrap Busboy processing in a promise so that we wait for it to finish.
      await new Promise<void>((resolve, reject) => {
        bb.on("finish", async () => {
          try {
            await Promise.all(filePromises);
            logger.info(
              `File promises completed. Total image parts: ${imageParts.length}`,
            );
            for (let i = 0; i < imageParts.length; i++) {
              const part = imageParts[i];
              logger.info(
                `Image ${i + 1} details: ${JSON.stringify({
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
                })} `,
              );
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        bb.once("error", reject);
        bb.end(req.rawBody);
      });

      logger.info(`${imageParts.length} images processed`);

      const chatSession = model.startChat({
        generationConfig,
        history: chatHistory,
      });

      const messageParts: Part[] = [{ text: userPrompt }, ...imageParts];

      // Run both operations in parallel
      const [llmResponse, captionResult] = await Promise.all([
        chatSession.sendMessage(messageParts),
        imageParts.length > 0
          ? generateCaption(
              imageParts,
              userPrompt,
              "yang",
              prevPhotoDescription,
            ).catch((error) => {
              logger.error("Error generating caption:", error);
              return undefined;
            })
          : Promise.resolve(undefined),
      ]);

      const responseText = llmResponse.response.text();
      const responseJson = JSON.parse(responseText);

      logger.info("Raw Gemini Response Text:", responseText);
      logger.info("Caption Generation Result:", captionResult);

      res.json({
        bubbles: responseJson.bubbles,
        caption: captionResult?.caption,
        description: captionResult?.description,
        transitionalComment: captionResult?.transitionalComment,
      });
    } catch (error) {
      logger.error("Error processing endpoint:", error);
      res.status(500).send("Error processing your request");
    }
  },
);
