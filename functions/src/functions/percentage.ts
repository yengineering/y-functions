import { onRequest } from "firebase-functions/https";
import { authenticate } from "../utils/auth";
import admin from "../admin";
import { logger } from "firebase-functions";

// Define the Message interface
interface Message {
  isUser: boolean;
  content?: string;
  [key: string]: any;
}

export const percentage = onRequest(async (req, res) => {
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

    let yinMessages = 0;
    let yangMessages = 0;

    // Process each conversation document
    convSnap.forEach((doc) => {
      const data = doc.data();
      
      // Count yin messages where isUser is true
      if (data.yin && data.yin.messages && Array.isArray(data.yin.messages)) {
        yinMessages += data.yin.messages.filter((msg: Message) => msg.isUser === true).length;
      }
      
      // Count yang messages where isUser is true
      if (data.yang && data.yang.messages && Array.isArray(data.yang.messages)) {
        yangMessages += data.yang.messages.filter((msg: Message) => msg.isUser === true).length;
      }
    });

    const totalMessages = yinMessages + yangMessages;
    
    // Calculate percentages (handle potential division by zero)
    const yinPercentage = totalMessages > 0 ? yinMessages / totalMessages : 0;
    const yangPercentage = totalMessages > 0 ? yangMessages / totalMessages : 0;

    res.json({
      yin: yinPercentage,
      yang: yangPercentage,
    });
  } catch (error) {
    logger.error(error);
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
