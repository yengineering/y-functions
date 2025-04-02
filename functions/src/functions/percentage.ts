import { onRequest } from "firebase-functions/https";
import { authenticate } from "../utils/auth";
import admin from "../admin";
import { logger } from "firebase-functions";

export const percentage = onRequest(async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).send("Methond not allowed");
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

    let yinMessages = 0;
    let yangMessages = 0;
    conversations.forEach((doc) => {
      const data = doc.data();
      if (data.chatMode === "yin") {
        yinMessages += data.messages.length;
      } else {
        yangMessages += data.messages.length;
      }
    });

    const yinPercentage = yinMessages / (yinMessages + yangMessages);
    const yangPercentage = yangMessages / (yinMessages + yangMessages);

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
