/**
 * Migration: lower-case the reviewer of every access review item (`review_items.reviewerId`).
 *
 * GET /access-reviews/my-reviews matched `reviewerId` exactly against the signed-in reviewer's
 * email, while decide compared without case, so a reviewer whose stored address differed in case
 * (a manager email an HR feed sends as `Mia.Manager@...`) never saw their items in My Reviews and
 * they expired undecided. A reviewer id is now stored trimmed and lower-cased (review-item.schema.ts)
 * and My Reviews asks for the email lower-cased; this brings the items stored before into that
 * form, in every tenant. A reviewer id is an email or an admin id (an ObjectId, already lower
 * case); decide and the reviewer mail compare both without case, so nothing else reads the case.
 *
 * Only ids with an upper-case letter or surrounding spaces are touched; rerunning changes nothing.
 * `down` changes nothing: the original case is not kept.
 */
import { Db } from 'mongodb';

const COLLECTION = 'review_items';

export async function up(db: Db): Promise<void> {
  const result = await db
    .collection(COLLECTION)
    .updateMany({ reviewerId: { $type: 'string', $regex: /[A-Z]|^\s|\s$/ } }, [
      { $set: { reviewerId: { $toLower: { $trim: { input: '$reviewerId' } } } } },
    ]);
  console.log(`[migration] review_items: ${result.modifiedCount} reviewer ids lower-cased`);
}

/** Nothing to undo: the original case is not kept. */
export async function down(): Promise<void> {}
