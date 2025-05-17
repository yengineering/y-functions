import "./admin";
import { setGlobalOptions } from "firebase-functions/v2";
import { yinYang } from "./functions/yinYang";
import { myVibe } from "./functions/myVibe";
import { percentage } from "./functions/percentage";
import { caption } from "./functions/caption";
import { handleDeletedPhoto } from "./functions/handleDeletedPhoto";
import "dotenv/config";

export { yinYang, myVibe, percentage, caption, handleDeletedPhoto };

/*
 * Required API keys in ../.env:
 * GEMINI_API_KEY
 * GCP_SERVICE_ACCOUNT
 */

setGlobalOptions({
  serviceAccount: process.env.GCP_SERVICE_ACCOUNT || "",
});
