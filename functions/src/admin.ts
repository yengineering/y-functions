import admin from "firebase-admin";
import { logger } from "firebase-functions";

if (!admin.apps.length) {
  admin.initializeApp();
  logger.info("Firebase admin initialized");
}

export default admin;
