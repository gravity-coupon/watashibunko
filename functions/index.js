// Scheduled cleanup of old game rooms.
//
// Runs every day at 04:00 JST. Deletes any /rooms/{rid} whose meta.createdAt
// is older than ROOM_TTL_MS. The TTL gives players a window to come back and
// re-read finished stories before they vanish.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();

setGlobalOptions({ region: 'asia-northeast1' });

const ROOM_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

exports.cleanupOldRooms = onSchedule(
  {
    schedule: 'every day 04:00',
    timeZone: 'Asia/Tokyo',
  },
  async () => {
    const db = admin.database();
    const cutoff = Date.now() - ROOM_TTL_MS;

    const snap = await db.ref('rooms').once('value');
    const rooms = snap.val() || {};
    const updates = {};
    let toDelete = 0;
    const total = Object.keys(rooms).length;

    for (const [roomId, room] of Object.entries(rooms)) {
      const createdAt = (room && room.meta && room.meta.createdAt) || 0;
      if (createdAt < cutoff) {
        updates[`rooms/${roomId}`] = null;
        toDelete++;
      }
    }

    if (toDelete > 0) {
      await db.ref().update(updates);
    }
    console.log(`cleanupOldRooms: deleted ${toDelete} of ${total} rooms (cutoff=${new Date(cutoff).toISOString()})`);
  }
);
