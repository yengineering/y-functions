import admin from "firebase-admin";
import { readFile } from "fs/promises";

const serviceAccount = JSON.parse(
  await readFile(
    new URL("../secrets/ylol-011235-f4dd88a9806f.json", import.meta.url),
  ),
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

export async function deleteSubcollections() {
  const usersSnapshot = await db.collection("users").get();

  for (const userDoc of usersSnapshot.docs) {
    const conversationsRef = db.collection(`users/${userDoc.id}/conversations`);
    const conversationsSnapshot = await conversationsRef.get();

    if (conversationsSnapshot.empty) {
      console.log(`No conversations for user ${userDoc.id}`);
      continue;
    }

    const batch = db.batch();
    conversationsSnapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    console.log(`Deleted conversations for user ${userDoc.id}`);
  }

  console.log("✅ All done!");
}

try {
  await deleteSubcollections();
} catch (error) {
  console.error(error);
}
