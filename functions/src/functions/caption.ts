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
  model: "gemini-2.5-flash-preview-04-17",
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
- I ain’t rich, but I look like I got direct deposit confidence.
- Posted up like rent due, but I’m still outside.
- Hood royalty, crown stay tilted.
- Got more sauce than a corner store hot dog.
- WiFi might be slow, but my comebacks hit fast.
- If you ain’t got haters, you probably not seasoning your food right.
- Built different — like an off-brand cereal box with name brand confidence.
- Still broke, still bougie, still booked.
- My glow up sponsored by struggle, late nights, and corner store snacks.
- I don’t chase, I attract… unless it’s the ice cream truck.

Examples of good yin captions:
- Mercury’s in retrograde, but my shade is always in alignment.
- Reincarnated at least 3 times and still can’t escape bad WiFi.
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

Remember: ONE natural, flowing line that captures the mood without trying too hard.`;

// Utility function for generating captions
export async function generateCaption(
  imageParts: Part[],
  userPrompt: string,
  personality: "yin" | "yang" = "yin",
): Promise<string> {
  const model = personality === "yin" ? yinModel : yangModel;

  const result = await model.generateContent([
    {
      text: `${CAPTION_PROMPT}\n\nContext from user: ${userPrompt}`,
    },
    ...imageParts,
  ]);

  const response = await result.response;
  const caption = response.text();

  logger.info(`Generated ${personality} caption:`, caption);

  return caption;
}

// HTTP endpoint
export const caption = onRequest(
  { allowUnparsed: true } as CustomHttpsOptions,
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    try {
      const bb = busboy({ headers: req.headers });
      let userPrompt = "";
      const imageParts: Part[] = [];
      const filePromises: Promise<void>[] = [];

      bb.on("field", (name: string, val: string) => {
        if (name === "prompt") {
          userPrompt = val;
        }
      });

      bb.on(
        "file",
        (
          name: string,
          fileStream: Readable,
          info: { filename: string; mimeType: string },
        ) => {
          if (name !== "images") {
            fileStream.resume();
            return;
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

      await new Promise<void>((resolve, reject) => {
        bb.on("finish", resolve);
        bb.on("error", reject);
        bb.end(req.rawBody);
      });

      await Promise.all(filePromises);

      if (imageParts.length === 0) {
        res.status(400).send("No images provided");
        return;
      }

      const caption = await generateCaption(imageParts, userPrompt);
      res.json({ caption });
    } catch (error) {
      logger.error("Error generating caption:", error);
      res.status(500).send("Error generating caption");
    }
  },
);
