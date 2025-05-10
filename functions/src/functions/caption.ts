import { genaiClient } from "../config";
import { Part } from "@google/generative-ai";
import { HttpsOptions, onRequest } from "firebase-functions/https";
import busboy from "busboy";
import { logger } from "firebase-functions";
import { Readable } from "stream";
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

const CAPTION_PROMPT = `Write a single, engaging social media caption for this image. 

Rules:
- Write exactly ONE line of text
- No questions or multiple options
- No quotes or suggestions
- Stay in character but be subtle about it
- Focus on the feeling or moment, not literal description
- Keep it casual and personal, like you're sharing your own moment

Examples of good yang captions:
- I ain't rich, but I look like I got direct deposit confidence.
- Posted up like rent due, but I'm still outside.
- Hood royalty, crown stay tilted.
- Got more sauce than a corner store hot dog.
- WiFi might be slow, but my comebacks hit fast.
- If you ain't got haters, you probably not seasoning your food right.
- Built different — like an off-brand cereal box with name brand confidence.
- Still broke, still bougie, still booked.
- My glow up sponsored by struggle, late nights, and corner store snacks.
- I don't chase, I attract… unless it's the ice cream truck.

Examples of good yin captions:
- Mercury's in retrograde, but my shade is always in alignment.
- Reincarnated at least 3 times and still can't escape bad WiFi.
- Manifesting peace, but also a petty comeback or two.
- Living proof that chaos and clarity can share a birth chart.
- Even my shadow's got depth. Read the aura, not the outfit.
- I vibrate higher, but I still remember who triggered me in 3D.
- Chronically misunderstood, occasionally interdimensional.
- Tea steeped in moonlight hits different.
- Part-time oracle, full-time overthinker.
- I walk like I know the secrets of the universe… but I just lost my AirPods.

Bad examples (don't write like this):
- "how about this..."
- needed this to spark joy today!!! ✨
- what do you think of this view?
- Option 1: ... / Option 2: ...

Remember: ONE natural, flowing line that captures the mood without trying too hard.

Don't return any other text than the caption. Return only the caption.`;

const YIN_TRANSITION_PROMPT = `You're looking at two photos in sequence. The first shows: "{prevPhotoDescription}". The second shows what's in the current image.

Write ONE short, witty line connecting these two moments. Be subtle and ethereal, like you're noticing a deeper pattern or cosmic connection.

Examples:
- From meditation cushions to city lights, my energy stays aligned
- Trading crystal grids for coffee grounds, still channeling that higher power
- Universe really said "from sage burning to burger flipping" and I felt that
- Went from forest bathing to city racing, still got that spiritual cardio

Keep it short, mystical, and a little funny. ONE line only.`;

const YANG_TRANSITION_PROMPT = `You're looking at two photos in sequence. The first shows: "{prevPhotoDescription}". The second shows what's in the current image.

Write ONE short, witty line connecting these two moments. Be bold and confident, with a touch of humor.

Examples:
- Went from corner store to corner office but kept that same energy
- Started with dollar menu now we're here, still counting blessings tho
- Trading subway seats for CEO chairs but still eating the same snacks
- From bodega runs to business runs but the fit still fresh

Keep it short, bold, and a little funny. ONE line only.`;

