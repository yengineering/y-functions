import { onRequest } from "firebase-functions/https";
import { genaiClient } from "../config";
import admin from "../admin";
import { authenticate } from "../utils/auth";
import { GenerationConfig, SchemaType } from "@google/generative-ai";
import { loadPrompt } from "../utils/loadPrompt";

// Define the Message interface
interface Message {
  isUser: boolean;
  content?: string;
  [key: string]: any;
}

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

  try {
    // Get Firestore instance
    const db = admin.firestore();
    const userDocRef = db.collection("users").doc(uid);
    const convSnap = await userDocRef.collection("conversations").get();

    if (convSnap.empty) {
      throw new Error("Conversation history is empty.");
    }

    const allMessages: Array<string> = [];

    // Process each conversation document
    convSnap.forEach((doc) => {
      const data = doc.data();

      // Process yin messages
      if (data.yin && data.yin.messages && Array.isArray(data.yin.messages)) {
        data.yin.messages.forEach((msg: Message) => {
          if (msg.content) {
            const sender = msg.isUser ? "User" : "Assistant";
            allMessages.push(`${sender}: ${msg.content}`);
          }
        });
      }

      // Process yang messages
      if (
        data.yang &&
        data.yang.messages &&
        Array.isArray(data.yang.messages)
      ) {
        data.yang.messages.forEach((msg: Message) => {
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

    const prompt = `
${loadPrompt("myVibe")}
${messagesText}`;

    const model = genaiClient.getGenerativeModel({
      model: "gemini-2.0-flash-001",
      systemInstruction: prompt,
    });

    const chatSession = model.startChat({
      generationConfig,
    });

    const llmResponse = await chatSession.sendMessage("");
    const responseText = llmResponse.response.text();
    const responseJson = JSON.parse(responseText);

    res.json({
      vibe: responseJson.vibe,
    });
  } catch (error: unknown) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
