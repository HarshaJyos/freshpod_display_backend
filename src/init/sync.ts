import db from './firebase';
import { Log, Machine } from '../modules/machine/machine.model';

function startSync(): void {
  console.log("🚀 Firebase → MongoDB sync started...");

  const machinesRef = db.ref("machines");

  // Print all existing machines
  machinesRef.once("value", (snapshot) => {
    console.log("📋 Machines in Firebase:");
    snapshot.forEach((machineSnap) => {
      console.log(machineSnap.key, machineSnap.val());
      return false; // required by types to prevent default flow
    });
  });

  // Listen for added machines
  machinesRef.on("child_added", (machineSnap) => {
    const machineId = machineSnap.key;
    if (machineId) {
      console.log(`🆕 Machine detected: ${machineId}`);
      listenToMachineLogs(machineId);
    }
  });
}

function listenToMachineLogs(machineId: string): void {
  const logsRef = db.ref(`machines/${machineId}/logs`);

  logsRef.on("child_added", (logSnap) => {
    syncLog(machineId, logSnap);
  });

  logsRef.on("child_changed", (logSnap) => {
    syncLog(machineId, logSnap);
  });
}

async function syncLog(machineId: string, logSnap: any): Promise<void> {
  try {
    const date = logSnap.key;
    const data = logSnap.val();

    // skip invalid date
    if (!date || date === "1970-01-01") return;

    const tapCount = data?.tapCount || 0;

    // upsert log
    await Log.updateOne(
      { machineId, date },
      { $set: { tapCount } },
      { upsert: true }
    );

    // Update machine total taps
    const allLogs = await Log.find({ machineId });

    const totalTaps = allLogs.reduce((sum, log: any) => {
      return sum + (log.tapCount || 0);
    }, 0);

    await Machine.updateOne(
      { machineId },
      { $set: { totalTaps } }
    );

    console.log(`🔄 Synced: ${machineId} | ${date} | taps: ${tapCount}`);

  } catch (error) {
    console.error("❌ Sync error:", error);
  }
}

export default startSync;
