import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/https";
import { genaiClient } from "../config";
import admin from "../admin";
import { authenticate } from "../utils/auth";
import { GenerationConfig, SchemaType } from "@google/generative-ai";
import { loadPrompt } from "../utils/loadPrompt";

const generationConfig: GenerationConfig = {
  temperature: 1.0,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 8192,
  responseMimeType: "application/json",
  responseSchema: {
    type: SchemaType.OBJECT,
    properties: {
      vibe: {
        type: SchemaType.STRING,
      },
    },
  },
};

export const myVibe = onRequest(async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }

  const uid = await authenticate(req, res, admin.app());
  if (!uid) return;
  logger.info(`Authenticated user: ${uid}`);

  try {
    // Get Firestore instance
    const db = admin.firestore();

    // Get conversation history from firestore
    const conversationsRef = db
      .collection("users")
      .doc(uid)
      .collection("conversations");

    const conversations = await conversationsRef.get();
    logger.info(`Query returned ${conversations.size} conversations`);

    if (conversations.empty) {
      throw new Error("Conversation history is empty.");
    }

    const allMessages: Array<string> = [];
    conversations.forEach((doc) => {
      const data = doc.data();
      // Check if the document has a messages array
      if (data.messages && Array.isArray(data.messages)) {
        // Add each message to our collection
        data.messages.forEach((msg) => {
          if (msg.content) {
            const sender = msg.isUser ? "User" : "Assistant";
            allMessages.push(`${sender}: ${msg.content}`);
          }
        });
      }
    });

    if (allMessages.length === 0) {
      throw new Error(
        "Found conversations, but no message content to analyze.",
      );
    }

    // Join all messages with line breaks
    const messagesText = allMessages.join("\n");
    logger.info(`Extracted ${allMessages.length} messages for analysis`);

    const prompt = `
${loadPrompt("myVibe")}
${messagesText}`;

    const model = genaiClient.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: prompt,
    });

    const chatSession = model.startChat({
      generationConfig,
    });

    const llmResponse = await chatSession.sendMessage("");
    const responseText = llmResponse.response.text();
    const responseJson = JSON.parse(responseText);

    logger.info("Raw Gemini Response Text:", responseText);

    res.json({
      vibe: responseJson.vibe,
    });
  } catch (error: unknown) {
    logger.error(error);
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