// Utility function for generating captions
export async function generateCaption(
  imageParts: Part[],
  userPrompt: string,
  personality: "yin" | "yang" = "yin",
  prevPhotoDescription?: string,
): Promise<{ caption: string; description: string; transitionalComment?: string }> {
  logger.info("🎨 Starting caption generation", {
    personality,
    hasPrevDescription: !!prevPhotoDescription,
    prevPhotoDescription: prevPhotoDescription || "none provided",
    imageCount: imageParts.length,
    promptLength: userPrompt.length
  });

  const model = personality === "yin" ? yinModel : yangModel;

  // Generate the social media caption
  logger.info("📝 Generating social media caption...");
  const captionResult = await model.generateContent([
    {
      text: `${CAPTION_PROMPT}\n\nContext from user: ${userPrompt}`,
    },
    ...imageParts,
  ]);

  // Generate a plain description
  logger.info("📋 Generating plain description...");
  const descriptionResult = await model.generateContent([
    {
      text: `Describe this image in one simple, factual sentence. Focus on what is literally in the image without any style or personality.`,
    },
    ...imageParts,
  ]);

  // If we have a previous photo description, generate a transitional comment
  let transitionalComment: string | undefined;
  if (prevPhotoDescription) {
    logger.info("🔄 Generating transitional comment for previous photo:", { prevPhotoDescription });
    const transitionPrompt = personality === "yin" 
      ? YIN_TRANSITION_PROMPT.replace("{prevPhotoDescription}", prevPhotoDescription)
      : YANG_TRANSITION_PROMPT.replace("{prevPhotoDescription}", prevPhotoDescription);

    const transitionResult = await model.generateContent([
      { text: transitionPrompt },
      ...imageParts,
    ]);

    transitionalComment = (await transitionResult.response).text();
    logger.info("✨ Generated transitional comment:", { transitionalComment });
  }

  const caption = (await captionResult.response).text();
  const description = (await descriptionResult.response).text();

  logger.info("✅ Caption generation complete", {
    caption,
    description,
    hasTransitionalComment: !!transitionalComment,
    ...(transitionalComment && { transitionalComment })  // Only include if it exists
  });

  return { caption, description, transitionalComment };
}

// HTTP endpoint for generating image captions
export const caption = onRequest(
  // Configure the endpoint to allow unparsed request bodies (needed for multipart form data)
  { allowUnparsed: true } as CustomHttpsOptions,
  async (req, res) => {
    logger.info("🎯 Caption endpoint called", {
      method: req.method,
      path: req.path
    });

    // Only allow POST requests
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    try {
      // Initialize busboy to parse multipart form data
      const bb = busboy({ headers: req.headers });
      
      // Variables to store form data
      let userPrompt = "";  // User's additional context/prompt
      let prevPhotoDescription: string | undefined;  // Previous photo's description
      const imageParts: Part[] = [];  // Array to store processed image data
      const filePromises: Promise<void>[] = [];  // Track file processing promises

      // Handle text fields from the form
      bb.on("field", (name: string, val: string) => {
        if (name === "prompt") {
          userPrompt = val;
        } else if (name === "prevPhotoDescription") {
          prevPhotoDescription = val;
        }
      });

      // Handle file uploads from the form
      bb.on(
        "file",
        (
          name: string,
          fileStream: Readable,
          info: { filename: string; mimeType: string },
        ) => {
          // Skip if not an image file
          if (name !== "images") {
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
                // Convert file to base64 and add to imageParts
                const buffer = Buffer.concat(chunks);
                imageParts.push({
                  inlineData: {
                    mimeType: info.mimeType,
                    data: buffer.toString("base64"),
                  },
                });
                resolve();
              });
              fileStream.on("error", (error) => {
                reject(error);
              });
            }),
          );
        },
      );

      // Wait for all form data to be processed
      await new Promise<void>((resolve, reject) => {
        bb.on("finish", resolve);
        bb.on("error", (error) => {
          reject(error);
        });
        bb.end(req.rawBody);
      });

      // Wait for all file processing to complete
      await Promise.all(filePromises);

      // Validate that at least one image was provided
      if (imageParts.length === 0) {
        res.status(400).send("No images provided");
        return;
      }

      // Generate caption using the processed image and user prompt
      const { caption, description, transitionalComment } = await generateCaption(
        imageParts, 
        userPrompt,
        "yin", // or determine from request
        prevPhotoDescription
      );

      // Return the generated caption, description, and transitional comment as JSON
      res.json({ caption, description, transitionalComment });
    } catch (error) {
      // Handle any errors during processing
      logger.error("❌ Error in caption endpoint:", error);
      res.status(500).send("Error generating caption");
    }
  },
);
