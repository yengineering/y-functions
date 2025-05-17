import { HttpsOptions, onRequest } from "firebase-functions/https";
import { genaiClient } from "../config";
import { logger } from "firebase-functions";
import { loadPrompt } from "../utils/loadPrompt";

interface CustomHttpsOptions extends HttpsOptions {
  allowUnparsed: boolean;
}

// Create separate models for yin and yang personalities
const yinModel = genaiClient.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yin")}`,
});

const yangModel = genaiClient.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction: `${loadPrompt("security")}\n\n${loadPrompt("yang")}`,
});

// Function to generate transitional comment for deleted photos
async function generateTransitionalCommentForDeletion(
  deletedPhotoDescription: string,
  previousPhotoDescription: string,
  nextPhotoDescription: string,
  personality: "yin" | "yang" = "yin",
): Promise<string> {
  logger.info(
    "[Photo-Deletion-Logs] 🔄 Generating transitional comment for deleted photo",
    {
      personality,
      deletedPhotoDescription,
      previousPhotoDescription,
      nextPhotoDescription,
    },
  );

  const model = personality === "yin" ? yinModel : yangModel;
  logger.info(
    "[Photo-Deletion-Logs] Using model for personality: " + personality,
  );

  // Create a prompt that includes all three descriptions
  const transitionPrompt =
    personality === "yin"
      ? `You're looking at two photos in sequence. The first shows: "${previousPhotoDescription}". The next photo shows: "${nextPhotoDescription}".

Write ONE short, witty line connecting the first and next photos. Be subtle and ethereal, like you're noticing a deeper pattern or cosmic connection.

Examples:
- From meditation cushions to city lights, my energy stays aligned
- Trading crystal grids for coffee grounds, still channeling that higher power
- Universe really said "from sage burning to burger flipping" and I felt that
- Went from forest bathing to city racing, still got that spiritual cardio

Keep it short, mystical, and a little funny. ONE line only.`
      : `You're looking at two photos in sequence. The first shows: "${previousPhotoDescription}". The next photo shows: "${nextPhotoDescription}".

Write ONE short, witty line connecting the first and next photos. Be bold and confident, with a touch of humor.

Examples:
- Went from corner store to corner office but kept that same energy
- Started with dollar menu now we're here, still counting blessings tho
- Trading subway seats for CEO chairs but still eating the same snacks
- From bodega runs to business runs but the fit still fresh

Keep it short, bold, and a little funny. ONE line only.`;

  logger.info("[Photo-Deletion-Logs] Sending prompt to model...");
  const transitionResult = await model.generateContent([
    { text: transitionPrompt },
  ]);

  const transitionalComment = (await transitionResult.response).text();
  logger.info("[Photo-Deletion-Logs] ✨ Generated transitional comment:", {
    transitionalComment,
  });

  return transitionalComment;
}

// HTTP endpoint for handling deleted photos
export const handleDeletedPhoto = onRequest(
  { allowUnparsed: true } as CustomHttpsOptions,
  async (req, res) => {
    logger.info("[Photo-Deletion-Logs] 🎯 HandleDeletedPhoto endpoint called", {
      method: req.method,
      path: req.path,
    });

    // Only allow POST requests
    if (req.method !== "POST") {
      logger.warn("[Photo-Deletion-Logs] ❌ Method not allowed:", {
        method: req.method,
      });
      res.status(405).send("Method not allowed");
      return;
    }

    try {
      // Parse the request body
      const body = req.body;
      logger.info("[Photo-Deletion-Logs] Received request body:", { body });

      // Extract the required fields
      const {
        deletedPhotoDescription,
        previousPhotoDescription,
        nextPhotoDescription,
        personality = "yin", // Default to yin if not specified
      } = body;

      // Validate required fields
      if (
        !deletedPhotoDescription ||
        !previousPhotoDescription ||
        !nextPhotoDescription
      ) {
        logger.warn("[Photo-Deletion-Logs] ❌ Missing required fields:", {
          hasDeletedDescription: !!deletedPhotoDescription,
          hasPreviousDescription: !!previousPhotoDescription,
          hasNextDescription: !!nextPhotoDescription,
        });
        res
          .status(400)
          .send(
            "Missing required fields: deletedPhotoDescription, previousPhotoDescription, and nextPhotoDescription are required",
          );
        return;
      }

      logger.info(
        "[Photo-Deletion-Logs] ✅ All required fields present, generating transitional comment...",
      );

      // Generate the transitional comment
      const transitionalComment = await generateTransitionalCommentForDeletion(
        deletedPhotoDescription,
        previousPhotoDescription,
        nextPhotoDescription,
        personality,
      );

      logger.info(
        "[Photo-Deletion-Logs] ✅ Successfully generated transitional comment:",
        { transitionalComment },
      );

      // Return the generated transitional comment
      res.json({ transitionalComment });
    } catch (error) {
      // Handle any errors during processing
      logger.error(
        "[Photo-Deletion-Logs] ❌ Error in handleDeletedPhoto endpoint:",
        error,
      );
      res.status(500).send("Error generating transitional comment");
    }
  },
);
