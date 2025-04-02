import { App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { Request, Response } from "firebase-functions/v1";
import { logger } from "firebase-functions";

export async function authenticate(
  req: Request,
  res: Response,
  adminApp: App,
): Promise<string | null> {
  const authHeader = req.headers.authorization || "";

  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).send("Unauthorized: Missing Bearer token");
    return null;
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decoded = await getAuth(adminApp).verifyIdToken(idToken);
    return decoded.uid;
  } catch (error) {
    logger.error("Token verification error:", error);
    res.status(401).send("Unauthorized: Invalid token");
    return null;
  }
}
