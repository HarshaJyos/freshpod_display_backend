import { getDatabase } from 'firebase-admin/database';

// Lazily resolve database reference to ensure Firebase Admin has been initialized
export default {
  ref(path?: string) {
    return getDatabase().ref(path);
  }
};
