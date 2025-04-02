import "./admin";
import { setGlobalOptions } from "firebase-functions/v2";
import { yang } from "./functions/yang";
import { yin } from "./functions/yin";
import { myVibe } from "./functions/myVibe";
import { percentage } from "./functions/percentage";
import "dotenv/config";

export { yin, yang, myVibe, percentage };

/*
 * Required API keys in ../.env:
 * GEMINI_API_KEY
 * GCP_SERVICE_ACCOUNT
 */

setGlobalOptions({
  serviceAccount: process.env.GCP_SERVICE_ACCOUNT || "",
});
